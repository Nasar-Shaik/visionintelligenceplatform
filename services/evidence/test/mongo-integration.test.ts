/**
 * Integration — the evidence store + custody log against a REAL MongoDB, and the full service over a
 * REAL LocalFsObjectStore. Proves idempotent registration, keyset pagination, the unique custody seq,
 * tenant isolation through the guard, and hash-chain verification end-to-end. Uses the dev-stack Mongo
 * via MONGO_URI and SKIPS gracefully when none is reachable (so default `pnpm test` stays green).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { TenantScope } from '@vip/tenancy';
import { LocalFsObjectStore } from '@vip/storage';
import type { RegisterEvidenceInput } from '@vip/contracts';
import { connectMongo, type MongoAdapter } from '../src/adapters/mongo.js';
import { EvidenceService } from '../src/application/evidence-service.js';

const URI =
  process.env.MONGO_URI ??
  'mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_evidence_test?authSource=admin';
const DB = 'vip_evidence_test';

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
const A = TenantScope.fromTenantId('tnt_a');
const B = TenantScope.fromTenantId('tnt_b');

describe.skipIf(!online)('evidence against real MongoDB + LocalFs storage', () => {
  let mongo: MongoAdapter;
  let dir: string;
  let store: LocalFsObjectStore;
  let service: EvidenceService;

  beforeAll(async () => {
    mongo = await connectMongo({ uri: URI, dbName: DB });
    dir = await mkdtemp(join(tmpdir(), 'vip-evd-int-'));
    store = new LocalFsObjectStore({ baseDir: dir });
  });
  afterAll(async () => {
    await mongo?.db.collection('evidence').deleteMany({});
    await mongo?.db.collection('evidence_custody').deleteMany({});
    await mongo?.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await mongo.db.collection('evidence').deleteMany({});
    await mongo.db.collection('evidence_custody').deleteMany({});
    let n = 0;
    service = new EvidenceService({
      store: mongo.evidence,
      custody: mongo.custody,
      objectStore: store,
      now: () => new Date('2026-07-30T10:00:00.000Z'),
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      downloadTtlSeconds: 900,
      defaultRetentionDays: 0,
    });
  });
  afterEach(async () => {
    /* cleaned in beforeEach */
  });

  async function put(scope: TenantScope, relKey: string, bytes: string): Promise<string> {
    await store.put({ key: `${scope.tenantId}/${relKey}`, body: bytes, contentType: 'image/jpeg' });
    return relKey;
  }

  function input(storageKey: string, capturedAt: string): RegisterEvidenceInput {
    return {
      kind: 'snapshot',
      storageKey,
      contentType: 'image/jpeg',
      capturedAt,
      source: { incidentId: 'inc_1' },
    };
  }

  it('registers idempotently and verifies the custody chain', async () => {
    const key = await put(A, 'cam_1/evidence/a.jpg', 'PIX');
    const first = await service.register(A, 'usr_1', input(key, '2026-07-30T09:00:00.000Z'));
    const second = await service.register(A, 'usr_1', input(key, '2026-07-30T09:00:00.000Z'));
    expect(second.id).toBe(first.id);
    expect((await service.list(A, { limit: 50 })).items).toHaveLength(1);
    await service.download(A, first.id, 'usr_1', 'review');
    expect(await service.verifyCustody(A, first.id)).toBe(true);
    const custody = await service.listCustody(A, first.id, { limit: 50 });
    expect(custody.items.map((c) => c.action)).toEqual(['created', 'accessed']);
  });

  it('paginates newest-first and isolates tenants', async () => {
    for (let i = 0; i < 3; i++) {
      const key = await put(A, `cam_1/evidence/p${i}.jpg`, `B${i}`);
      await service.register(A, 'usr_1', input(key, `2026-07-30T09:0${i}:00.000Z`));
    }
    const page1 = await service.list(A, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]!.capturedAt > page1.items[1]!.capturedAt).toBe(true);
    const page2 = await service.list(A, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);

    // Tenant B sees nothing and cannot read A's item.
    const aId = page1.items[0]!.id;
    expect((await service.list(B, { limit: 50 })).items).toHaveLength(0);
    await expect(service.get(B, aId)).rejects.toThrow(/not found/);
  });
});

/**
 * **Planner verification for TD-25** (P-5.1, Architect-approved F-1) — the half of index validation
 * only a real database can answer, and the half that found the coverage model wrong.
 *
 * `test/index-coverage.test.ts` proves the declaration is sound. This proves MongoDB agrees: for
 * every query the investigation workspace will issue, the planner picks the declared index, does
 * **no blocking `SORT`**, does **no `COLLSCAN`**, and — the measurement that actually matters —
 * examines a number of documents proportional to what it returns rather than to the tenant's whole
 * evidence history.
 *
 * Skipped without a database, which is a skip and not a pass (CONSTRAINTS §44).
 */
