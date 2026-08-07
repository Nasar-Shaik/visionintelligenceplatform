/**
 * What a session **says about itself** afterwards (P-8 Phase 8, slice 3): counts, provenance and the
 * findings that turn "nothing was found" into either "nothing happened" or "we could not tell".
 *
 * ⭐ These are the numbers a customer's report quotes, so each one is driven from a value here rather
 * than observed in a deployment and hoped about.
 */
import { describe, expect, it } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { EMPTY_ANALYSIS_COUNTS, type AnalysisCounts } from '@vip/contracts';
import {
  AnalysisWorker,
  mergeProvenance,
  summariseRefusals,
} from '../src/application/analysis-worker.js';
import { AnalysisService } from '../src/application/analysis-service.js';
import { InMemoryAnalysisStore } from '../src/adapters/in-memory-analysis-store.js';
import type { Frame, FrameDelivery, FrameSink } from '../src/application/ports.js';
import type {
  FrameChunkResult,
  FrameRequest,
  FrameSource,
} from '../src/application/frame-source.js';
import { newSession, type AnalysisDoc } from '../src/domain/analysis.js';
import { grantLease } from '../src/domain/analysis-lease.js';

const scope = new TenantScope('tnt_a');
const T0 = new Date('2026-03-01T09:00:00.000Z');
const FOOTAGE_START = '2026-02-14T18:30:00.000Z';

class TinySource implements FrameSource {
  constructor(private readonly durationSeconds = 10) {}
  async read(
    request: FrameRequest,
    onFrame: (frame: Frame) => Promise<void>,
    signal: AbortSignal,
  ): Promise<FrameChunkResult> {
    const seqAtStart = Math.round(request.fromOffsetSeconds * request.frameRate);
    const frames = Math.round(
      Math.min(request.durationSeconds, this.durationSeconds - request.fromOffsetSeconds) *
        request.frameRate,
    );
    let emitted = 0;
    for (let i = 0; i < frames; i += 1) {
      if (signal.aborted) break;
      const seq = seqAtStart + i + 1;
      const mediaOffsetSeconds = (seq - 1) / request.frameRate;
      await onFrame({
        seq,
        at: new Date(Date.parse(FOOTAGE_START) + mediaOffsetSeconds * 1000),
        data: new Uint8Array([1]),
        provenance: {
          sourceKind: 'stored-media',
          sourceId: 'k',
          analysisId: 'ana_1',
          sessionId: 'ases_1',
          mediaOffsetSeconds,
          ptsSeconds: mediaOffsetSeconds,
          frameRate: request.frameRate,
          decoder: 'test',
        },
      });
      emitted += 1;
    }
    return {
      framesEmitted: emitted,
      reachedOffsetSeconds:
        emitted === 0 ? request.fromOffsetSeconds : (seqAtStart + emitted) / request.frameRate,
      reachedEnd: emitted < frames || request.fromOffsetSeconds + emitted / 2 >= this.durationSeconds,
    };
  }
  async close(): Promise<void> {}
}

class ScriptedSink implements FrameSink {
  count = 0;
  constructor(private readonly script: (n: number) => FrameDelivery) {}
  push(): void {
    throw new Error('push must not be reached');
  }
  async deliver(): Promise<FrameDelivery> {
    return this.script(this.count++);
  }
}

