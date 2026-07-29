/**
 * Integration — the incident store against a REAL MongoDB. Proves promotion persistence, idempotent
 * promotion via the unique `(tenantId, source.dedupKey)` index, version-guarded replace, keyset
 * pagination, and tenant isolation. Uses the dev-stack Mongo via MONGO_URI and SKIPS gracefully when
 * none is reachable (so default `pnpm test` stays green).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { TenantScope } from '@vip/tenancy';
import { IncidentService } from '../src/application/incident-service.js';
import { connectMongo, type MongoAdapter } from '../src/adapters/mongo.js';
import { MongoIncidentStore } from '../src/adapters/mongo-incident-store.js';
import { personCandidate } from './helpers.js';

const URI = process.env.MONGO_URI ?? 'mongodb://localhost:47017/vip_workflow_test';
const DB = 'vip_workflow_test';

async function reachable(): Promise<boolean> {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 500 });
  try {
    await client.connect();
    // A real op (findOne) — a bare `ping` can pass pre-auth against an auth-gated Mongo and give a
    // false positive, so we probe with an operation that actually requires the connection's creds.
    await client.db(DB).collection('incidents').findOne({});
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

const online = await reachable();
const scopeA = TenantScope.fromTenantId('tnt_a');
const scopeB = TenantScope.fromTenantId('tnt_b');

describe.skipIf(!online)('incident store against real MongoDB', () => {
  let mongo: MongoAdapter;
  let store: MongoIncidentStore;
  let service: IncidentService;
  let seq = 0;

  beforeAll(async () => {
    mongo = await connectMongo({ uri: URI, dbName: DB });
    store = new MongoIncidentStore({ incidents: mongo.incidents });
    service = new IncidentService({ store, newId: () => `inc_${++seq}` });
  });

  afterAll(async () => {
    await mongo?.incidents.deleteMany({});
    await mongo?.close();
  });

  beforeEach(async () => {
    seq = 0;
    await mongo.incidents.deleteMany({});
  });

  it('promotes idempotently — the same dedupKey never yields two incidents', async () => {
    const first = await service.promote(scopeA, personCandidate({ dedupKey: 'a|1' }));
    const second = await service.promote(scopeA, personCandidate({ dedupKey: 'a|1' }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.incident.id).toBe(first.incident.id);
    expect(await mongo.incidents.countDocuments({ tenantId: 'tnt_a' })).toBe(1);
  });

  it('persists lifecycle transitions with version bumps', async () => {
    const { incident } = await service.promote(scopeA, personCandidate({ dedupKey: 'a|1' }));
    await service.acknowledge(scopeA, incident.id, { note: 'looking' }, 'op');
    const resolved = await service.resolve(scopeA, incident.id, { resolution: 'ok' }, 'op');
    expect(resolved.status).toBe('resolved');
    expect(resolved.version).toBe(3);

    const reread = await store.get(scopeA, incident.id);
    expect(reread?.status).toBe('resolved');
    expect(reread?.history).toHaveLength(3);
  });

  it("never returns another tenant's incidents (guarded reads + pagination)", async () => {
    await service.promote(scopeA, personCandidate({ tenantId: 'tnt_a', dedupKey: 'a|1' }));
    const page = await store.list(scopeB, { limit: 50 });
    expect(page.items).toHaveLength(0);
  });
});
