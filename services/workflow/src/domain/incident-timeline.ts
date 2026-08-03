/**
 * Domain: the **investigation timeline** (P-5.1, finding F-3). Pure — handed what the upstream
 * contexts returned, it merges and orders. The fetching is the application's job.
 *
 * ### Why this is not `IncidentActivity`
 *
 * `IncidentActivity` (P-5.0) derives three entry kinds from three arrays on the incident document:
 * one read, no fan-out, always complete. It stays exactly as it is, and the incident header uses it.
 *
 * A *complete* narrative is a different shape. Three of its entry kinds are owned elsewhere —
 * `event` by the Events context, `attachment`/evidence by Evidence, `automation` by Notify — so the
 * timeline is a **fan-out**, not a projection. That has consequences the contract has to carry
 * rather than hide:
 *
 * - **A join budget.** One bounded call per source, never one per entry. The per-entry version
 *   passes every test written against three rows and becomes a load test on a neighbour at four
 *   hundred (CONSTRAINTS §54).
 * - **Opt-in per source.** The header does not pay for the evidence panel.
 * - **Gaps, not silence.** An upstream that is down produces a named `gap`; the entries that *were*
 *   gathered are still returned. A timeline that quietly omits the events is a timeline asserting
 *   the events did not happen — §44 applied to a read.
 * - **Truncation, reported.** A busy correlation carries thousands of events. The timeline shows
 *   the most recent N and says that is what it did.
 */
import type {
  Incident,
  IncidentActorRef,
  IncidentAssignment,
  IncidentAttachment,
  IncidentNote,
  IncidentTimeline,
  IncidentTimelineEntry,
  IncidentTimelineGap,
  IncidentTimelineSource,
  IncidentTransition,
} from '@vip/contracts';
import { resolveActor, SYSTEM_ACTOR } from './incident-actor.js';

/**
 * ⚠️ **The join budget.** At most this many upstream calls per timeline read, total — not per
 * entry, not per page. Three sources, one call each.
 */
export const MAX_UPSTREAM_CALLS = 3;

/** How many entries one source may contribute before the rest are reported as truncated. */
export const MAX_ENTRIES_PER_SOURCE = 200;

/** How long any single upstream call may take before it is abandoned and reported as a gap. */
export const UPSTREAM_TIMEOUT_MS = 2_000;

/** Ordering for entries sharing a timestamp — a state change precedes commentary about it. */
const KIND_ORDER: Record<IncidentTimelineEntry['kind'], number> = {
  raised: 0,
  'state-change': 1,
  assignment: 2,
  event: 3,
  // A note precedes the attachments it carries — they share a timestamp, and an attachment read
  // before the comment explaining it is the wrong way round.
  note: 4,
  attachment: 5,
  system: 6,
  automation: 7,
  recommendation: 8,
  transition: 1, // the retained P-5.0 spelling sorts with what it became
};

/** One related event, as the Events context returned it — only what the timeline renders. */
export interface RelatedEvent {
  id: string;
  type: string;
  occurredAt: string;
  cameraId?: string | undefined;
}

/** One evidence record, reduced to a reference. The timeline never carries evidence content. */
export interface RelatedEvidence {
  id: string;
  kind: string;
  capturedAt: string;
  label?: string | undefined;
}

/** One automation action — a notification the Notify context sent about this incident. */
export interface RelatedAutomation {
  id: string;
  channel: string;
  status: string;
  at: string;
}

export interface TimelineInputs {
  incident: Incident;
  events?: { items: RelatedEvent[]; truncated: boolean } | undefined;
  evidence?: { items: RelatedEvidence[]; truncated: boolean } | undefined;
  automation?: { items: RelatedAutomation[]; truncated: boolean } | undefined;
  /** Sources the caller asked for. A source not requested is a `not-requested` gap, not a silence. */
  requested: readonly IncidentTimelineSource[];
  /** Sources that failed, with why. Produced by the application layer, reported verbatim. */
  failures?: readonly { source: IncidentTimelineSource; detail: string }[] | undefined;
  now: Date;
}

function transitionEntry(transition: IncidentTransition, index: number): IncidentTimelineEntry {
  const actor = resolveActor(transition.actor, transition.by);
  const first = transition.from === null;
  const entry: IncidentTimelineEntry = {
    id: `t${index}`,
    kind: first ? 'raised' : 'state-change',
    source: 'incident',
    at: transition.at,
    actor,
    summary: first ? 'raised from a rule match' : `${transition.from} → ${transition.to}`,
    transition,
  };
  if (transition.by !== undefined) entry.by = transition.by;
  return entry;
}

function assignmentEntry(assignment: IncidentAssignment, index: number): IncidentTimelineEntry {
  const summary =
    assignment.to === undefined
      ? `unassigned${assignment.from ? ` from ${assignment.from}` : ''}`
      : `assigned to ${assignment.to}${assignment.from ? ` (was ${assignment.from})` : ''}`;
  const entry: IncidentTimelineEntry = {
    id: `a${index}`,
    kind: 'assignment',
    source: 'incident',
    at: assignment.at,
    actor: resolveActor(assignment.actor, assignment.by),
    summary,
    assignment,
  };
  if (assignment.by !== undefined) entry.by = assignment.by;
  return entry;
}

