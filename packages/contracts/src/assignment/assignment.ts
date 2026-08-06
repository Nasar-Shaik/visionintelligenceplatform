/**
 * Camera Processing Assignment — the platform **control plane** (P-8 Phase 6).
 *
 * ### What this is for
 *
 * Every camera records. Only some cameras should consume AI. This module is how that decision is
 * expressed, persisted, audited and enforced — and the reason it exists as a subsystem rather than a
 * boolean on the camera record is that the decision has to survive a restart, name a runtime, respect
 * a capacity, be reversible, and be explainable six months later to somebody asking why a camera
 * stopped being analysed on a Tuesday.
 *
 * ### ⚠️ The invariant this whole module exists to protect
 *
 * **Recording and AI processing are independent axes, and nothing here can touch the first one.**
 *
 * That is structural rather than a convention: the assignment record carries no recording field, the
 * plan carries no recording field, and the enforcement point in `services/media` sits at the
 * *perception seam* (`FrameSink.push`) — which is downstream of the decoder and downstream of the
 * segment writer. Switching AI off for a camera cannot reach the code that writes MP4 segments,
 * because the code that writes MP4 segments never reads anything in this file.
 *
 * ### Declared vs measured — the platform's evidence rule, applied to assignment
 *
 * The camera lifecycle (`CameraLifecycleState`) already draws this line: a camera is not `connected`
 * because an operator ticked a box, it is `connected` because something read a frame off it. The
 * assignment state machine draws the same line and enforces it in `transition()`:
 *
 * - Most states are **administrative** — an operator, or the control plane itself, declared them.
 *   `starting` means *we have asked*; `stopping` means *we have asked to stop*; `error` is usually a
 *   placement failure the control plane observed directly.
 * - **`running` and `stopped` are the two that require evidence**, because they are the two that
 *   would be lies if the control plane set them itself: it only ever knows that it published a plan.
 *   No action other than `observe-running` / `observe-stopped` reaches them.
 *
 * So a camera whose assignment says `running` is a camera that something confirmed is processing.
 *
 * ⚠️ That shortlist started at five and a test walking every cell of the table cut it to two:
 * `starting` is reached by `start`, `resume` and `restart`, all operator actions. The wider claim
 * read better and was false — see `OBSERVED_ASSIGNMENT_STATES`.
 *
 * ### What is deliberately NOT here
 *
 * No analytics, no behaviours, no rules, no zones, no incidents. A `ProcessingProfile` names
 * capabilities; it does not contain them and it cannot express a condition. Assignment decides
 * *whether and where* a camera is processed and stops there — everything about *what is concluded*
 * belongs to the Rule Engine, which is frozen and untouched by this milestone.
 */
import { z } from 'zod';
import { CapabilityId, IsoDateTime, TenantId } from '../common/primitives.js';

// ---------------------------------------------------------------------------------------------
// The processing state machine (Architect P-8 Phase 6 rec 2)
// ---------------------------------------------------------------------------------------------

/**
 * The formal lifecycle of one camera's AI processing.
 *
 * ⚠️ **`aiEnabled` is derived from this and is not stored separately.** A boolean beside a state
 * machine is a second source of truth for one fact, and the two drift the first time a transition is
 * added without updating the boolean. `assignmentAiEnabled()` below is the only definition.
 *
 * - `unassigned` — no runtime, no profile, no processing. Every camera starts here, including every
 *   camera that existed before this subsystem did.
 * - `assigned`   — a profile and a runtime have been chosen. **Declared.** Nothing is processing yet.
 * - `starting`   — **declared.** The plan says process; the enforcement point has not confirmed it.
 * - `running`    — frames are being processed. **Observed** — never inferred from having published a
 *   plan, because "we told media to" and "media is doing it" are different facts and the gap between
 *   them is exactly where a control plane starts lying.
 * - `paused`     — **declared.** Frames stop; per-camera state (ordering gate, tracks) is RETAINED.
 *   This is the difference from `stopped`, and it is the whole reason both exist.
 * - `stopping`   — **declared.** A release is in flight: the enforcement point must drop this
 *   camera's publisher and tracking state before the stop is real.
 * - `stopped`    — **observed.** The release happened.
 * - `error`      — placement failed, or the assigned runtime could not be reached. Reachable both
 *   administratively (`place-failed`) and by observation (`observe-error`).
 * - `recovering` — a failover is re-establishing this camera somewhere else.
 */
export const AssignmentState = z.enum([
  'unassigned',
  'assigned',
  'starting',
  'running',
  'paused',
  'stopping',
  'stopped',
  'error',
  'recovering',
]);
export type AssignmentState = z.infer<typeof AssignmentState>;

/**
 * Everything that can move an assignment.
 *
 * Operator actions (`assign`…`remove`) and observations (`observe-*`) are in one enum on purpose:
 * the transition table is then a single total function, and a test can assert **every cell** of it
 * rather than the handful somebody remembered to write down.
 */
export const AssignmentAction = z.enum([
  /* operator / control-plane actions */
  'assign',
  'start',
  'pause',
  'resume',
  'stop',
  'restart',
  'remove',
  'place-failed',
  'failover',
  /* reports from the enforcement point — the only way to reach an observed state */
  'observe-running',
  'observe-error',
  'observe-stopped',
]);
export type AssignmentAction = z.infer<typeof AssignmentAction>;

/**
 * The transition table. Absent (state, action) pair ⇒ **illegal**, and `transition()` refuses it.
 *
 * ⚠️ Exported as data rather than buried in a `switch`, so the ADR, the tests and the runtime all
 * read the same table. A state machine documented in prose and implemented in a switch is two state
 * machines.
 *
 * Two entries are worth their reasons:
 *
 * - **`remove` is legal from every state.** Bulk "Remove Assignment" across fifty cameras where
 *   three are already unassigned must not fail on those three; an idempotent removal is the only
 *   version of that operation an operator can use twice.
 * - **`error --observe-running--> running` is legal.** A runtime that comes back on its own is a
 *   thing that happens, and refusing to believe an observation because the stored state disagrees
 *   would leave a healthy camera stuck in `error` until somebody clicked something.
 */
