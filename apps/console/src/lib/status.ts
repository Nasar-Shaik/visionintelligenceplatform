/**
 * Operational status → design-system status tokens (DESIGN_SYSTEM.md §2). Camera,
 * runtime, delivery, and connection states all normalise to these four so the
 * StatusIndicator renders consistently. Never colour-only — always paired with a label.
 */
export type StatusKind = 'ok' | 'warn' | 'error' | 'idle';

export interface StatusTokens {
  /** colour utility fragment: `status-ok` | `status-warn` | `status-error` | `status-idle`. */
  readonly token: string;
  readonly label: string;
}

const STATUS: Record<StatusKind, StatusTokens> = {
  ok: { token: 'status-ok', label: 'OK' },
  warn: { token: 'status-warn', label: 'Warning' },
  error: { token: 'status-error', label: 'Error' },
  idle: { token: 'status-idle', label: 'Idle' },
};

/**
 * ⚠️ **Total, and it took a whole page down.** A single demo camera carried
 * `health.status: "degraded"` — a *lifecycle* word, not a member of the frozen `CameraHealthStatus`
 * enum. `HEALTH_KIND[...]` returned `undefined`, `STATUS[undefined]` returned `undefined`, and
 * reading `.label` off it threw inside `StatusIndicator`. One unexpected string in one row of nine
 * white-screened `/cameras` in the production deployment.
 *
 * The row was wrong and has been fixed at its source. This is the second half of that fix: a
 * design-system primitive rendering an unknown status must degrade to `idle`, not take the page with
 * it. The same class as TD-33 — a formatter that assumes its input is well-formed is a page crash
 * waiting for the first record that is not.
 */
export function statusTokens(kind: StatusKind | undefined): StatusTokens {
  return (kind === undefined ? undefined : STATUS[kind]) ?? STATUS.idle;
}

/** Map common domain state strings to a status kind (camera/stream/delivery/health). */
export function toStatusKind(state: string): StatusKind {
  switch (state) {
    case 'online':
    case 'connected':
    case 'delivered':
    case 'healthy':
    case 'acked':
    case 'ready':
      return 'ok';
    case 'degraded':
    case 'connecting':
    case 'sent':
    case 'pending':
    case 'warning':
      return 'warn';
    case 'offline':
    case 'lost':
    case 'failed':
    case 'error':
    case 'unavailable':
      return 'error';
    default:
      return 'idle';
  }
}
