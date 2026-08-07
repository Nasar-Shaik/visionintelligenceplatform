/**
 * Offline video investigation over HTTP (P-8 Phase 8) — authorization, the envelope, the status
 * codes, and cross-tenant isolation. Driven in-memory with `app.inject()`; no Mongo, no MinIO, no
 * ffprobe.
 *
 * ⚠️ **The routes are optional in `buildServer`**, so this file also pins the thing that would
 * otherwise be discovered in a deployment: a media service built without the analysis service must
 * answer **404**, not 500. A route that exists and always fails is indistinguishable from a bug.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '@vip/auth';
import { loadConfig } from '../src/config/env.js';
import { StreamSupervisor } from '../src/application/stream-supervisor.js';
import { MediaCatalogService } from '../src/application/media-catalog-service.js';
import { InMemoryMediaCatalog } from '../src/adapters/in-memory-media-catalog.js';
import { InMemoryAnalysisStore } from '../src/adapters/in-memory-analysis-store.js';
import { AnalysisService } from '../src/application/analysis-service.js';
import { buildServer } from '../src/transport/server.js';
import type { MediaProbe, ProbeResult } from '../src/adapters/ffprobe.js';
import { FakeCameraSource, FakeDecoder, memoryObjectStore } from './helpers.js';

const SECRET = 'test-secret-at-least-16-chars';
const TENANT = 'tnt_a';
const OTHER = 'tnt_b';

let app: FastifyInstance;
let objectStore: ReturnType<typeof memoryObjectStore>;

function token(tenantId: string, roles: string[]): Promise<string> {
  return signAccessToken(
    { principalId: 'usr_1', tenantId, email: 'u@acme.com', roles },
    { secret: SECRET, issuer: 'identity', audience: 'vip' },
  ).then((r) => r.token);
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const probe: MediaProbe = {
  async probe(): Promise<ProbeResult> {
    return {
      codec: 'h264',
      codecTag: 'avc1',
      width: 1280,
      height: 720,
      frameRate: 25,
      durationSeconds: 42,
    };
  },
};

async function build(withAnalyses: boolean): Promise<FastifyInstance> {
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
  objectStore = memoryObjectStore();
  let n = 0;
  const catalog = new MediaCatalogService({
    store: new InMemoryMediaCatalog(),
    objectStore: memoryObjectStore(),
    clock: { now: () => new Date('2026-08-07T00:00:00.000Z') },
    ids: { clipId: () => `clip_${++n}` },
    playbackTtlSeconds: 900,
  });
  const supervisor = new StreamSupervisor({
    cameraSource: new FakeCameraSource(),
    decoder: new FakeDecoder(),
    objectStore: memoryObjectStore(),
    frameSink: { push: () => {} },
    clock: { now: () => new Date('2026-08-07T00:00:00.000Z') },
    options: { frameRate: 2, segmentSeconds: 6 },
  });
  let a = 0;
  let s = 0;
  const analyses = new AnalysisService({
    store: new InMemoryAnalysisStore(),
    objectStore,
    probe,
    cameras: {
      async exists() {
        return true;
      },
    },
    clock: { now: () => new Date('2026-08-07T00:00:00.000Z') },
    ids: { analysisId: () => `ana_${++a}`, sessionId: () => `ases_${++s}` },
    capabilityId: 'perception.person-detection',
    defaultFrameRate: 2,
    playbackTtlSeconds: 900,
  });
  const built = await buildServer({
    config,
    supervisor,
    catalog,
    startedAt: new Date(),
    ...(withAnalyses ? { analyses } : {}),
  });
  await built.app.ready();
  return built.app;
}

const create = {
  cameraId: 'cam_1',
  originalName: 'yesterday.mp4',
  contentType: 'video/mp4',
  bytes: 1024,
};

beforeEach(async () => {
  app = await build(true);
});
afterEach(async () => {
  await app.close();
});

describe('authorization (deny-by-default)', () => {
  it('401 without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/analyses' })).statusCode).toBe(401);
  });

  it('a viewer may list analyses but may not create one', async () => {
    const t = await token(TENANT, ['viewer']);
    expect(
      (await app.inject({ method: 'GET', url: '/analyses', headers: auth(t) })).statusCode,
    ).toBe(200);
    const denied = await app.inject({
      method: 'POST',
      url: '/analyses',
      headers: auth(t),
      payload: create,
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('the upload lifecycle over HTTP', () => {
  it('201s with an upload URL, then confirms, then queues a session', async () => {
    const t = await token(TENANT, ['admin']);

    const created = await app.inject({
      method: 'POST',
      url: '/analyses',
      headers: auth(t),
      payload: create,
    });
    expect(created.statusCode).toBe(201);
    const upload = created.json<{
      data: { analysis: { id: string }; uploadUrl: string; method: string };
    }>().data;
    expect(upload.method).toBe('PUT');
    expect(upload.uploadUrl).toContain('analyses/ana_1/source.mp4');

    /* The browser's PUT, simulated: the bytes appear under the tenant prefix. */
    await objectStore.put({
      key: `${TENANT}/analyses/ana_1/source.mp4`,
      body: new Uint8Array(1024),
    });

    const confirmed = await app.inject({
      method: 'POST',
      url: `/analyses/${upload.analysis.id}/confirm`,
      headers: auth(t),
      payload: { footageStartedAt: '2026-08-01T09:00:00.000Z' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<{ data: { state: string } }>().data.state).toBe('ready');

    const session = await app.inject({
      method: 'POST',
      url: `/analyses/${upload.analysis.id}/sessions`,
      headers: auth(t),
      payload: {},
    });
    expect(session.statusCode).toBe(201);
    expect(session.json<{ data: { state: string; sequence: number } }>().data).toMatchObject({
      state: 'queued',
      sequence: 1,
    });
  });

  it('400s a content type it cannot decode, with a reason a person can act on', async () => {
    const t = await token(TENANT, ['admin']);
    const res = await app.inject({
      method: 'POST',
      url: '/analyses',
      headers: auth(t),
      payload: { ...create, contentType: 'application/zip' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(
      /unsupported content type/,
    );
  });

  it('409s a confirm before the bytes have arrived', async () => {
    const t = await token(TENANT, ['admin']);
    const created = await app.inject({
      method: 'POST',
      url: '/analyses',
      headers: auth(t),
      payload: create,
    });
    const id = created.json<{ data: { analysis: { id: string } } }>().data.analysis.id;
    const res = await app.inject({
      method: 'POST',
      url: `/analyses/${id}/confirm`,
      headers: auth(t),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('cross-tenant isolation', () => {
  /* ⚠️ 404, never 403 — a 403 confirms the analysis exists, which is the leak. */
  it('another tenant gets 404, not 403', async () => {
    const mine = await token(TENANT, ['admin']);
    const theirs = await token(OTHER, ['admin']);
    const created = await app.inject({
      method: 'POST',
      url: '/analyses',
      headers: auth(mine),
      payload: create,
    });
    const id = created.json<{ data: { analysis: { id: string } } }>().data.analysis.id;

    const res = await app.inject({ method: 'GET', url: `/analyses/${id}`, headers: auth(theirs) });
    expect(res.statusCode).toBe(404);
  });
});

describe('a deployment without offline analysis', () => {
  /*
   * ⚠️ The capability is optional, exactly like perception and the event bridge before it. A media
   * service built without it must be silent about these routes rather than answering errors —
   * "absent" and "broken" must not look the same to an operator.
   */
  it('does not expose the routes at all', async () => {
    const bare = await build(false);
    const t = await token(TENANT, ['admin']);
    expect(
      (await bare.inject({ method: 'GET', url: '/analyses', headers: auth(t) })).statusCode,
    ).toBe(404);
    await bare.close();
  });
});
