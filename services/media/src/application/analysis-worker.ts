/**
 * Application: the analysis worker (P-8 Phase 8, slice 2).
 *
 * ⭐ **This file orchestrates; it does not analyse.** It claims a session, opens a `FrameSource`,
 * hands every frame to the **same `FrameSink` a live camera uses**, and records what happened. There
 * is no inference here, no tracking, no rule evaluation — offline and live reach the runtime through
 * one path, and if a second one ever appears the design has gone wrong.
 *
 * ### The four properties this is built for
 *
 * 1. **At most one worker per session.** Not by checking, but by a conditional write against
 *    `(state, lease.workerId)`. Slice 1 established that a read-then-write is not exclusion.
 * 2. **Chunked.** Progress moves, cancellation lands inside a second, and the offset reached is the
 *    checkpoint a resume starts from.
 * 3. **Resumable — with its cost stated.** ⚠️ A resume after longer than the runtime's idle release
 *    gets **new tracking identities**, so a dwell spanning the gap is split. Recorded as a finding
 *    rather than presented as continuity.
 * 4. **Multi-worker ready.** Nothing here is a singleton: `workerId` identifies the process, the
 *    lease is in the record, and a second worker on a second host needs no code change.
 */
import {
  ANALYSIS_LIMITS,
  isTerminalSessionState,
  type AnalysisCounts,
  type AnalysisFinding,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { grantLease, leaseHeld, renewLease, stateAfterFailure } from '../domain/analysis-lease.js';
import { computeProgress, nextChunk, resumeBreaksIdentity } from '../domain/analysis-progress.js';
import {
  Pacer,
  systemSleeper,
  PACING_BEHIND_TOLERANCE_MS,
  type Sleeper,
} from '../domain/analysis-pacing.js';
import type { AnalysisSessionDoc } from '../domain/analysis.js';
import type { AnalysisStore, Frame, FrameDelivery, FrameSink } from './ports.js';
import type { FrameSource, FrameSourceFactory } from './frame-source.js';

/** What the runtime reported about itself, accumulated across a session's frames. */
interface ObservedProvenance {
  runtimeVersion?: string;
  modelId?: string;
  executionProvider?: string;
}

export interface AnalysisWorkerDeps {
  store: AnalysisStore;
  sources: FrameSourceFactory;
  /** ⭐ The SAME sink the live decode path pushes to. Not a copy of it. */
  sink: FrameSink;
  clock: { now(): Date };
  /**
   * ⚠️ Injectable so a test can pace a four-hour recording in milliseconds.
   *
   * ⛔ `monotonicNow` must move **with** the sleeper. The first version of the parity harness left it
   * on the real `Date.now()` while a virtual sleeper returned instantly, so footage time advanced and
   * wall time did not: every frame's wait grew by one interval and 300 s of footage "slept" for 25
   * hours. The pacer was right; nothing was measuring it. They are one injection now so they cannot
   * be supplied inconsistently.
   */
  sleeper?: Sleeper;
  monotonicNow?: () => number;
  /** Stable per process, so a stale lease names something an operator can go and look at. */
  workerId: string;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

/** What one `runSession` call did. Returned rather than logged, so tests assert on it. */
export interface RunOutcome {
  sessionId: string;
  state: AnalysisSessionDoc['state'];
  chunksCompleted: number;
  framesProcessed: number;
  /** Present when the run stopped for a reason worth naming. */
  reason?: string;
}

export class AnalysisWorker {
  readonly #deps: AnalysisWorkerDeps;
  /** Sessions this process is running, so cancellation can reach the decode in progress. */
  readonly #running = new Map<string, AbortController>();

  constructor(deps: AnalysisWorkerDeps) {
    this.#deps = deps;
  }

  /** Read a session within scope. ⚠️ Exposed for the runner, which claims before it can read. */
  async sessionFor(scope: TenantScope, sessionId: string): Promise<AnalysisSessionDoc | null> {
    return this.#deps.store.getSession(scope, sessionId);
  }

  /**
   * ⭐ Take a session, if it is still there to take.
   *
   * Returns `false` when another worker got it — which is an ordinary outcome under two workers, not
   * an error, and must not be logged as one or the log becomes noise at exactly the moment it
   * matters.
   */
  async claim(scope: TenantScope, session: AnalysisSessionDoc): Promise<boolean> {
    const now = this.#deps.clock.now();
    const attempt = (session.lease?.attempt ?? 0) + 1;
    const claimed: AnalysisSessionDoc = {
      ...session,
      state: 'starting',
      lease: grantLease(this.#deps.workerId, attempt, now),
      ...(session.startedAt === undefined ? { startedAt: now.toISOString() } : {}),
    };
    return this.#deps.store.compareAndSetSession(
      scope,
      session._id,
      { state: session.state, workerId: session.lease?.workerId ?? null },
      claimed,
    );
  }

  /**
   * Run a claimed session to completion, cancellation, or a bounded failure.
   *
   * ⚠️ Every write goes through the conditional path, so a worker whose lease was reclaimed while it
   * was decoding **stops** rather than overwriting the session another worker now owns.
   */
  async runSession(scope: TenantScope, sessionId: string): Promise<RunOutcome> {
    const { store, sources, sink, clock } = this.#deps;
    const session = await store.getSession(scope, sessionId);
    if (session === null)
      return {
        sessionId,
        state: 'failed',
        chunksCompleted: 0,
        framesProcessed: 0,
        reason: 'session not found',
      };
    if (!leaseHeld(session.lease, this.#deps.workerId, clock.now())) {
      return {
        sessionId,
        state: session.state,
        chunksCompleted: 0,
        framesProcessed: session.progress.framesProcessed,
        reason: 'this worker does not hold the lease',
      };
    }

    const analysis = await store.getAnalysis(scope, session.analysisId);
    if (analysis?.asset === undefined) {
      return this.#fail(scope, session, 'the recording is no longer available', false);
    }

    const controller = new AbortController();
    this.#running.set(sessionId, controller);

    const findings: AnalysisFinding[] = [...session.findings];
    /*
     * ⭐ A resume that crosses the runtime's idle-release window does NOT continue the previous
     * identities. Saying so is the difference between an honest analysis and one whose split dwell
     * looks like the customer behaved differently.
     */
    const resumingFrom = session.progress.mediaOffsetSeconds;
    if (resumingFrom > 0) {
      const gapSeconds =
        session.lease?.heartbeatAt === undefined
          ? 0
          : Math.max(0, (clock.now().getTime() - Date.parse(session.lease.heartbeatAt)) / 1000);
      if (resumeBreaksIdentity(gapSeconds)) {
        findings.push({
          kind: 'frames-dropped',
          detail: `this run resumed at ${resumingFrom.toFixed(1)}s after a ${Math.round(gapSeconds)}s gap. The runtime had released this camera's tracking state, so subjects visible across the gap were given new identities — a dwell spanning it is split into two shorter visits and may not have crossed its threshold.`,
          atOffsetSeconds: resumingFrom,
        });
      }
    }

    let offset = resumingFrom;
    let framesProcessed = session.progress.framesProcessed;
    let chunksCompleted = 0;
    let elapsedMs = 0;
    /* ⚠️ Carried forward across a resume — a rerun's counts must cover the whole session. */
    const counts: AnalysisCounts = { ...session.counts };
    /** What the runtime said it ran, accumulated from the answers rather than from configuration. */
    const provenance: ObservedProvenance = {};
    /** Refusals by reason, so one finding names a count rather than fifty naming a frame each. */
    const refusals = new Map<string, { count: number; firstOffsetSeconds: number | undefined }>();
    const pace = new Pacer({
      speed: session.speed,
      now: this.#deps.monotonicNow ?? ((): number => Date.now()),
      sleeper: this.#deps.sleeper ?? systemSleeper,
    });
    /*
     * ⚠️ Opened INSIDE the try. The first version opened the source before it, so a recording that
     * could not be opened threw out of this method and left the session `starting` with a lease
     * nobody would renew — it would sit there until the lease lapsed and then be retried twice more
     * for the same unopenable file. A failure to open is a failure of the run, and is recorded as
     * one, with its reason.
     */
    let source: FrameSource | undefined;

    /*
     * ⛔ **Losslessness is required, not preferred.** `push` drops the oldest frame when the runtime
     * falls behind, which is right for a live camera and catastrophic for a recording: the customer
     * uploaded evidence and would be shown an analysis with silent holes in it. A sink that cannot
     * deliver losslessly is refused here rather than quietly downgraded — see `FrameSink`.
     */
    if (sink.deliver === undefined) {
      return this.#fail(
        scope,
        session,
        'this deployment has no perception runtime configured, so a recording cannot be analysed — frames would be discarded rather than examined',
        false,
      );
    }
    const deliver = sink.deliver.bind(sink);

    try {
      source = await sources.open({
        tenantId: scope.tenantId,
        assetKey: analysis.asset.key,
        contentType: analysis.asset.contentType,
        footageStartedAt: analysis.footageStartedAt,
        analysisId: analysis._id,
        sessionId: session._id,
      });
      await this.#advance(scope, session, 'running', findings);

      for (;;) {
        if (controller.signal.aborted) {
          return this.#stop(scope, sessionId, 'cancelled', chunksCompleted, framesProcessed, counts);
        }
        /* ⚠️ The frame rate is what decides whether the tail can hold another sample — see `nextChunk`. */
        const chunk = nextChunk(
          offset,
          analysis.asset.durationSeconds,
          undefined,
          session.analysisFrameRate,
        );
        if (chunk === null) break;

        const startedMs = Date.now();
        const result = await source.read(
          { ...chunk, frameRate: session.analysisFrameRate },
          async (frame: Frame) => {
            /*
             * ⭐ **The live path's sink, and the live path's runtime.** Offline frames are
             * indistinguishable from a camera's from here on: same request, same assignment gate,
             * same zones, same inference, same tracker, same publisher. There is no offline pipeline.
             *
             * ⚠️ Awaited, one at a time. That is what keeps the runtime's tracker seeing this
             * footage in order — it *skips* a frame older than the last one it saw, so concurrent
             * delivery would make which frames get skipped depend on scheduling, and two runs of one
             * file would disagree. See `FrameSink`.
             */
            counts.framesDecoded += 1;
            const outcome = await deliver(
              scope.tenantId,
              session.cameraId,
              frame,
              controller.signal,
            );
            this.#account(
              counts,
              provenance,
              refusals,
              outcome,
              frame.provenance?.mediaOffsetSeconds,
            );
            await pace.wait(frame, controller.signal);
          },
          controller.signal,
        );
        elapsedMs += Date.now() - startedMs;

        framesProcessed += result.framesEmitted;
        /*
         * ⛔ **A chunk that did not advance ends the run.** Belt and braces with the source's own
         * `reachedEnd`: any source that reported "not finished" while producing nothing would spin
         * this loop for ever, decoding empty chunks while the heartbeat reported healthy progress —
         * the one failure a lease cannot detect, because the worker really is alive.
         */
        const advanced = result.reachedOffsetSeconds > offset;
        offset = result.reachedOffsetSeconds;
        chunksCompleted += 1;

        /*
         * ⚠️ The write is conditional and its failure is meaningful: it means this worker no longer
         * owns the session — reclaimed after a lease lapse, or cancelled by an operator. Continuing
         * would run the footage twice through one camera's tracker.
         */
        const held = await this.#checkpoint(scope, sessionId, {
          offset,
          framesProcessed,
          elapsedMs,
          chunksCompleted,
          findings,
          counts,
          provenance,
        });
        if (!held) {
          return {
            sessionId,
            state: 'expired',
            chunksCompleted,
            framesProcessed,
            reason: 'the lease was taken by another worker while this chunk was decoding',
          };
        }

        /* ⚠️ The source's own end-of-file, not the container's declared duration — they disagree. */
        if (result.reachedEnd || !advanced) break;
      }

      findings.push(...summariseRefusals(refusals, counts));
      const paced = pace.report();
      if (paced.requestedSpeed !== null && paced.behindMs > PACING_BEHIND_TOLERANCE_MS) {
        findings.push({
          kind: 'bounded-by-limit',
          detail: `this run was asked to play at ${String(paced.requestedSpeed)}× real time but the host could not keep up, falling behind by up to ${(paced.behindMs / 1000).toFixed(1)}s. ⚠️ The analysis itself is unaffected — every frame was delivered, in order, timestamped by its position in the footage — but a live demonstration of it ran slower than real time.`,
        });
      }
      return this.#stop(
        scope,
        sessionId,
        'succeeded',
        chunksCompleted,
        framesProcessed,
        counts,
        findings,
        provenance,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = await store.getSession(scope, sessionId);
      if (current !== null) await this.#fail(scope, current, message, isTransient(err));
      return {
        sessionId,
        state: stateAfterFailure(current?.lease?.attempt ?? 1, isTransient(err)),
        chunksCompleted,
        framesProcessed,
        reason: message,
      };
    } finally {
      this.#running.delete(sessionId);
      await source?.close();
    }
  }

  /**
   * ⭐ Cancellation reaches the decode in progress, not just the record.
   *
   * ⚠️ A cancel that only writes `cancelled` leaves ffmpeg running and frames still arriving at the
   * runtime — the session looks stopped and the host does not.
   */
  cancelLocal(sessionId: string): boolean {
    const controller = this.#running.get(sessionId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  /** Renew the lease. Returns whether this worker still holds it. */
  async heartbeat(scope: TenantScope, sessionId: string): Promise<boolean> {
    const session = await this.#deps.store.getSession(scope, sessionId);
    if (session?.lease === undefined) return false;
    if (session.lease.workerId !== this.#deps.workerId) return false;
    return this.#deps.store.compareAndSetSession(
      scope,
      sessionId,
      { state: session.state, workerId: this.#deps.workerId },
      { ...session, lease: renewLease(session.lease, this.#deps.clock.now()) },
    );
  }

  /**
   * Fold one frame's outcome into the session's counts and provenance.
   *
   * ⚠️ **Refusals are aggregated by reason, not appended one per frame.** `findings` is capped at 50
   * by the contract, so a camera with no assignment would otherwise fill it with fifty identical
   * sentences and push out every other finding — losing exactly the information that explains the
   * result. One finding naming a count is both smaller and more useful.
   */
  #account(
    counts: AnalysisCounts,
    provenance: ObservedProvenance,
    refusals: Map<string, { count: number; firstOffsetSeconds: number | undefined }>,
    outcome: FrameDelivery,
    atOffsetSeconds?: number,
  ): void {
    /*
     * ⚠️ First answer wins, and it is never overwritten. A runtime upgraded mid-session would
     * otherwise leave the record naming only the second one — and a session whose frames were
     * analysed by two different models is exactly the case a provenance field exists to expose.
     */
    if (provenance.runtimeVersion === undefined && outcome.runtimeVersion !== undefined) {
      provenance.runtimeVersion = outcome.runtimeVersion;
    }
    if (provenance.modelId === undefined && outcome.modelId !== undefined) {
      provenance.modelId = outcome.modelId;
    }
    if (provenance.executionProvider === undefined && outcome.executionProvider !== undefined) {
      provenance.executionProvider = outcome.executionProvider;
    }

    if (outcome.outcome === 'delivered') {
      counts.framesAnalysed += 1;
      counts.detections += outcome.detections;
      return;
    }
    /*
     * ⛔ Everything else is a frame the analysis did not look at. It counts as dropped whatever the
     * reason, because from a customer's point of view the distinction between "the runtime refused
     * it" and "the camera was not assigned" is a detail — that a part of their footage was not
     * examined is not.
     */
    counts.framesDropped += 1;
    const reason = outcome.reason ?? outcome.outcome;
    const seen = refusals.get(reason);
    if (seen === undefined) refusals.set(reason, { count: 1, firstOffsetSeconds: atOffsetSeconds });
    else seen.count += 1;
  }

  async #advance(
    scope: TenantScope,
    session: AnalysisSessionDoc,
    state: AnalysisSessionDoc['state'],
    findings: AnalysisFinding[],
  ): Promise<boolean> {
    return this.#deps.store.compareAndSetSession(
      scope,
      session._id,
      { state: session.state, workerId: this.#deps.workerId },
      { ...session, state, findings },
    );
  }

  async #checkpoint(
    scope: TenantScope,
    sessionId: string,
    input: {
      offset: number;
      framesProcessed: number;
      elapsedMs: number;
      chunksCompleted: number;
      findings: AnalysisFinding[];
      counts: AnalysisCounts;
      provenance: ObservedProvenance;
    },
  ): Promise<boolean> {
    const store = this.#deps.store;
    const session = await store.getSession(scope, sessionId);
    if (session === null) return false;
    const now = this.#deps.clock.now();
    return store.compareAndSetSession(
      scope,
      sessionId,
      { state: session.state, workerId: this.#deps.workerId },
      {
        ...session,
        progress: computeProgress({
          offsetSeconds: input.offset,
          ...(session.progress.durationSeconds === undefined
            ? {}
            : { durationSeconds: session.progress.durationSeconds }),
          framesProcessed: input.framesProcessed,
          elapsedMs: input.elapsedMs,
          chunksCompleted: input.chunksCompleted,
          now,
        }),
        findings: input.findings,
        /* ⭐ Counts are persisted per chunk, so a session killed mid-run still reports what it saw. */
        counts: { ...input.counts },
        provenance: mergeProvenance(session.provenance, input.provenance),
        /* ⚠️ Renewed with every checkpoint — a long chunk must not cost a worker its lease. */
        lease: session.lease === undefined ? undefined : renewLease(session.lease, now),
      },
    );
  }

  async #stop(
    scope: TenantScope,
    sessionId: string,
    state: AnalysisSessionDoc['state'],
    chunksCompleted: number,
    framesProcessed: number,
    counts?: AnalysisCounts,
    findings?: AnalysisFinding[],
    provenance?: ObservedProvenance,
  ): Promise<RunOutcome> {
    const session = await this.#deps.store.getSession(scope, sessionId);
    if (session === null) return { sessionId, state, chunksCompleted, framesProcessed };
    const now = this.#deps.clock.now();
    await this.#deps.store.compareAndSetSession(
      scope,
      sessionId,
      { state: session.state, workerId: this.#deps.workerId },
      {
        ...session,
        state,
        finishedAt: now.toISOString(),
        ...(counts === undefined ? {} : { counts }),
        /* ⚠️ Capped at the contract's limit rather than allowed to fail validation on write. */
        ...(findings === undefined ? {} : { findings: findings.slice(0, 50) }),
        ...(provenance === undefined
          ? {}
          : { provenance: mergeProvenance(session.provenance, provenance) }),
      },
    );
    return { sessionId, state, chunksCompleted, framesProcessed };
  }

  async #fail(
    scope: TenantScope,
    session: AnalysisSessionDoc,
    message: string,
    transient: boolean,
  ): Promise<RunOutcome> {
    const attempt = session.lease?.attempt ?? 1;
    const state = stateAfterFailure(attempt, transient);
    const now = this.#deps.clock.now();
    await this.#deps.store.compareAndSetSession(
      scope,
      session._id,
      { state: session.state, workerId: this.#deps.workerId },
      {
        ...session,
        state,
        error: message,
        /* ⚠️ A retrying session is NOT finished — stamping it would make it look terminal. */
        ...(isTerminalSessionState(state) ? { finishedAt: now.toISOString() } : {}),
      },
    );
    return {
      sessionId: session._id,
      state,
      chunksCompleted: 0,
      framesProcessed: session.progress.framesProcessed,
      reason: message,
    };
  }
}

