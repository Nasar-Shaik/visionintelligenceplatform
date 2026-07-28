/**
 * Service configuration — delegates to the shared `@vip/config` groups (no service re-implements
 * env parsing; no code reads `process.env` directly, ADR-0018) and layers on the service version +
 * event tunables. `jwt` verifies inbound control tokens (`/events` reads); `database` is the event
 * store; `nats` is the backbone the consumer/publisher bind to. Fail-fast validation lives in
 * `@vip/config`.
 */
import {
  loadAppConfig,
  loadDatabaseConfig,
  loadJwtConfig,
  loadNatsConfig,
  parseEnv,
  type AppConfig,
  type DatabaseConfig,
  type JwtConfig,
  type NatsConfig,
} from '@vip/config';
import { z } from 'zod';

export interface EventsTuning {
  /** Correlation/dedup window (ms): repeats of the same (type, track/class, zone) collapse within it. */
  dedupWindowMs: number;
  /** Hard ceiling the service enforces on a single replay call, regardless of the request `limit`. */
  replayCeiling: number;
}

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  jwt: JwtConfig;
  database: DatabaseConfig;
  nats: NatsConfig;
  events: EventsTuning;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'events', port: 8084 });
  const jwt = loadJwtConfig(env);
  const database = loadDatabaseConfig(env);
  const nats = loadNatsConfig(env);
  const tuning = parseEnv(
    z.object({
      EVENTS_DEDUP_WINDOW_MS: z.coerce.number().int().min(0).max(3_600_000).default(10_000),
      EVENTS_REPLAY_CEILING: z.coerce.number().int().min(1).max(100_000).default(10_000),
    }),
    env,
    'events',
  );
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  return {
    ...app,
    serviceVersion,
    jwt,
    database,
    nats,
    events: {
      dedupWindowMs: tuning.EVENTS_DEDUP_WINDOW_MS,
      replayCeiling: tuning.EVENTS_REPLAY_CEILING,
    },
  };
}
