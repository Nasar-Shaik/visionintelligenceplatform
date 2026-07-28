import { describe, expect, it } from 'vitest';
import { ConfigError } from '@vip/config';
import { loadConfig } from '../src/config/env.js';

const base = {
  MONGO_URI: 'mongodb://localhost:47017/vip_identity',
  JWT_SECRET: 'test-secret-at-least-16-chars',
};

describe('loadConfig (identity, via @vip/config)', () => {
  it('applies identity defaults + loads db/jwt groups', () => {
    const cfg = loadConfig(base);
    expect(cfg.serviceName).toBe('identity');
    expect(cfg.port).toBe(8080);
    expect(cfg.database.uri).toBe('mongodb://localhost:47017/vip_identity');
    expect(cfg.jwt.secret).toBe('test-secret-at-least-16-chars');
    expect(cfg.jwt.accessTtl).toBe('15m');
    expect(cfg.jwt.refreshTtl).toBe('7d');
  });

  it('coerces PORT from string to number', () => {
    expect(loadConfig({ ...base, PORT: '4310' }).port).toBe(4310);
  });

  it('prefers SERVICE_VERSION over npm_package_version', () => {
    expect(
      loadConfig({ ...base, SERVICE_VERSION: '2.0.0', npm_package_version: '1.2.3' })
        .serviceVersion,
    ).toBe('2.0.0');
  });

  it('fails fast when MONGO_URI is missing (database group)', () => {
    const { MONGO_URI, ...noDb } = base;
    void MONGO_URI;
    expect(() => loadConfig(noDb)).toThrow(ConfigError);
  });

  it('fails fast when JWT_SECRET is too short (jwt group)', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(ConfigError);
  });
});
