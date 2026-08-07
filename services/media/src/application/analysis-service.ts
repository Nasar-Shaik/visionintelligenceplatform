/**
 * Application: offline video investigation use-cases (P-8 Phase 8).
 *
 * ⭐ **The whole of this milestone's value is that this file does not analyse anything.** It creates
 * an upload slot, measures what lands in it, and records the intent to run. The analysis itself is
 * the live pipeline — decode → `/infer` → tracking → events → rules — driven by a worker in a later
 * slice. If perception logic ever appears here, the design has gone wrong.
 *
 * Every operation is tenant-scoped via @vip/tenancy (fail-closed), and the object store is wrapped
 * per tenant so a principal can only ever address its own prefix.
 */
import {
  ANALYSIS_LIMITS,
  isTerminalSessionState,
  TIMELINE_MAX_EVENTS,
  type AnalysisTimeline,
  type AnalysisTimelineQuery,
  type AnalysisSession,
  type ConfirmVideoAnalysisInput,
  type CreateVideoAnalysisInput,
  type StartAnalysisSessionInput,
  type VideoAnalysis,
  type VideoAnalysisDetail,
  type VideoAnalysisPage,
  type VideoAnalysisPlayback,
  type VideoAnalysisQuery,
  type VideoAnalysisUpload,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { TenantObjectStore, type ObjectStore } from '@vip/storage';
import type { Clock } from '../domain/stream.js';
import {
  analysisSourceKey,
  assetFindings,
  newAnalysis,
  newSession,
  rejectAsset,
  resolveContainer,
  toAnalysis,
  toSession,
  type AnalysisDoc,
  type AnalysisSessionDoc,
} from '../domain/analysis.js';
import { stateAfterLeaseLapse } from '../domain/analysis-lease.js';
import { assetFromProbe, type MediaProbe } from '../adapters/ffprobe.js';
import { badRequest, conflict, DuplicateSessionError, notFound } from './errors.js';
import type {
  AnalysisEventCaller,
  AnalysisEventSource,
  AnalysisStore,
  CameraDirectory,
} from './ports.js';
import { toDensity, toEntry, toTrackSpans } from '../domain/analysis-timeline.js';

export interface AnalysisIdGen {
  analysisId(): string;
  sessionId(): string;
}

export interface AnalysisServiceDeps {
  store: AnalysisStore;
  objectStore: ObjectStore;
  probe: MediaProbe;
  cameras: CameraDirectory;
  clock: Clock;
  ids: AnalysisIdGen;
  /** Capability the frames will be sent to — recorded on every session's provenance. */
  capabilityId: string;
  /** Default frames-per-second **of footage** to analyse. */
  defaultFrameRate: number;
  /** Signed playback-URL lifetime (seconds). */
  playbackTtlSeconds: number;
  /**
   * What actually executes a session. Absent ⇒ sessions are recorded and sit `queued`.
   *
   * ⚠️ Absent is a real deployment, not a broken one: a media replica configured without a
   * perception runtime still accepts uploads and records the intent to analyse. It must say so by
   * leaving the session visibly `queued` rather than by silently reporting it as finished.
   */
  runner?: SessionRunner;
  /**
   * Reads back the events a run produced (slice 4). Absent ⇒ `/timeline` answers 501.
   *
   * ⚠️ Absent is a real deployment: media records and analyses without an events service. The
   * timeline says it is unavailable rather than returning an empty one, because "no events service"
   * and "no events" are opposite answers to a customer's question.
   */
  events?: AnalysisEventSource;
}

/** The seam between recording the intent to run and running it. Implemented by `AnalysisRunner`. */
export interface SessionRunner {
  submit(scope: TenantScope, sessionId: string): void;
  cancel(sessionId: string): boolean;
}

export class AnalysisService {
  readonly #store: AnalysisStore;
  readonly #objectStore: ObjectStore;
  readonly #probe: MediaProbe;
  readonly #cameras: CameraDirectory;
  readonly #clock: Clock;
  readonly #ids: AnalysisIdGen;
  readonly #capabilityId: string;
  readonly #defaultFrameRate: number;
  readonly #playbackTtl: number;
  readonly #runner: SessionRunner | undefined;
  readonly #events: AnalysisEventSource | undefined;

  constructor(deps: AnalysisServiceDeps) {
    this.#store = deps.store;
    this.#objectStore = deps.objectStore;
    this.#probe = deps.probe;
    this.#cameras = deps.cameras;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#capabilityId = deps.capabilityId;
    this.#defaultFrameRate = deps.defaultFrameRate;
    this.#playbackTtl = deps.playbackTtlSeconds;
    this.#runner = deps.runner;
    this.#events = deps.events;
  }

  /**
   * Create a `draft` analysis and hand back a URL its bytes may be written to.
   *
   * ⚠️ **The size ceiling is enforced here, before a byte moves.** Refusing after a customer has
   * spent twenty minutes uploading two gigabytes is technically the same rule and a completely
   * different experience.
   */
  async createUpload(
    scope: TenantScope,
    principalId: string,
    input: CreateVideoAnalysisInput,
  ): Promise<VideoAnalysisUpload> {
    const container = resolveContainer(input.contentType);
    if (!container.ok) throw badRequest(container.reason);

    if (input.bytes > ANALYSIS_LIMITS.maxBytes) {
      throw badRequest(
        `the file is ${input.bytes} bytes and the limit is ${ANALYSIS_LIMITS.maxBytes} — refused before upload`,
      );
    }

    /*
     * ⛔ The camera must exist. An analysis bound to a camera that does not is evaluated against no
     * zones and no rules, and would succeed having found nothing — the answer this platform must
     * never give. Resolving the name here is also what lets a report read on its own later.
     */
    if (!(await this.#cameras.exists(scope.tenantId, input.cameraId))) {
      throw badRequest(
        `camera '${input.cameraId}' could not be confirmed in this tenant — an analysis must be bound to a real camera, because the camera is what carries the zones and the rules`,
      );
    }

    const now = this.#clock.now();
    const id = this.#ids.analysisId();
    const key = analysisSourceKey(id, container.container);
    const doc = newAnalysis({
      id,
      tenantId: scope.tenantId,
      cameraId: input.cameraId,
      ...(input.label === undefined ? {} : { label: input.label }),
      pendingUpload: {
        key,
        originalName: input.originalName,
        contentType: input.contentType,
        container: container.container,
        declaredBytes: input.bytes,
      },
      /*
       * ⚠️ Provisional. The real answer arrives at confirm(), from the operator or from the file's
       * own metadata; this is a placeholder so the record is valid, and `upload-time` is recorded as
       * its source so nothing later mistakes it for a measurement.
       */
      footageStartedAt: input.footageStartedAt ?? now.toISOString(),
      footageStartSource: input.footageStartedAt === undefined ? 'upload-time' : 'operator',
      createdBy: principalId,
      now,
    });
    await this.#store.putAnalysis(scope, doc);

    const tenantStore = new TenantObjectStore(this.#objectStore, scope.tenantId);
    const uploadUrl = await tenantStore.presignPut(
      key,
      ANALYSIS_LIMITS.uploadTtlSeconds,
      input.contentType,
    );

    return {
      analysis: toAnalysis(doc),
      uploadUrl,
      method: 'PUT',
      contentType: input.contentType,
      expiresAt: new Date(now.getTime() + ANALYSIS_LIMITS.uploadTtlSeconds * 1000).toISOString(),
    };
  }

  /**
   * The upload landed: measure it, and either accept it or say why not.
   *
   * ⭐ **Nothing the uploader said is carried forward.** The codec, the dimensions, the duration and
   * the real byte count all come from `ffprobe` and from the store's own `head`. The declared
   * content type got the bytes into the bucket and has no authority over what they are.
   */
  async confirmUpload(
    scope: TenantScope,
    id: string,
    input: ConfirmVideoAnalysisInput,
  ): Promise<VideoAnalysis> {
    const doc = await this.#require(scope, id);
    if (doc.state === 'archived') throw conflict('this analysis has been archived');

    const pending = doc.pendingUpload;
    if (pending === undefined) {
      throw conflict('this analysis has already been confirmed — start a session to run it again');
    }
    const tenantStore = new TenantObjectStore(this.#objectStore, scope.tenantId);

    const head = await tenantStore.head(pending.key);
    if (head === null) {
      throw conflict(
        'no file has been uploaded for this analysis yet — PUT the bytes to the upload URL first',
      );
    }
    /*
     * ⚠️ The measured size, not the declared one. They disagree whenever an upload is truncated by a
     * dropped connection, and a truncated video probes as a shorter video rather than as an error —
     * so the mismatch is worth naming here, where it is still explicable, rather than leaving an
     * operator to wonder why their ten-minute recording was analysed for four.
     */
    if (head.size !== pending.declaredBytes) {
      throw badRequest(
        `the uploaded file is ${head.size} bytes but ${pending.declaredBytes} were declared — the upload was probably interrupted; upload it again`,
      );
    }

    /*
     * ⚠️ Probed through a signed URL rather than by downloading. A two-gigabyte read into a service
     * that only needs a header is the shape that makes one big upload take the whole host down.
     */
    /*
     * ⛔ **Internal, not public — and this was a deployed defect, not a precaution.**
     *
     * `ffprobe` runs inside this container. A URL signed against the *public* endpoint names the
     * host a browser resolves, which under this deployment is `https://localhost` — and inside the
     * container that is the container itself. Measured: `Connection to tcp://localhost:443 failed:
     * Connection refused`, so confirming an upload failed in every real deployment while passing
     * every unit test, because the tests supply a fake probe.
     */
    const url = await tenantStore.presignInternalGet(pending.key, 900);
    let probed;
    try {
      probed = await this.#probe.probe(url);
    } catch (err) {
      throw badRequest(
        `this file could not be read as a video: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const asset = assetFromProbe({
      key: pending.key,
      originalName: pending.originalName,
      bytes: head.size,
      contentType: pending.contentType,
      container: pending.container,
      probe: probed,
    });

    const rejection = rejectAsset(asset);
    if (rejection !== null) throw badRequest(rejection);

    /*
     * ⭐ The footage start, resolved in priority order and always with its provenance attached:
     * what the operator said now, what they said at creation, the container's own creation time,
     * and — only if none of those exist — the upload time, which is honestly labelled as a fallback
     * rather than presented as a measurement.
     */
    const resolved = resolveFootageStart(doc, input.footageStartedAt, probed.createdAt);

    /* ⚠️ `pendingUpload` is dropped, not kept — the claim has been superseded by the measurement. */
    const rest: AnalysisDoc = { ...doc };
    delete rest.pendingUpload;
    const updated: AnalysisDoc = {
      ...rest,
      state: 'ready',
      asset,
      footageStartedAt: resolved.at,
      footageStartSource: resolved.source,
      updatedAt: this.#clock.now().toISOString(),
    };
    await this.#store.putAnalysis(scope, updated);
    return toAnalysis(updated);
  }

  /**
   * Record the intent to analyse. ⭐ Called again on the same analysis, this is a **rerun**.
   *
   * ⚠️ This slice records the session and does not execute it — the worker arrives next. A session
   * therefore sits `queued` until then, which is visible and honest, rather than being reported as
   * running by something that is not.
   */
  async startSession(
    scope: TenantScope,
    analysisId: string,
    principalId: string,
    input: StartAnalysisSessionInput,
  ): Promise<AnalysisSession> {
    const doc = await this.#require(scope, analysisId);
    if (doc.state !== 'ready') {
      throw conflict(
        doc.state === 'draft'
          ? 'this analysis has no file yet — upload one and confirm it before running'
          : 'this analysis has been archived',
      );
    }

    const existing = await this.#store.listSessions(scope, analysisId);
    const active = existing.find((s) => !isTerminalSessionState(s.state));
    if (active !== undefined) {
      throw conflict(
        `session ${active._id} is already ${active.state} for this analysis — cancel it before starting another`,
      );
    }
    if (existing.length >= ANALYSIS_LIMITS.maxSessionsPerAnalysis) {
      throw conflict(
        `this analysis already has ${existing.length} sessions, which is the limit — the history is kept rather than silently trimmed`,
      );
    }

    const now = this.#clock.now();
    const session = newSession({
      id: this.#ids.sessionId(),
      tenantId: scope.tenantId,
      analysisId,
      cameraId: doc.cameraId,
      sequence: existing.length + 1,
      analysisFrameRate: input.analysisFrameRate ?? this.#defaultFrameRate,
      /*
       * ⭐ Unpaced unless the caller asks otherwise. An investigation wants its answer as fast as the
       * hardware can produce it; real-time playback is what Demonstration Mode asks for explicitly,
       * and defaulting to it would make every investigation take as long as the footage.
       */
      speed: input.speed ?? null,
      capabilityId: this.#capabilityId,
      /*
       * ⚠️ Empty until the slice that reads the rule plane. An empty snapshot means "not captured",
       * and the session says so rather than implying no rules existed.
       */
      ruleSet: [],
      findings: doc.asset === undefined ? [] : assetFindings(doc.asset, doc.footageStartSource),
      requestedBy: principalId,
      now,
      ...(doc.asset === undefined ? {} : { durationSeconds: doc.asset.durationSeconds }),
    });
    /*
     * ⚠️ The check above is the friendly path; this is the guarantee. Two operators pressing "run"
     * together both read zero sessions and both claim number 1 — no amount of re-reading makes a
     * read-then-write atomic, so the unique index decides and the loser is told what happened
     * instead of getting a second session that shares a run number with the first.
     */
    try {
      await this.#store.putSession(scope, session);
    } catch (err) {
      if (err instanceof DuplicateSessionError) {
        throw conflict(
          'another run of this analysis was started at the same moment — reload to see it',
        );
      }
      throw err;
    }

    await this.#store.putAnalysis(scope, {
      ...doc,
      latestSessionId: session._id,
      sessionCount: existing.length + 1,
      updatedAt: now.toISOString(),
    });

    /*
     * ⭐ **Handed to the runner only after the session is durable**, and the order is load-bearing.
     * Submitting first opens a window where the worker claims a session the store has not accepted —
     * it would fail its conditional write, look like a lost race, and the operator would be told the
     * run started when nothing did.
     *
     * ⚠️ Fire-and-forget on purpose: this is an HTTP request, and the analysis may take hours.
     */
    this.#runner?.submit(scope, session._id);

    return toSession(session);
  }

  /** ⚠️ Cancelling a terminal session is a conflict, not a no-op — the caller believes something. */
  async cancelSession(scope: TenantScope, sessionId: string): Promise<AnalysisSession> {
    const session = await this.#store.getSession(scope, sessionId);
    if (session === null) throw notFound(`session '${sessionId}' not found`);
    if (isTerminalSessionState(session.state)) {
      throw conflict(`session '${sessionId}' is already ${session.state}`);
    }
    /*
     * ⚠️ **The decode in progress is stopped first.** A cancel that only writes `cancelled` leaves
     * ffmpeg running and frames still arriving at the runtime — the session looks stopped and the
     * host does not. `cancelLocal` returns false when the session is running on another replica,
     * which is not an error: that worker's next conditional write will fail against the `cancelled`
     * state below and it will stop on its own.
     */
    this.#runner?.cancel(sessionId);

    const now = this.#clock.now().toISOString();
    const updated: AnalysisSessionDoc = {
      ...session,
      state: 'cancelled',
      finishedAt: now,
      progress: { ...session.progress, updatedAt: now },
    };
    await this.#store.putSession(scope, updated);
    return toSession(updated);
  }

  async list(scope: TenantScope, q: VideoAnalysisQuery): Promise<VideoAnalysisPage> {
    const page = await this.#store.listAnalyses(scope, q);
    return {
      items: page.items.map(toAnalysis),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async detail(scope: TenantScope, id: string): Promise<VideoAnalysisDetail> {
    const doc = await this.#require(scope, id);
    const sessions = await this.#store.listSessions(scope, id);
    const repaired = await Promise.all(sessions.map((s) => this.#repairLapsed(scope, s)));
    return { analysis: toAnalysis(doc), sessions: repaired.map(toSession) };
  }

  /**
   * ⭐ **Read-time repair of a session whose worker vanished** (P-8 Phase 8, slice 3).
   *
   * A media process restarted mid-analysis leaves a session `running` with a lease nobody will ever
   * renew. It is not wrong for a moment — the lease has to be allowed to lapse before anyone can say
   * the worker is gone — but after that it is a session claiming to be running that is not, and it
   * would claim it for ever.
   *
   * ⚠️ **Repaired here rather than by a sweeper, and that is a Law 5 consequence, not a preference.**
   * Every store read needs a `TenantScope`; a background sweeper would need to enumerate tenants,
   * and inventing a cross-tenant read to serve a loop would put a hole in the isolation guarantee for
   * the convenience of a timer. A caller entitled to see the session asks for it, and the repair
   * happens inside their scope — which is also the only moment the answer matters to anybody.
   *
   * ⚠️ The decision itself is `stateAfterLeaseLapse`, unchanged from slice 2, so `retrying` while
   * attempts remain and `expired` once they are exhausted. `expired` is deliberately not `failed`:
   * nobody can account for what happened to the worker, and reporting that as a failed analysis
   * would blame the customer's recording for a hosting event.
   */
  async #repairLapsed(
    scope: TenantScope,
    session: AnalysisSessionDoc,
  ): Promise<AnalysisSessionDoc> {
    if (isTerminalSessionState(session.state)) return session;
    if (session.lease === undefined) return session;
    const now = this.#clock.now();
    if (Date.parse(session.lease.expiresAt) > now.getTime()) return session;

    const { state, reason } = stateAfterLeaseLapse(session.lease.attempt);
    const repaired: AnalysisSessionDoc = {
      ...session,
      state,
      error: reason,
      ...(isTerminalSessionState(state) ? { finishedAt: now.toISOString() } : {}),
    };
    /*
     * ⚠️ Conditional, so a worker that is in fact alive and renews between the read and this write
     * keeps its session. Losing the race here is the correct outcome and needs no handling — the
     * session stays as the live worker left it, and the caller is told what the store says.
     */
    const landed = await this.#store.compareAndSetSession(
      scope,
      session._id,
      { state: session.state, workerId: session.lease.workerId },
      repaired,
    );
    return landed ? repaired : ((await this.#store.getSession(scope, session._id)) ?? session);
  }

  /**
   * ⭐ **The investigation timeline** (slice 4) — derived from the events one run produced.
   *
   * ⚠️ **Per session, never merged across runs.** Omitting `sessionId` means the *latest* run, not a
   * union of all of them. Two runs of one recording are two answers — possibly under different rules
   * or a different model — and overlaying them would produce a picture that describes no run that
   * ever happened.
   */
  async timeline(
    scope: TenantScope,
    analysisId: string,
    query: AnalysisTimelineQuery,
    caller: AnalysisEventCaller,
  ): Promise<AnalysisTimeline> {
    const doc = await this.#require(scope, analysisId);
    const source = this.#events;
    if (source === undefined) {
      throw conflict(
        'this deployment has no events service configured, so an analysis timeline cannot be built — the analysis itself is unaffected',
      );
    }

    const sessions = await this.#store.listSessions(scope, analysisId);
    /* ⚠️ `listSessions` is newest-first, so the head IS the latest run. */
    const session =
      query.sessionId === undefined
        ? sessions[0]
        : sessions.find((s) => s._id === query.sessionId);
    if (session === undefined) {
      throw notFound(
        query.sessionId === undefined
          ? `analysis '${analysisId}' has not been run yet, so it has no timeline`
          : `run '${query.sessionId}' does not belong to analysis '${analysisId}'`,
      );
    }

    const { events, truncated } = await source.forSession(
      scope,
      session._id,
      TIMELINE_MAX_EVENTS,
      caller,
    );
    const entries = events
      .map((event) => toEntry(event, doc.footageStartedAt))
      /*
       * ⚠️ Sorted here rather than trusted from the store, which returns newest-first. A timeline is
       * read left to right and every consumer of `entries` — the track spans, the density lane, the
       * export — assumes footage order.
       */
      .sort((a, b) => a.offsetSeconds - b.offsetSeconds || a.eventId.localeCompare(b.eventId));

    return {
      analysisId,
      sessionId: session._id,
      tenantId: scope.tenantId,
      cameraId: session.cameraId,
      footageStartedAt: doc.footageStartedAt,
      ...(doc.asset === undefined ? {} : { durationSeconds: doc.asset.durationSeconds }),
      entries,
      tracks: toTrackSpans(entries),
      density: toDensity(entries, doc.asset?.durationSeconds),
      truncated,
      /*
       * ⚠️ Incidents arrive in slice 5. Reported as **unavailable** rather than as an empty lane,
       * because "we cannot look" and "we looked and found none" are opposite answers and the console
       * must be able to say which one it is showing.
       */
      incidentsAvailable: false,
      generatedAt: this.#clock.now().toISOString(),
    };
  }

  /** A signed URL for the source recording, so an operator can watch what was analysed. */
  async playback(scope: TenantScope, id: string): Promise<VideoAnalysisPlayback> {
    const doc = await this.#require(scope, id);
    if (doc.asset === undefined) throw conflict('this analysis has no file yet');

    const tenantStore = new TenantObjectStore(this.#objectStore, scope.tenantId);
    const url = await tenantStore.presignGet(doc.asset.key, this.#playbackTtl);
    const warning = assetFindings(doc.asset, doc.footageStartSource).find(
      (f) => f.kind === 'codec-playback-limited',
    );
    return {
      url,
      contentType: doc.asset.contentType,
      expiresAt: new Date(this.#clock.now().getTime() + this.#playbackTtl * 1000).toISOString(),
      ...(warning === undefined ? {} : { playbackWarning: warning.detail }),
    };
  }

  /**
   * Remove an analysis and its bytes.
   *
   * ⛔ **Refused while a session is running.** Deleting the object a worker is mid-decode of turns a
   * running analysis into a decode error attributed to the customer's file.
   */
  async remove(scope: TenantScope, id: string): Promise<void> {
    const doc = await this.#require(scope, id);
    const sessions = await this.#store.listSessions(scope, id);
    const active = sessions.find((s) => !isTerminalSessionState(s.state));
    if (active !== undefined) {
      throw conflict(
        `session ${active._id} is ${active.state} — cancel it before deleting the recording it is reading`,
      );
    }

    if (doc.asset !== undefined) {
      const tenantStore = new TenantObjectStore(this.#objectStore, scope.tenantId);
      await tenantStore.delete(doc.asset.key);
    }
    await this.#store.deleteAnalysis(scope, id);
  }

  async #require(scope: TenantScope, id: string): Promise<AnalysisDoc> {
    const doc = await this.#store.getAnalysis(scope, id);
    /* ⚠️ Another tenant's analysis is a 404, not a 403 — no existence leak. */
    if (doc === null) throw notFound(`analysis '${id}' not found`);
    return doc;
  }
}

/**
 * ⚠️ Pure and exported so the priority order is testable without a file, a store or a clock.
 *
 * The order is deliberate: **a person who was there beats a file's metadata, and a file's metadata
 * beats a guess.** The source travels with the answer in every case, because the difference between
 * "this happened at 14:32" and "this happened 90 seconds into a file we received at 14:32" is the
 * difference between an investigation and a filename.
 */
export function resolveFootageStart(
  doc: AnalysisDoc,
  operatorSaid: string | undefined,
  containerSaid: Date | undefined,
): { at: string; source: AnalysisDoc['footageStartSource'] } {
  if (operatorSaid !== undefined) return { at: operatorSaid, source: 'operator' };
  if (doc.footageStartSource === 'operator') {
    return { at: doc.footageStartedAt, source: 'operator' };
  }
  if (containerSaid !== undefined && !Number.isNaN(containerSaid.getTime())) {
    return { at: containerSaid.toISOString(), source: 'container-metadata' };
  }
  return { at: doc.footageStartedAt, source: 'upload-time' };
}