export const ASSIGNMENT_TRANSITIONS: Readonly<
  Record<AssignmentState, Readonly<Partial<Record<AssignmentAction, AssignmentState>>>>
> = {
  unassigned: {
    assign: 'assigned',
    remove: 'unassigned',
  },
  assigned: {
    assign: 'assigned',
    start: 'starting',
    stop: 'stopping',
    'place-failed': 'error',
    failover: 'assigned',
    remove: 'unassigned',
  },
  starting: {
    'observe-running': 'running',
    'observe-error': 'error',
    'observe-stopped': 'stopped',
    /* ⚠️ Hot re-assignment — see the note under `running`. */
    assign: 'starting',
    pause: 'paused',
    stop: 'stopping',
    restart: 'starting',
    failover: 'recovering',
    'place-failed': 'error',
    remove: 'unassigned',
  },
  running: {
    /**
     * ⚠️ **`assign` is a self-transition, and that is what makes hot assignment possible** (Architect
     * rec 3). Changing a running camera's profile must change what it analyses without stopping it,
     * so the state does not move and `sessionEpoch` does not bump — the enforcement point simply
     * starts sending a different `capabilityId` on the next frame.
     *
     * Changing its *runtime* is not hot, and is not special-cased here: `applyAction` bumps the epoch
     * whenever the runtime actually changes, because the tracks live in the runtime and moving
     * container loses them. The state machine stays simple; the epoch carries the distinction.
     */
    assign: 'running',
    pause: 'paused',
    stop: 'stopping',
    restart: 'starting',
    failover: 'recovering',
    'place-failed': 'error',
    'observe-error': 'error',
    'observe-running': 'running',
    remove: 'unassigned',
  },
  paused: {
    assign: 'paused',
    resume: 'starting',
    stop: 'stopping',
    restart: 'starting',
    /**
     * ⚠️ Failover on a PAUSED camera lands back on `paused`, not on `recovering`.
     *
     * The runtime it was parked on has gone, so it must be re-placed — but re-placing it must not
     * resume it. An operator who paused a camera and came back to find it processing again would
     * stop trusting pause, and the platform would have overridden an explicit instruction because of
     * an event on the other side of the deployment.
     */
    failover: 'paused',
    'place-failed': 'error',
    'observe-error': 'error',
    remove: 'unassigned',
  },
  stopping: {
    'observe-stopped': 'stopped',
    'observe-error': 'error',
    stop: 'stopping',
    remove: 'unassigned',
  },
  stopped: {
    assign: 'assigned',
    start: 'starting',
    restart: 'starting',
    remove: 'unassigned',
  },
  error: {
    assign: 'assigned',
    failover: 'recovering',
    restart: 'starting',
    stop: 'stopping',
    'place-failed': 'error',
    'observe-running': 'running',
    remove: 'unassigned',
  },
  recovering: {
    assign: 'recovering',
    'observe-running': 'running',
    'observe-error': 'error',
    'place-failed': 'error',
    failover: 'recovering',
    stop: 'stopping',
    restart: 'starting',
    remove: 'unassigned',
  },
};

/**
 * States that **require** an observation — no administrative action reaches them.
 *
 * ### ⚠️ Exactly two, and the shortlist is the honest one
 *
 * The first draft of this list held five, and a test that walked every cell of the table caught it:
 * `starting` is reached by `start`, `resume` and `restart`, which are operator actions. Calling it
 * "observed" made the invariant read well and be false — the kind of claim that survives review
 * because nobody re-derives it.
 *
 * So the rule is stated over the two states that would be **lies** if the control plane set them
 * itself:
 *
 * - `running` — "frames are being processed". The control plane only ever knows it published a plan.
 * - `stopped` — "the per-camera state was released". Only the enforcement point can confirm a release.
 *
 * The others are all reachable administratively and honestly: `starting` means *we have asked*,
 * `stopping` means *we have asked to stop*, `error` is often a placement failure the control plane
 * observed directly, and `recovering` is a failover it initiated. `ASSIGNMENT_TRANSITIONS` enforces
 * this — no non-`observe-*` action maps to `running` or `stopped` — and a test asserts that property
 * of the table rather than trusting this comment.
 */
export const OBSERVED_ASSIGNMENT_STATES = [
  'running',
  'stopped',
] as const satisfies readonly AssignmentState[];

/** The actions that carry an observation. Only these may land on an `OBSERVED_ASSIGNMENT_STATE`. */
export const OBSERVING_ACTIONS = [
  'observe-running',
  'observe-error',
  'observe-stopped',
] as const satisfies readonly AssignmentAction[];

/** States an operator (or the control plane) may declare without evidence from the data plane. */
export const DECLARED_ASSIGNMENT_STATES = [
  'unassigned',
  'assigned',
  'starting',
  'paused',
  'stopping',
  'error',
  'recovering',
] as const satisfies readonly AssignmentState[];

/** `true` when the action may legally be applied to the state. */
export function canTransition(from: AssignmentState, action: AssignmentAction): boolean {
  return ASSIGNMENT_TRANSITIONS[from][action] !== undefined;
}

/**
 * Apply an action. Returns the next state, or `null` when the transition is illegal.
 *
 * ⚠️ Returns `null` rather than throwing so callers must handle refusal. An illegal transition is a
 * request problem (`409`), not a crash — and a bulk operation needs to report it per item.
 */
export function transition(
  from: AssignmentState,
  action: AssignmentAction,
): AssignmentState | null {
  return ASSIGNMENT_TRANSITIONS[from][action] ?? null;
}

