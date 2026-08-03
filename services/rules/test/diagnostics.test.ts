/**
 * P-4.2 — the support surface: classification, health, diffs, trends, the diagnostic artifact, the
 * P-5 contract, search, and import compatibility.
 *
 * These mostly protect **honesty**. A health score that quietly rounds an unverifiable rule up to 82,
 * a dependency graph that reports all-clear because nobody looked, a trend line invented for a rule
 * this node has never seen — each of those is a number someone would act on, and each is the kind of
 * thing that passes a casual review.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Rule, RuleValidationReport } from '@vip/contracts';
import { DEFAULT_RULE_LIMITS } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { RuleService } from '../src/application/rule-service.js';
import { InMemoryRuleStore } from '../src/adapters/in-memory-rule-store.js';
import { RuleStatsRegistry } from '../src/application/rule-stats.js';
import { classifyRule } from '../src/domain/budget.js';
import { diffRules } from '../src/domain/diff.js';
import { assessHealth } from '../src/domain/health.js';
import type { RuleDiagnostics } from '../src/application/ports.js';
import { personRuleInput } from './helpers.js';

const scopeA = TenantScope.fromTenantId('tnt_a');
let store: InMemoryRuleStore;
let service: RuleService;
let clock: Date;

const hierarchy = {
  async resolveScope(_scope: TenantScope, nodeIds: readonly string[]) {
    const known: Record<string, string[]> = { on_london: ['zone_1', 'zone_2'] };
    const archived = new Set(['on_old']);
    return {
      available: true,
      zoneIds: nodeIds.flatMap((id) => known[id] ?? []),
      missingNodeIds: nodeIds.filter((id) => !(id in known) && !archived.has(id)),
      archivedNodeIds: nodeIds.filter((id) => archived.has(id)),
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

function tick(seconds = 60): void {
  clock = new Date(clock.getTime() + seconds * 1000);
}

const cleanReport = (rule: Rule): RuleValidationReport => ({
  ruleId: rule.id,
  ruleVersion: rule.version,
  valid: true,
  verified: true,
  issues: [],
  checked: ['event-type', 'category', 'action'],
  checkedAt: clock.toISOString(),
});

describe('complexity classification (Architect rec 3)', () => {
  it('is relative to the deployment ceiling, not an absolute count', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    expect(classifyRule(rule).class).toBe('simple');
    // The same rule against a tiny deployment is not simple — that is the point of "relative".
    expect(classifyRule(rule, { ...DEFAULT_RULE_LIMITS, maxConditionNodes: 1 }).class).toBe(
      'very-complex',
    );
  });

  it('bands on the worst dimension, never an average', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({
        scope: { nodeIds: Array.from({ length: 120 }, (_, i) => `on_${i}`), cameraIds: [] },
      }),
    );
    // One leaf condition and 120 scoped locations: averaging would call this simple.
    const report = classifyRule(rule);
    expect(report.class).toBe('very-complex');
    expect(report.drivers[0]?.dimension).toBe('scopeNodes');
  });

  it('names only the dimensions that contribute', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    expect(classifyRule(rule).drivers.every((driver) => driver.used > 0)).toBe(true);
  });
});

describe('rule health (Architect rec 2)', () => {
  it('reports healthy with a full score and nothing to say', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const health = assessHealth({
      rule,
      validation: cleanReport(rule),
      complexity: classifyRule(rule),
      dependencies: {
        ruleId: rule.id,
        ruleVersion: 1,
        dependencies: [],
        dependencyHash: 'a'.repeat(64),
        statusChecked: true,
      },
      now: clock,
    });
    expect(health).toMatchObject({ status: 'healthy', score: 100, findings: [] });
  });

  /** The rule the whole module exists for. */
  it('reports unknown rather than a confident score when the checks could not run', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    const health = assessHealth({
      rule,
      validation: { ...cleanReport(rule), verified: false, valid: false },
      complexity: classifyRule(rule),
      dependencies: {
        ruleId: rule.id,
        ruleVersion: 1,
        dependencies: [],
        dependencyHash: 'a'.repeat(64),
        statusChecked: false,
      },
      now: clock,
    });
    expect(health.status).toBe('unknown');
    expect(health.findings.map((f) => f.code)).toContain('unverified');
  });

  it('keeps the score reconstructible from the findings', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ scope: { nodeIds: ['on_ghost'], cameraIds: [] } }),
    );
    const health = assessHealth({
      rule,
      validation: {
        ...cleanReport(rule),
        valid: false,
        issues: [
          { code: 'missing-location', severity: 'error', kind: 'location', message: 'gone' },
          { code: 'empty-scope', severity: 'warning', kind: 'location', message: 'empty' },
        ],
      },
      complexity: classifyRule(rule),
      dependencies: {
        ruleId: rule.id,
        ruleVersion: 1,
        dependencies: [{ kind: 'location', ref: 'on_ghost', direct: true, status: 'missing' }],
        dependencyHash: 'a'.repeat(64),
        statusChecked: true,
      },
      now: clock,
    });
    const deducted = health.findings.reduce((sum, f) => sum + f.deduction, 0);
    // A number nobody can take apart is a number people learn to ignore.
    expect(health.score).toBe(Math.max(0, 100 - deducted));
    expect(health.status).toBe('unhealthy');
  });

  it('flags a scoped rule with no resolved expansion — it matches nothing', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    const health = await service.health(scopeA, rule.id);
    expect(health.findings.map((f) => f.code)).toContain('scope-unresolved');
  });

  it('flags a stale expansion as a warning, not an error', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    await service.update(scopeA, rule.id, { lifecycle: 'enabled' });
    clock = new Date(clock.getTime() + 60 * 86_400_000); // two months later

    const health = await service.health(scopeA, rule.id);
    const stale = health.findings.find((f) => f.code === 'scope-stale');
    expect(stale?.severity).toBe('warning');
    expect(health.status).toBe('degraded');
  });

  it('treats a throwing rule as a defect', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const health = assessHealth({
      rule,
      validation: cleanReport(rule),
      complexity: classifyRule(rule),
      dependencies: {
        ruleId: rule.id,
        ruleVersion: 1,
        dependencies: [],
        dependencyHash: 'a'.repeat(64),
        statusChecked: true,
      },
      runtime: {
        ruleId: rule.id,
        ruleName: rule.name,
        ruleVersion: 1,
        evaluations: 100,
        matches: 0,
        failures: 3,
        avgEvaluationMicros: 1,
        maxEvaluationMicros: 2,
      },
      now: clock,
    });
    expect(health.status).toBe('unhealthy');
    expect(health.findings.map((f) => f.code)).toContain('evaluation-failures');
  });

  it('does not call a rule idle before this node has been up long enough to know', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const runtime = {
      ruleId: rule.id,
      ruleName: rule.name,
      ruleVersion: 1,
      evaluations: 0,
      matches: 0,
      failures: 0,
      avgEvaluationMicros: 0,
      maxEvaluationMicros: 0,
    };
    const inputs = {
      rule,
      validation: cleanReport(rule),
      complexity: classifyRule(rule),
      dependencies: {
        ruleId: rule.id,
        ruleVersion: 1,
        dependencies: [],
        dependencyHash: 'a'.repeat(64),
        statusChecked: true,
      },
      runtime,
      now: clock,
    };
    expect(assessHealth({ ...inputs, uptimeSeconds: 60 }).status).toBe('healthy');
    expect(
      assessHealth({ ...inputs, uptimeSeconds: 60 * 60 * 48 }).findings.map((f) => f.code),
    ).toContain('never-evaluated');
  });
});

