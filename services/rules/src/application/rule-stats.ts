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
import type { Rule, RuleRuntimeStats, RuleStatsBucket, RuleStatsHistory } from '@vip/contracts';

/**
 * How long one history bucket covers, and how many are kept (P-4.2, Architect rec 7).
 *
 * ⚠️ Twenty-four hourly buckets is a **shift**, not a time series. It answers "has this rule gone
 * quiet since lunchtime?" — a question about one node over one day. Anything longer, anything spanning
 * replicas, and anything used for capacity planning comes from the Prometheus pipeline, which stores
 * history properly. Building a second, worse one here would be the mistake.
 */
export const HISTORY_BUCKET_SECONDS = 3_600;
export const HISTORY_BUCKETS = 24;

/** A closed bucket: what happened in one interval, computed from counter deltas. */
interface ClosedBucket {
  startedAt: number;
  endedAt: number;
  evaluations: number;
  matches: number;
  failures: number;
  totalMicros: number;
  timedEvaluations: number;
}

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
  /**
   * Closed history buckets, oldest first, bounded to `HISTORY_BUCKETS` (P-4.2).
   *
   * Held on the counter rather than in a parallel structure so the ring lives and dies with the thing
   * it describes — a rule evicted from the registry takes its history with it rather than leaking one.
   */
  history: ClosedBucket[];
  /** Counter values when the open bucket began, so a bucket is a delta rather than a running total. */
  bucketStartedAt: number;
  bucketBaseline: {
    evaluations: number;
    matches: number;
    failures: number;
    totalMicros: number;
    timedEvaluations: number;
  };
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
    history: [],
    bucketStartedAt: createdAt,
    bucketBaseline: {
      evaluations: 0,
      matches: 0,
      failures: 0,
      totalMicros: 0,
      timedEvaluations: 0,
    },
  };
}

export interface RuleStatsRegistryDeps {
  /** Tenants tracked on this node. */
  maxTenants?: number;
  /** Rules tracked per tenant. */
  maxRulesPerTenant?: number;
  /** History bucket width, in seconds (P-4.2). */
  bucketSeconds?: number;
  /** How many closed buckets to keep. */
  retainedBuckets?: number;
  now?: () => number;
}

export class RuleStatsRegistry {
  private readonly byTenant = new Map<string, Map<string, RuleCounter>>();
  private readonly maxTenants: number;
  private readonly maxRules: number;
  private readonly bucketMs: number;
  private readonly retainedBuckets: number;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(deps: RuleStatsRegistryDeps = {}) {
    this.maxTenants = deps.maxTenants ?? 1_000;
    this.maxRules = deps.maxRulesPerTenant ?? 5_000;
    this.bucketMs = (deps.bucketSeconds ?? HISTORY_BUCKET_SECONDS) * 1000;
    this.retainedBuckets = deps.retainedBuckets ?? HISTORY_BUCKETS;
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
      // Compile time is the regular heartbeat that closes elapsed history buckets (P-4.2).
      this.roll(existing);
      return existing;
    }
    const counter = newCounter(rule, this.now());
    rules.set(rule.id, counter);
    this.evictRules(rules);
    return counter;
  }

  /**
   * Close any elapsed history buckets (P-4.2).
   *
   * Called at **compile time and read time, never per event** — the same discipline as everything
   * else that touches these counters. A tenant receiving events recompiles at least every TTL, so its
   * buckets close on time; a tenant receiving none has nothing to attribute anyway.
   *
   * ⚠️ **The imprecision this accepts:** if several buckets elapse between rolls, everything measured
   * in that gap is attributed to the first of them. For an active tenant the gap is seconds. For an
   * inactive one the deltas are zero. It is not a sampling system and is not documented as one.
   */
  private roll(counter: RuleCounter): void {
    const elapsed = Math.floor((this.now() - counter.bucketStartedAt) / this.bucketMs);
    if (elapsed <= 0) return;

    /*
     * A node that has been up for weeks would otherwise loop thousands of times to produce buckets it
     * evicts immediately. Only the last `retainedBuckets` can survive, so the rest are skipped — and
     * with them the deltas that belonged to a window nobody can see any more, which is what a bounded
     * window means.
     */
    const emit = Math.min(elapsed, this.retainedBuckets);
    const skipped = elapsed - emit;
    let start = counter.bucketStartedAt + skipped * this.bucketMs;
    const base = counter.bucketBaseline;

    for (let i = 0; i < emit; i += 1) {
      const carriesDeltas = i === 0 && skipped === 0;
      counter.history.push({
        startedAt: start,
        endedAt: start + this.bucketMs,
        evaluations: carriesDeltas ? counter.evaluations - base.evaluations : 0,
        matches: carriesDeltas ? counter.matches - base.matches : 0,
        failures: carriesDeltas ? counter.failures - base.failures : 0,
        totalMicros: carriesDeltas ? counter.totalMicros - base.totalMicros : 0,
        timedEvaluations: carriesDeltas ? counter.timedEvaluations - base.timedEvaluations : 0,
      });
      start += this.bucketMs;
    }

    if (counter.history.length > this.retainedBuckets) {
      counter.history.splice(0, counter.history.length - this.retainedBuckets);
    }
    counter.bucketStartedAt = start;
    counter.bucketBaseline = {
      evaluations: counter.evaluations,
      matches: counter.matches,
      failures: counter.failures,
      totalMicros: counter.totalMicros,
      timedEvaluations: counter.timedEvaluations,
    };
  }

  /**
   * A rule's recent activity, oldest bucket first (P-4.2, Architect rec 7).
   *
   * Returns an empty history for a rule this node has never compiled — not a fabricated flat line.
   */
  historyFor(tenantId: string, ruleId: string): RuleStatsHistory {
    const counter = this.byTenant.get(tenantId)?.get(ruleId);
    const bucketSeconds = this.bucketMs / 1000;
    if (!counter) return { ruleId, bucketSeconds, buckets: [], coversSeconds: 0 };

    this.roll(counter);
    const buckets: RuleStatsBucket[] = counter.history.map((bucket) => ({
      from: new Date(bucket.startedAt).toISOString(),
      to: new Date(bucket.endedAt).toISOString(),
      evaluations: bucket.evaluations,
      matches: bucket.matches,
      failures: bucket.failures,
      avgEvaluationMicros:
        bucket.timedEvaluations > 0 ? bucket.totalMicros / bucket.timedEvaluations : 0,
    }));

    return {
      ruleId,
      bucketSeconds,
      buckets,
      // How far back this node can actually see — shorter than the window means it restarted.
      coversSeconds: Math.min(
        buckets.length * bucketSeconds,
        (this.now() - counter.createdAt) / 1000,
      ),
    };
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
    for (const counter of rules.values()) this.roll(counter);
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