/**
 * Whether AI is enabled for a camera in this state — **the only definition**.
 *
 * `paused` counts as enabled: the operator has not withdrawn the assignment, they have suspended it,
 * and the camera still occupies capacity on its runtime. Reporting a paused camera as "AI disabled"
 * would make the capacity numbers unexplainable.
 */
export function assignmentAiEnabled(state: AssignmentState): boolean {
  return state !== 'unassigned' && state !== 'stopped';
}

/** Whether frames should be flowing to a runtime for a camera in this state. */
export function assignmentIsProcessing(state: AssignmentState): boolean {
  return state === 'starting' || state === 'running' || state === 'recovering';
}

// ---------------------------------------------------------------------------------------------
// Processing profiles (§2)
// ---------------------------------------------------------------------------------------------

/**
 * A reusable, named set of processing capabilities a camera can be bound to.
 *
 * ### ⚠️ Cameras are bound to profiles, never to analytics (Architect rec 1)
 *
 * "Cash Counter → Retail Monitoring" survives the retail analytics being rewritten. "Cash Counter →
 * loitering-detector-v3" does not. So a profile names **capability ids** — the frozen
 * `<family>.<name>` identifiers the AI runtime already publishes — and carries no thresholds, no
 * zones and no conditions. Everything conditional is the Rule Engine's, which this milestone does
 * not touch.
 *
 * ### Extensible without a release
 *
 * The six built-ins are seeded as ordinary documents. A tenant may create its own; the shape is the
 * same, `builtIn` is the only difference, and nothing in the platform special-cases the seeds except
 * the refusal to delete them.
 */
export const ProcessingProfile = z.object({
  /** Stable slug, unique per tenant. Built-ins use the ids in `BUILT_IN_PROFILE_IDS`. */
  id: z.string().min(1).max(64),
  tenantId: TenantId,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /**
   * Capabilities this profile runs. ⚠️ The **first** entry is what the enforcement point sends to
   * the runtime today — the runtime's `/infer` takes one capability per frame. The rest are declared
   * so a future multi-capability pipeline consumes this contract unchanged rather than a new one.
   */
  capabilities: z.array(CapabilityId).min(1).max(8),
  /**
   * Sampling rate this profile asks for. ⚠️ `null` means **"use the deployment's frame rate"**, not
   * "zero fps" — a profile that silently pinned every camera to a rate nobody chose would be worse
   * than one that declines to have an opinion.
   */
  targetFps: z.number().int().min(1).max(30).nullable().default(null),
  /** Seeded by the platform. Editable; not deletable. */
  builtIn: z.boolean().default(false),
  /**
   * Whether any registered runtime advertises this profile's primary capability — **derived on read,
   * never stored**.
   *
   * ⚠️ `null` means no runtime has been observed yet, and is not `false`. The deployed runtime
   * publishes one capability today, so most of the seeded catalogue reads `false` here. That is the
   * point: an operator sees which profiles their deployment can actually run before binding a camera
   * to one, instead of discovering it from an empty events page a week later.
   */
  supported: z.boolean().nullable().default(null),
  version: z.number().int().min(1),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  updatedBy: z.string().max(200).optional(),
});
export type ProcessingProfile = z.infer<typeof ProcessingProfile>;

/**
 * The profiles every tenant is seeded with (§2).
 *
 * ⚠️ `disabled` is a real profile rather than the absence of one. "This camera is deliberately not
 * analysed" and "nobody has configured this camera yet" are different operational facts, and a site
 * survey that cannot tell them apart re-asks the same question at every review.
 */
export const BUILT_IN_PROFILE_IDS = [
  'disabled',
  'person-tracking',
  'retail-monitoring',
  'queue-analytics',
  'vehicle-analytics',
  'safety-monitoring',
] as const;
export type BuiltInProfileId = (typeof BUILT_IN_PROFILE_IDS)[number];

export const CreateProcessingProfileInput = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug'),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  capabilities: z.array(CapabilityId).min(1).max(8),
  targetFps: z.number().int().min(1).max(30).nullable().optional(),
});
export type CreateProcessingProfileInput = z.infer<typeof CreateProcessingProfileInput>;

export const UpdateProcessingProfileInput = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  capabilities: z.array(CapabilityId).min(1).max(8).optional(),
  targetFps: z.number().int().min(1).max(30).nullable().optional(),
});
export type UpdateProcessingProfileInput = z.infer<typeof UpdateProcessingProfileInput>;

// ---------------------------------------------------------------------------------------------
// Runtimes (§3)
// ---------------------------------------------------------------------------------------------

/**
 * Operational health of an AI runtime (Architect rec 5).
 *
 * ⚠️ `unknown` is not a synonym for `offline`, and the distinction is load-bearing: a runtime nobody
 * has observed yet and a runtime that was observed to be unreachable are different situations, and
 * placement treats them differently. ADR-0039 in its device form.
 */
export const RuntimeHealth = z.enum([
  'healthy',
  'degraded',
  'busy',
  'recovering',
  'offline',
  'unknown',
]);
export type RuntimeHealth = z.infer<typeof RuntimeHealth>;

/** Health states a camera may be placed on. `busy` is excluded — it has no headroom by definition. */
export const PLACEABLE_RUNTIME_HEALTH = [
  'healthy',
  'degraded',
  'recovering',
] as const satisfies readonly RuntimeHealth[];

/**
 * A registered AI runtime.
 *
 * ### ⚠️ Registration is DECLARED; health is MEASURED, and by media
 *
 * An operator (or the deployment) declares that a runtime exists at a URL with a capacity. Nothing
 * about its health is taken on that authority. The health here arrives from `services/media`, which
 * is the **only service permitted to talk to the runtime** — a property P-8 Phase 1 asserts and the
 * deployment verification checks.
 *
 * That is not an accident of layering: media is the process that actually sends frames, so a runtime
 * media can reach is a runtime that can do work, and a runtime only the control plane can reach is a
 * runtime that cannot. Polling from the control plane would have measured the wrong path.
 */
