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
  RuleDryRunResult,
  RuleReferenceKind,
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
import { explain, explainCondition } from '../domain/explain.js';
import { permitsActivation, validateRule, type ReferenceFindings } from '../domain/validation.js';
import { badRequest, notFound } from './errors.js';
import type { CameraDirectory, HierarchyProvider, RuleStore } from './ports.js';
import { unavailableCameraDirectory, unavailableHierarchy } from './ports.js';

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
}

export class RuleService {
  private readonly store: RuleStore;
  private readonly hierarchy: HierarchyProvider;
  private readonly cameras: CameraDirectory;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly dedupWindowMs: number;
  private readonly onRulesChanged: (tenantId: string) => void;

  constructor(deps: RuleServiceDeps) {
    this.store = deps.store;
    this.hierarchy = deps.hierarchy ?? unavailableHierarchy;
    this.cameras = deps.cameras ?? unavailableCameraDirectory;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.dedupWindowMs = deps.dedupWindowMs ?? 60_000;
    this.onRulesChanged = deps.onRulesChanged ?? (() => {});
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
   * **Enabling is gated on a passing validation** (Architect P-4 rec 5): a rule may only be moved to
   * `enabled` when its *current* version validates clean. Validation runs here rather than trusting a
   * stored report, because the patch itself may be what invalidates the rule — re-scoping to a zone
   * that no longer exists in the same request that enables it is precisely the case a stored report
   * would wave through.
   *
   * Any other transition is unrestricted. An author must be able to disable or archive a broken rule
   * without first making it valid, which is the opposite requirement and easy to break by symmetry.
   */
  async update(
    scope: TenantScope,
    id: string,
    patch: UpdateRuleInput,
    actor?: string,
  ): Promise<Rule> {
    const current = await this.store.get(scope, id);
    if (!current) throw notFound(`rule ${id} not found`);

    let resolution: ResolvedRuleScope | undefined;
    if (patch.lifecycle === 'enabled' && current.lifecycle !== 'enabled') {
      const candidate = { ...current, ...stripUndefined(patch) } as Rule;
      const report = await this.buildValidation(scope, candidate);
      if (!permitsActivation(report)) {
        const blocking = report.issues.filter((i) => i.severity === 'error');
        throw badRequest(
          `this rule cannot be enabled: ${blocking.map((i) => i.message).join('; ') || 'validation did not pass'}`,
        );
      }
      /*
       * Resolve **as part of enabling**, in the same version.
       *
       * Without this a scoped rule would go live with no expansion, and `compileScope` treats an
       * absent expansion as tenant-wide — so a rule scoped to one site would fire for the entire
       * estate. Failing open in the direction of *more* alerts, silently. The gate and the expansion
       * are one operation for that reason, not two that happen to be called together.
       */
      resolution = await this.resolveScope(scope, candidate);
    }

    const rule = await this.store.update(scope, id, patch, actor, resolution);
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