describe('version diff (Architect rec 6)', () => {
  it('names the conditions added and removed rather than "version changed"', async () => {
    const rule = await service.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    tick();
    await service.update(scopeA, rule.id, {
      condition: { field: 'confidence', op: 'gte', value: 0.95 },
    });

    const diff = await service.diff(scopeA, rule.id, 1, 2);
    const summaries = diff.changes.map((change) => change.summary);
    expect(summaries.some((s) => s.includes('added') && s.includes('0.95'))).toBe(true);
    expect(summaries.some((s) => s.includes('removed') && s.includes('0.8'))).toBe(true);
    expect(diff.behaviourUnchanged).toBe(false);
  });

  it('reports a rename as behaviour-unchanged', async () => {
    const rule = await service.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    tick();
    await service.update(scopeA, rule.id, { name: 'the same rule, renamed' });
    const diff = await service.diff(scopeA, rule.id, 1, 2);
    expect(diff.behaviourUnchanged).toBe(true);
    expect(diff.changes.map((c) => c.area)).toEqual(['identity']);
  });

  it('spots the same conditions recombined', () => {
    const base = {
      id: 'r',
      tenantId: 'tnt_a',
      name: 'r',
      lifecycle: 'draft' as const,
      priority: 100,
      eventTypes: [],
      categories: [],
      severity: 'high' as const,
      actions: [{ type: 'raise-incident' as const }],
      scope: { nodeIds: [], cameraIds: [] },
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    };
    const leaves = [
      { field: 'confidence', op: 'gte' as const, value: 0.8 },
      { field: 'zoneId', op: 'exists' as const },
    ];
    const diff = diffRules(
      { ...base, version: 1, condition: { all: leaves } } as Rule,
      { ...base, version: 2, condition: { any: leaves } } as Rule,
    );
    expect(diff.changes.map((c) => c.summary)).toContain(
      'the same conditions, combined differently (all/any/not restructured)',
    );
  });

  it('names scope changes on both sides', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    tick();
    await service.update(scopeA, rule.id, {
      scope: { nodeIds: ['on_paris'], cameraIds: ['cam_1'] },
    });

    const diff = await service.diff(scopeA, rule.id, 1, 2);
    const scopeChanges = diff.changes.filter((c) => c.area === 'scope');
    expect(scopeChanges.map((c) => c.summary)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('added location on_paris'),
        expect.stringContaining('removed location on_london'),
        expect.stringContaining('added camera cam_1'),
      ]),
    );
  });

  it('refuses a version the rule never had', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    await expect(service.diff(scopeA, rule.id, 1, 9)).rejects.toThrow(/no version 9/);
  });
});

