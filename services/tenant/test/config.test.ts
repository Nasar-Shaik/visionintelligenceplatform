import { describe, expect, it } from 'vitest';
import { ConfigError } from '@vip/config';
import { loadConfig } from '../src/config/env.js';

const base = {
  NODE_ENV: 'test',
  SERVICE_NAME: 'tenant-test',
  LOG_LEVEL: 'silent',
  MONGO_URI: 'mongodb://localhost:47017/vip_tenant',
};

describe('loadConfig', () => {
  it('loads app + database groups', () => {
    const cfg = loadConfig(base);
    expect(cfg.serviceName).toBe('tenant-test');
    expect(cfg.database.uri).toBe('mongodb://localhost:47017/vip_tenant');
  });

  it('fails fast when MONGO_URI is missing (database group)', () => {
    const { MONGO_URI, ...noDb } = base;
    void MONGO_URI;
    expect(() => loadConfig(noDb)).toThrow(ConfigError);
  });
});
