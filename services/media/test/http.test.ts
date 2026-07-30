/**
 * HTTP tests — stream control/status driven in-memory (fakes): authorization (deny-by-default),
 * the 202/200/404 status codes, and cross-tenant isolation. Tokens are minted with @vip/auth
 * (this service verifies, it does not log in) using identity's iss/aud.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordingSegment } from '@vip/contracts';
import { signAccessToken } from '@vip/auth';
import { loadConfig } from '../src/config/env.js';
import { StreamSupervisor } from '../src/application/stream-supervisor.js';
import { MediaCatalogService } from '../src/application/media-catalog-service.js';
import { InMemoryMediaCatalog } from '../src/adapters/in-memory-media-catalog.js';
import { buildServer } from '../src/transport/server.js';
import { FakeCameraSource, FakeDecoder, memoryObjectStore } from './helpers.js';

const SECRET = 'test-secret-at-least-16-chars';
const TENANT = 'tnt_a';
const OTHER = 'tnt_b';

let app: FastifyInstance;
let catalog: MediaCatalogService;

function token(tenantId: string, roles: string[]): Promise<string> {
  return signAccessToken(
    { principalId: 'usr_1', tenantId, email: 'u@acme.com', roles },
    { secret: SECRET, issuer: 'identity', audience: 'vip' },
  ).then((r) => r.token);
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const segment = (tenantId: string, cameraId: string, startedAt: string): RecordingSegment => ({
  tenantId,
  cameraId,
  key: `${cameraId}/recordings/seg-${startedAt}.mp4`,
  startedAt,
  durationSeconds: 6,
  sizeBytes: 1024,
  contentType: 'video/mp4',
});

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'media',
    LOG_LEVEL: 'silent',
    JWT_SECRET: SECRET,
    MONGO_URI: 'mongodb://localhost:47017/vip_media',
    S3_ENDPOINT: 'http://localhost:49000',
    AWS_ACCESS_KEY_ID: 'k',
    AWS_SECRET_ACCESS_KEY: 's',
    INTERNAL_API_KEY: 'internal-key-at-least-16-chars',
    CAMERA_URL: 'http://localhost:8082',
  });
  let n = 0;
  catalog = new MediaCatalogService({
    store: new InMemoryMediaCatalog(),
    objectStore: memoryObjectStore(),
    clock: { now: () => new Date('2026-07-28T00:00:00.000Z') },
    ids: { clipId: () => `clip_${++n}` },
    playbackTtlSeconds: 900,
  });
  const supervisor = new StreamSupervisor({
    cameraSource: new FakeCameraSource(),
    decoder: new FakeDecoder(),
    objectStore: memoryObjectStore(),
    frameSink: { push: () => {} },
    clock: { now: () => new Date('2026-07-28T00:00:00.000Z') },
    options: { frameRate: 2, segmentSeconds: 6 },
  });
  app = (await buildServer({ config, supervisor, catalog, startedAt: new Date() })).app;
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

describe('stream health (G-2)', () => {
  it('summary counts a connected worker as healthy; per-stream health resolves', async () => {
    const t = await token(TENANT, ['admin']);
    await app.inject({ method: 'POST', url: '/streams/cam_1/start', headers: auth(t) });

    const summary = await app.inject({ method: 'GET', url: '/streams/health', headers: auth(t) });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().data).toMatchObject({ tenantId: TENANT, total: 1 });

    const one = await app.inject({
      method: 'GET',
      url: '/streams/cam_1/health',
      headers: auth(t),
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().data).toMatchObject({ cameraId: 'cam_1', tenantId: TENANT });
    expect(['healthy', 'degraded', 'unknown']).toContain(one.json().data.health);

    // Unknown camera → 404.
    expect(
      (await app.inject({ method: 'GET', url: '/streams/ghost/health', headers: auth(t) }))
        .statusCode,
    ).toBe(404);
  });
});

describe('recording catalog (G-2)', () => {
  beforeEach(async () => {
    await catalog.record(segment(TENANT, 'cam_1', '2026-07-28T00:00:00.000Z'));
    await catalog.record(segment(TENANT, 'cam_1', '2026-07-28T00:00:06.000Z'));
    await catalog.record(segment(OTHER, 'cam_9', '2026-07-28T00:00:00.000Z'));
  });

  it('lists a tenant’s recordings (newest-first, tenant-scoped)', async () => {
    const t = await token(TENANT, ['viewer']);
    const res = await app.inject({ method: 'GET', url: '/recordings', headers: auth(t) });
    expect(res.statusCode).toBe(200);
    const { items } = res.json().data;
    expect(items).toHaveLength(2);
    expect(items[0].startedAt > items[1].startedAt).toBe(true);
    expect(items.every((r: { tenantId: string }) => r.tenantId === TENANT)).toBe(true);
  });

  it('filters by camera and returns a signed playback URL', async () => {
    const t = await token(TENANT, ['viewer']);
    const listed = await app.inject({
      method: 'GET',
      url: '/recordings?cameraId=cam_1&limit=1',
      headers: auth(t),
    });
    const first = listed.json().data.items[0];
    expect(listed.json().data.nextCursor).toBeTruthy();

    const play = await app.inject({
      method: 'GET',
      url: `/recordings/${first.id}/playback`,
      headers: auth(t),
    });
    expect(play.statusCode).toBe(200);
    expect(play.json().data).toMatchObject({ expiresInSeconds: 900, contentType: 'video/mp4' });
    expect(play.json().data.url).toContain('https://signed/');
  });

  it('another tenant’s recording is a 404', async () => {
    const tOther = await token(OTHER, ['admin']);
    const mine = await app.inject({ method: 'GET', url: '/recordings', headers: auth(tOther) });
    const otherId = mine.json().data.items[0].id; // cam_9 recording under OTHER
    const tA = await token(TENANT, ['admin']);
    expect(
      (await app.inject({ method: 'GET', url: `/recordings/${otherId}`, headers: auth(tA) }))
        .statusCode,
    ).toBe(404);
  });
});

describe('clip catalog (G-2)', () => {
  const clipBody = {
    cameraId: 'cam_1',
    startedAt: '2026-07-28T00:00:00.000Z',
    endedAt: '2026-07-28T00:00:10.000Z',
    label: 'Person at door',
  };

  beforeEach(async () => {
    // A recording covering the clip window, so clip playback has a covered segment.
    await catalog.record(segment(TENANT, 'cam_1', '2026-07-28T00:00:00.000Z'));
  });

  it('operator can create a clip; viewer cannot (403)', async () => {
    const viewer = await token(TENANT, ['viewer']);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/clips',
          headers: auth(viewer),
          payload: clipBody,
        })
      ).statusCode,
    ).toBe(403);

    const op = await token(TENANT, ['operator']);
    const created = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth(op),
      payload: clipBody,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      cameraId: 'cam_1',
      status: 'pending',
      durationSeconds: 10,
      createdBy: 'usr_1',
    });
    // Snapshotted the covering recording key.
    expect(created.json().data.segmentKeys.length).toBe(1);
  });

  it('rejects an invalid time range (400)', async () => {
    const op = await token(TENANT, ['operator']);
    const res = await app.inject({
      method: 'POST',
      url: '/clips',
      headers: auth(op),
      payload: { ...clipBody, endedAt: '2026-07-27T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists, fetches, plays back, and deletes a clip', async () => {
    const op = await token(TENANT, ['operator']);
    const id = (
      await app.inject({ method: 'POST', url: '/clips', headers: auth(op), payload: clipBody })
    ).json().data.id;

    const listed = await app.inject({ method: 'GET', url: '/clips', headers: auth(op) });
    expect(listed.json().data.items).toHaveLength(1);

    const filtered = await app.inject({
      method: 'GET',
      url: '/clips?cameraId=cam_1&status=pending',
      headers: auth(op),
    });
    expect(filtered.json().data.items).toHaveLength(1);

    const play = await app.inject({
      method: 'GET',
      url: `/clips/${id}/playback`,
      headers: auth(op),
    });
    expect(play.statusCode).toBe(200);
    expect(play.json().data.segments).toHaveLength(1); // covered recording
    expect(play.json().data.segments[0].url).toContain('https://signed/');

    const del = await app.inject({ method: 'DELETE', url: `/clips/${id}`, headers: auth(op) });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/clips/${id}`, headers: auth(op) })).statusCode,
    ).toBe(404);
  });

  it('a tenant cannot address another tenant’s clip', async () => {
    const op = await token(TENANT, ['operator']);
    const id = (
      await app.inject({ method: 'POST', url: '/clips', headers: auth(op), payload: clipBody })
    ).json().data.id;
    const other = await token(OTHER, ['operator']);
    expect(
      (await app.inject({ method: 'GET', url: `/clips/${id}`, headers: auth(other) })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `/clips/${id}`, headers: auth(other) }))
        .statusCode,
    ).toBe(404);
  });
});
