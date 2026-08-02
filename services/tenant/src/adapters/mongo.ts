/**
 * Adapter: MongoDB connection + collections for the tenant service. Owns connection lifecycle,
 * index creation, and a readiness ping. Collections are handed to @vip/tenancy repositories by
 * the composition root — no other module talks to the driver directly (STORAGE_ARCHITECTURE).
 */
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { OrgNodeDoc, TenantDoc } from '../domain/tenant.js';

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
  // Tenant-leading indexes so every query is served by a tenant-scoped index (Law 5).
  await orgNodes.createIndex({ tenantId: 1, parentId: 1 }, { name: 'tenant_parent' });
  await orgNodes.createIndex({ tenantId: 1, type: 1 }, { name: 'tenant_type' });
  /*
   * The three P-3 access patterns, each an index rather than a walk (rec 6):
   *  - `path` is multikey: "everything under this node" is one indexed lookup at any depth.
   *  - `depth` serves the shallowest-first tree read, so a truncated estate is complete from the top.
   *  - `status` keeps archived locations out of working views without scanning them.
   */
  await orgNodes.createIndex({ tenantId: 1, path: 1 }, { name: 'tenant_path' });
  await orgNodes.createIndex({ tenantId: 1, depth: 1, _id: 1 }, { name: 'tenant_depth' });
  await orgNodes.createIndex({ tenantId: 1, status: 1, _id: 1 }, { name: 'tenant_status' });
}
