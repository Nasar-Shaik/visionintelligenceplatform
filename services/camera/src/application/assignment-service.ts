/**
 * Application: **Camera Processing Assignment** — the platform control plane (P-8 Phase 6).
 *
 * ### What this service decides, and what it deliberately cannot
 *
 * It decides *whether* a camera consumes AI, *which profile* it runs, and *which runtime* hosts it.
 * It publishes that decision as a plan, records every change immutably, and believes nothing about
 * the result until an enforcement point reports back.
 *
 * ⚠️ **It cannot stop a camera recording.** There is no recording field on the assignment, no
 * recording field on the plan, and no call from here into the stream supervisor. Switching AI off is
 * structurally incapable of reaching the code that writes MP4 segments — that is the milestone's
 * central invariant, and it is held by the shape of the data rather than by care.
 *
 * ### ⚠️ Why this lives in the camera service and not in a new one
 *
 * The standing architectural guardrail is **no new services**. It also happens to be the right home:
 * media already holds an internal client to this service (`HttpCameraSource` resolves camera
 * credentials through it), so the plan travels a seam that is already deployed, authenticated and
 * tested. A twelfth service would have added a container, a gateway prefix and a readiness probe in
 * order to own something that is a property of cameras.
 *
 * The module is nonetheless self-contained — `domain/assignment.ts`, `domain/placement.ts`,
 * `domain/processing-profile.ts`, `domain/runtime-registry.ts`, `domain/assignment-limits.ts` and
 * this file. Nothing in `camera-service.ts` knows it exists.
 *
 * ### ⚠️ Runtimes are platform infrastructure, so the runtime collection is NOT tenant-scoped
 *
 * A runtime is a container with a GPU that several tenants' cameras share, exactly as one media
 * process records several tenants' streams. Its *load* is therefore a cross-tenant number, and the
 * capacity report says so: per-tenant camera counts are scoped, per-runtime occupancy is not. That
 * is a deliberate, documented trade — an operator who cannot see why placement was refused cannot
 * fix it — and it exposes counts only, never another tenant's camera or tenant identifiers.
 */
import {
  BUILT_IN_PROFILE_IDS,
  assignmentAiEnabled,
  type AssignmentCapacityReport,
  type AssignmentHistoryEntry,
  type AssignmentLimits,
  type AssignmentObservationReport,
  type AssignmentPlan,
  type AssignmentPlanEntry,
  type AssignmentReason,
  type AssignmentRuntimeMetrics,
  type AssignmentState,
  type BulkAssignmentItemResult,
  type BulkAssignmentRequest,
  type BulkAssignmentResult,
  type CameraAssignment,
  type CameraCapabilityMatrix,
  type CameraGroup,
  type CreateCameraGroupInput,
  type CreateProcessingProfileInput,
  type PlacementFailure,
  type PlacementSuggestion,
  type ProcessingIntent,
  type ProcessingProfile,
  type ProcessingRuntime,
  type RegisterRuntimeInput,
  type RuntimeCapacity,
  type UpdateCameraGroupInput,
  type UpdateProcessingProfileInput,
  type UpdateRuntimeInput,
  type PlanZone,
} from '@vip/contracts';
import { NO_ASSIGNMENT_LIMITS } from '@vip/contracts';
import type { TenantRepository, TenantScope } from '@vip/tenancy';
import type { Collection } from 'mongodb';
import type { CameraDoc } from '../domain/camera.js';
import {
  actionForObservation,
  applyAction,
  assignmentId,
  recordObservation,
  toAssignment,
  unassigned,
  type AssignmentDoc,
  type ApplyActionInput,
} from '../domain/assignment.js';
import {
  BUILT_IN_PROFILES,
  newProfile,
  primaryCapability,
  profileDocId,
  seedProfile,
  toProfile,
  type ProfileDoc,
} from '../domain/processing-profile.js';
import {
  applyObservation,
  effectiveHealth,
  newRuntime,
  placeable,
  toRuntime,
  type RuntimeDoc,
} from '../domain/runtime-registry.js';
import {
  LeastLoadedPlacement,
  availableCapacity,
  remainingCapacity,
  type PlacementStrategy,
} from '../domain/placement.js';
import { checkAssignmentLimits } from '../domain/assignment-limits.js';
import {
  buildCapabilityMatrix,
  UnavailableRules,
  type ProcessingFactsDoc,
  type RuleAvailability,
} from './capability-matrix.js';
import { badRequest, conflict, notFound } from './errors.js';
import { nullPublisher, type EventPublisher } from './events.js';

export interface Clock {
  now(): Date;
}

/** Persisted history entry — the contract shape, which already carries its tenant. */
export type HistoryDoc = AssignmentHistoryEntry & { _id: string; tenantId: string };

export interface GroupDoc {
  _id: string;
  tenantId: string;
  groupId: string;
  name: string;
  description?: string;
  cameraIds: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/**
 * The plan-version counter.
 *
 * ⚠️ A stored monotonic integer, never derived from a clock or from `max(updatedAt)`. The
 * enforcement point compares plan versions to decide whether anything changed; a version that could
 * go backwards under clock skew, or repeat within a millisecond, would make it miss a change
 * silently. `versionAt` is kept beside it so assignment latency can be measured from the moment a
 * change was accepted rather than from when somebody noticed.
 */
export interface MetaDoc {
  _id: string;
  version: number;
  versionAt: string;
}

const PLAN_META_ID = 'assignment-plan';

/** How long a history read may reach back in one page. */
const HISTORY_PAGE = 200;

export interface AssignmentServiceDeps {
  assignments: Collection<AssignmentDoc>;
  profiles: Collection<ProfileDoc>;
  history: Collection<HistoryDoc>;
  groups: Collection<GroupDoc>;
  /**
   * What enforcement points measured, per camera (§ rec 1). Separate from the assignment because
   * they are different kinds of thing: an assignment is a DECISION, a fact is a MEASUREMENT, and
   * mixing them makes it impossible to tell which fields an operator can change.
   */
  facts: Collection<ProcessingFactsDoc>;
  /** ⚠️ Platform-wide. See the header. */
  runtimes: Collection<RuntimeDoc>;
  meta: Collection<MetaDoc>;
  cameras: TenantRepository<CameraDoc>;
  clock: Clock;
  ids: { historyId(): string };
  placement?: PlacementStrategy;
  /** Reads the tenant's rule catalogue for the capability matrix. Defaults to "unknown". */
  rules?: RuleAvailability;
  /** ⚠️ Ceilings a future licensing subsystem supplies. Unset on every deployment today. */
  limits?: AssignmentLimits;
  publisher?: EventPublisher;
  /**
   * Supplies each camera's enabled detection zones for the plan (P-8 Phase 7).
   *
   * ⚠️ Optional, and its absence is a plan whose entries carry `zones: []` — which the enforcement
   * point reads as "this camera has no zones", i.e. the pre-Phase-7 behaviour. A deployment that has
   * not wired zones therefore degrades to stamping no zone on any event rather than failing, which
   * is the only safe direction: the alternative would take AI processing down over a configuration
   * subsystem nothing was using.
   */
  zones?: ZonePlanSource;
}

/** The one thing the assignment service needs from the zone service (P-8 Phase 7). */
export interface ZonePlanSource {
  planZonesByCamera(): Promise<Map<string, PlanZone[]>>;
}

/** In-process counters exported as metrics. Reset on restart, like every Prometheus counter. */
interface Counters {
  changes: number;
  failures: number;
  failovers: number;
  /** Rolling mean of accepted-change → reported-applied, ms. */
  latencySamples: number[];
}

export class AssignmentService {
  readonly #assignments: Collection<AssignmentDoc>;
  readonly #profiles: Collection<ProfileDoc>;
  readonly #history: Collection<HistoryDoc>;
  readonly #groups: Collection<GroupDoc>;
  readonly #facts: Collection<ProcessingFactsDoc>;
  readonly #rules: RuleAvailability;
  readonly #runtimes: Collection<RuntimeDoc>;
  readonly #meta: Collection<MetaDoc>;
  readonly #cameras: TenantRepository<CameraDoc>;
  readonly #clock: Clock;
  readonly #ids: { historyId(): string };
  readonly #placement: PlacementStrategy;
  readonly #limits: AssignmentLimits;
  readonly #publisher: EventPublisher;
  readonly #zones: ZonePlanSource | undefined;
  readonly #counters: Counters = { changes: 0, failures: 0, failovers: 0, latencySamples: [] };
  /**
   * The change this process is waiting to see applied, and when it was accepted.
   *
   * ⚠️ In-process and deliberately not persisted: a restart must forget it, because a change made by
   * the previous process is one this one cannot honestly time. See `report()`.
   */
  #pending: { version: number; at: number } | null = null;
  /** Tenants whose built-in profiles have been seeded in this process. Purely an optimisation. */
  readonly #seeded = new Set<string>();