describe('runtime statistics history (Architect rec 7)', () => {
  it('closes a bucket per interval and keeps them bounded', () => {
    let now = 0;
    const stats = new RuleStatsRegistry({
      bucketSeconds: 60,
      retainedBuckets: 3,
      now: () => now,
    });
    const rule = { id: 'r1', name: 'r', version: 1 } as Rule;

    const counter = stats.counterFor('tnt_a', rule);
    counter.evaluations += 10;
    counter.matches += 2;

    now += 60_000;
    stats.counterFor('tnt_a', rule); // compile-time heartbeat closes the bucket
    const first = stats.historyFor('tnt_a', 'r1');
    expect(first.buckets).toHaveLength(1);
    expect(first.buckets[0]).toMatchObject({ evaluations: 10, matches: 2 });

    // Five more intervals with no activity: the ring stays at three.
    now += 5 * 60_000;
    const later = stats.historyFor('tnt_a', 'r1');
    expect(later.buckets).toHaveLength(3);
    expect(later.buckets.every((bucket) => bucket.evaluations === 0)).toBe(true);
    expect(later.bucketSeconds).toBe(60);
  });

  it('returns an empty history for a rule this node has never compiled, not a flat line', () => {
    const stats = new RuleStatsRegistry();
    expect(stats.historyFor('tnt_a', 'never-seen')).toMatchObject({
      buckets: [],
      coversSeconds: 0,
    });
  });

  it('does not loop once per elapsed interval after a long idle period', () => {
    let now = 0;
    const stats = new RuleStatsRegistry({ bucketSeconds: 1, retainedBuckets: 4, now: () => now });
    stats.counterFor('tnt_a', { id: 'r1', name: 'r', version: 1 } as Rule);
    // A year of idling must cost a bounded walk, not 31 million iterations.
    now += 365 * 86_400_000;
    const started = performance.now();
    const history = stats.historyFor('tnt_a', 'r1');
    expect(performance.now() - started).toBeLessThan(100);
    expect(history.buckets).toHaveLength(4);
  });
});

