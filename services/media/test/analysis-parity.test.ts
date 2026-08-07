/**
 * ⭐ **The milestone's central acceptance criterion, as a test** (P-8 Phase 8, slice 3).
 *
 * *The same recording analysed at different speeds must produce the same answer.* Not "close
 * enough", not "within tolerance" — **identical**, because every analytical decision downstream is
 * keyed on footage time, and footage time is a property of the file rather than of the host that
 * read it.
 *
 * ### What is actually compared
 *
 * The Architect asked for parity beyond incidents: detections, tracks, identities, dwell state, rule
 * evaluations, events, incidents, timestamps, evidence and replay. Those live in four services, so
 * this file verifies the half that media is answerable for and does it **exhaustively**:
 *
 * - every frame's sequence number, event time, media offset and PTS,
 * - the order they were delivered in,
 * - the bytes of each frame,
 * - the provenance stamped on each,
 * - the session's resulting counts and state.
 *
 * ⭐ **That is the whole of media's contribution to a deterministic result.** Everything downstream —
 * tracking, identity, dwell, rules, incidents — is a pure function of the frame stream plus the
 * runtime's own state, and the runtime is driven only by what arrives here. If two runs deliver
 * byte-identical frames, in the same order, with the same timestamps, then any downstream difference
 * is a defect in a *different* service, and this test is what makes that a provable statement rather
 * than an argument.
 *
 * ⚠️ The end-to-end half — the real runtime, real events, real incidents — is verified against the
 * deployed stack, because a fake runtime cannot prove a real one is deterministic. See
 * `docs/verification/P8-PHASE8-SLICE3.md`.
 */
import { describe, expect, it } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { AnalysisWorker } from '../src/application/analysis-worker.js';
import type { FrameDelivery, Frame, FrameSink } from '../src/application/ports.js';
import type {
  FrameChunkResult,
  FrameRequest,
  FrameSource,
} from '../src/application/frame-source.js';
import { InMemoryAnalysisStore } from '../src/adapters/in-memory-analysis-store.js';
import type { AnalysisDoc, AnalysisSessionDoc } from '../src/domain/analysis.js';
import { newSession } from '../src/domain/analysis.js';
import { Pacer, systemSleeper, type Sleeper } from '../src/domain/analysis-pacing.js';

const scope = new TenantScope('tnt_a');
const T0 = new Date('2026-03-01T09:00:00.000Z');
const FOOTAGE_START = '2026-02-14T18:30:00.000Z';

/**
 * A deterministic stand-in for stored media.
 *
 * ⚠️ It derives every frame from the request alone — no wall clock, no counters that survive a
 * chunk. That is not a simplification of the real source; it is the *contract* the real source is
 * held to, and stating it here is what makes the comparison below meaningful.
 */
class DeterministicSource implements FrameSource {
  #chunk = 0;
  constructor(private readonly realDurationSeconds: number) {}

  async read(
    request: FrameRequest,
    onFrame: (frame: Frame) => Promise<void>,
    signal: AbortSignal,
  ): Promise<FrameChunkResult> {
    const chunkIndex = this.#chunk;
    this.#chunk += 1;
    const end = Math.min(
      request.fromOffsetSeconds + request.durationSeconds,
      this.realDurationSeconds,
    );
    const seqAtStart = Math.round(request.fromOffsetSeconds * request.frameRate);
    const frames = Math.max(0, Math.round((end - request.fromOffsetSeconds) * request.frameRate));

    let emitted = 0;
    for (let i = 0; i < frames; i += 1) {
      if (signal.aborted) break;
      const seq = seqAtStart + i + 1;
      const mediaOffsetSeconds = (seq - 1) / request.frameRate;
      await onFrame({
        seq,
        at: new Date(Date.parse(FOOTAGE_START) + mediaOffsetSeconds * 1000),
        /* ⚠️ Content varies with seq, so a reordering shows up as different bytes, not just order. */
        data: new Uint8Array([seq & 0xff, (seq >> 8) & 0xff]),
        provenance: {
          sourceKind: 'stored-media',
          sourceId: 'analyses/ana_1/source.mp4',
          analysisId: 'ana_1',
          sessionId: 'ases_1',
          chunkId: `ases_1#${String(chunkIndex)}`,
          chunkIndex,
          mediaOffsetSeconds,
          ptsSeconds: mediaOffsetSeconds - request.fromOffsetSeconds,
          frameRate: request.frameRate,
          decoder: 'deterministic/1.0.0',
        },
      });
      emitted += 1;
    }
    const reached =
      emitted === 0 ? request.fromOffsetSeconds : (seqAtStart + emitted) / request.frameRate;
    return { framesEmitted: emitted, reachedOffsetSeconds: reached, reachedEnd: emitted < frames };
  }

