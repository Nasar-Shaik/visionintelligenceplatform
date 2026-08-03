/**
 * HTTP tests — the event read/replay vertical driven in-memory (no Mongo/NATS): authorization
 * (deny-by-default), tenant scoping (a tenant never sees another's events), query filtering, and
 * bounded replay re-publishing onto the bus. Tokens are minted directly with @vip/auth (this service
 * verifies; it does not log in) using identity's iss/aud. The real-driver proof lives in
 * mongo-integration.test.ts.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryEventBus, ALL_EVENTS } from '@vip/messaging';
import { loadConfig } from '../src/config/env.js';
import { EventQueryService } from '../src/application/event-query-service.js';
import { EventIngestService } from '../src/application/event-ingest-service.js';
import { InMemoryEventStore } from '../src/adapters/in-memory-event-store.js';
import { buildServer } from '../src/transport/server.js';
import { SECRET, token, authHeader, detectionResult } from './helpers.js';

let app: FastifyInstance;
let bus: InMemoryEventBus;
let replayBus: InMemoryEventBus;
let store: InMemoryEventStore;
let ids = 0;

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'events',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://localhost:47017/vip_events',
    NATS_URL: 'nats://localhost:44222',
    JWT_SECRET: SECRET,
  });
  bus = new InMemoryEventBus();
  store = new InMemoryEventStore();
  ids = 0;
  const ingest = new EventIngestService({
    bus,
    store,
    dedupWindowMs: 10_000,
    now: () => new Date('2026-07-28T00:00:00.200Z'),
    newId: () => `evt_${++ids}`,
  });
  await ingest.start();
  // seed two tenants' events through the real ingest path
  await bus.publish('t.tnt_a.capability.output.perception.person-detection', detectionResult());
  await bus.publish(
    't.tnt_a.capability.output.perception.person-detection',
    detectionResult({
      frame: { seq: 8, capturedAt: '2026-07-28T00:00:30.000Z' },
      detections: [
        { label: 'car', confidence: 0.7, bbox: [0.5, 0.5, 0.2, 0.2], attributes: {}, metadata: {} },
      ],
    }),
  );
  await bus.publish(
    't.tnt_b.capability.output.perception.person-detection',
    detectionResult({ tenantId: 'tnt_b', cameraId: 'cam_b' }),
  );

  replayBus = new InMemoryEventBus();
  const queryService = new EventQueryService({ store, bus: replayBus, replayCeiling: 100 });
  app = (await buildServer({ config, queryService, startedAt: new Date() })).app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('authorization', () => {
  it('GET /events without a token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /events without event:read (viewer has *:read so allow; a role lacking read is denied)', async () => {
    // a role with no permissions at all
    const t = await token('tnt_a', []);
    const res = await app.inject({ method: 'GET', url: '/events', headers: authHeader(t) });
    expect(res.statusCode).toBe(403);
  });

  it('POST /events/replay requires event:replay (viewer/operator denied)', async () => {
    const t = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'POST',
      url: '/events/replay',
      headers: authHeader(t),
      payload: { from: '2026-07-28T00:00:00.000Z', to: '2026-07-29T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /events (tenant-scoped query)', () => {
  it('returns only the caller tenant events, newest first', async () => {
    const t = await token('tnt_a', ['admin']);
    const res = await app.inject({ method: 'GET', url: '/events', headers: authHeader(t) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.events).toHaveLength(2);
    expect(body.data.events.every((e: { tenantId: string }) => e.tenantId === 'tnt_a')).toBe(true);
    // newest first (the car at 00:00:30 before the person at 00:00:00)
    expect(body.data.events[0].type).toBe('perception.vehicle.detected');
  });

  it('filters by type', async () => {
    const t = await token('tnt_a', ['admin']);
    const res = await app.inject({
      method: 'GET',
      url: '/events?type=perception.vehicle.detected',
      headers: authHeader(t),
    });
    const body = res.json();
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0].type).toBe('perception.vehicle.detected');
  });

  it('a tenant cannot see another tenant events', async () => {
    const t = await token('tnt_b', ['admin']);
    const res = await app.inject({ method: 'GET', url: '/events', headers: authHeader(t) });
    const body = res.json();
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0].cameraId).toBe('cam_b');
  });
});

describe('POST /events/replay', () => {
  it('re-publishes the tenant events in the window onto the bus (bounded)', async () => {
    const replayed: string[] = [];
    await replayBus.subscribe(
      { stream: 'EVENTS', durable: 'replay-probe', filterSubject: ALL_EVENTS },
      (m) => {
        replayed.push(m.subject);
        m.ack();
      },
    );
    const t = await token('tnt_a', ['admin']);
    const res = await app.inject({
      method: 'POST',
      url: '/events/replay',
      headers: authHeader(t),
      payload: { from: '2026-07-28T00:00:00.000Z', to: '2026-07-29T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.replayed).toBe(2);
    expect(replayed).toHaveLength(2);
  });
});

/**
 * P-5.0 entry criterion G-5 — event retrieval by id.
 *
 * The gap: an incident carries `triggeredBy.eventId`, and nothing could turn that id back into an
 * event. That blocked the investigation workspace's flagship answer, _why did this rule fire_,
 * which replays the triggering event through the rule simulator.
 */
