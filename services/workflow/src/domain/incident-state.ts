/**
 * Domain: the incident lifecycle **state machine** (P1-8 Architect rec 2; extended by P-5.0 G-1).
 * Pure data + total functions, no I/O. Keeping the allowed transitions in one table makes the
 * lifecycle auditable and impossible to widen by accident — a test asserts the table's exact shape,
 * so adding a state without deciding where it may be entered from fails the build.
 *
 * ⚠️ **`assign` is not here, and that is the design.** Assignment does not move an incident through
 * the lifecycle: an incident can be assigned while raised, acknowledged, investigating or escalated,
 * and re-assigned without changing state at all. A status answers _where is this_; an assignee
 * answers _whose is this_. Folding them together makes `assigned → resolved` and `resolved →
 * assigned` both look legal, and the table stops meaning anything.
 */
import type { IncidentStatus } from '@vip/contracts';

/** Operator actions that transition an incident. */
export type IncidentAction = 'acknowledge' | 'investigate' | 'escalate' | 'resolve' | 'close';

/** The status an action moves the incident **to**. */
export const ACTION_TARGET: Record<IncidentAction, IncidentStatus> = {
  acknowledge: 'acknowledged',
  investigate: 'investigating',
  escalate: 'escalated',
  resolve: 'resolved',
  close: 'closed',
};

/**
 * The statuses an action may be applied **from** (anything else is a 409 conflict).
 *
 * The shape worth noticing: `investigate` and `escalate` point at each other, because both really
 * happen — an escalated incident gets investigated by whoever it landed on, and an investigation
 * that runs out of authority gets escalated. Neither is a dead end. `resolve` is reachable from
 * every non-terminal state, because an incident that turns out to be nothing must be closable from
 * wherever it currently sits without walking it through states that never happened.
 */
export const ALLOWED_FROM: Record<IncidentAction, readonly IncidentStatus[]> = {
  acknowledge: ['raised'],
  investigate: ['raised', 'acknowledged', 'escalated'],
  escalate: ['raised', 'acknowledged', 'investigating'],
  // an incident can be resolved straight from `raised` (skipping ack) or from any active state.
  resolve: ['raised', 'acknowledged', 'investigating', 'escalated'],
  close: ['resolved'],
};

/**
 * The terminal status. **Nothing may be appended to a closed incident** — not a transition, not an
 * assignment, not a note. "Retained for audit" is only true if the record stops changing; a closed
 * incident that keeps growing comments is not retained, it is still live under another name.
 */
export const TERMINAL_STATUS: IncidentStatus = 'closed';

/** Is `action` legal from the incident's current `status`? */
export function canApply(action: IncidentAction, status: IncidentStatus): boolean {
  return ALLOWED_FROM[action].includes(status);
}

/** The target status for an action. */
export function targetStatus(action: IncidentAction): IncidentStatus {
  return ACTION_TARGET[action];
}

/** Is this incident closed — i.e. is the record sealed? */
export function isTerminal(status: IncidentStatus): boolean {
  return status === TERMINAL_STATUS;
}
