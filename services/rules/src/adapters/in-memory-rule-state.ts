/**
 * In-memory sliding-window `RuleStateStore` — the Phase-1 default (and the test double). Keeps, per
 * key, the timestamps of recent hits and counts those inside the window; old hits are pruned on each
 * call so memory stays bounded. Deterministic given the same event order, so replay reconstructs the
 * same counts. A Redis-backed store (sorted sets + TTL) is the horizontal-scale swap behind this same
 * port — the state is re-derivable from event replay, so losing it on restart is safe (TD-tracked).
 */
import type { RuleStateStore } from '../application/ports.js';

export class InMemoryRuleStateStore implements RuleStateStore {
  private readonly hits = new Map<string, number[]>();

  async hitAndCount(key: string, windowSeconds: number, now: Date): Promise<number> {
    const nowMs = now.getTime();
    const cutoff = nowMs - windowSeconds * 1000;
    const arr = this.hits.get(key) ?? [];
    // prune expired, append this hit
    const kept = arr.filter((t) => t >= cutoff);
    kept.push(nowMs);
    this.hits.set(key, kept);
    return kept.length;
  }
}
