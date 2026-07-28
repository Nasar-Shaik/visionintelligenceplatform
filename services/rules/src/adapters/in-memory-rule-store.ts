/**
 * A DB-free `RuleStore` for unit tests and local wiring. Enforces the same tenant scoping and the
 * same versioning/audit behaviour as the Mongo adapter (shared domain factory), so the CRUD + engine
 * logic is provable without a database.
 */
import type { CreateRuleInput, Rule, RuleVersionRecord, UpdateRuleInput } from '@vip/contracts';
import { TenancyError, type TenantScope } from '@vip/tenancy';
import { applyUpdate, newRule, versionRecord } from '../domain/rule-factory.js';
import { byEvaluationOrder } from '../domain/rule-evaluator.js';
import type { RuleStore } from '../application/ports.js';

export interface InMemoryRuleStoreDeps {
  now?: () => Date;
  newId?: () => string;
}

export class InMemoryRuleStore implements RuleStore {
  private readonly rules: Rule[] = [];
  private readonly versions: RuleVersionRecord[] = [];
  private readonly now: () => Date;
  private readonly newId: () => string;
  private seq = 0;

  constructor(deps: InMemoryRuleStoreDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => `rule_${++this.seq}`);
  }

  private get factoryDeps() {
    return { now: this.now, newId: this.newId };
  }

  private ownedBy(scope: TenantScope, rule: Rule): boolean {
    return rule.tenantId === scope.tenantId;
  }

  async create(scope: TenantScope, input: CreateRuleInput, actor?: string): Promise<Rule> {
    const { rule, version } = newRule(scope.tenantId, input, this.factoryDeps, actor);
    this.rules.push(rule);
    this.versions.push(version);
    return rule;
  }

  async get(scope: TenantScope, id: string): Promise<Rule | null> {
    return this.rules.find((r) => r.id === id && this.ownedBy(scope, r)) ?? null;
  }

  async list(scope: TenantScope): Promise<Rule[]> {
    return this.rules.filter((r) => this.ownedBy(scope, r)).sort(byEvaluationOrder);
  }

  async listEnabled(scope: TenantScope): Promise<Rule[]> {
    return this.rules
      .filter((r) => this.ownedBy(scope, r) && r.lifecycle === 'enabled')
      .sort(byEvaluationOrder);
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: UpdateRuleInput,
    actor?: string,
  ): Promise<Rule | null> {
    const idx = this.rules.findIndex((r) => r.id === id && this.ownedBy(scope, r));
    if (idx === -1) return null;
    const { rule, version } = applyUpdate(this.rules[idx]!, patch, this.factoryDeps, actor);
    if (rule.tenantId !== scope.tenantId) throw new TenancyError('cross-tenant write refused');
    this.rules[idx] = rule;
    this.versions.push(version);
    return rule;
  }

  async remove(scope: TenantScope, id: string, actor?: string): Promise<boolean> {
    const idx = this.rules.findIndex((r) => r.id === id && this.ownedBy(scope, r));
    if (idx === -1) return false;
    const snapshot: Rule = { ...this.rules[idx]!, version: this.rules[idx]!.version + 1 };
    this.versions.push(versionRecord(snapshot, 'deleted', actor, this.now().toISOString()));
    this.rules.splice(idx, 1);
    return true;
  }

  async listVersions(scope: TenantScope, id: string): Promise<RuleVersionRecord[]> {
    return this.versions
      .filter((v) => v.ruleId === id && v.tenantId === scope.tenantId)
      .sort((a, b) => b.version - a.version);
  }
}