describe('dependency health (Architect rec 4)', () => {
  it('says whether each reference is actually there', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({
        scope: { nodeIds: ['on_london', 'on_ghost', 'on_old'], cameraIds: ['cam_1', 'cam_x'] },
      }),
    );
    const graph = await service.dependencies(scopeA, rule.id, { checkStatus: true });
    const byRef = new Map(graph.dependencies.map((d) => [d.ref, d.status]));

    expect(graph.statusChecked).toBe(true);
    expect(byRef.get('on_london')).toBe('resolved');
    expect(byRef.get('on_ghost')).toBe('missing');
    expect(byRef.get('on_old')).toBe('archived');
    expect(byRef.get('cam_1')).toBe('resolved');
    expect(byRef.get('cam_x')).toBe('missing');
  });

  /** "Nothing is broken" and "nobody looked" must never be the same response. */
  it('says unknown when the owning context cannot be reached', async () => {
    const blind = new RuleService({ store, now: () => clock }); // no providers → unavailable
    const rule = await blind.create(
      scopeA,
      personRuleInput({ scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    const graph = await blind.dependencies(scopeA, rule.id, { checkStatus: true });
    expect(graph.dependencies.find((d) => d.ref === 'on_london')?.status).toBe('unknown');
  });

  it('does not check by default, and says it did not', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const graph = await service.dependencies(scopeA, rule.id);
    expect(graph.statusChecked).toBe(false);
    expect(graph.dependencies.every((d) => d.status === undefined)).toBe(true);
  });

  it('keeps the dependency hash independent of status — a deleted zone is not an edit', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ scope: { nodeIds: ['on_ghost'], cameraIds: [] } }),
    );
    const bare = await service.dependencies(scopeA, rule.id);
    const checked = await service.dependencies(scopeA, rule.id, { checkStatus: true });
    expect(checked.dependencyHash).toBe(bare.dependencyHash);
  });
});

describe('the diagnostic package (Architect recs 1 + 14)', () => {
  it('gathers everything about one rule, including its whole history', async () => {
    const rule = await service.create(scopeA, personRuleInput({ lifecycle: 'draft' }), 'usr_1');
    tick();
    await service.update(scopeA, rule.id, { severity: 'critical' }, 'usr_2');

    const pkg = await service.diagnosticPackage(scopeA, rule.id);
    expect(pkg.ruleId).toBe(rule.id);
    expect(pkg.tenantId).toBe('tnt_a');
    expect(pkg.versions).toHaveLength(2);
    expect(pkg.audit.map((entry) => entry.action)).toEqual(['updated', 'created']);
    expect(pkg.compilation.compiledHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.dependencies.statusChecked).toBe(true);
    expect(pkg.complexity.class).toBe('simple');
    expect(pkg.health.status).toBeDefined();
  });

  it('omits the runtime sections rather than zeroing them when this node does not evaluate', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const pkg = await service.diagnosticPackage(scopeA, rule.id);
    expect(pkg.runtime).toBeUndefined();
    expect(pkg.cache).toBeUndefined();
    expect(pkg.history).toBeUndefined();
    expect(pkg.node).toBe('unknown');
  });

  it('includes them when it does', async () => {
    const stats = new RuleStatsRegistry({ now: () => clock.getTime() });
    const diagnostics: RuleDiagnostics = {
      node: 'rules-7',
      uptimeSeconds: () => 3600,
      cacheStats: () => ({
        tenants: 1,
        rules: 1,
        hits: 9,
        misses: 1,
        coalesced: 0,
        compilations: 1,
        evictions: 0,
        hitRatio: 0.9,
        avgCompileMicros: 100,
        maxCompileMicros: 200,
      }),
      ruleStats: (tenantId) => stats.snapshot(tenantId),
      history: (tenantId, ruleId) => stats.historyFor(tenantId, ruleId),
    };
    const svc = new RuleService({ store, hierarchy, cameras, now: () => clock, diagnostics });
    const rule = await svc.create(scopeA, personRuleInput());
    stats.counterFor('tnt_a', rule).evaluations += 5;

    const pkg = await svc.diagnosticPackage(scopeA, rule.id);
    expect(pkg.node).toBe('rules-7');
    expect(pkg.runtime?.evaluations).toBe(5);
    expect(pkg.cache?.hitRatio).toBe(0.9);
  });
});