async function seed(store: InMemoryAnalysisStore, durationSeconds = 10): Promise<void> {
  const analysis: AnalysisDoc = {
    _id: 'ana_1',
    tenantId: 'tnt_a',
    cameraId: 'cam_1',
    sourceKind: 'upload',
    state: 'ready',
    asset: {
      key: 'analyses/ana_1/source.mp4',
      originalName: 'f.mp4',
      bytes: 10,
      contentType: 'video/mp4',
      container: 'mp4',
      codec: 'h264',
      width: 640,
      height: 480,
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
  await store.putSession(scope, {
    ...newSession({
      id: 'ases_1',
      tenantId: 'tnt_a',
      analysisId: 'ana_1',
      cameraId: 'cam_1',
      sequence: 1,
      analysisFrameRate: 2,
      speed: null,
      capabilityId: 'perception.person-detection',
      ruleSet: [],
      findings: [],
      requestedBy: 'usr_1',
      now: T0,
      durationSeconds,
    }),
    state: 'starting',
    lease: grantLease('worker-a', 1, T0),
  });
}

describe('a session that cannot be run losslessly is refused, not degraded', () => {
  /**
   * ⛔ **The guard that made seven existing tests fail, and rightly.**
   *
   * `push` drops the oldest frame when the runtime falls behind — correct for a live camera,
   * catastrophic for a recording. A worker that silently fell back to it would produce an analysis
   * with holes in it and report success, which is the worst available outcome: a customer would be
   * shown a confident "nothing found" for footage that was never looked at.
   */
  it('fails the session with an operator-facing reason when the sink can only push', async () => {
    const store = new InMemoryAnalysisStore();
    await seed(store);
    const worker = new AnalysisWorker({
      store,
      sources: { async open() { return new TinySource(); } },
      sink: { push: () => {} },
      clock: { now: () => T0 },
      workerId: 'worker-a',
    });

    const outcome = await worker.runSession(scope, 'ases_1');

    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toContain('no perception runtime configured');
    /* ⚠️ Not retried. Three attempts at a deployment that has no runtime is three times the wait. */
    const after = await store.getSession(scope, 'ases_1');
    expect(after?.state).toBe('failed');
    expect(after?.finishedAt).toBeDefined();
  });
});

describe('counts and provenance', () => {
  it('counts what was analysed, what was refused, and what was detected', async () => {
    const store = new InMemoryAnalysisStore();
    await seed(store, 10);
    /* Every 5th frame refused by the runtime; 20 frames in 10 s at 2 fps. */
    const sink = new ScriptedSink((n) =>
      n % 5 === 4
        ? { outcome: 'failed', detections: 0, reason: 'runtime answered 503: busy' }
        : { outcome: 'delivered', detections: n % 2, runtimeVersion: '1.4.2', modelId: 'yolov8n' },
    );
    const worker = new AnalysisWorker({
      store,
      sources: { async open() { return new TinySource(10); } },
      sink,
      clock: { now: () => T0 },
      workerId: 'worker-a',
    });

    await worker.runSession(scope, 'ases_1');
    const after = await store.getSession(scope, 'ases_1');

    expect(after?.counts.framesDecoded).toBe(20);
    expect(after?.counts.framesAnalysed).toBe(16);
    expect(after?.counts.framesDropped).toBe(4);
    /* ⚠️ The contract's invariant: decoded ≥ analysed + dropped. */
    expect(after?.counts.framesDecoded).toBeGreaterThanOrEqual(
      (after?.counts.framesAnalysed ?? 0) + (after?.counts.framesDropped ?? 0),
    );

    /* ⭐ Provenance came from what the runtime SAID, not from configuration. */
    expect(after?.provenance.runtimeVersion).toBe('1.4.2');
    expect(after?.provenance.modelId).toBe('yolov8n');
    /* …and what was configured is still there. */
    expect(after?.provenance.capabilityId).toBe('perception.person-detection');
    expect(after?.provenance.pipelineVersion).toBe('1.0.0');
  });

  /**
   * ⭐ **A refused frame becomes a finding with a denominator.**
   *
   * "412 frames were not analysed" means nothing on its own. "412 of 28 800 (1.4 %)" and
   * "412 of 412 (100 %)" are a blemish and a catastrophe, and they must not read the same.
   */
  it('summarises refusals as one finding naming a share, not one finding per frame', async () => {
    const store = new InMemoryAnalysisStore();
    await seed(store, 10);
    const sink = new ScriptedSink(() => ({
      outcome: 'skipped-unassigned',
      detections: 0,
      reason: 'camera cam_1 has no AI processing assignment, so no frame from it is analysed',
    }));
    const worker = new AnalysisWorker({
      store,
      sources: { async open() { return new TinySource(10); } },
      sink,
      clock: { now: () => T0 },
      workerId: 'worker-a',
    });

    await worker.runSession(scope, 'ases_1');
    const after = await store.getSession(scope, 'ases_1');

    const refusal = after?.findings.filter((f) => f.kind === 'assignment-missing') ?? [];
    expect(refusal).toHaveLength(1);
    expect(refusal[0]?.detail).toContain('20 of 20 decoded frames (100.0 %)');
    expect(refusal[0]?.detail).toContain('incomplete');
    /* ⛔ It still succeeded as a RUN — and says, loudly, that it examined nothing. */
    expect(after?.counts.framesAnalysed).toBe(0);
    expect(after?.counts.framesDropped).toBe(20);
  });
});

describe('summariseRefusals', () => {
  const counts = (decoded: number): AnalysisCounts => ({
    ...EMPTY_ANALYSIS_COUNTS,
    framesDecoded: decoded,
  });

  it('gives an assignment refusal its own kind, because it has its own fix', () => {
    const out = summariseRefusals(
      new Map([['camera cam_1 has no AI processing assignment', { count: 5, firstOffsetSeconds: 2 }]]),
      counts(100),
    );
    expect(out[0]?.kind).toBe('assignment-missing');
    expect(out[0]?.atOffsetSeconds).toBe(2);
    expect(out[0]?.detail).toContain('(5.0 %)');
  });

  it('treats a runtime refusal as dropped frames — an operations problem, not a config one', () => {
    const out = summariseRefusals(
      new Map([['runtime answered 503', { count: 1, firstOffsetSeconds: undefined }]]),
      counts(10),
    );
    expect(out[0]?.kind).toBe('frames-dropped');
    expect(out[0]).not.toHaveProperty('atOffsetSeconds');
  });

  /** ⚠️ Never divides by zero — a session that decoded nothing still reports honestly. */
  it('survives a session that decoded nothing', () => {
    const out = summariseRefusals(
      new Map([['it failed', { count: 1, firstOffsetSeconds: undefined }]]),
      counts(0),
    );
    expect(out[0]?.detail).toContain('(0.0 %)');
  });

  it('reports nothing when nothing was refused', () => {
    expect(summariseRefusals(new Map(), counts(100))).toEqual([]);
  });
});

describe('mergeProvenance', () => {
  const base = { capabilityId: 'cap', pipelineVersion: '1.0.0' };

  it('captures what the runtime reported', () => {
    expect(mergeProvenance(base, { runtimeVersion: '1.4.2', modelId: 'm' })).toEqual({
      ...base,
      runtimeVersion: '1.4.2',
      modelId: 'm',
    });
  });

  /**
   * ⭐ **First answer wins, and it is never overwritten.** A session resumed after a runtime upgrade
   * would otherwise record only the *second* runtime — losing precisely the fact that explains why
   * its two halves disagree.
   */
  it('never overwrites a version already recorded', () => {
    const existing = { ...base, runtimeVersion: '1.4.2' };
    expect(mergeProvenance(existing, { runtimeVersion: '2.0.0' }).runtimeVersion).toBe('1.4.2');
  });

  it('leaves a field absent rather than writing undefined into it', () => {
    expect(mergeProvenance(base, {})).toEqual(base);
    expect(mergeProvenance(base, {})).not.toHaveProperty('modelId');
  });
});

describe('read-time repair of a session whose worker vanished', () => {
  async function service(): Promise<{ store: InMemoryAnalysisStore; svc: AnalysisService }> {
    const store = new InMemoryAnalysisStore();
    await seed(store);
    const svc = new AnalysisService({
      store,
      objectStore: {} as never,
      probe: {} as never,
      cameras: { async exists() { return true; } },
      clock: { now: () => new Date(T0.getTime() + 10 * 60_000) },
      ids: { analysisId: () => 'ana_x', sessionId: () => 'ases_x' },
      capabilityId: 'cap',
      defaultFrameRate: 2,
      playbackTtlSeconds: 900,
    });
    return { store, svc };
  }

  /**
   * ⭐ A media process restarted mid-analysis leaves a session `running` with a lease nobody will
   * renew. Without this it would claim to be running for ever.
   *
   * ⚠️ Repaired at **read** time, tenant-scoped, rather than by a background sweeper — every store
   * read needs a `TenantScope`, and inventing a cross-tenant read to serve a timer would put a hole
   * in the isolation guarantee for the convenience of a loop.
   */
  it('moves a lapsed session to retrying while attempts remain', async () => {
    const { svc } = await service();
    const detail = await svc.detail(scope, 'ana_1');
    expect(detail.sessions[0]?.state).toBe('retrying');
    expect(detail.sessions[0]?.error).toContain('stopped responding');
    /* ⚠️ NOT finished — a retrying session that looked terminal would never be picked up again. */
    expect(detail.sessions[0]?.finishedAt).toBeUndefined();
  });

  /**
   * ⭐ `expired` is not `failed`. "We tried and it did not work" and "we cannot account for what
   * happened to the worker" are different answers, and only one is about the customer's recording.
   */
  it('expires a session that has lost every attempt, rather than failing it', async () => {
    const { store, svc } = await service();
    const session = await store.getSession(scope, 'ases_1');
    await store.putSession(scope, {
      ...session!,
      state: 'running',
      lease: { ...grantLease('worker-a', 3, T0), attempt: 3 },
    });

    const detail = await svc.detail(scope, 'ana_1');
    expect(detail.sessions[0]?.state).toBe('expired');
    expect(detail.sessions[0]?.error).toContain('cannot say what happened');
    expect(detail.sessions[0]?.finishedAt).toBeDefined();
  });

  /** ⚠️ A live worker's session is left completely alone. */
  it('does not touch a session whose lease is still held', async () => {
    const store = new InMemoryAnalysisStore();
    await seed(store);
    const svc = new AnalysisService({
      store,
      objectStore: {} as never,
      probe: {} as never,
      cameras: { async exists() { return true; } },
      /* Ten seconds later — well inside the 60 s lease. */
      clock: { now: () => new Date(T0.getTime() + 10_000) },
      ids: { analysisId: () => 'a', sessionId: () => 's' },
      capabilityId: 'cap',
      defaultFrameRate: 2,
      playbackTtlSeconds: 900,
    });

    const detail = await svc.detail(scope, 'ana_1');
    expect(detail.sessions[0]?.state).toBe('starting');
    expect(detail.sessions[0]?.error).toBeUndefined();
  });

  /** ⚠️ A terminal session is immutable — repair must never reopen a finished run. */
  it('leaves a terminal session untouched however old its lease is', async () => {
    const { store, svc } = await service();
    const session = await store.getSession(scope, 'ases_1');
    await store.putSession(scope, {
      ...session!,
      state: 'succeeded',
      finishedAt: T0.toISOString(),
    });

    const detail = await svc.detail(scope, 'ana_1');
    expect(detail.sessions[0]?.state).toBe('succeeded');
    expect(detail.sessions[0]?.error).toBeUndefined();
  });
});
