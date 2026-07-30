/**
 * HTTP tests — the camera-inventory vertical driven in-memory (fake collection): authorization
 * (deny-by-default), CRUD, health, the discovery stub, cross-tenant isolation, and the invariant
 * that credentials are NEVER returned. Runs everywhere with no Docker/Mongo; the real-driver proof
 * (unique index, decryptable vault) lives in integration.test.ts. Tokens are minted directly with
 * @vip/auth (this service verifies, it does not log in) using identity's iss/aud.
 */
import type { FastifyInstance } from 'fastify';
import type { Collection } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantRepository } from '@vip/tenancy';
import { SecretBox } from '@vip/crypto';
import { signAccessToken } from '@vip/auth';
import { loadConfig } from '../src/config/env.js';
import { CameraService } from '../src/application/camera-service.js';
import type { CameraDoc } from '../src/domain/camera.js';
import { buildServer } from '../src/transport/server.js';

const SECRET = 'test-secret-at-least-16-chars';
const INTERNAL_KEY = 'internal-key-at-least-16-chars';

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => doc[k] === v);
}

function memoryCollection<T extends Record<string, unknown>>(): Collection<T> {
  const store: T[] = [];
  return {
    async insertOne(doc: T) {
      store.push(doc);
      return { insertedId: doc._id, acknowledged: true };
    },
    async findOne(filter: Record<string, unknown>) {
      return store.find((d) => matches(d, filter)) ?? null;
    },
    find(filter: Record<string, unknown>) {
      return { toArray: async () => store.filter((d) => matches(d, filter)) };
    },
    async updateOne(filter: Record<string, unknown>, update: { $set?: Partial<T> }) {
      const doc = store.find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
      Object.assign(doc, update.$set ?? {});
      return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
    },
    async deleteOne(filter: Record<string, unknown>) {
      const i = store.findIndex((d) => matches(d, filter));
      if (i === -1) return { deletedCount: 0, acknowledged: true };
      store.splice(i, 1);
      return { deletedCount: 1, acknowledged: true };
    },
  } as unknown as Collection<T>;
}

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

const validCamera = {
  zoneId: 'on_zone1',
  name: 'Lobby',
  protocol: 'rtsp',
  streamUrl: 'rtsp://cam.local:554/stream',
  credentials: { username: 'admin', password: 's3cr3t' },
};

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'camera',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://localhost:47017/vip_camera',
    JWT_SECRET: SECRET,
    CREDENTIAL_ENCRYPTION_KEY: SECRET,
    INTERNAL_API_KEY: INTERNAL_KEY,
  });
  let n = 0;
  const service = new CameraService({
    cameras: new TenantRepository<CameraDoc>(memoryCollection<CameraDoc>()),
    vault: SecretBox.fromSecret(SECRET),
    clock: { now: () => new Date('2026-07-28T00:00:00.000Z') },
    ids: { cameraId: () => `cam_${++n}` },
  });
  app = (await buildServer({ config, service, startedAt: new Date() })).app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const create = async (t: string, body: unknown = validCamera) =>
  app.inject({ method: 'POST', url: '/cameras', headers: auth(t), payload: body });

describe('infra', () => {
  it('GET /health → 200', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });
});

describe('authorization (deny-by-default)', () => {
  it('401 without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/cameras' })).statusCode).toBe(401);
  });

  it('401 with a token signed by the wrong secret', async () => {
    const bad = await signAccessToken(
      { principalId: 'p', tenantId: TENANT, email: 'e', roles: ['admin'] },
      { secret: 'a-different-secret-16chars', issuer: 'identity', audience: 'vip' },
    );
    expect((await create(bad.token)).statusCode).toBe(401);
  });

  it('viewer can read but cannot create (403)', async () => {
    const viewer = await token(TENANT, ['viewer']);
    expect(
      (await app.inject({ method: 'GET', url: '/cameras', headers: auth(viewer) })).statusCode,
    ).toBe(200);
    expect((await create(viewer)).statusCode).toBe(403);
  });

  it('admin can create (201)', async () => {
    expect((await create(await token(TENANT, ['admin']))).statusCode).toBe(201);
  });
});

