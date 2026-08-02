/**
 * Application: the **compiled rule set** (P-4, Architect rec 12).
 *
 * The engine previously fetched a tenant's enabled rules from Mongo **on every event** and sorted them
 * — a database round trip and a sort per event, recorded as [TD-7]. At a thousand rules and a million
 * events that is a million queries and a million sorts to answer a question whose answer changed
 * twice that day.
 *
 * A compiled set is the tenant's enabled rules prepared once: sorted into evaluation order, bounded to
 * the per-event cap, and with each rule's scope expanded into hash sets. Evaluating an event then
 * touches no store at all.
 *
 * **Correctness is bounded by a TTL, not by hope.** A cache that is only invalidated on write is a
 * cache that is wrong whenever a write happened somewhere else — another replica, an operator using
 * the API directly, a restore from backup. The TTL is short enough that "my rule change took effect
 * within a few seconds" is true without anyone reasoning about topology, and explicit invalidation on
 * a local write makes the common case immediate.
 */
import type { Rule } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { byEvaluationOrder } from '../domain/rule-evaluator.js';
import { compileScope, scopeOf, type CompiledScope } from '../domain/scope.js';
import type { RuleStore } from './ports.js';

/** A rule with everything the hot path needs precomputed. */
export interface CompiledRule {
  readonly rule: Rule;
  readonly scope: CompiledScope;
}

export interface CompiledRuleSet {
  readonly tenantId: string;
  readonly rules: readonly CompiledRule[];
  readonly compiledAt: number;
}

/** Prepare a tenant's rules for evaluation. Pure given the rules — the store call is the caller's. */
export function compileRules(
  tenantId: string,
  rules: readonly Rule[],
  limit: number,
): CompiledRuleSet {
  const ordered = [...rules].sort(byEvaluationOrder).slice(0, limit);
  return {
    tenantId,
    compiledAt: Date.now(),
    rules: ordered.map((rule) => ({
      rule,
      scope: compileScope(rule.resolvedScope, scopeOf(rule)),
    })),
  };
}

export interface RuleSetCacheDeps {
  store: RuleStore;
  maxRulesPerEvent: number;
  /** How long a compiled set may be served before it is rebuilt. */
  ttlMs?: number;
  /** How many tenants to keep compiled. Bounded so one busy node cannot grow without limit. */
  maxTenants?: number;
  now?: () => number;
}

/**
 * A bounded, TTL'd cache of compiled rule sets, keyed by tenant.
 *
 * Deliberately **not** an LRU. Eviction is oldest-compiled-first, which for this workload is the same
 * thing at a fraction of the bookkeeping: a tenant producing events keeps getting recompiled and
 * therefore keeps a recent timestamp, while a tenant that has gone quiet ages out. An LRU would add
 * per-read mutation to the hot path to make a decision that only happens on overflow.
 */
export class RuleSetCache {
  private readonly store: RuleStore;
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly maxTenants: number;
  private readonly now: () => number;
  private readonly sets = new Map<string, CompiledRuleSet>();
  /** In-flight compilations, so a burst of events for a cold tenant issues one query, not hundreds. */
  private readonly inFlight = new Map<string, Promise<CompiledRuleSet>>();

  constructor(deps: RuleSetCacheDeps) {
    this.store = deps.store;
    this.limit = deps.maxRulesPerEvent;
    this.ttlMs = deps.ttlMs ?? 5_000;
    this.maxTenants = deps.maxTenants ?? 1_000;
    this.now = deps.now ?? (() => Date.now());
  }

  /** The tenant's compiled set, rebuilt if absent or stale. */
  async get(scope: TenantScope): Promise<CompiledRuleSet> {
    const cached = this.sets.get(scope.tenantId);
    if (cached && this.now() - cached.compiledAt < this.ttlMs) return cached;

    /*
     * Coalesce concurrent misses. Without this, a cold tenant receiving a burst of events issues one
     * `listEnabled` per event — precisely the per-event query this class exists to remove, reappearing
     * exactly when load is highest.
     */
    const existing = this.inFlight.get(scope.tenantId);
    if (existing) return existing;

    const pending = this.compile(scope).finally(() => this.inFlight.delete(scope.tenantId));
    this.inFlight.set(scope.tenantId, pending);
    return pending;
  }

  private async compile(scope: TenantScope): Promise<CompiledRuleSet> {
    const rules = await this.store.listEnabled(scope);
    const set = { ...compileRules(scope.tenantId, rules, this.limit), compiledAt: this.now() };
    this.sets.set(scope.tenantId, set);
    this.evictIfNeeded();
    return set;
  }

  /** Drop a tenant's compiled set — called on any local write so an edit takes effect immediately. */
  invalidate(tenantId: string): void {
    this.sets.delete(tenantId);
  }

  /** Drop everything. Used by tests and by an operator-triggered reload. */
  clear(): void {
    this.sets.clear();
  }

  get size(): number {
    return this.sets.size;
  }

  private evictIfNeeded(): void {
    if (this.sets.size <= this.maxTenants) return;
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [tenantId, set] of this.sets) {
      if (set.compiledAt < oldestAt) {
        oldestAt = set.compiledAt;
        oldestKey = tenantId;
      }
    }
    if (oldestKey) this.sets.delete(oldestKey);
  }
}
