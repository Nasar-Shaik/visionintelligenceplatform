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
import type { Frame } from '../src/application/ports.js';

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

class FakeSource implements FrameSource {
  readonly requests: FrameRequest[] = [];
  closed = 0;
  /** Fire `onAbort` after this many frames of a chunk, so cancellation is deterministic. */
  abortAfterFrames: number | null = null;
  onAbort: (() => void) | null = null;
  /** Footage the file actually contains, which may be less than the container declares. */
  constructor(private readonly realDurationSeconds = 300) {}

  async read(
    request: FrameRequest,
    onFrame: (frame: Frame) => void,
    signal: AbortSignal,
  ): Promise<FrameChunkResult> {
    this.requests.push(request);
    const end = Math.min(
      request.fromOffsetSeconds + request.durationSeconds,
      this.realDurationSeconds,
    );
    const frames = Math.max(0, Math.round((end - request.fromOffsetSeconds) * request.frameRate));
    let emitted = 0;
    for (let i = 0; i < frames; i += 1) {
      if (signal.aborted) break;
      onFrame({ seq: i + 1, at: new Date(T0.getTime() + i * 500), data: new Uint8Array([1]) });
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

function build(opts: { workerId?: string; source?: FakeSource; now?: () => Date } = {}) {
  const store = new InMemoryAnalysisStore();
  const source = opts.source ?? new FakeSource();
  const pushed: Array<{ cameraId: string; frame: Frame }> = [];
  const worker = new AnalysisWorker({
    store,
    sources: {
      async open() {
        return source;
      },
    },
    sink: { push: (_t, cameraId, frame) => pushed.push({ cameraId, frame }) },
    clock: { now: opts.now ?? (() => T0) },
    workerId: opts.workerId ?? 'worker-a',
  });
  return { store, worker, source, pushed };
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
        sink: { push: () => {} },
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
      sink: { push: () => {} },
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
      sink: { push: () => {} },
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
    const pushed: Frame[] = [];
    const worker = new AnalysisWorker({
      store,
      sources: {
        async open() {
          return source;
        },
      },
      sink: { push: (_t, _c, frame) => pushed.push(frame) },
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
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed.length).toBeLessThan(240);
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
      sink: { push: () => {} },
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
      sink: { push: () => {} },
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
      sink: { push: () => {} },
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
      sink: { push: () => {} },
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
