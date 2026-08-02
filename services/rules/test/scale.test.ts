/**
 * The scale regression gate (P-4.1, Architect rec 13).
 *
 * The benchmark (`pnpm bench`) produces numbers; this asserts the **shape** those numbers must keep.
 * The distinction matters: an absolute millisecond ceiling is a test that fails on a loaded CI runner
 * and passes on a fast laptop while a quadratic regression sails through at small N. What cannot be
 * faked is that **cost per rule stays flat as the rule count grows** — that is the property a
 * regression would break, and it is measured as a ratio, which a slow machine does not move.
 *
 * The absolute ceilings that do appear here are set orders of magnitude above the observed baseline.
 * They exist to catch a change that makes something impossible, not one that makes it slower.
 */
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, Rule } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { RuleSetCache } from '../src/application/compiled-rules.js';
import { evaluateRule } from '../src/domain/rule-evaluator.js';
import { matchesScope } from '../src/domain/scope.js';
import type { RuleStore } from '../src/application/ports.js';
import { personEvent } from './helpers.js';

const scope = TenantScope.fromTenantId('tnt_a');

function buildRules(count: number): Rule[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `rl_${i}`,
    tenantId: 'tnt_a',
    name: `rule ${i}`,
    lifecycle: 'enabled' as const,
    priority: 1000 - (i % 1000),
    version: 1,
    eventTypes: [],
    categories: [],
    condition: {
      all: [
        { field: 'confidence', op: 'gte' as const, value: 0.5 },
        { any: [{ field: 'subjects.0.class', op: 'eq' as const, value: 'person' }] },
      ],
    },
    severity: 'medium' as const,
    actions: [{ type: 'raise-incident' as const }],
    scope: i % 4 === 0 ? { nodeIds: [`on_${i}`], cameraIds: [] } : { nodeIds: [], cameraIds: [] },
    ...(i % 4 === 0
      ? {
          resolvedScope: {
            zoneIds: [`zone_${i}`],
            cameraIds: [],
            tenantWide: false,
            resolvedAt: '2026-08-03T00:00:00.000Z',
          },
        }
      : {}),
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  }));
}

function storeOf(rules: Rule[]): { store: RuleStore; calls: () => number } {
  let calls = 0;
  return {
    store: {
      async listEnabled() {
        calls += 1;
        return rules;
      },
    } as unknown as RuleStore,
    calls: () => calls,
  };
}

/** Median microseconds to evaluate one event against the whole compiled set. */
async function medianEventMicros(count: number, events: EventEnvelope[]): Promise<number> {
  const { store } = storeOf(buildRules(count));
  const cache = new RuleSetCache({ store, maxRulesPerEvent: 10_000, ttlMs: 3_600_000 });
  const compiled = await cache.get(scope);

  // Warm the JIT, or the first samples measure compilation of the interpreter rather than the rules.
  for (const event of events.slice(0, 50)) {
    for (const { rule, scope: s } of compiled.rules)
      if (matchesScope(s, event)) evaluateRule(rule, event);
  }

  const samples: number[] = [];
  for (const event of events) {
    const start = performance.now();
    for (const { rule, scope: s } of compiled.rules) {
      if (!matchesScope(s, event)) continue;
      evaluateRule(rule, event);
    }
    samples.push((performance.now() - start) * 1000);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

describe('rule-engine scale (Architect rec 13)', () => {
  const events = Array.from({ length: 300 }, (_, i) =>
    personEvent({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      zoneId: i % 10 === 0 ? `zone_${i * 4}` : `zone_none_${i}`,
      confidence: 0.5 + (i % 40) / 100,
    }),
  );

  it('keeps the cost per rule flat from 500 to 5,000 rules', async () => {
    const small = await medianEventMicros(500, events);
    const large = await medianEventMicros(5_000, events);

    const perRuleSmall = small / 500;
    const perRuleLarge = large / 5_000;

    /*
     * Ten times the rules costs ten times as much, not a hundred. The allowance is generous (2×)
     * because a laptop under load does not scale linearly either — but a quadratic regression lands at
     * 10× here, nowhere near it.
     */
    expect(perRuleLarge).toBeLessThan(perRuleSmall * 2);
  });

  it('compiles 5,000 rules with one store call, whatever the rule count', async () => {
    const { store, calls } = storeOf(buildRules(5_000));
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 10_000, ttlMs: 3_600_000 });

    const compiled = await cache.get(scope);
    for (let i = 0; i < 1_000; i += 1) await cache.get(scope);

    expect(compiled.rules).toHaveLength(5_000);
    expect(calls()).toBe(1);
  });

  it('bounds a compiled set by the per-event cap, however many rules a tenant has', async () => {
    const { store } = storeOf(buildRules(5_000));
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 200, ttlMs: 3_600_000 });
    const compiled = await cache.get(scope);
    // The cap is what stops one tenant's configuration becoming every tenant's latency.
    expect(compiled.rules).toHaveLength(200);
  });

  it('compiles 5,000 rules well inside a ceiling that would mean something is broken', async () => {
    const { store } = storeOf(buildRules(5_000));
    const cache = new RuleSetCache({ store, maxRulesPerEvent: 10_000, ttlMs: 3_600_000 });
    const start = performance.now();
    await cache.get(scope);
    // Baseline is ~3 ms. This catches an accidental O(n²) compile, not a slow afternoon.
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});
