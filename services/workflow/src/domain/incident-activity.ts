/**
 * Domain: the incident **activity log** (P-5.0 G-2) — derived, never stored.
 *
 * An investigation workspace needs one chronological answer to "what has happened to this
 * incident": acknowledged, assigned to Priya, two comments, escalated, resolved. The tempting
 * implementation is a fourth append-only array that every write path remembers to append to. That
 * is a second audit trail, and the P-4.1 lesson applies unchanged: two records of one truth
 * eventually disagree, and the derived one is the one that stays right.
 *
 * So this merges the three streams the incident already carries — `history`, `assignments`,
 * `notes` — and sorts them. It therefore works on incidents raised long before P-5.0 existed, with
 * no migration and no backfill.
 *
 * Pure.
 */
import type {
  Incident,
  IncidentActivity,
  IncidentActivityEntry,
  IncidentAssignment,
  IncidentNote,
  IncidentTransition,
} from '@vip/contracts';

function transitionEntry(transition: IncidentTransition): IncidentActivityEntry {
  const entry: IncidentActivityEntry = {
    kind: 'transition',
    at: transition.at,
    summary:
      transition.from === null
        ? 'raised from a rule match'
        : `${transition.from} → ${transition.to}`,
    transition,
  };
  if (transition.by !== undefined) entry.by = transition.by;
  return entry;
}

function assignmentEntry(assignment: IncidentAssignment): IncidentActivityEntry {
  const summary =
    assignment.to === undefined
      ? `unassigned${assignment.from ? ` from ${assignment.from}` : ''}`
      : `assigned to ${assignment.to}${assignment.from ? ` (was ${assignment.from})` : ''}`;
  const entry: IncidentActivityEntry = {
    kind: 'assignment',
    at: assignment.at,
    summary,
    assignment,
  };
  if (assignment.by !== undefined) entry.by = assignment.by;
  return entry;
}

function noteEntry(note: IncidentNote): IncidentActivityEntry {
  const attached =
    note.attachments.length > 0 ? ` (+${note.attachments.length} attachment(s))` : '';
  const entry: IncidentActivityEntry = {
    kind: 'note',
    at: note.at,
    // The body is the payload, not the summary — a 4,000-character comment must not become the
    // one-liner. Callers render `note.body`; this line is for a collapsed timeline row.
    summary: `commented${attached}`,
    note,
  };
  if (note.by !== undefined) entry.by = note.by;
  return entry;
}

/** The order entries with an identical timestamp appear in — a state change precedes its commentary. */
const KIND_ORDER: Record<IncidentActivityEntry['kind'], number> = {
  transition: 0,
  assignment: 1,
  note: 2,
};

/**
 * Derive the full activity log for an incident, oldest first.
 *
 * Oldest-first because an investigation is read as a story. Ties are broken by kind rather than
 * left to sort stability, so the same incident produces the same log on every node — the same
 * determinism rule the rule engine holds itself to.
 */
export function deriveActivity(incident: Incident, now: Date): IncidentActivity {
  const entries: IncidentActivityEntry[] = [
    ...incident.history.map(transitionEntry),
    ...incident.assignments.map(assignmentEntry),
    ...incident.notes.map(noteEntry),
  ].sort((a, b) => a.at.localeCompare(b.at) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  return {
    incidentId: incident.id,
    incidentVersion: incident.version,
    entries,
    derivedAt: now.toISOString(),
  };
}
