/**
 * Application: rule authoring use-cases (CRUD + dry-run). Persistence + versioning/audit live in the
 * `RuleStore`; this layer adds the **dry-run** evaluation (no side effects, no state mutation) that
 * authors use to test a rule against a sample event. Kept intentionally lean (P1-7 rec 6 — invest in
 * the engine, not CRUD): create/get/list/update/remove/versions + dry-run, nothing speculative.
 */
import type {
  CreateRuleInput,
  EventEnvelope,
  Rule,
  RuleDryRunResult,
  RuleVersionRecord,
  UpdateRuleInput,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { evaluateRule } from '../domain/rule-evaluator.js';
import { buildIncidentCandidate, raisesIncident } from '../domain/incident.js';
import { notFound } from './errors.js';
import type { RuleStore } from './ports.js';

export interface RuleServiceDeps {
  store: RuleStore;
  now?: () => Date;
  newId?: () => string;
  dedupWindowMs?: number;
}

export class RuleService {
  private readonly store: RuleStore;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly dedupWindowMs: number;

  constructor(deps: RuleServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.dedupWindowMs = deps.dedupWindowMs ?? 60_000;
  }

  create(scope: TenantScope, input: CreateRuleInput, actor?: string): Promise<Rule> {
    return this.store.create(scope, input, actor);
  }

  async get(scope: TenantScope, id: string): Promise<Rule> {
    const rule = await this.store.get(scope, id);
    if (!rule) throw notFound(`rule ${id} not found`);
    return rule;
  }

  list(scope: TenantScope): Promise<Rule[]> {
    return this.store.list(scope);
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: UpdateRuleInput,
    actor?: string,
  ): Promise<Rule> {
    const rule = await this.store.update(scope, id, patch, actor);
    if (!rule) throw notFound(`rule ${id} not found`);
    return rule;
  }

  async remove(scope: TenantScope, id: string, actor?: string): Promise<void> {
    const ok = await this.store.remove(scope, id, actor);
    if (!ok) throw notFound(`rule ${id} not found`);
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
    const { prefilterPassed, conditionPassed } = evaluateRule(rule, event);
    // Dry-run sees a single event → windowed threshold passes only if it needs ≤ 1 hit.
    const windowPassed = !rule.window || rule.window.count <= 1;
    const matched = prefilterPassed && conditionPassed && windowPassed;
    const result: RuleDryRunResult = {
      matched,
      evaluation: { prefilterPassed, conditionPassed, windowPassed },
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
