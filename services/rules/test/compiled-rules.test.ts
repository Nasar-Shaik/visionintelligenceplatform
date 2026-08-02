/**
 * The compiled rule set (P-4, Architect rec 12).
 *
 * What these protect is a **cost**, not a behaviour: the engine used to issue a `listEnabled` query
 * per event ([TD-7]). A test asserting the right incidents come out would pass either way, so these
 * count the queries instead.
 */
import { describe, expect, it } from 'vitest';
import type { Rule } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { RuleSetCache } from '../src/application/compiled-rules.js';
import type { RuleStore } from '../src/application/ports.js';

const scopeA = TenantScope.fromTenantId('tnt_a');
const scopeB = TenantScope.fromTenantId('tnt_b');

function rule(id: string, priority = 100): Rule {
  return {
    id,
    tenantId: 'tnt_a',
    name: id,
    lifecycle: 'enabled',
    priority,
    version: 1,
    eventTypes: [],
    categories: [],
    severity: 'high',
    actions: [{ type: 'raise-incident' }],
    scope: { nodeIds: [], cameraIds: [] },
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  };
}

/** A store that counts how often the engine actually asks it anything. */
function countingStore(rules: Rule[] = [rule('a')]) {
  let calls = 0;
  const store = {
    async listEnabled() {
      calls += 1;
      return rules;
    },
  } as unknown as RuleStore;
  return { store, calls: () => calls, setRules: (next: Rule[]) => (rules = next) };
}

describe('RuleSetCache', () => {
  it('queries the store once and serves every later event from memory', async () => {
    const { store, calls } = countingStore();
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 100, ttlMs: 60_000 });

    for (let i = 0; i < 1_000; i += 1) await cache.get(scopeA);

    // The regression this exists to prevent: 1,000 events used to mean 1,000 queries.
    expect(calls()).toBe(1);
  });

  it('coalesces a burst of concurrent misses into one query', async () => {
    const { store, calls } = countingStore();
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 100, ttlMs: 60_000 });

    // A cold tenant hit by 100 events at once — the worst moment to issue 100 queries.
    await Promise.all(Array.from({ length: 100 }, () => cache.get(scopeA)));
    expect(calls()).toBe(1);
  });

  it('rebuilds after the TTL, so a write on another replica still lands', async () => {
    const { store, calls } = countingStore();
    let clock = 1_000;
    const cache = new RuleSetCache({
      store,
      maxRulesPerEvent: 100,
      ttlMs: 5_000,
      now: () => clock,
    });

    await cache.get(scopeA);
    clock += 4_999;
    await cache.get(scopeA);
    expect(calls()).toBe(1);

    clock += 2;
    await cache.get(scopeA);
    expect(calls()).toBe(2);
  });

  it('takes an authoring change immediately when invalidated locally', async () => {
    const { store, calls, setRules } = countingStore();
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 100, ttlMs: 60_000 });

    await cache.get(scopeA);
    setRules([rule('a'), rule('b')]);
    cache.invalidate('tnt_a');

    const set = await cache.get(scopeA);
    expect(calls()).toBe(2);
    expect(set.rules).toHaveLength(2);
  });

  it('keeps tenants separate', async () => {
    const { store, calls } = countingStore();
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 100, ttlMs: 60_000 });
    await cache.get(scopeA);
    await cache.get(scopeB);
    expect(calls()).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('stays bounded, evicting the oldest compilation', async () => {
    const { store } = countingStore();
    let clock = 0;
    const cache = new RuleSetCache({
      store,
      maxRulesPerEvent: 100,
      ttlMs: 60_000,
      maxTenants: 3,
      now: () => (clock += 1),
    });

    for (const tenant of ['t1', 't2', 't3', 't4', 't5']) {
      await cache.get(TenantScope.fromTenantId(tenant));
    }
    // One busy node must not grow a map without limit.
    expect(cache.size).toBe(3);
  });

  it('applies the per-event rule cap at compile time, not per event', async () => {
    const { store } = countingStore([rule('a', 10), rule('b', 90), rule('c', 50)]);
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 2, ttlMs: 60_000 });
    const set = await cache.get(scopeA);
    expect(set.rules.map((r) => r.rule.id)).toEqual(['b', 'c']);
  });
});
