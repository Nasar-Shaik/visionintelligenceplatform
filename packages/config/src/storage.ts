/** Object storage (S3-compatible, e.g. MinIO) configuration group. */
import { z } from 'zod';
import { parseEnv } from './validate.js';

export interface StorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const c = parseEnv(
    z.object({
      S3_ENDPOINT: z.string().min(1),
      AWS_ACCESS_KEY_ID: z.string().min(1),
      AWS_SECRET_ACCESS_KEY: z.string().min(1),
    }),
    env,
    'storage',
  );
  return {
    endpoint: c.S3_ENDPOINT,
    accessKeyId: c.AWS_ACCESS_KEY_ID,
    secretAccessKey: c.AWS_SECRET_ACCESS_KEY,
  };
}
