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

export function statusTokens(kind: StatusKind): StatusTokens {
  return STATUS[kind];
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
