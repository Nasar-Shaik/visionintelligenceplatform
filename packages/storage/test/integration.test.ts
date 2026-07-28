/**
 * Integration test — the tenant-isolated storage wrapper against a REAL MinIO (dev stack). Proves
 * a recording lands under `{tenantId}/{cameraId}/…`, is retrievable + presignable, and that a
 * tenant's listing never crosses into another's prefix. SKIPS gracefully when MinIO is unreachable
 * (so default `pnpm test` stays green everywhere); run `pnpm dev:stack` to execute it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { S3ObjectStore, TenantObjectStore } from '../src/index.js';

const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:49000';
const ACCESS = process.env.AWS_ACCESS_KEY_ID ?? 'vip_dev';
const SECRET = process.env.AWS_SECRET_ACCESS_KEY ?? 'change_me_dev_only';
const BUCKET = `vip-recordings-it-${Date.now()}`;

const s3Opts = {
  endpoint: ENDPOINT,
  accessKeyId: ACCESS,
  secretAccessKey: SECRET,
  bucket: BUCKET,
  forcePathStyle: true,
};

let store: S3ObjectStore;

async function reachable(): Promise<boolean> {
  try {
    const client = new S3Client({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
      forcePathStyle: true,
      requestHandler: { requestTimeout: 1500, connectionTimeout: 1500 },
    });
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    store = new S3ObjectStore(s3Opts);
    return true;
  } catch {
    return false;
  }
}

const online = await reachable();

describe.skipIf(!online)('tenant-isolated storage against real MinIO', () => {
  beforeAll(() => {
    // store constructed in reachable()
  });

  afterAll(async () => {
    if (!online) return;
    // Best-effort cleanup of test objects (bucket removal is not required for correctness).
    const a = new TenantObjectStore(store, 'tnt_a');
    const b = new TenantObjectStore(store, 'tnt_b');
    for (const s of [a, b]) for (const o of await s.list()) await s.delete(o.key);
  });

  it('records a segment under {tenantId}/{cameraId}/… and reads it back + presigns it', async () => {
    const a = new TenantObjectStore(store, 'tnt_a');
    const key = a.keyFor('cam_1', 'recordings', 'seg-0001.mp4');
    await a.put(key, new Uint8Array([1, 2, 3, 4]), 'video/mp4');

    const head = await a.head(key);
    expect(head?.size).toBe(4);

    const got = await a.get(key);
    expect([...got.body]).toEqual([1, 2, 3, 4]);
    expect(got.contentType).toBe('video/mp4');

    const url = await a.presignGet(key, 60);
    expect(url).toContain('tnt_a/cam_1/recordings/seg-0001.mp4');
    expect(url).toMatch(/X-Amz-Signature=/);

    const listed = await a.list('cam_1/');
    expect(listed.map((o) => o.key)).toContain('cam_1/recordings/seg-0001.mp4');
  });

  it('keeps tenants isolated — B cannot see or read A’s recording', async () => {
    const a = new TenantObjectStore(store, 'tnt_a');
    const b = new TenantObjectStore(store, 'tnt_b');
    await a.put(a.keyFor('cam_1', 'x.mp4'), 'A-DATA', 'video/mp4');
    await b.put(b.keyFor('cam_1', 'y.mp4'), 'B-DATA', 'video/mp4');

    const bKeys = (await b.list()).map((o) => o.key);
    expect(bKeys).toContain('cam_1/y.mp4');
    expect(bKeys).not.toContain('cam_1/x.mp4');

    // Same relative key, different tenant → different object (no bleed).
    expect(new TextDecoder().decode((await b.get('cam_1/y.mp4')).body)).toBe('B-DATA');
    expect(await b.head('cam_1/x.mp4')).toBeNull();
  });
});
