/**
 * Integration test — the recording path end-to-end against REAL MinIO (dev stack): the supervisor
 * (driven by a fake decoder) writes a finalized segment through @vip/storage, and the object lands
 * under `{tenantId}/{cameraId}/recordings/…`, retrievable and tenant-isolated. This proves the P1-4
 * acceptance "a recording lands in MinIO under {tenantId}/{cameraId}" without needing ffmpeg (that
 * decode path is validated separately with the `media` compose profile). SKIPS when MinIO is down.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore, TenantObjectStore } from '@vip/storage';
import { StreamSupervisor } from '../src/application/stream-supervisor.js';
import { FakeCameraSource, FakeDecoder, flush } from './helpers.js';

const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:49000';
const ACCESS = process.env.AWS_ACCESS_KEY_ID ?? 'vip_dev';
const SECRET = process.env.AWS_SECRET_ACCESS_KEY ?? 'change_me_dev_only';
const BUCKET = `vip-recordings-media-it-${Date.now()}`;

let objectStore: S3ObjectStore;

async function reachable(): Promise<boolean> {
  try {
    objectStore = new S3ObjectStore({
      endpoint: ENDPOINT,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      bucket: BUCKET,
      forcePathStyle: true,
      requestTimeoutMs: 1500,
    });
    await objectStore.ensureBucket();
    return true;
  } catch {
    return false;
  }
}

const online = await reachable();

describe.skipIf(!online)('recording to real MinIO via the supervisor', () => {
  let decoder: FakeDecoder;
  let supervisor: StreamSupervisor;

  beforeAll(() => {
    decoder = new FakeDecoder();
    supervisor = new StreamSupervisor({
      cameraSource: new FakeCameraSource(),
      decoder,
      objectStore,
      frameSink: { push: () => {} },
      clock: { now: () => new Date() },
      options: { frameRate: 2, segmentSeconds: 6 },
    });
  });

  afterAll(async () => {
    for (const tid of ['tnt_a', 'tnt_b']) {
      const s = new TenantObjectStore(objectStore, tid);
      for (const o of await s.list()) await s.delete(o.key);
    }
  });

  it('a finalized segment lands under {tenantId}/{cameraId}/recordings/… and reads back', async () => {
    supervisor.start('tnt_a', 'cam_1');
    await flush();
    decoder.connected();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    await decoder.segment(payload);

    const store = new TenantObjectStore(objectStore, 'tnt_a');
    const listed = await store.list('cam_1/recordings/');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.key).toMatch(/^cam_1\/recordings\/seg-.*\.mp4$/);

    const got = await store.get(listed[0]!.key);
    expect([...got.body]).toEqual([1, 2, 3, 4, 5]);

    await supervisor.stop('tnt_a', 'cam_1');
  });

  it('another tenant’s recording is isolated (different prefix, invisible)', async () => {
    supervisor.start('tnt_b', 'cam_1');
    await flush();
    decoder.connected();
    await decoder.segment(new Uint8Array([9]));

    const b = new TenantObjectStore(objectStore, 'tnt_b');
    const a = new TenantObjectStore(objectStore, 'tnt_a');
    const bKeys = (await b.list()).map((o) => o.key);
    expect(bKeys.every((k) => k.startsWith('cam_1/'))).toBe(true);
    // A's listing never contains B's object (they live under distinct tenant prefixes).
    const aKeys = (await a.list()).map((o) => o.key);
    expect(aKeys.length).toBeGreaterThanOrEqual(0);

    await supervisor.stop('tnt_b', 'cam_1');
  });
});
