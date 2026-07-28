import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/validate.js';
import { loadDatabaseConfig } from '../src/database.js';
import { loadRedisConfig } from '../src/redis.js';
import { loadNatsConfig } from '../src/nats.js';
import { loadStorageConfig } from '../src/storage.js';
import { loadAiConfig } from '../src/ai.js';
import { loadJwtConfig } from '../src/jwt.js';
import { loadCryptoConfig } from '../src/crypto.js';

describe('infrastructure config groups', () => {
  it('database: maps MONGO_URI → uri', () => {
    expect(loadDatabaseConfig({ MONGO_URI: 'mongodb://h/db' }).uri).toBe('mongodb://h/db');
  });

  it('redis: maps REDIS_URL → url', () => {
    expect(loadRedisConfig({ REDIS_URL: 'redis://h:6379' }).url).toBe('redis://h:6379');
  });

  it('nats: maps NATS_URL → url', () => {
    expect(loadNatsConfig({ NATS_URL: 'nats://h:4222' }).url).toBe('nats://h:4222');
  });

  it('storage: maps S3 endpoint + credentials', () => {
    const c = loadStorageConfig({
      S3_ENDPOINT: 'http://h:9000',
      AWS_ACCESS_KEY_ID: 'k',
      AWS_SECRET_ACCESS_KEY: 's',
    });
    expect(c).toEqual({ endpoint: 'http://h:9000', accessKeyId: 'k', secretAccessKey: 's' });
  });

  it('ai: MLflow tracking uri + default artifacts bucket', () => {
    const c = loadAiConfig({ MLFLOW_TRACKING_URI: 'http://h:45000' });
    expect(c.mlflowTrackingUri).toBe('http://h:45000');
    expect(c.artifactsBucket).toBe('mlflow-artifacts');
  });

  it('jwt: requires a sufficiently long secret; applies TTL defaults', () => {
    const c = loadJwtConfig({ JWT_SECRET: 'x'.repeat(16) });
    expect(c.accessTtl).toBe('15m');
    expect(c.refreshTtl).toBe('7d');
  });

  it('crypto: maps CREDENTIAL_ENCRYPTION_KEY → encryptionKey', () => {
    const c = loadCryptoConfig({ CREDENTIAL_ENCRYPTION_KEY: 'x'.repeat(16) });
    expect(c.encryptionKey).toBe('x'.repeat(16));
  });

  it('each group fails fast when its required key is missing', () => {
    expect(() => loadDatabaseConfig({})).toThrow(ConfigError);
    expect(() => loadRedisConfig({})).toThrow(ConfigError);
    expect(() => loadNatsConfig({})).toThrow(ConfigError);
    expect(() => loadStorageConfig({})).toThrow(ConfigError);
    expect(() => loadAiConfig({})).toThrow(ConfigError);
    expect(() => loadJwtConfig({ JWT_SECRET: 'too-short' })).toThrow(ConfigError);
    expect(() => loadCryptoConfig({ CREDENTIAL_ENCRYPTION_KEY: 'short' })).toThrow(ConfigError);
  });
});
