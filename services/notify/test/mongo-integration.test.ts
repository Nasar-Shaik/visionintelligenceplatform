/**
 * Integration — the channel + notification stores against a REAL MongoDB. Proves channel persistence
 * + enabled query + tenant isolation, and the delivery log's idempotency (unique
 * `(tenantId, incidentId, channelId)`). Uses the dev-stack Mongo via MONGO_URI and SKIPS gracefully
 * when none is reachable (probing with an auth-requiring op so an auth-gated Mongo skips cleanly).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { TenantScope } from '@vip/tenancy';
import type { Notification } from '@vip/contracts';
import { connectMongo, type MongoAdapter } from '../src/adapters/mongo.js';
import { MongoChannelStore } from '../src/adapters/mongo-channel-store.js';
import { MongoNotificationStore } from '../src/adapters/mongo-notification-store.js';
import { inAppChannelInput } from './helpers.js';

const URI =
  process.env.MONGO_URI ??
  'mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_notify_test?authSource=admin';
const DB = 'vip_notify_test';

async function reachable(): Promise<boolean> {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 500 });
  try {
    await client.connect();
    await client.db(DB).collection('notifications').findOne({});
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

function notification(id: string, incidentId: string, channelId: string): Notification {
  return {
    id,
    tenantId: 'tnt_a',
    incidentId,
    channelId,
    channelType: 'in-app',
    status: 'sent',
    severity: 'critical',
    title: 'x',
    correlationId: 'corr-abc',
    causationId: incidentId,
    attempts: 1,
    createdAt: '2026-07-29T22:00:00.000Z',
    updatedAt: '2026-07-29T22:00:00.000Z',
  };
}

describe.skipIf(!online)('notify stores against real MongoDB', () => {
  let mongo: MongoAdapter;
  let channels: MongoChannelStore;
  let notifications: MongoNotificationStore;

  beforeAll(async () => {
    mongo = await connectMongo({ uri: URI, dbName: DB });
    channels = new MongoChannelStore({ channels: mongo.channels, newId: () => 'ch_1' });
    notifications = new MongoNotificationStore({ notifications: mongo.notifications });
  });

  afterAll(async () => {
    await mongo?.channels.deleteMany({});
    await mongo?.notifications.deleteMany({});
    await mongo?.close();
  });

  beforeEach(async () => {
    await mongo.channels.deleteMany({});
    await mongo.notifications.deleteMany({});
  });

  it('persists channels + lists only enabled, tenant-scoped', async () => {
    await channels.create(scopeA, inAppChannelInput({ enabled: true }));
    const enabled = await channels.listEnabled(scopeA);
    expect(enabled).toHaveLength(1);
    expect(await channels.listEnabled(scopeB)).toHaveLength(0);
  });

  it('enforces delivery-log idempotency on (incident, channel)', async () => {
    const id1 = '44444444-4444-4444-8444-444444444444';
    const id2 = '55555555-5555-4555-8555-555555555555';
    await notifications.insert(scopeA, notification(id1, 'inc_1', 'ch_1'));
    await expect(
      notifications.insert(scopeA, notification(id2, 'inc_1', 'ch_1')),
    ).rejects.toThrow();
    expect(await notifications.existsForIncidentChannel(scopeA, 'inc_1', 'ch_1')).toBe(true);
  });
});
