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
  endpoint: string;
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

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.#client, new GetObjectCommand({ Bucket: this.#bucket, Key: key }), {
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
