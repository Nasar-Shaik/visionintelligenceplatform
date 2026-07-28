/**
 * Application ports — the seams the rules service depends on, so the CRUD + engine logic is testable
 * without Mongo/Redis/NATS. `RuleStore` persists tenant-scoped rules + their immutable version
 * history; `RuleStateStore` holds bounded, tenant-scoped windowed-threshold state. Concrete Mongo /
 * (future) Redis adapters are wired by the composition root.
 */
import type { CreateRuleInput, Rule, RuleVersionRecord, UpdateRuleInput } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';

export interface RuleStore {
  create(scope: TenantScope, input: CreateRuleInput, actor?: string): Promise<Rule>;
  get(scope: TenantScope, id: string): Promise<Rule | null>;
  list(scope: TenantScope): Promise<Rule[]>;
  /** Rules the engine should evaluate (lifecycle === 'enabled'), for a tenant. */
  listEnabled(scope: TenantScope): Promise<Rule[]>;
  update(
    scope: TenantScope,
    id: string,
    patch: UpdateRuleInput,
    actor?: string,
  ): Promise<Rule | null>;
  remove(scope: TenantScope, id: string, actor?: string): Promise<boolean>;
  listVersions(scope: TenantScope, id: string): Promise<RuleVersionRecord[]>;
}

export interface RuleStateStore {
  /**
   * Record one hit for `key` at `now` and return how many hits fall within the last
   * `windowSeconds`. Backs windowed thresholds ("≥ N within W"). Bounded + tenant-prefixed.
   */
  hitAndCount(key: string, windowSeconds: number, now: Date): Promise<number>;
}
