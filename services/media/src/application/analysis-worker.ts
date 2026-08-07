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
import { ANALYSIS_LIMITS, isTerminalSessionState, type AnalysisFinding } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { grantLease, leaseHeld, renewLease, stateAfterFailure } from '../domain/analysis-lease.js';
import { computeProgress, nextChunk, resumeBreaksIdentity } from '../domain/analysis-progress.js';
import type { AnalysisSessionDoc } from '../domain/analysis.js';
import type { AnalysisStore, Frame, FrameSink } from './ports.js';
import type { FrameSource, FrameSourceFactory } from './frame-source.js';

export interface AnalysisWorkerDeps {
  store: AnalysisStore;
  sources: FrameSourceFactory;
  /** ⭐ The SAME sink the live decode path pushes to. Not a copy of it. */
  sink: FrameSink;
  clock: { now(): Date };
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
    /*
     * ⚠️ Opened INSIDE the try. The first version opened the source before it, so a recording that
     * could not be opened threw out of this method and left the session `starting` with a lease
     * nobody would renew — it would sit there until the lease lapsed and then be retried twice more
     * for the same unopenable file. A failure to open is a failure of the run, and is recorded as
     * one, with its reason.
     */
    let source: FrameSource | undefined;

    try {
      source = await sources.open({
        tenantId: scope.tenantId,
        assetKey: analysis.asset.key,
        contentType: analysis.asset.contentType,
      });
      await this.#advance(scope, session, 'running', findings);

      for (;;) {
        if (controller.signal.aborted) {
          return this.#stop(scope, sessionId, 'cancelled', chunksCompleted, framesProcessed);
        }
        const chunk = nextChunk(offset, analysis.asset.durationSeconds);
        if (chunk === null) break;

        const startedMs = Date.now();
        const result = await source.read(
          { ...chunk, frameRate: session.analysisFrameRate },
          (frame: Frame) => {
            /* ⭐ The live path's sink. Offline frames are indistinguishable from a camera's here. */
            sink.push(scope.tenantId, session.cameraId, frame);
          },
          controller.signal,
        );
        elapsedMs += Date.now() - startedMs;

        framesProcessed += result.framesEmitted;
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
        if (result.reachedEnd) break;
      }

      return this.#stop(scope, sessionId, 'succeeded', chunksCompleted, framesProcessed);
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
  ): Promise<RunOutcome> {
    const session = await this.#deps.store.getSession(scope, sessionId);
    if (session === null) return { sessionId, state, chunksCompleted, framesProcessed };
    const now = this.#deps.clock.now();
    await this.#deps.store.compareAndSetSession(
      scope,
      sessionId,
      { state: session.state, workerId: this.#deps.workerId },
      { ...session, state, finishedAt: now.toISOString() },
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
