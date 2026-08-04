/**
 * ⚠️ Pins the fix from ADR-0034: a signed URL must carry the name the **browser** can reach, while
 * server-side operations keep using the internal one.
 *
 * P-5.8 deployed the platform for the first time and playback was completely broken — every URL
 * pointed at `http://minio:9000`, a container-internal hostname no operator's browser can resolve,
 * over plaintext, from an HTTPS page. Three milestones had validated playback against `pnpm dev`,
 * where browser and service both say `localhost:49000` and one endpoint is accidentally enough.
 *
 * These tests need no MinIO: presigning is a local signature computation, so what the URL says is
 * decidable offline. That is the point — the defect was always visible from the URL, and nothing
 * had ever looked at it.
 */
import { describe, expect, it } from 'vitest';
import { S3ObjectStore } from '../src/s3-object-store.js';

const base = {
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
  bucket: 'vip-recordings',
  region: 'us-east-1',
  forcePathStyle: true,
};

describe('S3ObjectStore.presignGet — public vs internal endpoint', () => {
  it('signs against the public endpoint when the browser reaches storage by a different name', async () => {
    const store = new S3ObjectStore({
      ...base,
      endpoint: 'http://minio:9000',
      publicEndpoint: 'https://vip.example.com',
    });
    const url = await store.presignGet('tnt_a/cam_1/clip.mp4', 900);
    expect(url.startsWith('https://vip.example.com/vip-recordings/tnt_a/cam_1/clip.mp4')).toBe(
      true,
    );
    /* ⚠️ The internal name must not appear anywhere — not in the host, not in a query parameter. */
    expect(url).not.toContain('minio:9000');
  });

  it('still signs a working URL: signature, expiry and the signed-header set are present', async () => {
    const store = new S3ObjectStore({
      ...base,
      endpoint: 'http://minio:9000',
      publicEndpoint: 'https://vip.example.com',
    });
    const params = new URL(await store.presignGet('tnt_a/cam_1/clip.mp4', 900)).searchParams;
    expect(params.get('X-Amz-Expires')).toBe('900');
    expect(params.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    /* SigV4 covers `host`, which is exactly why signing against a different name is safe: the
     * object store validates against the name the browser actually used. */
    expect(params.get('X-Amz-SignedHeaders')).toContain('host');
  });

  it('⚠️ produces a DIFFERENT signature for the public name — proof the host is really covered', async () => {
    const internal = new S3ObjectStore({ ...base, endpoint: 'http://minio:9000' });
    const published = new S3ObjectStore({
      ...base,
      endpoint: 'http://minio:9000',
      publicEndpoint: 'https://vip.example.com',
    });
    const a = new URL(await internal.presignGet('k.mp4', 900)).searchParams.get('X-Amz-Signature');
    const b = new URL(await published.presignGet('k.mp4', 900)).searchParams.get('X-Amz-Signature');
    expect(a).not.toBe(b);
  });

  it('defaults to the internal endpoint when no public one is given (development is unchanged)', async () => {
    const store = new S3ObjectStore({ ...base, endpoint: 'http://localhost:49000' });
    const url = await store.presignGet('tnt_a/cam_1/clip.mp4', 60);
    expect(url.startsWith('http://localhost:49000/vip-recordings/')).toBe(true);
  });

  it('treats an identical public endpoint as no override at all', async () => {
    const store = new S3ObjectStore({
      ...base,
      endpoint: 'http://localhost:49000',
      publicEndpoint: 'http://localhost:49000',
    });
    const url = await store.presignGet('k.mp4', 60);
    expect(url.startsWith('http://localhost:49000/vip-recordings/k.mp4')).toBe(true);
  });
});
