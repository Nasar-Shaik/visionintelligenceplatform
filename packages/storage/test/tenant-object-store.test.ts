/**
 * Unit tests for the fail-closed tenant isolation — driven against an in-memory ObjectStore so
 * they run everywhere. Proves the `{tenantId}/` prefix is enforced, keys can't escape it, blank
 * tenants are refused, and one tenant's `list('')` never sees another's objects. The real-MinIO
 * proof lives in integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  StorageError,
  TenantObjectStore,
  type ObjectStore,
  type ObjectSummary,
} from '../src/index.js';

function memoryStore(): ObjectStore & { keys(): string[] } {
  const map = new Map<string, { body: Uint8Array; contentType?: string }>();
  return {
    keys: () => [...map.keys()],
    async put({ key, body, contentType }) {
      const bytes =
        typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
      map.set(key, contentType === undefined ? { body: bytes } : { body: bytes, contentType });
    },
    async get(key) {
      const o = map.get(key);
      if (!o) throw new StorageError(`not found: ${key}`);
      return o.contentType === undefined
        ? { body: o.body }
        : { body: o.body, contentType: o.contentType };
    },
    async list(prefix) {
      const out: ObjectSummary[] = [];
      for (const [key, v] of map)
        if (key.startsWith(prefix)) out.push({ key, size: v.body.length });
      return out;
    },
    async head(key) {
      const o = map.get(key);
      return o ? { key, size: o.body.length } : null;
    },
    async delete(key) {
      map.delete(key);
    },
    async presignGet(key, ttl) {
      return `https://signed.example/${key}?ttl=${ttl}`;
    },
  };
}

describe('construction', () => {
  it('refuses a blank tenantId (fail-closed)', () => {
    expect(() => new TenantObjectStore(memoryStore(), '')).toThrow(StorageError);
    expect(() => new TenantObjectStore(memoryStore(), '   ')).toThrow(StorageError);
  });
  it('refuses a tenantId containing a slash', () => {
    expect(() => new TenantObjectStore(memoryStore(), 'a/b')).toThrow(StorageError);
  });
});

describe('prefixing', () => {
  it('stores under {tenantId}/relKey and reads it back in relative terms', async () => {
    const inner = memoryStore();
    const store = new TenantObjectStore(inner, 'tnt_a');
    await store.put('cam1/recordings/seg.mp4', 'DATA', 'video/mp4');
    expect(inner.keys()).toEqual(['tnt_a/cam1/recordings/seg.mp4']);
    const got = await store.get('cam1/recordings/seg.mp4');
    expect(new TextDecoder().decode(got.body)).toBe('DATA');
    expect(got.contentType).toBe('video/mp4');
  });

  it('keyFor builds a safe relative key and rejects bad segments', () => {
    const store = new TenantObjectStore(memoryStore(), 'tnt_a');
    expect(store.keyFor('cam1', 'recordings', 'seg.mp4')).toBe('cam1/recordings/seg.mp4');
    expect(() => store.keyFor('cam1', '..', 'x')).toThrow(StorageError);
    expect(() => store.keyFor('cam1', 'a/b')).toThrow(StorageError);
  });

  it('presigned URLs are for the prefixed key', async () => {
    const store = new TenantObjectStore(memoryStore(), 'tnt_a');
    expect(await store.presignGet('cam1/x.mp4', 60)).toContain('tnt_a/cam1/x.mp4');
  });
});

describe('key-escape rejection (fail-closed)', () => {
  const store = new TenantObjectStore(memoryStore(), 'tnt_a');
  it('rejects traversal / absolute / empty keys', async () => {
    await expect(store.put('../tnt_b/x', 'X')).rejects.toThrow(StorageError);
    await expect(store.put('/etc/passwd', 'X')).rejects.toThrow(StorageError);
    await expect(store.get('')).rejects.toThrow(StorageError);
    await expect(store.put('a/../../b', 'X')).rejects.toThrow(StorageError);
  });
});

describe('cross-tenant list isolation', () => {
  it('list only ever returns the tenant’s own objects, in relative form', async () => {
    const inner = memoryStore();
    const a = new TenantObjectStore(inner, 'tnt_a');
    const b = new TenantObjectStore(inner, 'tnt_b');
    await a.put('cam1/x.mp4', 'A');
    await b.put('cam1/y.mp4', 'B');

    const aList = await a.list();
    expect(aList.map((o) => o.key).sort()).toEqual(['cam1/x.mp4']);
    const bList = await b.list('cam1/');
    expect(bList.map((o) => o.key)).toEqual(['cam1/y.mp4']);

    // A cannot read B's object even by guessing the relative key — it resolves under tnt_a/.
    await expect(a.get('cam1/y.mp4')).rejects.toThrow(StorageError);
  });
});
