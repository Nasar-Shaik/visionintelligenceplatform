/**
 * Tracking proxy tests (P-8 Phase 4).
 *
 * ⚠️ The assertion that matters most is `test('the tenant comes from the token …')`. Media forwards
 * `x-tenant-id` to a runtime that sits behind a shared internal key and trusts whatever tenant it is
 * handed — so if that header could ever be influenced by the caller, one request would read every
 * customer's movements. The rest of this file is the permission gate and the failure shapes.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '@vip/auth';
import { loadConfig } from '../src/config/env.js';
import { StreamSupervisor } from '../src/application/stream-supervisor.js';
import { MediaCatalogService } from '../src/application/media-catalog-service.js';
import { InMemoryMediaCatalog } from '../src/adapters/in-memory-media-catalog.js';
import { buildServer } from '../src/transport/server.js';
import { FakeCameraSource, FakeDecoder, memoryObjectStore } from './helpers.js';

const SECRET = 'test-secret-at-least-16-chars';

let app: FastifyInstance;
/** Every request the runtime would have received, so the test can inspect what media sent. */
let seen: Array<{ url: string; headers: Record<string, string> }>;
/** What the fake runtime answers with next. */
let answer: { status: number; body: unknown };
/** When set, the runtime hop throws this instead of answering — an unreachable container. */
let failWith: Error | undefined;

function token(tenantId: string, roles: string[]): Promise<string> {
  return signAccessToken(
    { principalId: 'usr_1', tenantId, email: 'u@acme.com', roles },
    { secret: SECRET, issuer: 'identity', audience: 'vip' },
  ).then((r) => r.token);
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  seen = [];
  failWith = undefined;
  answer = { status: 200, body: { success: true, data: { enabled: true, stats: {} } } };
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
    INFERENCE_URL: 'http://inference:8085',
  });
  const catalog = new MediaCatalogService({
    store: new InMemoryMediaCatalog(),
    objectStore: memoryObjectStore(),
    clock: { now: () => new Date('2026-08-05T00:00:00.000Z') },
    ids: { clipId: () => 'clip_1' },
    playbackTtlSeconds: 900,
  });
  const supervisor = new StreamSupervisor({
    cameraSource: new FakeCameraSource(),
    decoder: new FakeDecoder(),
    objectStore: memoryObjectStore(),
    frameSink: { push: () => {} },
    clock: { now: () => new Date('2026-08-05T00:00:00.000Z') },
    options: { frameRate: 2, segmentSeconds: 6 },
  });

  const fakeFetch: typeof fetch = async (input, init) => {
    seen.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (failWith !== undefined) throw failWith;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  app = (
    await buildServer({
      config,
      supervisor,
      catalog,
      startedAt: new Date(),
      trackingFetch: fakeFetch,
    })
  ).app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('tracking authorization', () => {
  it('refuses an anonymous request', async () => {
    const res = await app.inject({ method: 'GET', url: '/perception/tracking' });
    expect(res.statusCode).toBe(401);
  });

  it('allows an operator, an admin and a viewer — all hold track:read', async () => {
    for (const role of ['operator', 'admin', 'viewer']) {
      const res = await app.inject({
        method: 'GET',
        url: '/perception/tracking',
        headers: auth(await token('tnt_a', [role])),
      });
      expect(res.statusCode, `${role} was refused`).toBe(200);
    }
  });

  it('the per-camera route needs track:read too, not a weaker permission', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/perception/tracking/cameras' });
    expect(anonymous.statusCode).toBe(401);
    const operator = await app.inject({
      method: 'GET',
      url: '/perception/tracking/cameras',
      headers: auth(await token('tnt_a', ['operator'])),
    });
    expect(operator.statusCode).toBe(200);
  });
});

