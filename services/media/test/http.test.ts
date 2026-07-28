/**
 * HTTP tests — stream control/status driven in-memory (fakes): authorization (deny-by-default),
 * the 202/200/404 status codes, and cross-tenant isolation. Tokens are minted with @vip/auth
 * (this service verifies, it does not log in) using identity's iss/aud.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '@vip/auth';
import { loadConfig } from '../src/config/env.js';
import { StreamSupervisor } from '../src/application/stream-supervisor.js';
import { buildServer } from '../src/transport/server.js';
import { FakeCameraSource, FakeDecoder, memoryObjectStore } from './helpers.js';

const SECRET = 'test-secret-at-least-16-chars';
const TENANT = 'tnt_a';
const OTHER = 'tnt_b';

let app: FastifyInstance;

function token(tenantId: string, roles: string[]): Promise<string> {
  return signAccessToken(
    { principalId: 'usr_1', tenantId, email: 'u@acme.com', roles },
    { secret: SECRET, issuer: 'identity', audience: 'vip' },
  ).then((r) => r.token);
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'media',
    LOG_LEVEL: 'silent',
    JWT_SECRET: SECRET,
    S3_ENDPOINT: 'http://localhost:49000',
    AWS_ACCESS_KEY_ID: 'k',
    AWS_SECRET_ACCESS_KEY: 's',
    INTERNAL_API_KEY: 'internal-key-at-least-16-chars',
    CAMERA_URL: 'http://localhost:8082',
  });
  const supervisor = new StreamSupervisor({
    cameraSource: new FakeCameraSource(),
    decoder: new FakeDecoder(),
    objectStore: memoryObjectStore(),
    frameSink: { push: () => {} },
    clock: { now: () => new Date('2026-07-28T00:00:00.000Z') },
    options: { frameRate: 2, segmentSeconds: 6 },
  });
  app = (await buildServer({ config, supervisor, startedAt: new Date() })).app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('infra', () => {
  it('GET /health → 200', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });
});

describe('authorization (deny-by-default)', () => {
  it('401 without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/streams' })).statusCode).toBe(401);
  });

  it('viewer may read streams but not control them (403)', async () => {
    const viewer = await token(TENANT, ['viewer']);
    expect(
      (await app.inject({ method: 'GET', url: '/streams', headers: auth(viewer) })).statusCode,
    ).toBe(200);
    const started = await app.inject({
      method: 'POST',
      url: '/streams/cam_1/start',
      headers: auth(viewer),
    });
    expect(started.statusCode).toBe(403);
  });

  it('operator can control streams', async () => {
    const op = await token(TENANT, ['operator']);
    const res = await app.inject({
      method: 'POST',
      url: '/streams/cam_1/start',
      headers: auth(op),
    });
    expect(res.statusCode).toBe(202);
  });
});

describe('lifecycle via HTTP', () => {
  it('start (202) → status → stop (200) → 404 for unknown', async () => {
    const t = await token(TENANT, ['admin']);
    const started = await app.inject({
      method: 'POST',
      url: '/streams/cam_1/start',
      headers: auth(t),
    });
    expect(started.statusCode).toBe(202);
    expect(started.json().data).toMatchObject({ cameraId: 'cam_1', tenantId: TENANT });

    const status = await app.inject({
      method: 'GET',
      url: '/streams/cam_1/status',
      headers: auth(t),
    });
    expect(status.statusCode).toBe(200);

    const listed = await app.inject({ method: 'GET', url: '/streams', headers: auth(t) });
    expect(listed.json().data.length).toBe(1);

    const stopped = await app.inject({
      method: 'POST',
      url: '/streams/cam_1/stop',
      headers: auth(t),
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().data.state).toBe('stopped');

    const missing = await app.inject({
      method: 'GET',
      url: '/streams/ghost/status',
      headers: auth(t),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('cross-tenant isolation', () => {
  it('tenant B cannot see or address tenant A’s stream', async () => {
    const tA = await token(TENANT, ['admin']);
    const tB = await token(OTHER, ['admin']);
    await app.inject({ method: 'POST', url: '/streams/cam_1/start', headers: auth(tA) });

    expect(
      (await app.inject({ method: 'GET', url: '/streams', headers: auth(tB) })).json().data.length,
    ).toBe(0);
    expect(
      (await app.inject({ method: 'GET', url: '/streams/cam_1/status', headers: auth(tB) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/streams/cam_1/stop', headers: auth(tB) }))
        .statusCode,
    ).toBe(404);
  });
});