  constructor(deps: AssignmentServiceDeps) {
    this.#assignments = deps.assignments;
    this.#profiles = deps.profiles;
    this.#history = deps.history;
    this.#groups = deps.groups;
    this.#facts = deps.facts;
    this.#rules = deps.rules ?? UnavailableRules;
    this.#runtimes = deps.runtimes;
    this.#meta = deps.meta;
    this.#cameras = deps.cameras;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#placement = deps.placement ?? new LeastLoadedPlacement();
    this.#limits = deps.limits ?? NO_ASSIGNMENT_LIMITS;
    this.#publisher = deps.publisher ?? nullPublisher;
    this.#zones = deps.zones;
  }

  // -------------------------------------------------------------------------------------------
  // Profiles (§2)
  // -------------------------------------------------------------------------------------------

  /**
   * Seed the built-in catalogue for a tenant, once.
   *
   * ⚠️ Idempotent by construction: each seed is an upsert keyed on `{tenantId}:{profileId}` with
   * `$setOnInsert`, so re-running it never overwrites an operator's edit to a built-in profile. The
   * in-process `#seeded` set is an optimisation and nothing depends on it — a restart re-runs the
   * upserts harmlessly.
   */
  async ensureSeeded(scope: TenantScope): Promise<void> {
    if (this.#seeded.has(scope.tenantId)) return;
    const at = this.#clock.now();
    for (const seed of BUILT_IN_PROFILES) {
      const doc = seedProfile(scope.tenantId, seed, at);
      await this.#profiles.updateOne(
        { _id: doc._id } as never,
        { $setOnInsert: doc as never },
        { upsert: true },
      );
    }
    this.#seeded.add(scope.tenantId);
  }

  async listProfiles(scope: TenantScope): Promise<ProcessingProfile[]> {
    await this.ensureSeeded(scope);
    const [docs, runtimes] = await Promise.all([
      this.#profiles
        .find({ tenantId: scope.tenantId } as never)
        .sort({ _id: 1 })
        .toArray(),
      this.#allRuntimes(),
    ]);
    const advertised = runtimes.map((r) => r.capabilities);
    return docs.map((d) => toProfile(d, advertised));
  }

  async getProfile(scope: TenantScope, profileId: string): Promise<ProcessingProfile> {
    const doc = await this.#requireProfile(scope, profileId);
    const advertised = (await this.#allRuntimes()).map((r) => r.capabilities);
    return toProfile(doc, advertised);
  }

  async createProfile(
    scope: TenantScope,
    input: CreateProcessingProfileInput,
    actor: string,
  ): Promise<ProcessingProfile> {
    await this.ensureSeeded(scope);
    const existing = await this.#profiles.findOne({
      _id: profileDocId(scope.tenantId, input.id),
    } as never);
    if (existing !== null) throw conflict(`profile "${input.id}" already exists`);

    const count = await this.#profiles.countDocuments({ tenantId: scope.tenantId } as never);
    const decision = checkAssignmentLimits('processing-profiles', count, 1, this.#limits);
    if (!decision.allowed) throw conflict(decision.message);

    const doc = newProfile(scope.tenantId, input, actor, this.#clock.now());
    await this.#profiles.insertOne(doc as never);
    const advertised = (await this.#allRuntimes()).map((r) => r.capabilities);
    return toProfile(doc, advertised);
  }

  async updateProfile(
    scope: TenantScope,
    profileId: string,
    patch: UpdateProcessingProfileInput,
    actor: string,
  ): Promise<ProcessingProfile> {
    const doc = await this.#requireProfile(scope, profileId);
    const next: ProfileDoc = {
      ...doc,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.capabilities === undefined ? {} : { capabilities: [...patch.capabilities] }),
      ...(patch.targetFps === undefined ? {} : { targetFps: patch.targetFps }),
      version: doc.version + 1,
      updatedAt: this.#clock.now().toISOString(),
      updatedBy: actor,
    };
    await this.#profiles.updateOne({ _id: doc._id } as never, { $set: next as never });
    /*
     * ⚠️ A profile edit bumps the plan so the enforcement point picks up a changed capability. It
     * does NOT bump any camera's session epoch: changing what a camera analyses is a hot change and
     * must not tear down its tracking (Architect rec 3).
     */
    await this.#bumpPlan();
    const advertised = (await this.#allRuntimes()).map((r) => r.capabilities);
    return toProfile(next, advertised);
  }

  /**
   * Delete a tenant profile.
   *
   * ⚠️ Refuses a built-in, and refuses one that cameras are bound to. Deleting a profile out from
   * under a running assignment would leave the plan naming an id that resolves to nothing, and the
   * enforcement point would have to invent a behaviour — which is how a camera silently stops being
   * analysed with nothing anywhere saying why.
   */
  async deleteProfile(scope: TenantScope, profileId: string): Promise<void> {
    const doc = await this.#requireProfile(scope, profileId);
    if (doc.builtIn) throw conflict(`"${profileId}" is a built-in profile and cannot be deleted`);
    const inUse = await this.#assignments.countDocuments({
      tenantId: scope.tenantId,
      profileId,
    } as never);
    if (inUse > 0) {
      throw conflict(`profile "${profileId}" is assigned to ${inUse} camera(s)`);
    }
    await this.#profiles.deleteOne({ _id: doc._id } as never);
  }

  // -------------------------------------------------------------------------------------------
  // Runtimes (§3)
  // -------------------------------------------------------------------------------------------

  /**
   * Register the deployment's own runtime, once, if no runtime exists yet.
   *
   * ### ⚠️ Why this exists rather than requiring an operator step
   *
   * A fresh install would otherwise come up with an inference container running, a control plane
   * that has never heard of it, and every camera unplaceable — which looks exactly like a broken
   * deployment and is fixed by an API call nobody knows to make. Seeding the runtime the deployment
   * actually ships makes `up` produce a working platform.
   *
   * ### ⚠️ `$setOnInsert`, so it is not a config push
   *
   * An operator's edits to capacity, labels or `enabled` survive every restart. The seed only ever
   * creates. It **will** re-create a runtime that was deliberately removed, on the next restart —
   * that is a deliberate trade (a deployment should converge on its own topology) and it is the
   * reason the removal path re-places cameras rather than dropping them.
   *
   * ⚠️ The default capacity is the **provisional** figure from the P-8 Phase 5 benchmark, not a
   * guess. Two cameras are the supported number; four is the provisional ceiling. Shipping a
   * capacity nobody measured would make every capacity refusal unexplainable.
   */
  async seedRuntime(input: RegisterRuntimeInput): Promise<void> {
    const existing = await this.#runtimes.countDocuments({} as never);
    if (existing > 0) return;
    const doc = newRuntime(input, 'system', this.#clock.now());
    await this.#runtimes.updateOne(
      { _id: doc._id } as never,
      { $setOnInsert: doc as never },
      { upsert: true },
    );
    await this.#bumpPlan();
  }

