import type { ReactNode } from 'react';
import { Camera, Clock } from 'lucide-react';
import type { EventPriority, IncidentStatus } from '@vip/contracts';
import { cn } from '@/lib/cn';
import { timeAgo } from '@/lib/format';
import { Badge } from '@/ui/badge';
import { SeverityBadge, SEVERITY_BORDER } from './severity-badge';

/**
 * Incident lifecycle status. Aliased to the contract enum rather than re-typed as a string union:
 * this card duplicated the four values and would have silently rendered nothing for the two P-5.0
 * added (G-1). Now a lifecycle change is a compile error here too.
 */
export type IncidentCardStatus = IncidentStatus;

/**
 * How each lifecycle state is labelled and coloured, for the whole console.
 *
 * ⚠️ **Declared in the `ui` layer and imported by `features`**, not the other way round, because that
 * is the direction the import boundary allows. Until P-8 Phase 7 this card and
 * `features/incidents/status.ts` each held their own copy of the same six rows; the lifecycle freeze
 * made both fail to compile at once, which is the only reason anyone noticed there were two.
 *
 * ⚠️ `dismissed` and `archived` are declared and unreachable in this release (`INCIDENT_LIFECYCLE`).
 * They are rendered anyway: a console pinned to this build must be able to show a record written by a
 * later one rather than an empty chip.
 */
export const INCIDENT_STATUS_BADGE: Record<
  IncidentCardStatus,
  { variant: 'critical' | 'warning' | 'success' | 'neutral'; label: string }
> = {
  raised: { variant: 'critical', label: 'Raised' },
  acknowledged: { variant: 'warning', label: 'Acknowledged' },
  investigating: { variant: 'warning', label: 'Investigating' },
  escalated: { variant: 'critical', label: 'Escalated' },
  resolved: { variant: 'success', label: 'Resolved' },
  closed: { variant: 'neutral', label: 'Closed' },
  dismissed: { variant: 'neutral', label: 'Dismissed' },
  archived: { variant: 'neutral', label: 'Archived' },
};

const STATUS_BADGE = INCIDENT_STATUS_BADGE;

export interface IncidentCardProps {
  title: string;
  severity: EventPriority;
  status: IncidentCardStatus;
  cameraName?: string;
  at: string | number | Date;
  /** Quick actions (ack/resolve buttons) rendered in the footer. */
  actions?: ReactNode;
  onClick?: () => void;
  className?: string;
}

/** Incident summary card — severity left-border + status chip + quick actions. */
export function IncidentCard({
  title,
  severity,
  status,
  cameraName,
  at,
  actions,
  onClick,
  className,
}: IncidentCardProps) {
  const badge = STATUS_BADGE[status];
  return (
    <div
      className={cn(
        'rounded-md border border-l-4 border-border bg-surface-1 p-3',
        SEVERITY_BORDER[severity],
        onClick && 'cursor-pointer transition-colors hover:bg-surface-2',
        className,
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <SeverityBadge severity={severity} />
        {cameraName ? (
          <span className="inline-flex items-center gap-1">
            <Camera className="size-3" aria-hidden />
            {cameraName}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3" aria-hidden />
          {timeAgo(at)}
        </span>
      </div>
      {actions ? <div className="mt-3 flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
