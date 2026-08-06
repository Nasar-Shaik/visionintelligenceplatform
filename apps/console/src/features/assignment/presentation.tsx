import type { AssignmentState, CapabilityFact, RuntimeHealth } from '@vip/contracts';
import { Badge } from '@/ui';

/**
 * Shared presentation for Camera Processing Assignment (P-8 Phase 6).
 *
 * ### ⚠️ Nine states, not two colours
 *
 * A page that renders "on" and "off" cannot answer the question an operator actually has, which is
 * *why*. `error` and `unassigned` are both "not analysing" and need opposite responses; `paused` and
 * `stopped` are both "not processing" and differ in whether the tracks survived. Every state gets
 * its own label and its own tone.
 */

const STATE_LABEL: Record<AssignmentState, string> = {
  unassigned: 'Not assigned',
  assigned: 'Assigned',
  starting: 'Starting',
  running: 'Running',
  paused: 'Paused',
  stopping: 'Stopping',
  stopped: 'Stopped',
  error: 'Error',
  recovering: 'Recovering',
};

const STATE_TONE: Record<
  AssignmentState,
  'success' | 'neutral' | 'critical' | 'warning' | 'outline'
> = {
  unassigned: 'outline',
  assigned: 'neutral',
  starting: 'neutral',
  running: 'success',
  paused: 'warning',
  stopping: 'neutral',
  stopped: 'outline',
  error: 'critical',
  recovering: 'warning',
};

export function AssignmentStateBadge({ state }: { state: AssignmentState }) {
  return <Badge variant={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>;
}

const HEALTH_LABEL: Record<RuntimeHealth, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  busy: 'Busy',
  recovering: 'Recovering',
  offline: 'Offline',
  /* ⚠️ "Not observed", never "Unhealthy". Nobody has looked, which is not a fault report. */
  unknown: 'Not observed',
};

const HEALTH_TONE: Record<
  RuntimeHealth,
  'success' | 'neutral' | 'critical' | 'warning' | 'outline'
> = {
  healthy: 'success',
  degraded: 'warning',
  busy: 'warning',
  recovering: 'warning',
  offline: 'critical',
  unknown: 'outline',
};

export function RuntimeHealthBadge({ health }: { health: RuntimeHealth }) {
  return <Badge variant={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</Badge>;
}

/**
 * A capability, with its evidence.
 *
 * ⚠️ Four outcomes, not two. `Unknown` is rendered as its own thing rather than as a grey "No",
 * because the whole point of the matrix is that a consumer can tell a measured absence from an
 * unmeasured one — and an operator reading the page needs the same distinction.
 */
export function CapabilityBadge({ fact, label }: { fact: CapabilityFact; label: string }) {
  const text =
    fact.evidence === 'unknown'
      ? 'Unknown'
      : fact.available === true
        ? fact.evidence === 'measured'
          ? 'Yes · measured'
          : 'Yes · declared'
        : fact.evidence === 'unavailable'
          ? 'No · measured'
          : 'No · declared';
  const tone =
    fact.evidence === 'unknown'
      ? 'outline'
      : fact.available === true
        ? 'success'
        : fact.evidence === 'unavailable'
          ? 'critical'
          : 'warning';
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Badge variant={tone} title={fact.detail ?? undefined}>
        {text}
      </Badge>
    </div>
  );
}

/**
 * A number that may not exist.
 *
 * ⚠️ `null` renders as "Not measured", never as `0`. ADR-0039 in one function — the two are
 * indistinguishable on screen and mean opposite things, and it is the reason this helper exists
 * rather than each page choosing.
 */
export function figure(value: number | null | undefined, suffix = '', digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Not measured';
  return `${value.toFixed(digits)}${suffix}`;
}

/** Utilisation as a percentage, or the honest absence of one. */
export function utilisation(value: number | null): string {
  if (value === null) return 'No capacity declared';
  return `${Math.round(value * 100)}%`;
}