describe('GET /events/:id (P-5.0 G-5)', () => {
  it('returns the envelope the incident’s triggeredBy.eventId points at', async () => {
    const t = await token('tnt_a', ['admin']);
    const list = await app.inject({ method: 'GET', url: '/events', headers: authHeader(t) });
    const first = list.json().data.events[0];

    const res = await app.inject({
      method: 'GET',
      url: `/events/${first.id}`,
      headers: authHeader(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(first);
  });

  it('is a 404 for an unknown id — an expired event is absent, not an error', async () => {
    const t = await token('tnt_a', ['admin']);
    const res = await app.inject({
      method: 'GET',
      url: '/events/evt_does_not_exist',
      headers: authHeader(t),
    });
    expect(res.statusCode).toBe(404);
  });

  /** The isolation property that matters: another tenant's event is indistinguishable from absent. */
  it('is a 404 — not a 403 — for another tenant’s event, so existence never leaks', async () => {
    const a = await token('tnt_a', ['admin']);
    const b = await token('tnt_b', ['admin']);
    const theirs = (
      await app.inject({ method: 'GET', url: '/events', headers: authHeader(b) })
    ).json().data.events[0];

    const res = await app.inject({
      method: 'GET',
      url: `/events/${theirs.id}`,
      headers: authHeader(a),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error?.code ?? res.json().code).toBe('not_found');
  });

  it('is denied without event:read, like every other read', async () => {
    const res = await app.inject({ method: 'GET', url: '/events/evt_1' });
    expect(res.statusCode).toBe(401);
  });

  it('counts lookups by outcome, and exposes no cache series (rec 4)', async () => {
    const t = await token('tnt_a', ['admin']);
    await app.inject({ method: 'GET', url: '/events/evt_1', headers: authHeader(t) });
    await app.inject({ method: 'GET', url: '/events/nope', headers: authHeader(t) });

    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/events_lookup_total\{outcome="found"[^}]*\} 1/);
    expect(metrics).toMatch(/events_lookup_total\{outcome="not_found"[^}]*\} 1/);
    expect(metrics).toContain('events_lookup_duration_seconds');
    // There is no cache, so there are no cache counters. A series pinned at zero would read as a
    // broken cache rather than an absent one.
    expect(metrics).not.toContain('cache_hit');
    expect(metrics).not.toContain('cache_miss');
  });
});

describe('GET /events?correlationId= (P-5.0 G-5)', () => {
  it('returns only the events on that correlation', async () => {
    const t = await token('tnt_a', ['admin']);
    const all = (await app.inject({ method: 'GET', url: '/events', headers: authHeader(t) })).json()
      .data.events;
    const correlationId = all[0].correlationId;
    expect(correlationId).toBeTruthy();

    const res = await app.inject({
      method: 'GET',
      url: `/events?correlationId=${correlationId}`,
      headers: authHeader(t),
    });
    expect(res.statusCode).toBe(200);
    const events = res.json().data.events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e: { correlationId: string }) => e.correlationId === correlationId)).toBe(
      true,
    );
  });

  it('returns nothing for a correlation that does not exist', async () => {
    const t = await token('tnt_a', ['admin']);
    const res = await app.inject({
      method: 'GET',
      url: '/events?correlationId=corr-nobody',
      headers: authHeader(t),
    });
    expect(res.json().data.events).toHaveLength(0);
  });
});
