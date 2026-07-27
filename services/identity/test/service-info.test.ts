import { describe, expect, it } from 'vitest';
import { buildServiceInfo } from '../src/domain/service-info.js';
import { getServiceInfo } from '../src/application/get-service-info.js';

describe('buildServiceInfo (domain)', () => {
  it('computes uptime in whole seconds', () => {
    const startedAt = new Date('2026-07-27T00:00:00.000Z');
    const now = new Date('2026-07-27T00:00:42.500Z');
    const info = buildServiceInfo({ name: 'identity', version: '0.1.0', startedAt, now });
    expect(info).toEqual({
      name: 'identity',
      version: '0.1.0',
      startedAt: '2026-07-27T00:00:00.000Z',
      uptimeSeconds: 42,
    });
  });

  it('never returns negative uptime for clock skew', () => {
    const startedAt = new Date('2026-07-27T00:00:10.000Z');
    const now = new Date('2026-07-27T00:00:00.000Z');
    expect(buildServiceInfo({ name: 'x', version: '1', startedAt, now }).uptimeSeconds).toBe(0);
  });
});

describe('getServiceInfo (application)', () => {
  it('uses the injected clock', () => {
    const startedAt = new Date('2026-07-27T00:00:00.000Z');
    const info = getServiceInfo({
      name: 'identity',
      version: '9.9.9',
      startedAt,
      now: () => new Date('2026-07-27T00:01:00.000Z'),
    });
    expect(info.uptimeSeconds).toBe(60);
    expect(info.version).toBe('9.9.9');
  });
});
