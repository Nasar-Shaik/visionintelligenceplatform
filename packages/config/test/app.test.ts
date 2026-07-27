import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/validate.js';
import { loadAppConfig } from '../src/app.js';

describe('loadAppConfig', () => {
  it('applies defaults on an empty environment', () => {
    const c = loadAppConfig({});
    expect(c).toEqual({
      nodeEnv: 'development',
      serviceName: 'service',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'info',
    });
  });

  it('honours per-service defaults', () => {
    const c = loadAppConfig({}, { serviceName: 'identity', port: 8081 });
    expect(c.serviceName).toBe('identity');
    expect(c.port).toBe(8081);
  });

  it('env overrides win over defaults and coerces PORT', () => {
    const c = loadAppConfig({ SERVICE_NAME: 'x', PORT: '4310' }, { serviceName: 'identity' });
    expect(c.serviceName).toBe('x');
    expect(c.port).toBe(4310);
  });

  it('throws ConfigError on an out-of-range PORT', () => {
    expect(() => loadAppConfig({ PORT: '70000' })).toThrow(ConfigError);
  });

  it('throws ConfigError on an invalid NODE_ENV', () => {
    expect(() => loadAppConfig({ NODE_ENV: 'staging' })).toThrow(ConfigError);
  });
});
