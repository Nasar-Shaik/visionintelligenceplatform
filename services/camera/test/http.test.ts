/**
 * HTTP tests — the camera-inventory vertical driven in-memory (fake collection): authorization
 * (deny-by-default), CRUD, health, ONVIF discovery + bulk onboarding (P-1), cross-tenant isolation,
 * and the invariant
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
import type { DiscoveryProbe, DiscoveryProvider } from '../src/application/discovery.js';
import type { StreamProbe, StreamProbeOutcome } from '../src/application/stream-probe.js';
import type { CameraDoc } from '../src/domain/camera.js';
import type { ProbeRecordDoc } from '../src/domain/probe-archive.js';
import { buildServer } from '../src/transport/server.js';

const SECRET = 'test-secret-at-least-16-chars';
const INTERNAL_KEY = 'internal-key-at-least-16-chars';

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    // The one operator the service uses — the fleet query's window bound on `at`.
    if (v && typeof v === 'object' && '$gte' in (v as Record<string, unknown>)) {
      return String(doc[k]) >= String((v as { $gte: unknown }).$gte);
    }
    return doc[k] === v;
  });
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
    /**
     * A cursor that honours `sort`/`skip`/`limit`.
     *
     * P-2.2 loaded collections and sliced them in memory; P-2.3 pushes the ordering and the bound
     * into the query, and this fake has to model that or the tests would pass against behaviour the
     * production driver does not have. Supports the `$gte` the fleet query uses on `at`.
     */
    find(filter: Record<string, unknown>) {
      let rows = store.filter((d) => matches(d, filter));
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          const [[key, direction] = ['', 1]] = Object.entries(spec);
          rows = [...rows].sort((a, b) => {
            const left = a[key as keyof typeof a] as string | number;
            const right = b[key as keyof typeof b] as string | number;
            if (left === right) return 0;
            return (left < right ? -1 : 1) * (direction as number);
          });
          return cursor;
        },
        skip(n: number) {
          rows = rows.slice(n);
          return cursor;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return cursor;
        },
        toArray: async () => rows,
      };
      return cursor;
    },
    async countDocuments(filter: Record<string, unknown>) {
      return store.filter((d) => matches(d, filter)).length;
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

/** A discovery provider the test controls — no socket, no AI runtime, no network. */
class StubDiscovery implements DiscoveryProvider {
  constructor(public probeResult: DiscoveryProbe) {}
  async probe(): Promise<DiscoveryProbe> {
    return this.probeResult;
  }
}

const DISCOVERED = {
  endpoint: 'http://10.0.0.64/onvif/device_service',
  address: '10.0.0.64',
  metadata: { manufacturer: 'Hikvision', model: 'DS-2CD2143G2', firmware: 'V5.7.3', tags: [] },
  capabilities: {
    ptz: true,
    audio: true,
    snapshot: true,
    codecs: ['h264' as const],
    resolutions: ['2560x1440', '640x360'],
    protocols: ['rtsp' as const],
    streamProfiles: [
      { name: 'main', resolution: '2560x1440', preferredForAnalysis: false },
      { name: 'sub', resolution: '640x360', preferredForAnalysis: true },
    ],
    onvif: true,
    metadataStream: true,
    fpsRange: { min: 10, max: 25 },
  },
  suggestedStreamUrl: 'rtsp://10.0.0.64:554/Streaming/Channels/102',
  registryId: 'hikvision-ds-2cd2143g2',
};

/** A stream probe the test controls — no runtime, no camera, no network. */
class StubProbe implements StreamProbe {
  /** Counted so a test can prove replay contacts nothing (P-2.2 rec 6). */
  calls = 0;
  constructor(public outcome: StreamProbeOutcome) {}
  async probe(): Promise<StreamProbeOutcome> {
    this.calls += 1;
    return this.outcome;
  }
}

/** A probe result that measured a real device and found it working. */
const HARDWARE_OK: StreamProbeOutcome = {
  result: {
    probedAt: '2026-07-28T00:00:00.000Z',
    evidenceClass: 'hardware',
    probeVersion: '3',
    runtimeVersion: '0.1.0',
    provider: 'rtsp',
    reachable: true,
    framesRead: 3,
    firstFrameMs: 412,
    totalMs: 640,
    fps: 10,
    resolution: '640x360',
    authentication: 'ok',
    checks: [
      { name: 'dns', status: 'pass', measured: '10.0.0.64', durationMs: 12 },
      { name: 'tcp', status: 'pass', measured: '10.0.0.64:554', durationMs: 4 },
      { name: 'authentication', status: 'pass', durationMs: 90 },
      { name: 'stream-open', status: 'pass', durationMs: 90 },
      { name: 'first-frame', status: 'pass', measured: '412 ms', durationMs: 412 },
      { name: 'frames-received', status: 'pass', measured: '3 frames', durationMs: 420 },
    ],
    profiles: [],
    warnings: [],
  },
};

/** A probe that reached the device and could not get a frame out of it — a device-side failure. */
const HARDWARE_NO_FRAME: StreamProbeOutcome = {
  result: {
    probedAt: '2026-07-28T00:00:00.000Z',
    evidenceClass: 'hardware',
    probeVersion: '3',
    runtimeVersion: '0.1.0',
    provider: 'rtsp',
    reachable: true,
    framesRead: 0,
    totalMs: 8100,
    authentication: 'ok',
    failureCode: 'no-first-frame',
    checks: [
      { name: 'dns', status: 'pass', durationMs: 11 },
      { name: 'tcp', status: 'pass', durationMs: 5 },
      { name: 'authentication', status: 'pass', durationMs: 80 },
      { name: 'stream-open', status: 'pass', durationMs: 80 },
      { name: 'first-frame', status: 'fail', measured: '0 frames' },
    ],
    profiles: [],
    warnings: [],
    error: 'the stream opened but produced no frames within 8s',
  },
};

let discovery: StubDiscovery;
let probe: StubProbe;

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
  discovery = new StubDiscovery({ devices: [DISCOVERED], probedSeconds: 3 });
  probe = new StubProbe(HARDWARE_OK);
  const service = new CameraService({
    cameras: new TenantRepository<CameraDoc>(memoryCollection<CameraDoc>()),
    probes: new TenantRepository<ProbeRecordDoc>(memoryCollection<ProbeRecordDoc>()),
    vault: SecretBox.fromSecret(SECRET),
    clock: { now: () => new Date('2026-07-28T00:00:00.000Z') },
    ids: { cameraId: () => `cam_${++n}`, probeId: () => `prb_${++n}` },
    discovery,
    probe,
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

describe('ONVIF discovery (P-1)', () => {
  const scan = async (t: string, payload: unknown = {}) =>
    app.inject({ method: 'POST', url: '/cameras/discover', headers: auth(t), payload });

  it('returns the discovered device with its negotiated capabilities', async () => {
    const res = await scan(await token(TENANT, ['admin']));
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.devices).toHaveLength(1);
    expect(data.devices[0].metadata.manufacturer).toBe('Hikvision');
    expect(data.devices[0].capabilities.fpsRange).toEqual({ min: 10, max: 25 });
    expect(data.devices[0].alreadyOnboarded).toBe(false);
  });

  it('requires camera:create — a probe is an active operation against the customer estate', async () => {
    expect((await scan(await token(TENANT, ['viewer']))).statusCode).toBe(403);
  });

  it('marks an already-onboarded device instead of hiding it', async () => {
    // An installer re-scanning a half-configured site must be able to tell "already watched" from
    // "did not answer". Hiding the onboarded ones makes those two look identical.
    const admin = await token(TENANT, ['admin']);
    const created = await create(admin, {
      ...validCamera,
      streamUrl: DISCOVERED.suggestedStreamUrl,
    });
    expect(created.statusCode).toBe(201);
    const data = (await scan(admin)).json().data;
    expect(data.devices[0].alreadyOnboarded).toBe(true);
    expect(data.devices[0].cameraId).toBe(created.json().data.id);
  });

  it('matches an existing camera whose URL differs only in scheme/host case', async () => {
    const admin = await token(TENANT, ['admin']);
    await create(admin, {
      ...validCamera,
      streamUrl: 'rtsp://10.0.0.64:554/Streaming/Channels/102',
    });
    discovery.probeResult = {
      devices: [
        { ...DISCOVERED, suggestedStreamUrl: 'rtsp://10.0.0.64:554/Streaming/Channels/102/' },
      ],
      probedSeconds: 1,
    };
    const data = (await scan(admin)).json().data;
    expect(data.devices[0].alreadyOnboarded).toBe(true);
  });

  it('does not treat a different channel on the same DVR as already onboarded', async () => {
    // Paths are case- and value-sensitive: channel 102 and 202 are different cameras.
    const admin = await token(TENANT, ['admin']);
    await create(admin, {
      ...validCamera,
      streamUrl: 'rtsp://10.0.0.64:554/Streaming/Channels/202',
    });
    const data = (await scan(admin)).json().data;
    expect(data.devices[0].alreadyOnboarded).toBe(false);
  });

  it('reports an unavailable provider distinctly from an empty network', async () => {
    discovery.probeResult = {
      devices: [],
      probedSeconds: 0,
      unavailable: 'network discovery is not configured for this deployment',
    };
    const data = (await scan(await token(TENANT, ['admin']))).json().data;
    expect(data.devices).toEqual([]);
    expect(data.unavailable).toContain('not configured');
  });

  it('an empty network is not an error and carries no unavailable reason', async () => {
    discovery.probeResult = { devices: [], probedSeconds: 3 };
    const data = (await scan(await token(TENANT, ['admin']))).json().data;
    expect(data.devices).toEqual([]);
    expect(data.unavailable).toBeUndefined();
  });

  it('discovery never persists anything', async () => {
    const admin = await token(TENANT, ['admin']);
    await scan(admin);
    const list = await app.inject({ method: 'GET', url: '/cameras', headers: auth(admin) });
    expect(list.json().data).toEqual([]);
  });

  it('is tenant-scoped: another tenant sees the device as not onboarded', async () => {
    const admin = await token(TENANT, ['admin']);
    await create(admin, { ...validCamera, streamUrl: DISCOVERED.suggestedStreamUrl });
    const other = await scan(await token(OTHER, ['admin']));
    expect(other.json().data.devices[0].alreadyOnboarded).toBe(false);
  });
});

describe('bulk onboarding — the DVR/NVR case (P-1)', () => {
  const channels = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      zoneId: 'on_zone1',
      name: `DVR Channel ${i + 1}`,
      protocol: 'rtsp' as const,
      streamUrl: `rtsp://10.0.0.9:554/cam/realmonitor?channel=${i + 1}&subtype=1`,
    }));

  const bulk = async (t: string, cameras: unknown[]) =>
    app.inject({ method: 'POST', url: '/cameras/bulk', headers: auth(t), payload: { cameras } });

  it('onboards every channel in one call', async () => {
    const res = await bulk(await token(TENANT, ['admin']), channels(8));
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.created).toBe(8);
    expect(data.failed).toBe(0);
    expect(data.results).toHaveLength(8);
    expect(data.results[0].camera.name).toBe('DVR Channel 1');
  });

  it('a single bad channel does not discard the good ones', async () => {
    // Partial success is the expected outcome. Wrapping this in a transaction would make an
    // installer who mistyped channel 7 redo the whole DVR.
    const admin = await token(TENANT, ['admin']);
    const list = channels(4);
    list[2] = { ...list[2]!, streamUrl: 'http://not-a-stream/x' };
    const res = await bulk(admin, list);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.created).toBe(3);
    expect(data.failed).toBe(1);
    expect(data.results[2].index).toBe(2);
    expect(data.results[2].created).toBe(false);
    expect(data.results[2].error).toBeTruthy();
  });

  it('never returns credentials, even in bulk', async () => {
    const res = await bulk(
      await token(TENANT, ['admin']),
      channels(2).map((c) => ({ ...c, credentials: { username: 'admin', password: 's3cr3t' } })),
    );
    expect(JSON.stringify(res.json())).not.toContain('s3cr3t');
    expect(res.json().data.results[0].camera.hasCredentials).toBe(true);
  });

  it('requires camera:create', async () => {
    expect((await bulk(await token(TENANT, ['viewer']), channels(1))).statusCode).toBe(403);
  });

  it('rejects an empty batch', async () => {
    expect((await bulk(await token(TENANT, ['admin']), [])).statusCode).toBe(400);
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

// -------------------------------------------------------------------------------------------
// P-2: lifecycle, measured health, capability cache
// -------------------------------------------------------------------------------------------

describe('camera lifecycle (P-2)', () => {
  async function onboard(t: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/cameras',
      headers: auth(t),
      payload: validCamera,
    });
    return res.json().data;
  }

  it('a newly onboarded camera is configured, never connected', async () => {
    const t = await token(TENANT, ['admin']);
    const camera = await onboard(t);
    // The platform has a configuration and has measured nothing. Claiming `connected` here is the
    // failure that makes every downstream dashboard fiction.
    expect(camera.lifecycle.state).toBe('configured');
    expect(camera.lifecycle.evidence).toBe('declared');
    expect(camera.operational).toBeUndefined();
  });

  it('refuses to onboard a configuration that cannot work', async () => {
    const t = await token(TENANT, ['admin']);
    const res = await app.inject({
      method: 'POST',
      url: '/cameras',
      headers: auth(t),
      payload: { ...validCamera, streamUrl: 'rtsp://admin:pass@cam.local/stream' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a hardware probe connects the camera and records what it measured', async () => {
    const t = await token(TENANT, ['admin']);
    const camera = await onboard(t);
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${camera.id}/probe`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const report = res.json().data;
    expect(report.lifecycle.state).toBe('connected');
    expect(report.lifecycle.evidence).toBe('measured');
    expect(report.operational.rtspLatencyMs).toBe(412);
    expect(report.operational.source).toBe('stream-probe');
  });

  it('NEGATIVE CONTROL: a flawless simulated probe does not connect the camera', async () => {
    const t = await token(TENANT, ['admin']);
    const camera = await onboard(t);
    probe.outcome = {
      result: { ...HARDWARE_OK.result!, evidenceClass: 'simulated', framesRead: 30, fps: 25 },
    };
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${camera.id}/probe`,
      headers: auth(t),
    });
    const report = res.json().data;
    // The checks all pass and the console shows them. The camera is still not connected, because
    // nothing was learned about a camera — only about the platform.
    expect(report.probe.evidenceClass).toBe('simulated');
    expect(report.lifecycle.state).toBe('configured');
  });

  it('distinguishes "we cannot test here" from "this camera failed"', async () => {
    const t = await token(TENANT, ['admin']);
    const camera = await onboard(t);
    probe.outcome = { unavailable: 'stream validation is not configured for this deployment' };
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${camera.id}/probe`,
      headers: auth(t),
    });
    const report = res.json().data;
    expect(report.unavailable).toMatch(/not configured/);
    expect(report.probe).toBeUndefined();
    // A deployment gap must not be recorded as a camera fault.
    expect(report.lifecycle.state).toBe('configured');
  });

  it('an unreachable device goes offline and says why', async () => {
    const t = await token(TENANT, ['admin']);
    const camera = await onboard(t);
    probe.outcome = {
      result: {
        ...HARDWARE_OK.result!,
        reachable: false,
        framesRead: 0,
        authentication: 'unknown',
        error: 'no route to host',
        checks: [{ name: 'reachability', status: 'fail', detail: 'no route to host' }],
      },
    };
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${camera.id}/probe`,
      headers: auth(t),
    });
    const report = res.json().data;
    expect(report.lifecycle.state).toBe('offline');
    expect(report.operational.streamAvailable).toBe(false);
  });

  it('retire keeps the record and its history, unlike delete', async () => {
    const t = await token(TENANT, ['admin']);
    const camera = await onboard(t);
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${camera.id}/retire`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const retired = res.json().data;
    expect(retired.lifecycle.state).toBe('retired');
    expect(retired.status).toBe('disabled');
    // Still there — an investigation months from now may need this camera's timeline.
    const still = await app.inject({
      method: 'GET',
      url: `/cameras/${camera.id}`,
      headers: auth(t),
    });
    expect(still.statusCode).toBe(200);
  });

  it('a retired camera is not revived by a probe that happens to reach it', async () => {
    const t = await token(TENANT, ['admin']);
    const camera = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${camera.id}/retire`, headers: auth(t) });
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${camera.id}/probe`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    // The device may have been redeployed somewhere else entirely. Reinstatement is a decision.
    expect(res.json().data.lifecycle.state).toBe('retired');
  });

  it('reinstate returns a camera to configured, not to whatever it was before', async () => {
    const t = await token(TENANT, ['admin']);
    const camera = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${camera.id}/probe`, headers: auth(t) });
    await app.inject({ method: 'POST', url: `/cameras/${camera.id}/retire`, headers: auth(t) });
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${camera.id}/reinstate`,
      headers: auth(t),
    });
    expect(res.json().data.lifecycle.state).toBe('configured');
    expect(res.json().data.status).toBe('enabled');
  });

  it('the timeline records credential rotation, which is what explains a later failure', async () => {
    const t = await token(TENANT, ['admin']);
    const camera = await onboard(t);
    await app.inject({
      method: 'PATCH',
      url: `/cameras/${camera.id}`,
      headers: auth(t),
      payload: { credentials: { username: 'admin', password: 'rotated' } },
    });
    const res = await app.inject({ method: 'GET', url: `/cameras/${camera.id}`, headers: auth(t) });
    const kinds = res.json().data.timeline.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain('credentials-updated');
  });

  it('probing requires camera:update, not merely camera:read', async () => {
    const admin = await token(TENANT, ['admin']);
    const camera = await onboard(admin);
    const viewer = await token(TENANT, ['viewer']);
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${camera.id}/probe`,
      headers: auth(viewer),
    });
    // A probe opens a stream on the customer's network. The permission matches what it does.
    expect(res.statusCode).toBe(403);
  });
});

