/**
 * Service configuration — delegates to the shared `@vip/config` groups (no service re-implements
 * env parsing; no code reads `process.env` directly, ADR-0018) and layers on the service version +
 * ingestion tunables. `jwt` verifies inbound control tokens; `storage` is the recordings store;
 * `internal` authenticates the camera credential-resolve call. Fail-fast validation lives in
 * `@vip/config`.
 */
import {
  loadAppConfig,
  loadInternalConfig,
  loadJwtConfig,
  loadStorageConfig,
  parseEnv,
  type AppConfig,
  type InternalConfig,
  type JwtConfig,
  type StorageConfig,
} from '@vip/config';
import { z } from 'zod';

export interface IngestionConfig {
  /** Base URL of the camera service (internal resolve endpoint). */
  cameraUrl: string;
  /** Frame-extraction rate handed to perception (fps). */
  frameRate: number;
  /** Recording segment length (seconds). */
  segmentSeconds: number;
  /** ffmpeg binary name/path. */
  ffmpegBinary: string;
}

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  jwt: JwtConfig;
  storage: StorageConfig;
  internal: InternalConfig;
  ingestion: IngestionConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'media', port: 8083 });
  const jwt = loadJwtConfig(env);
  const storage = loadStorageConfig(env);
  const internal = loadInternalConfig(env);
  const ing = parseEnv(
    z.object({
      CAMERA_URL: z.url().default('http://localhost:8082'),
      MEDIA_FRAME_RATE: z.coerce.number().int().min(1).max(60).default(2),
      MEDIA_SEGMENT_SECONDS: z.coerce.number().int().min(1).max(3600).default(6),
      FFMPEG_BINARY: z.string().min(1).default('ffmpeg'),
    }),
    env,
    'ingestion',
  );
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  return {
    ...app,
    serviceVersion,
    jwt,
    storage,
    internal,
    ingestion: {
      cameraUrl: ing.CAMERA_URL,
      frameRate: ing.MEDIA_FRAME_RATE,
      segmentSeconds: ing.MEDIA_SEGMENT_SECONDS,
      ffmpegBinary: ing.FFMPEG_BINARY,
    },
  };
}