describe('tenant scoping', () => {
  it('⚠️ the tenant comes from the token, and a caller cannot name their own', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/perception/tracking/tracks',
      headers: {
        ...auth(await token('tnt_real', ['operator'])),
        // Everything an attacker could try. None of it may reach the runtime.
        'x-tenant-id': 'tnt_victim',
        'x-tenant': 'tnt_victim',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers['x-tenant-id']).toBe('tnt_real');
  });

  it('forwards the internal key to the runtime and nothing from the caller', async () => {
    await app.inject({
      method: 'GET',
      url: '/perception/tracking',
      headers: auth(await token('tnt_a', ['operator'])),
    });
    expect(seen[0]?.headers['x-internal-key']).toBe('internal-key-at-least-16-chars');
    expect(seen[0]?.headers['authorization']).toBeUndefined();
  });

  it('passes the camera and state filters through', async () => {
    await app.inject({
      method: 'GET',
      url: '/perception/tracking/tracks?cameraId=cam_1&state=confirmed',
      headers: auth(await token('tnt_a', ['operator'])),
    });
    expect(seen[0]?.url).toContain('cameraId=cam_1');
    expect(seen[0]?.url).toContain('state=confirmed');
  });

  it('⚠️ a per-camera read is scoped by the token too — camera ids are tenant data', async () => {
    await app.inject({
      method: 'GET',
      url: '/perception/tracking/cameras',
      headers: {
        ...auth(await token('tnt_real', ['operator'])),
        'x-tenant-id': 'tnt_victim',
      },
    });
    expect(seen[0]?.url).toContain('/tracking/cameras');
    expect(seen[0]?.headers['x-tenant-id']).toBe('tnt_real');
  });

  it('url-encodes a track id rather than pasting it into a path', async () => {
    await app.inject({
      method: 'GET',
      url: '/perception/tracking/tracks/trk%2Fa%20b',
      headers: auth(await token('tnt_a', ['operator'])),
    });
    expect(seen[0]?.url).toContain('/tracking/tracks/trk%2Fa%20b');
  });

  /**
   * ⛔ **The kind filter has to reach the runtime, because that is the only place it helps.**
   *
   * The runtime applies it *before* its 2000-entry cap. A console that filtered what arrived would
   * look identical and recover nothing — measured on a live camera where 1207 of the permitted
   * entries were `gap`, having displaced every merge and crossing later in the run.
   */
  it('carries the behaviour kind filter through to the runtime', async () => {
    await app.inject({
      method: 'GET',
      url: '/perception/behaviour/timeline?streamId=ases_1&kinds=idle,linger',
      headers: auth(await token('tnt_a', ['operator'])),
    });
    expect(seen[0]?.url).toContain('/tracking/behaviour/timeline');
    expect(seen[0]?.url).toContain('streamId=ases_1');
    expect(seen[0]?.url).toContain('kinds=idle%2Clinger');
  });

  it('⚠️ the behaviour views are scoped by the token like every other tracking read', async () => {
    for (const view of ['primitives', 'timeline', 'graph']) {
      seen = [];
      const res = await app.inject({
        method: 'GET',
        url: `/perception/behaviour/${view}?streamId=ases_1`,
        headers: {
          ...auth(await token('tnt_real', ['operator'])),
          'x-tenant-id': 'tnt_victim',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(seen[0]?.headers['x-tenant-id']).toBe('tnt_real');
    }
  });
});

describe('failure shapes', () => {
  it('⚠️ an unreachable runtime is an ANSWER, not a 500 — the page exists to show it', async () => {
    const err = new Error('fetch failed');
    (err as Error & { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
    failWith = err;
    const res = await app.inject({
      method: 'GET',
      url: '/perception/tracking',
      headers: auth(await token('tnt_a', ['operator'])),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.unreachable).toBe(true);
    /* ⚠️ "fetch failed" is not a reason. ECONNREFUSED vs ENOTFOUND is "the container is not
     * running" vs "the name does not resolve", and only one of those is a DNS problem. */
    expect(res.json().data.detail).toContain('ECONNREFUSED');
  });

  it('names a timeout as a timeout', async () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    failWith = err;
    const res = await app.inject({
      method: 'GET',
      url: '/perception/tracking',
      headers: auth(await token('tnt_a', ['operator'])),
    });
    expect(res.json().data.detail).toContain('did not answer within');
  });

  it('a track that ended between two requests is a 404, not an error banner', async () => {
    answer = { status: 404, body: { success: false, error: { message: 'no live track' } } };
    const res = await app.inject({
      method: 'GET',
      url: '/perception/tracking/tracks/trk_gone',
      headers: auth(await token('tnt_a', ['operator'])),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain('no longer live');
  });

  it('reports "not configured" when this deployment has no runtime', async () => {
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
    const bare = (
      await buildServer({
        config,
        supervisor: new StreamSupervisor({
          cameraSource: new FakeCameraSource(),
          decoder: new FakeDecoder(),
          objectStore: memoryObjectStore(),
          frameSink: { push: () => {} },
          clock: { now: () => new Date() },
          options: { frameRate: 2, segmentSeconds: 6 },
        }),
        catalog: new MediaCatalogService({
          store: new InMemoryMediaCatalog(),
          objectStore: memoryObjectStore(),
          clock: { now: () => new Date() },
          ids: { clipId: () => 'clip_1' },
          playbackTtlSeconds: 900,
        }),
        startedAt: new Date(),
      })
    ).app;
    await bare.ready();
    const res = await bare.inject({
      method: 'GET',
      url: '/perception/tracking',
      headers: auth(await token('tnt_a', ['operator'])),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.enabled).toBe(false);
    expect(res.json().data.detail).toContain('INFERENCE_URL');
    await bare.close();
  });
});
