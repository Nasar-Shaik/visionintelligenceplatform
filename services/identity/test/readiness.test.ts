import { describe, expect, it } from 'vitest';
import { ReadinessRegistry } from '../src/application/readiness.js';

describe('ReadinessRegistry', () => {
  it('reports pass with no checks registered (Phase 0 scaffold)', async () => {
    const report = await new ReadinessRegistry().run();
    expect(report.status).toBe('pass');
    expect(report.checks).toEqual([]);
  });

  it('passes only when every check passes', async () => {
    const reg = new ReadinessRegistry();
    reg.register('mongo', async () => ({ status: 'pass' }));
    reg.register('nats', async () => ({ status: 'pass', detail: 'connected' }));
    const report = await reg.run();
    expect(report.status).toBe('pass');
    expect(report.checks).toHaveLength(2);
  });

  it('fails overall if any check fails', async () => {
    const reg = new ReadinessRegistry();
    reg.register('mongo', async () => ({ status: 'pass' }));
    reg.register('redis', async () => ({ status: 'fail', detail: 'timeout' }));
    const report = await reg.run();
    expect(report.status).toBe('fail');
    expect(report.checks.find((c) => c.name === 'redis')?.detail).toBe('timeout');
  });

  it('treats a thrown check as a failure, not a crash', async () => {
    const reg = new ReadinessRegistry();
    reg.register('flaky', async () => {
      throw new Error('boom');
    });
    const report = await reg.run();
    expect(report.status).toBe('fail');
    expect(report.checks[0]?.detail).toBe('boom');
  });
});
