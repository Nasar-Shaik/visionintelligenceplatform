/**
 * Application: rule authoring use-cases (CRUD + dry-run). Persistence + versioning/audit live in the
 * `RuleStore`; this layer adds the **dry-run** evaluation (no side effects, no state mutation) that
 * authors use to test a rule against a sample event. Kept intentionally lean (P1-7 rec 6 — invest in
 * the engine, not CRUD): create/get/list/update/remove/versions + dry-run, nothing speculative.
 */
import type {
  CreateRuleInput,
  EventEnvelope,
  ResolvedRuleScope,
  Rule,
  RuleAuditEntry,
  RuleCompilation,
  RuleDependencyGraph,
  RuleDependents,
  RuleDryRunResult,
  RuleImportResult,
  RulePackage,
  RuleReferenceKind,
  RuleSimulationInput,
  RuleSimulationResult,
  RuleStatsReport,
  RuleValidationReport,
  RuleVersionRecord,
  UpdateRuleInput,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { evaluateRule } from '../domain/rule-evaluator.js';
import { buildIncidentCandidate, raisesIncident } from '../domain/incident.js';
import {
  compileScope,
  explainScope,
  isTenantWide,
  matchesScope,
  scopeOf,
} from '../domain/scope.js';
import { deriveAudit } from '../domain/audit.js';
import { ruleDependencies } from '../domain/dependencies.js';
import {
  COMPILER_VERSION,
  ENGINE_VERSION,
  contentHash,
  dependencyHash,
  scopeHash,
  validationHash,
} from '../domain/fingerprint.js';
import { explain, explainCondition } from '../domain/explain.js';
import { permitsActivation, validateRule, type ReferenceFindings } from '../domain/validation.js';
import { badRequest, notFound, notImplemented } from './errors.js';
import type { CameraDirectory, HierarchyProvider, RuleDiagnostics, RuleStore } from './ports.js';
import { unavailableCameraDirectory, unavailableHierarchy } from './ports.js';

/** The format version of an exported `RulePackage`. Bumped only when the envelope shape changes. */
const PACKAGE_VERSION = '1.0.0';

/**
 * Patch keys that change what a rule *does*, as opposed to what state it is in.
 *
 * The distinction is what the activation gate turns on: editing any of these while a rule is live is
 * a change to live behaviour and has to be validated, whereas moving lifecycle is not.
 */
const CONTENT_KEYS = [
  'name',
  'description',
  'priority',
  'eventTypes',
  'categories',
  'condition',
  'window',
  'severity',
  'actions',
  'scope',
] as const satisfies readonly (keyof UpdateRuleInput)[];

function touchesContent(patch: UpdateRuleInput): boolean {
  return CONTENT_KEYS.some((key) => patch[key] !== undefined);
}

export interface RuleServiceDeps {
  store: RuleStore;
  /** Reads the Location Hierarchy at validation time. Defaults to unavailable — never to "fine". */
  hierarchy?: HierarchyProvider;
  /** Reads the camera inventory at validation time. Defaults to unavailable. */
  cameras?: CameraDirectory;
  now?: () => Date;
  newId?: () => string;
  dedupWindowMs?: number;
  /**
   * Called after any write that could change what the engine evaluates (P-4).
   *
   * A **callback, not a dependency on the engine**: the authoring service must not know that an
   * evaluation cache exists, and the composition root is the right place to know both. Without it a
   * newly created or enabled rule is invisible until the compiled set expires — an author sees "saved"
   * and nothing happens for seconds, which reads as the product being broken.
   */
  onRulesChanged?: (tenantId: string) => void;
  /**
   * Live cache and per-rule counters, supplied by the composition root (P-4.1).
   *
   * A port rather than a reference to the engine, for the same reason `onRulesChanged` is a callback.
   * Absent when this node does not evaluate — and then `stats()` says so instead of reporting zeroes.
   */
  diagnostics?: RuleDiagnostics;
}

export class RuleService {
  private readonly store: RuleStore;
  private readonly hierarchy: HierarchyProvider;
  private readonly cameras: CameraDirectory;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly dedupWindowMs: number;
  private readonly onRulesChanged: (tenantId: string) => void;
  private readonly diagnostics: RuleDiagnostics | undefined;

  constructor(deps: RuleServiceDeps) {
    this.store = deps.store;
    this.hierarchy = deps.hierarchy ?? unavailableHierarchy;
    this.cameras = deps.cameras ?? unavailableCameraDirectory;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.dedupWindowMs = deps.dedupWindowMs ?? 60_000;
    this.onRulesChanged = deps.onRulesChanged ?? (() => {});
    this.diagnostics = deps.diagnostics;
  }

  async create(scope: TenantScope, input: CreateRuleInput, actor?: string): Promise<Rule> {
    const rule = await this.store.create(scope, input, actor);
    this.onRulesChanged(scope.tenantId);
    return rule;
  }

  async get(scope: TenantScope, id: string): Promise<Rule> {
    const rule = await this.store.get(scope, id);
    if (!rule) throw notFound(`rule ${id} not found`);
    return rule;
  }

  list(scope: TenantScope): Promise<Rule[]> {
    return this.store.list(scope);
  }

  /**
   * Update a rule.
   *
   * **Live behaviour is gated on a passing validation** (Architect P-4 rec 5, corrected in P-4.1). The
   * gate fires in two cases, and P-4 only had the first:
   *
   * 1. **Moving a rule into `enabled`.** Validated against the patched rule rather than a stored
   *    report, because the patch itself may be what invalidates it — re-scoping to a zone that no
   *    longer exists in the same request that enables it is precisely what a stored report waves
   *    through.
   * 2. **Editing a rule that is already `enabled`.** P-4 checked only the transition, which left the
   *    larger hole: an operator could re-scope a live rule to a deleted zone and the change would be
   *    accepted. Worse, re-scoping drops the expansion by design, so the rule went to `unresolved` and
   *    **matched nothing** — a live rule silently stopped firing, and nothing in the product said so.
   *    The transition is not the dangerous moment; putting unvalidated content in front of live events
   *    is, however it got there.
   *
   * Everything else is unrestricted. An author must be able to disable or archive a broken rule
   * without first making it valid — the opposite requirement, and easy to break by symmetry.
   */
  async update(
    scope: TenantScope,
    id: string,
    patch: UpdateRuleInput,
    actor?: string,
  ): Promise<Rule> {
    const current = await this.store.get(scope, id);
    if (!current) throw notFound(`rule ${id} not found`);

    /*
     * What matters is the lifecycle the rule *ends up in*. An operator fixing a broken live rule by
     * editing and disabling it in one request must not be blocked by a gate protecting live events —
     * after that request there are none.
     */
    const nextLifecycle = patch.lifecycle ?? current.lifecycle;
    const activating = nextLifecycle === 'enabled' && current.lifecycle !== 'enabled';
    const editingLive =
      nextLifecycle === 'enabled' && current.lifecycle === 'enabled' && touchesContent(patch);

    let resolution: ResolvedRuleScope | undefined;
    if (activating || editingLive) {
      const candidate = { ...current, ...stripUndefined(patch) } as Rule;
      const report = await this.buildValidation(scope, candidate);
      if (!permitsActivation(report)) {
        const blocking = report.issues.filter((i) => i.severity === 'error');
        const reasons = blocking.map((i) => i.message).join('; ') || 'validation did not pass';
        throw badRequest(
          activating
            ? `this rule cannot be enabled: ${reasons}`
            : `this change cannot be saved while the rule is enabled — disable it first: ${reasons}`,
        );
      }
      /*
       * Resolve **as part of the same version**.
       *
       * Without this a scoped rule goes live with no expansion, and an absent expansion on a scoped
       * rule matches nothing — a rule the customer explicitly configured, quietly doing nothing. The
       * gate and the expansion are one operation for that reason, not two that happen to be called
       * together.
       */
      resolution = await this.resolveScope(scope, candidate);
    }

    const rule = await this.store.update(scope, id, patch, actor, resolution);
    if (!rule) throw notFound(`rule ${id} not found`);
    this.onRulesChanged(scope.tenantId);
    return rule;
  }

  /**
   * Restore an earlier version's content as a new version (P-4.1, Architect rec 7).
   *
   * **History is appended to, never rewritten**: rolling back to v3 produces v9 whose content equals
   * v3's. The audit trail derives `rolled-back` from that fact, so the timeline shows both the mistake
   * and the correction, which is the only version of events an investigation can use.
   *
   * Rollback is **instant for a rule that is not live** — the target version carries its own scope
   * expansion, so nothing is recomputed and no other context is consulted. A rule that *is* live goes
   * through the same gate as any other edit to live content: restoring content last verified an
   * unknown time ago, against an estate that has changed since, is exactly the situation the gate
   * exists for, and "it used to work" is not a check.
   */
  async rollback(scope: TenantScope, id: string, version: number, actor?: string): Promise<Rule> {
    const current = await this.get(scope, id);
    if (version === current.version) {
      throw badRequest(`rule ${id} is already at version ${version}`);
    }
    const versions = await this.store.listVersions(scope, id);
    const target = versions.find((record) => record.version === version);
    if (!target) throw notFound(`rule ${id} has no version ${version}`);

    let resolution: ResolvedRuleScope | undefined;
    if (current.lifecycle === 'enabled') {
      const candidate: Rule = { ...target.snapshot, id: current.id, version: current.version };
      const report = await this.buildValidation(scope, candidate);
      if (!permitsActivation(report)) {
        const blocking = report.issues.filter((i) => i.severity === 'error');
        throw badRequest(
          `version ${version} cannot be restored while the rule is enabled — disable it first: ${
            blocking.map((i) => i.message).join('; ') || 'validation did not pass'
          }`,
        );
      }
      resolution = await this.resolveScope(scope, candidate);
    }

    const rule = await this.store.restore(scope, id, target.snapshot, actor, resolution);
    if (!rule) throw notFound(`rule ${id} not found`);
    this.onRulesChanged(scope.tenantId);
    return rule;
  }

  /**
   * Validate a rule and return the report. Read-only — it never changes lifecycle.
   *
   * Separated from activation on purpose: an author needs to see what is wrong *before* deciding to
   * go live, and a validation that only ran as a side effect of enabling would make "why can't I
   * enable this?" a guessing game.
   */
  async validate(scope: TenantScope, id: string): Promise<RuleValidationReport> {
    return this.buildValidation(scope, await this.get(scope, id));
  }

  /**
   * Expand a rule's authored scope to the leaf ids the engine matches on.
   *
   * Called at validation time and snapshotted onto the rule version — never per event. See
   * `ResolvedRuleScope` for why the expansion is stored rather than recomputed.
   */
  async resolveScope(scope: TenantScope, rule: Rule): Promise<ResolvedRuleScope> {
    const at = this.now().toISOString();
    const authored = scopeOf(rule);
    if (isTenantWide(authored)) {
      return { zoneIds: [], cameraIds: [], tenantWide: true, resolvedAt: at };
    }
    const resolution = await this.hierarchy.resolveScope(scope, authored.nodeIds);
    return {
      zoneIds: resolution.zoneIds,
      cameraIds: [...authored.cameraIds],
      tenantWide: false,
      resolvedAt: at,
    };
  }

  /** Gather what the owning contexts report, then let the pure domain decide what it means. */
  private async buildValidation(scope: TenantScope, rule: Rule): Promise<RuleValidationReport> {
    // These always run: the event catalog is compiled in, so a rule is never entirely unchecked.
    const checked: RuleReferenceKind[] = ['event-type', 'category', 'action'];
    const findings: ReferenceFindings = { checked };
    const authored = scopeOf(rule);

    if (authored.nodeIds.length > 0) {
      const resolution = await this.hierarchy.resolveScope(scope, authored.nodeIds);
      if (resolution.available) {
        checked.push('location');
        findings.missingNodeIds = resolution.missingNodeIds;
        findings.archivedNodeIds = resolution.archivedNodeIds;
        findings.resolvedZoneIds = resolution.zoneIds;
      }
    }

    if (authored.cameraIds.length > 0) {
      const lookup = await this.cameras.findMissing(scope, authored.cameraIds);
      if (lookup.available) {
        checked.push('camera');
        findings.missingCameraIds = lookup.missingCameraIds;
      }
    }

    return validateRule(rule, findings, this.now());
  }

  async remove(scope: TenantScope, id: string, actor?: string): Promise<void> {
    const ok = await this.store.remove(scope, id, actor);
    if (!ok) throw notFound(`rule ${id} not found`);
    this.onRulesChanged(scope.tenantId);
  }

  listVersions(scope: TenantScope, id: string): Promise<RuleVersionRecord[]> {
    return this.store.listVersions(scope, id);
  }

  /**
   * The rule's lifecycle timeline (P-4.1, Architect rec 12), derived from its versions.
   *
   * No second store, no second write path. See `domain/audit.ts` for why that matters more than the
   * convenience of writing audit rows directly.
   */
  async audit(scope: TenantScope, id: string): Promise<RuleAuditEntry[]> {
    return deriveAudit(await this.store.listVersions(scope, id));
  }

  /** What this rule version points at (Architect rec 2). */
  async dependencies(scope: TenantScope, id: string): Promise<RuleDependencyGraph> {
    const rule = await this.get(scope, id);
    const dependencies = ruleDependencies(rule);
    return {
      ruleId: rule.id,
      ruleVersion: rule.version,
      dependencies,
      dependencyHash: dependencyHash(dependencies),
    };
  }

  /**
   * Which rules depend on one thing — the answer to "is this safe to delete?" (Architect rec 2).
   *
   * For a location this consults the **resolved expansion** as well as the authored scope, and they
   * are reported differently. A rule that names a zone breaks outright if the zone is removed; a rule
   * that merely covers it through an ancestor keeps working with one fewer zone. Collapsing the two
   * would either raise false alarms about every deletion or miss the ones that matter.
   */
  async dependents(
    scope: TenantScope,
    kind: RuleDependents['kind'],
    ref: string,
  ): Promise<RuleDependents> {
    const rules = await this.store.list(scope);
    const matches: RuleDependents['rules'] = [];
    for (const rule of rules) {
      const direct = ruleDependencies(rule).some((d) => d.kind === kind && d.ref === ref);
      const covered =
        !direct && kind === 'location' && (rule.resolvedScope?.zoneIds.includes(ref) ?? false);
      if (!direct && !covered) continue;
      matches.push({ ruleId: rule.id, ruleName: rule.name, lifecycle: rule.lifecycle, direct });
    }
    return { kind, ref, rules: matches };
  }

  /**
   * The rule version's fingerprints (Architect recs 1 + 14).
   *
   * Recomputed on every call rather than read from anywhere. That is not laziness — it is what makes
   * the value trustworthy: a stored hash can end up describing a rule it no longer matches, and this
   * one is, by construction, a statement about the bytes that are there right now.
   */
  async compilation(scope: TenantScope, id: string): Promise<RuleCompilation> {
    const rule = await this.get(scope, id);
    const report = await this.buildValidation(scope, rule);
    return {
      ruleId: rule.id,
      ruleVersion: rule.version,
      compilerVersion: COMPILER_VERSION,
      engineVersion: ENGINE_VERSION,
      compiledHash: contentHash(rule),
      scopeHash: scopeHash(rule),
      dependencyHash: dependencyHash(ruleDependencies(rule)),
      validationHash: validationHash(report),
      compiledAt: this.now().toISOString(),
    };
  }

  /**
   * Operational statistics for this tenant on this node (Architect recs 3 + 8).
   *
   * Fails rather than fabricating when no diagnostics source is wired. A deployment that runs
   * authoring separately from evaluation genuinely has no numbers here, and answering with zeroes
   * would be indistinguishable from a rule that has never fired.
   */
  stats(scope: TenantScope): RuleStatsReport {
    const cache = this.diagnostics?.cacheStats(scope.tenantId);
    if (!this.diagnostics || !cache) {
      throw notImplemented(
        'this node is not evaluating rules, so it has no runtime statistics to report',
      );
    }
    return {
      tenantId: scope.tenantId,
      node: this.diagnostics.node,
      uptimeSeconds: this.diagnostics.uptimeSeconds(),
      cache,
      rules: this.diagnostics.ruleStats(scope.tenantId),
      at: this.now().toISOString(),
    };
  }

  /**
   * Run a rule against events without side effects (Architect rec 9).
   *
   * The supplied-events form is implemented because it is a dry-run over a list and there is no honest
   * reason to stub something already achievable. Replay over stored history returns **501**: the event
   * archive belongs to another context, and reaching into it from here is a decision that deserves its
   * own design rather than arriving as a side effect of a rule feature. The contract for both is frozen
   * now so neither becomes a breaking change.
   */
  async simulate(
    scope: TenantScope,
    id: string,
    input: RuleSimulationInput,
  ): Promise<RuleSimulationResult> {
    if (input.range && !input.events) {
      throw notImplemented(
        'simulating over stored history is not implemented — supply the events to run against',
      );
    }
    const events = input.events ?? [];
    if (events.length === 0) throw badRequest('supply at least one event to simulate against');

    const rule = await this.get(scope, id);
    const outcomes: RuleSimulationResult['outcomes'] = [];
    const decidedBy: Record<string, number> = {};
    let matched = 0;

    for (const event of events) {
      const result = this.evaluateForDryRun(rule, event);
      if (result.matched) matched += 1;
      const explanation = result.explanation;
      if (!explanation) continue;
      decidedBy[explanation.decidedBy] = (decidedBy[explanation.decidedBy] ?? 0) + 1;
      outcomes.push({ eventId: event.id, matched: result.matched, explanation });
    }

    return {
      ruleId: rule.id,
      ruleVersion: rule.version,
      evaluated: events.length,
      matched,
      outcomes,
      decidedBy,
      at: this.now().toISOString(),
    };
  }

  /**
   * Export a tenant's rules as a portable package (Architect recs 10 + 14).
   *
   * Carries authored content and each rule's dependencies — not ids, not the resolved scope, not
   * timestamps. The dependencies are the part that does not travel: a node id names one place in the
   * tenant it came from and nothing at all in the tenant it lands in, so naming the references
   * explicitly is what turns a silent mis-import into a validation report.
   */
  async exportRules(scope: TenantScope, node?: string): Promise<RulePackage> {
    const rules = await this.store.list(scope);
    return {
      packageVersion: PACKAGE_VERSION,
      compilerVersion: COMPILER_VERSION,
      exportedAt: this.now().toISOString(),
      source: { tenantId: scope.tenantId, ...(node ? { node } : {}) },
      rules: rules.map((rule) => ({
        sourceRuleId: rule.id,
        sourceVersion: rule.version,
        rule: toCreateInput(rule),
        dependencies: ruleDependencies(rule),
        compiledHash: contentHash(rule),
      })),
    };
  }

  /**
   * Import a package (Architect rec 10).
   *
   * Every imported rule lands as a **draft**, whatever state it was exported in. A package is a file,
   * a file arrives from somewhere, and activating rules that arrived from somewhere is how an estate
   * starts alerting on a configuration nobody in the room chose. Each one comes back with its
   * validation report, so the references that did not survive the journey are visible before anyone
   * decides to enable it.
   *
   * One rule failing does not abort the rest. A partial import that says exactly what it did is more
   * useful than an all-or-nothing one that leaves the operator to work out why.
   */
  async importRules(
    scope: TenantScope,
    pkg: RulePackage,
    actor?: string,
  ): Promise<RuleImportResult> {
    const results: RuleImportResult['results'] = [];
    let imported = 0;
    let rejected = 0;

    for (const entry of pkg.rules) {
      try {
        const rule = await this.store.create(scope, { ...entry.rule, lifecycle: 'draft' }, actor);
        imported += 1;
        results.push({
          sourceRuleId: entry.sourceRuleId,
          ruleId: rule.id,
          created: true,
          validation: await this.buildValidation(scope, rule),
        });
      } catch (err) {
        rejected += 1;
        results.push({
          sourceRuleId: entry.sourceRuleId,
          created: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (imported > 0) this.onRulesChanged(scope.tenantId);
    return { imported, rejected, results, at: this.now().toISOString() };
  }

  /** Evaluate a stored rule against a sample event WITHOUT emitting or touching state. */
  async dryRun(scope: TenantScope, id: string, event: EventEnvelope): Promise<RuleDryRunResult> {
    const rule = await this.get(scope, id);
    return this.evaluateForDryRun(rule, event);
  }

  private evaluateForDryRun(rule: Rule, event: EventEnvelope): RuleDryRunResult {
    const compiled = compileScope(rule.resolvedScope, scopeOf(rule));
    const scopePassed = matchesScope(compiled, event);
    const { prefilterPassed, conditionPassed } = evaluateRule(rule, event);
    // Dry-run sees a single event → windowed threshold passes only if it needs ≤ 1 hit.
    const windowPassed = !rule.window || rule.window.count <= 1;
    const matched = scopePassed && prefilterPassed && conditionPassed && windowPassed;

    const explanation = explain({
      ruleId: rule.id,
      ruleVersion: rule.version,
      ruleName: rule.name,
      stages: {
        // A dry-run deliberately ignores lifecycle: an author tests a draft before enabling it, and
        // reporting "not enabled" there would answer a question nobody asked.
        lifecyclePassed: true,
        scopePassed,
        prefilterPassed,
        conditionPassed,
        windowPassed,
      },
      scopeReason: explainScope(compiled, event),
      prefilterReason: prefilterReason(rule, event),
      ...(rule.condition ? { condition: explainCondition(rule.condition, event) } : {}),
      ...(rule.window
        ? {
            window: {
              counted: 1,
              required: rule.window.count,
              withinSeconds: rule.window.withinSeconds,
            },
          }
        : {}),
    });

    const result: RuleDryRunResult = {
      matched,
      evaluation: { prefilterPassed, conditionPassed, windowPassed },
      explanation,
    };
    if (matched && raisesIncident(rule)) {
      result.candidate = buildIncidentCandidate(rule, event, 1, this.dedupWindowMs, {
        newId: this.newId,
        now: this.now,
      });
    }
    return result;
  }
}

/**
 * A stored rule reduced to what an author wrote.
 *
 * Everything the platform assigned — id, tenant, version, timestamps, the resolved expansion — is left
 * behind. A package that carried them would import a rule claiming to be from a tenant it is not in and
 * covering zones that do not exist there.
 */
function toCreateInput(rule: Rule): CreateRuleInput {
  const input: CreateRuleInput = {
    name: rule.name,
    lifecycle: rule.lifecycle,
    priority: rule.priority,
    eventTypes: [...rule.eventTypes],
    categories: [...rule.categories],
    severity: rule.severity,
    actions: [...rule.actions],
    scope: scopeOf(rule),
  };
  if (rule.description !== undefined) input.description = rule.description;
  if (rule.condition !== undefined) input.condition = rule.condition;
  if (rule.window !== undefined) input.window = rule.window;
  return input;
}

/** Why the type/category pre-filter came out as it did. */
function prefilterReason(rule: Rule, event: EventEnvelope): string {
  const typeOk = rule.eventTypes.length === 0 || rule.eventTypes.includes(event.type);
  if (!typeOk) {
    return `the event is "${event.type}", and the rule only matches ${rule.eventTypes.join(', ')}`;
  }
  const catOk = rule.categories.length === 0 || rule.categories.includes(event.category);
  if (!catOk) {
    return `the event is in category "${event.category}", and the rule only matches ${rule.categories.join(', ')}`;
  }
  return 'the event type and category match the rule';
}

/**
 * Drop `undefined` values so a patch merged onto a rule cannot blank a field it did not mention.
 * `{ ...rule, ...patch }` with an explicit `undefined` would erase — a spread does not skip it.
 */
function stripUndefined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}
