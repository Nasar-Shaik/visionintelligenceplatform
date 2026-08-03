/**
 * P-4.1 — rule operations: fingerprints, dependencies, budgets, audit, rollback, simulation and
 * portability.
 *
 * Everything here is diagnostic or derived, so the tests are mostly about **what must not change**: a
 * hash that moves when a rule is renamed, an audit entry that calls a pause an edit, or a rollback that
 * leaves a field the target version never had are all failures that would go unnoticed in normal use
 * and be discovered during an incident.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Rule } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { RuleService } from '../src/application/rule-service.js';
import { InMemoryRuleStore } from '../src/adapters/in-memory-rule-store.js';
import { unsetOf } from '../src/adapters/mongo-rule-store.js';
import { budgetChecks, measureRule, rawDepth, MAX_BODY_NESTING } from '../src/domain/budget.js';
import { deriveAudit } from '../src/domain/audit.js';
import { ruleDependencies } from '../src/domain/dependencies.js';
import {
  canonicalize,
  contentHash,
  dependencyHash,
  scopeHash,
  validationHash,
} from '../src/domain/fingerprint.js';
import { personEvent, personRuleInput } from './helpers.js';

const scopeA = TenantScope.fromTenantId('tnt_a');
let store: InMemoryRuleStore;
let service: RuleService;
let clock: Date;

/** A hierarchy that knows one site with two zones. */
const hierarchy = {
  async resolveScope(_scope: TenantScope, nodeIds: readonly string[]) {
    const known: Record<string, string[]> = { on_london: ['zone_1', 'zone_2'], on_empty: [] };
    return {
      available: true,
      zoneIds: nodeIds.flatMap((id) => known[id] ?? []),
      missingNodeIds: nodeIds.filter((id) => !(id in known)),
      archivedNodeIds: [],
    };
  },
};
const cameras = {
  async findMissing(_scope: TenantScope, ids: readonly string[]) {
    return { available: true, missingCameraIds: ids.filter((id) => id !== 'cam_1') };
  },
};

beforeEach(() => {
  clock = new Date('2026-08-03T09:00:00.000Z');
  store = new InMemoryRuleStore({ now: () => clock });
  service = new RuleService({ store, hierarchy, cameras, now: () => clock });
});

/** Advance the clock so successive versions do not share a timestamp. */
function tick(seconds = 60): void {
  clock = new Date(clock.getTime() + seconds * 1000);
}

describe('fingerprints (Architect recs 1 + 14)', () => {
  it('is independent of key order — the same rule always hashes the same', () => {
    expect(canonicalize({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      canonicalize({ a: [2, { c: 3, d: 4 }], b: 1 }),
    );
  });

  it('preserves array order, because a condition tree is walked in order', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('drops undefined rather than serialising it, so an absent field equals an absent field', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('does not move when a rule is renamed — the question is "did the behaviour change?"', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const before = contentHash(rule);
    tick();
    const renamed = await service.update(scopeA, rule.id, { name: 'a better name' });
    expect(contentHash(renamed)).toBe(before);
  });

  it('does not move when a rule is paused and resumed', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const before = contentHash(rule);
    tick();
    const paused = await service.update(scopeA, rule.id, { lifecycle: 'disabled' });
    expect(contentHash(paused)).toBe(before);
  });

  it('moves when the condition changes', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const before = contentHash(rule);
    tick();
    const edited = await service.update(scopeA, rule.id, {
      condition: { field: 'confidence', op: 'gte', value: 0.95 },
    });
    expect(contentHash(edited)).not.toBe(before);
  });

  it('gives a scope hash that ignores when the expansion was taken', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    tick();
    const enabled = await service.update(scopeA, rule.id, { lifecycle: 'enabled' });
    const first = scopeHash(enabled);
    // Re-resolving against an unchanged estate must produce an unchanged hash, only a later timestamp.
    const reResolved: Rule = {
      ...enabled,
      resolvedScope: { ...enabled.resolvedScope!, resolvedAt: '2027-01-01T00:00:00.000Z' },
    };
    expect(scopeHash(reResolved)).toBe(first);
  });

  it('gives a dependency hash that ignores order', () => {
    const a = dependencyHash([
      { kind: 'location', ref: 'on_1', direct: true },
      { kind: 'camera', ref: 'cam_1', direct: true },
    ]);
    const b = dependencyHash([
      { kind: 'camera', ref: 'cam_1', direct: true },
      { kind: 'location', ref: 'on_1', direct: true },
    ]);
    expect(a).toBe(b);
  });

  it('gives a validation hash that ignores when the check ran', () => {
    const report = {
      ruleId: 'r1',
      ruleVersion: 1,
      valid: true,
      verified: true,
      issues: [],
      checked: ['action' as const],
      checkedAt: '2026-08-03T09:00:00.000Z',
    };
    expect(validationHash(report)).toBe(
      validationHash({ ...report, checkedAt: '2027-01-01T00:00:00.000Z' }),
    );
  });

  it('reports a compilation for a stored rule, recomputed rather than read', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const compilation = await service.compilation(scopeA, rule.id);
    expect(compilation).toMatchObject({
      ruleId: rule.id,
      ruleVersion: 1,
      compilerVersion: '1.0.0',
    });
    expect(compilation.compiledHash).toMatch(/^[0-9a-f]{64}$/);
    expect(compilation.compiledHash).toBe(contentHash(rule));
  });
});

