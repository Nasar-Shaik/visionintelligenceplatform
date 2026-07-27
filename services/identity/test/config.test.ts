import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

describe('loadConfig (identity, via @vip/config)', () => {
  it('applies identity defaults for an empty environment', () => {
    const cfg = loadConfig({});
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.serviceName).toBe('identity');
    expect(cfg.port).toBe(8080);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.logLevel).toBe('info');
  });

  it('coerces PORT from string to number', () => {
    expect(loadConfig({ PORT: '4310' }).port).toBe(4310);
  });

  it('prefers SERVICE_VERSION, then npm_package_version', () => {
    expect(loadConfig({ npm_package_version: '1.2.3' }).serviceVersion).toBe('1.2.3');
    expect(
      loadConfig({ SERVICE_VERSION: '2.0.0', npm_package_version: '1.2.3' }).serviceVersion,
    ).toBe('2.0.0');
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow();
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow();
  });
});
