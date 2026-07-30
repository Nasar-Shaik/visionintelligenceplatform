/**
 * LocalFsObjectStore — the filesystem provider behind the ObjectStore port. Proves put/get/head/list/
 * delete round-trips, deterministic expiring signed URLs, and fail-closed path-traversal refusal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsObjectStore, StorageError, TenantObjectStore } from '../src/index.js';

describe('LocalFsObjectStore', () => {
  let dir: string;
  let store: LocalFsObjectStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vip-evd-'));
    store = new LocalFsObjectStore({
      baseDir: dir,
      publicBaseUrl: 'http://local/evd',
      now: () => 1_000_000,
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips bytes + content-type and reports head/size', async () => {
    await store.put({ key: 'tnt_a/evidence/x.jpg', body: 'hello', contentType: 'image/jpeg' });
    const got = await store.get('tnt_a/evidence/x.jpg');
    expect(new TextDecoder().decode(got.body)).toBe('hello');
    expect(got.contentType).toBe('image/jpeg');
    const head = await store.head('tnt_a/evidence/x.jpg');
    expect(head?.size).toBe(5);
    expect(await store.head('tnt_a/evidence/missing.jpg')).toBeNull();
  });

  it('lists keys under a prefix (excluding sidecars)', async () => {
    await store.put({ key: 'tnt_a/a.bin', body: 'a' });
    await store.put({ key: 'tnt_a/b.bin', body: 'b' });
    await store.put({ key: 'tnt_b/c.bin', body: 'c' });
    const keys = (await store.list('tnt_a/')).map((o) => o.key);
    expect(keys).toEqual(['tnt_a/a.bin', 'tnt_a/b.bin']);
  });

  it('produces deterministic, expiring signed URLs', async () => {
    const url = await store.presignGet('tnt_a/evidence/x.jpg', 900);
    expect(url).toBe('http://local/evd/tnt_a/evidence/x.jpg?expires=1900'); // 1_000_000/1000 + 900
  });

  it('deletes bytes + sidecar', async () => {
    await store.put({ key: 'tnt_a/x.bin', body: 'x', contentType: 'application/octet-stream' });
    await store.delete('tnt_a/x.bin');
    expect(await store.head('tnt_a/x.bin')).toBeNull();
  });

  it('refuses a key that escapes the storage root (fail-closed)', async () => {
    await expect(store.get('../../etc/passwd')).rejects.toBeInstanceOf(StorageError);
  });

  it('works under the TenantObjectStore isolation wrapper', async () => {
    const tenant = new TenantObjectStore(store, 'tnt_a');
    await tenant.put('evidence/y.jpg', 'yy', 'image/jpeg');
    // The raw store sees the tenant-prefixed key; the wrapper sees the relative key.
    expect(await store.head('tnt_a/evidence/y.jpg')).not.toBeNull();
    const url = await tenant.presignGet('evidence/y.jpg', 60);
    expect(url).toContain('tnt_a/evidence/y.jpg');
  });
});