export const ProcessingRuntime = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  /** Base URL the enforcement point posts frames to, e.g. `http://inference:8085`. */
  url: z.string().min(1).max(500),
  /** Free-form operator labels (site, hardware class, `gpu`, …). Never interpreted here. */
  labels: z.array(z.string().min(1).max(50)).max(20).default([]),
  /** Cameras this runtime may hold. Placement refuses to exceed it. */
  maxCameras: z.number().int().min(0).max(10_000),
  /** Administratively available for placement. A disabled runtime keeps its cameras until moved. */
  enabled: z.boolean().default(true),

  /* --- measured --------------------------------------------------------------------------- */
  health: RuntimeHealth.default('unknown'),
  /** ⚠️ Absent means **never observed**. It is not "observed long ago" and never renders as a zero. */
  observedAt: IsoDateTime.optional(),
  /** Which enforcement point reported it (`media`), for when there is more than one. */
  observedBy: z.string().max(120).optional(),
  /** Last round-trip to the runtime, ms. `null` when the last observation could not reach it. */
  latencyMs: z.number().nullable().default(null),
  /** Why it is not healthy, verbatim from the observer. Absent when it is. */
  detail: z.string().max(500).optional(),
  /**
   * Capabilities this runtime **advertises**, read from it rather than configured.
   *
   * ⚠️ `null` means nothing has read them yet — distinct from `[]`, which means the runtime was
   * reached and offered none. Placement treats the two differently: an unread runtime is not
   * excluded on capability grounds, because excluding it would make a fresh deployment unplaceable
   * until the first poll landed.
   */
  capabilities: z.array(CapabilityId).nullable().default(null),

  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  updatedBy: z.string().max(200).optional(),
});
export type ProcessingRuntime = z.infer<typeof ProcessingRuntime>;

export const RegisterRuntimeInput = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug'),
  name: z.string().min(1).max(120),
  url: z.string().min(1).max(500),
  labels: z.array(z.string().min(1).max(50)).max(20).optional(),
  maxCameras: z.number().int().min(0).max(10_000),
  enabled: z.boolean().optional(),
});
export type RegisterRuntimeInput = z.infer<typeof RegisterRuntimeInput>;

