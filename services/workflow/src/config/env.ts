/**
 * Service configuration — delegates to the shared `@vip/config` groups (no service re-implements env
 * parsing; no code reads `process.env` directly, ADR-0018) and layers on the service version. `jwt`
 * verifies inbound control tokens (`/incidents` transitions); `database` is the incident store;
 * `nats` is the backbone (consume `incident.candidate`, publish `incident.*`).
 */
import {
  loadAppConfig,
  loadDatabaseConfig,
  loadJwtConfig,
  loadNatsConfig,
  type AppConfig,
  type DatabaseConfig,
  type JwtConfig,
  type NatsConfig,
} from '@vip/config';

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  jwt: JwtConfig;
  database: DatabaseConfig;
  nats: NatsConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'workflow', port: 8087 });
  const jwt = loadJwtConfig(env);
  const database = loadDatabaseConfig(env);
  const nats = loadNatsConfig(env);
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  return { ...app, serviceVersion, jwt, database, nats };
}
