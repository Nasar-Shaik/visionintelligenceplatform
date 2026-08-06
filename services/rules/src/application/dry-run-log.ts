/**
 * Application: **what a dry-run rule would have raised** (P-8 Phase 7).
 *
 * A bounded, in-process ring of the candidates a dry-run rule built and did not publish. This is the
 * entire observable output of dry-run mode, and it is deliberately the *same object* a live rule
 * would have published — not a summary of it, not a count.
 *
 * ### ⚠️ In-process and lost on restart, and that is stated rather than hidden
 *
 * Same posture as `RuleStatsHistory`: this answers *"what would this rule have done this afternoon?"*
 * on the node you are asking, and it says which node that is. It is **not** a store, and the moment
 * somebody needs dry-run results to survive a deploy, the answer is to publish them onto a subject of
 * their own — not to grow a database here.
 *
 * ⚠️ Bounded per rule as well as globally. One noisy dry-run rule must not evict the evidence from
 * the other five somebody is evaluating; that is the same per-camera-versus-global reasoning the
 * event publisher's queue uses.
 */
import type { IncidentCandidate } from '@vip/contracts';

/** Candidates kept per rule. Enough to see the pattern of an afternoon, small enough to be free. */
const PER_RULE = 50;
/** Rules tracked at once. Beyond this the least recently active is dropped whole. */
const MAX_RULES = 64;

export interface DryRunSummary {
  ruleId: string;
  ruleName: string;
  /** Candidates this node withheld for the rule. ⚠️ Since this process started — see the header. */
  withheld: number;
  /** How many of those are still retained; the rest aged out of the ring. */
  retained: number;
  firstAt?: string;
  lastAt?: string;
  /** Observed dwell of the longest candidate withheld, when the rule measures duration. */
  maxDurationSeconds?: number;
}

export class DryRunLog {
  readonly #byRule = new Map<
    string,
    { name: string; withheld: number; items: IncidentCandidate[] }
  >();

  record(candidate: IncidentCandidate): void {
    let entry = this.#byRule.get(candidate.ruleId);
    if (entry === undefined) {
      entry = { name: candidate.ruleName, withheld: 0, items: [] };
    } else {
      /* Re-insert so the map's order is least-recently-active first. */
      this.#byRule.delete(candidate.ruleId);
      entry.name = candidate.ruleName;
    }
    entry.withheld += 1;
    entry.items.push(candidate);
    while (entry.items.length > PER_RULE) entry.items.shift();
    this.#byRule.set(candidate.ruleId, entry);

    while (this.#byRule.size > MAX_RULES) {
      const oldest = this.#byRule.keys().next();
      if (oldest.done === true) break;
      this.#byRule.delete(oldest.value);
    }
  }

  /** Candidates withheld for one rule, newest last. Empty when the rule is not in dry run. */
  candidates(ruleId: string): IncidentCandidate[] {
    return [...(this.#byRule.get(ruleId)?.items ?? [])];
  }

  /** One row per dry-run rule this node has seen. */
  summaries(tenantId: string): DryRunSummary[] {
    const rows: DryRunSummary[] = [];
    for (const [ruleId, entry] of this.#byRule) {
      const mine = entry.items.filter((c) => c.tenantId === tenantId);
      if (mine.length === 0) continue;
      const durations = mine
        .map((c) => c.durationSeconds)
        .filter((d): d is number => d !== undefined);
      const row: DryRunSummary = {
        ruleId,
        ruleName: entry.name,
        withheld: entry.withheld,
        retained: mine.length,
      };
      const first = mine[0];
      const last = mine[mine.length - 1];
      if (first !== undefined) row.firstAt = first.at;
      if (last !== undefined) row.lastAt = last.at;
      if (durations.length > 0) row.maxDurationSeconds = Math.max(...durations);
      rows.push(row);
    }
    return rows.sort((a, b) => b.withheld - a.withheld);
  }
}
