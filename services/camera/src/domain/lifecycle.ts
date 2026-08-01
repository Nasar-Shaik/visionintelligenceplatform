/**
 * Domain: the camera lifecycle state machine (P-2). Pure, framework-free, deterministic — the clock
 * is passed in, nothing here reads a database or a network.
 *
 * **Two rules carry this module, and both are enforced here rather than trusted to callers:**
 *
 * 1. **Legal transitions only.** `retired → connected` is not a transition; a decommissioned camera
 *    must be reinstated before it can be operated again (Architect P-2 rec 5). Without an explicit
 *    map, "retired" degrades into a label that any subsequent health check silently overwrites, and
 *    the estate quietly starts monitoring cameras someone deliberately took out of service.
 *
 * 2. **Measured states need measured evidence.** `connected`, `monitoring`, `degraded` and `offline`
 *    are claims about a physical device. They may only be entered with `evidence: 'measured'` backed
 *    by a `hardware` observation — a simulated probe, however flawless, cannot produce them. This is
 *    the AI-5e certification rule (CONSTRAINTS §18) applied to devices, and it is the reason a demo
 *    environment cannot report a fully connected estate that does not physically exist.
 *
 * The negative controls for both live in `test/lifecycle.test.ts` and are the tests to be most
 * suspicious of anyone "fixing".
 */
import { isHardwareEvidence } from '@vip/contracts';
import type {
  CameraLifecycle,
  CameraLifecycleState,
  CameraOperationalHealth,
  CameraTimelineEntry,
  EvidenceClass,
  LifecycleEvidence,
  StreamProbeResult,
  TimelineReasonCode,
} from '@vip/contracts';

/** How many timeline entries a camera keeps. Matches the `CameraTimeline` contract bound. */
export const TIMELINE_LIMIT = 50;

/**
 * States that are claims about a physical device rather than about its configuration. Entering one
 * requires evidence that something actually talked to the camera.
 */
const MEASURED_STATES: ReadonlySet<CameraLifecycleState> = new Set([
  'connected',
  'monitoring',
  'degraded',
  'offline',
]);

/**
 * The legal transition map (Architect P-2 rec 5).
 *
 * Read it as: from this state, a camera may next be in one of these. Notably absent —
 *   - anything → `discovered`: a camera cannot become un-known,
 *   - `retired` → anything except `configured`: reinstatement is the only way back, and it returns
 *     the camera to a *declared* state, not to whatever measured state it held when it was retired.
 *     Six months in a cupboard invalidates any prior claim that it was connected.
 */
export const LEGAL_TRANSITIONS: Readonly<
  Record<CameraLifecycleState, readonly CameraLifecycleState[]>
> = {
  discovered: ['validated', 'configured', 'retired'],
  validated: ['configured', 'offline', 'retired'],
  // `configured → monitoring` is legal (Architect P-2.1 rec 7 diagram): a running analysis session is
  // itself hardware evidence, and it can arrive without anyone having pressed "test connection"
  // first. Requiring a manual probe before the platform would admit a camera is being analysed would
  // be the state machine disbelieving its own runtime.
  configured: ['connected', 'monitoring', 'degraded', 'offline', 'validated', 'retired'],
  connected: ['monitoring', 'degraded', 'offline', 'configured', 'retired'],
  monitoring: ['connected', 'degraded', 'offline', 'retired'],
  degraded: ['connected', 'monitoring', 'offline', 'configured', 'retired'],
  offline: ['connected', 'degraded', 'monitoring', 'configured', 'retired'],
  // Reinstatement only. A retired camera re-enters at `configured` and must re-earn everything else.
  retired: ['configured'],
};

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleError';
  }
}

export function isMeasuredState(state: CameraLifecycleState): boolean {
  return MEASURED_STATES.has(state);
}

