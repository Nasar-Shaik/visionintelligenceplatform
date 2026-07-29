/**
 * HTTP tests — notification-channel CRUD driven in-memory: authorization (deny-by-default), per-type
 * config validation (webhook needs a URL), and tenant scoping (404 across tenants). Tokens are minted
 * directly with @vip/auth using identity's iss/aud.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { ChannelService } from '../src/application/channel-service.js';
import { NotificationService } from '../src/application/notification-service.js';
import { InMemoryChannelStore } from '../src/adapters/in-memory-channel-store.js';
import { InMemoryNotificationStore } from '../src/adapters/in-memory-notification-store.js';
import { buildServer } from '../src/transport/server.js';
import { SECRET, token, authHeader, inAppChannelInput, webhookChannelInput } from './helpers.js';

let app: FastifyInstance;

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'notify',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://localhost:47017/vip_notify',
    NATS_URL: 'nats://localhost:44222',
    JWT_SECRET: SECRET,
  });
  const channelService = new ChannelService({ store: new InMemoryChannelStore() });
  const notificationService = new NotificationService({ store: new InMemoryNotificationStore() });
  app = (await buildServer({ config, channelService, notificationService, startedAt: new Date() }))
    .app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const createChannel = async (t: string, body: unknown = inAppChannelInput()) =>
  app.inject({
    method: 'POST',
    url: '/notification-channels',
    headers: authHeader(t),
    payload: body,
  });

describe('authorization', () => {
  it('POST without a token → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notification-channels',
      payload: inAppChannelInput(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('a viewer cannot create a channel (needs notification:create)', async () => {
    const res = await createChannel(await token('tnt_a', ['viewer']));
    expect(res.statusCode).toBe(403);
  });

  it('an admin can create + list channels', async () => {
    const admin = await token('tnt_a', ['admin']);
    expect((await createChannel(admin)).statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: '/notification-channels',
      headers: authHeader(admin),
    });
    expect(list.json().data).toHaveLength(1);
  });
});

describe('config validation', () => {
  it('rejects a webhook channel with a missing/invalid url → 400', async () => {
    const admin = await token('tnt_a', ['admin']);
    const res = await createChannel(admin, webhookChannelInput({ config: { url: 'not-a-url' } }));
    expect(res.statusCode).toBe(400);
  });

  it('accepts a valid webhook channel', async () => {
    const admin = await token('tnt_a', ['admin']);
    const res = await createChannel(admin, webhookChannelInput());
    expect(res.statusCode).toBe(201);
    expect(res.json().data.type).toBe('webhook');
  });
});

describe('tenant scoping', () => {
  it("GET another tenant's channel → 404 (no existence leak)", async () => {
    const created = (await createChannel(await token('tnt_a', ['admin']))).json().data;
    const other = await token('tnt_b', ['admin']);
    const res = await app.inject({
      method: 'GET',
      url: `/notification-channels/${created.id}`,
      headers: authHeader(other),
    });
    expect(res.statusCode).toBe(404);
  });
});
