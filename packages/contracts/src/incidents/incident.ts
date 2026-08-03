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
 * Incident lifecycle (P1-8 Architect rec 2 — defined before the Alert Engine; extended by P-5.0).
 * An explicit, operational state machine, not a boolean:
 *   - `raised`        — promoted from a candidate; awaiting operator attention.
 *   - `acknowledged`  — an operator has taken ownership (`incident:ack`).
 *   - `investigating` — active investigation is under way (`incident:investigate`, P-5.0 G-1).
 *   - `escalated`     — handed up; someone else now owns the outcome (`incident:escalate`, G-1).
 *   - `resolved`      — the situation is handled, with a resolution note (`incident:resolve`).
 *   - `closed`        — terminal; retained for audit. Nothing may be appended after this.
 * Transitions are validated (illegal moves are rejected) and each bumps `version` + appends history.
 *
 * ⚠️ **`assigned` is deliberately NOT a status.** An incident can be assigned while raised,
 * acknowledged, investigating or escalated — assignment answers _who owns it_, the status answers
 * _where it is_. Folding the two together is how a state machine grows a state that is really an
 * event and then cannot be reasoned about (see docs/architecture/RULE_ARTIFACT_LIFECYCLE.md, the
 * same distinction one context over). Assignment is `Incident.assignee` + the `assignments` stream.
 *
 * ⚠️ **Extending this enum is not purely additive for a strict parser.** A console or integration
 * pinned to the four-value schema fails to parse an incident in a new state. Recorded in
 * [ADR-0029](../../../../docs/adr/ADR-0029-incident-workflow-entry-criteria.md).
 */
export const IncidentStatus = z.enum([
  'raised',
  'acknowledged',
  'investigating',
  'escalated',
  'resolved',
  'closed',
]);
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

// ---------------------------------------------------------------------------------------------
// Actors — who did a thing. Declared before the streams that reference them.
// ---------------------------------------------------------------------------------------------

/**
 * Whoever an incident can be assigned or escalated to: a principal id, or a team/role handle.
 * Deliberately an opaque string — the Workflow context does not own the directory, and resolving
 * this to a person is the caller's job (Identity owns principals).
 */
export const IncidentActor = z.string().min(1).max(200);
export type IncidentActor = z.infer<typeof IncidentActor>;

/**
 * **Who did this** (P-5.1, finding F-2) — the typed half of `IncidentActor`.
 *
 * The problem this fixes: `IncidentActor` is a bare string, so `"priya"`, `"system"` and a future AI
 * principal are indistinguishable by type. "Show me only what a human did" was unanswerable, and
 * merging operator, automation and AI actions into one undifferentiated stream is exactly what the
 * collaboration model must not do.
 *
 * ⚠️ **`unknown` is a real value, not defensive padding.** Every incident raised before this
 * existed carries a bare string, and there is no honest way to decide whether `"system"` was a
 * person named system. Guessing would be the mistake CONSTRAINTS §52 exists to prevent, so
 * pre-P-5.1 records resolve to `{kind: 'unknown', id: <the string>}` and say so.
 */
export const IncidentActorKind = z.enum([
  /** A human being, acting through the console or the API. */
  'operator',
  /** The platform itself — promotion, dedup collapse, retention expiry. */
  'system',
  /** Another VIP service acting under a machine principal. */
  'service',
  /** A configured automation rule or workflow, acting on a policy someone wrote. */
  'automation',
  /**
   * An AI advisor. ⚠️ **Advisory only** — see `IncidentRecommendation`. No role grants a principal
   * of this kind any `incident:*` write permission, so this can appear beside a recommendation and
   * never beside a state change.
   */
  'ai-advisor',
  /** A third-party system acting through an integration. */
  'external-integration',
  /** Not honestly classifiable — pre-P-5.1 records, and anything the platform cannot attribute. */
  'unknown',
]);
export type IncidentActorKind = z.infer<typeof IncidentActorKind>;

