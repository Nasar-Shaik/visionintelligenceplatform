/**
 * Tenant isolation across everything P-4.1 added (Architect rec 11).
 *
 * Isolation is not a feature that can be tested once. Every new surface is a new place it can leak,
 * and the ones added here are the easy ones to get wrong precisely because they feel like plumbing: a
 * compiled cache, a counter registry, a dependency lookup, an export file. None of them look like
 * customer data until one of them returns another customer's estate.
 *
 * These are deliberately blunt — two tenants, one of each thing, assert nothing crosses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Rule } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { RuleService } from '../src/application/rule-service.js';
import { InMemoryRuleStore } from '../src/adapters/in-memory-rule-store.js';
import { RuleSetCache } from '../src/application/compiled-rules.js';
import { RuleStatsRegistry } from '../src/application/rule-stats.js';
import type { RuleStore } from '../src/application/ports.js';
import { personRuleInput } from './helpers.js';

const scopeA = TenantScope.fromTenantId('tnt_a');
const scopeB = TenantScope.fromTenantId('tnt_b');

let store: InMemoryRuleStore;
let service: RuleService;

const hierarchy = {
  async resolveScope(scope: TenantScope, nodeIds: readonly string[]) {
    // Tenant A owns on_london; tenant B owns nothing. A leak would resolve A's node for B.
    const owned = scope.tenantId === 'tnt_a' ? { on_london: ['zone_1', 'zone_2'] } : {};
    return {
      available: true,
      zoneIds: nodeIds.flatMap((id) => (owned as Record<string, string[]>)[id] ?? []),
      missingNodeIds: nodeIds.filter((id) => !(id in owned)),
      archivedNodeIds: [],
    };
  },
};

beforeEach(() => {
  store = new InMemoryRuleStore({ now: () => new Date('2026-08-03T09:00:00.000Z') });
  service = new RuleService({ store, hierarchy });
});

describe('tenant isolation (Architect rec 11)', () => {
  it('does not report another tenant’s rules as dependents', async () => {
    const a = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    const dependentsForB = await service.dependents(scopeB, 'location', 'on_london');
    expect(dependentsForB.rules).toHaveLength(0);

    const dependentsForA = await service.dependents(scopeA, 'location', 'on_london');
    expect(dependentsForA.rules.map((r) => r.ruleId)).toEqual([a.id]);
  });

  it('does not expose another tenant’s dependency graph, audit or compilation', async () => {
    const a = await service.create(scopeA, personRuleInput());
    await expect(service.dependencies(scopeB, a.id)).rejects.toThrow(/not found/);
    await expect(service.compilation(scopeB, a.id)).rejects.toThrow(/not found/);
    expect(await service.audit(scopeB, a.id)).toEqual([]);
  });

  it('does not let another tenant roll back a rule', async () => {
    const a = await service.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    await service.update(scopeA, a.id, { severity: 'critical' });
    await expect(service.rollback(scopeB, a.id, 1)).rejects.toThrow(/not found/);
    expect((await service.get(scopeA, a.id)).severity).toBe('critical');
  });

  it('exports only the requesting tenant’s rules', async () => {
    await service.create(scopeA, personRuleInput({ name: 'a-rule' }));
    await service.create(scopeB, personRuleInput({ name: 'b-rule' }));

    const pkgA = await service.exportRules(scopeA);
    expect(pkgA.rules.map((r) => r.rule.name)).toEqual(['a-rule']);
    expect(pkgA.source.tenantId).toBe('tnt_a');
  });

  it('imports into the requesting tenant only, whatever the package claims', async () => {
    await service.create(scopeA, personRuleInput({ name: 'a-rule' }));
    const pkgA = await service.exportRules(scopeA);
    // The package says it came from tnt_a; importing as tnt_b must land in tnt_b.
    await service.importRules(scopeB, pkgA);

    expect((await service.list(scopeA)).map((r) => r.name)).toEqual(['a-rule']);
    const inB = await service.list(scopeB);
    expect(inB).toHaveLength(1);
    expect(inB[0]?.tenantId).toBe('tnt_b');
  });

  /**
   * The one that would be silent. Validation reaches another context, and a provider that ignored the
   * tenant scope would resolve one customer's site for another — a rule scoped to somewhere it has no
   * business seeing, activated cleanly.
   */
  it('validates against the requesting tenant’s estate, not whoever owns the id', async () => {
    const b = await service.create(
      scopeB,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    const report = await service.validate(scopeB, b.id);
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === 'missing-location')).toBe(true);
    await expect(service.update(scopeB, b.id, { lifecycle: 'enabled' })).rejects.toThrow();
  });

  it('keeps compiled rule sets and per-rule counters separate', async () => {
    const rules: Record<string, Rule[]> = {
      tnt_a: [ruleFor('tnt_a', 'a1'), ruleFor('tnt_a', 'a2')],
      tnt_b: [ruleFor('tnt_b', 'b1')],
    };
    const counting = {
      async listEnabled(scope: TenantScope) {
        return rules[scope.tenantId] ?? [];
      },
    } as unknown as RuleStore;

    const stats = new RuleStatsRegistry();
    const cache = new RuleSetCache({ store: counting, maxRulesPerEvent: 100, stats });

    const setA = await cache.get(scopeA);
    const setB = await cache.get(scopeB);
    expect(setA.rules.map((r) => r.rule.id)).toEqual(['a1', 'a2']);
    expect(setB.rules.map((r) => r.rule.id)).toEqual(['b1']);

    setA.rules[0]!.stats!.matches += 5;
    expect(stats.snapshot('tnt_a').map((s) => s.ruleId)).toEqual(['a1', 'a2']);
    expect(stats.snapshot('tnt_b').map((s) => s.ruleId)).toEqual(['b1']);
    expect(stats.snapshot('tnt_b')[0]?.matches).toBe(0);
    // Dropping one tenant's counters must not touch another's.
    stats.forget('tnt_a');
    expect(stats.snapshot('tnt_a')).toEqual([]);
    expect(stats.snapshot('tnt_b')).toHaveLength(1);
  });
});

function ruleFor(tenantId: string, id: string): Rule {
  return {
    id,
    tenantId,
    name: id,
    lifecycle: 'enabled',
    priority: 100,
    version: 1,
    eventTypes: [],
    categories: [],
    severity: 'high',
    actions: [{ type: 'raise-incident' }],
    scope: { nodeIds: [], cameraIds: [] },
    createdAt: '2026-08-03T09:00:00.000Z',
    updatedAt: '2026-08-03T09:00:00.000Z',
  };
}
