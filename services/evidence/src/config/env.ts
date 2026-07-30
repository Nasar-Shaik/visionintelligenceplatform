/**
 * Service configuration — delegates to the shared `@vip/config` groups (no service re-implements env
 * parsing; nothing reads `process.env` directly, ADR-0018) and layers on evidence tunables. `jwt`
 * verifies inbound access tokens; `storage` + the provider selector back the evidence object store;
 * `database` holds the manifest + custody log; `nats` is the backbone (consume `incident.raised`,
 * publish `evidence.*`). Fail-fast validation lives in `@vip/config`.
 */
import {
  loadAppConfig,
  loadDatabaseConfig,
  loadJwtConfig,
  loadNatsConfig,
  loadStorageConfig,
  parseEnv,
  type AppConfig,
  type DatabaseConfig,
  type JwtConfig,
  type NatsConfig,
  type StorageConfig,
} from '@vip/config';
import { z } from 'zod';

/** Which StorageProvider backs evidence bytes — switch by config, never code (Architect rec 3). */
export type StorageProviderKind = 'local' | 's3';

export interface EvidenceTuning {
  /** StorageProvider selection: `local` (filesystem, dev/test) or `s3` (MinIO/S3, prod). */
  storageProvider: StorageProviderKind;
  /** Base dir for the `local` provider. */
  localDir: string;
  /** Public base URL the `local` provider builds signed GETs against. */
  localPublicBaseUrl: string;
  /** Signed download/playback URL lifetime (seconds). */
  downloadTtlSeconds: number;
  /** Default retention window (days) applied when a registration omits `retainDays`; 0 = indefinite. */
  defaultRetentionDays: number;
  /** Whether the incident.raised → auto-register consumer runs. */
  consumeIncidents: boolean;
}

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  jwt: JwtConfig;
  storage: StorageConfig;
  database: DatabaseConfig;
  nats: NatsConfig;
  evidence: EvidenceTuning;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'evidence', port: 8090 });
  const jwt = loadJwtConfig(env);
  const storage = loadStorageConfig(env);
  const database = loadDatabaseConfig(env);
  const nats = loadNatsConfig(env);
  const tuning = parseEnv(
    z.object({
      EVIDENCE_STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
      EVIDENCE_LOCAL_DIR: z.string().min(1).default('.data/evidence'),
      EVIDENCE_LOCAL_PUBLIC_BASE_URL: z.url().default('http://localhost:8090/evidence-blobs'),
      EVIDENCE_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),
      EVIDENCE_DEFAULT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
      EVIDENCE_CONSUME_INCIDENTS: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
    }),
    env,
    'evidence',
  );
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  return {
    ...app,
    serviceVersion,
    jwt,
    storage,
    database,
    nats,
    evidence: {
      storageProvider: tuning.EVIDENCE_STORAGE_PROVIDER,
      localDir: tuning.EVIDENCE_LOCAL_DIR,
      localPublicBaseUrl: tuning.EVIDENCE_LOCAL_PUBLIC_BASE_URL,
      downloadTtlSeconds: tuning.EVIDENCE_DOWNLOAD_TTL_SECONDS,
      defaultRetentionDays: tuning.EVIDENCE_DEFAULT_RETENTION_DAYS,
      consumeIncidents: tuning.EVIDENCE_CONSUME_INCIDENTS,
    },
  };
}
