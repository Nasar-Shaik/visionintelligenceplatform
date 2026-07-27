/**
 * The Event envelope — the normalized, versioned, domain-neutral currency of the platform
 * (docs/architecture/09-EVENT-PLATFORM.md §1). Events carry NO industry meaning; meaning is
 * assigned by rules (Law 1/3). Consumers tolerate unknown additive payload fields (Postel's law).
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
  class: z.string().optional(),
  bbox: BBox.optional(),
  /** Free-form, additive attributes (color, ppe flags, etc.). */
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type EventSubject = z.infer<typeof EventSubject>;

export const EventEnvelope = z.object({
  id: Uuid,
  type: EventType,
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

  // --- type-specific body (kept opaque here; validated per-type by the catalog) ---
  payload: z.record(z.string(), z.unknown()).default({}),

  evidenceRefs: z.array(z.string()).default([]),
  priority: EventPriority,
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
