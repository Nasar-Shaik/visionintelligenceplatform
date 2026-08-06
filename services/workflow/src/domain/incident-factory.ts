/**
 * Domain: pure construction + lifecycle transitions of an incident. `promoteFromCandidate` turns a
 * rule engine's `incident.candidate` into a version-1 `raised` incident — anchoring the **end-to-end
 * correlationId** (rec 1: the candidate's, else the triggering event id) and the causation chain.
 * `applyTransition` moves an incident along the (pre-validated) state machine, bumps the version, and
 * appends an immutable history entry. No I/O — the store persists what these return.
 */
import type {
  Incident,
  IncidentActorRef,
  IncidentAssignment,
  IncidentAttachment,
  IncidentCandidate,
  IncidentNote,
  IncidentTransition,
} from '@vip/contracts';
import { type IncidentAction, targetStatus } from './incident-state.js';

export interface FactoryDeps {
  now: () => Date;
  newId: () => string;
}

/** Input carried on a transition (who + optional note/resolution/escalation target). */
export interface TransitionInput {
  by?: string | undefined;
  /** The typed actor (P-5.1, F-2). Recorded alongside `by`, never inferred from it. */
  actor?: IncidentActorRef | undefined;
  note?: string | undefined;
  resolution?: string | undefined;
  /** Only meaningful for `escalate`: who now owns the outcome. */
  escalateTo?: string | undefined;
}

/** Promote a candidate into a fresh `raised` incident (idempotency is the store's job via dedupKey). */
export function promoteFromCandidate(
  candidate: IncidentCandidate,
  deps: FactoryDeps,
  actor = 'system',
): Incident {
  const at = deps.now().toISOString();
  /*
   * The promoter is the platform, not a person (P-5.1, F-2). Recording that explicitly is what lets
   * a timeline distinguish "the system raised this" from "someone called system did".
   */
  const firstTransition: IncidentTransition = {
    from: null,
    to: 'raised',
    at,
    by: actor,
    actor: { kind: 'system', id: actor },
  };
  const incident: Incident = {
    id: deps.newId(),
    tenantId: candidate.tenantId,
    status: 'raised',
    severity: candidate.severity,
    title: candidate.title,
    category: candidate.category,
    source: {
      ruleId: candidate.ruleId,
      ruleVersion: candidate.ruleVersion,
      ruleName: candidate.ruleName,
      candidateId: candidate.id,
      dedupKey: candidate.dedupKey,
    },
    triggeredBy: {
      eventId: candidate.triggeredBy.eventId,
      eventType: candidate.triggeredBy.eventType,
      occurredAt: candidate.triggeredBy.occurredAt,
    },
    /*
     * ⚠️ P-8 Phase 7 — the analytical detail is COPIED onto the incident, not referenced.
     *
     * A candidate is a message on a bus with a retention policy; an incident is a record somebody
     * may open in a year. An incident that had to reach back to a broker message to explain itself
     * would, in a year, be an incident that cannot explain itself. `evidence` is a list of locators
     * rather than bytes, so copying it costs a few hundred bytes and buys permanence.
     */
    evidence: candidate.evidence ?? [],
    matchedCount: candidate.matchedCount,
    version: 1,
    // rec 1 — always present: inherit the event's correlation, else anchor to the triggering event.
    correlationId: candidate.correlationId ?? candidate.triggeredBy.eventId,
    causationId: candidate.id,
    history: [firstTransition],
    // A fresh incident is unassigned with nothing said about it yet. Empty rather than absent, so
    // every reader appends to an array that is always there (P-5.0 G-2).
    assignments: [],
    notes: [],
    raisedAt: at,
    updatedAt: at,
  };
  if (candidate.triggeredBy.cameraId)
    incident.triggeredBy.cameraId = candidate.triggeredBy.cameraId;
  if (candidate.triggeredBy.zoneId) incident.triggeredBy.zoneId = candidate.triggeredBy.zoneId;

  /* ⚠️ Conditional, not defaulted. Absent means "this rule does not measure duration". */
  if (candidate.identityId !== undefined) incident.identityId = candidate.identityId;
  if (candidate.durationSeconds !== undefined) incident.durationSeconds = candidate.durationSeconds;
  if (candidate.explanation !== undefined) incident.explanation = candidate.explanation;
  if (candidate.timeline !== undefined) incident.timeline = candidate.timeline;
  if (candidate.confidence !== undefined) incident.detectionConfidence = candidate.confidence;
  return incident;
}

