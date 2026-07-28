/**
 * Adapter: MongoDB connection + collections for the camera service. Owns connection lifecycle,
 * index creation, and a readiness ping. The `cameras` collection is handed to a @vip/tenancy
 * repository by the composition root — no other module talks to the driver (STORAGE_ARCHITECTURE).
 */
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { CameraDoc } from '../domain/camera.js';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  cameras: Collection<CameraDoc>;
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
  const cameras = db.collection<CameraDoc>('cameras');
  await ensureIndexes(cameras);
  return {
    client,
    db,
    cameras,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

async function ensureIndexes(cameras: Collection<CameraDoc>): Promise<void> {
  // A stream URL is unique within a tenant (idempotent onboarding / duplicate → 409). Tenant-leading
  // so the index is tenant-scoped (Law 5); the same URL may legitimately exist in another tenant.
  await cameras.createIndex(
    { tenantId: 1, streamUrl: 1 },
    { unique: true, name: 'uniq_tenant_stream' },
  );
  // Subtree/listing queries by location, tenant-scoped.
  await cameras.createIndex({ tenantId: 1, zoneId: 1 }, { name: 'tenant_zone' });
}
