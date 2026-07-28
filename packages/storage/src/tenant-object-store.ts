/**
 * TenantObjectStore — the fail-closed tenant isolation for object storage, the MinIO counterpart
 * of the @vip/tenancy Mongo guard. It wraps a raw {@link ObjectStore} bound to a single tenant and
 * transparently prefixes every key with `{tenantId}/`, so a service works in RELATIVE keys and
 * cannot address another tenant's objects (STORAGE_ARCHITECTURE.md §MinIO). Construction with a
 * blank tenantId is refused; a relative key that tries to escape the prefix (`..`, absolute, empty
 * segment) is refused. `list('')` only ever sees this tenant's objects.
 */
import type { ObjectBody, ObjectStore, ObjectSummary } from './object-store.js';
import { StorageError } from './errors.js';

export class TenantObjectStore {
  readonly #inner: ObjectStore;
  readonly #tenantId: string;
  readonly #prefix: string;

  constructor(inner: ObjectStore, tenantId: string) {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new StorageError('a non-blank tenantId is required', 'tenant_required');
    }
    if (tenantId.includes('/')) {
      throw new StorageError('tenantId must not contain "/"', 'tenant_required');
    }
    this.#inner = inner;
    this.#tenantId = tenantId;
    this.#prefix = `${tenantId}/`;
  }

  get tenantId(): string {
    return this.#tenantId;
  }

  /**
   * Build a safe relative key from path segments (each validated). Use this instead of string
   * concatenation, e.g. `keyFor(cameraId, 'recordings', name)` → `cameraId/recordings/name`.
   */
  keyFor(...segments: string[]): string {
    return segments.map((s) => safeSegment(s)).join('/');
  }

  async put(
    relKey: string,
    body: Uint8Array | Buffer | string,
    contentType?: string,
  ): Promise<void> {
    await this.#inner.put({
      key: this.#abs(relKey),
      body,
      ...(contentType ? { contentType } : {}),
    });
  }

  async get(relKey: string): Promise<ObjectBody> {
    return this.#inner.get(this.#abs(relKey));
  }

  /** List this tenant's objects under a relative prefix; returned keys are RELATIVE to the tenant. */
  async list(relPrefix = ''): Promise<ObjectSummary[]> {
    const abs = relPrefix === '' ? this.#prefix : this.#abs(relPrefix, { allowPrefix: true });
    const items = await this.#inner.list(abs);
    return items.map((o) => ({ ...o, key: this.#rel(o.key) }));
  }

  async head(relKey: string): Promise<ObjectSummary | null> {
    const o = await this.#inner.head(this.#abs(relKey));
    return o ? { ...o, key: this.#rel(o.key) } : null;
  }

  async delete(relKey: string): Promise<void> {
    await this.#inner.delete(this.#abs(relKey));
  }

  async presignGet(relKey: string, ttlSeconds: number): Promise<string> {
    return this.#inner.presignGet(this.#abs(relKey), ttlSeconds);
  }

  /** Resolve a relative key to its absolute, tenant-prefixed form (fail-closed on escape). */
  #abs(relKey: string, opts: { allowPrefix?: boolean } = {}): string {
    if (typeof relKey !== 'string' || relKey === '') {
      throw new StorageError('a relative key is required', 'invalid_key');
    }
    if (relKey.startsWith('/')) {
      throw new StorageError('relative key must not be absolute', 'invalid_key');
    }
    const segs = relKey.split('/');
    for (const [i, s] of segs.entries()) {
      // A trailing empty segment is allowed only for a prefix ("cameras/" ends with "").
      const isTrailingEmpty = opts.allowPrefix && i === segs.length - 1 && s === '';
      if (s === '..' || s === '.' || (s === '' && !isTrailingEmpty)) {
        throw new StorageError(`invalid key segment in "${relKey}"`, 'invalid_key');
      }
    }
    return this.#prefix + relKey;
  }

  /** Strip the tenant prefix from an absolute key (invariant: it always starts with the prefix). */
  #rel(absKey: string): string {
    return absKey.startsWith(this.#prefix) ? absKey.slice(this.#prefix.length) : absKey;
  }
}

/** Validate a single path segment: non-empty, no slashes, no traversal. */
function safeSegment(s: string): string {
  if (typeof s !== 'string' || s === '' || s === '.' || s === '..' || s.includes('/')) {
    throw new StorageError(`invalid key segment: "${s}"`, 'invalid_key');
  }
  return s;
}