/**
 * ⭐ **What the runtime said, folded into what the session already recorded.**
 *
 * ⚠️ The session's existing value wins. `capabilityId` and `pipelineVersion` are ours and are set at
 * creation; the runtime's three are captured on the first frame that answers and then left alone. A
 * later frame overwriting them would mean a session resumed after a runtime upgrade silently
 * reporting only the *second* runtime — losing precisely the fact that makes the result explicable.
 */
export function mergeProvenance(
  existing: AnalysisSessionDoc['provenance'],
  observed: ObservedProvenance,
): AnalysisSessionDoc['provenance'] {
  return {
    ...existing,
    ...(existing.runtimeVersion === undefined && observed.runtimeVersion !== undefined
      ? { runtimeVersion: observed.runtimeVersion }
      : {}),
    ...(existing.modelId === undefined && observed.modelId !== undefined
      ? { modelId: observed.modelId }
      : {}),
    ...(existing.executionProvider === undefined && observed.executionProvider !== undefined
      ? { executionProvider: observed.executionProvider }
      : {}),
  };
}

/**
 * Turn refused frames into findings an operator can act on.
 *
 * ⭐ **The percentage is the sentence that matters.** "412 frames were not analysed" means nothing
 * without a denominator; "412 of 28 800 (1.4 %)" and "412 of 412 (100 %)" are a blemish and a
 * catastrophe, and they must not read the same on a report.
 */