  async listRuntimes(): Promise<ProcessingRuntime[]> {
    const now = this.#clock.now();
    return (await this.#allRuntimes()).map((d) => toRuntime(d, now));
  }

  async getRuntime(id: string): Promise<ProcessingRuntime> {
    const doc = await this.#requireRuntime(id);
    return toRuntime(doc, this.#clock.now());
  }

  async registerRuntime(input: RegisterRuntimeInput, actor: string): Promise<ProcessingRuntime> {
    const existing = await this.#runtimes.findOne({ _id: input.id } as never);
    if (existing !== null) throw conflict(`runtime "${input.id}" already registered`);
    const active = await this.#runtimes.countDocuments({ enabled: true } as never);
    const decision = checkAssignmentLimits('active-runtimes', active, 1, this.#limits);
    if (!decision.allowed) throw conflict(decision.message);

    const doc = newRuntime(input, actor, this.#clock.now());
    await this.#runtimes.insertOne(doc as never);
    await this.#bumpPlan();
    return toRuntime(doc, this.#clock.now());
  }

  async updateRuntime(
    id: string,
    patch: UpdateRuntimeInput,
    actor: string,
  ): Promise<ProcessingRuntime> {
    const doc = await this.#requireRuntime(id);
    const next: RuntimeDoc = {
      ...doc,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.url === undefined ? {} : { url: patch.url }),
      ...(patch.labels === undefined ? {} : { labels: [...patch.labels] }),
      ...(patch.maxCameras === undefined ? {} : { maxCameras: patch.maxCameras }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      updatedAt: this.#clock.now().toISOString(),
      updatedBy: actor,
    };
    await this.#runtimes.updateOne({ _id: id } as never, { $set: next as never });
    await this.#bumpPlan();
    return toRuntime(next, this.#clock.now());
  }

  /**
   * Remove a runtime registration.
   *
   * ⚠️ Cameras on it are **not** silently dropped — they are re-placed, and the ones that cannot be
   * are moved to `error` with `runtime-removed` on the record. A removal that quietly stopped
   * analysing a dozen cameras would be indistinguishable from the platform working.
   */
  async removeRuntime(id: string, actor: string): Promise<{ reassigned: number; failed: number }> {
    await this.#requireRuntime(id);
    const affected = await this.#assignments.find({ runtimeId: id } as never).toArray();
    await this.#runtimes.deleteOne({ _id: id } as never);

    let reassigned = 0;
    let failed = 0;
    for (const doc of affected) {
      const outcome = await this.#replace(doc, 'runtime-removed', actor);
      if (outcome === 'placed') reassigned += 1;
      else if (outcome === 'failed') failed += 1;
    }
    await this.#bumpPlan();
    return { reassigned, failed };
  }

  // -------------------------------------------------------------------------------------------
  // Assignments (§1, §4)
  // -------------------------------------------------------------------------------------------

  async getAssignment(scope: TenantScope, cameraId: string): Promise<CameraAssignment> {
    await this.#requireCamera(scope, cameraId);
    const doc = await this.#loadAssignment(scope, cameraId);
    return toAssignment(doc, this.#clock.now());
  }

  async listAssignments(
    scope: TenantScope,
    filter: { state?: AssignmentState; runtimeId?: string; profileId?: string } = {},
  ): Promise<CameraAssignment[]> {
    /*
     * ⚠️ Driven from the CAMERA list, not from the assignment collection. Every camera has an
     * assignment — cameras onboarded before this subsystem existed have `unassigned`, materialised on
     * read. Listing only the assignment documents would show an estate that shrinks to the cameras
     * somebody has already touched, which is the opposite of what an assignment page is for.
     */
    const cameras = await this.#cameras.findMany(scope, {}, { limit: 5_000, sort: { _id: 1 } });
    const docs = await this.#assignments.find({ tenantId: scope.tenantId } as never).toArray();
    const byCamera = new Map(docs.map((d) => [d.cameraId, d]));
    const now = this.#clock.now();
    const out: CameraAssignment[] = [];
    for (const camera of cameras) {
      const doc = byCamera.get(camera._id) ?? unassigned(scope.tenantId, camera._id, now);
      if (filter.state !== undefined && doc.state !== filter.state) continue;
      if (filter.runtimeId !== undefined && doc.runtimeId !== filter.runtimeId) continue;
      if (filter.profileId !== undefined && doc.profileId !== filter.profileId) continue;
      out.push(toAssignment(doc, now));
    }
    return out;
  }

  /**
   * Enable AI on a camera: bind a profile, place it on a runtime, and start it.
   *
   * The three steps are one operation because two of them alone are never useful — a camera assigned
   * to a runtime and never started is a configuration nobody asked for.
   */
  async enable(
    scope: TenantScope,
    cameraId: string,
    opts: { profileId: string; runtimeId?: string | undefined; actor: string; note?: string },
    reason: AssignmentReason = 'operator',
  ): Promise<CameraAssignment> {
    const prepared = await this.#prepareEnable(scope, cameraId, opts, reason);
    if ('error' in prepared) throw prepared.error;
    await this.#commit(prepared.writes);
    await this.#bumpPlan();
    return toAssignment(prepared.doc, this.#clock.now());
  }

  /** Any non-enable action on one camera. Refusals surface as `409`. */
  async act(
    scope: TenantScope,
    cameraId: string,
    action: 'disable' | 'pause' | 'resume' | 'restart' | 'remove',
    opts: { actor: string; note?: string },
    reason: AssignmentReason = 'operator',
  ): Promise<CameraAssignment> {
    const prepared = await this.#prepareAct(scope, cameraId, action, opts, reason);
    if ('error' in prepared) throw prepared.error;
    await this.#commit(prepared.writes);
    await this.#bumpPlan();
    return toAssignment(prepared.doc, this.#clock.now());
  }

  /** Move a camera to a named runtime (or re-place it when `runtimeId` is omitted). */
  async assignRuntime(
    scope: TenantScope,
    cameraId: string,
    opts: { runtimeId?: string | undefined; actor: string; note?: string },
  ): Promise<CameraAssignment> {
    const doc = await this.#loadAssignment(scope, cameraId);
    if (doc.profileId === null) {
      throw badRequest(`camera "${cameraId}" has no profile — enable it first`);
    }
    const prepared = await this.#prepareEnable(
      scope,
      cameraId,
      {
        profileId: doc.profileId,
        runtimeId: opts.runtimeId,
        actor: opts.actor,
        ...(opts.note === undefined ? {} : { note: opts.note }),
      },
      'operator',
    );
    if ('error' in prepared) throw prepared.error;
    await this.#commit(prepared.writes);
    await this.#bumpPlan();
    return toAssignment(prepared.doc, this.#clock.now());
  }

  // -------------------------------------------------------------------------------------------
  // Bulk operations (§7)
  // -------------------------------------------------------------------------------------------

  /**
   * Apply one operation to many cameras.
   *
   * ### ⚠️ "Transactional" here means validate-all-then-apply, and `partial` is why
   *
   * The deployment runs a **standalone** MongoDB, which offers no multi-document transactions. So
   * this delivers the guarantee that is actually achievable and actually useful: **every item is
   * validated and its new document computed before any document is written.** The overwhelmingly
   * common failure — a missing camera, an unknown profile, a full runtime, an illegal transition —
   * is therefore atomic with nothing written at all.
   *
   * A fault *during* the write phase can still leave some items applied. That is reported, never
   * hidden: `partial` is true and every item says whether it landed. Claiming an atomicity we cannot
   * deliver would be worse than naming the gap (KNOWN_LIMITATIONS; a replica set enables
   * `withTransaction` and closes it without a contract change).
   */
  async bulk(
    scope: TenantScope,
    request: BulkAssignmentRequest,
    actor: string,
  ): Promise<BulkAssignmentResult> {
    /*
     * ⚠️ Writes are grouped **per camera**, not accumulated in one list.
     *
     * An enable produces two transitions (assign, then start), so a flat list made `applied` count
     * documents rather than cameras — two cameras enabled reported `applied: 4`. A count that does
     * not match `requested` is a count nobody can act on.
     */
    const prepared: { item: BulkAssignmentItemResult; writes: PendingWrite[] }[] = [];
    for (const cameraId of request.cameraIds) {
      prepared.push(await this.#prepareBulkItem(scope, cameraId, request, actor));
    }
    const items = prepared.map((p) => p.item);

    const refused = items.filter((i) => !i.applied).length;
    /*
     * ⚠️ Nothing is written when ANY item is refused. That is the atomicity a standalone MongoDB can
     * offer, and offering it only when everything validates is what makes "the request was rejected"
     * a complete description of the outcome.
     *
     * The valid items are reported as not applied **with a reason naming the batch**, rather than as
     * silent successes. `requested`, `applied` and `failed` then add up, which is the difference
     * between a result an operator can act on and one they have to interpret.
     */
    if (refused > 0) {
      this.#counters.failures += refused;
      return {
        operation: request.operation,
        requested: request.cameraIds.length,
        applied: 0,
        failed: items.length,
        partial: false,
        planVersion: await this.#planVersion(),
        items: items.map((i) =>
          i.applied
            ? {
                cameraId: i.cameraId,
                applied: false,
                error: {
                  code: 'batch_refused',
                  message: 'not applied — another camera in this operation was refused',
                },
              }
            : i,
        ),
      };
    }

    /* --- apply, one camera at a time ---------------------------------------------------------- */
    let applied = 0;
    let writeFailed = 0;
    for (const { item, writes } of prepared) {
      try {
        await this.#commit(writes);
        applied += 1;
      } catch (err) {
        writeFailed += 1;
        item.applied = false;
        item.error = {
          code: 'write_failed',
          message: err instanceof Error ? err.message : 'write failed',
        };
      }
    }
    const planVersion = applied > 0 ? await this.#bumpPlan() : await this.#planVersion();
    this.#counters.failures += writeFailed;
    return {
      operation: request.operation,
      requested: request.cameraIds.length,
      applied,
      failed: writeFailed,
      /* ⚠️ The state an operator must see: some landed, some did not. */
      partial: writeFailed > 0 && applied > 0,
      planVersion,
      items,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Audit history (§ rec 4)
  // -------------------------------------------------------------------------------------------

  /** Newest-first. Append-only — nothing in this service ever updates or deletes an entry. */
  async listHistory(
    scope: TenantScope,
    query: { cameraId?: string; limit?: number } = {},
  ): Promise<AssignmentHistoryEntry[]> {
    const filter: Record<string, unknown> = { tenantId: scope.tenantId };
    if (query.cameraId !== undefined) filter.cameraId = query.cameraId;
    const docs = await this.#history
      .find(filter as never)
      .sort({ at: -1, _id: -1 })
      .limit(Math.min(query.limit ?? 50, HISTORY_PAGE))
      .toArray();
    /* The persisted doc is the contract entry plus a Mongo `_id`; strip it rather than leak it. */
    return docs.map((doc) => {
      const entry = { ...doc } as Partial<HistoryDoc>;
      delete entry._id;
      return entry as AssignmentHistoryEntry;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Camera groups (§ rec 5) — storage only, nothing reads these to make a decision
  // -------------------------------------------------------------------------------------------

  async listGroups(scope: TenantScope): Promise<CameraGroup[]> {
    const docs = await this.#groups
      .find({ tenantId: scope.tenantId } as never)
      .sort({ _id: 1 })
      .toArray();
    return docs.map(toGroup);
  }

  async createGroup(
    scope: TenantScope,
    input: CreateCameraGroupInput,
    actor: string,
  ): Promise<CameraGroup> {
    const _id = `${scope.tenantId}:${input.id}`;
    if ((await this.#groups.findOne({ _id } as never)) !== null) {
      throw conflict(`group "${input.id}" already exists`);
    }
    const ts = this.#clock.now().toISOString();
    const doc: GroupDoc = {
      _id,
      tenantId: scope.tenantId,
      groupId: input.id,
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      cameraIds: input.cameraIds ?? [],
      createdAt: ts,
      updatedAt: ts,
      updatedBy: actor,
    };
    await this.#groups.insertOne(doc as never);
    return toGroup(doc);
  }

  async updateGroup(
    scope: TenantScope,
    groupId: string,
    patch: UpdateCameraGroupInput,
    actor: string,
  ): Promise<CameraGroup> {
    const doc = await this.#groups.findOne({
      _id: `${scope.tenantId}:${groupId}`,
      tenantId: scope.tenantId,
    } as never);
    if (doc === null) throw notFound(`no group "${groupId}"`);
    const next: GroupDoc = {
      ...doc,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.cameraIds === undefined ? {} : { cameraIds: [...patch.cameraIds] }),
      updatedAt: this.#clock.now().toISOString(),
      updatedBy: actor,
    };
    await this.#groups.updateOne({ _id: doc._id } as never, { $set: next as never });
    return toGroup(next);
  }

  async deleteGroup(scope: TenantScope, groupId: string): Promise<void> {
    const removed = await this.#groups.deleteOne({
      _id: `${scope.tenantId}:${groupId}`,
      tenantId: scope.tenantId,
    } as never);
    if (removed.deletedCount === 0) throw notFound(`no group "${groupId}"`);
  }

  // -------------------------------------------------------------------------------------------
  // Capacity planning (§ rec 6)
  // -------------------------------------------------------------------------------------------

  /**
   * The read-only capacity view future UI and any future balancer consume instead of computing
   * their own.
   *
   * ⚠️ `suggestions` are produced by calling the **same** placement strategy that performs real
   * placement. A read-only reimplementation would diverge the first time either changed, and nobody
   * would notice because both would keep returning something plausible.
   */
  async capacity(scope: TenantScope): Promise<AssignmentCapacityReport> {
    const now = this.#clock.now();
    const [cameras, docs, runtimes, load, profiles] = await Promise.all([
      this.#cameras.count(scope),
      this.#assignments.find({ tenantId: scope.tenantId } as never).toArray(),
      this.#allRuntimes(),
      this.#runtimeLoad(),
      this.#profiles.find({ tenantId: scope.tenantId } as never).toArray(),
    ]);

    const byState = (state: AssignmentState): number =>
      docs.filter((d) => d.state === state).length;
    const assigned = docs.filter((d) => assignmentAiEnabled(d.state)).length;

    const runtimeViews: RuntimeCapacity[] = runtimes.map((r) => {
      const used = load.get(r._id) ?? 0;
      const scoped = docs.filter((d) => d.runtimeId === r._id);
      const remaining = remainingCapacity(r, used);
      return {
        runtimeId: r._id,
        name: r.name,
        health: effectiveHealth(r, now),
        maxCameras: r.maxCameras,
        /* ⚠️ Platform-wide occupancy — a shared runtime's load is not a per-tenant number. */
        assignedCameras: used,
        activeCameras: scoped.filter((d) => d.state === 'running').length,
        pausedCameras: scoped.filter((d) => d.state === 'paused').length,
        failedCameras: scoped.filter((d) => d.state === 'error').length,
        utilization: r.maxCameras === 0 ? null : used / r.maxCameras,
        remaining,
        observedAt: r.observedAt,
      };
    });

    /* Where the currently unplaced cameras would go — the same function, not a second one. */
    const defaultProfile = profiles.find((p) => p.profileId === 'person-tracking') ?? profiles[0];
    const unplaced = docs.filter((d) => d.runtimeId === null && assignmentAiEnabled(d.state));
    const suggestions: PlacementSuggestion[] = unplaced.slice(0, 200).map((d) => {
      const profile =
        (d.profileId === null ? undefined : profiles.find((p) => p.profileId === d.profileId)) ??
        defaultProfile;
      if (profile === undefined) return { cameraId: d.cameraId, runtimeId: null };
      const result = this.#placement.place(
        { capabilityId: primaryCapability(profile), currentRuntimeId: d.runtimeId },
        runtimes,
        load,
        now,
      );
      return result.placed
        ? { cameraId: d.cameraId, runtimeId: result.runtimeId }
        : { cameraId: d.cameraId, runtimeId: null, failure: result.failure };
    });

    return {
      tenantId: scope.tenantId,
      generatedAt: now.toISOString(),
      totalCameras: cameras,
      assignedCameras: assigned,
      runningCameras: byState('running'),
      pausedCameras: byState('paused'),
      /* Cameras nobody has assigned — recording only. */
      idleCameras: Math.max(0, cameras - assigned),
      failedCameras: byState('error'),
      availableCapacity: availableCapacity(runtimes, load, now),
      runtimes: runtimeViews,
      suggestions,
      limits: {
        maxAiCameras: this.#limits.maxAiCameras,
        maxActiveRuntimes: this.#limits.maxActiveRuntimes,
        maxProcessingProfiles: this.#limits.maxProcessingProfiles,
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // The plan and the observation channel (internal — enforcement point only)
  // -------------------------------------------------------------------------------------------

  /**
   * The whole platform's processing plan.
   *
   * ⚠️ Cross-tenant by necessity: one media deployment ingests every tenant's cameras, so a
   * per-tenant plan would mean media polling N endpoints and discovering a new tenant by accident.
   * Reachable only behind the internal key, never through the gateway.
   *
   * ⚠️ **A camera absent from the plan is a camera to release.** There is no `stop` entry, so a lost
   * entry and a stopped camera behave identically — and the failure mode of this system is therefore
   * "AI stopped", never "AI kept running on a camera nobody authorised".
   */
  async plan(): Promise<AssignmentPlan> {
    const now = this.#clock.now();
    const [meta, runtimes, docs, zonesByCamera] = await Promise.all([
      this.#metaDoc(),
      this.#allRuntimes(),
      this.#assignments
        .find({
          state: { $in: ['assigned', 'starting', 'running', 'recovering', 'paused'] },
        } as never)
        .toArray(),
      /*
       * ⚠️ P-8 Phase 7. One cross-tenant query for every enabled zone, joined in memory — never a
       * query per camera. The plan is polled every few seconds by every media process, and an N+1
       * here would be invisible on a fixture and quadratic on an estate.
       */
      this.#zones === undefined
        ? Promise.resolve(new Map<string, PlanZone[]>())
        : this.#zones.planZonesByCamera(),
    ]);
    const runtimeById = new Map(runtimes.map((r) => [r._id, r]));
    const profileCache = new Map<string, ProfileDoc | null>();

    const entries: AssignmentPlanEntry[] = [];
    for (const doc of docs) {
      if (doc.runtimeId === null || doc.profileId === null) continue;
      const runtime = runtimeById.get(doc.runtimeId);
      if (runtime === undefined) continue;
      const key = profileDocId(doc.tenantId, doc.profileId);
      let profile = profileCache.get(key);
      if (profile === undefined) {
        profile = await this.#profiles.findOne({ _id: key } as never);
        profileCache.set(key, profile);
      }
      if (profile === null) continue;
      const intent: ProcessingIntent = doc.state === 'paused' ? 'hold' : 'process';
      entries.push({
        tenantId: doc.tenantId,
        cameraId: doc.cameraId,
        intent,
        capabilityId: primaryCapability(profile),
        profileId: doc.profileId,
        runtimeId: doc.runtimeId,
        runtimeUrl: runtime.url,
        targetFps: profile.targetFps,
        assignmentVersion: doc.version,
        sessionEpoch: doc.sessionEpoch,
        zones: zonesByCamera.get(`${doc.tenantId}:${doc.cameraId}`) ?? [],
        /*
         * ⚠️ Derived from the zones themselves, not stored. The maximum zone version on the camera
         * changes whenever any of its zones is edited, added or removed — and a derived value cannot
         * disagree with the thing it describes after a partial write, which a stored counter can.
         * Same reasoning as `RuleCompilation`'s hashes being derived rather than persisted.
         */
        zoneVersion: maxZoneVersion(zonesByCamera.get(`${doc.tenantId}:${doc.cameraId}`)),
      });
    }

    /* Stopping cameras stay in the plan for one cycle so the release is explicit and confirmable. */
    const stopping = await this.#assignments.find({ state: 'stopping' } as never).toArray();
    for (const doc of stopping) {
      if (doc.runtimeId === null || doc.profileId === null) continue;
      const runtime = runtimeById.get(doc.runtimeId);
      entries.push({
        tenantId: doc.tenantId,
        cameraId: doc.cameraId,
        intent: 'release',
        capabilityId: 'perception.person-detection',
        profileId: doc.profileId,
        runtimeId: doc.runtimeId,
        runtimeUrl: runtime?.url ?? '',
        targetFps: null,
        assignmentVersion: doc.version,
        sessionEpoch: doc.sessionEpoch,
        /* ⚠️ A release carries no zones: there is nothing left to evaluate them against. */
        zones: [],
        zoneVersion: 0,
      });
    }

    entries.sort((a, b) =>
      a.tenantId === b.tenantId
        ? a.cameraId.localeCompare(b.cameraId)
        : a.tenantId.localeCompare(b.tenantId),
    );
    return {
      version: meta.version,
      generatedAt: now.toISOString(),
      entries,
      /* ⚠️ Every registered runtime, not just the ones with cameras — see `AssignmentPlan`. */
      runtimes: runtimes.map((r) => ({ runtimeId: r._id, url: r.url })),
    };
  }

  /**
   * Take a report from an enforcement point: runtime health, per-camera state, and the plan version
   * it had applied.
   *
   * ⚠️ **This is the only path to an observed state.** Everything the control plane claims to know
   * about what is actually running enters here, and nowhere else.
   *
   * Failover happens here too, because this is the moment the platform learns a runtime is gone:
   * every camera on a runtime that is no longer placeable is re-placed, and the ones that cannot be
   * are moved to `error` rather than left pointing at a dead container.
   */
  async report(report: AssignmentObservationReport): Promise<{ failover: number; failed: number }> {
    const now = this.#clock.now();

    /* --- runtime health ----------------------------------------------------------------------- */
    for (const observation of report.runtimes) {
      const doc = await this.#runtimes.findOne({ _id: observation.runtimeId } as never);
      if (doc === null) continue;
      const next = applyObservation(doc, observation, report.reportedBy, now);
      await this.#runtimes.updateOne({ _id: doc._id } as never, { $set: next as never });
    }

    /* --- per-camera observations -------------------------------------------------------------- */
    for (const observation of report.cameras) {
      /*
       * ⚠️ The measured facts are stored for EVERY reported camera, including ones with no
       * assignment. A camera that records and is deliberately not analysed still has to be able to
       * answer "are you recording?" — and that is the row the capability matrix reads.
       */
      const factsId = assignmentId(observation.tenantId, observation.cameraId);
      await this.#facts.updateOne(
        { _id: factsId } as never,
        {
          $set: {
            _id: factsId,
            tenantId: observation.tenantId,
            cameraId: observation.cameraId,
            at: now.toISOString(),
            reportedBy: report.reportedBy,
            ...(observation.recording === undefined ? {} : { recording: observation.recording }),
            ...(observation.recordingHealth === undefined
              ? {}
              : { recordingHealth: observation.recordingHealth }),
            ...(observation.tracking === undefined ? {} : { tracking: observation.tracking }),
            ...(observation.eventsPublished === undefined
              ? {}
              : { eventsPublished: observation.eventsPublished }),
          } as never,
        },
        { upsert: true },
      );

      const doc = await this.#assignments.findOne({ _id: factsId } as never);
      if (doc === null) continue;
      let next = recordObservation(doc, observation, report.planVersion, now);
      const action = actionForObservation(observation.state);
      if (action !== null) {
        const outcome = applyAction(next, {
          action,
          actor: 'system',
          reason: 'observation',
          at: now,
          historyId: this.#ids.historyId(),
          ...(observation.detail === undefined ? {} : { lastError: observation.detail }),
        });
        /* ⚠️ An illegal transition is IGNORED, not an error: a report about a camera an operator
         * paused a second ago describes a moment that has passed. The observation is still stored. */
        if (!('code' in outcome)) {
          next = outcome.doc;
          await this.#history.insertOne({
            _id: outcome.history.id,
            ...outcome.history,
          } as never);
        }
      }
      await this.#assignments.updateOne({ _id: doc._id } as never, { $set: next as never });
    }

    /* --- assignment latency ------------------------------------------------------------------- */
    /*
     * ⚠️ **Measured only for changes THIS process made, and only once each.**
     *
     * Two wrong versions preceded this one, and the benchmark ladder caught both because each
     * produced a number that fell as load rose — the signature of a metric measuring the wrong
     * quantity, since more changes means a more recent baseline.
     *
     *   1. Sampling on *every* report where the enforcement point was up to date measured "time
     *      since the last change", not "time to apply one". 588 s at one camera → 196 s at sixteen.
     *   2. Sampling once per version, but from the meta document's `versionAt`, meant the first
     *      report after a **restart** measured the age of the last change ever made — one poisoned
     *      sample dominating a rolling mean of a hundred. 89 s at one camera → 17 s at sixteen.
     *
     * The pending mark is set when this process accepts a change and cleared by the first report
     * that confirms it. A control plane that has just restarted therefore reports `null` until it
     * accepts one — which is correct, and is what ADR-0039 asks for.
     */
    if (
      this.#pending !== null &&
      report.planVersion !== null &&
      report.planVersion >= this.#pending.version
    ) {
      const ms = now.getTime() - this.#pending.at;
      this.#pending = null;
      if (Number.isFinite(ms) && ms >= 0) {
        this.#counters.latencySamples.push(ms);
        if (this.#counters.latencySamples.length > 100) this.#counters.latencySamples.shift();
      }
    }

    /* --- failover ----------------------------------------------------------------------------- */
    return this.#reconcile(now);
  }

  /** Aggregate counters (§9). Safe for Prometheus — no tenant, no camera. */
  async metrics(): Promise<AssignmentRuntimeMetrics> {
    const [docs, meta] = await Promise.all([
      this.#assignments.find({} as never).toArray(),
      this.#metaDoc(),
    ]);
    const samples = this.#counters.latencySamples;
    return {
      assignedCameras: docs.filter((d) => assignmentAiEnabled(d.state)).length,
      activeCameras: docs.filter((d) => d.state === 'running').length,
      disabledCameras: docs.filter((d) => !assignmentAiEnabled(d.state)).length,
      assignmentChanges: this.#counters.changes,
      assignmentFailures: this.#counters.failures,
      runtimeFailovers: this.#counters.failovers,
      assignmentQueue: docs.filter((d) => assignmentAiEnabled(d.state) && d.runtimeId === null)
        .length,
      /* ⚠️ `null` until a round trip completes — never 0, which would read as "instant". */
      assignmentLatencyMs:
        samples.length === 0 ? null : samples.reduce((a, b) => a + b, 0) / samples.length,
      planVersion: meta.version,
    };
  }

  /**
   * The camera capability matrix (§ rec 1) — one read-only answer future modules consume instead of
   * inferring capability from configuration.
   *
   * `authorization` is the caller's own header, forwarded to the rule catalogue so their authority is
   * preserved exactly. See `HttpRuleAvailability`.
   */
  async capabilityMatrix(
    scope: TenantScope,
    cameraId: string,
    authorization?: string,
  ): Promise<CameraCapabilityMatrix> {
    const camera = await this.#requireCamera(scope, cameraId);
    const now = this.#clock.now();
    const assignment = await this.#loadAssignment(scope, cameraId);
    const facts = await this.#facts.findOne({
      _id: assignmentId(scope.tenantId, cameraId),
      tenantId: scope.tenantId,
    } as never);
    const runtime =
      assignment.runtimeId === null
        ? null
        : await this.#runtimes.findOne({ _id: assignment.runtimeId } as never);
    const enabledRules = await this.#rules.enabledRuleCount(scope.tenantId, authorization);
    return buildCapabilityMatrix({
      camera,
      assignment,
      facts,
      runtimeHealth: runtime === null ? null : effectiveHealth(runtime, now),
      enabledRules,
      now,
    });
  }

  // -------------------------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------------------------

  async #allRuntimes(): Promise<RuntimeDoc[]> {
    return this.#runtimes
      .find({} as never)
      .sort({ _id: 1 })
      .toArray();
  }

  /** Cameras per runtime, counted across every tenant — a runtime is shared infrastructure. */
  async #runtimeLoad(): Promise<Map<string, number>> {
    const docs = await this.#assignments.find({ runtimeId: { $ne: null } } as never).toArray();
    const load = new Map<string, number>();
    for (const doc of docs) {
      if (doc.runtimeId === null || !assignmentAiEnabled(doc.state)) continue;
      load.set(doc.runtimeId, (load.get(doc.runtimeId) ?? 0) + 1);
    }
    return load;
  }

  async #loadAssignment(scope: TenantScope, cameraId: string): Promise<AssignmentDoc> {
    const doc = await this.#assignments.findOne({
      _id: assignmentId(scope.tenantId, cameraId),
      tenantId: scope.tenantId,
    } as never);
    return doc ?? unassigned(scope.tenantId, cameraId, this.#clock.now());
  }

  async #requireCamera(scope: TenantScope, cameraId: string): Promise<CameraDoc> {
    const camera = await this.#cameras.findOne(scope, { _id: cameraId } as never);
    if (camera === null) throw notFound(`no camera "${cameraId}"`);
    return camera;
  }

  async #requireProfile(scope: TenantScope, profileId: string): Promise<ProfileDoc> {
    await this.ensureSeeded(scope);
    const doc = await this.#profiles.findOne({
      _id: profileDocId(scope.tenantId, profileId),
      tenantId: scope.tenantId,
    } as never);
    if (doc === null) throw notFound(`no profile "${profileId}"`);
    return doc;
  }

  async #requireRuntime(id: string): Promise<RuntimeDoc> {
    const doc = await this.#runtimes.findOne({ _id: id } as never);
    if (doc === null) throw notFound(`no runtime "${id}"`);
    return doc;
  }