describe('dependencies (Architect rec 2)', () => {
  it('names the scope, the prefilter and the emit target', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({
        scope: { nodeIds: ['on_london'], cameraIds: ['cam_1'] },
        actions: [{ type: 'emit-event', eventType: 'system.health.degraded' }],
      }),
    );
    const refs = ruleDependencies(rule).map((d) => `${d.kind}:${d.ref}`);
    expect(refs).toContain('location:on_london');
    expect(refs).toContain('camera:cam_1');
    expect(refs).toContain('event-type:perception.person.detected');
    expect(refs).toContain('event-type:system.health.degraded');
  });

  /** The case a naive implementation misses, and the one that makes a deletion check worth running. */
  it('sees a reference made inside a condition, not only in the declared fields', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({
        eventTypes: [],
        condition: { all: [{ field: 'zoneId', op: 'in', value: ['zone_7', 'zone_8'] }] },
      }),
    );
    const refs = ruleDependencies(rule).map((d) => `${d.kind}:${d.ref}`);
    expect(refs).toContain('location:zone_7');
    expect(refs).toContain('location:zone_8');
  });

  it('does not invent references from a numeric comparison', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    expect(ruleDependencies(rule).some((d) => d.ref === '0.8')).toBe(false);
  });

  it('separates a rule that names a zone from one that merely covers it', async () => {
    const named = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: [], cameraIds: [] } }),
    );
    await service.update(scopeA, named.id, {
      condition: { field: 'zoneId', op: 'eq', value: 'zone_1' },
    });
    tick();
    const covering = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    await service.update(scopeA, covering.id, { lifecycle: 'enabled' });

    const dependents = await service.dependents(scopeA, 'location', 'zone_1');
    const byId = new Map(dependents.rules.map((r) => [r.ruleId, r.direct]));
    expect(byId.get(named.id)).toBe(true);
    // Covered through an ancestor: removing the zone leaves this rule working with one fewer zone.
    expect(byId.get(covering.id)).toBe(false);
  });
});

