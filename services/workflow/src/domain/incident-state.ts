/**
 * Domain: the incident lifecycle **state machine** (P1-8 Architect rec 2 — defined before the Alert
 * Engine). Pure data + total functions, no I/O. An incident moves `raised → acknowledged → resolved
 * → closed`; illegal moves are rejected by the caller using `canApply`. Keeping the allowed
 * transitions in one table makes the lifecycle auditable and impossible to widen by accident.
 */
import type { IncidentStatus } from '@vip/contracts';

/** Operator actions that transition an incident. */
export type IncidentAction = 'acknowledge' | 'resolve' | 'close';

/** The status an action moves the incident **to**. */
export const ACTION_TARGET: Record<IncidentAction, IncidentStatus> = {
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  close: 'closed',
};

/** The statuses an action may be applied **from** (anything else is a 409 conflict). */
export const ALLOWED_FROM: Record<IncidentAction, readonly IncidentStatus[]> = {
  acknowledge: ['raised'],
  // an incident can be resolved straight from `raised` (skipping ack) or after `acknowledged`.
  resolve: ['raised', 'acknowledged'],
  close: ['resolved'],
};

/** Is `action` legal from the incident's current `status`? */
export function canApply(action: IncidentAction, status: IncidentStatus): boolean {
  return ALLOWED_FROM[action].includes(status);
}

/** The target status for an action. */
export function targetStatus(action: IncidentAction): IncidentStatus {
  return ACTION_TARGET[action];
}
