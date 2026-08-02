/**
 * Rule scoping, validation and explainability (P-4).
 *
 * All pure or in-memory: no Mongo, no NATS, no clock. The rules a customer configures decide where
 * alerts come from, so every branch here is one an operator would notice getting wrong.
 */
import { describe, expect, it } from 'vitest';
import type { Rule, RuleScope } from '@vip/contracts';
import { compileScope, explainScope, isTenantWide, matchesScope } from '../src/domain/scope.js';
import { explain, explainCondition, firstFailure } from '../src/domain/explain.js';
import { evaluateCondition } from '../src/domain/condition.js';
import {
  permitsActivation,
  selfChecks,
  validateRule,
  type ReferenceFindings,
} from '../src/domain/validation.js';
import { compileRules } from '../src/application/compiled-rules.js';
import { RuleService } from '../src/application/rule-service.js';
import { InMemoryRuleStore } from '../src/adapters/in-memory-rule-store.js';
import { TenantScope } from '@vip/tenancy';
import { personEvent, personRuleInput } from './helpers.js';

const AT = new Date('2026-08-02T00:00:00.000Z');

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rl_1',
    tenantId: 'tnt_a',
    name: 'test rule',
    lifecycle: 'enabled',
    priority: 100,
    version: 1,
    eventTypes: ['perception.person.detected'],
    categories: [],
    severity: 'high',
    actions: [{ type: 'raise-incident' }],
    scope: { nodeIds: [], cameraIds: [] },
    createdAt: AT.toISOString(),
    updatedAt: AT.toISOString(),
    ...overrides,
  };
}

const scoped = (nodeIds: string[], cameraIds: string[] = []): RuleScope => ({ nodeIds, cameraIds });

describe('scope matching', () => {
  it('treats a rule that names nothing as tenant-wide', () => {
    expect(isTenantWide(undefined)).toBe(true);
    expect(isTenantWide({ nodeIds: [], cameraIds: [] })).toBe(true);
    expect(isTenantWide({ nodeIds: ['on_site'], cameraIds: [] })).toBe(false);

    const compiled = compileScope(undefined, { nodeIds: [], cameraIds: [] });
    expect(compiled.tenantWide).toBe(true);
    expect(matchesScope(compiled, personEvent())).toBe(true);
  });

  it('matches an event in a zone the scope expanded to', () => {
    const compiled = compileScope({
      zoneIds: ['zone_1', 'zone_2'],
      cameraIds: [],
      tenantWide: false,
      resolvedAt: AT.toISOString(),
    });
    expect(matchesScope(compiled, personEvent({ zoneId: 'zone_1' }))).toBe(true);
    expect(matchesScope(compiled, personEvent({ zoneId: 'zone_9' }))).toBe(false);
  });

  it('matches a named camera wherever it sits', () => {
    const compiled = compileScope({
      zoneIds: ['zone_7'],
      cameraIds: ['cam_1'],
      tenantWide: false,
      resolvedAt: AT.toISOString(),
    });
    // The zone is outside the scope; the camera is named directly, which is what the operator meant.
    expect(matchesScope(compiled, personEvent({ zoneId: 'zone_9', cameraId: 'cam_1' }))).toBe(true);
  });

  /**
   * The failure direction that matters. An event with no location must not satisfy a narrowed scope:
   * treating "unknown" as "inside" is how a rule for one site starts alerting for the whole estate.
   */
  it('refuses an event with no location against a narrowed scope', () => {
    const compiled = compileScope({
      zoneIds: ['zone_1'],
      cameraIds: [],
      tenantWide: false,
      resolvedAt: AT.toISOString(),
    });
    const nowhere = { ...personEvent() } as Record<string, unknown>;
    delete nowhere.zoneId;
    delete nowhere.cameraId;
    expect(matchesScope(compiled, nowhere as never)).toBe(false);
    expect(explainScope(compiled, nowhere as never)).toContain('carries no location');
  });

  /**
   * A rule that names places but has no expansion matches **nothing**, not everything. Failing open
   * here would be an estate-wide alert storm that looks like the product working.
   */
  it('matches nothing when a scoped rule has never been resolved', () => {
    const compiled = compileScope(undefined, scoped(['on_london']));
    expect(compiled.unresolved).toBe(true);
    expect(compiled.tenantWide).toBe(false);
    expect(matchesScope(compiled, personEvent({ zoneId: 'zone_1' }))).toBe(false);
    expect(explainScope(compiled, personEvent())).toContain('not resolved');
  });

  it('explains why an event fell outside the scope', () => {
    const compiled = compileScope({
      zoneIds: ['zone_1'],
      cameraIds: [],
      tenantWide: false,
      resolvedAt: AT.toISOString(),
    });
    expect(explainScope(compiled, personEvent({ zoneId: 'zone_9' }))).toContain('outside');
    expect(explainScope(compiled, personEvent({ zoneId: 'zone_1' }))).toContain('inside');
  });
});

