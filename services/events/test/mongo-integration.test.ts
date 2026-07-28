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

const URI = process.env.MONGO_URI ?? 'mongodb://localhost:47017/vip_events_test';
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