export const UpdateRuntimeInput = z.object({
  name: z.string().min(1).max(120).optional(),
  url: z.string().min(1).max(500).optional(),
  labels: z.array(z.string().min(1).max(50)).max(20).optional(),
  maxCameras: z.number().int().min(0).max(10_000).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateRuntimeInput = z.infer<typeof UpdateRuntimeInput>;

/**
 * Derived load/capacity view of one runtime (§9, Architect rec 6).
 *
 * ⚠️ Everything here is **computed on read** from the assignments and the last observation. It is
 * never stored, because a stored counter and the documents it counts disagree the first time a write
 * fails halfway — and the counter is the one people trust.
 */
export const RuntimeCapacity = z.object({
  runtimeId: z.string(),
  name: z.string(),
  health: RuntimeHealth,
  maxCameras: z.number().int(),
  /** Cameras whose assignment names this runtime, in any AI-enabled state. */
  assignedCameras: z.number().int().min(0),
  /** Of those, the ones observed `running`. */
  activeCameras: z.number().int().min(0),
  /** Of those, the ones an operator has paused. */
  pausedCameras: z.number().int().min(0),
  /** Assigned cameras in `error` — placed here but not processing. */
  failedCameras: z.number().int().min(0),
  /**
   * `assignedCameras / maxCameras`, or `null`.
   *
   * ⚠️ `null` when `maxCameras` is 0 — a runtime declared with no capacity has an *undefined*
   * utilization, not a 100 % one and not a 0 % one. Dividing anyway is how a dashboard ends up
   * showing `Infinity%`.
   */
  utilization: z.number().nullable(),
  /** Free slots, or `null` when capacity is undeclared. */
  remaining: z.number().int().nullable(),
  observedAt: IsoDateTime.nullable(),
});
export type RuntimeCapacity = z.infer<typeof RuntimeCapacity>;

// ---------------------------------------------------------------------------------------------
// The assignment itself (§1)
// ---------------------------------------------------------------------------------------------

/** How a camera came to be where it is — carried on the assignment and on every history entry. */
export const AssignmentReason = z.enum([
  'operator',
  'bulk',
  'failover',
  'capacity',
  'runtime-removed',
  'profile-removed',
  'observation',
  'seed',
]);
export type AssignmentReason = z.infer<typeof AssignmentReason>;

/** Why placement could not put a camera anywhere. Absent when it could. */
export const PlacementFailure = z.enum([
  'no-runtime-registered',
  'no-healthy-runtime',
  'capacity-exceeded',
  'runtime-disabled',
  'runtime-not-found',
  'limit-reached',
  /**
   * No placeable runtime **advertises** the capability the profile requires.
   *
   * ⚠️ This is why placement is capability-aware rather than a capacity sum. The deployed runtime
   * publishes exactly one capability today (`perception.person-detection`), so four of the six seeded
   * profiles cannot run anywhere — and the honest thing for an operator to see is "no runtime can run
   * Vehicle Analytics", not a camera that was accepted and then quietly produced nothing. It is also
   * what multi-runtime actually means: different runtimes carry different models.
   */
  'capability-unavailable',
]);
export type PlacementFailure = z.infer<typeof PlacementFailure>;

/**
 * What an enforcement point sees for one camera — the observer's vocabulary, not the control
 * plane's.
 *
 * `released` is its own value rather than a flavour of `idle`: it is the confirmation that the
 * per-camera state was actually dropped, and it is what advances `stopping → stopped`. Without it,
 * "stopped" would mean "we asked", which is the thing this whole module refuses to do.
 *
 * `idle` is the one that has no equivalent in `AssignmentState`, and that is why observations are
 * stored in this vocabulary: media holds the camera in its plan and no frames are arriving — usually
 * because the *stream* is down, which is a recording problem showing up in the AI path rather than an
 * assignment problem. Collapsing it into any assignment state would attribute the fault to the wrong
 * subsystem.
 */
export const CameraObservationState = z.enum([
  'starting',
  'active',
  'idle',
  'paused',
  'released',
  'failed',
]);
export type CameraObservationState = z.infer<typeof CameraObservationState>;

/**
 * The observed half of an assignment — what the enforcement point last reported.
 *
 * ⚠️ Every field is nullable and `null` means **nothing has reported**, which is why this is a
 * separate object rather than four optional fields on the assignment. A consumer that has to
 * distinguish "not processing" from "we have no idea" gets one place to look.
 */
export const AssignmentObserved = z.object({
  /**
   * What the enforcement point reported, **in its own vocabulary** — see `CameraObservationState`.
   *
   * ⚠️ Deliberately not an `AssignmentState`. Mapping an observation onto the control plane's state
   * machine before storing it loses the distinction that makes it useful: `idle` (media holds this
   * camera but no frames are arriving) has no `AssignmentState` it maps to honestly, and squeezing it
   * into `assigned` would report a *declared* state as if something had measured it. `null` until an
   * enforcement point reports on this camera.
   */
  state: CameraObservationState.nullable(),
  at: IsoDateTime.nullable(),
  runtimeId: z.string().nullable(),
  /** The plan version the enforcement point had applied when it reported. */
  planVersion: z.number().int().nullable(),
  /**
   * `true` when the last report is older than the staleness window — the stored state is kept, and
   * consumers are told the measurement behind it has expired rather than shown a confident stale one.
   */
  stale: z.boolean(),
});
export type AssignmentObserved = z.infer<typeof AssignmentObserved>;

/** One camera's processing assignment. Tenant-scoped; `cameraId` is unique within a tenant. */
export const CameraAssignment = z.object({
  tenantId: TenantId,
  cameraId: z.string().min(1),
  state: AssignmentState,
  /** ⚠️ Derived from `state` — see `assignmentAiEnabled`. Present on the wire, never stored. */
  aiEnabled: z.boolean(),
  profileId: z.string().nullable(),
  runtimeId: z.string().nullable(),
  /**
   * Monotonic per assignment. Bumped on every accepted transition, so a consumer can tell a stale
   * read from a current one without comparing timestamps across two clocks.
   */
  version: z.number().int().min(0),
  /**
   * Bumped whenever this camera's processing must start from a clean slate — a restart, or a stop
   * followed by a start.
   *
   * ⚠️ **This is the mechanism that fixes the defect P-8 Phase 5 measured.** A camera switched off
   * and back on begins its frame sequence again at 1; a publisher still holding `lastSeq = 100` from
   * the previous session drops every event indefinitely. The enforcement point releases its
   * per-camera state whenever the epoch it sees differs from the epoch it applied, so re-enabling a
   * camera cannot inherit the old session's ordering gate.
   */
  sessionEpoch: z.number().int().min(0),
  reason: AssignmentReason,
  /** Why placement last failed. `null` when the camera is placed. */
  placementFailure: PlacementFailure.nullable(),
  lastError: z.string().max(500).nullable(),
  observed: AssignmentObserved,
  updatedAt: IsoDateTime,
  /** Principal that last changed it. `system` for failover and seeding. */
  updatedBy: z.string().max(200),
  createdAt: IsoDateTime,
});
export type CameraAssignment = z.infer<typeof CameraAssignment>;

// ---------------------------------------------------------------------------------------------
// Immutable audit history (§ Architect rec 4)
// ---------------------------------------------------------------------------------------------

/**
 * One appended, never-modified record of an assignment change.
 *
 * ⚠️ Carries the **whole** before and after, not a diff. A diff is only interpretable against the
 * document it was taken from, and by the time an auditor reads this the document has moved on. This
 * is the same reasoning that made the camera probe archive immutable (CONSTRAINTS §27).
 */
export const AssignmentSnapshot = z.object({
  state: AssignmentState,
  profileId: z.string().nullable(),
  runtimeId: z.string().nullable(),
  version: z.number().int(),
  sessionEpoch: z.number().int(),
});
export type AssignmentSnapshot = z.infer<typeof AssignmentSnapshot>;

export const AssignmentHistoryEntry = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  cameraId: z.string().min(1),
  at: IsoDateTime,
  action: AssignmentAction,
  reason: AssignmentReason,
  /** Free-text justification supplied by the caller. Absent when none was given. */
  note: z.string().max(500).optional(),
  /** Who. `system` when the platform acted (failover, seeding, observation). */
  actor: z.string().max(200),
  /** `null` for the first entry — there was nothing before it. */
  before: AssignmentSnapshot.nullable(),
  after: AssignmentSnapshot,
});
export type AssignmentHistoryEntry = z.infer<typeof AssignmentHistoryEntry>;

// ---------------------------------------------------------------------------------------------
// Camera groups (§ Architect rec 5) — contracts and storage only
// ---------------------------------------------------------------------------------------------

/**
 * A named set of cameras, for future bulk targeting.
 *
 * ### ⚠️ Deliberately inert this milestone
 *
 * Groups are stored and listed. **No bulk operation accepts a `groupId`**, and no assignment
 * decision reads one. The Architect asked for the contract and the storage so future bulk targeting
 * consumes this shape rather than inventing one; wiring it now would be a targeting mechanism nobody
 * has verified against a real estate.
 *
 * ### ⚠️ A group is NOT a location
 *
 * Ground Floor, Parking and Entrance are already modelled — properly, with ancestry — by the
 * Location Hierarchy (`OrgNode`, kinds `building` · `floor` · `zone`). A group is the *other* kind of
 * set: one that cuts across locations ("all cash counters", "everything the night shift watches").
 * Storing floors here as well would give the platform two answers to "where is this camera".
 */
