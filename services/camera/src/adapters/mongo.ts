/**
 * Adapter: MongoDB connection + collections for the camera service. Owns connection lifecycle,
 * index creation, and a readiness ping. The `cameras` and `camera_probes` collections are
 * handed to @vip/tenancy repositories by the composition root — no other module talks to the driver
 * (STORAGE_ARCHITECTURE).
 */
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { CameraDoc } from '../domain/camera.js';
import type { ProbeRecordDoc } from '../domain/probe-archive.js';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  cameras: Collection<CameraDoc>;
  /** The immutable probe archive (P-2.2). Append-only: nothing in the service ever updates it. */
  probes: Collection<ProbeRecordDoc>;
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
  const probes = db.collection<ProbeRecordDoc>('camera_probes');
  await ensureIndexes(cameras, probes);
  return {
    client,
    db,
    cameras,
    probes,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

async function ensureIndexes(
  cameras: Collection<CameraDoc>,
  probes: Collection<ProbeRecordDoc>,
): Promise<void> {
  // A stream URL is unique within a tenant (idempotent onboarding / duplicate → 409). Tenant-leading
  // so the index is tenant-scoped (Law 5); the same URL may legitimately exist in another tenant.
  await cameras.createIndex(
    { tenantId: 1, streamUrl: 1 },
    { unique: true, name: 'uniq_tenant_stream' },
  );
  // Subtree/listing queries by location, tenant-scoped.
  await cameras.createIndex({ tenantId: 1, zoneId: 1 }, { name: 'tenant_zone' });
  // P-2.2: probe history is read newest-first per camera, and aggregated per tenant for the fleet
  // view. Descending on `at` so both reads walk the index rather than sorting a scan.
  await probes.createIndex({ tenantId: 1, cameraId: 1, at: -1 }, { name: 'tenant_camera_at' });
  await probes.createIndex({ tenantId: 1, at: -1 }, { name: 'tenant_at' });
}