describe.skipIf(!online)('the planner uses the declared evidence indexes (TD-25)', () => {
  let client: MongoClient;
  let col: import('mongodb').Collection;

  const ROWS = 500;

  beforeAll(async () => {
    // A dedicated collection: this suite rebuilds indexes and measures examined/returned ratios,
    // so it must not share state with the fixtures above.
    client = new MongoClient(URI);
    await client.connect();
    col = client.db(DB).collection('evidence_planner');
    await col.deleteMany({});
    await col.dropIndexes().catch(() => {});
    await new (await import('../src/adapters/mongo-evidence-store.js')).MongoEvidenceStore(
      col as never,
    ).ensureIndexes();

    await col.insertMany(
      Array.from({ length: ROWS }, (_, i) => ({
        _id: `evd_${String(i).padStart(6, '0')}` as never,
        tenantId: 'tnt_a',
        kind: i % 2 ? 'clip' : 'snapshot',
        status: 'available',
        capturedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        source: {
          cameraId: `cam_${i % 10}`,
          incidentId: `inc_${i % 50}`,
          eventId: `evt_${i}`,
          correlationId: `corr_${i % 8}`,
        },
      })),
    );
  });

  afterAll(async () => {
    await col?.drop().catch(() => {});
    await client?.close();
  });

  async function plan(filter: Record<string, unknown>) {
    const e = (await col
      .find({ tenantId: 'tnt_a', ...filter })
      .sort({ capturedAt: -1, _id: -1 })
      .limit(50)
      .explain('executionStats')) as {
      queryPlanner: { winningPlan: Record<string, unknown> };
      executionStats: { totalDocsExamined: number; nReturned: number };
    };
    const json = JSON.stringify(e.queryPlanner.winningPlan);
    return {
      index: json.match(/"indexName":"([^"]+)"/)?.[1] ?? '(none)',
      blockingSort: json.includes('"stage":"SORT"'),
      collscan: json.includes('COLLSCAN'),
      examined: e.executionStats.totalDocsExamined,
      returned: e.executionStats.nReturned,
    };
  }

  const CASES: [string, string, Record<string, unknown>][] = [
    ['unfiltered', 'tenant_captured', {}],
    ['incidentId — the workspace panel', 'tenant_incident', { 'source.incidentId': 'inc_3' }],
    ['correlationId — the spine', 'tenant_correlation', { 'source.correlationId': 'corr_5' }],
    ['eventId', 'tenant_event', { 'source.eventId': 'evt_7' }],
    ['cameraId', 'tenant_camera', { 'source.cameraId': 'cam_3' }],
    ['kind + status', 'tenant_kind_status', { kind: 'clip', status: 'available' }],
  ];

  it.each(CASES)('%s — uses %s, no blocking sort, no collscan', async (_n, expected, filter) => {
    const p = await plan(filter);
    expect(p.index, `expected the planner to choose ${expected}`).toBe(expected);
    expect(p.blockingSort, 'a blocking SORT is the 32 MB cliff TD-25 recorded').toBe(false);
    expect(p.collscan).toBe(false);
  });

  /**
   * ⚠️ The assertion that actually encodes TD-25. Before P-5.1 `eventId` examined **all 500
   * documents to return 1** — no COLLSCAN and no blocking sort, which is exactly why reading the
   * index list understated it. The ratio is the defect.
   */
  it('examines documents in proportion to what it returns, not to the tenant history', async () => {
    const identity = await plan({ 'source.eventId': 'evt_7' });
    expect(identity.returned).toBe(1);
    expect(
      identity.examined,
      `examined ${identity.examined} of ${ROWS} rows to return 1 — the TD-25 defect`,
    ).toBeLessThanOrEqual(2);

    const spine = await plan({ 'source.correlationId': 'corr_5' });
    expect(spine.examined).toBeLessThanOrEqual(spine.returned + 1);
  });

  /**
   * The migration TD-25 performs, proven rather than trusted. Three index names already exist in
   * deployed databases with a **different key set**; re-declaring one is an `IndexOptionsConflict`
   * that fails the service at boot, so `ensureIndexes` drops and rebuilds. This runs once per
   * deployment and its failure mode is "the service will not start".
   */
  it('rebuilds a pre-P-5.1 index whose keys changed, instead of failing to start', async () => {
    await col.dropIndexes().catch(() => {});
    // Recreate `tenant_incident` exactly as it was — stopping at `capturedAt`.
    await col.createIndex(
      { tenantId: 1, 'source.incidentId': 1, capturedAt: -1 },
      { name: 'tenant_incident' },
    );
    const before = await plan({ 'source.incidentId': 'inc_3' });
    expect(before.blockingSort, 'the old index really did sort in memory').toBe(true);

    const { MongoEvidenceStore } = await import('../src/adapters/mongo-evidence-store.js');
    await new MongoEvidenceStore(col as never).ensureIndexes();

    const rebuilt = (await col.indexes()).find((i) => i.name === 'tenant_incident');
    expect(rebuilt?.key).toEqual({ tenantId: 1, 'source.incidentId': 1, capturedAt: -1, _id: -1 });
    expect((await plan({ 'source.incidentId': 'inc_3' })).blockingSort).toBe(false);
  });
});
