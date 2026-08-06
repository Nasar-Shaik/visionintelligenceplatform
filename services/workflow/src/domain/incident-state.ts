/**
 * Domain: **enforcement** of the incident lifecycle (P1-8 Architect rec 2; extended by P-5.0 G-1;
 * the table itself frozen into `@vip/contracts` by P-8 Phase 7). Pure data + total functions, no I/O.
 *
 * ⚠️ **The transitions are no longer declared here.** `INCIDENT_LIFECYCLE` in the contracts package
 * is the single source of truth, and this module derives its enforcement table from it. Until P-8
 * Phase 7 there were two hand-maintained copies — this one and the console's — with a comment on the
 * second saying it "mirrors the workflow state machine". A mirror is a copy, and a copy of a state
 * machine is a second state machine that agrees with the first only for as long as somebody
 * remembers. See [ADR-0045](../../../../docs/adr/ADR-0045-the-incident-lifecycle-is-frozen.md).
 *
 * ⚠️ **`assign` is not here, and that is the design.** Assignment does not move an incident through
 * the lifecycle: an incident can be assigned while raised, acknowledged, investigating or escalated,
 * and re-assigned without changing state at all. A status answers _where is this_; an assignee
 * answers _whose is this_. Folding them together makes `assigned → resolved` and `resolved →
 * assigned` both look legal, and the table stops meaning anything.
 */
import { INCIDENT_LIFECYCLE, type IncidentStatus } from '@vip/contracts';

/**
 * Operator actions that transition an incident.
 *
 * ⚠️ There is deliberately **no action for `dismissed` or `archived`**, the two states the P-8 Phase 7
 * freeze declared. `ACTION_TARGET` is the only way into a state, so declaring the states without
 * declaring their actions is what makes them unreachable — the contract is frozen, the behaviour is
 * not yet built, and no code path can produce one by accident in between.
 */
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
 * The statuses an action may be applied **from** (anything else is a 409 conflict) — derived, never
 * authored. A test still asserts the resulting table's exact shape, so a change to the frozen
 * lifecycle that widens what an operator may do shows up as a failing assertion here rather than as
 * a quietly permitted transition.
 *
 * The shape worth noticing: `investigate` and `escalate` point at each other, because both really
 * happen — an escalated incident gets investigated by whoever it landed on, and an investigation
 * that runs out of authority gets escalated. Neither is a dead end. `resolve` is reachable from
 * every non-terminal state, because an incident that turns out to be nothing must be closable from
 * wherever it currently sits without walking it through states that never happened.
 */
export const ALLOWED_FROM: Record<IncidentAction, readonly IncidentStatus[]> = Object.fromEntries(
  (Object.keys(ACTION_TARGET) as IncidentAction[]).map((action) => [
    action,
    INCIDENT_LIFECYCLE[ACTION_TARGET[action]].reachableFrom,
  ]),
) as Record<IncidentAction, readonly IncidentStatus[]>;

/**
 * The terminal status this deployment can reach. **Nothing may be appended to a closed incident** —
 * not a transition, not an assignment, not a note. "Retained for audit" is only true if the record
 * stops changing; a closed incident that keeps growing comments is not retained, it is still live
 * under another name.
 *
 * ⚠️ Kept as a single value because `close` is the only action that reaches a terminal state.
 * `isTerminal` reads the frozen table instead, so a record that arrives in `dismissed` or `archived`
 * from a future version is sealed correctly rather than treated as live.
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

/** Is this incident's record sealed — closed, or in any other terminal state the contract declares? */
export function isTerminal(status: IncidentStatus): boolean {
  return INCIDENT_LIFECYCLE[status].terminal;
}