/**
 * Apply a lifecycle transition (the caller has already checked `canApply`). Bumps the version,
 * records who/when on the matching status fields, and appends the history entry.
 */
export function applyTransition(
  incident: Incident,
  action: IncidentAction,
  input: TransitionInput,
  deps: FactoryDeps,
): Incident {
  const at = deps.now().toISOString();
  const to = targetStatus(action);
  const transition: IncidentTransition = { from: incident.status, to, at };
  if (input.by !== undefined) transition.by = input.by;
  if (input.actor !== undefined) transition.actor = input.actor;
  const note = action === 'resolve' ? input.resolution : input.note;
  if (note !== undefined && note !== '') transition.note = note;

  const next: Incident = {
    ...incident,
    status: to,
    version: incident.version + 1,
    history: [...incident.history, transition],
    updatedAt: at,
  };
  /*
   * The `<state>By`/`<state>At` pairs below are P1-8 contract and stay exactly as they are. They are
   * deliberately **not extended** for the P-5.0 states: `history` already records who did what and
   * when, and every denormalised copy is another field that can drift from it. `escalation` is the
   * one exception, because "who was it handed to" is genuinely new information no transition
   * carries — and it is queryable state, not a duplicate.
   */
  if (action === 'acknowledge') {
    if (input.by !== undefined) next.acknowledgedBy = input.by;
    next.acknowledgedAt = at;
  } else if (action === 'resolve') {
    if (input.by !== undefined) next.resolvedBy = input.by;
    next.resolvedAt = at;
    if (input.resolution !== undefined && input.resolution !== '') {
      next.resolution = input.resolution;
    }
  } else if (action === 'close') {
    if (input.by !== undefined) next.closedBy = input.by;
    next.closedAt = at;
  } else if (action === 'escalate') {
    next.escalation = { at };
    if (input.escalateTo !== undefined && input.escalateTo !== '') {
      next.escalation.to = input.escalateTo;
    }
    if (input.by !== undefined) next.escalation.by = input.by;
  }
  // `investigate` records itself in `history` and nowhere else — there is nothing extra to know.
  return next;
}

/** Input carried on an assignment. `to` absent means un-assign. */
export interface AssignmentInput {
  to?: string | undefined;
  by?: string | undefined;
  actor?: IncidentActorRef | undefined;
  note?: string | undefined;
}

/**
 * Assign (or un-assign) an incident. Bumps the version like any other persisted change and appends
 * to the immutable `assignments` stream. Does **not** touch `status` — see `incident-state.ts`.
 */
export function applyAssignment(
  incident: Incident,
  input: AssignmentInput,
  deps: FactoryDeps,
): Incident {
  const at = deps.now().toISOString();
  const assignment: IncidentAssignment = { at };
  if (incident.assignee !== undefined) assignment.from = incident.assignee;
  if (input.to !== undefined) assignment.to = input.to;
  if (input.by !== undefined) assignment.by = input.by;
  if (input.actor !== undefined) assignment.actor = input.actor;
  if (input.note !== undefined && input.note !== '') assignment.note = input.note;

  const next: Incident = {
    ...incident,
    version: incident.version + 1,
    assignments: [...incident.assignments, assignment],
    updatedAt: at,
  };
  if (input.to === undefined) delete next.assignee;
  else next.assignee = input.to;
  return next;
}

/** Input carried on a note. */
export interface NoteInput {
  body: string;
  by?: string | undefined;
  actor?: IncidentActorRef | undefined;
  attachments?: readonly IncidentAttachment[] | undefined;
}

/** Append an operator note. Immutable once written — there is no edit and no delete, by design. */
export function appendNote(incident: Incident, input: NoteInput, deps: FactoryDeps): Incident {
  const at = deps.now().toISOString();
  const note: IncidentNote = {
    id: deps.newId(),
    body: input.body,
    at,
    attachments: [...(input.attachments ?? [])],
  };
  if (input.by !== undefined) note.by = input.by;
  if (input.actor !== undefined) note.actor = input.actor;

  return {
    ...incident,
    version: incident.version + 1,
    notes: [...incident.notes, note],
    updatedAt: at,
  };
}
