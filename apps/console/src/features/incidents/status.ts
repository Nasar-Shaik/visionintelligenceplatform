import { INCIDENT_LIFECYCLE, type IncidentStatus } from '@vip/contracts';
import type { BadgeProps } from '@/ui/badge';
import { INCIDENT_STATUS_BADGE } from '@/ui/soc/incident-card';

/**
 * Incident lifecycle presentation + the legal operator transitions from each state.
 *
 * ⚠️ **The transitions are derived from `INCIDENT_LIFECYCLE`, not mirrored from it.** Until P-8
 * Phase 7 this file kept its own hand-written copy of the workflow state machine, with a comment
 * saying it mirrored one — which held only for as long as two files were edited together. The
 * gateway remains the real arbiter (an illegal move is a 409); this decides which buttons are
 * *offered*, and now it cannot offer one the server would reject.
 *
 * `investigating` and `escalated` arrived with P-5.0 entry criterion G-1. They are rendered here
 * because the queue must not break when an incident comes back in one of them; the **buttons** that
 * enter those states belong to the P-5 investigation workspace and are deliberately not added yet.
 * This `Record` being exhaustive is what turned that contract change into a compile error rather
 * than a blank chip in production — the enum-extension hazard ADR-0029 records, caught by the type.
 * It did the same job again for `dismissed` and `archived` in P-8 Phase 7.
 */
export const INCIDENT_STATUS: Record<
  IncidentStatus,
  { label: string; variant: BadgeProps['variant'] }
> = INCIDENT_STATUS_BADGE;

/** The subset of lifecycle moves this queue offers. The workspace owns `investigate` / `escalate`. */
export type IncidentAction = 'acknowledge' | 'resolve' | 'close';

const ACTION_TARGET: Record<IncidentAction, IncidentStatus> = {
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  close: 'closed',
};

const ORDER: IncidentAction[] = ['acknowledge', 'resolve', 'close'];

/**
 * Which transitions are offered from a given status, before permission gating.
 *
 * Derived: an action is offered when the frozen lifecycle says its target is reachable from where the
 * incident currently sits. `investigating` and `escalated` therefore offer `resolve` — an incident in
 * any active state can still be resolved from this queue — without that having to be restated here.
 */
export function allowedActions(status: IncidentStatus): IncidentAction[] {
  return ORDER.filter((action) =>
    INCIDENT_LIFECYCLE[ACTION_TARGET[action]].reachableFrom.includes(status),
  );
}
