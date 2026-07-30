/**
 * LocalFsObjectStore — a filesystem {@link ObjectStore} for local dev + deterministic tests, so the
 * whole storage path runs with no MinIO/S3. It is the local counterpart of {@link S3ObjectStore}:
 * both sit behind the same port, so a service selects a provider by CONFIG, not code
 * (`EVIDENCE_STORAGE_PROVIDER=local|s3`). Not for production (no real signing/replication).
 *
 * Layout: bytes at `{baseDir}/{key}`, content-type in a sibling `{path}.ctype` sidecar. `presignGet`
 * returns a deterministic, expiring URL (`{publicBaseUrl}/{key}?expires=<epoch>`) — the same
 * signed-URL-only access shape the S3 provider gives, so download/playback never streams through a
 * service. Keys are validated against path traversal (fail-closed).
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ObjectBody, ObjectStore, ObjectSummary, PutObjectInput } from './object-store.js';
import { StorageError } from './errors.js';

const CTYPE_SUFFIX = '.ctype';

export interface LocalFsObjectStoreOptions {
  /** Root directory objects live under (created on demand). */
  baseDir: string;
  /** Base URL for signed GETs (default `file://{baseDir}`). */
  publicBaseUrl?: string;
  /** Injected clock for deterministic expiry (default `Date.now`). */
  now?: () => number;
}

export class LocalFsObjectStore implements ObjectStore {
  readonly #baseDir: string;
  readonly #publicBaseUrl: string;
  readonly #now: () => number;

  constructor(opts: LocalFsObjectStoreOptions) {
    this.#baseDir = resolve(opts.baseDir);
    this.#publicBaseUrl = opts.publicBaseUrl ?? `file://${this.#baseDir}`;
    this.#now = opts.now ?? (() => Date.now());
  }

  async put(input: PutObjectInput): Promise<void> {
    const abs = this.#resolve(input.key);
    await mkdir(dirname(abs), { recursive: true });
    const body = typeof input.body === 'string' ? Buffer.from(input.body) : Buffer.from(input.body);
    await writeFile(abs, body);
    if (input.contentType) await writeFile(abs + CTYPE_SUFFIX, input.contentType);
  }

  async get(key: string): Promise<ObjectBody> {
    const abs = this.#resolve(key);
    let body: Buffer;
    try {
      body = await readFile(abs);
    } catch {
      throw new StorageError(`object not found: ${key}`, 'storage_error');
    }
    const contentType = await this.#readCtype(abs);
    return {
      body: new Uint8Array(body),
      contentLength: body.byteLength,
      ...(contentType ? { contentType } : {}),
    };
  }

  async list(prefix: string): Promise<ObjectSummary[]> {
    const out: ObjectSummary[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (!entry.name.endsWith(CTYPE_SUFFIX)) {
          const key = relative(this.#baseDir, abs).split(sep).join('/');
          if (key.startsWith(prefix)) {
            const s = await stat(abs);
            out.push({ key, size: s.size, lastModified: s.mtime });
          }
        }
      }
    };
    await walk(this.#baseDir);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async head(key: string): Promise<ObjectSummary | null> {
    const abs = this.#resolve(key);
    try {
      const s = await stat(abs);
      return { key, size: s.size, lastModified: s.mtime };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const abs = this.#resolve(key);
    await rm(abs, { force: true });
    await rm(abs + CTYPE_SUFFIX, { force: true });
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    // Deterministic, expiring, signed-URL-only shape (mirrors the S3 provider's contract).
    const expires = Math.floor(this.#now() / 1000) + ttlSeconds;
    return `${this.#publicBaseUrl}/${key}?expires=${expires}`;
  }

  /** Resolve a key under baseDir, refusing any path that escapes it (fail-closed). */
  #resolve(key: string): string {
    if (typeof key !== 'string' || key === '') {
      throw new StorageError('a key is required', 'invalid_key');
    }
    const abs = resolve(this.#baseDir, key);
    if (abs !== this.#baseDir && !abs.startsWith(this.#baseDir + sep)) {
      throw new StorageError(`key escapes storage root: ${key}`, 'invalid_key');
    }
    return abs;
  }

  async #readCtype(abs: string): Promise<string | undefined> {
    try {
      return (await readFile(abs + CTYPE_SUFFIX, 'utf8')).trim() || undefined;
    } catch {
      return undefined;
    }
  }
}
