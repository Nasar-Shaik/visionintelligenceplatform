/**
 * Domain: the camera **processing assignment** — the persisted document, its transitions, and the
 * immutable audit record each one produces (P-8 Phase 6). Pure, framework-free, deterministic: the
 * clock and every identifier are passed in, and nothing here reads a database or a network.
 *
 * ### ⚠️ Two rules carry this module, exactly as they carry `lifecycle.ts`
 *
 * 1. **Legal transitions only.** The table lives in `@vip/contracts`
 *    (`ASSIGNMENT_TRANSITIONS`) so the ADR, the tests and the runtime read one table rather than
 *    three descriptions of one. `applyAction` refuses anything not in it, and returns the refusal
 *    rather than throwing — a bulk operation has to report per item which cameras it could not move.
 *
 * 2. **Observed states need an observation.** `running`, `stopped`, `error` and `recovering` are
 *    claims about what the enforcement point is *actually doing*. They may only be entered by an
 *    `observe-*` action, which only arrives on the internal reporting route. The control plane can
 *    never mark a camera `running` because it published a plan — that is the camera-lifecycle
 *    evidence rule (CONSTRAINTS §25) applied to orchestration, and it is enforced here rather than
 *    described in a comment.
 *
 * ### ⚠️ `sessionEpoch`, and the defect it exists to prevent
 *
 * P-8 Phase 5 measured a re-enabled camera publishing 0 events and dropping 32: a restarted stream
 * begins its frame sequence at 1, and a publisher still holding `lastSeq` from the previous session
 * treats every new frame as stale. The epoch is the fix — it is bumped whenever processing must start
 * from a clean slate, and the enforcement point releases its per-camera state whenever the epoch it
 * sees differs from the one it applied. Nothing depends on timing, and nothing has to be remembered
 * by a human.
 */
import {
  assignmentAiEnabled,
  transition,
  type AssignmentAction,
  type AssignmentHistoryEntry,
  type AssignmentObserved,
  type AssignmentReason,
  type AssignmentSnapshot,
  type AssignmentState,
  type CameraAssignment,
  type CameraObservation,
  type CameraObservationState,
  type PlacementFailure,
} from '@vip/contracts';
import type { TenantScoped } from '@vip/tenancy';

