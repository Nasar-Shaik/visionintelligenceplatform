/**
 * HTTP tests — the incident lifecycle vertical driven in-memory (no Mongo/NATS): authorization
 * (deny-by-default), tenant scoping (404 across tenants, no existence leak), lifecycle transitions,
 * and the illegal-transition 409. Incidents are seeded via the promotion use-case (there is no
 * create API). Tokens are minted directly with @vip/auth using identity's iss/aud.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { loadConfig } from '../src/config/env.js';
import { IncidentService } from '../src/application/incident-service.js';
import { InMemoryIncidentStore } from '../src/adapters/in-memory-incident-store.js';
import { buildServer } from '../src/transport/server.js';
import { SECRET, token, authHeader, personCandidate } from './helpers.js';

let app: FastifyInstance;
let service: IncidentService;
let idSeq = 0;

async function seedIncident(tenantId: string, dedupKey: string): Promise<string> {
  const id = `inc_${++idSeq}`;
  const store = (service as unknown as { store: InMemoryIncidentStore }).store;
  // promote through the service so the incident is well-formed + persisted
  const svc = new IncidentService({ store, newId: () => id });
  await svc.promote(TenantScope.fromTenantId(tenantId), personCandidate({ tenantId, dedupKey }));
  return id;
}

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'workflow',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://localhost:47017/vip_workflow',
    NATS_URL: 'nats://localhost:44222',
    JWT_SECRET: SECRET,
  });
  service = new IncidentService({ store: new InMemoryIncidentStore() });
  app = (await buildServer({ config, incidentService: service, startedAt: new Date() })).app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  idSeq = 0;
});

describe('authorization', () => {
  it('GET /incidents without a token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/incidents' });
    expect(res.statusCode).toBe(401);
  });

  it('a viewer can read but cannot acknowledge', async () => {
    const id = await seedIncident('tnt_a', 'a|1');
    const viewer = await token('tnt_a', ['viewer']);
    expect(
      (await app.inject({ method: 'GET', url: '/incidents', headers: authHeader(viewer) }))
        .statusCode,
    ).toBe(200);
    const ack = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/ack`,
      headers: authHeader(viewer),
    });
    expect(ack.statusCode).toBe(403);
  });
});

describe('tenant scoping', () => {
  it("GET another tenant's incident → 404 (no existence leak)", async () => {
    const id = await seedIncident('tnt_a', 'a|1');
    const other = await token('tnt_b', ['admin']);
    const res = await app.inject({
      method: 'GET',
      url: `/incidents/${id}`,
      headers: authHeader(other),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('lifecycle transitions', () => {
  it('operator acknowledges then resolves an incident', async () => {
    const id = await seedIncident('tnt_a', 'a|1');
    const op = await token('tnt_a', ['operator']);

    const ack = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/ack`,
      headers: authHeader(op),
      payload: { note: 'looking' },
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().data).toMatchObject({ status: 'acknowledged', version: 2 });

    const resolve = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/resolve`,
      headers: authHeader(op),
      payload: { resolution: 'false alarm' },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().data).toMatchObject({ status: 'resolved', resolution: 'false alarm' });
  });

  it('rejects an illegal transition with 409 (cannot close a raised incident)', async () => {
    const id = await seedIncident('tnt_a', 'a|1');
    const op = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/close`,
      headers: authHeader(op),
    });
    expect(res.statusCode).toBe(409);
  });

  it('filters the incident list by status', async () => {
    await seedIncident('tnt_a', 'a|1');
    const id2 = await seedIncident('tnt_a', 'a|2');
    const op = await token('tnt_a', ['operator']);
    await app.inject({ method: 'POST', url: `/incidents/${id2}/ack`, headers: authHeader(op) });

    const raised = await app.inject({
      method: 'GET',
      url: '/incidents?status=raised',
      headers: authHeader(op),
    });
    expect(raised.json().data.items).toHaveLength(1);
    expect(raised.json().data.items[0].status).toBe('raised');
  });
});

/**
 * P-5.0 entry criteria G-1 / G-2 / G-3 at the HTTP edge — the surface the investigation workspace
 * will call. The service-level behaviour is proven in `incident-workflow.test.ts`; what is asserted
 * here is the wiring: the routes exist, they are permission-gated separately from ack/resolve, and
 * the search filters survive the query-string round trip.
 */
