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
import { RuleStatsRegistry } from '../src/application/rule-stats.js';
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

/** Cache observability and warm-up (P-4.1, Architect recs 5 + 8). */
describe('RuleSetCache — operations', () => {
  it('warms a tenant on demand, so the first live event never pays the compilation', async () => {
    const { store, calls } = countingStore();
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 100, ttlMs: 60_000 });

    await cache.refresh(scopeA);
    expect(calls()).toBe(1);

    // The event that follows is served from memory — the point of warming.
    await cache.get(scopeA);
    expect(calls()).toBe(1);
    expect(cache.statsFor('tnt_a').hits).toBe(1);
  });

  it('coalesces a warm-up racing an event for the same tenant', async () => {
    const { store, calls } = countingStore();
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 100, ttlMs: 60_000 });
    await Promise.all([cache.refresh(scopeA), cache.get(scopeA), cache.get(scopeA)]);
    expect(calls()).toBe(1);
  });

  it('reports a hit ratio of zero when nothing has been looked up, not a perfect one', () => {
    const { store } = countingStore();
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 100 });
    expect(cache.statsFor('tnt_a')).toMatchObject({ hits: 0, misses: 0, hitRatio: 0, rules: 0 });
  });

  it('counts hits, misses, coalescing, compilations and evictions', async () => {
    const { store } = countingStore();
    let clock = 0;
    const cache = new RuleSetCache({
      store,
      maxRulesPerEvent: 100,
      ttlMs: 60_000,
      maxTenants: 1,
      now: () => (clock += 1),
    });

    await cache.get(scopeA); // miss + compile
    await cache.get(scopeA); // hit
    await cache.get(scopeB); // miss + compile, evicting A

    const stats = cache.statsFor('tnt_b');
    expect(stats).toMatchObject({ hits: 1, misses: 2, compilations: 2, evictions: 1, tenants: 1 });
    expect(stats.hitRatio).toBeCloseTo(1 / 3);
    expect(stats.lastCompiledAt).toBeDefined();
  });

  it('counts a tenant’s compiled rules for that tenant only', async () => {
    const { store } = countingStore([rule('a'), rule('b')]);
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 100, ttlMs: 60_000 });
    await cache.get(scopeA);
    expect(cache.statsFor('tnt_a').rules).toBe(2);
    expect(cache.statsFor('tnt_b').rules).toBe(0);
  });
});

/** Per-rule counters (P-4.1, Architect rec 3). */
describe('RuleSetCache — per-rule counters', () => {
  it('attaches the same counter across recompilations, so numbers are not reset every TTL', async () => {
    const { store } = countingStore();
    const stats = new RuleStatsRegistry();
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 100, ttlMs: 60_000, stats });

    const first = await cache.get(scopeA);
    first.rules[0]!.stats!.evaluations += 7;

    cache.invalidate('tnt_a');
    const second = await cache.get(scopeA);
    // Same object, not a fresh one — a rebuilt set must not zero what the node has measured.
    expect(second.rules[0]!.stats).toBe(first.rules[0]!.stats);
    expect(stats.snapshot('tnt_a')[0]?.evaluations).toBe(7);
  });

  it('keeps counters per tenant', async () => {
    const { store } = countingStore();
    const stats = new RuleStatsRegistry();
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 100, ttlMs: 60_000, stats });

    (await cache.get(scopeA)).rules[0]!.stats!.matches += 3;
    await cache.get(scopeB);

    expect(stats.snapshot('tnt_a')[0]?.matches).toBe(3);
    expect(stats.snapshot('tnt_b')[0]?.matches).toBe(0);
  });

  it('reports no averages rather than dividing by zero', () => {
    const stats = new RuleStatsRegistry();
    stats.counterFor('tnt_a', rule('a'));
    expect(stats.snapshot('tnt_a')[0]).toMatchObject({
      avgEvaluationMicros: 0,
      maxEvaluationMicros: 0,
    });
    expect(stats.snapshot('tnt_a')[0]?.lastEvaluatedAt).toBeUndefined();
  });

  it('stays bounded, dropping the coldest rule and never the newest', () => {
    let clock = 1_000;
    const stats = new RuleStatsRegistry({ maxRulesPerTenant: 2, now: () => (clock += 1_000) });

    stats.counterFor('tnt_a', rule('a')); // oldest, never evaluated
    const b = stats.counterFor('tnt_a', rule('b'));
    b.lastEvaluatedAt = 1_000_000; // busy
    stats.counterFor('tnt_a', rule('c')); // brand new

    const kept = stats.snapshot('tnt_a').map((s) => s.ruleId);
    expect(kept).toHaveLength(2);
    expect(kept).not.toContain('a');
    // A newly compiled rule must not be evicted before it has measured anything.
    expect(kept).toContain('c');
  });
});