/** MongoDB-persisted assignment. `_id` is `{tenantId}:{cameraId}` so upserts are idempotent. */
export interface AssignmentDoc extends TenantScoped {
  _id: string;
  tenantId: string;
  cameraId: string;
  state: AssignmentState;
  profileId: string | null;
  runtimeId: string | null;
  version: number;
  sessionEpoch: number;
  reason: AssignmentReason;
  placementFailure: PlacementFailure | null;
  lastError: string | null;
  /** ⚠️ The observed half. `null` throughout means nothing has ever reported on this camera. */
  observedState: CameraObservationState | null;
  observedAt: string | null;
  observedRuntimeId: string | null;
  observedPlanVersion: number | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * How long an observation stays believable.
 *
 * ⚠️ Past this, `AssignmentObserved.stale` is true and the *measurement* is disowned — the stored
 * state is kept, because forgetting it would lose the operator's intent, but no consumer is shown a
 * confident reading taken ten minutes ago. Comfortably longer than the enforcement point's reporting
 * interval so an ordinary poll cycle never flickers into staleness.
 */
export const OBSERVATION_TTL_MS = 45_000;

export function assignmentId(tenantId: string, cameraId: string): string {
  return `${tenantId}:${cameraId}`;
}

/**
 * The assignment a camera has when nobody has assigned it.
 *
 * ⚠️ Materialised rather than inferred from a missing document. Every camera in the estate needs an
 * answer to "is AI on", including the ones onboarded before this subsystem existed, and a caller
 * that has to treat `null` as "unassigned" is a caller that will one day treat it as "unknown".
 */
export function unassigned(tenantId: string, cameraId: string, at: Date): AssignmentDoc {
  const ts = at.toISOString();
  return {
    _id: assignmentId(tenantId, cameraId),
    tenantId,
    cameraId,
    state: 'unassigned',
    profileId: null,
    runtimeId: null,
    version: 0,
    sessionEpoch: 0,
    reason: 'seed',
    placementFailure: null,
    lastError: null,
    observedState: null,
    observedAt: null,
    observedRuntimeId: null,
    observedPlanVersion: null,
    createdAt: ts,
    updatedAt: ts,
    updatedBy: 'system',
  };
}

/** Why an action was refused. Carries enough to answer the operator without a second lookup. */
export interface AssignmentRefusal {
  code: 'illegal_transition';
  message: string;
}

export interface ApplyActionInput {
  action: AssignmentAction;
  actor: string;
  reason: AssignmentReason;
  at: Date;
  note?: string;
  /** Set on `assign` / `failover`. */
  runtimeId?: string | null;
  /** Set on `assign`. */
  profileId?: string | null;
  /** Set on `place-failed`. */
  placementFailure?: PlacementFailure;
  lastError?: string | null;
  /** Identifier for the history entry — injected so the domain stays deterministic. */
  historyId: string;
}

export interface ApplyActionOutcome {
  doc: AssignmentDoc;
  history: AssignmentHistoryEntry;
  /** True when the enforcement point must drop this camera's per-camera state before resuming. */
  releasedSession: boolean;
}

/**
 * Actions after which processing must begin from a clean slate.
 *
 * ⚠️ `resume` is **not** here, and that is the distinction between pause and stop. A paused camera
 * keeps its ordering gate and its tracks, so resuming it continues the same session; a stopped or
 * restarted camera does not, so it gets a new epoch. If `resume` bumped the epoch, pause would be an
 * expensive synonym for stop and the two would stop being worth having.
 */
const EPOCH_BUMPING_ACTIONS: ReadonlySet<AssignmentAction> = new Set<AssignmentAction>([
  'start',
  'restart',
]);

/**
 * Apply an action to an assignment, or refuse it.
 *
 * Returns `AssignmentRefusal` for an illegal transition rather than throwing: illegal transitions
 * arrive from operator input (a bulk resume over a set that includes stopped cameras), so refusing
 * one is an ordinary outcome that has to be reported item by item, not an exception.
 */
export function applyAction(
  doc: AssignmentDoc,
  input: ApplyActionInput,
): ApplyActionOutcome | AssignmentRefusal {
  const next = transition(doc.state, input.action);
  if (next === null) {
    return {
      code: 'illegal_transition',
      message: `"${doc.state}" does not accept "${input.action}"`,
    };
  }

  const before = snapshot(doc);
  const ts = input.at.toISOString();

  const runtimeId = input.runtimeId === undefined ? doc.runtimeId : input.runtimeId;
  const profileId = input.profileId === undefined ? doc.profileId : input.profileId;

  /*
   * ⚠️ The epoch bumps when a *new session* begins, not on every accepted action.
   *
   * Two things start a new session, and they are different in kind:
   *
   *   1. an explicit `start`/`restart` — "forget what you knew about this camera";
   *   2. a **runtime change** — the tracks live inside the runtime process, so moving container
   *      loses them whether or not anybody asked for a restart. Deriving this from the runtime id
   *      rather than from the action is what lets `assign` stay a hot self-transition on a running
   *      camera: changing the *profile* keeps the session, changing the *runtime* does not, and the
   *      state machine does not need to know the difference.
   *
   * `pause`/`resume` deliberately do not bump — that is the entire distinction between pause and
   * stop, and without it pause would be an expensive synonym.
   */
  const movedRuntime = runtimeId !== null && doc.runtimeId !== null && runtimeId !== doc.runtimeId;
  const newSession =
    (EPOCH_BUMPING_ACTIONS.has(input.action) && doc.state !== 'starting') || movedRuntime;
  const sessionEpoch = newSession ? doc.sessionEpoch + 1 : doc.sessionEpoch;

  const doc2: AssignmentDoc = {
    ...doc,
    state: next,
    /* ⚠️ Removal clears the placement. Leaving a runtimeId on an unassigned camera would keep it
     * counted against that runtime's capacity for ever. */
    runtimeId: next === 'unassigned' ? null : runtimeId,
    profileId: next === 'unassigned' ? null : profileId,
    version: doc.version + 1,
    sessionEpoch,
    reason: input.reason,
    placementFailure: input.placementFailure ?? (next === 'error' ? doc.placementFailure : null),
    lastError:
      input.lastError === undefined ? (next === 'error' ? doc.lastError : null) : input.lastError,
    updatedAt: ts,
    updatedBy: input.actor,
    /* ⚠️ Removal also clears the observation. Keeping it would let an unassigned camera display a
     * measured `active` from the session before it was removed. */
    ...(next === 'unassigned'
      ? {
          observedState: null,
          observedAt: null,
          observedRuntimeId: null,
          observedPlanVersion: null,
        }
      : {}),
  };

  return {
    doc: doc2,
    releasedSession: sessionEpoch !== doc.sessionEpoch,
    history: {
      id: input.historyId,
      tenantId: doc.tenantId,
      cameraId: doc.cameraId,
      at: ts,
      action: input.action,
      reason: input.reason,
      ...(input.note === undefined ? {} : { note: input.note }),
      actor: input.actor,
      /* `null` for the very first entry — there was nothing before it. */
      before: doc.version === 0 && doc.state === 'unassigned' ? null : before,
      after: snapshot(doc2),
    },
  };
}

export function snapshot(doc: AssignmentDoc): AssignmentSnapshot {
  return {
    state: doc.state,
    profileId: doc.profileId,
    runtimeId: doc.runtimeId,
    version: doc.version,
    sessionEpoch: doc.sessionEpoch,
  };
}

/**
 * The state-machine action an observation justifies — and `null` when it justifies none.
 *
 * ⚠️ Returning `null` rather than a plausible action is the same discipline as `stateForProbe`: an
 * `idle` camera has not told us anything about the *assignment*, only about the stream, so it must
 * move nothing. A mapping that always produced an action would let a camera whose RTSP feed dropped
 * silently walk its assignment into `error` and page somebody about the wrong subsystem.
 */
export function actionForObservation(state: CameraObservationState): AssignmentAction | null {
  switch (state) {
    case 'active':
      return 'observe-running';
    case 'released':
      return 'observe-stopped';
    case 'failed':
      return 'observe-error';
    case 'starting':
      return 'start';
    case 'idle':
    case 'paused':
      return null;
  }
}

/**
 * Record what an enforcement point reported, without moving the state machine.
 *
 * The two are separate on purpose: the observation is *always* stored (it is a measurement, and
 * measurements are kept), while the transition it may justify is applied only if it is legal. A
 * report that arrives for a camera an operator paused two seconds ago records the truth about that
 * moment and changes nothing.
 */
export function recordObservation(
  doc: AssignmentDoc,
  observation: CameraObservation,
  planVersion: number | null,
  at: Date,
): AssignmentDoc {
  return {
    ...doc,
    observedState: observation.state,
    observedAt: at.toISOString(),
    observedRuntimeId: observation.runtimeId,
    observedPlanVersion: planVersion,
  };
}

/**
 * Present the observed half, disowning a measurement older than the TTL.
 *
 * ⚠️ `stale` rather than blanking the fields: an operator debugging at 3am needs "last seen active
 * four minutes ago" far more than they need `null`, and a consumer that must not act on old data has
 * one boolean to check. ADR-0039's rule is that an *unavailable* metric is never a zero — it is not
 * that a *stale* one must be hidden.
 */
export function observedView(doc: AssignmentDoc, now: Date): AssignmentObserved {
  const at = doc.observedAt;
  const stale = at === null ? false : now.getTime() - Date.parse(at) > OBSERVATION_TTL_MS;
  return {
    state: doc.observedState,
    at,
    runtimeId: doc.observedRuntimeId,
    planVersion: doc.observedPlanVersion,
    stale,
  };
}

/** Map a persisted assignment to its public contract shape. `aiEnabled` is derived, never stored. */
export function toAssignment(doc: AssignmentDoc, now: Date): CameraAssignment {
  return {
    tenantId: doc.tenantId,
    cameraId: doc.cameraId,
    state: doc.state,
    aiEnabled: assignmentAiEnabled(doc.state),
    profileId: doc.profileId,
    runtimeId: doc.runtimeId,
    version: doc.version,
    sessionEpoch: doc.sessionEpoch,
    reason: doc.reason,
    placementFailure: doc.placementFailure,
    lastError: doc.lastError,
    observed: observedView(doc, now),
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt,
  };
}
