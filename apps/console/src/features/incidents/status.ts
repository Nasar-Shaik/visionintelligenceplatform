import type { IncidentStatus } from '@vip/contracts';
import type { BadgeProps } from '@/ui/badge';

/**
 * Incident lifecycle presentation + the legal operator transitions from each state (mirrors the
 * workflow state machine: raised → acknowledged → resolved → closed). The gateway remains the real
 * arbiter — an illegal move is a 409 — this only drives which action buttons are offered.
 */
export const INCIDENT_STATUS: Record<
  IncidentStatus,
  { label: string; variant: BadgeProps['variant'] }
> = {
  raised: { label: 'Raised', variant: 'critical' },
  acknowledged: { label: 'Acknowledged', variant: 'warning' },
  resolved: { label: 'Resolved', variant: 'success' },
  closed: { label: 'Closed', variant: 'neutral' },
};

export type IncidentAction = 'acknowledge' | 'resolve' | 'close';

/** Which transitions are offered from a given status (before permission gating). */
export function allowedActions(status: IncidentStatus): IncidentAction[] {
  switch (status) {
    case 'raised':
      return ['acknowledge', 'resolve'];
    case 'acknowledged':
      return ['resolve'];
    case 'resolved':
      return ['close'];
    case 'closed':
      return [];
  }
}