  async #metaDoc(): Promise<MetaDoc> {
    const doc = await this.#meta.findOne({ _id: PLAN_META_ID } as never);
    return doc ?? { _id: PLAN_META_ID, version: 0, versionAt: new Date(0).toISOString() };
  }

  async #planVersion(): Promise<number> {
    return (await this.#metaDoc()).version;
  }

  /** Bump the plan version. One increment per accepted operation, not per document written. */
  /**
   * Make the next plan poll see a change that did not come from an assignment (P-8 Phase 7).
   *
   * ⚠️ Called by the zone service, and **not** marked as a pending change: `#pending` anchors the
   * assignment-latency metric, and timing a polygon edit as though it were a reassignment would
   * pollute a measurement that exists to answer a different question. The plan version still moves,
   * which is all the enforcement point needs.
   */
  async bumpPlanVersion(): Promise<number> {
    const now = this.#clock.now();
    await this.#meta.updateOne(
      { _id: PLAN_META_ID } as never,
      { $inc: { version: 1 } as never, $set: { versionAt: now.toISOString() } as never },
      { upsert: true },
    );
    return this.#planVersion();
  }

  async #bumpPlan(): Promise<number> {
    const now = this.#clock.now();
    await this.#meta.updateOne(
      { _id: PLAN_META_ID } as never,
      { $inc: { version: 1 } as never, $set: { versionAt: now.toISOString() } as never },
      { upsert: true },
    );
    const version = await this.#planVersion();
    /*
     * ⚠️ The oldest unconfirmed change wins. A burst of changes should be timed from the FIRST one
     * an operator made to the moment the data plane caught up — overwriting the mark on every bump
     * would time only the last change in a bulk operation and report a bulk apply as instant.
     */
    if (this.#pending === null) this.#pending = { version, at: now.getTime() };
    return version;
  }

  async #commit(writes: readonly PendingWrite[]): Promise<void> {
    for (const write of writes) {
      await this.#assignments.updateOne(
        { _id: write.doc._id } as never,
        { $set: write.doc as never },
        { upsert: true },
      );
      await this.#history.insertOne({ _id: write.history.id, ...write.history } as never);
      this.#counters.changes += 1;
      await this.#publisher.publish({
        type: 'camera.assignment.changed',
        tenantId: write.doc.tenantId,
        payload: {
          cameraId: write.doc.cameraId,
          state: write.doc.state,
          profileId: write.doc.profileId,
          runtimeId: write.doc.runtimeId,
          version: write.doc.version,
          action: write.history.action,
        },
      });
    }
  }

  /**
   * Compute (never write) the documents an enable produces.
   *
   * Split from `enable` so `bulk` can validate every item before writing any — the whole basis of
   * the atomicity this can honestly offer.
   */
  async #prepareEnable(
    scope: TenantScope,
    cameraId: string,
    opts: { profileId: string; runtimeId?: string | undefined; actor: string; note?: string },
    reason: AssignmentReason,
  ): Promise<{ doc: AssignmentDoc; writes: PendingWrite[] } | { error: Error }> {
    const now = this.#clock.now();
    try {
      await this.#requireCamera(scope, cameraId);
      const profile = await this.#requireProfile(scope, opts.profileId);
      const current = await this.#loadAssignment(scope, cameraId);

      /* ⚠️ The licensing seam, executed on every enable so it is never first executed in production. */
      if (!assignmentAiEnabled(current.state)) {
        const enabled = await this.#assignments.countDocuments({
          tenantId: scope.tenantId,
          state: { $nin: ['unassigned', 'stopped'] },
        } as never);
        const decision = checkAssignmentLimits('ai-cameras', enabled, 1, this.#limits);
        if (!decision.allowed) return { error: conflict(decision.message) };
      }

      const [runtimes, load] = await Promise.all([this.#allRuntimes(), this.#runtimeLoad()]);
      const placement = this.#placement.place(
        {
          capabilityId: primaryCapability(profile),
          pinnedRuntimeId: opts.runtimeId,
          currentRuntimeId: current.runtimeId,
        },
        runtimes,
        load,
        now,
      );

      /*
       * ⚠️ A placement failure on an *enable* refuses the request and writes NOTHING.
       *
       * The tempting alternative — park the camera in `error` with the reason on it — would leave a
       * junk assignment behind every rejected request, and would break the one atomicity guarantee a
       * bulk operation can honestly make (validate everything, then write). The reason is not lost:
       * it comes back as a `409` naming the failure, and it is counted in `assignmentFailures`.
       *
       * Failover is the opposite case and is handled the opposite way (`#replace` writes `error`),
       * because there the camera *was* running and has genuinely stopped — that is a state change,
       * not a rejected request.
       */
      if (!placement.placed) {
        this.#counters.failures += 1;
        return { error: conflict(placementMessage(placement.failure)) };
      }

      /*
       * Two steps, because they are two facts: the camera is placed, and then it is started. The
       * history shows both, which is what makes "when did this camera start being analysed"
       * answerable.
       */
      const writes: PendingWrite[] = [];
      const assigned = this.#step(current, {
        action: 'assign',
        actor: opts.actor,
        reason,
        at: now,
        historyId: this.#ids.historyId(),
        runtimeId: placement.runtimeId,
        profileId: opts.profileId,
        lastError: null,
        ...(opts.note === undefined ? {} : { note: opts.note }),
      });
      if ('error' in assigned) return assigned;
      writes.push(assigned.write);

      /*
       * ⚠️ `start` only when the camera is not already processing. `assign` is a self-transition on
       * `running`/`starting`/`paused`/`recovering` — that is what makes a profile change hot — and
       * following it with a `start` there would be an illegal transition, refusing exactly the
       * operation the Architect asked to be applied live.
       */
      if (assigned.write.doc.state !== 'assigned') {
        return { doc: assigned.write.doc, writes };
      }

      const started = this.#step(assigned.write.doc, {
        action: 'start',
        actor: opts.actor,
        reason,
        at: now,
        historyId: this.#ids.historyId(),
      });
      if ('error' in started) return started;
      writes.push(started.write);

      return { doc: started.write.doc, writes };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  async #prepareAct(
    scope: TenantScope,
    cameraId: string,
    action: 'disable' | 'pause' | 'resume' | 'restart' | 'remove',
    opts: { actor: string; note?: string },
    reason: AssignmentReason,
  ): Promise<{ doc: AssignmentDoc; writes: PendingWrite[] } | { error: Error }> {
    const now = this.#clock.now();
    try {
      await this.#requireCamera(scope, cameraId);
      const current = await this.#loadAssignment(scope, cameraId);
      const mapped = action === 'disable' ? 'stop' : action;
      const stepped = this.#step(current, {
        action: mapped,
        actor: opts.actor,
        reason,
        at: now,
        historyId: this.#ids.historyId(),
        ...(opts.note === undefined ? {} : { note: opts.note }),
      });
      if ('error' in stepped) return stepped;
      return { doc: stepped.write.doc, writes: [stepped.write] };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  async #prepareBulkItem(
    scope: TenantScope,
    cameraId: string,
    request: BulkAssignmentRequest,
    actor: string,
  ): Promise<{ item: BulkAssignmentItemResult; writes: PendingWrite[] }> {
    const opts = { actor, ...(request.note === undefined ? {} : { note: request.note }) };
    const prepared =
      request.operation === 'enable' || request.operation === 'assign-profile'
        ? await this.#prepareEnable(
            scope,
            cameraId,
            { ...opts, profileId: request.profileId ?? 'person-tracking' },
            'bulk',
          )
        : request.operation === 'assign-runtime'
          ? await this.#prepareEnableOnRuntime(scope, cameraId, request, opts)
          : await this.#prepareAct(
              scope,
              cameraId,
              request.operation === 'disable' ? 'disable' : request.operation,
              opts,
              'bulk',
            );

    if ('error' in prepared) {
      return {
        item: {
          cameraId,
          applied: false,
          error: { code: 'refused', message: prepared.error.message },
        },
        writes: [],
      };
    }
    return {
      item: { cameraId, applied: true, state: prepared.doc.state },
      writes: prepared.writes,
    };
  }

  async #prepareEnableOnRuntime(
    scope: TenantScope,
    cameraId: string,
    request: BulkAssignmentRequest,
    opts: { actor: string; note?: string },
  ): Promise<{ doc: AssignmentDoc; writes: PendingWrite[] } | { error: Error }> {
    const current = await this.#loadAssignment(scope, cameraId);
    const profileId = request.profileId ?? current.profileId;
    if (profileId === null) {
      return { error: badRequest(`camera "${cameraId}" has no profile — enable it first`) };
    }
    return this.#prepareEnable(
      scope,
      cameraId,
      {
        ...opts,
        profileId,
        ...(request.runtimeId === undefined ? {} : { runtimeId: request.runtimeId }),
      },
      'bulk',
    );
  }

  /** One transition, computed and not written. */
  #step(doc: AssignmentDoc, input: ApplyActionInput): { write: PendingWrite } | { error: Error } {
    const outcome = applyAction(doc, input);
    if ('code' in outcome) {
      return { error: conflict(outcome.message) };
    }
    return { write: { doc: outcome.doc, history: outcome.history } };
  }

  /**
   * Move every camera that is not where it should be (§3 — failover *and* recovery).
   *
   * ### ⚠️ Two populations, and the second one was missing
   *
   * - **a camera whose runtime became unusable** — move it;
   * - **a camera stranded in `error`** — retry it, because a runtime may have come back.
   *
   * The first version swept only the first, and the deployment verification caught the consequence:
   * a camera parked in `error` while every runtime was down stayed in `error` for ever once one
   * returned, waiting for an operator who had no reason to know they were needed. A control plane
   * that can put a camera into a hole it cannot climb out of is not an orchestration layer.
   *
   * ⚠️ **A camera on a healthy runtime is still never touched.** "Healthy runtimes must never restart
   * unnecessarily" is enforced by what this loop skips, and the added population is disjoint from it:
   * a camera in `error` is by definition not processing.
   */
  async #reconcile(now: Date): Promise<{ failover: number; failed: number }> {
    const runtimes = await this.#allRuntimes();
    const usable = new Set(runtimes.filter((r) => placeable(r, now)).map((r) => r._id));
    const docs = await this.#assignments
      .find({
        state: { $in: ['assigned', 'starting', 'running', 'paused', 'recovering', 'error'] },
      } as never)
      .toArray();

    /*
     * ⚠️ **Assignments whose camera no longer exists are dropped here**, and this is not tidiness:
     * a deleted camera's assignment keeps counting against its runtime's capacity for ever, so an
     * estate that churns cameras slowly loses the ability to place new ones — with a capacity page
     * that looks full and a camera list that does not explain it.
     *
     * ⚠️ One query for the whole sweep, not one per camera. Reaching the collection directly rather
     * than through the tenant repository is deliberate and safe: this is a cross-tenant reconcile on
     * an internal path, the projection returns only ids, and pruning is keyed on the (tenant, camera)
     * PAIR — an id from another tenant cannot keep an assignment alive.
     */
    let alive = new Set<string>();
    if (docs.length > 0) {
      const rows = await this.#cameras.collection
        .find({ _id: { $in: docs.map((d) => d.cameraId) } } as never, {
          projection: { _id: 1, tenantId: 1 },
        })
        .toArray();
      alive = new Set(rows.map((r) => `${(r as { tenantId: string }).tenantId}:${String(r._id)}`));
    }

    let failover = 0;
    let failed = 0;
    let changed = false;
    let orphaned = 0;
    for (const doc of docs) {
      if (!alive.has(assignmentId(doc.tenantId, doc.cameraId))) {
        await this.#assignments.deleteOne({ _id: doc._id } as never);
        orphaned += 1;
        changed = true;
        continue;
      }
      const strandedInError = doc.state === 'error';
      const runtimeGone = doc.runtimeId === null || !usable.has(doc.runtimeId);
      if (!strandedInError && !runtimeGone) continue;
      /*
       * ⚠️ A stranded camera with still nowhere to go re-runs `place-failed`, a legal self-transition
       * on `error`. It rewrites the same reason rather than doing nothing, so "we are still trying"
       * stays visible — an operator can tell a retry loop from a control plane that gave up.
       */
      const outcome = await this.#replace(doc, 'failover', 'system');
      if (outcome === 'placed') {
        failover += 1;
        changed = true;
      } else if (outcome === 'failed') {
        failed += 1;
        changed = true;
      }
    }
    this.#counters.failovers += failover;
    this.#counters.failures += failed;
    if (orphaned > 0) {
      this.#counters.changes += orphaned;
    }
    if (changed) await this.#bumpPlan();
    return { failover, failed };
  }

  /** Re-place one camera. Returns what happened so callers can count it. */
  async #replace(
    doc: AssignmentDoc,
    reason: AssignmentReason,
    actor: string,
  ): Promise<'placed' | 'failed' | 'skipped'> {
    if (doc.profileId === null) return 'skipped';
    const now = this.#clock.now();
    const profile = await this.#profiles.findOne({
      _id: profileDocId(doc.tenantId, doc.profileId),
    } as never);
    if (profile === null) return 'skipped';

    const [runtimes, load] = await Promise.all([this.#allRuntimes(), this.#runtimeLoad()]);
    /*
     * ⚠️ The dead runtime is **not filtered out of the list**, and that changes the diagnosis.
     * Filtering it left an empty array, so a single-runtime deployment whose only runtime went
     * offline reported `no-runtime-registered` — which sends an engineer to look for a missing
     * registration instead of at the container that died. `placeable()` already excludes it on
     * health; leaving it in the list is what lets the failure resolve to `no-healthy-runtime`.
     */
    /*
     * ⛔ **`currentRuntimeId` is the camera's own runtime, not `null` — and passing `null` here
     * deadlocked the platform** (P-8.5 Product Validation, V-1).
     *
     * `#runtimeLoad()` counts every assignment whose state is `aiEnabled`, and `error` is one of
     * them — correctly, because an errored camera is still assigned and still owns its slot. So a
     * camera being re-placed is *already inside* the load figure. Telling the strategy it has no
     * current runtime withholds the one fact that lets it discount that slot, and the camera is
     * refused for lack of a seat it is itself sitting in.
     *
     * ⚠️ The failure only appears when the runtime is **exactly full**, which is why no test caught
     * it and only a deployment did. Measured on the deployed stack: the inference container was
     * restarted, all 4 of `maxCameras: 4` failed over, and every retry thereafter recorded
     * `placementFailure: capacity-exceeded` — `remaining: 0`, `utilization: 1`, `failedCameras: 4`.
     * The planner cycled 669 times without recovering. Freeing a single slot by unassigning one
     * camera moved the other three from `error` to `recovering` within one cycle, which is the
     * measurement that isolated the cause.
     *
     * ⛔ The product consequence was worse than a stuck camera: with no assignment, every subsequent
     * offline analysis completed as `succeeded` having analysed **nothing**, reporting a speed factor
     * of ×280 for a run that looked at zero frames.
     *
     * ⭐ The pinned branch of `LeastLoadedPlacement` already documents this exact trap — "the camera
     * already on this runtime does not consume a slot it is about to re-occupy" — and guards it. The
     * reasoning was simply never carried across to failover. The strategy needed no change; it needed
     * to be told the truth.
     *
     * ⚠️ Still not filtered from `runtimes`: a dead runtime left in the list is what lets the failure
     * resolve to `no-healthy-runtime` rather than `no-runtime-registered`, which is the difference
     * between sending an engineer to the container that died and sending them to look for a missing
     * registration. `placeable()` excludes it on health, so a genuinely dead runtime still forces the
     * choose branch and a real move.
     */
    const placement = this.#placement.place(
      { capabilityId: primaryCapability(profile), currentRuntimeId: doc.runtimeId },
      runtimes,
      load,
      now,
    );

    const input: ApplyActionInput = placement.placed
      ? {
          action: 'failover',
          actor,
          reason,
          at: now,
          historyId: this.#ids.historyId(),
          runtimeId: placement.runtimeId,
          lastError: null,
        }
      : {
          action: 'place-failed',
          actor,
          reason,
          at: now,
          historyId: this.#ids.historyId(),
          placementFailure: placement.failure,
          lastError: placementMessage(placement.failure),
        };

    const stepped = this.#step(doc, input);
    if ('error' in stepped) return 'skipped';
    await this.#commit([stepped.write]);
    return placement.placed ? 'placed' : 'failed';
  }
}

