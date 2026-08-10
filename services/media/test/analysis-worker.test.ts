/**
 * The analysis worker: leases, chunking, checkpoints, cancellation and retry (P-8 Phase 8, slice 2).
 *
 * ⭐ Driven with a fake `FrameSource`, so every property below is decided by arithmetic and by the
 * store's conditional write — no ffmpeg, no runtime, no Mongo, no wall-clock sleeps.
 */
import { describe, expect, it, vi } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { ANALYSIS_LIMITS, sessionStateToJobState } from '@vip/contracts';
import { InMemoryAnalysisStore } from '../src/adapters/in-memory-analysis-store.js';
import { AnalysisWorker, isTransient } from '../src/application/analysis-worker.js';
import { resolveEvidenceExpiry } from '../src/transport/routes/tracking.js';
import {
  computeProgress,
  estimateRemaining,
  nextChunk,
  resumeBreaksIdentity,
} from '../src/domain/analysis-progress.js';
import {
  grantLease,
  isClaimable,
  leaseHeld,
  stateAfterFailure,
  stateAfterLeaseLapse,
} from '../src/domain/analysis-lease.js';
import type {
  FrameChunkResult,
  FrameRequest,
  FrameSource,
} from '../src/application/frame-source.js';
import type { AnalysisDoc, AnalysisSessionDoc } from '../src/domain/analysis.js';
import type { Frame, StreamClosed } from '../src/application/ports.js';

const scope = TenantScope.fromTenantId('tnt_a');
const T0 = new Date('2026-08-07T12:00:00.000Z');

// ---------------------------------------------------------------------------------------------

describe('progress — the numbers an operator watches for twenty minutes', () => {
  /*
   * ⛔ `0` reads as "stalled". A queued session has not been slow; it has not been measured, and the
   * difference is what an operator raises a support ticket about.
   */
  it('reports null rather than zero before anything has been measured', () => {
    const p = computeProgress({
      offsetSeconds: 0,
      durationSeconds: 600,
      framesProcessed: 0,
      elapsedMs: 0,
      chunksCompleted: 0,
      now: T0,
    });
    expect(p.throughputFps).toBeNull();
    expect(p.speedFactor).toBeNull();
    expect(p.etaSeconds).toBeNull();
  });

  it('measures throughput and speed once there is elapsed time', () => {
    const p = computeProgress({
      offsetSeconds: 240,
      durationSeconds: 600,
      framesProcessed: 480,
      elapsedMs: 60_000,
      chunksCompleted: 2,
      now: T0,
    });
    expect(p.throughputFps).toBeCloseTo(8, 5);
    /* 240 s of footage in 60 s of wall clock — four times real time, which is the point. */
    expect(p.speedFactor).toBeCloseTo(4, 5);
    expect(p.etaSeconds).toBeCloseTo(90, 5);
  });

  /* ⭐ ADR-0039 one layer up: absent with a reason, never an invented number. */
  it('refuses an ETA before enough samples, and says why', () => {
    const early = estimateRemaining({
      offsetSeconds: 60,
      durationSeconds: 600,
      speedFactor: 8,
      chunksCompleted: 1,
    });
    expect(early.seconds).toBeNull();
    expect(early.reason).toMatch(/not enough of the recording/);
  });

  it('refuses an ETA when the recording declares no duration, and says why', () => {
    const r = estimateRemaining({ offsetSeconds: 60, speedFactor: 8, chunksCompleted: 5 });
    expect(r.seconds).toBeNull();
    expect(r.reason).toMatch(/does not declare a duration/);
  });
});

