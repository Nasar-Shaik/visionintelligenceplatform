/**
 * Adapter: MongoDB connection + the `rules` and `rule_versions` collections. Owns connection
 * lifecycle, index creation, and a readiness ping. Collections are handed to a @vip/tenancy
 * repository by the composition root — no other module talks to the driver. `rule_versions` is the
 * immutable audit trail (one row per rule version).
 */
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Rule, RuleVersionRecord } from '@vip/contracts';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  rules: Collection<Rule>;
  versions: Collection<RuleVersionRecord>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectMongoOptions {
  uri: string;
  dbName?: string;
  serverSelectionTimeoutMS?: number;
}

export async function connectMongo(opts: ConnectMongoOptions): Promise<MongoAdapter> {
  const client = new MongoClient(opts.uri, {
    serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS ?? 5000,
  });
  await client.connect();
  const db = opts.dbName ? client.db(opts.dbName) : client.db();
  const rules = db.collection<Rule>('rules');
  const versions = db.collection<RuleVersionRecord>('rule_versions');
  await ensureIndexes(rules, versions);
  return {
    client,
    db,
    rules,
    versions,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

async function ensureIndexes(
  rules: Collection<Rule>,
  versions: Collection<RuleVersionRecord>,
): Promise<void> {
  // One rule id per tenant (tenant-leading, Law 5).
  await rules.createIndex({ tenantId: 1, id: 1 }, { unique: true, name: 'uniq_tenant_rule' });
  // Engine hot path: fetch a tenant's enabled rules, ordered.
  await rules.createIndex(
    { tenantId: 1, lifecycle: 1, priority: -1 },
    { name: 'tenant_lifecycle_priority' },
  );
  // Audit trail: one row per (rule, version); listable newest-first.
  await versions.createIndex(
    { tenantId: 1, ruleId: 1, version: -1 },
    { unique: true, name: 'uniq_tenant_rule_version' },
  );
}