export const CameraGroup = z.object({
  id: z.string().min(1).max(64),
  tenantId: TenantId,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /** Explicit membership. Bounded — a group is a working set, not a query. */
  cameraIds: z.array(z.string().min(1)).max(500).default([]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  updatedBy: z.string().max(200).optional(),
});
export type CameraGroup = z.infer<typeof CameraGroup>;

export const CreateCameraGroupInput = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug'),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  cameraIds: z.array(z.string().min(1)).max(500).optional(),
});
export type CreateCameraGroupInput = z.infer<typeof CreateCameraGroupInput>;

export const UpdateCameraGroupInput = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  cameraIds: z.array(z.string().min(1)).max(500).optional(),
});
export type UpdateCameraGroupInput = z.infer<typeof UpdateCameraGroupInput>;

// ---------------------------------------------------------------------------------------------
// The plan — what the enforcement point reads (§3, §11)
// ---------------------------------------------------------------------------------------------

/**
 * What the enforcement point should do with a camera.
 *
 * ⚠️ There is no `stop` value, because **absence from the plan is the stop signal**. A camera that
 * should not be processed is simply not in the plan, and the enforcement point releases anything it
 * still holds for cameras it no longer sees. One rule instead of two means a lost plan entry and a
 * stopped camera behave identically, which is the safe direction: the failure mode of this system is
 * "AI stopped", never "AI kept running on a camera nobody authorised".
 */
export const ProcessingIntent = z.enum([
  /** Deliver frames. */
  'process',
  /** Deliver no frames but RETAIN per-camera state — this is `paused`. */
  'hold',
  /** Deliver no frames and DROP per-camera state — this is `stopping`. */
  'release',
]);
export type ProcessingIntent = z.infer<typeof ProcessingIntent>;

export const AssignmentPlanEntry = z.object({
  tenantId: TenantId,
  cameraId: z.string().min(1),
  intent: ProcessingIntent,
  /** The capability to run. Resolved from the profile so the enforcement point never reads profiles. */
  capabilityId: CapabilityId,
  profileId: z.string(),
  runtimeId: z.string(),
  /** Where to send frames. Resolved here so media routes per camera without a second lookup. */
  runtimeUrl: z.string(),
  /** `null` ⇒ the deployment's configured frame rate. */
  targetFps: z.number().int().nullable(),
  assignmentVersion: z.number().int(),
  /** ⚠️ A change means "release this camera's state before processing it again". */
  sessionEpoch: z.number().int(),
});
export type AssignmentPlanEntry = z.infer<typeof AssignmentPlanEntry>;

/**
 * The whole platform's processing plan.
 *
 * ⚠️ Deliberately **not tenant-scoped**: one media deployment ingests every tenant's cameras, so a
 * per-tenant plan would mean media polling N endpoints and discovering a new tenant only by
 * accident. It is reachable only behind the internal key, never through the gateway.
 */
export const AssignmentPlan = z.object({
  /** Monotonic across the platform. Bumped once per accepted change, never derived from a clock. */
  version: z.number().int().min(0),
  generatedAt: IsoDateTime,
  entries: z.array(AssignmentPlanEntry),
});
export type AssignmentPlan = z.infer<typeof AssignmentPlan>;

// ---------------------------------------------------------------------------------------------
// Observations — what the enforcement point reports back (§3, §9)
// ---------------------------------------------------------------------------------------------

/** What media saw when it last spoke to a runtime. */
export const RuntimeObservation = z.object({
  runtimeId: z.string().min(1),
  health: RuntimeHealth,
  /** Round trip in ms, or `null` when it could not be reached. ⚠️ Never 0 for unreachable. */
  latencyMs: z.number().nullable(),
  detail: z.string().max(500).optional(),
  /** What the runtime said it can run. `null` when it could not be asked. */
  capabilities: z.array(CapabilityId).nullable(),
});
export type RuntimeObservation = z.infer<typeof RuntimeObservation>;

export const CameraObservation = z.object({
  tenantId: TenantId,
  cameraId: z.string().min(1),
  state: CameraObservationState,
  runtimeId: z.string().nullable(),
  detail: z.string().max(500).optional(),

  /* --- facts only the enforcement point can measure (§ rec 1, the capability matrix) ----------
   *
   * ⚠️ Carried on THIS channel rather than fetched by the control plane, and that is a deliberate
   * architectural choice: the control plane asking media for them would make the two services call
   * each other, and media already reports here every few seconds. Every field is optional and
   * `undefined` means *this observer did not measure it* — never `false`.
   */
  /** Segments are being written for this camera. */
  recording: z.boolean().optional(),
  /** The stream worker's health, verbatim from the supervisor. */
  recordingHealth: z.enum(['healthy', 'degraded', 'down']).optional(),
  /** Detections carrying a track id have been seen — the runtime is tracking, not just detecting. */
  tracking: z.boolean().optional(),
  /** Events published for this camera since the process started. */
  eventsPublished: z.number().int().min(0).optional(),
});
export type CameraObservation = z.infer<typeof CameraObservation>;

export const AssignmentObservationReport = z.object({
  /** Which enforcement point this is. One today (`media`); the shape allows more. */
  reportedBy: z.string().min(1).max(120),
  at: IsoDateTime,
  /** The plan version this report describes. `null` before the first plan has been applied. */
  planVersion: z.number().int().nullable(),
  runtimes: z.array(RuntimeObservation).max(100),
  cameras: z.array(CameraObservation).max(2000),
});
export type AssignmentObservationReport = z.infer<typeof AssignmentObservationReport>;

// ---------------------------------------------------------------------------------------------
// Bulk operations (§7)
// ---------------------------------------------------------------------------------------------

export const BulkAssignmentOperation = z.enum([
  'enable',
  'disable',
  'pause',
  'resume',
  'restart',
  'assign-profile',
  'assign-runtime',
  'remove',
]);
export type BulkAssignmentOperation = z.infer<typeof BulkAssignmentOperation>;