  async close(): Promise<void> {
    /* nothing held */
  }
}

/** Records exactly what the runtime would have been asked to look at, in the order it was asked. */
class RecordingSink implements FrameSink {
  readonly seen: Array<{
    cameraId: string;
    seq: number;
    at: string;
    offset: number | undefined;
    pts: number | null | undefined;
    chunkId: string | undefined;
    sessionId: string | undefined;
    bytes: string;
  }> = [];

  push(): void {
    throw new Error('an offline session must never reach the lossy push path');
  }

  async deliver(
    _tenantId: string,
    cameraId: string,
    frame: Frame,
    _signal: AbortSignal,
  ): Promise<FrameDelivery> {
    this.seen.push({
      cameraId,
      seq: frame.seq,
      at: frame.at.toISOString(),
      offset: frame.provenance?.mediaOffsetSeconds,
      pts: frame.provenance?.ptsSeconds,
      chunkId: frame.provenance?.chunkId,
      sessionId: frame.provenance?.sessionId,
      bytes: Buffer.from(frame.data ?? new Uint8Array()).toString('hex'),
    });
    return { outcome: 'delivered', detections: frame.seq % 7 === 0 ? 1 : 0 };
  }
}

/**
 * A sleeper that returns instantly while **advancing a virtual clock** — hours in milliseconds.
 *
 * ⛔ Advancing the clock is the whole point, and the first version of this did not. Returning
 * instantly while the pacer read the real `Date.now()` meant footage time ran and wall time stood
 * still, so every wait grew by one frame interval and 300 s of footage reported 25 hours of sleep.
 * A harness that does not move time cannot measure something that waits for it.
 */
class VirtualSleeper implements Sleeper {
  totalMs = 0;
  nowMs = 1_000_000;
  async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    this.totalMs += ms;
    this.nowMs += ms;
  }
}

async function seed(
  store: InMemoryAnalysisStore,
  durationSeconds: number,
  speed: number | null,
): Promise<AnalysisSessionDoc> {
  const analysis: AnalysisDoc = {
    _id: 'ana_1',
    tenantId: 'tnt_a',
    cameraId: 'cam_1',
    sourceKind: 'upload',
    state: 'ready',
    asset: {
      key: 'analyses/ana_1/source.mp4',
      originalName: 'front-door.mp4',
      bytes: 1024,
      contentType: 'video/mp4',
      container: 'mp4',
      codec: 'h264',
      width: 1920,
      height: 1080,
      sourceFrameRate: 25,
      durationSeconds,
    },
    footageStartedAt: FOOTAGE_START,
    footageStartSource: 'operator',
    sessionCount: 1,
    createdBy: 'usr_1',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  };
  await store.putAnalysis(scope, analysis);
  const session = newSession({
    id: 'ases_1',
    tenantId: 'tnt_a',
    analysisId: 'ana_1',
    cameraId: 'cam_1',
    sequence: 1,
    analysisFrameRate: 2,
    speed,
    capabilityId: 'perception.person-detection',
    ruleSet: [],
    findings: [],
    requestedBy: 'usr_1',
    now: T0,
    durationSeconds,
  });
  await store.putSession(scope, session);
  return session;
}

/** Run one whole analysis at `speed` and report everything the runtime would have seen. */
async function run(speed: number | null, durationSeconds = 300) {
  const store = new InMemoryAnalysisStore();
  const session = await seed(store, durationSeconds, speed);
  const sink = new RecordingSink();
  const sleeper = new VirtualSleeper();
  const worker = new AnalysisWorker({
    store,
    sources: { async open() {
      return new DeterministicSource(durationSeconds);
    } },
    sink,
    clock: { now: () => T0 },
    sleeper,
    monotonicNow: () => sleeper.nowMs,
    workerId: `worker-${String(speed ?? 'max')}`,
  });
  await worker.claim(scope, session);
  const outcome = await worker.runSession(scope, 'ases_1');
  const after = await store.getSession(scope, 'ases_1');
  return { outcome, sink, sleeper, after };
}

