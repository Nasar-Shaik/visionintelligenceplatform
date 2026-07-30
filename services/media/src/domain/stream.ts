/**
 * Domain: pure per-stream state + transitions, reconnect backoff, and segment naming. Framework-
 * and I/O-free (the clock is injected). The supervisor drives these; keeping them pure makes the
 * lifecycle (connecting → connected → lost → … → stopped) and backoff deterministically testable.
 */
import type {
  StreamHealthReport,
  StreamHealthState,
  StreamState,
  StreamStatus,
} from '@vip/contracts';

export interface Clock {
  now(): Date;
}

/** Mutable worker record. `tenantId`+`cameraId` identify it; scoped so a tenant sees only its own. */
export interface StreamWorkerState {
  tenantId: string;
  cameraId: string;
  state: StreamState;
  since: string;
  recording: boolean;
  reconnectAttempts: number;
  framesReceived: number;
  lastSegmentAt?: string;
  lastError?: string;
  /** True once `stop()` was requested — suppresses further reconnects. */
  stopped: boolean;
}

export function newWorkerState(tenantId: string, cameraId: string, at: Date): StreamWorkerState {
  return {
    tenantId,
    cameraId,
    state: 'idle',
    since: at.toISOString(),
    recording: false,
    reconnectAttempts: 0,
    framesReceived: 0,
    stopped: false,
  };
}

/** Transition a worker to a new state, stamping `since`. */
export function transition(w: StreamWorkerState, state: StreamState, at: Date): void {
  w.state = state;
  w.since = at.toISOString();
}

/** Project the mutable worker into the public `StreamStatus` contract shape. */
export function toStatus(w: StreamWorkerState): StreamStatus {
  return {
    cameraId: w.cameraId,
    tenantId: w.tenantId,
    state: w.state,
    since: w.since,
    recording: w.recording,
    reconnectAttempts: w.reconnectAttempts,
    framesReceived: w.framesReceived,
    ...(w.lastSegmentAt !== undefined ? { lastSegmentAt: w.lastSegmentAt } : {}),
    ...(w.lastError !== undefined ? { lastError: w.lastError } : {}),
  };
}

/**
 * Derive operational health from a worker's lifecycle state (P2-2 G-2):
 *   connected → healthy · connecting/lost → degraded · stopped → down · idle → unknown.
 */
export function streamHealthState(state: StreamState): StreamHealthState {
  switch (state) {
    case 'connected':
      return 'healthy';
    case 'connecting':
    case 'lost':
      return 'degraded';
    case 'stopped':
      return 'down';
    case 'idle':
      return 'unknown';
  }
}

/** Project a worker into a `StreamHealthReport` (health = derived from state). */
export function toHealthReport(w: StreamWorkerState): StreamHealthReport {
  return {
    cameraId: w.cameraId,
    tenantId: w.tenantId,
    health: streamHealthState(w.state),
    state: w.state,
    since: w.since,
    recording: w.recording,
    reconnectAttempts: w.reconnectAttempts,
    framesReceived: w.framesReceived,
    ...(w.lastError !== undefined ? { lastError: w.lastError } : {}),
  };
}

export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, capMs: 30_000 };

/**
 * Exponential reconnect backoff: `min(base * 2^attempt, cap)`. Deterministic (no jitter) so the
 * reconnect schedule is testable; jitter is a later refinement. `attempt` is 0-based.
 */
export function backoffMs(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF): number {
  const exp = opts.baseMs * 2 ** Math.max(0, attempt);
  return Math.min(exp, opts.capMs);
}

/** A collision-resistant, sortable segment object name (relative to `{cameraId}/recordings/`). */
export function segmentName(startedAt: Date, seq: number): string {
  const ts = startedAt.toISOString().replace(/[:.]/g, '-');
  const n = String(seq).padStart(5, '0');
  return `seg-${ts}-${n}.mp4`;
}
