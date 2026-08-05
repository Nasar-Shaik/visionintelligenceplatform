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
import { NotificationService } from '../src/application/notification-service.js';
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

/*
 * ⚠️ **This suite carries the acknowledgement-race regression, and a skip is silent.**
 *
 * Two operators taking the same alert is a defect that only a real database can catch — the
 * in-memory store serialises every operation, so the same scenario written against it passes on the
 * defect. That makes this file the only thing standing between a refactor and the race coming back,
 * and it is excluded from `pnpm test` (integration) *and* skips itself when no MongoDB is reachable.
 * A regression guard that can quietly not run is a guard that can only pass. The production gate
 * sets `VIP_REQUIRE_MONGO=1`, which turns "no database" from a shrug into a failure. See TD-56.
 */
if (!online && process.env['VIP_REQUIRE_MONGO'] === '1') {
  throw new Error(
    `VIP_REQUIRE_MONGO=1 but no MongoDB is reachable at ${URI} — the acknowledgement-race regression cannot run, and a green result would mean nothing`,
  );
}

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

  /**
   * ⚠️ **Two operators, one alert — and this test lives here because it cannot fail anywhere else.**
   *
   * `ack` used to read the record, check it was acknowledgeable, and write it back. Against the
   * in-memory store that is flawless: nothing interleaves between the find and the assignment, so
   * every unit test passed. Against real MongoDB, where each call is real I/O the event loop can
   * suspend on, twelve simultaneous acknowledgements of one alert produced **two to four winners**,
   * measured on the deployment — each operator told they had the incident, the record naming
   * whichever write landed last.
   *
   * Verified red before the fix: this assertion saw 5 winners.
   */
  it('⚠️ concurrent acknowledgements of one alert produce exactly one winner', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    await notifications.insert(scopeA, notification(id, 'inc_race', 'ch_race'));

    const service = new NotificationService({ store: notifications });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => service.ack(scopeA, id, {}, `operator-${i}@acme.test`)),
    );

    const winners = results.filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    /* Every loser is refused, and refused as a conflict rather than a crash. */
    for (const loser of results.filter((r) => r.status === 'rejected')) {
      expect((loser.reason as { statusCode?: number }).statusCode).toBe(409);
    }
    /* ⚠️ And the stored record names the operator who was told they had it. */
    const stored = await notifications.get(scopeA, id);
    expect(stored?.status).toBe('acked');
    expect(stored?.ackedBy).toBe(
      (winners[0] as PromiseFulfilledResult<Notification>).value.ackedBy,
    );
  });
});
