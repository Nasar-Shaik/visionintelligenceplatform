import { describe, expect, it } from 'vitest';
import { resolveEffectiveConfig, type ConfigNode } from '../src/config/hierarchy.js';

describe('resolveEffectiveConfig', () => {
  it('most-specific level wins (sparse override)', () => {
    const chain: ConfigNode[] = [
      { level: 'global', nodeId: '*', values: { retentionDays: 7, fps: 10 }, lockedKeys: [], version: 0 },
      { level: 'tenant', nodeId: 't1', values: { retentionDays: 30 }, lockedKeys: [], version: 0 },
      { level: 'camera', nodeId: 'cam1', values: { fps: 5 }, lockedKeys: [], version: 0 },
    ];
    const eff = resolveEffectiveConfig(chain);
    expect(eff.retentionDays.value).toBe(30);
    expect(eff.retentionDays.source).toBe('tenant');
    expect(eff.fps.value).toBe(5);
    expect(eff.fps.source).toBe('camera');
  });

  it('a locked ancestor key cannot be overridden by descendants', () => {
    const chain: ConfigNode[] = [
      { level: 'platform', nodeId: '*', values: { minRetentionDays: 30 }, lockedKeys: ['minRetentionDays'], version: 0 },
      { level: 'camera', nodeId: 'cam1', values: { minRetentionDays: 1 }, lockedKeys: [], version: 0 },
    ];
    const eff = resolveEffectiveConfig(chain);
    expect(eff.minRetentionDays.value).toBe(30);
    expect(eff.minRetentionDays.source).toBe('platform');
    expect(eff.minRetentionDays.locked).toBe(true);
  });

  it('resolves independent of input order (sorted by precedence)', () => {
    const chain: ConfigNode[] = [
      { level: 'camera', nodeId: 'cam1', values: { fps: 5 }, lockedKeys: [], version: 0 },
      { level: 'global', nodeId: '*', values: { fps: 10 }, lockedKeys: [], version: 0 },
    ];
    expect(resolveEffectiveConfig(chain).fps.value).toBe(5);
  });
});
