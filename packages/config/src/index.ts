/**
 * @vip/config — centralized, typed, fail-fast configuration.
 *
 * `.env` is the ONLY secrets source (ADR-0018); no external secret manager is required
 * or integrated. Configuration is grouped by concern; a service imports only the groups
 * it needs, and each group validates its own keys and fails fast with a clear message.
 * No business logic should ever read `process.env` directly — go through a group loader.
 *
 * Usage:
 *   import { loadDotEnv, loadAppConfig, loadDatabaseConfig } from '@vip/config';
 *   loadDotEnv();                       // once, at process start
 *   const app = loadAppConfig(process.env, { serviceName: 'identity' });
 */
export { loadDotEnv } from './env.js';
export { ConfigError, parseEnv } from './validate.js';

export { loadAppConfig } from './app.js';
export type { AppConfig, AppDefaults, NodeEnv, LogLevel } from './app.js';

export { loadDatabaseConfig } from './database.js';
export type { DatabaseConfig } from './database.js';

export { loadRedisConfig } from './redis.js';
export type { RedisConfig } from './redis.js';

export { loadNatsConfig } from './nats.js';
export type { NatsConfig } from './nats.js';

export { loadStorageConfig } from './storage.js';
export type { StorageConfig } from './storage.js';

export { loadAiConfig } from './ai.js';
export type { AiConfig } from './ai.js';

export { loadJwtConfig } from './jwt.js';
export type { JwtConfig } from './jwt.js';

export { loadCryptoConfig } from './crypto.js';
export type { CryptoConfig } from './crypto.js';

export { loadInternalConfig } from './internal.js';
export type { InternalConfig } from './internal.js';

/** Package version — bump per Constitution §7. */
export const CONFIG_VERSION = '0.1.0';
