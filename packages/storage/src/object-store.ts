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
  /**
   * A short-lived pre-signed GET URL **for a browser** (media access is signed-URL only — never
   * public).
   *
   * ⚠️ It carries the object store's *public* endpoint, which is the name a browser can resolve. A
   * process running inside the compose network cannot reach it — see {@link presignInternalGet}.
   */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  /**
   * A short-lived pre-signed GET URL **for a server-side consumer** — ffprobe, ffmpeg, anything
   * inside the deployment (P-8 Phase 8, slice 3).
   *
   * ### ⛔ Why this is a separate method rather than a flag
   *
   * This was a real, deployed defect and it is worth stating plainly. `presignGet` signs against the
   * *public* endpoint, because a browser has to resolve the host — so under the deployment's own
   * configuration it returns `https://localhost/...`. Handed to `ffprobe` **inside the media
   * container**, `localhost:443` is the container itself, and the measured result was:
   *
   * ```
   * Connection to tcp://localhost:443 failed: Connection refused
   * ```
   *
   * Confirming an uploaded recording therefore failed in every real deployment while passing every
   * unit test, because the tests supplied a fake probe. ⭐ The two audiences have genuinely different
   * failure modes — a browser fails on DNS or CORS, a container fails on connection-refused — so
   * they get different methods. A boolean parameter would be one more thing to get right at each
   * call site, and the wrong value produces a URL that looks perfectly valid.
   *
   * ⚠️ Same signature, same expiry semantics, same tenant scoping. **Only the host differs.**
   */
  presignInternalGet(key: string, ttlSeconds: number): Promise<string>;
  /**
   * A short-lived pre-signed **PUT** URL, scoped to exactly one key and one content type
   * (P-8 Phase 8, offline video upload).
   *
   * ⚠️ **The write counterpart of `presignGet`, and it grants strictly more**, so three properties
   * are not optional:
   *
   * 1. **One key.** The signature covers the key, so a caller handed a URL for
   *    `t/{tenant}/analyses/{id}/source.mp4` cannot write anywhere else — including another tenant's
   *    prefix, which is why {@link TenantObjectStore} is the only thing that should build one.
   * 2. **One content type.** ⚠️ **Only because the implementation forces it into the signed header
   *    set.** Setting a content type on the request is *not* enough — measured on
   *    `@aws-sdk/client-s3` 3.1096, a presigned PUT signs `host` alone and drops the content type,
   *    so two URLs issued for `video/mp4` and `application/zip` are byte-identical. An
   *    implementation of this port that does not sign it is offering "somewhere to put anything"
   *    while appearing to offer "somewhere to put a video".
   * 3. **Short-lived.** The URL is the credential; there is no second check at write time.
   *
   * ⛔ **Presigning a PUT is not a validation.** It says where bytes may land, never what they are —
   * the object is untrusted until the service has probed it. See `AnalysisAsset`, every field of
   * which is measured rather than believed.
   */
  presignPut(key: string, ttlSeconds: number, contentType: string): Promise<string>;
}