describe('explainability', () => {
  const event = personEvent({ confidence: 0.71 });

  it('names the leaf that failed and the value it saw', () => {
    const trace = explainCondition({ field: 'confidence', op: 'gte', value: 0.8 }, event);
    expect(trace.passed).toBe(false);
    expect(trace.actual).toBe(0.71);
    expect(trace.expected).toBe(0.8);
    expect(trace.reason).toContain('0.71');
    expect(trace.reason).toContain('0.8');
  });

  it('agrees with the interpreter on every node — one implementation, two readers', () => {
    const conditions = [
      { field: 'confidence', op: 'gte' as const, value: 0.8 },
      { field: 'type', op: 'eq' as const, value: 'perception.person.detected' },
      {
        all: [
          { field: 'confidence', op: 'gt' as const, value: 0.5 },
          { field: 'zoneId', op: 'exists' as const },
        ],
      },
      {
        any: [
          { field: 'confidence', op: 'gt' as const, value: 0.99 },
          { field: 'cameraId', op: 'eq' as const, value: 'cam_1' },
        ],
      },
      { not: { field: 'confidence', op: 'lt' as const, value: 0.1 } },
    ];
    for (const condition of conditions) {
      expect(explainCondition(condition, event).passed).toBe(evaluateCondition(condition, event));
    }
  });

  it('does not short-circuit a composite — the next failing leaf is what the author needs', () => {
    const trace = explainCondition(
      {
        all: [
          { field: 'confidence', op: 'gte', value: 0.8 },
          { field: 'subjects.0.class', op: 'eq', value: 'vehicle' },
        ],
      },
      event,
    );
    expect(trace.children).toHaveLength(2);
    // Both were evaluated even though the first already decided the outcome.
    expect(trace.children?.every((child) => child.passed === false)).toBe(true);
  });

  it('reports the first failing leaf, depth-first', () => {
    const trace = explainCondition(
      {
        all: [
          { field: 'type', op: 'eq', value: 'perception.person.detected' },
          { any: [{ field: 'confidence', op: 'gte', value: 0.9 }] },
        ],
      },
      event,
    );
    expect(firstFailure(trace)?.field).toBe('confidence');
  });

  /**
   * The first failing **stage** decides, not the last. A rule scoped to the wrong site and with a
   * failing condition must report the scope — fixing the condition would not have helped.
   */
  it('attributes the outcome to the first stage that failed', () => {
    const explanation = explain({
      ruleId: 'rl_1',
      ruleVersion: 3,
      ruleName: 'test',
      stages: {
        lifecyclePassed: true,
        scopePassed: false,
        prefilterPassed: true,
        conditionPassed: false,
        windowPassed: false,
      },
      scopeReason: 'zone_9 is outside the scope',
      prefilterReason: 'types match',
    });
    expect(explanation.decidedBy).toBe('scope');
    expect(explanation.summary).toContain('outside');
    expect(explanation.matched).toBe(false);
  });

  it('says so plainly when everything matched', () => {
    const explanation = explain({
      ruleId: 'rl_1',
      ruleVersion: 1,
      ruleName: 'test',
      stages: {
        lifecyclePassed: true,
        scopePassed: true,
        prefilterPassed: true,
        conditionPassed: true,
        windowPassed: true,
      },
      scopeReason: 'tenant-wide',
      prefilterReason: 'types match',
    });
    expect(explanation.decidedBy).toBe('matched');
    expect(explanation.matched).toBe(true);
  });

  it('reports how far a windowed threshold got', () => {
    const explanation = explain({
      ruleId: 'rl_1',
      ruleVersion: 1,
      ruleName: 'test',
      stages: {
        lifecyclePassed: true,
        scopePassed: true,
        prefilterPassed: true,
        conditionPassed: true,
        windowPassed: false,
      },
      scopeReason: 'tenant-wide',
      prefilterReason: 'types match',
      window: { counted: 2, required: 5, withinSeconds: 60 },
    });
    expect(explanation.decidedBy).toBe('window');
    expect(explanation.summary).toContain('2 of 5');
  });
});