export const IncidentActorRef = z.object({
  kind: IncidentActorKind,
  /** The raw identifier: a principal id, a service name, a model name, or the legacy string. */
  id: IncidentActor,
  /** Resolved for display when the caller knows it. Never authoritative — Identity owns names. */
  displayName: z.string().max(200).optional(),
});
export type IncidentActorRef = z.infer<typeof IncidentActorRef>;

/** One immutable lifecycle transition — the (embedded) audit trail for the incident. */
export const IncidentTransition = z.object({
  from: IncidentStatus.nullable(),
  to: IncidentStatus,
  at: IsoDateTime,
  by: z.string().optional(),
  /**
   * The typed actor (P-5.1, F-2). Written on every new transition; **absent on records from before
   * P-5.1**, which is why it is optional and why readers resolve an absent one to `unknown` rather
   * than guessing from `by`. `by` is retained unchanged — the contract is additive-only.
   */
  actor: IncidentActorRef.optional(),
  note: z.string().max(2000).optional(),
});
export type IncidentTransition = z.infer<typeof IncidentTransition>;

// ---------------------------------------------------------------------------------------------
// P-5.0 — operator collaboration (entry criterion G-2).
//
// Three append-only streams, one derived view. Notes, assignments and transitions each carry
// genuinely different data, so each gets its own array; the **activity log is derived** by merging
// them, never stored. Two records of one truth eventually disagree (CONSTRAINTS §46) — and a
// derived log works on incidents raised long before this contract existed.
// ---------------------------------------------------------------------------------------------

/**
 * Something attached to a note. **A reference, never bytes.**
 *
 * `evidence` points at an Evidence Foundation record by id; `link` is an absolute URI. Storing the
 * artifact here instead would put a mutable copy of an immutable record inside the Workflow context
 * — see the P-5 architecture validation pass, G-2.
 */
export const IncidentAttachmentKind = z.enum(['evidence', 'link']);
export type IncidentAttachmentKind = z.infer<typeof IncidentAttachmentKind>;

export const IncidentAttachment = z.object({
  kind: IncidentAttachmentKind,
  /** An evidence id, or an absolute URI when `kind` is `link`. */
  ref: z.string().min(1).max(2000),
  label: z.string().max(200).optional(),
});
export type IncidentAttachment = z.infer<typeof IncidentAttachment>;

/**
 * One operator note on an incident — the "comment" of the investigation workspace.
 *
 * ⚠️ **Note and comment are the same object.** The distinction that actually exists is between a
 * note bound to a state change (`IncidentTransition.note`) and a free-standing one (this) — so that
 * is the distinction the contract models, rather than two identical types with different names.
 */
export const IncidentNote = z.object({
  id: Uuid,
  body: z.string().min(1).max(4000),
  by: IncidentActor.optional(),
  /** The typed actor (P-5.1, F-2). Absent on pre-P-5.1 records — resolved to `unknown`, not guessed. */
  actor: IncidentActorRef.optional(),
  at: IsoDateTime,
  attachments: z.array(IncidentAttachment).max(20).default([]),
});
export type IncidentNote = z.infer<typeof IncidentNote>;

/** One immutable assignment change. `to` absent means the incident was un-assigned. */
export const IncidentAssignment = z.object({
  from: IncidentActor.optional(),
  to: IncidentActor.optional(),
  by: IncidentActor.optional(),
  /** The typed actor (P-5.1, F-2). Absent on pre-P-5.1 records — resolved to `unknown`, not guessed. */
  actor: IncidentActorRef.optional(),
  at: IsoDateTime,
  note: z.string().max(2000).optional(),
});
export type IncidentAssignment = z.infer<typeof IncidentAssignment>;

