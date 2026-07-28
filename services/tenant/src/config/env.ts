/**
 * Service configuration — delegates to the shared `@vip/config` groups (no service
 * re-implements env parsing; no code reads `process.env` directly, ADR-0018) and layers
 * on the service version. Fail-fast validation happens inside `@vip/config`.
 */
import {
  loadAppConfig,
  loadDatabaseConfig,
  type AppConfig,
  type DatabaseConfig,
} from '@vip/config';

export interface ServiceConfig extends AppConfig {
  /** Semantic version, injected by the package manager at runtime when present. */
  serviceVersion: string;
  database: DatabaseConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'tenant', port: 8080 });
  const database = loadDatabaseConfig(env);
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  return { ...app, serviceVersion, database };
}