describe('capability cache (P-2)', () => {
  it('serves from cache without contacting the device', async () => {
    const t = await token(TENANT, ['admin']);
    const created = await app.inject({
      method: 'POST',
      url: '/cameras',
      headers: auth(t),
      payload: validCamera,
    });
    const id = created.json().data.id;
    const res = await app.inject({
      method: 'POST',
      url: `/cameras/${id}/capabilities/refresh`,
      headers: auth(t),
    });
    const result = res.json().data;
    // Never discovered, and no device address on file — so it reports honestly rather than
    // re-scanning the whole segment on a per-camera button press.
    expect(result.reason).toBe('never-discovered');
    expect(result.refreshed).toBe(false);
    expect(result.unavailable).toMatch(/discovery/);
  });
});

describe('health trends (P-2)', () => {
  it('reports how much evidence a summary rests on', async () => {
    const t = await token(TENANT, ['admin']);
    const created = await app.inject({
      method: 'POST',
      url: '/cameras',
      headers: auth(t),
      payload: validCamera,
    });
    const id = created.json().data.id;
    const res = await app.inject({
      method: 'GET',
      url: `/cameras/${id}/health/summary`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const summary = res.json().data;
    expect(summary.cameraId).toBe(id);
    // One onboarding entry is not a trend, so no percentage is offered.
    expect(summary.availabilityPercent).toBeUndefined();
  });
});

describe('device identity (P-2)', () => {
  it('THE DHCP CASE: recognises a camera that moved and offers to update, not to duplicate', async () => {
    const t = await token(TENANT, ['admin']);
    // Onboarded from discovery, so its identity was carried through and stored.
    await app.inject({
      method: 'POST',
      url: '/cameras',
      headers: auth(t),
      payload: {
        zoneId: 'on_zone1',
        name: 'Lobby',
        protocol: 'rtsp',
        streamUrl: 'rtsp://10.0.0.64:554/Streaming/Channels/102',
        identity: { onvifUuid: 'urn:uuid:abc-123', lastKnownAddress: '10.0.0.64' },
      },
    });

    // The lease renewed overnight; the same physical camera now answers from .99.
    discovery.probeResult = {
      devices: [
        {
          ...DISCOVERED,
          identity: { onvifUuid: 'urn:uuid:abc-123', lastKnownAddress: '10.0.0.99' },
          suggestedStreamUrl: 'rtsp://10.0.0.99:554/Streaming/Channels/102',
        },
      ],
      probedSeconds: 3,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/cameras/discover',
      headers: auth(t),
      payload: {},
    });
    const device = res.json().data.devices[0];
    // Matching on the URL alone would call this a new camera, and the installer would onboard the
    // same hardware twice — one of the two never connecting again.
    expect(device.alreadyOnboarded).toBe(true);
    expect(device.addressChanged).toBe(true);
    expect(device.cameraId).toBeDefined();
  });

  it('a device with no identity still matches on its stream URL', async () => {
    const t = await token(TENANT, ['admin']);
    await app.inject({
      method: 'POST',
      url: '/cameras',
      headers: auth(t),
      payload: {
        zoneId: 'on_zone1',
        name: 'Lobby',
        protocol: 'rtsp',
        streamUrl: 'rtsp://10.0.0.64:554/Streaming/Channels/102',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/cameras/discover',
      headers: auth(t),
      payload: {},
    });
    const device = res.json().data.devices[0];
    expect(device.alreadyOnboarded).toBe(true);
    expect(device.addressChanged).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// P-2.2 — the immutable probe archive
// ---------------------------------------------------------------------------------------------

describe('immutable probe archive (P-2.2)', () => {
  const onboard = async (t: string) => (await create(t)).json().data.id as string;

  it('keeps every probe rather than overwriting the last one', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    probe.outcome = HARDWARE_NO_FRAME;
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });

    const res = await app.inject({ method: 'GET', url: `/cameras/${id}/probes`, headers: auth(t) });
    expect(res.statusCode).toBe(200);
    const history = res.json().data;
    // Before P-2.2 the first report simply ceased to exist, which makes "was it always like this?"
    // — the most common operational question there is — permanently unanswerable.
    expect(history.total).toBe(2);
    expect(history.retained).toBe(2);
    expect(history.evicted).toBe(0);
    expect(history.records.map((r: { outcome: string }) => r.outcome)).toEqual([
      'failed',
      'succeeded',
    ]);
    // Correlation: the newest points back at the one before it (rec 2).
    expect(history.records[0].previousProbeId).toBe(history.records[1].probeId);
    expect(history.records[0].previousOutcome).toBe('succeeded');
  });

  it("records the configuration each probe ran against, not the camera's current one", async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    await app.inject({
      method: 'PATCH',
      url: `/cameras/${id}`,
      headers: auth(t),
      payload: { streamUrl: 'rtsp://cam.local:554/main' },
    });

    const history = (
      await app.inject({ method: 'GET', url: `/cameras/${id}/probes`, headers: auth(t) })
    ).json().data;
    // The stored report still says what was measured. Back-filling today's URL would silently
    // rewrite history to match the present, and the comparison would be against a stream nobody ran.
    expect(history.records[0].configuration.streamUrl).toBe('rtsp://cam.local:554/stream');
  });

  it('replays a stored probe without contacting the camera', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    const history = (
      await app.inject({ method: 'GET', url: `/cameras/${id}/probes`, headers: auth(t) })
    ).json().data;
    const probeId = history.records[0].probeId;

    const before = probe.calls;
    const res = await app.inject({
      method: 'GET',
      url: `/cameras/${id}/probes/${probeId}`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const replay = res.json().data;
    // The whole point (rec 6): support work happens days later, often on a camera that has since
    // been power-cycled into working. Re-probing then answers "it works now" and explains nothing.
    expect(probe.calls).toBe(before);
    expect(replay.stages.map((s: { name: string }) => s.name)).toEqual([
      'dns',
      'tcp',
      'authentication',
      'stream-open',
      'first-frame',
      'frames-received',
    ]);
    expect(replay.outcome).toBe('succeeded');
    expect(replay.evidenceClass).toBe('hardware');
    expect(replay.recordedAt).toBe('2026-07-28T00:00:00.000Z');
  });

  it('records a probe that could not run at all, so the gap has a timestamp', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    probe.outcome = { unavailable: 'no stream validator is configured' };
    const res = await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    expect(res.json().data.unavailable).toBe('no stream validator is configured');

    const history = (
      await app.inject({ method: 'GET', url: `/cameras/${id}/probes`, headers: auth(t) })
    ).json().data;
    expect(history.records[0].outcome).toBe('unavailable');
    // It measured nothing about the camera — and must never claim otherwise.
    expect(history.records[0].evidenceClass).toBe('simulated');
    expect(history.records[0].result).toBeUndefined();
  });

  it('records what the camera has been proven to work under, and never from a simulation', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    let camera = (
      await app.inject({ method: 'GET', url: `/cameras/${id}`, headers: auth(t) })
    ).json().data;
    const supported = camera.compatibility.find(
      (row: { dimension: string }) => row.dimension === 'provider',
    );
    expect(supported).toMatchObject({ value: 'rtsp', status: 'supported', successfulProbes: 1 });
    expect(
      camera.compatibility.find(
        (row: { dimension: string }) => row.dimension === 'runtime-version',
      ),
    ).toMatchObject({ value: '0.1.0', status: 'supported' });

    // A device-side failure on hardware evidence is the only thing that earns `unsupported`.
    probe.outcome = HARDWARE_NO_FRAME;
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    camera = (await app.inject({ method: 'GET', url: `/cameras/${id}`, headers: auth(t) })).json()
      .data;
    expect(
      camera.compatibility.find((row: { dimension: string }) => row.dimension === 'provider')
        .status,
    ).toBe('unsupported');
  });

  it('never marks a firmware unsupported for a credential failure', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    probe.outcome = {
      result: {
        ...HARDWARE_NO_FRAME.result!,
        failureCode: 'authentication-failure',
        authentication: 'failed',
      },
    };
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    const camera = (
      await app.inject({ method: 'GET', url: `/cameras/${id}`, headers: auth(t) })
    ).json().data;
    // A wrong password says nothing whatsoever about a vendor's firmware. Counting it would
    // eventually brand a perfectly good release unsupported across an entire estate.
    expect(
      camera.compatibility.find((row: { dimension: string }) => row.dimension === 'provider')
        .status,
    ).toBe('pending-validation');
  });

  it('does not issue an operational confidence score from a single probe', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    const summary = (
      await app.inject({ method: 'GET', url: `/cameras/${id}/health/summary`, headers: auth(t) })
    ).json().data;
    // A percentage computed from one observation is arithmetic wearing a uniform (rec 4).
    expect(summary.confidence.band).toBe('insufficient-evidence');
    expect(summary.confidence.score).toBeUndefined();
  });

  it('reports per-stage probe performance', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    const metrics = (
      await app.inject({ method: 'GET', url: `/cameras/${id}/probes/metrics`, headers: auth(t) })
    ).json().data;
    expect(metrics.probes).toBe(1);
    expect(metrics.successRatePercent).toBe(100);
    expect(metrics.averageTotalMs).toBe(640);
    expect(metrics.stages.find((s: { stage: string }) => s.stage === 'dns').averageMs).toBe(12);
    expect(metrics.hardwareProbes).toBe(1);
  });

  it('merges every record into one chronology', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    const evidence = (
      await app.inject({ method: 'GET', url: `/cameras/${id}/evidence`, headers: auth(t) })
    ).json().data;
    // One question, one chronology (rec 8) — assembled from four records that stay separate on the
    // write side because they have four different retention rules.
    expect(evidence.sources).toContain('probe');
    expect(evidence.sources).toContain('lifecycle');
    expect(evidence.entries.every((e: { at: string; summary: string }) => e.summary)).toBe(true);
    // The probe appears once, not twice: the archive is authoritative and the timeline echo is dropped.
    expect(evidence.entries.filter((e: { source: string }) => e.source === 'probe')).toHaveLength(
      1,
    );
  });

  it('counts the cameras nobody has ever probed in the fleet view', async () => {
    const t = await token(TENANT, ['admin']);
    const probed = await onboard(t);
    await create(t, { ...validCamera, name: 'Never tested', streamUrl: 'rtsp://cam2.local/s' });
    await app.inject({ method: 'POST', url: `/cameras/${probed}/probe`, headers: auth(t) });

    const fleet = (
      await app.inject({ method: 'GET', url: '/cameras/metrics', headers: auth(t) })
    ).json().data;
    expect(fleet.cameras).toBe(2);
    expect(fleet.camerasProbed).toBe(1);
    // The denominator nobody remembers to ask for. "100% probe success" over the one camera anyone
    // tested is a green number describing a sample nobody chose.
    expect(fleet.camerasNeverProbed).toBe(1);
    expect(fleet.successRatePercent).toBe(100);
  });

  it("does not leak another tenant's probe reports", async () => {
    const t = await token(TENANT, ['admin']);
    const other = await token(OTHER, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    const res = await app.inject({
      method: 'GET',
      url: `/cameras/${id}/probes`,
      headers: auth(other),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// P-2.3 — provenance, decisions, trend
// ---------------------------------------------------------------------------------------------

describe('investigation surface (P-2.3)', () => {
  const onboard = async (t: string) => (await create(t)).json().data.id as string;

  it('gives every evidence entry the same provenance envelope', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    const evidence = (
      await app.inject({ method: 'GET', url: `/cameras/${id}/evidence`, headers: auth(t) })
    ).json().data;

    for (const entry of evidence.entries) {
      // The chain of custody, identical whatever produced the entry — which is what lets a future
      // producer appear in this timeline without a consumer change.
      expect(entry.evidenceId).toBeTruthy();
      expect(entry.evidenceType).toBeTruthy();
      expect(entry.tenantId).toBe(TENANT);
      expect(entry.producer).toBeTruthy();
      expect(entry.links.cameraId).toBe(id);
    }
    const probe = evidence.entries.find((e: { source: string }) => e.source === 'probe');
    expect(probe.producer).toBe('ai-runtime');
    expect(probe.runtimeVersion).toBe('0.1.0');
  });

  it('explains why a simulated probe moved nothing', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    probe.outcome = {
      result: { ...HARDWARE_OK.result!, evidenceClass: 'simulated' },
    };
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });

    const log = (
      await app.inject({ method: 'GET', url: `/cameras/${id}/decisions`, headers: auth(t) })
    ).json().data;
    const unchanged = log.decisions.find((d: { decision: string }) => d.decision === 'unchanged');
    // Explainability only — this route reconstructs and changes nothing. Without it, a state that
    // correctly refuses to move looks exactly like a bug.
    expect(unchanged.reason).toContain('hardware evidence');
    expect(unchanged.supportingEvidence[0]).toMatch(/^probe:/);
  });

  it('never persists a derived value on the camera', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    const camera = (
      await app.inject({ method: 'GET', url: `/cameras/${id}`, headers: auth(t) })
    ).json().data;
    // Measurements and observations are stored; conclusions are derived on read. A stored confidence
    // or trend is a second copy of a conclusion that can drift from the evidence behind it.
    for (const derived of ['confidence', 'confidenceTrend', 'decisions', 'trend', 'summary']) {
      expect(camera[derived]).toBeUndefined();
    }
  });

  it('returns a confidence trend with gaps rather than an interpolated line', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    const trend = (
      await app.inject({ method: 'GET', url: `/cameras/${id}/confidence`, headers: auth(t) })
    ).json().data;
    expect(trend.points).toHaveLength(12);
    // One probe is not a trend, and the buckets say so instead of drawing a line through them.
    expect(trend.points.every((p: { score?: number }) => p.score === undefined)).toBe(true);
    expect(trend.current.band).toBe('insufficient-evidence');
  });

  it('reports a fleet aggregate as a census when it is one', async () => {
    const t = await token(TENANT, ['admin']);
    const id = await onboard(t);
    await app.inject({ method: 'POST', url: `/cameras/${id}/probe`, headers: auth(t) });
    const fleet = (
      await app.inject({ method: 'GET', url: '/cameras/metrics', headers: auth(t) })
    ).json().data;
    // `sampled` is what stops a bounded read being presented as a complete one at fleet scale.
    expect(fleet.sampled).toBe(false);
    expect(fleet.cameras).toBe(1);
  });
});
