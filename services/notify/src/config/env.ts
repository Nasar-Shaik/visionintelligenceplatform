/**
 * Service configuration — delegates to the shared `@vip/config` groups (ADR-0018) and layers on the
 * service version + the webhook delivery timeout. `jwt` verifies inbound control tokens (`/notification-
 * channels`, `/notifications`); `database` is the channel + delivery-log store; `nats` is the backbone
 * (consume `incident.raised`, publish `notification.*`).
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

export interface NotifyTuning {
  /** Per-attempt webhook delivery timeout (ms). */
  webhookTimeoutMs: number;
}

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  jwt: JwtConfig;
  database: DatabaseConfig;
  nats: NatsConfig;
  notify: NotifyTuning;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'notify', port: 8088 });
  const jwt = loadJwtConfig(env);
  const database = loadDatabaseConfig(env);
  const nats = loadNatsConfig(env);
  const tuning = parseEnv(
    z.object({
      NOTIFY_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    }),
    env,
    'notify',
  );
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  return {
    ...app,
    serviceVersion,
    jwt,
    database,
    nats,
    notify: { webhookTimeoutMs: tuning.NOTIFY_WEBHOOK_TIMEOUT_MS },
  };
}
