import type { IncidentStatus } from '@vip/contracts';
import type { BadgeProps } from '@/ui/badge';

/**
 * Incident lifecycle presentation + the legal operator transitions from each state (mirrors the
 * workflow state machine). The gateway remains the real arbiter — an illegal move is a 409 — this
 * only drives which action buttons are offered.
 *
 * `investigating` and `escalated` arrived with P-5.0 entry criterion G-1. They are rendered here
 * because the queue must not break when an incident comes back in one of them; the **buttons** that
 * enter those states belong to the P-5 investigation workspace and are deliberately not added yet.
 * This `Record` being exhaustive is what turned that contract change into a compile error rather
 * than a blank chip in production — the enum-extension hazard ADR-0029 records, caught by the type.
 */
export const INCIDENT_STATUS: Record<
  IncidentStatus,
  { label: string; variant: BadgeProps['variant'] }
> = {
  raised: { label: 'Raised', variant: 'critical' },
  acknowledged: { label: 'Acknowledged', variant: 'warning' },
  investigating: { label: 'Investigating', variant: 'warning' },
  escalated: { label: 'Escalated', variant: 'critical' },
  resolved: { label: 'Resolved', variant: 'success' },
  closed: { label: 'Closed', variant: 'neutral' },
};

export type IncidentAction = 'acknowledge' | 'resolve' | 'close';

/**
 * Which transitions are offered from a given status (before permission gating).
 *
 * `investigating` and `escalated` offer the same actions as `acknowledged` — an incident in any
 * active state can still be resolved from this queue. Offering `investigate` / `escalate` themselves
 * needs the investigation workspace, which is P-5, not this slice.
 */
export function allowedActions(status: IncidentStatus): IncidentAction[] {
  switch (status) {
    case 'raised':
      return ['acknowledge', 'resolve'];
    case 'acknowledged':
    case 'investigating':
    case 'escalated':
      return ['resolve'];
    case 'resolved':
      return ['close'];
    case 'closed':
      return [];
  }
}
