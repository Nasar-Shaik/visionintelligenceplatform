/** Object storage (S3-compatible, e.g. MinIO) configuration group. */
import { z } from 'zod';
import { parseEnv } from './validate.js';

export interface StorageConfig {
  /** Endpoint services use to reach object storage. Container-internal in a deployment. */
  endpoint: string;
  /**
   * Endpoint that browser-facing signed URLs are signed against; defaults to {@link endpoint}.
   *
   * ⚠️ Set this whenever the browser and the services reach object storage by different names —
   * which is every containerised deployment. Left unset there, playback URLs point at the internal
   * hostname and no operator's browser can resolve them (see `S3ObjectStore.publicEndpoint`).
   */
  publicEndpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Bucket for ingested recordings/media (P1-4). */
  recordingsBucket: string;
  /** Path-style addressing (true for MinIO; false for AWS virtual-host buckets). */
  forcePathStyle: boolean;
}

export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const c = parseEnv(
    z.object({
      S3_ENDPOINT: z.string().min(1),
      // Optional: unset means "the browser reaches storage the same way we do" (dev, or a
      // deployment where object storage is genuinely on one public name).
      S3_PUBLIC_ENDPOINT: z.string().min(1).optional(),
      AWS_ACCESS_KEY_ID: z.string().min(1),
      AWS_SECRET_ACCESS_KEY: z.string().min(1),
      S3_REGION: z.string().min(1).default('us-east-1'),
      S3_RECORDINGS_BUCKET: z.string().min(1).default('vip-recordings'),
      S3_FORCE_PATH_STYLE: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
    }),
    env,
    'storage',
  );
  return {
    endpoint: c.S3_ENDPOINT,
    publicEndpoint: c.S3_PUBLIC_ENDPOINT ?? c.S3_ENDPOINT,
    accessKeyId: c.AWS_ACCESS_KEY_ID,
    secretAccessKey: c.AWS_SECRET_ACCESS_KEY,
    region: c.S3_REGION,
    recordingsBucket: c.S3_RECORDINGS_BUCKET,
    forcePathStyle: c.S3_FORCE_PATH_STYLE,
  };
}