describe('P-5.0 · investigation routes', () => {
  it('investigates and escalates, each behind its own permission', async () => {
    const id = await seedIncident('tnt_a', 'p5|1');
    const operator = await token('tnt_a', ['operator']);

    const investigated = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/investigate`,
      headers: authHeader(operator),
      payload: {},
    });
    expect(investigated.statusCode).toBe(200);
    expect(investigated.json().data.status).toBe('investigating');

    const escalated = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/escalate`,
      headers: authHeader(operator),
      payload: { to: 'team:leads' },
    });
    expect(escalated.statusCode).toBe(200);
    expect(escalated.json().data.escalation.to).toBe('team:leads');
  });

  it('refuses a viewer the investigation actions — read is not write', async () => {
    const id = await seedIncident('tnt_a', 'p5|2');
    const viewer = await token('tnt_a', ['viewer']);
    for (const path of ['investigate', 'escalate', 'assign', 'notes']) {
      const res = await app.inject({
        method: 'POST',
        url: `/incidents/${id}/${path}`,
        headers: authHeader(viewer),
        payload: path === 'assign' ? { assignee: 'x' } : { body: 'x' },
      });
      expect(res.statusCode, `${path} must be denied to a viewer`).toBe(403);
    }
  });

  it('assigns without moving the incident along the lifecycle', async () => {
    const id = await seedIncident('tnt_a', 'p5|3');
    const operator = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/assign`,
      headers: authHeader(operator),
      payload: { assignee: 'priya' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ assignee: 'priya', status: 'raised' });
  });

  it('appends a note with an evidence reference and returns 201', async () => {
    const id = await seedIncident('tnt_a', 'p5|4');
    const operator = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/notes`,
      headers: authHeader(operator),
      payload: { body: 'clip reviewed', attachments: [{ kind: 'evidence', ref: 'evd_1' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.notes).toHaveLength(1);
  });

  it('serves the derived activity log to anyone who may read the incident', async () => {
    const id = await seedIncident('tnt_a', 'p5|5');
    const operator = await token('tnt_a', ['operator']);
    await app.inject({
      method: 'POST',
      url: `/incidents/${id}/assign`,
      headers: authHeader(operator),
      payload: { assignee: 'priya' },
    });
    const viewer = await token('tnt_a', ['viewer']);
    const res = await app.inject({
      method: 'GET',
      url: `/incidents/${id}/activity`,
      headers: authHeader(viewer),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.entries.map((e: { kind: string }) => e.kind)).toEqual([
      'transition',
      'assignment',
    ]);
  });

  it('rejects a body that violates the contract rather than storing it', async () => {
    const id = await seedIncident('tnt_a', 'p5|6');
    const operator = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/notes`,
      headers: authHeader(operator),
      payload: { body: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('P-5.0 · the frozen search surface (G-3)', () => {
  it('carries every filter through the query string', async () => {
    await seedIncident('tnt_a', 'q|1');
    const t = await token('tnt_a', ['operator']);
    const url =
      '/incidents?status=raised&severity=critical&category=perception' +
      '&eventType=perception.person.detected&cameraId=cam_1&zoneId=zone_1' +
      '&ruleId=rule_1&correlationId=corr-abc&limit=10';
    const res = await app.inject({ method: 'GET', url, headers: authHeader(t) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.items).toHaveLength(1);
  });

  it('returns nothing when one filter in the set disagrees', async () => {
    await seedIncident('tnt_a', 'q|2');
    const t = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'GET',
      url: '/incidents?cameraId=cam_1&zoneId=zone_elsewhere',
      headers: authHeader(t),
    });
    expect(res.json().data.items).toHaveLength(0);
  });

  it('rejects an out-of-contract filter value instead of ignoring it', async () => {
    const t = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'GET',
      url: '/incidents?status=who-knows',
      headers: authHeader(t),
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * P-5.1 at the HTTP edge — the timeline and SLA routes, and the permission split.
 *
 * The service-level behaviour is proven in `incident-p51.test.ts`; what is asserted here is the
 * wiring: the routes exist, `?include=` is honoured, an unconfigured deployment answers honestly
 * rather than flatteringly, and closing is gated on its own permission without having silently
 * removed an operator's ability to do it.
 */
describe('P-5.1 · timeline and SLA routes', () => {
  it('serves a timeline of the incident’s own streams, naming every source not requested', async () => {
    const id = await seedIncident('tnt_a', 'p51|1');
    const t = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'GET',
      url: `/incidents/${id}/timeline`,
      headers: authHeader(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.entries.map((e: { kind: string }) => e.kind)).toEqual(['raised']);
    expect(
      body.gaps.map((g: { source: string; reason: string }) => `${g.source}:${g.reason}`),
    ).toEqual(['events:not-requested', 'evidence:not-requested', 'notify:not-requested']);
  });

  /**
   * ⚠️ The property that matters most on this route. With no upstream clients wired (P-5.2 work),
   * a requested source must come back as an **unavailable gap** — not an empty list, which would
   * claim the source was consulted and had nothing to say.
   */
  it('reports a requested-but-unwired source as unavailable, and still returns 200', async () => {
    const id = await seedIncident('tnt_a', 'p51|2');
    const t = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'GET',
      url: `/incidents/${id}/timeline?include=events,evidence`,
      headers: authHeader(t),
    });
    expect(res.statusCode).toBe(200);
    const gaps = res.json().data.gaps.filter((g: { reason: string }) => g.reason === 'unavailable');
    expect(gaps.map((g: { source: string }) => g.source).sort()).toEqual(['events', 'evidence']);
  });

  it('drops an unrecognised include rather than failing the read', async () => {
    const id = await seedIncident('tnt_a', 'p51|3');
    const t = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'GET',
      url: `/incidents/${id}/timeline?include=events,nonsense`,
      headers: authHeader(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.sources).toEqual(['incident', 'events']);
  });

  it('reports SLA as unknown when the deployment configured no policy', async () => {
    const id = await seedIncident('tnt_a', 'p51|4');
    const t = await token('tnt_a', ['viewer']);
    const res = await app.inject({
      method: 'GET',
      url: `/incidents/${id}/sla`,
      headers: authHeader(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ state: 'unknown' });
    expect(res.json().data.policy).toBeUndefined();
  });

  it('still lets an operator close — the incident:close split is additive', async () => {
    const id = await seedIncident('tnt_a', 'p51|5');
    const operator = await token('tnt_a', ['operator']);
    await app.inject({
      method: 'POST',
      url: `/incidents/${id}/resolve`,
      headers: authHeader(operator),
      payload: {},
    });
    const res = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/close`,
      headers: authHeader(operator),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('closed');
  });

  it('records the calling principal as a typed operator on every write', async () => {
    const id = await seedIncident('tnt_a', 'p51|6');
    const t = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'POST',
      url: `/incidents/${id}/ack`,
      headers: authHeader(t),
      payload: {},
    });
    expect(res.json().data.history.at(-1).actor).toEqual({ kind: 'operator', id: 'usr_1' });
  });
});