export const BulkAssignmentRequest = z
  .object({
    operation: BulkAssignmentOperation,
    cameraIds: z.array(z.string().min(1)).min(1).max(500),
    profileId: z.string().min(1).optional(),
    /** Pin a runtime. Omitted ⇒ placement chooses. */
    runtimeId: z.string().min(1).optional(),
    note: z.string().max(500).optional(),
  })
  .refine((r) => r.operation !== 'assign-profile' || r.profileId !== undefined, {
    message: 'assign-profile requires profileId',
    path: ['profileId'],
  })
  .refine((r) => r.operation !== 'assign-runtime' || r.runtimeId !== undefined, {
    message: 'assign-runtime requires runtimeId',
    path: ['runtimeId'],
  })
  .refine((r) => new Set(r.cameraIds).size === r.cameraIds.length, {
    message: 'cameraIds must be unique',
    path: ['cameraIds'],
  });
export type BulkAssignmentRequest = z.infer<typeof BulkAssignmentRequest>;

export const BulkAssignmentItemResult = z.object({
  cameraId: z.string(),
  applied: z.boolean(),
  /** Present exactly when `applied` is false. */
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  state: AssignmentState.optional(),
});
export type BulkAssignmentItemResult = z.infer<typeof BulkAssignmentItemResult>;

/**
 * The outcome of a bulk operation.
 *
 * ### ⚠️ "Transactional" is honoured as validate-all-then-apply, and `partial` is why
 *
 * The deployment runs a **standalone** MongoDB, which offers no multi-document transactions. So the
 * guarantee this gives is the one that is actually achievable and actually useful: **every item is
 * validated before any item is written**, which makes the overwhelmingly common failure — a bad
 * request, a missing camera, a full runtime — atomic with nothing written at all.
 *
 * A failure *during* the write phase (an infrastructure fault) can still leave some items applied.
 * That is reported, not hidden: `partial` is true, and every item says whether it landed. Claiming
 * atomicity we cannot deliver would be worse than naming the gap. Recorded as a known limitation
 * with the exact remedy (a replica set enables `withTransaction`).
 */
export const BulkAssignmentResult = z.object({
  operation: BulkAssignmentOperation,
  requested: z.number().int().min(0),
  applied: z.number().int().min(0),
  failed: z.number().int().min(0),
  /** ⚠️ `true` when some items applied and some did not — the state an operator must see. */
  partial: z.boolean(),
  /** The plan version after the operation. Unchanged from before when nothing applied. */
  planVersion: z.number().int(),
  items: z.array(BulkAssignmentItemResult),
});
export type BulkAssignmentResult = z.infer<typeof BulkAssignmentResult>;

// ---------------------------------------------------------------------------------------------
// Capacity planning (§ Architect rec 6)
// ---------------------------------------------------------------------------------------------

/**
 * Where placement *would* put a camera, without putting it there.
 *
 * ⚠️ Computed by the **same** pure function that performs real placement. A "suggested placement"
 * produced by a second, read-only implementation is a suggestion that stops matching the real one
 * the first time either changes — and nobody notices, because both look plausible.
 */
export const PlacementSuggestion = z.object({
  cameraId: z.string(),
  runtimeId: z.string().nullable(),
  /** Present when `runtimeId` is null. */
  failure: PlacementFailure.optional(),
});
export type PlacementSuggestion = z.infer<typeof PlacementSuggestion>;

export const AssignmentCapacityReport = z.object({
  tenantId: TenantId,
  generatedAt: IsoDateTime,
  totalCameras: z.number().int().min(0),
  assignedCameras: z.number().int().min(0),
  runningCameras: z.number().int().min(0),
  pausedCameras: z.number().int().min(0),
  /** Cameras with no assignment at all — recording only. */
  idleCameras: z.number().int().min(0),
  failedCameras: z.number().int().min(0),
  /**
   * Free slots across placeable runtimes, or `null` when **no runtime declares a capacity**.
   * ⚠️ Not 0 — "no headroom" and "nobody said" are different answers to a capacity question.
   */
  availableCapacity: z.number().int().nullable(),
  runtimes: z.array(RuntimeCapacity),
  /** For currently unplaced cameras, where they would go. Bounded to keep the response small. */
  suggestions: z.array(PlacementSuggestion).max(200),
  limits: z
    .object({
      maxAiCameras: z.number().int().nullable(),
      maxActiveRuntimes: z.number().int().nullable(),
      maxProcessingProfiles: z.number().int().nullable(),
    })
    .optional(),
});
export type AssignmentCapacityReport = z.infer<typeof AssignmentCapacityReport>;

// ---------------------------------------------------------------------------------------------
// Licensing extension point (§ Architect rec 3) — declared, not enforced
// ---------------------------------------------------------------------------------------------

/**
 * Ceilings a future licensing subsystem will supply.
 *
 * ⚠️ **No licensing is implemented and none should be inferred from this.** Every field is `null` by
 * default and `null` means *no limit configured*, not *zero allowed* — a limits object that defaulted
 * to zero would switch every deployment off the moment the check was wired in.
 *
 * The seam is real: `checkAssignmentLimits` is called on the enable path today and answers "allowed,
 * no limit configured". A licensing service later supplies the numbers and nothing else changes.
 */
export const AssignmentLimits = z.object({
  maxAiCameras: z.number().int().min(0).nullable().default(null),
  maxActiveRuntimes: z.number().int().min(0).nullable().default(null),
  maxProcessingProfiles: z.number().int().min(0).nullable().default(null),
});
export type AssignmentLimits = z.infer<typeof AssignmentLimits>;

export const NO_ASSIGNMENT_LIMITS: AssignmentLimits = {
  maxAiCameras: null,
  maxActiveRuntimes: null,
  maxProcessingProfiles: null,
};

// ---------------------------------------------------------------------------------------------
// The camera capability matrix (§ Architect rec 1)
// ---------------------------------------------------------------------------------------------

