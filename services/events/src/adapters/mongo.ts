/**
 * Adapter: MongoDB connection + the `events` collection for the event store. Owns connection
 * lifecycle, index creation, and a readiness ping. The collection is handed to a @vip/tenancy
 * repository by the composition root — no other module talks to the driver (STORAGE_ARCHITECTURE).
 * The stored document is an `EventEnvelope` plus a `dedupKey`; the unique `{tenantId, dedupKey}`
 * index is what makes normalization idempotent (at-least-once safe).
 */
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { EventEnvelope } from '@vip/contracts';

/** The persisted shape: the envelope + its dedup key (tenantId is already on the envelope). */
export interface EventDoc extends EventEnvelope {
  dedupKey: string;
}

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  events: Collection<EventDoc>;
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
  const events = db.collection<EventDoc>('events');
  await ensureIndexes(events);
  return {
    client,
    db,
    events,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

async function ensureIndexes(events: Collection<EventDoc>): Promise<void> {
  // Idempotency + correlation dedup: one event per dedup key within a tenant. A duplicate insert
  // (redelivery or a repeated subject inside the window) hits this and is collapsed (Law 5 leading).
  await events.createIndex(
    { tenantId: 1, dedupKey: 1 },
    { unique: true, name: 'uniq_tenant_dedup' },
  );
  // Query/replay by time, tenant-scoped and newest-first.
  await events.createIndex({ tenantId: 1, occurredAt: -1 }, { name: 'tenant_occurredAt' });
  // Filtered queries by type / camera, tenant-scoped.
  await events.createIndex({ tenantId: 1, type: 1, occurredAt: -1 }, { name: 'tenant_type_time' });
  await events.createIndex(
    { tenantId: 1, cameraId: 1, occurredAt: -1 },
    { name: 'tenant_camera_time' },
  );
}