describe('chunk planning', () => {
  it('walks the footage in bounded steps and stops at the end', () => {
    expect(nextChunk(0, 300, 120)).toEqual({ fromOffsetSeconds: 0, durationSeconds: 120 });
    expect(nextChunk(240, 300, 120)).toEqual({ fromOffsetSeconds: 240, durationSeconds: 60 });
    expect(nextChunk(300, 300, 120)).toBeNull();
  });

  /* ⚠️ An undeclared duration must not stop the loop — the source's own EOF ends it. */
  it('keeps planning when the duration is unknown', () => {
    expect(nextChunk(480, undefined, 120)).toEqual({
      fromOffsetSeconds: 480,
      durationSeconds: 120,
    });
  });

  /**
   * ⛔ **The tail that failed every real recording the platform was ever given.**
   *
   * `offsetSeconds` is where the last *sampled* frame was, not where the footage ends. A 19.07 s
   * recording at 2 fps samples its last frame at 19.0, leaving 0.07 s — shorter than the 0.5 s
   * between samples, so no further frame can exist. Asking for it made ffmpeg seek past the last
   * frame, emit nothing and exit 234 "Conversion failed!", which the worker read as a decode failure
   * and retried three times — on a run that had already analysed 38/38 frames and found 24
   * detections.
   *
   * ⚠️ Every clip in the validation library is exactly 30.000 s, an exact multiple of the sample
   * interval, so its final chunk always landed on a sample point and emitted one frame. The whole
   * dataset was structurally blind to this. Reported by the Architect, 2026-08-08.
   */
  it('stops when the remaining footage is shorter than one frame interval', () => {
    /* 19.07 s at 2 fps: last sample at 19.0, 0.07 s left, 0.5 s between samples. */
    expect(nextChunk(19, 19.07, 120, 2)).toBeNull();
    /* ⚠️ And the old `Math.max(1, remaining)` widened that 0.07 s request to a full second. */
    expect(nextChunk(19, 19.07, 120)).toEqual({ fromOffsetSeconds: 19, durationSeconds: 1 });
  });

  /** ⭐ A tail that CAN still hold a sample is planned — this must not become an off-by-one. */
  it('still plans a tail that can contain another sample', () => {
    /* 0.6 s remaining at 2 fps is longer than the 0.5 s interval, so a frame can exist. */
    expect(nextChunk(19, 19.6, 120, 2)).toEqual({ fromOffsetSeconds: 19, durationSeconds: 1 });
    /* ⚠️ Exactly one interval remaining still counts — `29.5 → 30.0` emits the frame at 29.5. */
    expect(nextChunk(29.5, 30, 120, 2)).toEqual({ fromOffsetSeconds: 29.5, durationSeconds: 1 });
  });

  /** ⚠️ An unknown duration cannot be reasoned about, so the frame rate must not change anything. */
  it('ignores the frame rate when the duration is unknown', () => {
    expect(nextChunk(480, undefined, 120, 2)).toEqual({
      fromOffsetSeconds: 480,
      durationSeconds: 120,
    });
  });
});

