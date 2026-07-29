/**
 * Adapter: MongoDB connection + the `notification_channels` and `notifications` (delivery-log)
 * collections. Owns connection lifecycle, index creation, and a readiness ping. Collections are
 * handed to @vip/tenancy repositories by the composition root. Uniqueness on
 * `(tenantId, incidentId, channelId)` makes fan-out idempotent under redelivery.
 */
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Notification, NotificationChannel } from '@vip/contracts';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  channels: Collection<NotificationChannel>;
  notifications: Collection<Notification>;
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
  const channels = db.collection<NotificationChannel>('notification_channels');
  const notifications = db.collection<Notification>('notifications');
  await ensureIndexes(channels, notifications);
  return {
    client,
    db,
    channels,
    notifications,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

async function ensureIndexes(
  channels: Collection<NotificationChannel>,
  notifications: Collection<Notification>,
): Promise<void> {
  await channels.createIndex({ tenantId: 1, id: 1 }, { unique: true, name: 'uniq_tenant_channel' });
  await channels.createIndex({ tenantId: 1, enabled: 1 }, { name: 'tenant_enabled' });
  await notifications.createIndex(
    { tenantId: 1, id: 1 },
    { unique: true, name: 'uniq_tenant_notification' },
  );
  // Idempotent fan-out: at most one notification per (tenant, incident, channel).
  await notifications.createIndex(
    { tenantId: 1, incidentId: 1, channelId: 1 },
    { unique: true, name: 'uniq_tenant_incident_channel' },
  );
  // Delivery-log list hot path: newest-first, filterable by incident/status.
  await notifications.createIndex(
    { tenantId: 1, createdAt: -1, id: -1 },
    { name: 'tenant_createdAt_id' },
  );
}