describe('validation', () => {
  const fullyChecked: ReferenceFindings = {
    checked: ['event-type', 'category', 'action', 'location', 'camera'],
  };

  it('passes a well-formed tenant-wide rule with the catalog alone', () => {
    const report = validateRule(rule(), { checked: ['event-type', 'category', 'action'] }, AT);
    expect(report.valid).toBe(true);
    expect(report.verified).toBe(true);
    expect(permitsActivation(report)).toBe(true);
  });

  it('rejects an event type no capability publishes', () => {
    const issues = selfChecks(rule({ eventTypes: ['perception.dragon.detected'] }));
    expect(issues.map((i) => i.code)).toContain('unknown-event-type');
    expect(issues[0]?.severity).toBe('error');
  });

  it('rejects a rule scoped to a location that does not exist', () => {
    const report = validateRule(
      rule({ scope: scoped(['on_ghost']) }),
      { ...fullyChecked, missingNodeIds: ['on_ghost'], resolvedZoneIds: [] },
      AT,
    );
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === 'missing-location')).toBe(true);
  });

  it('rejects a rule scoped to an archived location', () => {
    const report = validateRule(
      rule({ scope: scoped(['on_old']) }),
      { ...fullyChecked, archivedNodeIds: ['on_old'], resolvedZoneIds: ['z1'] },
      AT,
    );
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === 'archived-location')).toBe(true);
  });

  it('rejects a rule naming a camera that does not exist', () => {
    const report = validateRule(
      rule({ scope: scoped([], ['cam_ghost']) }),
      { ...fullyChecked, missingCameraIds: ['cam_ghost'] },
      AT,
    );
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === 'missing-camera')).toBe(true);
  });

  /**
   * The rule this whole module exists for. A check that could not run is not a check that passed —
   * the configuration equivalent of certifying hardware from a simulation.
   */
  it('refuses to call a rule valid when a check could not run', () => {
    const report = validateRule(
      rule({ scope: scoped(['on_london']) }),
      { checked: ['event-type', 'category', 'action'] }, // the hierarchy was unavailable
      AT,
    );
    expect(report.verified).toBe(false);
    expect(report.valid).toBe(false);
    expect(permitsActivation(report)).toBe(false);
    expect(report.issues.some((i) => i.code === 'unverified-reference')).toBe(true);
  });

  it('requires only the checks the rule actually needs', () => {
    // A tenant-wide rule references no location, so an unreachable hierarchy does not block it.
    const report = validateRule(rule(), { checked: ['event-type', 'category', 'action'] }, AT);
    expect(report.verified).toBe(true);
  });

  it('warns rather than blocks when a scope is real but empty', () => {
    const report = validateRule(
      rule({ scope: scoped(['on_new_building']) }),
      { ...fullyChecked, resolvedZoneIds: [] },
      AT,
    );
    // Scoping a rule ahead of installing the cameras is legitimate; the product should not argue.
    expect(report.valid).toBe(true);
    expect(report.issues.some((i) => i.code === 'empty-scope' && i.severity === 'warning')).toBe(
      true,
    );
  });

  it('reports the version it describes, so a later edit needs its own report', () => {
    expect(validateRule(rule({ version: 7 }), fullyChecked, AT).ruleVersion).toBe(7);
  });
});

