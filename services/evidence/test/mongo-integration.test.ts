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