function noteEntries(note: IncidentNote, index: number): IncidentTimelineEntry[] {
  const actor = resolveActor(note.actor, note.by);
  const entry: IncidentTimelineEntry = {
    id: `n${index}`,
    kind: 'note',
    source: 'incident',
    at: note.at,
    actor,
    // The body is the payload, not the summary — a 4,000-character comment must not become the
    // one-liner a collapsed row renders.
    summary: 'commented',
    note,
  };
  if (note.by !== undefined) entry.by = note.by;

  /*
   * An attachment is its own entry as well as part of its note. Both readings are wanted: the
   * comment thread shows the note with its attachments, and the "what evidence is linked here"
   * filter shows the attachments alone. The note is the single stored truth; both are derived.
   */
  const attachments = note.attachments.map(
    (attachment: IncidentAttachment, position: number): IncidentTimelineEntry => {
      const item: IncidentTimelineEntry = {
        id: `n${index}x${position}`,
        kind: 'attachment',
        source: 'incident',
        at: note.at,
        actor,
        summary:
          attachment.kind === 'evidence'
            ? `linked evidence ${attachment.label ?? attachment.ref}`
            : `linked ${attachment.label ?? attachment.ref}`,
        attachment,
      };
      if (attachment.kind === 'evidence') item.evidenceId = attachment.ref;
      return item;
    },
  );

  return [entry, ...attachments];
}

function eventEntry(event: RelatedEvent, index: number): IncidentTimelineEntry {
  const entry: IncidentTimelineEntry = {
    id: `e${index}`,
    kind: 'event',
    source: 'events',
    at: event.occurredAt,
    actor: SYSTEM_ACTOR,
    summary: event.cameraId ? `${event.type} on ${event.cameraId}` : event.type,
    eventId: event.id,
  };
  // `eventType` is a catalog value; an upstream that returns something else is reported as-is
  // rather than dropped, because a timeline that hides an unrecognised event is lying about it.
  (entry as { eventType?: string }).eventType = event.type;
  return entry;
}

function evidenceEntry(evidence: RelatedEvidence, index: number): IncidentTimelineEntry {
  return {
    id: `v${index}`,
    kind: 'attachment',
    source: 'evidence',
    at: evidence.capturedAt,
    actor: SYSTEM_ACTOR,
    summary: `${evidence.kind} captured${evidence.label ? ` — ${evidence.label}` : ''}`,
    evidenceId: evidence.id,
  };
}

function automationEntry(automation: RelatedAutomation, index: number): IncidentTimelineEntry {
  return {
    id: `m${index}`,
    kind: 'automation',
    source: 'notify',
    at: automation.at,
    actor: { kind: 'automation', id: automation.channel } as IncidentActorRef,
    summary: `notification ${automation.status} via ${automation.channel}`,
  };
}

/**
 * Merge every source into one ordered narrative, oldest first.
 *
 * Oldest-first because an investigation is read as a story. Ties break by kind rather than by sort
 * stability, so the same incident produces the same timeline on every node — the determinism rule
 * the rule engine holds itself to, applied to a read.
 */
export function buildTimeline(inputs: TimelineInputs): IncidentTimeline {
  const { incident, requested, now } = inputs;
  const entries: IncidentTimelineEntry[] = [
    ...incident.history.map(transitionEntry),
    ...incident.assignments.map(assignmentEntry),
    ...incident.notes.flatMap(noteEntries),
  ];

  const gaps: IncidentTimelineGap[] = [];
  const cap = (source: IncidentTimelineSource, truncated: boolean, count: number) => {
    if (truncated) {
      gaps.push({
        source,
        reason: 'truncated',
        detail: `showing the most recent ${count} of more than ${MAX_ENTRIES_PER_SOURCE}`,
      });
    }
  };

  if (inputs.events) {
    entries.push(...inputs.events.items.map(eventEntry));
    cap('events', inputs.events.truncated, inputs.events.items.length);
  }
  if (inputs.evidence) {
    entries.push(...inputs.evidence.items.map(evidenceEntry));
    cap('evidence', inputs.evidence.truncated, inputs.evidence.items.length);
  }
  if (inputs.automation) {
    entries.push(...inputs.automation.items.map(automationEntry));
    cap('notify', inputs.automation.truncated, inputs.automation.items.length);
  }

  for (const failure of inputs.failures ?? []) {
    gaps.push({ source: failure.source, reason: 'unavailable', detail: failure.detail });
  }

  /*
   * A requested source that produced neither entries nor a failure is reported as available and
   * empty — no gap. A source that was NOT requested is a `not-requested` gap, so a caller reading
   * a timeline can always tell "there is nothing" from "nobody asked".
   */
  const all: IncidentTimelineSource[] = ['incident', 'events', 'evidence', 'notify'];
  for (const source of all) {
    if (source !== 'incident' && !requested.includes(source)) {
      gaps.push({ source, reason: 'not-requested', detail: `add \`${source}\` to include` });
    }
  }

  entries.sort((a, b) => a.at.localeCompare(b.at) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  return {
    incidentId: incident.id,
    incidentVersion: incident.version,
    entries,
    sources: ['incident', ...requested.filter((source) => source !== 'incident')],
    gaps,
    derivedAt: now.toISOString(),
  };
}