describe('the incident-management contract (Architect recs 12 + 15)', () => {
  it('answers for the version the incident was raised by, not today’s rule', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', severity: 'low' }),
    );
    tick();
    await service.update(scopeA, rule.id, { severity: 'critical' });

    const then = await service.incidentContext(scopeA, rule.id, 1);
    expect(then.ruleVersion).toBe(1);
    expect(then.severity).toBe('low');
    expect(then.supersededByCurrentVersion).toBe(true);
    // The rule's *current* lifecycle is still reported — an investigator needs both.
    expect(then.lifecycle).toBe('draft');
  });

  it('defaults to the current version, and says it is not superseded', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const context = await service.incidentContext(scopeA, rule.id);
    expect(context.ruleVersion).toBe(rule.version);
    expect(context.supersededByCurrentVersion).toBe(false);
  });

  it('carries the scope snapshot that version covered', async () => {
    const rule = await service.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    tick();
    await service.update(scopeA, rule.id, { lifecycle: 'enabled' });

    const context = await service.incidentContext(scopeA, rule.id, 2);
    expect(context.scope?.zoneIds).toEqual(['zone_1', 'zone_2']);
  });

  it('carries the condition as authored, and no invented trace', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const context = await service.incidentContext(scopeA, rule.id);
    expect(context.condition).toEqual({ field: 'confidence', op: 'gte', value: 0.8 });
    expect(context).not.toHaveProperty('explanation');
  });

  it('refuses a version the rule never had', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    await expect(service.incidentContext(scopeA, rule.id, 7)).rejects.toThrow(/no version 7/);
  });
});

describe('diagnostic search (Architect rec 13)', () => {
  it('filters by what depends on a thing, including coverage through an ancestor', async () => {
    const named = await service.create(
      scopeA,
      personRuleInput({
        name: 'names the zone',
        condition: { field: 'zoneId', op: 'eq', value: 'zone_1' },
      }),
    );
    const covering = await service.create(
      scopeA,
      personRuleInput({
        name: 'covers it',
        lifecycle: 'draft',
        scope: { nodeIds: ['on_london'], cameraIds: [] },
      }),
    );
    await service.update(scopeA, covering.id, { lifecycle: 'enabled' });
    await service.create(scopeA, personRuleInput({ name: 'unrelated' }));

    const result = await service.searchDiagnostics(scopeA, { kind: 'location', ref: 'zone_1' });
    expect(result.rows.map((row) => row.ruleId).sort()).toEqual([named.id, covering.id].sort());
    expect(result.scanned).toBe(3);
  });

  it('orders worst-first — a diagnostic list is read from the top', async () => {
    await service.create(scopeA, personRuleInput({ name: 'fine' }));
    await service.create(
      scopeA,
      personRuleInput({ name: 'broken', scope: { nodeIds: ['on_ghost'], cameraIds: [] } }),
    );
    const result = await service.searchDiagnostics(scopeA, {});
    expect(result.rows[0]?.ruleName).toBe('broken');
    expect(result.rows[0]!.healthScore).toBeLessThan(result.rows[1]!.healthScore);
  });

  it('filters by lifecycle, name and complexity', async () => {
    await service.create(scopeA, personRuleInput({ name: 'alpha', lifecycle: 'draft' }));
    await service.create(scopeA, personRuleInput({ name: 'beta' }));

    expect((await service.searchDiagnostics(scopeA, { lifecycle: 'draft' })).rows).toHaveLength(1);
    expect((await service.searchDiagnostics(scopeA, { name: 'BET' })).rows[0]?.ruleName).toBe(
      'beta',
    );
    expect((await service.searchDiagnostics(scopeA, { complexity: 'simple' })).rows).toHaveLength(
      2,
    );
  });

  it('refuses a ref with no kind rather than guessing what to look it up under', async () => {
    await expect(service.searchDiagnostics(scopeA, { ref: 'zone_1' })).rejects.toThrow(
      /needs a kind/,
    );
  });

  it('resolves dependency status once for the tenant, not once per rule', async () => {
    let calls = 0;
    const counting = {
      async resolveScope(...args: Parameters<typeof hierarchy.resolveScope>) {
        calls += 1;
        return hierarchy.resolveScope(...args);
      },
    };
    const svc = new RuleService({ store, hierarchy: counting, cameras, now: () => clock });
    for (let i = 0; i < 10; i += 1) {
      await svc.create(
        scopeA,
        personRuleInput({ name: `r${i}`, scope: { nodeIds: ['on_london'], cameraIds: [] } }),
      );
    }
    calls = 0;

    await svc.searchDiagnostics(scopeA, {});
    // Ten rules, one hierarchy call — otherwise a list view is a load test on another context.
    expect(calls).toBe(1);
  });
});

