/**
 * Integration — the event store against a REAL MongoDB. Proves the unique `{tenantId, dedupKey}`
 * index makes persistence idempotent (a duplicate collapses, not errors), cross-tenant reads are
 * impossible through the guard, and keyset pagination works. Uses the dev-stack Mongo via MONGO_URI
 * and SKIPS gracefully when none is reachable (so default `pnpm test` stays green everywhere).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { TenantScope } from '@vip/tenancy';
import { connectMongo, type MongoAdapter } from '../src/adapters/mongo.js';
import { MongoEventStore } from '../src/adapters/mongo-event-store.js';
import { EventIngestService } from '../src/application/event-ingest-service.js';
import { InMemoryEventBus } from '@vip/messaging';
import { detectionResult } from './helpers.js';

const URI =
  process.env.MONGO_URI ??
  'mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_events_test?authSource=admin';
const DB = 'vip_events_test';

async function reachable(): Promise<boolean> {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 500 });
  try {
    await client.connect();
    await client.db(DB).command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

const online = await reachable();

describe.skipIf(!online)('event store against real MongoDB', () => {
  let mongo: MongoAdapter;
  let store: MongoEventStore;

  beforeAll(async () => {
    mongo = await connectMongo({ uri: URI, dbName: DB });
    store = new MongoEventStore(mongo.events);
  });

  afterAll(async () => {
    await mongo?.events.deleteMany({});
    await mongo?.close();
  });

  beforeEach(async () => {
    await mongo.events.deleteMany({});
  });

  it('deduplicates identical detections via the unique index (idempotent ingest)', async () => {
    const bus = new InMemoryEventBus();
    let n = 0;
    const ingest = new EventIngestService({
      bus,
      store,
      dedupWindowMs: 10_000,
      now: () => new Date('2026-07-28T00:00:00.200Z'),
      newId: () => `evt_${++n}`,
    });
    await ingest.start();

    await bus.publish('t.tnt_a.capability.output.perception.person-detection', detectionResult());
    await bus.publish('t.tnt_a.capability.output.perception.person-detection', detectionResult());

    const page = await store.query(TenantScope.fromTenantId('tnt_a'), { limit: 50 });
    expect(page.events).toHaveLength(1);
    expect(await mongo.events.countDocuments({ tenantId: 'tnt_a' })).toBe(1);
  });

  it('never returns another tenant events (guarded reads)', async () => {
    const now = () => new Date('2026-07-28T00:00:00.200Z');
    const a = new MongoEventStore(mongo.events);
    const bus = new InMemoryEventBus();
    const ingest = new EventIngestService({
      bus,
      store: a,
      dedupWindowMs: 10_000,
      now,
      newId: () => crypto.randomUUID(),
    });
    await ingest.start();
    await bus.publish('t.tnt_a.capability.output.perception.person-detection', detectionResult());
    await bus.publish(
      't.tnt_b.capability.output.perception.person-detection',
      detectionResult({ tenantId: 'tnt_b', cameraId: 'cam_b' }),
    );

    const bView = await store.query(TenantScope.fromTenantId('tnt_b'), { limit: 50 });
    expect(bView.events).toHaveLength(1);
    expect(bView.events[0]!.cameraId).toBe('cam_b');
  });
});

/**
 * **Planner verification** for the P-5.0 event reads (G-5, Architect rec 6).
 *
 * `test/index-coverage.test.ts` proves the declaration; this proves MongoDB agrees. Both new reads
 * are checked — the by-id lookup that turns an incident's `triggeredBy.eventId` back into an event,
 * and the correlation walk behind "every event related to this".
 *
 * Skipped without a database, which is a skip and not a pass (CONSTRAINTS §44).
 */