/** Who an escalated incident was handed to, and by whom. Present only while/after escalation. */
export const IncidentEscalation = z.object({
  to: IncidentActor.optional(),
  by: IncidentActor.optional(),
  at: IsoDateTime,
});
export type IncidentEscalation = z.infer<typeof IncidentEscalation>;

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
  /**
   * Monotonic version — the optimistic-concurrency token. Bumps on every persisted change: a
   * lifecycle transition, an assignment, or an appended note (widened in P-5.0, so two operators
   * commenting at the same instant get a 409 rather than one silently losing their note).
   */
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
  /**
   * Who currently owns the incident (P-5.0 G-2). Not a status — see `IncidentStatus`. Absent means
   * unassigned, which is a legitimate resting state, not an error.
   */
  assignee: IncidentActor.optional(),
  /** Append-only assignment history, including un-assignments. */
  assignments: z.array(IncidentAssignment).default([]),
  /** Append-only operator notes / comments. Capped by the service; refused once `closed`. */
  notes: z.array(IncidentNote).default([]),
  /** Set when the incident is escalated; retained afterwards as the record of who was handed it. */
  escalation: IncidentEscalation.optional(),
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

/** Operator input to begin investigating (P-5.0 G-1). */
export const InvestigateIncidentInput = z.object({ note: z.string().max(2000).optional() });
export type InvestigateIncidentInput = z.infer<typeof InvestigateIncidentInput>;

/** Operator input to escalate — `to` records who now owns the outcome (P-5.0 G-1). */
export const EscalateIncidentInput = z.object({
  to: IncidentActor.optional(),
  note: z.string().max(2000).optional(),
});
export type EscalateIncidentInput = z.infer<typeof EscalateIncidentInput>;

/**
 * Operator input to assign — or, with `assignee: null`, to un-assign (P-5.0 G-2).
 *
 * `null` rather than an absent field: omitting the key would be indistinguishable from "no change"
 * once this input grows a second field, and un-assigning is a real operator action that has to be
 * expressible.
 */
export const AssignIncidentInput = z.object({
  assignee: IncidentActor.nullable(),
  note: z.string().max(2000).optional(),
});
export type AssignIncidentInput = z.infer<typeof AssignIncidentInput>;

/** Operator input to append a note / comment (P-5.0 G-2). */
export const AddIncidentNoteInput = z.object({
  body: z.string().min(1).max(4000),
  attachments: z.array(IncidentAttachment).max(20).default([]),
});
export type AddIncidentNoteInput = z.infer<typeof AddIncidentNoteInput>;

/**
 * Cursor-paged incident query (tenant-scoped; the store always filters by tenant).
 *
 * ⚠️ **Frozen as the P-5 search surface** (P-5.0 entry criterion G-3, Architect rec 9). Every field
 * here is backed by a declared index — see `services/workflow/src/adapters/indexes.ts` and the
 * coverage test that proves it. **Adding a filter without adding its index is a defect**
 * (CONSTRAINTS §40); the coverage test is written to fail rather than let one through.
 *
 * Two filters the P-5 scope asks for are deliberately **absent**, because nothing populates them:
 * a composite-behaviour id and a behaviour-profile id are not carried on `IncidentCandidate`, so a
 * filter for either would always match nothing. Recorded as TD-23 rather than shipped dead.
 * Behaviour search is served honestly by `eventType` (`behavior.loitering`, …) and `category`.
 */
