/**
 * Adapter: `RuleStore` over MongoDB, routed through the @vip/tenancy `TenantRepository` so every
 * read/write is tenant-scoped structurally. Create/update produce both the current rule and an
 * immutable `rule_versions` audit row (versioning + audit, RULE_ENGINE §Security). Reads never cross
 * tenants; `listEnabled` returns only `lifecycle === 'enabled'` rules for the engine.
 */
import type { Collection } from 'mongodb';
import type { CreateRuleInput, Rule, RuleVersionRecord, UpdateRuleInput } from '@vip/contracts';
import { TenantRepository, type TenantScope } from '@vip/tenancy';
import { applyUpdate, newRule, versionRecord } from '../domain/rule-factory.js';
import { notFound } from '../application/errors.js';
import type { RuleStore } from '../application/ports.js';

export interface MongoRuleStoreDeps {
  rules: Collection<Rule>;
  versions: Collection<RuleVersionRecord>;
  now?: () => Date;
  newId?: () => string;
}

const STRIP = { projection: { _id: 0 } } as const;

export class MongoRuleStore implements RuleStore {
  private readonly rules: TenantRepository<Rule>;
  private readonly versions: TenantRepository<RuleVersionRecord>;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: MongoRuleStoreDeps) {
    this.rules = new TenantRepository<Rule>(deps.rules);
    this.versions = new TenantRepository<RuleVersionRecord>(deps.versions);
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  private get factoryDeps() {
    return { now: this.now, newId: this.newId };
  }

  async create(scope: TenantScope, input: CreateRuleInput, actor?: string): Promise<Rule> {
    const { rule, version } = newRule(scope.tenantId, input, this.factoryDeps, actor);
    await this.rules.insertOne(scope, rule as Omit<Rule, 'tenantId'>);
    await this.versions.insertOne(scope, version as Omit<RuleVersionRecord, 'tenantId'>);
    return rule;
  }

  async get(scope: TenantScope, id: string): Promise<Rule | null> {
    return this.rules.collection.findOne(
      { tenantId: scope.tenantId, id } as never,
      STRIP,
    ) as Promise<Rule | null>;
  }

  async list(scope: TenantScope): Promise<Rule[]> {
    return this.rules.collection
      .find({ tenantId: scope.tenantId } as never, STRIP)
      .sort({ priority: -1, id: 1 })
      .toArray() as Promise<Rule[]>;
  }

  async listEnabled(scope: TenantScope): Promise<Rule[]> {
    return this.rules.collection
      .find({ tenantId: scope.tenantId, lifecycle: 'enabled' } as never, STRIP)
      .sort({ priority: -1, id: 1 })
      .toArray() as Promise<Rule[]>;
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: UpdateRuleInput,
    actor?: string,
  ): Promise<Rule | null> {
    const existing = await this.get(scope, id);
    if (!existing) return null;
    const { rule, version } = applyUpdate(existing, patch, this.factoryDeps, actor);
    const matched = await this.rules.updateOne(scope, { id } as never, { $set: rule } as never);
    if (matched === 0) return null;
    await this.versions.insertOne(scope, version as Omit<RuleVersionRecord, 'tenantId'>);
    return rule;
  }

  async remove(scope: TenantScope, id: string, actor?: string): Promise<boolean> {
    const existing = await this.get(scope, id);
    if (!existing) return false;
    // Record a final 'deleted' audit snapshot (version bumped), then remove the live rule.
    const deletedSnapshot: Rule = { ...existing, version: existing.version + 1 };
    await this.versions.insertOne(
      scope,
      versionRecord(deletedSnapshot, 'deleted', actor, this.now().toISOString()) as Omit<
        RuleVersionRecord,
        'tenantId'
      >,
    );
    const deleted = await this.rules.deleteOne(scope, { id } as never);
    return deleted > 0;
  }

  async listVersions(scope: TenantScope, id: string): Promise<RuleVersionRecord[]> {
    const rows = await this.versions.collection
      .find({ tenantId: scope.tenantId, ruleId: id } as never, STRIP)
      .sort({ version: -1 })
      .toArray();
    if (rows.length === 0) {
      // distinguish "no such rule" from "rule with no history" — a rule always has ≥1 version
      const exists = await this.get(scope, id);
      if (!exists) throw notFound(`rule ${id} not found`);
    }
    return rows as RuleVersionRecord[];
  }
}
