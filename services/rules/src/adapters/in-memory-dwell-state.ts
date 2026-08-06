/**
 * In-memory `DwellStateStore` — where a visit lives between two events (P-8 Phase 7).
 *
 * ### ⚠️ Bounded, swept, and honest about what it loses
 *
 * One entry per (tenant, rule, zone, subject) currently being watched. On a busy site that is one
 * entry per person per monitored zone per dwell rule, which is small — but it is unbounded in
 * *principle*, because subjects keep arriving and nothing tells this store when one has gone home.
 * So it sweeps: an entry untouched for longer than its rule could ever need is dropped.
 *
 * ⚠️ **State is lost on restart, and a visit in progress restarts its clock.** That is a real
 * limitation with a real consequence — a rules service redeployed while somebody is standing in a
 * monitored zone will not fire for them until they have been there for the full threshold again. It
 * is recorded in KNOWN_LIMITATIONS rather than hidden, and it is the right trade for this milestone:
 * the alternative is a write to a durable store on the per-event path, which would put a disk between
 * a camera and an alert. The seam for a Redis-backed implementation is this interface, unchanged —
 * exactly as `RuleStateStore` already anticipates for windows.
 *
 * ⚠️ Unlike windowed state, dwell state is **not** re-derivable from event replay in the general case:
 * replaying the last hour rebuilds a visit only if the whole visit is inside that hour. That is why
 * the loss is documented as a behaviour rather than as a recovery detail.
 */
import type { RuleDwell } from '@vip/contracts';
import {
  observe,
  type DwellObservationInput,
  type DwellOutcome,
  type DwellRecord,
} from '../domain/dwell.js';
import type { DwellStateStore, DwellStoreStats } from '../application/ports.js';

interface Entry {
  record: DwellRecord;
  /** Wall-clock of the last touch — the sweep's clock, deliberately not the event's. */
  touchedAtMs: number;
}

export interface InMemoryDwellStateOptions {
  /**
   * Entries kept before the store starts evicting the least recently touched.
   *
   * ⚠️ A ceiling, not a target. It exists so a pathological producer — a tracker emitting a fresh
   * identity every frame, which is exactly what a saturated host does — cannot turn a rules node into
   * an out-of-memory crash. Eviction is counted and reported, because silently dropping a visit makes
   * a rule stop firing for reasons nobody could see.
   */
  maxEntries?: number;
  /** How often to sweep expired entries, in observations. Sweeping every call would be quadratic. */
  sweepEvery?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_SWEEP_EVERY = 512;

export class InMemoryDwellStateStore implements DwellStateStore {
  /** ⚠️ A `Map` preserves insertion order, which is what makes LRU eviction a `keys().next()`. */
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #sweepEvery: number;
  readonly #now: () => number;
  #sinceSweep = 0;
  #evicted = 0;
  #expired = 0;
  #observations = 0;

  constructor(opts: InMemoryDwellStateOptions = {}) {
    this.#maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#sweepEvery = opts.sweepEvery ?? DEFAULT_SWEEP_EVERY;
    this.#now = opts.now ?? (() => Date.now());
  }

  async observe(
    key: string,
    input: DwellObservationInput,
    config: RuleDwell,
  ): Promise<DwellOutcome> {
    this.#observations += 1;
    const existing = this.#entries.get(key);
    const outcome = observe(existing?.record, input, config);

    /*
     * ⚠️ Delete-then-set, not set. A `Map` only records insertion order on first insert, so updating
     * in place leaves a hot key sitting at the front of the eviction queue — and the busiest subject
     * on the estate would be the first one evicted. Getting this wrong produces a store that works
     * perfectly until it fills up and then loses exactly the wrong entries.
     */
    this.#entries.delete(key);
    this.#entries.set(key, { record: outcome.record, touchedAtMs: this.#now() });

    this.#sinceSweep += 1;
    if (this.#sinceSweep >= this.#sweepEvery) {
      this.#sinceSweep = 0;
      this.#sweep(config);
    }
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
      this.#evicted += 1;
    }
    return outcome;
  }

  /**
   * Drop entries that can no longer influence anything.
   *
   * ⚠️ The horizon is `resetAfterSeconds + cooldownSeconds`, not just the reset. An entry past its
   * reset window would begin a fresh visit on its next observation — dropping it early is harmless.
   * An entry inside its **cool-down** is different: forgetting it re-arms a rule that is supposed to
   * be silent, and the operator gets the alert storm the cool-down exists to prevent. So the cool-down
   * is added, and the sweep is deliberately conservative in the direction that costs memory rather
   * than in the direction that costs an operator's attention.
   *
   * ⚠️ The horizon comes from the rule *currently being evaluated*, which is not necessarily the rule
   * that owns every entry. That is safe in one direction only — a long-cooldown rule sweeping under a
   * short-cooldown rule's horizon would drop entries early — so the widest horizon seen is retained.
   */
  #sweep(config: RuleDwell): void {
    const horizonMs = Math.max(
      this.#horizonMs,
      (config.resetAfterSeconds + config.cooldownSeconds) * 1000,
    );
    this.#horizonMs = horizonMs;
    const cutoff = this.#now() - horizonMs;
    for (const [key, entry] of this.#entries) {
      if (entry.touchedAtMs >= cutoff) continue;
      this.#entries.delete(key);
      this.#expired += 1;
    }
  }

  #horizonMs = 0;

  stats(): DwellStoreStats {
    return {
      entries: this.#entries.size,
      maxEntries: this.#maxEntries,
      observations: this.#observations,
      evicted: this.#evicted,
      expired: this.#expired,
    };
  }

  /**
   * Every visit being held, newest-touched last (insertion order is LRU order — see `observe`).
   *
   * ⚠️ Returns the records themselves rather than copies. The caller derives a view and discards it;
   * copying every record on every status poll would allocate proportionally to the estate for a
   * screen somebody may not be looking at. Nothing mutates a record outside `observe`.
   */
  active(): { key: string; record: DwellRecord }[] {
    return [...this.#entries].map(([key, entry]) => ({ key, record: entry.record }));
  }

  /** Test seam: forget everything. Never called in production — the sweep is the production path. */
  clear(): void {
    this.#entries.clear();
  }
}
