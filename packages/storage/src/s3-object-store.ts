/**
 * S3/MinIO adapter for {@link ObjectStore}, built on the AWS SDK v3 (pure-JS, no native build).
 * MinIO is S3-compatible; `forcePathStyle` is on by default so `http://host:9000/bucket/key`
 * addressing works (MinIO doesn't do virtual-host buckets). Credentials + endpoint come from
 * `@vip/config` (`.env`, ADR-0018). This is the ONLY module that talks to the S3 protocol.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  HeadBucketCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectBody, ObjectStore, ObjectSummary, PutObjectInput } from './object-store.js';
import { StorageError } from './errors.js';

export interface S3ObjectStoreOptions {
  /** Endpoint this *process* uses to reach object storage (server-side get/put/head/list). */
  endpoint: string;
  /**
   * Endpoint to sign **browser-facing** URLs against. Defaults to `endpoint`.
   *
   * ⚠️ Added in P-5.8 because presigned playback was broken in every containerised deployment, and
   * the failure was invisible until the stack was actually deployed. A service reaches MinIO at
   * `http://minio:9000` — a name that resolves on the container network and nowhere else — so every
   * URL handed to an operator's browser pointed at a host it could not look up, over plaintext,
   * from an HTTPS page. Development never showed it: there, browser and service both say
   * `localhost:49000`, so one endpoint appeared to be enough.
   *
   * ⚠️ Signing against a different host is safe **only** because SigV4 covers the `Host` header.
   * The signature is computed for the public name, so the object store validates it against the
   * name the browser actually used — provided the reverse proxy forwards `Host` unchanged (Caddy
   * does by default; nginx needs `proxy_set_header Host $host`). Get that wrong and every URL is
   * rejected as unauthorised, which is the correct failure: the proxy gains reach, never authority.
   */
  publicEndpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
  /** MinIO / path-style addressing (default true). Set false for AWS virtual-host style. */
  forcePathStyle?: boolean;
  /** Per-request timeout (ms). Useful to fail fast against an unreachable endpoint. */
  requestTimeoutMs?: number;
}

/**
 * ⚠️ `requestChecksumCalculation` is honoured at runtime by `@aws-sdk/client-s3` 3.1096 but is not
 * in its exported config type. Declared here rather than cast away at the call site, so the reason
 * it is being passed survives the next SDK bump.
 */
type PresignClientConfig = S3ClientConfig & {
  requestChecksumCalculation?: 'WHEN_SUPPORTED' | 'WHEN_REQUIRED';
};

export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  /** Signs browser-facing URLs. Same credentials, different endpoint; never sends a request. */
  readonly #signer: S3Client;
  /**
   * Signs browser-facing **PUT** URLs. A third client, for one measured reason.
   *
   * ⚠️ By default the SDK hoists `x-amz-checksum-crc32=AAAAAA%3D%3D` — the CRC32 of an **empty**
   * payload — into the signed query string of a presigned PUT. MinIO accepts it (measured: 200 OK
   * with a non-empty body), so this is not a live defect here; but it is a signed assertion about
   * the bytes that is false for every upload, and an S3 implementation that validates it would
   * reject every one. `WHEN_REQUIRED` removes the parameter instead of relying on a server to
   * ignore it.
   *
   * ⛔ It is a **separate client** so that `put()` and `presignGet()` are byte-for-byte unchanged.
   * `presignGet` is verified against a deployment (ADR-0036: 206 on a range, 403 on tamper, expiry
   * enforced) and recording is the contractual obligation — neither changes to fix an upload path.
   */
  readonly #putSigner: S3Client;
  readonly #bucket: string;

  constructor(opts: S3ObjectStoreOptions) {
    const config: S3ClientConfig = {
      endpoint: opts.endpoint,
      region: opts.region ?? 'us-east-1',
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      forcePathStyle: opts.forcePathStyle ?? true,
      ...(opts.requestTimeoutMs !== undefined
        ? {
            requestHandler: {
              requestTimeout: opts.requestTimeoutMs,
              connectionTimeout: opts.requestTimeoutMs,
            },
          }
        : {}),
    };
    this.#client = new S3Client(config);
    // A second client only when the public name differs — otherwise reuse, so the default path
    // allocates nothing extra and behaves exactly as it did before.
    this.#signer =
      opts.publicEndpoint === undefined || opts.publicEndpoint === opts.endpoint
        ? this.#client
        : new S3Client({ ...config, endpoint: opts.publicEndpoint });
    const putConfig: PresignClientConfig = {
      ...config,
      endpoint: opts.publicEndpoint ?? opts.endpoint,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    };
    this.#putSigner = new S3Client(putConfig);
    this.#bucket = opts.bucket;
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: input.key,
        Body: input.body,
        ...(input.contentType ? { ContentType: input.contentType } : {}),
      }),
    );
  }

  async get(key: string): Promise<ObjectBody> {
    const res = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    if (!res.Body) throw new StorageError(`empty body for ${key}`);
    // SDK v3 Node stream exposes transformToByteArray().
    const body = await res.Body.transformToByteArray();
    return {
      body,
      ...(res.ContentType ? { contentType: res.ContentType } : {}),
      ...(res.ContentLength !== undefined ? { contentLength: res.ContentLength } : {}),
    };
  }

  async list(prefix: string): Promise<ObjectSummary[]> {
    const out: ObjectSummary[] = [];
    let token: string | undefined;
    do {
      const res = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key === undefined) continue;
        out.push({
          key: o.Key,
          size: o.Size ?? 0,
          ...(o.LastModified ? { lastModified: o.LastModified } : {}),
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async head(key: string): Promise<ObjectSummary | null> {
    try {
      const res = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return {
        key,
        size: res.ContentLength ?? 0,
        ...(res.LastModified ? { lastModified: res.LastModified } : {}),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  /** Signed with `#signer`, so the URL carries the name the *browser* can reach. */
  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.#signer, new GetObjectCommand({ Bucket: this.#bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  /**
   * Signed against the public endpoint for the same reason `presignGet` is — the browser performs
   * this PUT.
   *
   * ⭐ **`signableHeaders` is what makes the content type mean anything, and leaving it out is a
   * silent hole.** Measured against MinIO before this was written: with `ContentType` set on the
   * command and nothing else, the SDK emits `X-Amz-SignedHeaders=host` and **drops the content type
   * entirely** — two URLs signed for `video/mp4` and `application/zip` came out byte-identical, and
   * a presigned "video upload" URL would have accepted an executable. Forcing `content-type` into
   * the signed set makes the signature cover it: a mismatched upload is
   * **`403 SignatureDoesNotMatch`**, measured against a real MinIO, which is the correct failure.
   *
   * ⛔ **This still does not make the object a video.** Presigning says where bytes may land, never
   * what they are; the content type is what the uploader *declared*, and the store enforces only
   * that they declare the same thing twice. Nothing is trusted until it has been probed.
   */
  async presignPut(key: string, ttlSeconds: number, contentType: string): Promise<string> {
    return getSignedUrl(
      this.#putSigner,
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, ContentType: contentType }),
      { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type']) },
    );
  }

  /** Readiness probe: the bucket is reachable + accessible. */
  async ping(): Promise<void> {
    await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
  }

  /** Create the bucket if it doesn't already exist (idempotent). For bootstrap/tests. */
  async ensureBucket(): Promise<void> {
    try {
      await this.#client.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const meta = err as { $metadata?: { httpStatusCode?: number }; name?: string };
  return meta.$metadata?.httpStatusCode === 404 || meta.name === 'NotFound';
}
