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

export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  /** Signs browser-facing URLs. Same credentials, different endpoint; never sends a request. */
  readonly #signer: S3Client;
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