describe('⭐ replay-speed parity — the same footage at any speed is the same analysis', () => {
  it('delivers a byte-for-byte identical frame stream at 1×, at 8× and unpaced', async () => {
    const atRealtime = await run(1);
    const at8x = await run(8);
    const unpaced = await run(null);

    /*
     * ⛔ **Deep equality over the whole stream, not a count and a spot check.**
     *
     * A count would pass while every timestamp was an hour out; a spot check would pass while frame
     * 431 was delivered twice. This compares sequence, event time, media offset, PTS, chunk, session
     * and the frame's bytes, for all 600 frames, in order — which is the entirety of what media
     * hands the runtime.
     */
    expect(at8x.sink.seen).toEqual(atRealtime.sink.seen);
    expect(unpaced.sink.seen).toEqual(atRealtime.sink.seen);

    /* And it is a real stream, not an empty one that trivially matches itself. */
    expect(atRealtime.sink.seen).toHaveLength(600);
  });

  it('produces the same session outcome and the same counts at every speed', async () => {
    const atRealtime = await run(1);
    const at8x = await run(8);
    const unpaced = await run(null);

    for (const result of [at8x, unpaced]) {
      expect(result.outcome.state).toBe(atRealtime.outcome.state);
      expect(result.outcome.framesProcessed).toBe(atRealtime.outcome.framesProcessed);
      expect(result.outcome.chunksCompleted).toBe(atRealtime.outcome.chunksCompleted);
      /* ⭐ Detections, analysed frames and dropped frames — the numbers a report quotes. */
      expect(result.after?.counts).toEqual(atRealtime.after?.counts);
    }
    expect(atRealtime.after?.counts.detections).toBe(85); // every 7th of 600 frames
    expect(atRealtime.after?.counts.framesAnalysed).toBe(600);
    expect(atRealtime.after?.counts.framesDropped).toBe(0);
  });

  /**
   * ⭐ **Event time comes from the footage, and this is the assertion that proves it.**
   *
   * Every frame's `at` is `footageStartedAt + (seq − 1)/rate`, six weeks before the analysis ran.
   * Nothing anywhere reads the host's clock to decide when something happened — which is why the
   * events service's dedup window, `window` and `dwell` all behave identically at any speed.
   */
  it('timestamps every frame in footage time, never in wall-clock time', async () => {
    const { sink } = await run(8);

    expect(sink.seen[0]?.at).toBe('2026-02-14T18:30:00.000Z');
    expect(sink.seen[0]?.offset).toBe(0);
    /* Frame 600 of 600 at 2 fps → offset 299.5 s. */
    expect(sink.seen[599]?.at).toBe('2026-02-14T18:34:59.500Z');
    expect(sink.seen[599]?.offset).toBe(299.5);

    /* ⚠️ Strictly increasing, with no repeats — the property the runtime's tracker depends on. */
    for (let i = 1; i < sink.seen.length; i += 1) {
      const prev = sink.seen[i - 1];
      const cur = sink.seen[i];
      expect(cur?.seq).toBe((prev?.seq ?? 0) + 1);
      expect(Date.parse(cur?.at ?? '')).toBeGreaterThan(Date.parse(prev?.at ?? ''));
    }
  });

  /**
   * ⚠️ The chunk seam is where an off-by-one would hide: chunk 2's first frame must be the one
   * *after* chunk 1's last, with no repeat and no gap. A repeat would show the runtime the same
   * moment twice and double a count; a gap would lose half a second of a customer's footage.
   */
  it('joins chunks with no repeated and no skipped frame', async () => {
    const { sink } = await run(null);
    const offsets = sink.seen.map((f) => f.offset);
    expect(new Set(offsets).size).toBe(offsets.length);

    const chunkIds = [...new Set(sink.seen.map((f) => f.chunkId))];
    expect(chunkIds).toEqual(['ases_1#0', 'ases_1#1', 'ases_1#2']);

    const lastOfChunk0 = sink.seen.filter((f) => f.chunkId === 'ases_1#0').at(-1);
    const firstOfChunk1 = sink.seen.find((f) => f.chunkId === 'ases_1#1');
    expect(firstOfChunk1?.seq).toBe((lastOfChunk0?.seq ?? 0) + 1);
    expect(firstOfChunk1?.offset).toBe((lastOfChunk0?.offset ?? 0) + 0.5);
  });

  /**
   * ⭐ **Speed changes only the waiting**, which is the other half of the claim: not merely that the
   * results match, but that the pacing was actually doing something at 1× and rather less at 8×. Two
   * runs that both ran unpaced would match trivially and prove nothing.
   */
  it('spends real time in proportion to the requested speed, and none when unpaced', async () => {
    const atRealtime = await run(1);
    const at8x = await run(8);
    const unpaced = await run(null);

    /* 300 s of footage: ~300 s of waiting at 1×, ~37.5 s at 8×, none unpaced. */
    expect(atRealtime.sleeper.totalMs).toBeGreaterThan(290_000);
    expect(atRealtime.sleeper.totalMs).toBeLessThan(300_000);
    expect(at8x.sleeper.totalMs).toBeGreaterThan(36_000);
    expect(at8x.sleeper.totalMs).toBeLessThan(38_000);
    expect(unpaced.sleeper.totalMs).toBe(0);

    /* ⭐ …and it did NOT change the answer. */
    expect(at8x.sink.seen).toEqual(atRealtime.sink.seen);
  });
});