describe('evaluation budget (Architect rec 4)', () => {
  const nest = (depth: number): unknown =>
    depth === 0 ? { field: 'confidence', op: 'gte', value: 0.5 } : { not: nest(depth - 1) };

  it('measures a rule whether or not anything is wrong', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({
        condition: {
          all: [
            { field: 'confidence', op: 'gte', value: 0.8 },
            { any: [{ field: 'zoneId', op: 'eq', value: 'z' }] },
          ],
        },
      }),
    );
    // all + leaf + any + leaf = 4 nodes; all → any → leaf = 3 levels.
    expect(measureRule(rule)).toMatchObject({ conditionNodes: 4, conditionDepth: 3, actions: 1 });
  });

  it('blocks a condition nested past the deployment limit', async () => {
    const rule = await service.create(scopeA, personRuleInput({ condition: nest(25) as never }));
    const issues = budgetChecks(rule);
    expect(issues.map((i) => i.code)).toContain('condition-too-deep');
    expect(issues.every((i) => i.severity === 'error')).toBe(true);
  });

  it('reports every ceiling exceeded, not the first', async () => {
    const rule = await service.create(scopeA, personRuleInput({ condition: nest(25) as never }));
    const issues = budgetChecks(rule, {
      maxConditionNodes: 1,
      maxConditionDepth: 1,
      maxEventTypes: 1,
      maxCategories: 1,
      maxActions: 1,
      maxScopeNodes: 1,
      maxScopeCameras: 1,
      maxResolvedZones: 1,
    });
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['condition-too-large', 'condition-too-deep']),
    );
  });

  it('refuses to enable a rule that exceeds a ceiling', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', condition: nest(25) as never }),
    );
    await expect(service.update(scopeA, rule.id, { lifecycle: 'enabled' })).rejects.toThrow(
      /levels of nesting/,
    );
  });

  /**
   * The crash guard. `RuleCondition` is recursive, so a body this deep overflows the stack *inside*
   * the Zod parser — before validation, before the budget check, before anything can report it.
   */
  it('measures raw nesting without recursing, and stops early', () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 5_000; i += 1) deep = { not: deep };
    expect(rawDepth(deep, MAX_BODY_NESTING)).toBeGreaterThan(MAX_BODY_NESTING);
    expect(rawDepth({ a: { b: 1 } }, MAX_BODY_NESTING)).toBe(2);
  });
});

describe('audit trail, derived from the versions (Architect rec 12)', () => {
  it('reads a rule’s life as actions rather than states', async () => {
    const rule = await service.create(scopeA, personRuleInput({ lifecycle: 'draft' }), 'usr_1');
    tick();
    await service.update(scopeA, rule.id, { severity: 'critical' }, 'usr_2');
    tick();
    await service.update(scopeA, rule.id, { lifecycle: 'enabled' }, 'usr_2');
    tick();
    await service.update(scopeA, rule.id, { lifecycle: 'disabled' }, 'usr_3');

    const audit = await service.audit(scopeA, rule.id);
    expect(audit.map((e) => e.action)).toEqual(['disabled', 'enabled', 'updated', 'created']);
    expect(audit[0]?.actor).toBe('usr_3');
    expect(audit.at(-1)?.version).toBe(1);
    expect(audit.find((e) => e.action === 'updated')?.changedFields).toContain('severity');
  });

  it('calls a return to the archive a restoration', async () => {
    const rule = await service.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    tick();
    await service.update(scopeA, rule.id, { lifecycle: 'archived' });
    tick();
    await service.update(scopeA, rule.id, { lifecycle: 'draft' });
    const audit = await service.audit(scopeA, rule.id);
    expect(audit.map((e) => e.action)).toEqual(['restored', 'archived', 'created']);
  });

  it('recognises a rollback from the content, however it was performed', async () => {
    const rule = await service.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    tick();
    await service.update(scopeA, rule.id, { severity: 'critical' });
    tick();
    // Put the original severity back by hand — no rollback endpoint involved.
    await service.update(scopeA, rule.id, { severity: 'high' });

    const audit = await service.audit(scopeA, rule.id);
    expect(audit[0]?.action).toBe('rolled-back');
    expect(audit[0]?.restoredFrom).toBe(1);
  });

  it('does not call a pause a rollback', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    tick();
    await service.update(scopeA, rule.id, { lifecycle: 'disabled' });
    tick();
    await service.update(scopeA, rule.id, { lifecycle: 'enabled' });
    const audit = await service.audit(scopeA, rule.id);
    expect(audit.map((e) => e.action)).toEqual(['enabled', 'disabled', 'created']);
  });

  it('sorts the history itself rather than trusting the order it arrives in', () => {
    const base = { tenantId: 'tnt_a', ruleId: 'r1', changedAt: '2026-08-03T09:00:00.000Z' };
    const snapshot = (version: number, lifecycle: Rule['lifecycle']): Rule =>
      ({
        id: 'r1',
        tenantId: 'tnt_a',
        name: 'r',
        lifecycle,
        priority: 100,
        version,
        eventTypes: [],
        categories: [],
        severity: 'high',
        actions: [{ type: 'raise-incident' }],
        scope: { nodeIds: [], cameraIds: [] },
        createdAt: base.changedAt,
        updatedAt: base.changedAt,
      }) as Rule;

    const audit = deriveAudit([
      { ...base, version: 2, changeKind: 'lifecycle-changed', snapshot: snapshot(2, 'enabled') },
      { ...base, version: 1, changeKind: 'created', snapshot: snapshot(1, 'draft') },
    ]);
    expect(audit.map((e) => e.action)).toEqual(['enabled', 'created']);
  });
});

