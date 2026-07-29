/**
 * Incident contracts (Phase 1, P1-8 — Workflow context). An **incident** is the durable, operator-
 * facing consequence of a rule firing: the Workflow context promotes a rule engine's transient
 * `incident.candidate` into a persisted Incident with an explicit **lifecycle** (`raised →
 * acknowledged → resolved → closed`) and publishes `incident.raised|acknowledged|resolved|closed`.
 *
 * The Incident is the canonical contract the Alert Engine (Notification context, P1-8) consumes —
 * it never sees the rule candidate (P1-8 Architect rec 3). Every Incident carries a **required
 * `correlationId`** so the frame → detection → event → candidate → incident → notification chain is
 * unbroken (rec 1). Ownership + taxonomy: docs/architecture/22-BOUNDED-CONTEXTS.md §9,
 * docs/architecture/23-SERVICE-OWNERSHIP.md (Workflow), docs/architecture/11-WORKFLOW-ENGINE.md.
 */
import { z } from 'zod';
import { EventType, IsoDateTime, TenantId, Uuid } from '../common/primitives.js';
import { EventPriority } from '../events/priority.js';
import { EventCategory } from '../events/category.js';

/**
 * Incident lifecycle (P1-8 Architect rec 2 — defined before the Alert Engine). An explicit,
 * operational state machine, not a boolean:
 *   - `raised`       — promoted from a candidate; awaiting operator attention.
 *   - `acknowledged` — an operator has taken ownership (`incident:ack`).
 *   - `resolved`     — the situation is handled, with a resolution note (`incident:resolve`).
 *   - `closed`       — terminal; retained for audit.
 * Transitions are validated (illegal moves are rejected) and each bumps `version` + appends history.
 * `escalated`/`assigned`/cases are future (full Workflow engine) — see TECH-DEBT.
 */
export const IncidentStatus = z.enum(['raised', 'acknowledged', 'resolved', 'closed']);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

/** Provenance back to the rule + candidate that produced the incident (idempotency via `dedupKey`). */
export const IncidentSource = z.object({
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().min(1),
  ruleName: z.string(),
  candidateId: Uuid,
  /** The candidate dedup key — the idempotency key for promotion (repeat candidates collapse). */
  dedupKey: z.string().min(1),
});
export type IncidentSource = z.infer<typeof IncidentSource>;

/** The triggering event's provenance, carried from the candidate for operator context. */
export const IncidentTrigger = z.object({
  eventId: Uuid,
  eventType: EventType,
  cameraId: z.string().optional(),
  zoneId: z.string().optional(),
  occurredAt: IsoDateTime,
});
export type IncidentTrigger = z.infer<typeof IncidentTrigger>;

/** One immutable lifecycle transition — the (embedded) audit trail for the incident. */
export const IncidentTransition = z.object({
  from: IncidentStatus.nullable(),
  to: IncidentStatus,
  at: IsoDateTime,
  by: z.string().optional(),
  note: z.string().max(2000).optional(),
});
export type IncidentTransition = z.infer<typeof IncidentTransition>;

/** A persisted incident (owned by the Workflow context). */
export const Incident = z.object({
  id: Uuid,
  tenantId: TenantId,
  status: IncidentStatus,
  severity: EventPriority,
  title: z.string().min(1),
  category: EventCategory,
  source: IncidentSource,
  triggeredBy: IncidentTrigger,
  /** How many matching events satisfied the (windowed) rule; grows as repeat candidates collapse in. */
  matchedCount: z.number().int().min(1),
  /** Monotonic version — bumps on every lifecycle transition (optimistic concurrency + audit). */
  version: z.number().int().min(1),
  /**
   * End-to-end correlation id (P1-8 Architect rec 1). Always present: inherited from the triggering
   * event's `correlationId`, else anchored to the triggering event id. Threads the whole vertical.
   */
  correlationId: z.string().min(1),
  /** The candidate id that caused this incident (causation chain). */
  causationId: Uuid,
  /** Lifecycle transition audit trail (append-only). */
  history: z.array(IncidentTransition).default([]),
  acknowledgedBy: z.string().optional(),
  acknowledgedAt: IsoDateTime.optional(),
  resolvedBy: z.string().optional(),
  resolvedAt: IsoDateTime.optional(),
  resolution: z.string().max(2000).optional(),
  closedBy: z.string().optional(),
  closedAt: IsoDateTime.optional(),
  raisedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Incident = z.infer<typeof Incident>;

/** Operator input to acknowledge an incident. */
export const AcknowledgeIncidentInput = z.object({ note: z.string().max(2000).optional() });
export type AcknowledgeIncidentInput = z.infer<typeof AcknowledgeIncidentInput>;

/** Operator input to resolve an incident (a resolution note is encouraged). */
export const ResolveIncidentInput = z.object({ resolution: z.string().max(2000).optional() });
export type ResolveIncidentInput = z.infer<typeof ResolveIncidentInput>;

/** Operator input to close a (resolved) incident. */
export const CloseIncidentInput = z.object({ note: z.string().max(2000).optional() });
export type CloseIncidentInput = z.infer<typeof CloseIncidentInput>;

/** Cursor-paged incident query (tenant-scoped; the store always filters by tenant). */
export const IncidentQuery = z.object({
  status: IncidentStatus.optional(),
  severity: EventPriority.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type IncidentQuery = z.infer<typeof IncidentQuery>;

export const IncidentPage = z.object({
  items: z.array(Incident),
  nextCursor: z.string().optional(),
});
export type IncidentPage = z.infer<typeof IncidentPage>;
