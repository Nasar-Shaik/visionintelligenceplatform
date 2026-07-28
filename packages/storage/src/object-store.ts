/**
 * The low-level object-store port (untenanted). Adapters (S3/MinIO) implement it; the
 * tenant-isolation wrapper ({@link TenantObjectStore}) sits ON TOP so no service ever calls a
 * raw store with a hand-built, un-prefixed key. Keys are opaque strings; the wrapper owns the
 * `{tenantId}/…` prefix convention (STORAGE_ARCHITECTURE.md).
 */

export interface PutObjectInput {
  key: string;
  body: Uint8Array | Buffer | string;
  contentType?: string;
}

export interface ObjectSummary {
  key: string;
  size: number;
  lastModified?: Date;
}

export interface ObjectBody {
  body: Uint8Array;
  contentType?: string;
  contentLength?: number;
}

export interface ObjectStore {
  put(input: PutObjectInput): Promise<void>;
  get(key: string): Promise<ObjectBody>;
  /** List objects under a full key prefix (returns fully-qualified keys). */
  list(prefix: string): Promise<ObjectSummary[]>;
  head(key: string): Promise<ObjectSummary | null>;
  delete(key: string): Promise<void>;
  /** A short-lived pre-signed GET URL (media access is signed-URL only — never public). */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
}