describe('rollback (Architect rec 7)', () => {
  it('restores content as a new version, never rewriting history', async () => {
    const rule = await service.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    tick();
    await service.update(scopeA, rule.id, { severity: 'critical', priority: 900 });
    tick();

    const restored = await service.rollback(scopeA, rule.id, 1, 'usr_9');
    expect(restored.version).toBe(3);
    expect(restored.severity).toBe('high');
    expect(restored.priority).toBe(100);
    // Both the mistake and the correction remain in the record.
    const versions = await service.listVersions(scopeA, rule.id);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions.find((v) => v.version === 2)?.snapshot.severity).toBe('critical');
  });

  /**
   * The case a patch-based rollback gets wrong. `UpdateRuleInput` cannot express "this field is now
   * absent", so rolling back through `update` would leave the condition behind and produce a rule
   * identical to neither version.
   */
  it('removes a field the target version did not have', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', condition: undefined }),
    );
    expect(rule.condition).toBeUndefined();
    tick();
    await service.update(scopeA, rule.id, {
      condition: { field: 'confidence', op: 'gte', value: 0.9 },
    });
    tick();

    const restored = await service.rollback(scopeA, rule.id, 1);
    expect(restored.condition).toBeUndefined();
  });

  it('leaves lifecycle alone — restoring content must not re-enable a rule someone disabled', async () => {
    const rule = await service.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    tick();
    await service.update(scopeA, rule.id, { severity: 'critical' });
    tick();
    await service.update(scopeA, rule.id, { lifecycle: 'disabled' });
    tick();
    const restored = await service.rollback(scopeA, rule.id, 1);
    expect(restored.lifecycle).toBe('disabled');
    expect(restored.severity).toBe('high');
  });

  it('is instant for a rule that is not live — no other context is consulted', async () => {
    let calls = 0;
    const counting = {
      async resolveScope(...args: Parameters<typeof hierarchy.resolveScope>) {
        calls += 1;
        return hierarchy.resolveScope(...args);
      },
    };
    const svc = new RuleService({ store, hierarchy: counting, cameras, now: () => clock });
    const rule = await svc.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    tick();
    await svc.update(scopeA, rule.id, { severity: 'critical' });
    tick();
    const before = calls;

    const restored = await svc.rollback(scopeA, rule.id, 1);
    expect(calls).toBe(before);
    expect(restored.severity).toBe('high');
  });

  it('gates a rollback of a live rule the same way any other live edit is gated', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    tick();
    await service.update(scopeA, rule.id, { lifecycle: 'enabled' });
    tick();
    await service.update(scopeA, rule.id, { scope: { nodeIds: ['on_empty'], cameraIds: [] } });
    tick();

    // v3's scope is valid, so this succeeds and re-resolves rather than trusting the old snapshot.
    const restored = await service.rollback(scopeA, rule.id, 2);
    expect(restored.lifecycle).toBe('enabled');
    expect(restored.resolvedScope?.zoneIds).toEqual(['zone_1', 'zone_2']);
  });

  it('refuses a version the rule never had', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    await expect(service.rollback(scopeA, rule.id, 47)).rejects.toThrow(/no version 47/);
  });

  it('refuses to roll back to the version already loaded', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    await expect(service.rollback(scopeA, rule.id, 1)).rejects.toThrow(/already at version/);
  });
});

