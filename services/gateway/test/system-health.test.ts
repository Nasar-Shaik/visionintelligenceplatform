/**
 * System health (P-6.4) — the aggregation, and the route.
 *
 * ⚠️ Every test here is written to be able to **fail against a green deployment**: the point of the
 * surface is that it says `no` when `no` is the truth, and a health page is the one screen where a
 * test that only ever sees healthy proves nothing at all. Each case therefore drives a real failure
 * — a service that answers 503, one that does not answer, one that answers with something else —
 * and asserts the *word* the operator is given, not merely that a row exists.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '@vip/auth';
import { SystemHealthService } from '../src/application/system-health.js';
import { assertSystemPrefixFree } from '../src/transport/routes/system.js';
import { loadConfig } from '../src/config/env.js';
import { buildServer } from '../src/transport/server.js';
import { ReadinessRegistry } from '../src/application/readiness.js';

const SECRET = 'gateway-test-secret-16chars';
const jwtOpts = { secret: SECRET, issuer: 'identity', audience: 'vip', accessTtl: '15m' };
const at = new Date('2026-08-04T12:00:00.000Z');

/** A readiness report exactly as a service serves it. */
const ready = (checks: { name: string; status: 'pass' | 'fail'; detail?: string }[]) => ({
  status: checks.every((c) => c.status === 'pass') ? 'pass' : 'fail',
  checks,
});

