/**
 * Adapter: MongoDB connection + collections for the tenant service. Owns connection lifecycle,
 * index creation, and a readiness ping. Collections are handed to @vip/tenancy repositories by
 * the composition root — no other module talks to the driver directly (STORAGE_ARCHITECTURE).
 */
import { MongoClient, type Collection, type Db, type IndexSpecification } from 'mongodb';
import type { OrgNodeDoc, TenantDoc } from '../domain/tenant.js';
import { ORG_NODE_INDEXES } from './indexes.js';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  tenants: Collection<TenantDoc>;
  orgNodes: Collection<OrgNodeDoc>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectMongoOptions {
  uri: string;
  dbName?: string;
  /** Fail fast if no server is selectable within this many ms (default 5000). */
  serverSelectionTimeoutMS?: number;
}

export async function connectMongo(opts: ConnectMongoOptions): Promise<MongoAdapter> {
  const client = new MongoClient(opts.uri, {
    serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS ?? 5000,
  });
  await client.connect();
  // Honor the database in the connection string; `dbName` overrides (used by tests for isolation).
  const db = opts.dbName ? client.db(opts.dbName) : client.db();
  const tenants = db.collection<TenantDoc>('tenants');
  const orgNodes = db.collection<OrgNodeDoc>('org_nodes');
  await ensureIndexes(tenants, orgNodes);
  return {
    client,
    db,
    tenants,
    orgNodes,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

async function ensureIndexes(
  tenants: Collection<TenantDoc>,
  orgNodes: Collection<OrgNodeDoc>,
): Promise<void> {
  // Slug is globally unique in the tenant registry.
  await tenants.createIndex({ slug: 1 }, { unique: true, name: 'uniq_slug' });

  /*
   * Location-hierarchy indexes, created from the declared specs so the code and the coverage test
   * cannot disagree. Every one is tenant-leading (Law 5) and ends in `_id` (the cursor) — see
   * `indexes.ts` for why the trailing key is load-bearing rather than cosmetic.
   */
  for (const spec of ORG_NODE_INDEXES) {
    if (spec.implicit) continue; // `_id_` is created by MongoDB; declared only so coverage sees it.
    const keys = Object.fromEntries(spec.keys.map((key) => [key, 1]));
    await orgNodes.createIndex(keys as IndexSpecification, { name: spec.name });
  }
}
