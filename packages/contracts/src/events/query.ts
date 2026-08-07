/**
 * Event query + page contracts (Phase 1, P1-5). The read side of the event store: a tenant-scoped,
 * bounded query over persisted `EventEnvelope`s (`GET /events`) and a cursor-paged result. Tenant
 * scoping is NOT a query field — it is enforced structurally by `@vip/tenancy` from the request
 * context (Law 5); a query can never widen across tenants. Grounds: docs/architecture/09 §Query,
 * 23-SERVICE-OWNERSHIP (events context), docs/architecture/phase1/EVENT_PIPELINE.md.
 */
import { z } from 'zod';
import { EventType, IsoDateTime } from '../common/primitives.js';
import { EventEnvelope } from './envelope.js';

/**
 * A bounded, tenant-scoped query over the event store. All filters are optional (AND-combined).
 *
 * ⚠️ **Every filter here has a declared covering index** (`services/events/src/adapters/indexes.ts`),
 * proven by `test/index-coverage.test.ts`. Future filters the P-5 workspace may want — severity,
 * rule id, behaviour id — remain **additive**: a new optional field plus its index plus a row in
 * that test. None of them is added speculatively, because a filter nothing populates matches
 * nothing while looking like it works.
 */
export const EventQuery = z.object({
  /** Restrict to one event type (e.g. `perception.person.detected`). */
  type: EventType.optional(),
  cameraId: z.string().min(1).optional(),
  zoneId: z.string().min(1).optional(),
  /**
   * The end-to-end correlation spine (P-5.0 entry criterion G-5) — "every event related to this
   * incident". Backed by `tenant_correlation_time`; see `services/events/src/adapters/indexes.ts`.
   */
  correlationId: z.string().min(1).optional(),
  /**
   * ⭐ **Every event one offline analysis run produced** (ADR-0047).
   *
   * The join key for the investigation timeline, evidence extraction and the export report — and the
   * only field that can answer it. `correlationId` cannot: on the live path it is stamped **per
   * frame**, and a rerun of one recording reproduces every other field exactly. Backed by
   * `tenant_analysis_time`.
   */
  analysisSessionId: z.string().min(1).max(120).optional(),
  /**
   * ⛔ **Include offline-analysis events in an otherwise unfiltered read. Default `false`.**
   *
   * Every event on this platform was a live observation until offline analysis existed, so every
   * existing caller — the console's Events page, every dashboard, every export written before this
   * milestone — asks its question meaning *live*. Returning analysis events to them would put
   * six-week-old footage, replayed on demand, into a view an operator reads as "what is happening".
   * That is the pollution ADR-0047 has to prevent, and a default is the only thing that prevents it
   * for callers that have not been changed.
   *
   * ⚠️ **Defaulting is a behaviour change made deliberately, and it is the conservative one.** It
   * cannot hide a live event: analysis events are exactly the ones carrying an `analysisSessionId`,
   * and nothing else acquires one. Setting `analysisSessionId` selects a single run regardless of
   * this flag, because naming a run is already an unambiguous request for it.
   */
  includeAnalyses: z.coerce.boolean().default(false),
  /** Inclusive lower bound on `occurredAt`. */
  from: IsoDateTime.optional(),
  /** Exclusive upper bound on `occurredAt`. */
  to: IsoDateTime.optional(),
  /** Opaque forward cursor from a prior page (the last envelope id). */
  cursor: z.string().min(1).optional(),
  /** Page size; bounded to protect the store. */
  limit: z.number().int().min(1).max(500).default(50),
});
export type EventQuery = z.infer<typeof EventQuery>;

/** One page of persisted events, newest-first, with an optional forward cursor. */
export const EventPage = z.object({
  events: z.array(EventEnvelope).default([]),
  /** Present when more results exist — pass back as `cursor` for the next page. */
  nextCursor: z.string().min(1).optional(),
});
export type EventPage = z.infer<typeof EventPage>;

/**
 * A bounded replay request (`POST /events/replay`, admin) — re-publish persisted envelopes in a
 * window onto the backbone so a new/repaired consumer can rebuild state (ADR-0005 replay). Bounded
 * by design: a window is required and the count is capped by the service.
 */
export const EventReplayRequest = z.object({
  from: IsoDateTime,
  to: IsoDateTime,
  type: EventType.optional(),
  cameraId: z.string().min(1).optional(),
  /** Hard cap on how many envelopes to replay in one call (service enforces its own ceiling). */
  limit: z.number().int().min(1).max(10000).default(1000),
});
export type EventReplayRequest = z.infer<typeof EventReplayRequest>;

/** Result of a replay: how many envelopes were re-published, and the window actually covered. */
export const EventReplayResult = z.object({
  replayed: z.number().int().nonnegative(),
  from: IsoDateTime,
  to: IsoDateTime,
});
export type EventReplayResult = z.infer<typeof EventReplayResult>;
