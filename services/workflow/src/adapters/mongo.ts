/**
 * Adapter: MongoDB connection + the `incidents` collection. Owns connection lifecycle, index
 * creation, and a readiness ping. The collection is handed to a @vip/tenancy repository by the
 * composition root — no other module talks to the driver. Uniqueness on `(tenantId, source.dedupKey)`
 * is what makes candidate promotion idempotent even across restarts / concurrent consumers.
 */
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Incident } from '@vip/contracts';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  incidents: Collection<Incident>;
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
  const incidents = db.collection<Incident>('incidents');
  await ensureIndexes(incidents);
  return {
    client,
    db,
    incidents,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

async function ensureIndexes(incidents: Collection<Incident>): Promise<void> {
  // One incident id per tenant (tenant-leading, Law 5).
  await incidents.createIndex(
    { tenantId: 1, id: 1 },
    { unique: true, name: 'uniq_tenant_incident' },
  );
  // Idempotent promotion: at most one incident per (tenant, candidate dedup key).
  await incidents.createIndex(
    { tenantId: 1, 'source.dedupKey': 1 },
    { unique: true, name: 'uniq_tenant_dedupkey' },
  );
  // List hot path: newest-first, filterable by status/severity.
  await incidents.createIndex(
    { tenantId: 1, raisedAt: -1, id: -1 },
    { name: 'tenant_raisedAt_id' },
  );
}
