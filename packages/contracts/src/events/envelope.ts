/**
 * The Event envelope — the normalized, versioned, domain-neutral currency of the platform
 * (docs/architecture/09-EVENT-PLATFORM.md §1). Events carry NO industry meaning; meaning is
 * assigned by rules (Law 1/3). Consumers tolerate unknown additive payload fields (Postel's law).
 *
 * FROZEN — AI Runtime Architecture v1.0 (ED-0039): `EventEnvelope` is one of the five frozen AI
 * contracts. Evolve ADDITIVELY only (optional fields); breaking changes require an ADR + major bump.
 */
import { z } from 'zod';
import {
  BBox,
  CapabilityId,
  Confidence,
  EventType,
  IsoDateTime,
  SemVer,
  TenantId,
  Uuid,
} from '../common/primitives.js';
import { EventPriority } from './priority.js';
import { EventCategory } from './category.js';

/** The capability (and optional model) that produced the event. */
export const EventProducer = z.object({
  capability: CapabilityId,
  capabilityVersion: SemVer,
  /** Present when a model produced/backed the detection (model-agnostic — a version, not a name). */
  modelVersion: z.string().optional(),
});
export type EventProducer = z.infer<typeof EventProducer>;

/** A subject the event is about (a tracked entity), if any. */
export const EventSubject = z.object({
  trackId: z.string().optional(),
  /**
   * Identity across gaps the tracker bridged (P-8 Phase 5, additive — ADR-0041).
   *
   * ⚠️ **A rule that accumulates over time must group by THIS, not by `trackId`.** A person briefly
   * occluded gets a new `trackId` (ADR-0038 forbids reuse), so a dwell rule keyed on `trackId` sees
   * two short visits instead of one long one and never crosses its threshold. The failure is silent
   * — no error, no dropped message — and it worsens with host load, because identity fragments as a
   * host saturates ([L-42]). That makes the same rule fire on a quiet host and not on a busy one.
   *
   * ⚠️ Advisory. The link is geometric, not appearance-based, so it can join the wrong person. An
   * incident whose duration spans a link is asserting something the platform believes rather than
   * something it observed, and the operator surface shows both ids for that reason.
   */
  identityId: z.string().optional(),
  /** The immediate predecessor in the identity chain, when the subject's track re-entered. */
  precededBy: z.string().optional(),
  class: z.string().optional(),
  bbox: BBox.optional(),
  /** Free-form, additive attributes (color, ppe flags, etc.). */
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type EventSubject = z.infer<typeof EventSubject>;

export const EventEnvelope = z.object({
  id: Uuid,
  type: EventType,
  /**
   * Version of the **EventEnvelope structure itself** — the contract every consumer (rules,
   * analytics, connectors) binds to. Distinct from `schemaVersion` (the type-specific payload).
   * Additive changes bump the minor; a breaking envelope change bumps the major (+ ADR). Lets
   * long-lived consumers evolve safely (Constitution §7). Defaults to the current envelope version.
   */
  envelopeVersion: SemVer.default('1.0.0'),
  /**
   * Coarse, domain-neutral classification for fast filtering + routing (rules/analytics) without
   * decoding the payload. Set from the event catalog. Extend the enum additively, never repurpose.
   */
  category: EventCategory,
  /** Schema version of the type-specific `payload` (additive-only within a major). */
  schemaVersion: SemVer,

  // --- tenancy & spatial scoping (Law 5; docs/architecture/06) ---
  tenantId: TenantId,
  branchId: z.string().optional(),
  siteId: z.string().optional(),
  cameraId: z.string().optional(),
  zoneId: z.string().optional(),

  // --- timing ---
  occurredAt: IsoDateTime,
  ingestedAt: IsoDateTime,

  // --- provenance ---
  producer: EventProducer,
  confidence: Confidence.optional(),

  // --- subjects & correlation ---
  subjects: z.array(EventSubject).default([]),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),

  /**
   * ⭐ **Which offline analysis run produced this event** (ADR-0047, amending ADR-0040).
   *
   * ### ⛔ Why a platform-wide envelope field, when almost nothing sets it
   *
   * It is part of an event's **identity**, not a detail about it. The events service deduplicates on
   * `tenant + type + camera + zone + track + time-bucket`, and every one of those is derived from
   * the observation itself. An offline analysis stamps `occurredAt` in **footage** time, so
   * re-analysing one recording on one camera reproduces all six exactly — and because footage time
   * never advances, the collision is **permanent** rather than windowed. Measured on the deployed
   * stack (L-61): 120 detections offered, `deduped +120`, `persisted +0`, against a session
   * reporting `succeeded` with 120 detections. The rerun the product is built around returned
   * nothing, and said nothing.
   *
   * Nothing already on the envelope can separate the two runs. `correlationId` cannot: the live path
   * stamps it **per frame** (`tenant:camera:seq`), so feeding it to the dedup key would give every
   * live frame a unique key and switch deduplication off for every camera on the platform.
   *
   * ### ⚠️ Absent means live, and absent is the default
   *
   * A live camera has no analysis run — it is one unbounded stream — so this is **absent** on every
   * event any existing producer emits. `dedupKey` appends nothing when it is absent, so live keys
   * stay **byte-identical** to the ones computed before this field existed. That is the whole of the
   * backward-compatibility argument, and there is a test that holds it.
   *
   * ### What it is for beyond dedup
   *
   * It is the join key for the investigation timeline, evidence extraction, the export report and any
   * future comparison of two models over the same footage — all of which need "the events **this
   * run** produced", which no other field can answer.
   */
  analysisSessionId: z.string().min(1).max(120).optional(),

  // --- type-specific body (kept opaque here; validated per-type by the catalog) ---
  payload: z.record(z.string(), z.unknown()).default({}),

  evidenceRefs: z.array(z.string()).default([]),
  priority: EventPriority,
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
