/**
 * Service configuration — delegates to the shared `@vip/config` groups (no service re-implements
 * env parsing; no code reads `process.env` directly, ADR-0018) and layers on the service version +
 * ingestion tunables. `jwt` verifies inbound control tokens; `storage` is the recordings store;
 * `internal` authenticates the camera credential-resolve call. Fail-fast validation lives in
 * `@vip/config`.
 */
import {
  loadAppConfig,
  loadDatabaseConfig,
  loadInternalConfig,
  loadJwtConfig,
  loadStorageConfig,
  parseEnv,
  type AppConfig,
  type DatabaseConfig,
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

/**
 * Where extracted frames go (P-8 Phase 2). ⚠️ **An empty `url` keeps the null sink**, which is the
 * behaviour every deployment had before this phase — so a deployment that does not configure
 * perception is unchanged rather than broken, and turning it on is one variable.
 */
export interface PerceptionConfig {
  url: string;
  capabilityId: string;
  queuePerCamera: number;
  maxInflight: number;
  timeoutMs: number;
}

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  jwt: JwtConfig;
  storage: StorageConfig;
  database: DatabaseConfig;
  internal: InternalConfig;
  ingestion: IngestionConfig;
  perception: PerceptionConfig;
  /** Signed playback-URL lifetime (seconds). */
  playbackTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'media', port: 8083 });
  const jwt = loadJwtConfig(env);
  const storage = loadStorageConfig(env);
  const database = loadDatabaseConfig(env);
  const internal = loadInternalConfig(env);
  const ing = parseEnv(
    z.object({
      CAMERA_URL: z.url().default('http://localhost:8082'),
      MEDIA_FRAME_RATE: z.coerce.number().int().min(1).max(60).default(2),
      MEDIA_SEGMENT_SECONDS: z.coerce.number().int().min(1).max(3600).default(6),
      FFMPEG_BINARY: z.string().min(1).default('ffmpeg'),
      MEDIA_PLAYBACK_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),
      // ⚠️ Blank by default: no URL, no perception, and the deployment behaves exactly as before.
      INFERENCE_URL: z.string().default(''),
      INFERENCE_CAPABILITY_ID: z.string().min(1).default('perception.person-detection'),
      MEDIA_FRAME_QUEUE_PER_CAMERA: z.coerce.number().int().min(1).max(64).default(2),
      MEDIA_FRAME_MAX_INFLIGHT: z.coerce.number().int().min(1).max(64).default(4),
      MEDIA_FRAME_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
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
    database,
    internal,
    ingestion: {
      cameraUrl: ing.CAMERA_URL,
      frameRate: ing.MEDIA_FRAME_RATE,
      segmentSeconds: ing.MEDIA_SEGMENT_SECONDS,
      ffmpegBinary: ing.FFMPEG_BINARY,
    },
    perception: {
      url: ing.INFERENCE_URL.trim(),
      capabilityId: ing.INFERENCE_CAPABILITY_ID,
      queuePerCamera: ing.MEDIA_FRAME_QUEUE_PER_CAMERA,
      maxInflight: ing.MEDIA_FRAME_MAX_INFLIGHT,
      timeoutMs: ing.MEDIA_FRAME_TIMEOUT_MS,
    },
    playbackTtlSeconds: ing.MEDIA_PLAYBACK_TTL_SECONDS,
  };
}