interface PendingWrite {
  doc: AssignmentDoc;
  history: AssignmentHistoryEntry;
}

function toGroup(doc: GroupDoc): CameraGroup {
  return {
    id: doc.groupId,
    tenantId: doc.tenantId,
    name: doc.name,
    ...(doc.description === undefined ? {} : { description: doc.description }),
    cameraIds: [...doc.cameraIds],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.updatedBy === undefined ? {} : { updatedBy: doc.updatedBy }),
  };
}

/** The operator-facing sentence for each placement failure. One place, so the wording is uniform. */
export function placementMessage(failure: PlacementFailure): string {
  switch (failure) {
    case 'no-runtime-registered':
      return 'no AI runtime is registered';
    case 'no-healthy-runtime':
      return 'no registered runtime is healthy enough to accept a camera';
    case 'capacity-exceeded':
      return 'every eligible runtime is at capacity';
    case 'runtime-disabled':
      return 'the runtime is administratively disabled';
    case 'runtime-not-found':
      return 'the named runtime is not registered';
    case 'limit-reached':
      return 'the licensed limit has been reached';
    case 'capability-unavailable':
      return "no runtime advertises this profile's capability";
  }
}

/** Ids the built-in catalogue occupies, for the routes that refuse to shadow them. */
export const RESERVED_PROFILE_IDS: ReadonlySet<string> = new Set(BUILT_IN_PROFILE_IDS);

/**
 * The highest version among a camera's zones — the camera's zone-set version (P-8 Phase 7).
 *
 * ⚠️ `0` for a camera with no zones, which is a legitimate value and not a missing measurement: a
 * camera with nothing drawn on it genuinely has no zone configuration to be at a version of. Because
 * every zone starts at version 1, `0` can never collide with a real one.
 *
 * ⚠️ A *maximum* rather than a sum or a count, and the difference matters: deleting a zone lowers the
 * count and would make a change look like a revert, while the maximum only ever moves forward for as
 * long as any zone on the camera is edited. It is not a perfect monotonic counter — deleting the
 * newest zone lowers it — and that is acceptable because the enforcement point compares for
 * *inequality*, not for ordering.
 */
function maxZoneVersion(zones: readonly PlanZone[] | undefined): number {
  if (zones === undefined || zones.length === 0) return 0;
  let max = 0;
  for (const zone of zones) if (zone.version > max) max = zone.version;
  return max;
}