describe('Pacer', () => {
  const frameAt = (offset: number): Frame => ({
    seq: offset * 2 + 1,
    at: new Date(Date.parse(FOOTAGE_START) + offset * 1000),
    provenance: {
      sourceKind: 'stored-media',
      sourceId: 'k',
      mediaOffsetSeconds: offset,
      ptsSeconds: offset,
      frameRate: 2,
      decoder: 'test',
    },
  });

  it('does nothing at all when unpaced', async () => {
    const sleeper = new VirtualSleeper();
    const pacer = new Pacer({ speed: null, now: () => 0, sleeper });
    for (const o of [0, 0.5, 1]) await pacer.wait(frameAt(o), new AbortController().signal);
    expect(sleeper.totalMs).toBe(0);
    expect(pacer.report().requestedSpeed).toBeNull();
  });

  /**
   * ⭐ **The self-correcting property, and why a fixed per-frame budget was rejected.**
   *
   * A budget of `1/(rate × speed)` per frame accumulates the runtime's own latency: at 500 ms budget
   * and 300 ms inference, every frame slips 300 ms and a 20-minute demonstration finishes 12 minutes
   * late while still claiming 1×. Pacing against the footage clock makes a slow frame cost a
   * *shorter* next wait, so the error does not accumulate.
   */
  it('absorbs a slow frame instead of accumulating the delay', async () => {
    const sleeper = new VirtualSleeper();
    let clock = 1_000_000;
    const pacer = new Pacer({ speed: 1, now: () => clock, sleeper });
    /* ⚠️ This case drives the clock by hand to model a SLOW frame — the sleeper's own advance is
     * not enough, because the delay being tested is time spent outside the sleeper. */
    const signal = new AbortController().signal;

    await pacer.wait(frameAt(0), signal); // establishes the origin; no wait
    clock += 900; // ⚠️ frame 2 took 900 ms of real time for 500 ms of footage
    await pacer.wait(frameAt(0.5), signal);
    /* Already 400 ms late, so no wait — and the lateness is recorded, not hidden. */
    expect(sleeper.totalMs).toBe(0);

    clock += 10; // frame 3 is fast
    await pacer.wait(frameAt(1.0), signal);
    /* ⭐ Due at origin+1000, now at origin+910 → waits 90 ms. A fixed budget would have waited 500. */
    expect(sleeper.totalMs).toBe(90);
    expect(pacer.report().behindMs).toBe(400);
  });

  it('never paces a frame with no provenance rather than inventing a position', async () => {
    const sleeper = new VirtualSleeper();
    const pacer = new Pacer({ speed: 1, now: () => 0, sleeper });
    await pacer.wait({ seq: 1, at: new Date() }, new AbortController().signal);
    await pacer.wait({ seq: 2, at: new Date() }, new AbortController().signal);
    expect(sleeper.totalMs).toBe(0);
  });

  it('the system sleeper returns immediately on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await systemSleeper.sleep(5_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