describe('compiled rule sets', () => {
  it('orders by priority then id, and bounds the set', () => {
    const rules = [
      rule({ id: 'b', priority: 50 }),
      rule({ id: 'a', priority: 100 }),
      rule({ id: 'c', priority: 100 }),
    ];
    const compiled = compileRules('tnt_a', rules, 10);
    expect(compiled.rules.map((r) => r.rule.id)).toEqual(['a', 'c', 'b']);
    expect(compileRules('tnt_a', rules, 2).rules).toHaveLength(2);
  });

  it('expands each rule s scope once, into sets', () => {
    const compiled = compileRules(
      'tnt_a',
      [
        rule({
          scope: scoped(['on_london']),
          resolvedScope: {
            zoneIds: ['z1', 'z2'],
            cameraIds: [],
            tenantWide: false,
            resolvedAt: AT.toISOString(),
          },
        }),
      ],
      10,
    );
    expect(compiled.rules[0]!.scope.zoneIds.has('z1')).toBe(true);
    expect(compiled.rules[0]!.scope.tenantWide).toBe(false);
  });

  it('compiles an unresolved scoped rule to match nothing', () => {
    const compiled = compileRules('tnt_a', [rule({ scope: scoped(['on_london']) })], 10);
    expect(compiled.rules[0]!.scope.unresolved).toBe(true);
    expect(matchesScope(compiled.rules[0]!.scope, personEvent())).toBe(false);
  });
});

/**
 * The structured evaluation tree (P-4.1, Architect rec 6).
 *
 * The tree is a **projection of the same evaluation** the summary is read from, not a second one. What
 * these protect is that the two never disagree — a summary blaming the scope beside a tree whose scope
 * node is green is worse than either alone, because a reader has no way to tell which is lying.
 */
describe('the evaluation tree', () => {
  const stages = (over: Partial<Record<string, boolean>> = {}) => ({
    lifecyclePassed: true,
    scopePassed: true,
    prefilterPassed: true,
    conditionPassed: true,
    windowPassed: true,
    ...over,
  });

  const base = {
    ruleId: 'r1',
    ruleVersion: 1,
    ruleName: 'r',
    scopeReason: 'the rule applies tenant-wide',
    prefilterReason: 'the event type and category match the rule',
  };

  it('reports every stage in the order the engine applies them', () => {
    const result = explain({ ...base, stages: stages() });
    expect(result.tree.map((node) => node.stage)).toEqual([
      'lifecycle',
      'scope',
      'prefilter',
      'condition',
      'window',
    ]);
  });

  it('marks exactly the stage that decided, and agrees with the summary', () => {
    const result = explain({ ...base, stages: stages({ scopePassed: false }) });
    const decisive = result.tree.filter((node) => node.decisive);
    expect(decisive).toHaveLength(1);
    expect(decisive[0]?.stage).toBe('scope');
    expect(result.decidedBy).toBe('scope');
    // The one-liner is the decisive node's reason — one source, two renderings.
    expect(result.summary).toBe(decisive[0]?.reason);
  });

  it('marks the first failure decisive, not the last', () => {
    const result = explain({
      ...base,
      stages: stages({ scopePassed: false, conditionPassed: false }),
    });
    expect(result.tree.find((node) => node.decisive)?.stage).toBe('scope');
  });

  it('marks nothing decisive on a match, because every stage was', () => {
    const result = explain({ ...base, stages: stages() });
    expect(result.tree.some((node) => node.decisive)).toBe(false);
    expect(result.matched).toBe(true);
  });

  it('hangs the condition tree under its own stage, and nowhere else', () => {
    const condition = explainCondition(
      { field: 'confidence', op: 'gte', value: 0.8 },
      personEvent({ confidence: 0.71 }),
    );
    const result = explain({ ...base, stages: stages({ conditionPassed: false }), condition });
    const conditionNode = result.tree.find((node) => node.stage === 'condition');
    expect(conditionNode?.children).toEqual([condition]);
    expect(result.tree.filter((node) => node.children).length).toBe(1);
  });

  it('carries a tree through a dry-run, so a viewer has one shape to render', async () => {
    const store = new InMemoryRuleStore({ now: () => AT });
    const service = new RuleService({ store });
    const rule = await service.create(TenantScope.fromTenantId('tnt_a'), personRuleInput());
    const result = await service.dryRun(
      TenantScope.fromTenantId('tnt_a'),
      rule.id,
      personEvent({ confidence: 0.2 }),
    );
    expect(result.explanation?.tree.find((n) => n.decisive)?.stage).toBe('condition');
  });
});
