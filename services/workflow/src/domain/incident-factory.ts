/**
 * Domain: pure construction + lifecycle transitions of an incident. `promoteFromCandidate` turns a
 * rule engine's `incident.candidate` into a version-1 `raised` incident — anchoring the **end-to-end
 * correlationId** (rec 1: the candidate's, else the triggering event id) and the causation chain.
 * `applyTransition` moves an incident along the (pre-validated) state machine, bumps the version, and
 * appends an immutable history entry. No I/O — the store persists what these return.
 */
import type { Incident, IncidentCandidate, IncidentTransition } from '@vip/contracts';
import { type IncidentAction, targetStatus } from './incident-state.js';

export interface FactoryDeps {
  now: () => Date;
  newId: () => string;
}

/** Input carried on a transition (who + optional note/resolution). */
export interface TransitionInput {
  by?: string | undefined;
  note?: string | undefined;
  resolution?: string | undefined;
}

/** Promote a candidate into a fresh `raised` incident (idempotency is the store's job via dedupKey). */
export function promoteFromCandidate(
  candidate: IncidentCandidate,
  deps: FactoryDeps,
  actor = 'system',
): Incident {
  const at = deps.now().toISOString();
  const firstTransition: IncidentTransition = { from: null, to: 'raised', at, by: actor };
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
    matchedCount: candidate.matchedCount,
    version: 1,
    // rec 1 — always present: inherit the event's correlation, else anchor to the triggering event.
    correlationId: candidate.correlationId ?? candidate.triggeredBy.eventId,
    causationId: candidate.id,
    history: [firstTransition],
    raisedAt: at,
    updatedAt: at,
  };
  if (candidate.triggeredBy.cameraId)
    incident.triggeredBy.cameraId = candidate.triggeredBy.cameraId;
  if (candidate.triggeredBy.zoneId) incident.triggeredBy.zoneId = candidate.triggeredBy.zoneId;
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
  const note = action === 'resolve' ? input.resolution : input.note;
  if (note !== undefined && note !== '') transition.note = note;

  const next: Incident = {
    ...incident,
    status: to,
    version: incident.version + 1,
    history: [...incident.history, transition],
    updatedAt: at,
  };
  if (action === 'acknowledge') {
    if (input.by !== undefined) next.acknowledgedBy = input.by;
    next.acknowledgedAt = at;
  } else if (action === 'resolve') {
    if (input.by !== undefined) next.resolvedBy = input.by;
    next.resolvedAt = at;
    if (input.resolution !== undefined && input.resolution !== '') {
      next.resolution = input.resolution;
    }
  } else {
    if (input.by !== undefined) next.closedBy = input.by;
    next.closedAt = at;
  }
  return next;
}
