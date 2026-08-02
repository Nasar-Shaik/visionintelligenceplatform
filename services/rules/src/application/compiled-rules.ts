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
import type { Rule, RuleCacheStats } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { byEvaluationOrder } from '../domain/rule-evaluator.js';
import { compileScope, scopeOf, type CompiledScope } from '../domain/scope.js';
import type { RuleCounter, RuleStatsRegistry } from './rule-stats.js';
import type { RuleStore } from './ports.js';

/** A rule with everything the hot path needs precomputed. */
export interface CompiledRule {
  readonly rule: Rule;
  readonly scope: CompiledScope;
  /**
   * This rule's durable counters, resolved once here so the engine increments a field it already has
   * (P-4.1). The counters are owned by the registry, not by the compiled set — otherwise every
   * recompilation would reset them.
   */
  readonly stats?: RuleCounter | undefined;
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
  stats?: RuleStatsRegistry,
): CompiledRuleSet {
  const ordered = [...rules].sort(byEvaluationOrder).slice(0, limit);
  return {
    tenantId,
    compiledAt: Date.now(),
    rules: ordered.map((rule) => ({
      rule,
      scope: compileScope(rule.resolvedScope, scopeOf(rule)),
      stats: stats?.counterFor(tenantId, rule),
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
  /** Durable per-rule counters to attach at compile time (P-4.1). Absent = no per-rule stats. */
  stats?: RuleStatsRegistry;
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
  private readonly stats: RuleStatsRegistry | undefined;
  private readonly sets = new Map<string, CompiledRuleSet>();
  /** In-flight compilations, so a burst of events for a cold tenant issues one query, not hundreds. */
  private readonly inFlight = new Map<string, Promise<CompiledRuleSet>>();
  /** Operational counters (P-4.1, Architect rec 8). Read by `/rules/stats`, never by evaluation. */
  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private compilations = 0;
  private evictions = 0;
  private totalCompileMicros = 0;
  private maxCompileMicros = 0;
  private lastCompiledAt = 0;

  constructor(deps: RuleSetCacheDeps) {
    this.store = deps.store;
    this.limit = deps.maxRulesPerEvent;
    this.ttlMs = deps.ttlMs ?? 5_000;
    this.maxTenants = deps.maxTenants ?? 1_000;
    this.stats = deps.stats;
    this.now = deps.now ?? (() => Date.now());
  }

  /** The tenant's compiled set, rebuilt if absent or stale. */
  async get(scope: TenantScope): Promise<CompiledRuleSet> {
    const cached = this.sets.get(scope.tenantId);
    if (cached && this.now() - cached.compiledAt < this.ttlMs) {
      this.hits += 1;
      return cached;
    }
    this.misses += 1;

    /*
     * Coalesce concurrent misses. Without this, a cold tenant receiving a burst of events issues one
     * `listEnabled` per event — precisely the per-event query this class exists to remove, reappearing
     * exactly when load is highest.
     */
    const existing = this.inFlight.get(scope.tenantId);
    if (existing) {
      this.coalesced += 1;
      return existing;
    }

    const pending = this.compile(scope).finally(() => this.inFlight.delete(scope.tenantId));
    this.inFlight.set(scope.tenantId, pending);
    return pending;
  }

  /**
   * Compile a tenant's rules **now**, whatever the cache holds (P-4.1, Architect rec 5).
   *
   * Called after an authoring write so the first live event never pays the compilation. It replaces
   * `invalidate` at the composition root: dropping the set leaves the next event to rebuild it, which
   * is the one event most likely to be the one the author is watching for.
   *
   * Deliberately routed through `inFlight` rather than compiling directly, so a warm-up racing an
   * event for the same tenant still issues one query.
   */
  async refresh(scope: TenantScope): Promise<CompiledRuleSet> {
    const existing = this.inFlight.get(scope.tenantId);
    if (existing) return existing;
    const pending = this.compile(scope).finally(() => this.inFlight.delete(scope.tenantId));
    this.inFlight.set(scope.tenantId, pending);
    return pending;
  }

  private async compile(scope: TenantScope): Promise<CompiledRuleSet> {
    const startedAt = performance.now();
    const rules = await this.store.listEnabled(scope);
    const set = {
      ...compileRules(scope.tenantId, rules, this.limit, this.stats),
      compiledAt: this.now(),
    };
    this.sets.set(scope.tenantId, set);
    /*
     * Timed around the store call as well as the compilation. The number an operator needs is "how
     * long is a cold tenant's first event delayed", and excluding the query would answer a question
     * nobody is asking.
     */
    const micros = (performance.now() - startedAt) * 1000;
    this.compilations += 1;
    this.totalCompileMicros += micros;
    if (micros > this.maxCompileMicros) this.maxCompileMicros = micros;
    this.lastCompiledAt = set.compiledAt;
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

  /** Cache health for one tenant on this node (Architect rec 8). */
  statsFor(tenantId: string): RuleCacheStats {
    const lookups = this.hits + this.misses;
    const report: RuleCacheStats = {
      tenants: this.sets.size,
      rules: this.sets.get(tenantId)?.rules.length ?? 0,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      compilations: this.compilations,
      evictions: this.evictions,
      // Zero lookups is zero, never a fabricated 1 — an untested cache is not a perfect cache.
      hitRatio: lookups > 0 ? this.hits / lookups : 0,
      avgCompileMicros: this.compilations > 0 ? this.totalCompileMicros / this.compilations : 0,
      maxCompileMicros: this.maxCompileMicros,
    };
    if (this.lastCompiledAt > 0)
      report.lastCompiledAt = new Date(this.lastCompiledAt).toISOString();
    return report;
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
    if (oldestKey) {
      this.sets.delete(oldestKey);
      this.evictions += 1;
    }
  }
}
