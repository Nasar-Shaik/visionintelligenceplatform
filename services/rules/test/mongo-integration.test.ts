/**
 * Integration — the rule store against a REAL MongoDB. Proves versioning/audit persistence, the
 * enabled-rules query, and tenant isolation through the guard. Uses the dev-stack Mongo via
 * MONGO_URI and SKIPS gracefully when none is reachable (so default `pnpm test` stays green).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { TenantScope } from '@vip/tenancy';
import { connectMongo, type MongoAdapter } from '../src/adapters/mongo.js';
import { MongoRuleStore } from '../src/adapters/mongo-rule-store.js';
import { personRuleInput } from './helpers.js';

const URI = process.env.MONGO_URI ?? 'mongodb://localhost:47017/vip_rules_test';
const DB = 'vip_rules_test';

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
const scopeA = TenantScope.fromTenantId('tnt_a');
const scopeB = TenantScope.fromTenantId('tnt_b');

describe.skipIf(!online)('rule store against real MongoDB', () => {
  let mongo: MongoAdapter;
  let store: MongoRuleStore;

  beforeAll(async () => {
    mongo = await connectMongo({ uri: URI, dbName: DB });
    store = new MongoRuleStore({ rules: mongo.rules, versions: mongo.versions });
  });

  afterAll(async () => {
    await mongo?.rules.deleteMany({});
    await mongo?.versions.deleteMany({});
    await mongo?.close();
  });

  beforeEach(async () => {
    await mongo.rules.deleteMany({});
    await mongo.versions.deleteMany({});
  });

  it('persists a rule + audit trail and lists only enabled rules', async () => {
    const enabled = await store.create(scopeA, personRuleInput({ lifecycle: 'enabled' }), 'u1');
    await store.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    await store.update(scopeA, enabled.id, { severity: 'critical' }, 'u2');

    const enabledRules = await store.listEnabled(scopeA);
    expect(enabledRules).toHaveLength(1);
    expect(enabledRules[0]!.severity).toBe('critical');
    expect(enabledRules[0]!.version).toBe(2);

    const versions = await store.listVersions(scopeA, enabled.id);
    expect(versions.map((v) => v.changeKind)).toEqual(['updated', 'created']);
  });

  it("never returns another tenant's rules (guarded reads)", async () => {
    await store.create(scopeA, personRuleInput({ lifecycle: 'enabled' }));
    expect(await store.list(scopeB)).toHaveLength(0);
    expect(await store.listEnabled(scopeB)).toHaveLength(0);
  });
});