describe('simulation (Architect rec 9)', () => {
  it('runs a rule over supplied events and says which stage rejected each one', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const result = await service.simulate(scopeA, rule.id, {
      events: [
        personEvent({ id: '11111111-1111-4111-8111-111111111111' }),
        personEvent({ id: '22222222-2222-4222-8222-222222222222', confidence: 0.2 }),
      ],
    });
    expect(result.evaluated).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.decidedBy).toEqual({ matched: 1, condition: 1 });
    expect(result.outcomes[1]?.explanation.summary).toMatch(/confidence/);
  });

  it('reports replay over stored history as not implemented, rather than pretending', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    await expect(
      service.simulate(scopeA, rule.id, {
        range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
      }),
    ).rejects.toMatchObject({ statusCode: 501 });
  });

  it('emits nothing and changes nothing', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    await service.simulate(scopeA, rule.id, { events: [personEvent()] });
    expect((await service.get(scopeA, rule.id)).version).toBe(1);
  });
});

describe('portability (Architect recs 10 + 14)', () => {
  it('exports authored content without ids, tenant or the resolved scope', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    tick();
    await service.update(scopeA, rule.id, { lifecycle: 'enabled' });

    const pkg = await service.exportRules(scopeA);
    expect(pkg.rules).toHaveLength(1);
    const entry = pkg.rules[0]!;
    expect(entry.sourceRuleId).toBe(rule.id);
    expect(entry).not.toHaveProperty('rule.id');
    expect(entry.rule).not.toHaveProperty('resolvedScope');
    expect(entry.dependencies.map((d) => d.ref)).toContain('on_london');
    expect(entry.compiledHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('imports every rule as a draft, whatever state it was exported in', async () => {
    await service.create(scopeA, personRuleInput({ name: 'live rule' }));
    const pkg = await service.exportRules(scopeA);
    expect(pkg.rules[0]?.rule.lifecycle).toBe('enabled');

    const scopeC = TenantScope.fromTenantId('tnt_c');
    const result = await service.importRules(
      scopeC,
      { package: pkg, onConflict: 'skip' },
      'usr_import',
    );
    expect(result.imported).toBe(1);
    expect(result.rejected).toBe(0);
    const [imported] = await service.list(scopeC);
    expect(imported?.lifecycle).toBe('draft');
    expect(imported?.name).toBe('live rule');
  });

  it('reports the references that did not survive the journey', async () => {
    await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_ghost'], cameraIds: [] } }),
    );
    const pkg = await service.exportRules(scopeA);
    const result = await service.importRules(TenantScope.fromTenantId('tnt_c'), {
      package: pkg,
      onConflict: 'skip',
    });
    expect(result.imported).toBe(1);
    expect(result.results[0]?.validation?.valid).toBe(false);
    expect(result.results[0]?.validation?.issues.some((i) => i.code === 'missing-location')).toBe(
      true,
    );
  });
});

describe('statistics when this node does not evaluate (Architect rec 3)', () => {
  it('says so rather than reporting zeroes as measurements', () => {
    expect(() => service.stats(scopeA)).toThrow(/not evaluating/);
  });
});

/**
 * The Mongo write shape. `$set` with an object that lacks a key leaves the stored key untouched, so a
 * field the domain removed survives in the database — and for `resolvedScope` that means a re-scoped
 * rule keeps matching the zones the author just removed. Proven at the mapping, which is the layer
 * that decides it; the collection round-trip is covered by the integration suite.
 */
describe('the Mongo unset mapping', () => {
  it('unsets exactly the fields a rule does not have', () => {
    const bare = {
      id: 'r1',
      tenantId: 'tnt_a',
      name: 'r',
      lifecycle: 'draft',
      priority: 100,
      version: 1,
      eventTypes: [],
      categories: [],
      severity: 'high',
      actions: [{ type: 'raise-incident' }],
      scope: { nodeIds: [], cameraIds: [] },
      createdAt: '2026-08-03T09:00:00.000Z',
      updatedAt: '2026-08-03T09:00:00.000Z',
    } as Rule;

    expect(unsetOf(bare)).toEqual({
      description: '',
      condition: '',
      window: '',
      resolvedScope: '',
      createdBy: '',
    });
    expect(
      unsetOf({ ...bare, condition: { field: 'confidence', op: 'gte', value: 0.5 } }),
    ).not.toHaveProperty('condition');
  });
});
