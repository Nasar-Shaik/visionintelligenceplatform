/**
 * Application: a **bounded sliding-rate window** (P-8 Phase 7, Architect rec 3).
 *
 * Counts events in a fixed recent window and reports a per-second rate. In-process, lost on restart,
 * and deliberately tiny — this is what the Live Rule Status page reads, not a time-series database.
 * Anything spanning replicas or surviving a deploy comes from the Prometheus pipeline, which is
 * already wired and already stores history properly.
 *
 * ### ⚠️ `null` until the window has elapsed, and this is the whole point
 *
 * A node that started four seconds ago has counted four seconds of traffic. Dividing by a ten-second
 * window reports 40% of the true rate — a number that is *plausible*, *wrong*, and *moving in the
 * right direction*, which is the worst combination available. ADR-0039 says an unmeasured value is
 * absent; the P-8 Phase 6 benchmark shipped two latency metrics that fell as load rose before this
 * lesson was learned, and the second one would have gone out.
 *
 * ⚠️ Counters, not timestamps. Storing one timestamp per event would make the memory cost a function
 * of throughput on the one process that must not run out of it; buckets make it a function of the
 * window length alone.
 */

/** Bucket width. One second, so a ten-second window is ten small integers. */
const BUCKET_MS = 1_000;

export class RateWindow {
  readonly #buckets: number[];
  readonly #windowMs: number;
  /** The bucket index most recently written, so a gap can be zero-filled rather than mis-attributed. */
  #lastBucket: number | null = null;
  /** When counting began. ⚠️ The window is not reportable until this is `windowMs` in the past. */
  readonly #startedAtMs: number;

  constructor(startedAtMs: number, windowSeconds = 10) {
    this.#windowMs = windowSeconds * BUCKET_MS;
    this.#buckets = new Array<number>(windowSeconds).fill(0);
    this.#startedAtMs = startedAtMs;
  }

  /** Record `n` occurrences at `nowMs`. */
  add(nowMs: number, n = 1): void {
    const bucket = Math.floor(nowMs / BUCKET_MS);
    if (this.#lastBucket === null) {
      this.#lastBucket = bucket;
    } else if (bucket !== this.#lastBucket) {
      /*
       * ⚠️ Zero-fill every bucket skipped since the last write, capped at the window length. Without
       * this, a quiet minute followed by one event would report the rate from before the quiet minute
       * — a node that had stopped receiving traffic would look busy.
       */
      const skipped = Math.min(bucket - this.#lastBucket, this.#buckets.length);
      for (let i = 1; i <= skipped; i += 1) {
        this.#buckets[(this.#lastBucket + i) % this.#buckets.length] = 0;
      }
      this.#lastBucket = bucket;
    }
    const index = bucket % this.#buckets.length;
    this.#buckets[index] = (this.#buckets[index] ?? 0) + n;
  }

  /** The rate per second, or `null` before a full window has elapsed. See the header. */
  perSecond(nowMs: number): number | null {
    if (nowMs - this.#startedAtMs < this.#windowMs) return null;
    /*
     * ⚠️ Zero-fill on READ as well as on write. A node that received nothing for a minute never
     * called `add`, so its buckets still hold the last burst — and a status page polled during the
     * quiet minute would report the old rate as though it were current.
     */
    if (this.#lastBucket !== null) {
      const bucket = Math.floor(nowMs / BUCKET_MS);
      const skipped = Math.min(bucket - this.#lastBucket, this.#buckets.length);
      for (let i = 1; i <= skipped; i += 1) {
        this.#buckets[(this.#lastBucket + i) % this.#buckets.length] = 0;
      }
      if (skipped > 0) this.#lastBucket = bucket;
    }
    const total = this.#buckets.reduce((a, b) => a + b, 0);
    return total / (this.#windowMs / BUCKET_MS);
  }
}