/**
 * Whether a capability is available, and **on what authority**.
 *
 * ⚠️ This is the point of the whole matrix. "Future features should never infer capability from
 * configuration" is only achievable if the answer distinguishes *configured* from *observed* — so a
 * consumer that needs a measured fact can refuse a declared one instead of quietly accepting it.
 *
 * - `measured`   — something observed it working.
 * - `declared`   — configuration says so; nothing has confirmed it.
 * - `unavailable`— observed not working.
 * - `unknown`    — nothing has said either way. ⚠️ Never rendered as `false`.
 */
export const CapabilityEvidence = z.enum(['measured', 'declared', 'unavailable', 'unknown']);
export type CapabilityEvidence = z.infer<typeof CapabilityEvidence>;

export const CapabilityFact = z.object({
  /** `null` when `evidence` is `unknown` — the whole reason this is not a bare boolean. */
  available: z.boolean().nullable(),
  evidence: CapabilityEvidence,
  /** When the measurement was taken. `null` for declared or unknown facts. */
  at: IsoDateTime.nullable(),
  detail: z.string().max(300).optional(),
});
export type CapabilityFact = z.infer<typeof CapabilityFact>;

/**
 * The single read-only answer to "what can this camera do right now".
 *
 * ### ⚠️ Composed, never stored
 *
 * Each fact is owned by the subsystem that can prove it — recording by the stream supervisor, AI and
 * tracking by the enforcement point, events by the publisher, rules by the rule catalogue. Persisting
 * a copy here would create a second version of every one of them, and the copy is the one that goes
 * stale. This is `FOUNDATIONS.md` rule 1 (*persist measurements, derive conclusions*) applied to a
 * cross-subsystem view.
 */
export const CameraCapabilityMatrix = z.object({
  tenantId: TenantId,
  cameraId: z.string().min(1),
  generatedAt: IsoDateTime,
  /** Frames are being decoded and segments written. */
  recording: CapabilityFact,
  /** Frames are reaching a runtime under an assignment. */
  aiProcessing: CapabilityFact,
  /** The runtime is producing tracks for this camera. */
  tracking: CapabilityFact,
  /** Detections from this camera are reaching the event platform. */
  events: CapabilityFact,
  /** Rules exist that could evaluate this camera's events. */
  rules: CapabilityFact,
  /** The device can produce a still image. */
  snapshots: CapabilityFact,
  /** Health of the recording path. */
  recordingHealth: CapabilityFact,
  /** Health of the AI path — the assigned runtime. */
  aiHealth: CapabilityFact,
  /** The assignment this was derived from, for the consumer that wants to act on it. */
  assignment: z
    .object({
      state: AssignmentState,
      profileId: z.string().nullable(),
      runtimeId: z.string().nullable(),
    })
    .nullable(),
});
export type CameraCapabilityMatrix = z.infer<typeof CameraCapabilityMatrix>;

/** A fact nothing has established. The default for every capability, so absence is never `false`. */
export const UNKNOWN_CAPABILITY: CapabilityFact = {
  available: null,
  evidence: 'unknown',
  at: null,
};

// ---------------------------------------------------------------------------------------------
// Per-camera processing metrics (§8, §10)
// ---------------------------------------------------------------------------------------------

/**
 * What the enforcement point measured for one camera.
 *
 * ⚠️ **Served over the tenant-scoped API, not as Prometheus labels.** Prometheus has no tenant
 * isolation: a `camera_id` label on a scrape endpoint publishes one customer's camera inventory to
 * anything that can reach `/metrics`, and the cardinality grows with the estate. Aggregates go to
 * Prometheus; per-camera figures go here, behind `assignment:read` and a verified tenant.
 */
export const CameraProcessingMetrics = z.object({
  tenantId: TenantId,
  cameraId: z.string().min(1),
  aiEnabled: z.boolean(),
  state: AssignmentState,
  profileId: z.string().nullable(),
  runtimeId: z.string().nullable(),
  /** Frames actually delivered per second over the recent window. `null` until one is delivered. */
  processingFps: z.number().nullable(),
  framesOffered: z.number().int().min(0),
  framesDelivered: z.number().int().min(0),
  /** ⚠️ Frames not sent because this camera is not assigned. Policy, not loss — its own counter. */
  framesSkippedUnassigned: z.number().int().min(0),
  framesDroppedQueueFull: z.number().int().min(0),
  queueDepth: z.number().int().min(0),
  /** Round-trip to the runtime, ms. `null` until measured. */
  processingLatencyMs: z.number().nullable(),
  /** Events published for this camera. `null` when the bridge is off — not 0. */
  eventsPublished: z.number().int().nullable(),
  /** Live tracks. `null` when tracking has not reported. */
  activeTracks: z.number().int().nullable(),
  lastFrameAt: IsoDateTime.nullable(),
  lastErrorAt: IsoDateTime.nullable(),
  lastError: z.string().max(500).nullable(),
});
export type CameraProcessingMetrics = z.infer<typeof CameraProcessingMetrics>;

/** Platform-wide assignment counters (§9). Aggregate only — safe for Prometheus. */
export const AssignmentRuntimeMetrics = z.object({
  assignedCameras: z.number().int().min(0),
  activeCameras: z.number().int().min(0),
  disabledCameras: z.number().int().min(0),
  assignmentChanges: z.number().int().min(0),
  assignmentFailures: z.number().int().min(0),
  runtimeFailovers: z.number().int().min(0),
  /** Cameras waiting for placement. */
  assignmentQueue: z.number().int().min(0),
  /** Mean ms from an accepted change to the enforcement point reporting it applied. `null` until
   *  one round trip completes — ⚠️ never 0, which would read as "instant". */
  assignmentLatencyMs: z.number().nullable(),
  planVersion: z.number().int().min(0),
});
export type AssignmentRuntimeMetrics = z.infer<typeof AssignmentRuntimeMetrics>;
