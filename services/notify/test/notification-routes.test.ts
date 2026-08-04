/**
 * HTTP tests — the delivery-log read + recipient ack: authorization (viewer can read, needs
 * notification:ack to acknowledge), the ack transition, and the 409 when a notification is not in an
 * ackable state. A notification is seeded directly into the store in a `delivered` state.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import type { Notification } from '@vip/contracts';
import { loadConfig } from '../src/config/env.js';
import { ChannelService } from '../src/application/channel-service.js';
import { NotificationService } from '../src/application/notification-service.js';
import { InMemoryChannelStore } from '../src/adapters/in-memory-channel-store.js';
import { InMemoryNotificationStore } from '../src/adapters/in-memory-notification-store.js';
import { buildServer } from '../src/transport/server.js';
import { SECRET, token, authHeader } from './helpers.js';

let app: FastifyInstance;
let store: InMemoryNotificationStore;

function seededNotification(status: Notification['status']): Notification {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    tenantId: 'tnt_a',
    incidentId: '11111111-1111-4111-8111-111111111111',
    channelId: 'ch_1',
    channelType: 'in-app',
    status,
    severity: 'critical',
    title: 'High-confidence person',
    correlationId: 'corr-abc',
    causationId: '11111111-1111-4111-8111-111111111111',
    attempts: 1,
    createdAt: '2026-07-29T22:00:00.000Z',
    updatedAt: '2026-07-29T22:00:00.000Z',
  };
}

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'notify',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://localhost:47017/vip_notify',
    NATS_URL: 'nats://localhost:44222',
    JWT_SECRET: SECRET,
  });
  store = new InMemoryNotificationStore();
  const notificationService = new NotificationService({ store });
  const channelService = new ChannelService({ store: new InMemoryChannelStore() });
  app = (await buildServer({ config, channelService, notificationService, startedAt: new Date() }))
    .app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('delivery log + ack', () => {
  it('a viewer can list but cannot ack', async () => {
    await store.insert(TenantScope.fromTenantId('tnt_a'), seededNotification('delivered'));
    const viewer = await token('tnt_a', ['viewer']);
    expect(
      (await app.inject({ method: 'GET', url: '/notifications', headers: authHeader(viewer) }))
        .statusCode,
    ).toBe(200);
    const ack = await app.inject({
      method: 'POST',
      url: '/notifications/44444444-4444-4444-8444-444444444444/ack',
      headers: authHeader(viewer),
    });
    expect(ack.statusCode).toBe(403);
  });

  it('an operator acknowledges a delivered notification', async () => {
    await store.insert(TenantScope.fromTenantId('tnt_a'), seededNotification('delivered'));
    const op = await token('tnt_a', ['operator']);
    const ack = await app.inject({
      method: 'POST',
      url: '/notifications/44444444-4444-4444-8444-444444444444/ack',
      headers: authHeader(op),
    });
    expect(ack.statusCode).toBe(200);
    /* ⚠️ The **authenticated** principal, with no cooperation required from the caller. */
    expect(ack.json().data).toMatchObject({ status: 'acked', ackedBy: 'u@acme.com' });
  });

  /**
   * ⚠️ **Found by looking at what the inbox rendered.** `ackedBy` came entirely from the request
   * body, so the console — which sent nothing — produced acknowledgements attributed to **nobody**,
   * and any caller who did send it could name **anyone**. The record of who took a security alert
   * was whatever the caller typed.
   *
   * The field stays in the contract, because removing it would break existing callers, and it is no
   * longer honoured: an audit field a caller can choose is not an audit field.
   */
  it('⚠️ ignores a caller-supplied acknowledger — it is not theirs to choose', async () => {
    await store.insert(TenantScope.fromTenantId('tnt_a'), seededNotification('delivered'));
    const op = await token('tnt_a', ['operator']);
    const ack = await app.inject({
      method: 'POST',
      url: '/notifications/44444444-4444-4444-8444-444444444444/ack',
      headers: authHeader(op),
      payload: { by: 'somebody-else@elsewhere.example' },
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().data.ackedBy).toBe('u@acme.com');
  });

  it('⚠️ never records an acknowledgement with no acknowledger', async () => {
    await store.insert(TenantScope.fromTenantId('tnt_a'), seededNotification('delivered'));
    const op = await token('tnt_a', ['operator']);
    const ack = await app.inject({
      method: 'POST',
      url: '/notifications/44444444-4444-4444-8444-444444444444/ack',
      headers: authHeader(op),
      payload: {},
    });
    // A queue nobody signs is a queue nobody owns.
    expect(ack.json().data.ackedBy).toBeTruthy();
  });

  it('rejects acking a failed notification with 409', async () => {
    await store.insert(TenantScope.fromTenantId('tnt_a'), seededNotification('failed'));
    const op = await token('tnt_a', ['operator']);
    const ack = await app.inject({
      method: 'POST',
      url: '/notifications/44444444-4444-4444-8444-444444444444/ack',
      headers: authHeader(op),
    });
    expect(ack.statusCode).toBe(409);
  });

  /**
   * ⚠️ **The inbox filter, and the reason it is not just another status.**
   *
   * "What has nobody dealt with" is the complement of one state — `pending`, `sent`, `delivered`
   * *and* `failed`. Answering it by fetching everything and filtering in the browser answers it
   * correctly for the rows that happen to be loaded and silently wrongly for the rest, which is how
   * an unread badge becomes a lie.
   */
  it('⚠️ selects everything except acked, including failed', async () => {
    const scope = TenantScope.fromTenantId('tnt_a');
    await store.insert(scope, {
      ...seededNotification('acked'),
      id: '44444444-4444-4444-8444-000000000001',
    });
    await store.insert(scope, {
      ...seededNotification('delivered'),
      id: '44444444-4444-4444-8444-000000000002',
    });
    await store.insert(scope, {
      ...seededNotification('failed'),
      id: '44444444-4444-4444-8444-000000000003',
    });
    await store.insert(scope, {
      ...seededNotification('pending'),
      id: '44444444-4444-4444-8444-000000000004',
    });
    const op = await token('tnt_a', ['operator']);

    const unread = await app.inject({
      method: 'GET',
      url: '/notifications?acknowledged=false',
      headers: authHeader(op),
    });
    const statuses = unread
      .json()
      .data.items.map((n: { status: string }) => n.status)
      .sort();
    /* ⚠️ `failed` is included: it reached nobody, so nobody can have acted on it. */
    expect(statuses).toEqual(['delivered', 'failed', 'pending']);

    const read = await app.inject({
      method: 'GET',
      url: '/notifications?acknowledged=true',
      headers: authHeader(op),
    });
    expect(read.json().data.items.map((n: { status: string }) => n.status)).toEqual(['acked']);
  });

  /**
   * ⚠️ A query string carries text, and `Boolean('false')` is `true`. A coercion bug here turns
   * "unread only" into "everything" while every test that passes a real boolean stays green.
   */
  it('⚠️ reads acknowledged=false as false, not as a non-empty string', async () => {
    const scope = TenantScope.fromTenantId('tnt_a');
    await store.insert(scope, {
      ...seededNotification('acked'),
      id: '44444444-4444-4444-8444-000000000005',
    });
    const op = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'GET',
      url: '/notifications?acknowledged=false',
      headers: authHeader(op),
    });
    expect(res.json().data.items).toHaveLength(0);
  });

  it('ignores an unparseable acknowledged value rather than guessing', async () => {
    const scope = TenantScope.fromTenantId('tnt_a');
    await store.insert(scope, seededNotification('acked'));
    const op = await token('tnt_a', ['operator']);
    const res = await app.inject({
      method: 'GET',
      url: '/notifications?acknowledged=maybe',
      headers: authHeader(op),
    });
    expect(res.json().data.items).toHaveLength(1);
  });

  it('filters the delivery log by status, tenant-scoped', async () => {
    await store.insert(TenantScope.fromTenantId('tnt_a'), seededNotification('delivered'));
    const op = await token('tnt_a', ['operator']);
    const delivered = await app.inject({
      method: 'GET',
      url: '/notifications?status=delivered',
      headers: authHeader(op),
    });
    expect(delivered.json().data.items).toHaveLength(1);
    const other = await token('tnt_b', ['operator']);
    const none = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: authHeader(other),
    });
    expect(none.json().data.items).toHaveLength(0);
  });
});
