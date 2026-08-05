/**
 * Event lookup metrics (P-5.0, Architect rec 4) — operational only. Nothing here is read while
 * deciding anything; these exist so an operator can see whether the investigation workspace's
 * by-id fetch is fast and whether it is finding what it asks for.
 *
 * ⚠️ **There are no cache-hit or cache-miss counters, because there is no cache.** The
 * recommendation named four series; three of them are real here. A `cache_hits_total` that is
 * always zero reads as "the cache is broken", which is a worse answer than no series at all — and a
 * dashboard panel built on it would be wrong the day a cache is actually added. The same discipline
 * as CONSTRAINTS §53: the artifact omits what it does not know.
 *
 * When a cache lands, add the two counters **with** it, in the same slice.
 */
import { Counter, Histogram, type Registry } from 'prom-client';

export class EventMetrics {
  /** One per `GET /events/:id`, labelled `found` / `not_found`. */
  readonly lookups: Counter<string>;
  /** How long the store took to answer a by-id lookup. */
  readonly lookupDuration: Histogram<string>;

  constructor(registry: Registry) {
    this.lookups = new Counter({
      name: 'events_lookup_total',
      help: 'Event by-id lookups served, by outcome',
      labelNames: ['outcome'],
      registers: [registry],
    });
    this.lookupDuration = new Histogram({
      name: 'events_lookup_duration_seconds',
      help: 'Time to fetch one event by id from the store',
      buckets: [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
      registers: [registry],
    });
  }
}

/**
 * Ingest metrics (P-8 Phase 5) — the consumer side, which until this milestone had no traffic.
 *
 * ⚠️ **These deliberately did not exist before, and adding them earlier would have been the mistake
 * this file's header warns about.** Nothing published to `capability.output`, so every one of these
 * would have read zero for the life of the platform — indistinguishable from a broken consumer, and
 * a dashboard panel built on them would have been wrong from the day it was drawn. The Event Bridge
 * is what put traffic on this path, so the counters land in the same milestone as the traffic.
 *
 * ⚠️ `persisted` and `deduped` are SEPARATE, not one "ingested" total. A run where every message
 * dedupes is a redelivery storm; a run where none do is a stream of distinct events. One number
 * cannot tell those apart, and the second is the one an operator is looking for.
 */
export class EventIngestMetrics {
  /** Envelopes normalized from capability output, labelled `persisted` / `deduped`. */
  readonly normalized: Counter<string>;
  /** Messages terminated to the dead-letter path, by reason. ⚠️ Fail-closed is a counted event. */
  readonly deadLettered: Counter<string>;
  /** Messages nak'd for redelivery after a transient store or broker failure. */
  readonly redelivered: Counter<string>;
  /** Wall-clock time to normalize, dedup, persist and re-publish one capability output. */
  readonly ingestDuration: Histogram<string>;

  constructor(registry: Registry) {
    this.normalized = new Counter({
      name: 'events_normalized_total',
      help: 'Envelopes produced from capability output, by whether they were newly persisted',
      labelNames: ['outcome'],
      registers: [registry],
    });
    this.deadLettered = new Counter({
      name: 'events_dead_lettered_total',
      help: 'Capability outputs terminated rather than processed (fail-closed), by reason',
      labelNames: ['reason'],
      registers: [registry],
    });
    this.redelivered = new Counter({
      name: 'events_redelivered_total',
      help: 'Capability outputs nak’d for redelivery after a transient failure',
      registers: [registry],
    });
    this.ingestDuration = new Histogram({
      name: 'events_ingest_duration_seconds',
      help: 'Time to normalize, dedup, persist and re-publish one capability output',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [registry],
    });
  }
}