export function summariseRefusals(
  refusals: Map<string, { count: number; firstOffsetSeconds: number | undefined }>,
  counts: AnalysisCounts,
): AnalysisFinding[] {
  const out: AnalysisFinding[] = [];
  for (const [reason, seen] of refusals) {
    const share = counts.framesDecoded === 0 ? 0 : (seen.count / counts.framesDecoded) * 100;
    /*
     * ⚠️ An assignment refusal is its own kind, because it has its own fix. "The runtime was busy"
     * is an operations problem; "this camera is not assigned to AI processing" is a configuration
     * one, and L-54 exists because the two were once indistinguishable from the outside.
     */
    const kind: AnalysisFinding['kind'] = reason.includes('no AI processing assignment')
      ? 'assignment-missing'
      : reason.includes('paused for camera')
        ? 'assignment-missing'
        : 'frames-dropped';
    out.push({
      kind,
      detail: `${String(seen.count)} of ${String(counts.framesDecoded)} decoded frames (${share.toFixed(1)} %) were not analysed: ${reason}. ⛔ This analysis is incomplete — anything happening in those frames was not looked at.`,
      ...(seen.firstOffsetSeconds === undefined
        ? {}
        : { atOffsetSeconds: seen.firstOffsetSeconds }),
    });
  }
  return out;
}

/**
 * ⚠️ **Which failures deserve another attempt.**
 *
 * A network blip, a runtime restart or an object-store timeout will very likely succeed next time. A
 * recording with no video stream will fail identically three times and then fail — which is three
 * times the wait for the same answer, so it is refused after the first.
 */
export function isTransient(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const permanent = [
    'no video stream',
    'not json',
    'no usable dimensions',
    'unsupported',
    'not found',
  ];
  if (permanent.some((p) => message.includes(p))) return false;
  return true;
}

/** ⚠️ Exported so a deployment can state its own identity rather than inheriting a random one. */
export function defaultWorkerId(hostname: string, pid: number): string {
  return `${hostname}:${String(pid)}`;
}

export { ANALYSIS_LIMITS };