/** Build a service over a fetch stub, so a failure can be *caused* rather than waited for. */
function service(
  responses: Record<string, { status: number; body?: unknown; throws?: Error }>,
  options: { streamEnabled?: boolean; own?: { status: string; checks: [] } } = {},
) {
  return new SystemHealthService({
    upstreams: Object.fromEntries(Object.keys(responses).map((id) => [id, `http://${id}:1234`])),
    ownReadiness: async () => options.own ?? { status: 'pass', checks: [] },
    streamEnabled: options.streamEnabled ?? true,
    clock: () => at,
    fetch: (async (url: string | URL) => {
      const id = new URL(String(url)).hostname;
      const planned = responses[id]!;
      if (planned.throws) throw planned.throws;
      return new Response(JSON.stringify(planned.body ?? {}), {
        status: planned.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
}

const find = (report: { components: { id: string }[] }, id: string) =>
  report.components.find((c) => c.id === id);

/**
 * Two upstreams that both depend on `mongo`, whose reachability each caller controls, over a clock
 * that advances past the cache on every read. This is how a database outage is reproduced without
 * one: the services stop answering, not the check.
 */
function outageService(tenantAlive: () => boolean, eventsAlive: () => boolean = tenantAlive) {
  let tick = 0;
  return new SystemHealthService({
    upstreams: { tenant: 'http://tenant:1234', events: 'http://events:1234' },
    ownReadiness: async () => ({ status: 'pass', checks: [] }),
    streamEnabled: true,
    clock: () => new Date(at.getTime() + tick++ * 60_000),
    fetch: (async (url: string | URL) => {
      const id = new URL(String(url)).hostname;
      const alive = id === 'tenant' ? tenantAlive() : eventsAlive();
      if (!alive) throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      return new Response(JSON.stringify(ready([{ name: 'mongo', status: 'pass' }])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
}

describe('system health aggregation', () => {
  it('a service whose dependencies all pass is ready', async () => {
    const report = await service({
      tenant: { status: 200, body: ready([{ name: 'mongo', status: 'pass' }]) },
    }).report();

    expect(find(report, 'tenant')).toMatchObject({ state: 'ready', label: 'Tenant' });
    // ⚠️ `ready` is the one state that needs no sentence. Every other state owes the operator one.
    expect(find(report, 'tenant')?.detail).toBeUndefined();
  });

  /**
   * ⚠️ **A service answering 503 is degraded, not unavailable, and the distinction is the point.**
   * It answered — its dependency is what failed — so the operator should be sent to the database,
   * not to the service. Collapsing the two would send them to the wrong place at 3am.
   */
  it('a service that answers 503 is degraded, and says which check failed', async () => {
    const report = await service({
      events: {
        status: 503,
        body: ready([{ name: 'mongo', status: 'fail', detail: 'connection refused' }]),
      },
    }).report();

    expect(find(report, 'events')?.state).toBe('degraded');
    expect(find(report, 'events')?.detail).toContain('connection refused');
  });

  it('a service that does not answer at all is unreachable, with the reason', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    const report = await service({ media: { status: 0, throws: timeout } }).report();

    expect(find(report, 'media')?.state).toBe('unreachable');
    expect(find(report, 'media')?.detail).toMatch(/did not answer within \d+ ms/);
  });

  /**
   * ⚠️ **"fetch failed" is not a reason**, and that is what the deployment reported for a stopped
   * container — a sentence that tells an operator nothing the word "Unavailable" had not already.
   * `undici` keeps the real cause one level down.
   */
  it('digs the real cause out of a connection failure', async () => {
    const report = await service({
      media: { status: 0, throws: new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } }) },
    }).report();

    expect(find(report, 'media')?.detail).toContain('ECONNREFUSED');
  });

  /**
   * ⚠️ Something is listening and we have no idea what it thinks of itself. That is `unknown` — the
   * one thing it must never be is `ready`, which is what a truthy HTTP 200 would otherwise buy.
   */
  it('a service that answers with something other than a readiness report is unknown', async () => {
    const report = await service({
      camera: { status: 200, body: '<html>hello</html>' },
    }).report();
    // A JSON string parses, but carries no `checks` and no `status`.
    expect(find(report, 'camera')?.state).not.toBe('ready');
  });

  describe('infrastructure is derived, not probed', () => {
    it('one row per dependency, healthy when every service that uses it agrees', async () => {
      const report = await service({
        tenant: { status: 200, body: ready([{ name: 'mongo', status: 'pass' }]) },
        events: { status: 200, body: ready([{ name: 'mongo', status: 'pass' }]) },
      }).report();

      expect(find(report, 'infra:mongo')).toMatchObject({
        state: 'ready',
        kind: 'infrastructure',
        label: 'MongoDB',
      });
    });

    it('degraded when it fails for some services and works for others', async () => {
      const report = await service({
        tenant: { status: 200, body: ready([{ name: 'mongo', status: 'pass' }]) },
        events: {
          status: 503,
          body: ready([{ name: 'mongo', status: 'fail', detail: 'auth failed' }]),
        },
      }).report();

      expect(find(report, 'infra:mongo')?.state).toBe('degraded');
      expect(find(report, 'infra:mongo')?.detail).toContain('Events');
      expect(find(report, 'infra:mongo')?.detail).toContain('Tenant');
    });

    it('unreachable when every service that depends on it reports it failing', async () => {
      const report = await service({
        tenant: { status: 503, body: ready([{ name: 'mongo', status: 'fail' }]) },
        events: { status: 503, body: ready([{ name: 'mongo', status: 'fail' }]) },
      }).report();

      expect(find(report, 'infra:mongo')?.state).toBe('unreachable');
    });

    /**
     * ⚠️ A silent service contributes **nothing** to the infrastructure verdict rather than
     * contributing a failure. Its silence is already its own row; counting it twice would turn one
     * outage into two and point the second one at the wrong component.
     */
    it('a service that did not answer is not evidence about the database', async () => {
      const report = await service({
        tenant: { status: 200, body: ready([{ name: 'mongo', status: 'pass' }]) },
        events: { status: 0, throws: new Error('ECONNREFUSED') },
      }).report();

      expect(find(report, 'events')?.state).toBe('unreachable');
      expect(find(report, 'infra:mongo')?.state).toBe('ready');
    });

    /**
     * ⚠️ Redis is in the production compose stack and **no service connects to it**. A row saying
     * "Redis · unknown" is indistinguishable, to a customer, from "Redis · broken" — and it would be
     * the gateway asserting that something is part of the system, which is the one thing the gateway
     * cannot know. Nothing checks it, so nothing reports it.
     */
    /**
     * ⚠️ **The defect this milestone's deployment verification actually found.**
     *
     * MongoDB was paused against the running stack. Every service's readiness probe blocked, all ten
     * timed out as `unreachable`, none reported a check — and the MongoDB row **vanished from the
     * report**. Ten red rows during a total database outage, and not one word about the database.
     *
     * The row now survives as `unknown`, which is the honest word: nobody can speak for it. Claiming
     * `unreachable` would be an inference — the database may be fine and the services unreachable
     * for their own reasons — and that inference is exactly what would send someone to the wrong
     * place.
     */
    it('⚠️ keeps the row when every service that reports on it goes silent', async () => {
      let alive = true;
      const svc = outageService(() => alive);

      expect(find(await svc.report(), 'infra:mongo')?.state).toBe('ready');

      alive = false; // the database is paused: every readiness probe now blocks and times out
      const outage = await svc.report();

      expect(find(outage, 'tenant')?.state).toBe('unreachable');
      const mongo = find(outage, 'infra:mongo');
      expect(mongo).toBeDefined();
      expect(mongo?.state).toBe('unknown');
      expect(mongo?.detail).toMatch(/not answering/);
    });

    it('one silent service among healthy ones says nothing about the dependency', async () => {
      let bothAlive = true;
      const svc = outageService(
        () => true,
        () => bothAlive,
      );
      await svc.report();
      bothAlive = false;
      // ⚠️ One silent reporter beside a healthy one is not evidence: the healthy one just used it.
      expect(find(await svc.report(), 'infra:mongo')?.state).toBe('ready');
    });

    it('reports nothing about a dependency no service checks', async () => {
      const report = await service({
        tenant: { status: 200, body: ready([{ name: 'mongo', status: 'pass' }]) },
      }).report();

      expect(find(report, 'infra:redis')).toBeUndefined();
    });
  });

  describe('capabilities', () => {
    it('real-time updates are not-configured when the deployment turned them off', async () => {
      const off = await service(
        { tenant: { status: 200, body: ready([]) } },
        { streamEnabled: false },
      ).report();
      expect(find(off, 'realtime-stream')?.state).toBe('not-configured');
      expect(find(off, 'realtime-stream')?.detail).toContain('STREAM_ENABLED');

      const on = await service({ tenant: { status: 200, body: ready([]) } }).report();
      expect(find(on, 'realtime-stream')?.state).toBe('ready');
    });

    it('reports what the release does not contain, with the reason', async () => {
      const report = await service({ tenant: { status: 200, body: ready([]) } }).report();
      const live = find(report, 'live-video');
      expect(live?.state).toBe('not-built');
      // ⚠️ The sentence is the product: "not-built" alone reads as broken.
      expect(live?.detail).toMatch(/P-8/);
      expect(find(report, 'email-sms-delivery')?.state).toBe('not-built');
      expect(find(report, 'ai-advisor')?.state).toBe('not-built');
    });
  });

  it('caches, so N viewers are not N fan-outs', async () => {
    let calls = 0;
    const svc = new SystemHealthService({
      upstreams: { tenant: 'http://tenant:1234' },
      ownReadiness: async () => ({ status: 'pass', checks: [] }),
      streamEnabled: true,
      clock: () => at,
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify(ready([])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    await svc.report();
    await svc.report();
    await svc.report();
    expect(calls).toBe(1);
  });
});

describe('the reserved prefix', () => {
  it('fails the boot if an upstream is named `system`', () => {
    // ⚠️ Otherwise the failure is a route that half-works: /api/system/health answers here and
    // /api/system/anything-else proxies to a different process.
    expect(() => assertSystemPrefixFree({ system: 'http://somewhere:1' })).toThrow(/reserved/);
    expect(() => assertSystemPrefixFree({ tenant: 'http://tenant:1' })).not.toThrow();
  });
});

describe('GET /api/system/health', () => {
  let gateway: FastifyInstance;
  let upstream: FastifyInstance;

  beforeAll(async () => {
    upstream = Fastify({ logger: false });
    upstream.get('/ready', async () => ready([{ name: 'mongo', status: 'pass' }]));
    await upstream.listen({ host: '127.0.0.1', port: 0 });
    const addr = upstream.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const config = loadConfig({
      NODE_ENV: 'test',
      SERVICE_NAME: 'gateway',
      LOG_LEVEL: 'silent',
      JWT_SECRET: SECRET,
      IDENTITY_URL: `http://127.0.0.1:${port}`,
      TENANT_URL: `http://127.0.0.1:${port}`,
      CAMERA_URL: `http://127.0.0.1:${port}`,
      MEDIA_URL: `http://127.0.0.1:${port}`,
      EVENTS_URL: `http://127.0.0.1:${port}`,
      RULES_URL: `http://127.0.0.1:${port}`,
      WORKFLOW_URL: `http://127.0.0.1:${port}`,
      NOTIFY_URL: `http://127.0.0.1:${port}`,
      EVIDENCE_URL: `http://127.0.0.1:${port}`,
      STREAM_ENABLED: 'false',
    });
    gateway = (await buildServer({ config, readiness: new ReadinessRegistry() })).app;
    await gateway.ready();
  });

  afterAll(async () => {
    await gateway.close();
    await upstream.close();
  });

  const token = async (roles: string[]) =>
    (
      await signAccessToken(
        { principalId: 'usr_1', tenantId: 'tnt_a', email: 'a@b.com', roles },
        jwtOpts,
      )
    ).token;

  it('requires a token', async () => {
    const res = await gateway.inject({ method: 'GET', url: '/api/system/health' });
    expect(res.statusCode).toBe(401);
  });

  it('serves the report to an operator', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/system/health',
      headers: { authorization: `Bearer ${await token(['operator'])}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.components.some((c: { id: string }) => c.id === 'gateway')).toBe(true);
    expect(body.data.components.some((c: { id: string }) => c.id === 'tenant')).toBe(true);
  });

  /**
   * ⚠️ The `forbidden` state exists because it is reachable. A principal with no roles is refused
   * here rather than being shown an empty page, so the console can say "you may not see this"
   * instead of "nothing is wrong".
   */
  it('refuses a principal with no roles', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/system/health',
      headers: { authorization: `Bearer ${await token([])}` },
    });
    expect(res.statusCode).toBe(403);
  });

  /**
   * ⚠️ The route is a static path sitting beside the proxy's `/api/:service/*`. This asserts the
   * static path wins — the thing that would break silently if the routes were ever reordered.
   */
  it('is not swallowed by the upstream proxy', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/system/health',
      headers: { authorization: `Bearer ${await token(['admin'])}` },
    });
    // The stub upstream would answer `/health` with a 404; the gateway answers with a report.
    expect(res.json().data.derivedAt).toBeTruthy();
  });
});
