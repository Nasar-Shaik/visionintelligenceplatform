import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

describe('loadConfig', () => {
  it('applies defaults for an empty environment', () => {
    const cfg = loadConfig({});
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.SERVICE_NAME).toBe('identity');
    expect(cfg.PORT).toBe(8080);
    expect(cfg.HOST).toBe('0.0.0.0');
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT from string to number', () => {
    expect(loadConfig({ PORT: '4310' }).PORT).toBe(4310);
  });

  it('prefers npm_package_version for SERVICE_VERSION', () => {
    expect(loadConfig({ npm_package_version: '1.2.3' }).SERVICE_VERSION).toBe('1.2.3');
    expect(
      loadConfig({ SERVICE_VERSION: '2.0.0', npm_package_version: '1.2.3' }).SERVICE_VERSION,
    ).toBe('2.0.0');
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow();
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow();
  });
});