describe('resume honesty', () => {
  /*
   * ⭐ The runtime releases a camera's tracking state after an idle period. A resume across it gets
   * NEW identities, so a dwell spanning the gap is split. Claiming continuity would be the defect.
   */
  it('knows when a resume cannot claim continuity', () => {
    expect(resumeBreaksIdentity(30)).toBe(false);
    expect(resumeBreaksIdentity(299)).toBe(false);
    expect(resumeBreaksIdentity(300)).toBe(true);
    expect(resumeBreaksIdentity(3600)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the lease — exclusion, not a check', () => {
  it('a queued session is claimable; a freshly leased one is not', () => {
    const lease = grantLease('worker-a', 1, T0);
    expect(isClaimable('queued', undefined, T0)).toBe(true);
    expect(isClaimable('running', lease, T0)).toBe(false);
  });

  /* ⚠️ Reclaiming a LIVE worker's session runs the footage twice through one camera's tracker. */
  it('a leased session becomes claimable only once the lease has genuinely lapsed', () => {
    const lease = grantLease('worker-a', 1, T0);
    const justBefore = new Date(T0.getTime() + (ANALYSIS_LIMITS.leaseSeconds - 1) * 1000);
    const after = new Date(T0.getTime() + (ANALYSIS_LIMITS.leaseSeconds + 1) * 1000);
    expect(isClaimable('running', lease, justBefore)).toBe(false);
    expect(isClaimable('running', lease, after)).toBe(true);
  });

  it('leaseHeld is false for another worker and for an expired lease', () => {
    const lease = grantLease('worker-a', 1, T0);
    expect(leaseHeld(lease, 'worker-a', T0)).toBe(true);
    expect(leaseHeld(lease, 'worker-b', T0)).toBe(false);
    expect(leaseHeld(lease, 'worker-a', new Date(T0.getTime() + 61_000))).toBe(false);
  });

  /*
   * ⭐ `expired` is not `failed`. "We tried and it did not work" and "we cannot account for what
   * happened to the worker" are different answers, and only one of them is about the recording.
   */
  it('retries a lapsed lease while attempts remain, then expires it', () => {
    expect(stateAfterLeaseLapse(1).state).toBe('retrying');
    expect(stateAfterLeaseLapse(2).state).toBe('retrying');
    expect(stateAfterLeaseLapse(3).state).toBe('expired');
    expect(stateAfterLeaseLapse(3).reason).toMatch(/cannot say what happened/);
  });

  it('retries a transient failure and refuses to retry a permanent one', () => {
    expect(stateAfterFailure(1, true)).toBe('retrying');
    expect(stateAfterFailure(3, true)).toBe('failed');
    expect(stateAfterFailure(1, false)).toBe('failed');
  });

  it('classifies failures by whether another attempt could possibly help', () => {
    expect(isTransient(new Error('socket hang up'))).toBe(true);
    expect(isTransient(new Error('the file contains no video stream'))).toBe(false);
    expect(isTransient(new Error('unsupported content type'))).toBe(false);
  });
});

describe('session state maps onto the frozen job vocabulary', () => {
  /* ⚠️ One function, so the two can never drift into disagreeing about "is this finished?". */
  it('collapses the operational states and leaves no job state unreachable', () => {
    expect(sessionStateToJobState('queued')).toBe('queued');
    expect(sessionStateToJobState('starting')).toBe('running');
    expect(sessionStateToJobState('paused')).toBe('running');
    expect(sessionStateToJobState('retrying')).toBe('running');
    expect(sessionStateToJobState('succeeded')).toBe('succeeded');
    expect(sessionStateToJobState('cancelled')).toBe('cancelled');
    /* ⭐ `expired` is a failure to the job layer — a job that never concluded did not succeed. */
    expect(sessionStateToJobState('expired')).toBe('failed');
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * ⭐ A sink that **delivers losslessly**, as the real one does for offline frames.
 *
 * ⚠️ It implements `deliver`, not just `push`, and that is what makes these tests meaningful. The
 * worker refuses a sink that can only `push`, because pushing drops frames under load — so a double
 * offering only `push` would have every one of these tests exercise the refusal path instead of the
 * behaviour they are named for.
 */
class FakeSink implements FrameSink {
  readonly delivered: Array<{ cameraId: string; frame: Frame }> = [];
  /** Outcome for the nth delivery, so a refusal can be driven deterministically. */
  outcomeFor: ((index: number) => FrameDelivery) | null = null;
  /** ⭐ Every end-of-run close, so a test can assert the runtime was told — and told once. */
  readonly closed: Array<{ tenantId: string; cameraId: string; streamId: string }> = [];
  /** What the close reports, so a lost-evidence path can be driven deterministically. */
  closeResult: StreamClosed = { closed: 0, written: 0 };

  async closeStream(tenantId: string, cameraId: string, streamId: string): Promise<StreamClosed> {
    this.closed.push({ tenantId, cameraId, streamId });
    return this.closeResult;
  }

  push(): void {
    throw new Error('an offline session must never reach the lossy push path');
  }

  async deliver(
    _tenantId: string,
    cameraId: string,
    frame: Frame,
    _signal: AbortSignal,
  ): Promise<FrameDelivery> {
    const index = this.delivered.length;
    this.delivered.push({ cameraId, frame });
    return (
      this.outcomeFor?.(index) ?? {
        outcome: 'delivered',
        detections: 0,
        runtimeVersion: '1.0.0',
        modelId: 'yolov8n',
        executionProvider: 'cpu',
      }
    );
  }
}

class FakeSource implements FrameSource {
  readonly requests: FrameRequest[] = [];
  closed = 0;
  /** Fire `onAbort` after this many frames of a chunk, so cancellation is deterministic. */
  abortAfterFrames: number | null = null;
  onAbort: (() => void) | null = null;
  /** ⚠️ Throw from `read`, so a run that fails can be driven without a real decoder. */
  failWith: Error | null = null;
  /** Footage the file actually contains, which may be less than the container declares. */
  constructor(private readonly realDurationSeconds = 300) {}

  async read(
    request: FrameRequest,
    onFrame: (frame: Frame) => Promise<void>,
    signal: AbortSignal,
  ): Promise<FrameChunkResult> {
    this.requests.push(request);
    if (this.failWith !== null) throw this.failWith;
    const end = Math.min(
      request.fromOffsetSeconds + request.durationSeconds,
      this.realDurationSeconds,
    );
    const frames = Math.max(0, Math.round((end - request.fromOffsetSeconds) * request.frameRate));
    let emitted = 0;
    for (let i = 0; i < frames; i += 1) {
      if (signal.aborted) break;
      /*
       * ⚠️ Frames carry provenance, exactly as the real source stamps them. A fake that omitted it
       * would make the pacer a no-op and the offset-derived assertions vacuous — the double would
       * pass tests the real thing fails.
       */
      const seq = Math.round(request.fromOffsetSeconds * request.frameRate) + i + 1;
      const mediaOffsetSeconds = (seq - 1) / request.frameRate;
      await onFrame({
        seq,
        at: new Date(T0.getTime() + mediaOffsetSeconds * 1000),
        data: new Uint8Array([1]),
        provenance: {
          sourceKind: 'stored-media',
          sourceId: 'analyses/ana_1/source.mp4',
          analysisId: 'ana_1',
          sessionId: 'ases_1',
          chunkId: `ases_1#${String(this.requests.length - 1)}`,
          chunkIndex: this.requests.length - 1,
          mediaOffsetSeconds,
          ptsSeconds: mediaOffsetSeconds - request.fromOffsetSeconds,
          frameRate: request.frameRate,
          decoder: 'fake/1.0.0',
        },
      });
      emitted += 1;
      if (this.abortAfterFrames !== null && emitted === this.abortAfterFrames) this.onAbort?.();
    }
    /* ⚠️ A cancelled chunk reports where it actually got to, not where it was asked to reach. */
    const truncated = emitted < frames;
    const reached = truncated ? request.fromOffsetSeconds + emitted / request.frameRate : end;
    return {
      framesEmitted: emitted,
      reachedOffsetSeconds: reached,
      reachedEnd: !truncated && end >= this.realDurationSeconds,
    };
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

async function seed(store: InMemoryAnalysisStore, durationSeconds = 300) {
  const analysis: AnalysisDoc = {
    _id: 'ana_1',
    tenantId: 'tnt_a',
    cameraId: 'cam_1',
    sourceKind: 'upload',
    state: 'ready',
    asset: {
      key: 'analyses/ana_1/source.mp4',
      originalName: 'x.mp4',
      bytes: 10,
      contentType: 'video/mp4',
      container: 'mp4',
      codec: 'h264',
      width: 640,
      height: 480,
      sourceFrameRate: 25,
      durationSeconds,
    },
    footageStartedAt: '2026-08-01T09:00:00.000Z',
    footageStartSource: 'operator',
    sessionCount: 1,
    createdBy: 'usr_1',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  };
  await store.putAnalysis(scope, analysis);

  const session: AnalysisSessionDoc = {
    _id: 'ases_1',
    tenantId: 'tnt_a',
    analysisId: 'ana_1',
    cameraId: 'cam_1',
    sequence: 1,
    state: 'queued',
    analysisFrameRate: 2,
    provenance: { capabilityId: 'perception.person-detection', pipelineVersion: '1.0.0' },
    ruleSet: [],
    progress: {
      mediaOffsetSeconds: 0,
      durationSeconds,
      framesProcessed: 0,
      throughputFps: null,
      speedFactor: null,
      etaSeconds: null,
      updatedAt: T0.toISOString(),
    },
    counts: {
      framesDecoded: 0,
      framesAnalysed: 0,
      framesDropped: 0,
      detections: 0,
      events: 0,
      incidents: 0,
    },
    findings: [],
    requestedBy: 'usr_1',
    createdAt: T0.toISOString(),
  };
  await store.putSession(scope, session);
  return { analysis, session };
}

function build(
  opts: { workerId?: string; source?: FakeSource; now?: () => Date; sink?: FakeSink } = {},
) {
  const store = new InMemoryAnalysisStore();
  const source = opts.source ?? new FakeSource();
  const sink = opts.sink ?? new FakeSink();
  const worker = new AnalysisWorker({
    store,
    sources: {
      async open() {
        return source;
      },
    },
    sink,
    clock: { now: opts.now ?? (() => T0) },
    workerId: opts.workerId ?? 'worker-a',
  });
  return { store, worker, source, sink, pushed: sink.delivered };
}

describe('AnalysisWorker — running a session', () => {
  it('claims, chunks through the footage, and succeeds', async () => {
    const { store, worker, source, pushed } = build();
    const { session } = await seed(store, 300);

    expect(await worker.claim(scope, session)).toBe(true);
    const outcome = await worker.runSession(scope, 'ases_1');

    expect(outcome.state).toBe('succeeded');
    /* 300 s of footage in 120 s chunks → 120 + 120 + 60. */
    expect(source.requests.map((r) => r.durationSeconds)).toEqual([120, 120, 60]);
    expect(outcome.framesProcessed).toBe(600); // 300 s at 2 fps
    expect(pushed).toHaveLength(600);
    /* ⭐ Every frame reached the LIVE sink, under the analysis's camera. */
    expect(pushed.every((p) => p.cameraId === 'cam_1')).toBe(true);
    expect(source.closed).toBe(1);
  });

  /* ⚠️ The source's own EOF ends the run — a container that over-declares must not spin for ever. */
  it('stops at the source’s real end even when the container declares more', async () => {
    const { store, worker, source } = build({ source: new FakeSource(150) });
    const { session } = await seed(store, 600);
    await worker.claim(scope, session);

    const outcome = await worker.runSession(scope, 'ases_1');
    expect(outcome.state).toBe('succeeded');
    expect(source.requests).toHaveLength(2);
    expect(outcome.framesProcessed).toBe(300); // 150 s at 2 fps
  });

  it('checkpoints its offset after every chunk, so a resume knows where to start', async () => {
    const { store, worker } = build();
    const { session } = await seed(store, 300);
    await worker.claim(scope, session);
    await worker.runSession(scope, 'ases_1');

    const after = await store.getSession(scope, 'ases_1');
    expect(after?.progress.mediaOffsetSeconds).toBe(300);
    expect(after?.progress.framesProcessed).toBe(600);
    expect(after?.finishedAt).toBeDefined();
  });

  /*
   * ⭐ Two workers, one session. The loser must not run the same footage through the same camera's
   * tracker — that is duplicate identities and duplicate incidents, from software behaving "correctly".
   */
  it('lets exactly one of two workers claim a session', async () => {
    const store = new InMemoryAnalysisStore();
    const { session } = await seed(store);
    const mk = (id: string) =>
      new AnalysisWorker({
        store,
        sources: {
          async open() {
            return new FakeSource();
          },
        },
        sink: new FakeSink(),
        clock: { now: () => T0 },
        workerId: id,
      });

    const results = await Promise.all([
      mk('worker-a').claim(scope, session),
      mk('worker-b').claim(scope, session),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses to run a session it does not hold', async () => {
    const store = new InMemoryAnalysisStore();
    const { session } = await seed(store);
    const a = new AnalysisWorker({
      store,
      sources: {
        async open() {
          return new FakeSource();
        },
      },
      sink: new FakeSink(),
      clock: { now: () => T0 },
      workerId: 'worker-a',
    });
    const b = new AnalysisWorker({
      store,
      sources: {
        async open() {
          return new FakeSource();
        },
      },
      sink: new FakeSink(),
      clock: { now: () => T0 },
      workerId: 'worker-b',
    });
    await a.claim(scope, session);

    const outcome = await b.runSession(scope, 'ases_1');
    expect(outcome.reason).toMatch(/does not hold the lease/);
  });

  /*
   * ⛔ A cancel that only writes `cancelled` leaves the decoder running and frames still arriving.
   * The session looks stopped and the host does not.
   */
  /*
   * ⛔ A cancel that only writes `cancelled` leaves the decoder running and frames still arriving.
   * The session looks stopped and the host does not — so the assertion is that the SIGNAL reached
   * the source mid-chunk, not merely that the record changed.
   */
  it('cancellation reaches the decode in progress, not just the record', async () => {
    const store = new InMemoryAnalysisStore();
    const { session } = await seed(store, 600);
    const source = new FakeSource(600);
    const sink = new FakeSink();
    const worker = new AnalysisWorker({
      store,
      sources: {
        async open() {
          return source;
        },
      },
      sink,
      clock: { now: () => T0 },
      workerId: 'worker-a',
    });
    /* Abort deterministically, part-way through the first chunk's frames. */
    source.abortAfterFrames = 50;
    source.onAbort = () => worker.cancelLocal('ases_1');
    await worker.claim(scope, session);

    const outcome = await worker.runSession(scope, 'ases_1');

    expect(outcome.state).toBe('cancelled');
    const after = await store.getSession(scope, 'ases_1');
    expect(after?.state).toBe('cancelled');
    /* ⭐ It stopped INSIDE the chunk: far fewer than the 240 frames one 120 s chunk would give. */
    expect(sink.delivered.length).toBeGreaterThan(0);
    expect(sink.delivered.length).toBeLessThan(240);
  });

  it('reports a permanent failure without retrying it', async () => {
    const store = new InMemoryAnalysisStore();
    const { session } = await seed(store);
    const worker = new AnalysisWorker({
      store,
      sources: {
        async open() {
          throw new Error('the file contains no video stream');
        },
      },
      sink: new FakeSink(),
      clock: { now: () => T0 },
      workerId: 'worker-a',
    });
    await worker.claim(scope, session);

    /*
     * ⚠️ The first version of this test asserted that `runSession` THREW — which is what the code
     * did, because the source was opened outside the try. That left the session `starting` with a
     * lease nobody would renew, to be retried twice more for the same unopenable file. The test was
     * written to match the code rather than the requirement; both are fixed.
     */
    const outcome = await worker.runSession(scope, 'ases_1');
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toMatch(/no video stream/);

    const after = await store.getSession(scope, 'ases_1');
    expect(after?.state).toBe('failed');
    expect(after?.error).toMatch(/no video stream/);
    expect(after?.finishedAt).toBeDefined();
  });

  it('retries a transient open failure instead of failing outright', async () => {
    const store = new InMemoryAnalysisStore();
    const { session } = await seed(store);
    const worker = new AnalysisWorker({
      store,
      sources: {
        async open() {
          throw new Error('socket hang up');
        },
      },
      sink: new FakeSink(),
      clock: { now: () => T0 },
      workerId: 'worker-a',
    });
    await worker.claim(scope, session);

    const outcome = await worker.runSession(scope, 'ases_1');
    expect(outcome.state).toBe('retrying');
    const after = await store.getSession(scope, 'ases_1');
    /* ⚠️ A retrying session is NOT finished — stamping it would make it look terminal. */
    expect(after?.finishedAt).toBeUndefined();
  });

  it('renews its lease on heartbeat and refuses to renew another worker’s', async () => {
    let tick = T0;
    const { store, worker } = build({ now: () => tick });
    const { session } = await seed(store);
    await worker.claim(scope, session);

    tick = new Date(T0.getTime() + 30_000);
    expect(await worker.heartbeat(scope, 'ases_1')).toBe(true);
    const renewed = await store.getSession(scope, 'ases_1');
    expect(Date.parse(renewed!.lease!.expiresAt)).toBeGreaterThan(
      T0.getTime() + ANALYSIS_LIMITS.leaseSeconds * 1000,
    );

    const other = new AnalysisWorker({
      store,
      sources: {
        async open() {
          return new FakeSource();
        },
      },
      sink: new FakeSink(),
      clock: { now: () => tick },
      workerId: 'worker-b',
    });
    expect(await other.heartbeat(scope, 'ases_1')).toBe(false);
  });

  /*
   * ⭐ The property that makes multi-worker safe under a lease lapse: a worker whose session was
   * reclaimed mid-chunk must STOP, not overwrite the record the new owner is now writing.
   */
  it('stops when its lease is taken while a chunk is decoding', async () => {
    const store = new InMemoryAnalysisStore();
    const { session } = await seed(store, 600);
    const worker = new AnalysisWorker({
      store,
      sources: {
        async open() {
          return new FakeSource(600);
        },
      },
      sink: new FakeSink(),
      clock: { now: () => T0 },
      workerId: 'worker-a',
    });
    await worker.claim(scope, session);

    /* Another worker takes it over between chunks. */
    const stolen = await store.getSession(scope, 'ases_1');
    const original = store.compareAndSetSession.bind(store);
    let calls = 0;
    vi.spyOn(store, 'compareAndSetSession').mockImplementation(async (s, id, expected, next) => {
      calls += 1;
      if (calls === 3) {
        await original(s, id, expected, {
          ...stolen!,
          state: 'running',
          lease: grantLease('worker-b', 1, T0),
        });
        return false;
      }
      return original(s, id, expected, next);
    });

    const outcome = await worker.runSession(scope, 'ases_1');
    expect(outcome.state).toBe('expired');
    expect(outcome.reason).toMatch(/taken by another worker/);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * ⛔ **The run must tell the runtime when it ends** (Evidence Integrity, EI-3b).
 *
 * Nothing used to. The worker delivered its last frame and stopped, and every identity still in shot
 * stayed in the runtime's in-memory buffer until a 300-second camera sweep happened to run — which
 * runs on the *frame* path, so a deployment that has gone quiet never runs it. Measured on the
 * deployed stack, idle for 26 minutes after a batch of analyses:
 *
 *     BEFORE  live_identities=28  live_streams=12  records=5259  write_failures=0
 *     ⏻ docker kill -s KILL
 *     AFTER   live_identities=0   live_streams=0   records=5259  write_failures=0
 *
 * 28 identities across **12 finished runs**, destroyed, with nothing attempted. ⚠️ No shutdown
 * handler can fix that — SIGKILL, an OOM kill and an expired grace period never consult the process.
 * The window between "this run ended" and "something eventually retires it" is the defect, and the
 * party that knows the run ended is this one.
 */
describe('AnalysisWorker — closing the run so its evidence survives', () => {
  it('tells the runtime when a run succeeds', async () => {
    const { store, worker, sink } = build();
    const { session } = await seed(store, 60);
    await worker.claim(scope, session);

    const outcome = await worker.runSession(scope, 'ases_1');

    expect(outcome.state).toBe('succeeded');
    expect(sink.closed).toEqual([
      { tenantId: 'tnt_a', cameraId: 'cam_1', streamId: 'ases_1' },
    ]);
  });

  it('tells the runtime when a run is cancelled', async () => {
    /*
     * ⛔ A cancelled run has produced real evidence up to the moment it stopped, and an operator who
     * cancels a four-hour analysis after twenty minutes still expects the twenty minutes.
     */
    const source = new FakeSource();
    const { store, worker, sink } = build({ source });
    const { session } = await seed(store, 600);
    await worker.claim(scope, session);
    /*
     * ⚠️ Mid-chunk, after frames have been emitted — the existing hook, and the realistic shape.
     * A cancel landing before the *first* frame of a chunk leaves the offset unadvanced, and the
     * loop's "a chunk that did not advance ends the run" guard then reports `succeeded`. That is a
     * pre-existing narrow race, noted in EVIDENCE_INTEGRITY_REPORT.md and out of scope here.
     */
    source.abortAfterFrames = 40;
    source.onAbort = (): void => {
      worker.cancelLocal('ases_1');
    };

    const outcome = await worker.runSession(scope, 'ases_1');

    expect(outcome.state).toBe('cancelled');
    expect(sink.closed).toHaveLength(1);
    expect(sink.closed[0]?.streamId).toBe('ases_1');
  });

  it('tells the runtime when a run fails for good', async () => {
    const source = new FakeSource();
    source.failWith = new Error('no video stream');
    const { store, worker, sink } = build({ source });
    const { session } = await seed(store, 60);
    await worker.claim(scope, session);

    const outcome = await worker.runSession(scope, 'ases_1');

    expect(outcome.state).toBe('failed');
    expect(sink.closed).toHaveLength(1);
  });

  it('does NOT close a run that will be retried', async () => {
    /*
     * ⛔ The one that must not fire. A `retrying` session is claimed again by a worker that continues
     * the same stream; retiring its identities between attempts would split every path across the
     * retry and produce two short visits where one long one happened — ADR-0038's failure, caused by
     * the fix for a different one.
     */
    const source = new FakeSource();
    source.failWith = new Error('the object store timed out');
    const { store, worker, sink } = build({ source });
    const { session } = await seed(store, 60);
    await worker.claim(scope, session);

    const outcome = await worker.runSession(scope, 'ases_1');

    expect(outcome.state).toBe('retrying');
    expect(sink.closed).toEqual([]);
  });

  it('records a finding when the runtime could not be told', async () => {
    /*
     * ⚠️ The analysis still succeeded — a bookkeeping call that failed must not turn a complete run
     * into a failed one. But it must not be silent: this is the only place the fact can be attached
     * to the session it belongs to.
     */
    const sink = new FakeSink();
    sink.closeResult = { closed: 0, written: 0, reason: 'connect ECONNREFUSED' };
    const { store, worker } = build({ sink });
    const { session } = await seed(store, 60);
    await worker.claim(scope, session);

    const outcome = await worker.runSession(scope, 'ases_1');
    const after = await store.getSession(scope, 'ases_1');

    expect(outcome.state).toBe('succeeded');
    const finding = after?.findings.find((f) => f.kind === 'evidence-not-preserved');
    expect(finding).toBeDefined();
    expect(finding?.detail).toMatch(/ECONNREFUSED/);
  });

  it('records a finding when evidence was retired but not written', async () => {
    /* ⛔ `closed > written` is a full disk or an unwritable volume: the identities left memory and
     * never reached storage. The count is the only witness. */
    const sink = new FakeSink();
    sink.closeResult = { closed: 3, written: 1 };
    const { store, worker } = build({ sink });
    const { session } = await seed(store, 60);
    await worker.claim(scope, session);

    await worker.runSession(scope, 'ases_1');
    const after = await store.getSession(scope, 'ases_1');

    const finding = after?.findings.find((f) => f.kind === 'evidence-not-preserved');
    expect(finding).toBeDefined();
    expect(finding?.detail).toMatch(/2 of 3/);
  });

  it('says nothing when the close succeeded', async () => {
    /* ⚠️ The negative control. A finding that is always present is not a finding. */
    const sink = new FakeSink();
    sink.closeResult = { closed: 2, written: 2 };
    const { store, worker } = build({ sink });
    const { session } = await seed(store, 60);
    await worker.claim(scope, session);

    await worker.runSession(scope, 'ases_1');
    const after = await store.getSession(scope, 'ases_1');

    expect(after?.findings.some((f) => f.kind === 'evidence-not-preserved')).toBe(false);
  });

  it('does not fail the run when closing throws', async () => {
    /* ⚠️ `closeStream` is documented as never throwing, but a sink is an interface and this is the
     * boundary. A complete analysis must not be reported as failed by its own bookkeeping. */
    const sink = new FakeSink();
    sink.closeStream = (): Promise<StreamClosed> => Promise.reject(new Error('boom'));
    const { store, worker } = build({ sink });
    const { session } = await seed(store, 60);
    await worker.claim(scope, session);

    const outcome = await worker.runSession(scope, 'ases_1');

    expect(outcome.state).toBe('succeeded');
  });

  it('still completes when the deployment has no runtime to tell', async () => {
    /* ⚠️ A sink without `closeStream` is a legitimate deployment, and absence must read as "cannot
     * be told" rather than as an error. */
    const sink = new FakeSink();
    /* ⚠️ An own property shadowing the prototype method — `delete` would not remove a class method. */
    (sink as { closeStream?: unknown }).closeStream = undefined;
    const { store, worker } = build({ sink });
    const { session } = await seed(store, 60);
    await worker.claim(scope, session);

    expect((await worker.runSession(scope, 'ases_1')).state).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * ⭐ **`absent` and `expired` are different answers** (Evidence Integrity, EI-4).
 *
 * The runtime holds records, not runs. Asked about a stream it has none for, it cannot tell "this
 * analysis never existed" from "this analysis is older than retention" — both are silence. This
 * layer holds `finishedAt`, and a run that finished before the runtime's published retention horizon
 * **cannot** have surviving records. ⭐ A proof rather than an inference, made once, here.
 */
describe('evidence expiry — a kept promise, not a defect', () => {
  const horizon = '2026-08-10T00:00:00.000Z';
  const answer = (state: string): unknown => ({
    enabled: true,
    evidence: { state, detail: 'x', durable: 0, live: 0, records: 0, damagedRecords: 0, retentionHorizonAt: horizon },
  });
  const sessions = (finishedAt?: string, evidenceNotPreserved?: string) => ({
    async evidenceContext(): Promise<{ finishedAt?: string; evidenceNotPreserved?: string }> {
      return {
        ...(finishedAt === undefined ? {} : { finishedAt }),
        ...(evidenceNotPreserved === undefined ? {} : { evidenceNotPreserved }),
      };
    },
  });
  const stateOf = (out: unknown): unknown => (out as { evidence: { state: unknown } }).evidence.state;

  it('upgrades absent to expired when the run finished before the horizon', async () => {
    const out = await resolveEvidenceExpiry(answer('absent'), {
      sessions: sessions('2026-08-01T09:00:00.000Z'),
      tenantId: 'tnt_a',
      streamId: 'ases_1',
    });
    expect(stateOf(out)).toBe('expired');
  });

  it('leaves absent alone when the run is inside the horizon', async () => {
    /* ⚠️ The negative control. An expiry that always fires explains every empty answer away. */
    const out = await resolveEvidenceExpiry(answer('absent'), {
      sessions: sessions('2026-08-10T09:00:00.000Z'),
      tenantId: 'tnt_a',
      streamId: 'ases_1',
    });
    expect(stateOf(out)).toBe('absent');
  });

  it('never dresses a lost read as expired', async () => {
    /* ⛔ EI-4's rule in the direction that flatters us: calling a defect a policy. */
    const out = await resolveEvidenceExpiry(answer('lost'), {
      sessions: sessions('2026-08-01T09:00:00.000Z'),
      tenantId: 'tnt_a',
      streamId: 'ases_1',
    });
    expect(stateOf(out)).toBe('lost');
  });

  it('never dresses a corrupted read as expired', async () => {
    const out = await resolveEvidenceExpiry(answer('corrupted'), {
      sessions: sessions('2026-08-01T09:00:00.000Z'),
      tenantId: 'tnt_a',
      streamId: 'ases_1',
    });
    expect(stateOf(out)).toBe('corrupted');
  });

  it('stays absent when this deployment cannot look a run up', async () => {
    const out = await resolveEvidenceExpiry(answer('absent'), {
      tenantId: 'tnt_a',
      streamId: 'ases_1',
    });
    expect(stateOf(out)).toBe('absent');
  });

  it('stays absent when the run has no finish time', async () => {
    const out = await resolveEvidenceExpiry(answer('absent'), {
      sessions: sessions(undefined),
      tenantId: 'tnt_a',
      streamId: 'ases_1',
    });
    expect(stateOf(out)).toBe('absent');
  });

  it('stays absent when the lookup fails', async () => {
    /* ⚠️ A store that is down must not manufacture an explanation for missing evidence. */
    const out = await resolveEvidenceExpiry(answer('absent'), {
      sessions: {
        async evidenceContext(): Promise<never> {
          throw new Error('mongo is unreachable');
        },
      },
      tenantId: 'tnt_a',
      streamId: 'ases_1',
    });
    expect(stateOf(out)).toBe('absent');
  });

  it('reports a run that recorded losing evidence as lost, not absent', async () => {
    /*
     * ⛔ **The stress run found this one.** A run SIGKILLed mid-flight had analysed 24 frames and
     * produced 69 detections; those identities were live in the process that died and are genuinely
     * unrecoverable. The run said so twice — `frames-dropped` and `evidence-not-preserved` — and the
     * behaviour read still answered `absent`, because the RESTARTED runtime has no memory of what
     * the dead one was holding. The session outlives the restart; the runtime does not.
     */
    const out = await resolveEvidenceExpiry(answer('absent'), {
      sessions: sessions(undefined, 'the perception runtime could not be told so: fetch failed'),
      tenantId: 'tnt_a',
      streamId: 'ases_1',
    });
    expect(stateOf(out)).toBe('lost');
    expect((out as { evidence: { detail: string } }).evidence.detail).toMatch(/not a claim that nothing happened/);
  });

  it('calls a run that both lost evidence and aged out lost, never expired', async () => {
    /* ⛔ Reporting it as `expired` would file a defect under a policy that was kept. */
    const out = await resolveEvidenceExpiry(answer('absent'), {
      sessions: sessions('2026-08-01T09:00:00.000Z', 'fetch failed'),
      tenantId: 'tnt_a',
      streamId: 'ases_1',
    });
    expect(stateOf(out)).toBe('lost');
  });

  it('passes a read with no evidence block through untouched', async () => {
    const plain = { enabled: false, detail: 'track history is not enabled on this runtime' };
    expect(await resolveEvidenceExpiry(plain, { tenantId: 'tnt_a' })).toBe(plain);
  });
});