describe('CRUD + credential safety', () => {
  it('creates a camera and never returns credentials', async () => {
    const res = await create(await token(TENANT, ['admin']));
    expect(res.statusCode).toBe(201);
    const cam = res.json().data;
    expect(cam.id).toBeTruthy();
    expect(cam.tenantId).toBe(TENANT);
    expect(cam.status).toBe('enabled');
    expect(cam.health.status).toBe('unknown');
    expect(cam.hasCredentials).toBe(true);
    // The whole serialized body must not leak the secret.
    expect(JSON.stringify(res.json())).not.toContain('s3cr3t');
    expect('credentials' in cam).toBe(false);
  });

  it('rejects a stream URL with embedded credentials (400)', async () => {
    const res = await create(await token(TENANT, ['admin']), {
      ...validCamera,
      streamUrl: 'rtsp://admin:pw@cam.local:554/stream',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a protocol/scheme mismatch (400)', async () => {
    const res = await create(await token(TENANT, ['admin']), { ...validCamera, protocol: 'rtmp' });
    expect(res.statusCode).toBe(400);
  });

  it('lists, gets, updates, and deletes', async () => {
    const t = await token(TENANT, ['admin']);
    const id = (await create(t)).json().data.id;

    const listed = await app.inject({ method: 'GET', url: '/cameras', headers: auth(t) });
    expect(listed.json().data.length).toBe(1);

    const got = await app.inject({ method: 'GET', url: `/cameras/${id}`, headers: auth(t) });
    expect(got.json().data.name).toBe('Lobby');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/cameras/${id}`,
      headers: auth(t),
      payload: { name: 'Front Door', status: 'disabled' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.name).toBe('Front Door');
    expect(patched.json().data.status).toBe('disabled');

    const health = await app.inject({
      method: 'GET',
      url: `/cameras/${id}/health`,
      headers: auth(t),
    });
    expect(health.json().data).toMatchObject({ cameraId: id, status: 'unknown' });

    const del = await app.inject({ method: 'DELETE', url: `/cameras/${id}`, headers: auth(t) });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: `/cameras/${id}`, headers: auth(t) });
    expect(after.statusCode).toBe(404);
  });

  it('rejects an update whose new streamUrl scheme mismatches the stored protocol (400)', async () => {
    const t = await token(TENANT, ['admin']);
    const id = (await create(t)).json().data.id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/cameras/${id}`,
      headers: auth(t),
      payload: { streamUrl: 'rtmp://cam.local/live' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('cross-tenant isolation (fail-closed)', () => {
  it('a principal of tenant B cannot see/mutate tenant A’s camera (404)', async () => {
    const tA = await token(TENANT, ['admin']);
    const tB = await token(OTHER, ['admin']);
    const id = (await create(tA)).json().data.id;

    // B lists → empty; gets/patches/deletes A's camera → 404 (no existence leak).
    expect(
      (await app.inject({ method: 'GET', url: '/cameras', headers: auth(tB) })).json().data.length,
    ).toBe(0);
    expect(
      (await app.inject({ method: 'GET', url: `/cameras/${id}`, headers: auth(tB) })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/cameras/${id}`,
          headers: auth(tB),
          payload: { name: 'hijack' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `/cameras/${id}`, headers: auth(tB) })).statusCode,
    ).toBe(404);

    // A still owns an untouched camera.
    expect(
      (await app.inject({ method: 'GET', url: `/cameras/${id}`, headers: auth(tA) })).json().data
        .name,
    ).toBe('Lobby');
  });
});

describe('internal stream-resolve endpoint (service-to-service)', () => {
  const resolve = (id: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: `/internal/cameras/${id}/stream`, headers });

  it('returns the connection descriptor WITH decrypted credentials for a valid internal key', async () => {
    const id = (await create(await token(TENANT, ['admin']))).json().data.id;
    const res = await resolve(id, { 'x-internal-key': INTERNAL_KEY, 'x-tenant-id': TENANT });
    expect(res.statusCode).toBe(200);
    const conn = res.json().data;
    expect(conn).toMatchObject({
      cameraId: id,
      protocol: 'rtsp',
      streamUrl: 'rtsp://cam.local:554/stream',
      username: 'admin',
      password: 's3cr3t',
    });
  });

  it('rejects a missing/wrong internal key with 401', async () => {
    const id = (await create(await token(TENANT, ['admin']))).json().data.id;
    expect((await resolve(id, { 'x-tenant-id': TENANT })).statusCode).toBe(401);
    expect(
      (await resolve(id, { 'x-internal-key': 'wrong-key-16-characters', 'x-tenant-id': TENANT }))
        .statusCode,
    ).toBe(401);
  });

  it('requires the x-tenant-id header (400) and isolates across tenants (404)', async () => {
    const id = (await create(await token(TENANT, ['admin']))).json().data.id;
    expect((await resolve(id, { 'x-internal-key': INTERNAL_KEY })).statusCode).toBe(400);
    // A different tenant cannot resolve tenant A's camera.
    expect(
      (await resolve(id, { 'x-internal-key': INTERNAL_KEY, 'x-tenant-id': OTHER })).statusCode,
    ).toBe(404);
  });

  it('never leaks a JWT user into the credential path — a user Bearer token cannot resolve', async () => {
    const id = (await create(await token(TENANT, ['admin']))).json().data.id;
    // No internal key, only a user token → 401 (this endpoint is internal-key gated).
    const res = await resolve(id, { authorization: `Bearer ${await token(TENANT, ['admin'])}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('discovery stub', () => {
  it('POST /cameras/discover → 501 (contract exists, not yet implemented)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cameras/discover',
      headers: auth(await token(TENANT, ['admin'])),
      payload: {},
    });
    expect(res.statusCode).toBe(501);
  });
});

describe('G-1 enhancements: metadata + capabilities', () => {
  it('round-trips metadata and derives capabilities on create', async () => {
    const t = await token(TENANT, ['admin']);
    const res = await create(t, {
      ...validCamera,
      capture: { codec: 'h264', resolution: '1920x1080', ptz: true },
      metadata: { manufacturer: 'Axis', tags: ['lobby', 'exterior'] },
    });
    expect(res.statusCode).toBe(201);
    const cam = res.json().data;
    expect(cam.metadata).toEqual({ manufacturer: 'Axis', tags: ['lobby', 'exterior'] });
    expect(cam.capabilities).toMatchObject({
      ptz: true,
      codecs: ['h264'],
      resolutions: ['1920x1080'],
      protocols: ['rtsp'],
    });
  });

  it('updates metadata via PATCH and exposes GET /cameras/:id/capabilities', async () => {
    const t = await token(TENANT, ['admin']);
    const id = (await create(t)).json().data.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/cameras/${id}`,
      headers: auth(t),
      payload: { metadata: { location: 'North wing', tags: ['x'] } },
    });
    expect(patched.json().data.metadata).toEqual({ location: 'North wing', tags: ['x'] });

    const caps = await app.inject({
      method: 'GET',
      url: `/cameras/${id}/capabilities`,
      headers: auth(t),
    });
    expect(caps.statusCode).toBe(200);
    expect(caps.json().data.protocols).toEqual(['rtsp']);
  });
});

describe('G-1 enhancements: validation (test-connection)', () => {
  it('validates a candidate config without persisting (valid)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cameras/validate',
      headers: auth(await token(TENANT, ['viewer'])), // read-only diagnostic
      payload: { protocol: 'rtsp', streamUrl: 'rtsp://cam.local:554/s' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.valid).toBe(true);
    // Nothing persisted.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/cameras',
          headers: auth(await token(TENANT, ['admin'])),
        })
      ).json().data.length,
    ).toBe(0);
  });

  it('reports structured failures for a bad config (protocol mismatch)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cameras/validate',
      headers: auth(await token(TENANT, ['admin'])),
      payload: { protocol: 'rtsp', streamUrl: 'rtmp://cam.local/live' },
    });
    expect(res.json().data.valid).toBe(false);
    const failed = res
      .json()
      .data.checks.filter((c: { passed: boolean; informational: boolean }) => !c.passed);
    expect(failed.map((c: { name: string }) => c.name)).toContain('protocol-matches-url');
  });

  it('validates an existing camera via POST /cameras/:id/validate', async () => {
    const t = await token(TENANT, ['admin']);
    const id = (await create(t)).json().data.id;
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${id}/validate`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.valid).toBe(true);
  });
});

describe('G-1 enhancements: status + active health-check', () => {
  it('enable/disable convenience endpoints flip status (camera:update gated)', async () => {
    const t = await token(TENANT, ['admin']);
    const id = (await create(t)).json().data.id;

    const disabled = await app.inject({
      method: 'POST',
      url: `/cameras/${id}/disable`,
      headers: auth(t),
    });
    expect(disabled.json().data.status).toBe('disabled');

    const enabled = await app.inject({
      method: 'POST',
      url: `/cameras/${id}/enable`,
      headers: auth(t),
    });
    expect(enabled.json().data.status).toBe('enabled');

    // A viewer cannot flip status.
    const viewer = await token(TENANT, ['viewer']);
    expect(
      (await app.inject({ method: 'POST', url: `/cameras/${id}/disable`, headers: auth(viewer) }))
        .statusCode,
    ).toBe(403);
  });

  it('active health-check records a snapshot with lastCheckedAt', async () => {
    const t = await token(TENANT, ['admin']);
    const id = (await create(t)).json().data.id;
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${id}/health/check`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ cameraId: id });
    expect(res.json().data.lastCheckedAt).toBeTruthy();
    // Config is valid → status stays observed 'unknown' (live connectivity proven by ingestion/G-2).
    expect(res.json().data.status).toBe('unknown');
  });
});