export function canTransition(from: CameraLifecycleState, to: CameraLifecycleState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export interface TransitionInput {
  to: CameraLifecycleState;
  evidence: LifecycleEvidence;
  /** Machine-readable cause (P-2.1 rec 7) — what makes a timeline filterable rather than readable. */
  reasonCode: TimelineReasonCode;
  /** The human sentence that accompanies it. */
  reason: string;
  at: Date;
  /** The class of evidence behind a measured transition. Required to enter a measured state. */
  evidenceClass?: EvidenceClass;
  /** Provenance of the measurement behind this transition, when there was one (P-2.1 rec 4). */
  probeVersion?: string;
  correlationId?: string;
}

export interface TransitionOutcome {
  lifecycle: CameraLifecycle;
  /** The timeline entry to append, or `null` when nothing changed. */
  entry: CameraTimelineEntry | null;
  /** True when the state actually moved (a re-affirmation of the same state does not). */
  changed: boolean;
}

/**
 * Apply a lifecycle transition, or refuse it.
 *
 * Refuses (throws `LifecycleError`) when the transition is not legal, or when a measured state is
 * requested without `hardware` evidence. Both are programming errors at the call site rather than
 * user input, so throwing is right: a caller that wants to *ask* whether a transition is possible
 * has `canTransition` and `isMeasuredState`.
 *
 * Re-affirming the current state is not an error and not a transition: a camera that is probed every
 * five minutes and is still `connected` should refresh its health, not accumulate fifty identical
 * timeline entries that bury the one time it went offline.
 */
export function transition(current: CameraLifecycle, input: TransitionInput): TransitionOutcome {
  const { to, evidence, reason, at } = input;

  if (isMeasuredState(to)) {
    if (evidence !== 'measured') {
      throw new LifecycleError(
        `"${to}" is a claim about a physical device and cannot be entered with "${evidence}" evidence`,
      );
    }
    if (input.evidenceClass === undefined || !isHardwareEvidence(input.evidenceClass)) {
      // The rule that makes the whole state machine honest. See CONSTRAINTS §25.
      throw new LifecycleError(
        `"${to}" requires hardware evidence; "${input.evidenceClass ?? 'none'}" proves the software, not the device`,
      );
    }
  }

  if (current.state === to) {
    return { lifecycle: { ...current }, entry: null, changed: false };
  }

  if (!canTransition(current.state, to)) {
    throw new LifecycleError(
      `"${current.state}" → "${to}" is not a legal transition` +
        (current.state === 'retired' ? ' — a retired camera must be reinstated first' : ''),
    );
  }

  const timestamp = at.toISOString();
  return {
    lifecycle: { state: to, since: timestamp, evidence, reason },
    entry: {
      at: timestamp,
      kind: 'state-changed',
      evidence,
      reasonCode: input.reasonCode,
      ...(input.probeVersion ? { probeVersion: input.probeVersion } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      from: current.state,
      to,
      detail: reason,
    },
    changed: true,
  };
}

/** The lifecycle a newly onboarded camera starts in. Declared configuration, nothing measured. */
export function initialLifecycle(at: Date, reason = 'onboarded'): CameraLifecycle {
  return { state: 'configured', since: at.toISOString(), evidence: 'declared', reason };
}

/**
 * The lifecycle to assume for a record written before P-2 existed.
 *
 * `configured` is the only honest answer. The camera demonstrably has a configuration — it is in the
 * inventory — and there is no record of anything ever having measured it. Deriving `connected` from
 * a stored `health.status === 'online'` would be manufacturing measured evidence from a field that
 * was, before P-2, only ever set by configuration validation.
 */
export function derivedLifecycle(createdAt: string): CameraLifecycle {
  return {
    state: 'configured',
    since: createdAt,
    evidence: 'declared',
    reason: 'derived for a record created before the lifecycle existed',
  };
}

/** Append to a bounded timeline, dropping the oldest entries first. */
export function appendTimeline(
  timeline: readonly CameraTimelineEntry[],
  ...entries: readonly (CameraTimelineEntry | null)[]
): CameraTimelineEntry[] {
  const next = [...timeline, ...entries.filter((e): e is CameraTimelineEntry => e !== null)];
  return next.slice(Math.max(0, next.length - TIMELINE_LIMIT));
}

/**
 * The lifecycle state a probe result justifies — and, crucially, `null` when it justifies none.
 *
 * A probe of a simulated or recorded source measures the *platform*, not the camera. It is a real
 * and useful result (the console shows every check), but it is not evidence about a device, so it
 * moves nothing. Returning `null` rather than a state is what forces every caller to handle that
 * case explicitly instead of defaulting to something plausible.
 */
export function stateForProbe(probe: StreamProbeResult): CameraLifecycleState | null {
  if (!isHardwareEvidence(probe.evidenceClass)) return null;
  if (!probe.reachable) return 'offline';
  if (probe.authentication === 'failed') return 'degraded';
  if (probe.framesRead === 0) return 'degraded';
  if (probe.checks.some((check) => check.status === 'warn')) return 'degraded';
  return 'connected';
}

/** Turn a probe result into the operational-health snapshot to persist. */
export function healthFromProbe(probe: StreamProbeResult): CameraOperationalHealth {
  return {
    observedAt: probe.probedAt,
    source: 'stream-probe',
    evidenceClass: probe.evidenceClass,
    reachable: probe.reachable,
    streamAvailable: probe.framesRead > 0,
    authentication: probe.authentication,
    ...(probe.framesRead > 0 ? { lastFrameAt: probe.probedAt } : {}),
    ...(probe.firstFrameMs !== undefined ? { rtspLatencyMs: probe.firstFrameMs } : {}),
    ...(probe.fps !== undefined ? { fps: probe.fps } : {}),
    ...(probe.resolution !== undefined ? { resolution: probe.resolution } : {}),
    ...(probe.error !== undefined ? { detail: probe.error } : {}),
  };
}