describe('import compatibility and conflicts (Architect recs 8 + 11)', () => {
  const scopeC = TenantScope.fromTenantId('tnt_c');

  it('rejects a package from an incompatible engine, importing nothing at all', async () => {
    await service.create(scopeA, personRuleInput({ name: 'exported' }));
    const pkg = await service.exportRules(scopeA);

    const result = await service.importRules(scopeC, {
      package: { ...pkg, engineVersion: '2.0.0' },
      onConflict: 'skip',
    });
    expect(result.incompatible[0]).toMatch(/engine 2\.0\.0/);
    expect(result.imported).toBe(0);
    // Partial imports are fine for a broken rule and not for a broken package.
    expect(await service.list(scopeC)).toHaveLength(0);
  });

  it('accepts a package from an older minor version — additive by the platform’s own rule', async () => {
    await service.create(scopeA, personRuleInput({ name: 'exported' }));
    const pkg = await service.exportRules(scopeA);
    const result = await service.importRules(scopeC, {
      package: { ...pkg, engineVersion: '1.0.0', schemaVersion: '1.0.0' },
      onConflict: 'skip',
    });
    expect(result.incompatible).toEqual([]);
    expect(result.imported).toBe(1);
  });

  it('accepts a package written before the version fields existed', async () => {
    await service.create(scopeA, personRuleInput({ name: 'exported' }));
    const pkg = await service.exportRules(scopeA);
    const { engineVersion: _e, schemaVersion: _s, ...older } = pkg;
    const result = await service.importRules(scopeC, { package: older, onConflict: 'skip' });
    expect(result.incompatible).toEqual([]);
    expect(result.imported).toBe(1);
  });

  it('skips a name that already exists rather than silently doubling the rule set', async () => {
    await service.create(scopeA, personRuleInput({ name: 'exported' }));
    const pkg = await service.exportRules(scopeA);

    await service.importRules(scopeC, { package: pkg, onConflict: 'skip' });
    const second = await service.importRules(scopeC, { package: pkg, onConflict: 'skip' });

    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.results[0]).toMatchObject({ outcome: 'skipped' });
    expect(second.results[0]?.conflictsWith).toBeDefined();
    expect(await service.list(scopeC)).toHaveLength(1);
  });

  it('imports anyway when told to', async () => {
    await service.create(scopeA, personRuleInput({ name: 'exported' }));
    const pkg = await service.exportRules(scopeA);
    await service.importRules(scopeC, { package: pkg, onConflict: 'skip' });
    const second = await service.importRules(scopeC, { package: pkg, onConflict: 'import-anyway' });
    expect(second.imported).toBe(1);
    expect(await service.list(scopeC)).toHaveLength(2);
  });

  it('names the references that did not survive the journey, and counts what needs attention', async () => {
    await service.create(
      scopeA,
      personRuleInput({
        name: 'scoped',
        lifecycle: 'draft',
        scope: { nodeIds: ['on_london'], cameraIds: [] },
      }),
    );
    const pkg = await service.exportRules(scopeA);

    // A tenant whose hierarchy knows nothing: the node id means nothing here.
    const blind = new RuleService({
      store,
      hierarchy: {
        async resolveScope(_s: TenantScope, nodeIds: readonly string[]) {
          return {
            available: true,
            zoneIds: [],
            missingNodeIds: [...nodeIds],
            archivedNodeIds: [],
          };
        },
      },
      cameras,
      now: () => clock,
    });
    const result = await blind.importRules(scopeC, { package: pkg, onConflict: 'skip' });

    expect(result.imported).toBe(1);
    expect(result.results[0]?.unresolvedDependencies.map((d) => d.ref)).toContain('on_london');
    expect(result.summary.withErrors).toBe(1);
  });
});