export const IncidentQuery = z.object({
  status: IncidentStatus.optional(),
  severity: EventPriority.optional(),
  category: EventCategory.optional(),
  /** The triggering event's type — how a behaviour search is actually expressed. */
  eventType: EventType.optional(),
  cameraId: z.string().min(1).optional(),
  zoneId: z.string().min(1).optional(),
  /** The rule that raised it — "everything this rule has ever produced". */
  ruleId: z.string().min(1).optional(),
  /** The correlation spine — "everything related to this". */
  correlationId: z.string().min(1).optional(),
  assignee: IncidentActor.optional(),
  /** Inclusive lower bound on `raisedAt`. */
  from: IsoDateTime.optional(),
  /** Exclusive upper bound on `raisedAt`. */
  to: IsoDateTime.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type IncidentQuery = z.infer<typeof IncidentQuery>;

/**
 * One entry in an incident's activity log (P-5.0 G-2; expanded P-5.1, finding F-5).
 *
 * **Derived, never stored.** Merged on read from `history`, `assignments` and `notes` — the three
 * append-only streams the incident already carries, plus (for `IncidentTimeline`) bounded reads
 * from the contexts that own the rest. A stored copy would be a second audit trail, which is the
 * mistake P-4.1 recorded and did not make (CONSTRAINTS §46).
 *
 * ### ⚠️ Why this enum is shorter than the list that was asked for
 *
 * The recommendation named sixteen activities. Nine of them are not distinct **kinds** — they are
 * the *payload* of a kind that already exists, and giving each its own value would duplicate
 * another enum into this one, leaving two that must be kept in sync forever:
 *
 * | Asked for                                                  | Modelled as                                          |
 * | ---------------------------------------------------------- | ---------------------------------------------------- |
 * | Acknowledgement · Investigation · Escalation · Resolution  | `state-change` + `transition.to` — that *is* `IncidentStatus` |
 * | Assignment · Reassignment                                  | `assignment`; `assignment.from` present ⇒ a reassignment |
 * | Comment                                                    | `note` — note and comment are one object (P-5.0, F-6) |
 * | Evidence Linked                                            | `attachment` with `attachment.kind === 'evidence'`    |
 * | AI Accepted · AI Rejected                                  | deferred: `recommendation-decision`, when an AI exists to accept |
 * | Camera Offline · Camera Recovered · Rule Changed           | deferred: `context-change`, when a producer emits one |
 *
 * The deferred values are safe to add later precisely because **consumers must render an unknown
 * kind** from `kind` + `actor` + `at` + `summary`, which are required on every entry. Adding a
 * value nothing emits today would be a category that is always empty while looking like a feature —
 * the same failure CONSTRAINTS §58 records for query filters.
 */
export const IncidentActivityKind = z.enum([
  /** The incident came into being — promoted from a rule candidate. */
  'raised',
  /** A lifecycle transition. Carries its bound note, if the operator left one. */
  'state-change',
  /** Assigned, re-assigned, or un-assigned. */
  'assignment',
  /** A free-standing operator note (the workspace's "comment"). */
  'note',
  /** Evidence or a link referenced from a note. */
  'attachment',
  /** A related event on the correlation spine — joined from the Events context. */
  'event',
  /** The platform acted: promotion, dedup collapse, retention expiry. */
  'system',
  /** A configured automation acted: a notification sent, delivered or acknowledged. */
  'automation',
  /**
   * An AI suggestion. ⚠️ **Advisory only** — a recommendation never changes incident state, and an
   * `ai-advisor` actor can never appear on a `state-change`.
   */
  'recommendation',
  /**
   * ⚠️ **Retained for compatibility.** P-5.0 emitted `transition` for what is now `state-change`.
   * Nothing emits this any more; it stays so a consumer pinned to the P-5.0 schema still parses.
   */
  'transition',
]);
export type IncidentActivityKind = z.infer<typeof IncidentActivityKind>;

export const IncidentActivityEntry = z.object({
  kind: IncidentActivityKind,
  at: IsoDateTime,
  /** The raw actor string, as P-5.0 emitted it. Retained; `actor` is the typed answer. */
  by: IncidentActor.optional(),
  /** The typed actor (P-5.1, F-2). Always present on a derived entry — `unknown` when unattributable. */
  actor: IncidentActorRef.optional(),
  /** A human-readable one-liner. The structured payload below is the authority. */
  summary: z.string().min(1),
  transition: IncidentTransition.optional(),
  assignment: IncidentAssignment.optional(),
  note: IncidentNote.optional(),
  attachment: IncidentAttachment.optional(),
});
export type IncidentActivityEntry = z.infer<typeof IncidentActivityEntry>;

export const IncidentActivity = z.object({
  incidentId: Uuid,
  incidentVersion: z.number().int().min(1),
  entries: z.array(IncidentActivityEntry),
  derivedAt: IsoDateTime,
});
export type IncidentActivity = z.infer<typeof IncidentActivity>;

// ---------------------------------------------------------------------------------------------
// P-5.1 — the timeline (finding F-3) and SLA (finding F-4).
// ---------------------------------------------------------------------------------------------

/**
 * Which context an activity entry came from.
 *
 * Present on every timeline entry so a reader can tell "the incident says so" from "another service
 * said so" — and, when a source is missing, exactly which one.
 */
export const IncidentTimelineSource = z.enum(['incident', 'events', 'evidence', 'notify']);
export type IncidentTimelineSource = z.infer<typeof IncidentTimelineSource>;

/**
 * Something the timeline could **not** include, and why (P-5.1, F-3).
 *
 * ⚠️ This is a first-class field, not error handling. A timeline that quietly omits the events is a
 * timeline asserting the events did not happen — §44 applied to a read. Every degraded source says
 * so out loud, and the entries that *were* gathered are still returned.
 */
export const IncidentTimelineGapReason = z.enum([
  /** The upstream context did not answer in time, or answered with an error. */
  'unavailable',
  /** The upstream answered, but there were more entries than the budget allows. */
  'truncated',
  /** The caller did not ask for this source (`include` is opt-in per source). */
  'not-requested',
]);
export type IncidentTimelineGapReason = z.infer<typeof IncidentTimelineGapReason>;

export const IncidentTimelineGap = z.object({
  source: IncidentTimelineSource,
  reason: IncidentTimelineGapReason,
  detail: z.string().min(1),
});
export type IncidentTimelineGap = z.infer<typeof IncidentTimelineGap>;

/** One timeline entry — an activity entry that also knows where it came from. */
export const IncidentTimelineEntry = IncidentActivityEntry.extend({
  /**
   * Stable within one derivation. Enough for a React key and a deep link; **not** a durable id,
   * because the entry is derived and has no independent existence.
   */
  id: z.string().min(1),
  source: IncidentTimelineSource,
  /** Set when `kind === 'event'` — the related event, as the Events context returned it. */
  eventId: z.string().min(1).optional(),
  eventType: EventType.optional(),
  /** Set when the entry references an evidence record. */
  evidenceId: z.string().min(1).optional(),
});
export type IncidentTimelineEntry = z.infer<typeof IncidentTimelineEntry>;

/**
 * The full investigation narrative (P-5.1, F-3) — **derived across contexts**, oldest first.
 *
 * Distinct from `IncidentActivity`, which stays exactly as P-5.0 shipped it: one document read, no
 * fan-out, for the incident header. This one joins the contexts that own the rest of the story, so
 * it costs upstream calls and is bounded and degradable by design.
 */
export const IncidentTimeline = z.object({
  incidentId: Uuid,
  incidentVersion: z.number().int().min(1),
  entries: z.array(IncidentTimelineEntry),
  /** Which sources were consulted, whatever they answered. */
  sources: z.array(IncidentTimelineSource),
  /** ⚠️ Everything missing, and why. Empty means genuinely complete. */
  gaps: z.array(IncidentTimelineGap).default([]),
  derivedAt: IsoDateTime,
});
export type IncidentTimeline = z.infer<typeof IncidentTimeline>;

/**
 * An SLA target (P-5.1, F-4) — **deployment-configurable**, per tenant, per severity.
 *
 * Deliberately minimal: two durations and the clock they run against. Escalation *policies* and
 * timers (who gets paged when a target is missed) remain deferred with the full Workflow engine —
 * measuring a breach and acting on one are different features, and only the first is in scope.
 */
export const IncidentSlaPolicy = z.object({
  tenantId: TenantId,
  severity: EventPriority,
  /** Time from `raisedAt` to an operator acknowledging. Absent = not measured. */
  acknowledgeWithinSeconds: z.number().int().min(1).optional(),
  /** Time from `raisedAt` to `resolved`. Absent = not measured. */
  resolveWithinSeconds: z.number().int().min(1).optional(),
});
export type IncidentSlaPolicy = z.infer<typeof IncidentSlaPolicy>;

/** One SLA clock's outcome. `dueAt` is derived from `raisedAt` + the target. */
export const IncidentSlaClock = z.object({
  dueAt: IsoDateTime,
  /** When the target was met. Absent while still running, or if it was missed. */
  metAt: IsoDateTime.optional(),
  breached: z.boolean(),
  /** Elapsed at `metAt`, or at the moment of derivation while still running. */
  elapsedSeconds: z.number().int().min(0),
});
export type IncidentSlaClock = z.infer<typeof IncidentSlaClock>;

/**
 * An incident's SLA attainment — **derived, never stored** (P-5.1, F-4).
 *
 * ⚠️ **No policy means `unknown`, never "met".** An incident with no SLA configured is not
 * compliant, it is *unmeasured*, and a report that cannot distinguish the two is worse than one
 * that omits the column. The same discipline as `RuleHealthStatus.unknown` — a status computed from
 * a target that does not exist is fabricated.
 */
export const IncidentSlaState = z.enum(['unknown', 'on-track', 'met', 'breached']);
export type IncidentSlaState = z.infer<typeof IncidentSlaState>;

export const IncidentSlaStatus = z.object({
  incidentId: Uuid,
  state: IncidentSlaState,
  /** The policy this was measured against. **Absent ⇒ `state` is `unknown`.** */
  policy: IncidentSlaPolicy.optional(),
  acknowledge: IncidentSlaClock.optional(),
  resolve: IncidentSlaClock.optional(),
  derivedAt: IsoDateTime,
});
export type IncidentSlaStatus = z.infer<typeof IncidentSlaStatus>;

/**
 * An AI suggestion about an incident (P-5.1 — the reserved shape; **no producer exists yet**).
 *
 * ⚠️ **The AI boundary, stated where it is enforced.** A recommendation is a read-side artefact.
 * AI may recommend, summarise, correlate, prioritise, suggest and explain; it may never assign,
 * resolve, close, delete, modify or escalate. That is enforced by the **permission catalog** — no
 * role grants a machine principal any `incident:*` write permission, and `incident:ai-recommend` is
 * a read-side grant — not by convention and not by prompt.
 *
 * `basis` and `producer` are required in spirit: an unattributable suggestion sitting in an
 * investigation record is indistinguishable from a finding, which is how it ends up in a report.
 */
export const IncidentRecommendationKind = z.enum([
  'summary',
  'similar-incidents',
  'root-cause',
  'suggested-action',
]);
export type IncidentRecommendationKind = z.infer<typeof IncidentRecommendationKind>;

export const IncidentRecommendation = z.object({
  id: Uuid,
  incidentId: Uuid,
  kind: IncidentRecommendationKind,
  body: z.string().min(1).max(8000),
  /** 0–1. **Absent means absent** — not zero, not certain. */
  confidence: z.number().min(0).max(1).optional(),
  /** What it looked at, so a wrong suggestion is traceable to its inputs. */
  basis: z
    .object({
      incidentIds: z.array(z.string().min(1)).default([]),
      eventIds: z.array(z.string().min(1)).default([]),
      evidenceIds: z.array(z.string().min(1)).default([]),
      ruleIds: z.array(z.string().min(1)).default([]),
    })
    .default({ incidentIds: [], eventIds: [], evidenceIds: [], ruleIds: [] }),
  /** Which model said it, so a bad one is traceable to its producer. */
  producer: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  at: IsoDateTime,
});
export type IncidentRecommendation = z.infer<typeof IncidentRecommendation>;

export const IncidentPage = z.object({
  items: z.array(Incident),
  nextCursor: z.string().optional(),
});
export type IncidentPage = z.infer<typeof IncidentPage>;
