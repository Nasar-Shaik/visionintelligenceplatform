/**
 * Service configuration — delegates to the shared `@vip/config` groups (no service re-implements
 * env parsing; no code reads `process.env` directly, ADR-0018) and layers on the service version.
 * `jwt` verifies inbound access tokens; `crypto` supplies the secret for credential vaulting.
 * Fail-fast validation happens inside `@vip/config`.
 */
import {
  loadAppConfig,
  loadCryptoConfig,
  loadDatabaseConfig,
  loadInternalConfig,
  loadJwtConfig,
  type AppConfig,
  type CryptoConfig,
  type DatabaseConfig,
  type InternalConfig,
  type JwtConfig,
} from '@vip/config';

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  database: DatabaseConfig;
  jwt: JwtConfig;
  crypto: CryptoConfig;
  /** Shared key authenticating internal service-to-service calls (e.g. media resolving a stream). */
  internal: InternalConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'camera', port: 8080 });
  const database = loadDatabaseConfig(env);
  const jwt = loadJwtConfig(env);
  const crypto = loadCryptoConfig(env);
  const internal = loadInternalConfig(env);
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  return { ...app, serviceVersion, database, jwt, crypto, internal };
}