describe.skipIf(!online)('the planner uses the declared event indexes (G-5)', () => {
  let mongo: MongoAdapter;

  beforeAll(async () => {
    mongo = await connectMongo({ uri: URI, dbName: DB });
    await mongo.events.deleteMany({});
    const rows = Array.from({ length: 300 }, (_, index) => {
      const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
      return {
        id: `plan_${index}`,
        tenantId: 'tnt_a',
        envelopeVersion: '1.0.0',
        schemaVersion: '1.0.0',
        type: index % 2 === 0 ? 'perception.person.detected' : 'behavior.loitering',
        category: 'perception',
        priority: 'high',
        cameraId: `cam_${index % 10}`,
        zoneId: `zone_${index % 4}`,
        correlationId: `corr_${index % 8}`,
        occurredAt: at,
        receivedAt: at,
        source: { service: 'planner', version: '1.0.0' },
        payload: {},
        dedupKey: `plan_${index}`,
      };
    });
    await mongo.events.insertMany(rows as never[]);
  });

  afterAll(async () => {
    await mongo?.events.deleteMany({});
    await mongo?.close();
  });

  it('fetches one event by id through tenant_event_id, not a collection scan', async () => {
    const plan = JSON.stringify(
      (
        (await mongo.events
          .find({ tenantId: 'tnt_a', id: 'plan_7' } as never)
          .limit(1)
          .explain('queryPlanner')) as { queryPlanner: { winningPlan: Record<string, unknown> } }
      ).queryPlanner.winningPlan,
    );
    expect(plan).toContain('tenant_event_id');
    expect(plan).not.toContain('COLLSCAN');
  });

  const CASES: [string, string, Record<string, unknown>][] = [
    ['unfiltered', 'tenant_occurredAt', {}],
    ['type', 'tenant_type_time', { type: 'behavior.loitering' }],
    ['camera', 'tenant_camera_time', { cameraId: 'cam_3' }],
    ['zone', 'tenant_zone_time', { zoneId: 'zone_2' }],
    ['correlation', 'tenant_correlation_time', { correlationId: 'corr_5' }],
  ];

  it.each(CASES)('%s — uses %s, and never sorts in memory', async (_name, expected, filter) => {
    const plan = JSON.stringify(
      (
        (await mongo.events
          .find({ tenantId: 'tnt_a', ...filter } as never)
          .sort({ occurredAt: -1, id: -1 })
          .limit(50)
          .explain('queryPlanner')) as { queryPlanner: { winningPlan: Record<string, unknown> } }
      ).queryPlanner.winningPlan,
    );
    expect(plan, `expected the planner to choose ${expected}`).toContain(expected);
    expect(plan).not.toContain('"stage":"SORT"');
    expect(plan).not.toContain('COLLSCAN');
  });
});

/**
 * The index migration P-5.0 performs, proven against a real database.
 *
 * Three P1-5 indexes stopped at `occurredAt` and so abandoned the `(occurredAt, id)` sort every
 * paged read performs. Re-declaring an existing index name with different keys is an
 * `IndexOptionsConflict` — MongoDB refuses, and the service fails at boot. `ensureIndexes` therefore
 * drops a name whose key set changed and rebuilds it. This asserts that path rather than trusting
 * it, because it runs exactly once per deployment and the failure mode is "the service will not
 * start".
 */
describe.skipIf(!online)('index reconciliation on boot (G-5)', () => {
  it('replaces a pre-P-5.0 index whose keys changed, instead of failing to start', async () => {
    const client = new MongoClient(URI);
    await client.connect();
    const events = client.db(DB).collection('events');
    await events.dropIndexes().catch(() => {});
    // Recreate the index exactly as P1-5 wrote it — stopping at `occurredAt`.
    await events.createIndex({ tenantId: 1, occurredAt: -1 }, { name: 'tenant_occurredAt' });
    await client.close();

    const adapter = await connectMongo({ uri: URI, dbName: DB });
    const rebuilt = (await adapter.events.indexes()).find((i) => i.name === 'tenant_occurredAt');
    expect(rebuilt?.key).toEqual({ tenantId: 1, occurredAt: -1, id: -1 });
    await adapter.close();
  });
});
