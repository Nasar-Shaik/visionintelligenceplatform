/**
 * Application: **what each rule is actually doing** (P-4.1, Architect rec 3).
 *
 * The operational question a rule author asks is not "is the service healthy" — it is _"is my rule
 * doing anything?"_ A rule that has been evaluated four million times and matched zero is a different
 * problem from one that has never been evaluated at all, and the platform could not tell them apart.
 *
 * Three constraints shaped this:
 *
 * - **The hot path may not pay for a lookup.** Counters are handed to the compiler as objects, and the
 *   engine increments fields on the compiled rule it already holds. No map, no key building, no
 *   allocation per event. That is why the registry hands out `RuleCounter` references rather than
 *   offering a `record(tenantId, ruleId, …)` method — the obvious API would put two hash lookups per
 *   rule per event into the one loop that must not have them.
 * - **Counters must outlive compilation.** The compiled set is rebuilt every few seconds; if the
 *   counters lived on it, every number would reset every TTL and mean nothing. The registry owns them
 *   and compilation only re-attaches.
 * - **Memory is bounded.** A registry keyed by tenant and rule grows with the estate, so both
 *   dimensions are capped and the least recently evaluated entry is dropped on overflow. An
 *   observability feature that can exhaust a node is not an observability feature.
 *
 * **Per process, not per cluster.** This node reports what this node did. Cluster-wide totals are what
 * the Prometheus counters are for; summing these across a load balancer would produce a number that is
 * wrong in a way nobody could detect.
 *
 * Nothing in evaluation reads any of this.
 */
import type { Rule, RuleRuntimeStats } from '@vip/contracts';

/**
 * Mutable counters for one rule, incremented directly by the engine.
 *
 * Public fields rather than methods, deliberately: this is the innermost loop in the service, and a
 * method call per event per rule is a cost with nothing to show for it.
 */
export interface RuleCounter {
  ruleId: string;
  ruleName: string;
  ruleVersion: number;
  evaluations: number;
  matches: number;
  failures: number;
  /** Epoch millis, `0` when it has not happened. */
  lastEvaluatedAt: number;
  lastMatchedAt: number;
  /**
   * When this counter was created. Used only for eviction, never reported.
   *
   * Without it a newly compiled rule is the coldest thing in a full registry — `lastEvaluatedAt` is
   * still `0` — so it would be evicted the instant it was added and never accumulate a single
   * measurement. Reusing `lastEvaluatedAt` as the creation time instead would be worse: the report
   * would then claim a rule was evaluated at a moment nothing evaluated it.
   */
  createdAt: number;
  /** Microseconds summed over evaluations that got past the scope check, and how many those were. */
  totalMicros: number;
  timedEvaluations: number;
  maxMicros: number;
}

function newCounter(rule: Rule, createdAt: number): RuleCounter {
  return {
    createdAt,
    ruleId: rule.id,
    ruleName: rule.name,
    ruleVersion: rule.version,
    evaluations: 0,
    matches: 0,
    failures: 0,
    lastEvaluatedAt: 0,
    lastMatchedAt: 0,
    totalMicros: 0,
    timedEvaluations: 0,
    maxMicros: 0,
  };
}

export interface RuleStatsRegistryDeps {
  /** Tenants tracked on this node. */
  maxTenants?: number;
  /** Rules tracked per tenant. */
  maxRulesPerTenant?: number;
  now?: () => number;
}

export class RuleStatsRegistry {
  private readonly byTenant = new Map<string, Map<string, RuleCounter>>();
  private readonly maxTenants: number;
  private readonly maxRules: number;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(deps: RuleStatsRegistryDeps = {}) {
    this.maxTenants = deps.maxTenants ?? 1_000;
    this.maxRules = deps.maxRulesPerTenant ?? 5_000;
    this.now = deps.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  /**
   * The counter for this rule, created on first sight and reused afterwards.
   *
   * Called at **compile** time, once per rule per recompilation — never per event.
   *
   * A version bump keeps the same counter and updates the name and version on it. Resetting would be
   * defensible and is wrong in practice: an operator watching a rule they just edited wants to see it
   * keep working, not a row that starts again from zero every time they touch it.
   */
  counterFor(tenantId: string, rule: Rule): RuleCounter {
    let rules = this.byTenant.get(tenantId);
    if (!rules) {
      rules = new Map();
      this.byTenant.set(tenantId, rules);
      this.evictTenants();
    }
    const existing = rules.get(rule.id);
    if (existing) {
      existing.ruleName = rule.name;
      existing.ruleVersion = rule.version;
      return existing;
    }
    const counter = newCounter(rule, this.now());
    rules.set(rule.id, counter);
    this.evictRules(rules);
    return counter;
  }

  /** Drop a tenant's counters — used when a rule is deleted and by tests. */
  forget(tenantId: string): void {
    this.byTenant.delete(tenantId);
  }

  clear(): void {
    this.byTenant.clear();
  }

  get uptimeSeconds(): number {
    return (this.now() - this.startedAt) / 1000;
  }

  /**
   * This tenant's counters, as the published contract.
   *
   * Sorted by evaluation count so the rules carrying the load are at the top, which is what an
   * operator opening this is looking for.
   */
  snapshot(tenantId: string): RuleRuntimeStats[] {
    const rules = this.byTenant.get(tenantId);
    if (!rules) return [];
    return [...rules.values()]
      .map((counter) => {
        const stats: RuleRuntimeStats = {
          ruleId: counter.ruleId,
          ruleName: counter.ruleName,
          ruleVersion: counter.ruleVersion,
          evaluations: counter.evaluations,
          matches: counter.matches,
          failures: counter.failures,
          avgEvaluationMicros:
            counter.timedEvaluations > 0 ? counter.totalMicros / counter.timedEvaluations : 0,
          maxEvaluationMicros: counter.maxMicros,
        };
        if (counter.lastEvaluatedAt > 0) {
          stats.lastEvaluatedAt = new Date(counter.lastEvaluatedAt).toISOString();
        }
        if (counter.lastMatchedAt > 0) {
          stats.lastMatchedAt = new Date(counter.lastMatchedAt).toISOString();
        }
        return stats;
      })
      .sort((a, b) => b.evaluations - a.evaluations || a.ruleId.localeCompare(b.ruleId));
  }

  private evictTenants(): void {
    while (this.byTenant.size > this.maxTenants) {
      // Insertion order: the oldest tenant this node has seen goes first.
      const oldest = this.byTenant.keys().next();
      if (oldest.done) return;
      this.byTenant.delete(oldest.value);
    }
  }

  private evictRules(rules: Map<string, RuleCounter>): void {
    while (rules.size > this.maxRules) {
      let coldestId: string | undefined;
      let coldestAt = Infinity;
      for (const [id, counter] of rules) {
        const touched = Math.max(counter.lastEvaluatedAt, counter.createdAt);
        if (touched < coldestAt) {
          coldestAt = touched;
          coldestId = id;
        }
      }
      if (!coldestId) return;
      rules.delete(coldestId);
    }
  }
}
