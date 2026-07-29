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
