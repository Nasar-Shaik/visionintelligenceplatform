/**
 * ⭐ **One delivery path, two admission policies** (P-8 Phase 8, slice 3).
 *
 * These tests exist to hold one claim: `deliver` and `push` reach the runtime through the *same*
 * request, the same assignment gate and the same publisher, and differ only in what happens when the
 * runtime cannot keep up. A second request builder for offline frames would be invisible in review
 * and would break offline/live parity without failing anything — so the shared-path property is
 * asserted directly, on the wire format.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpFrameSink } from '../src/adapters/http-frame-sink.js';
import type { Frame } from '../src/application/ports.js';

const KEY = 'internal-key';
const never = new AbortController().signal;

interface Captured {
  url: string;
  body: {
    capabilityId: string;
    context: { tenantId: string };
    frame: { cameraId: string; seq: number; capturedAt: string; source: string; correlationId?: string };
    imageBase64: string;
  };
}

let captured: Captured[] = [];

function stubRuntime(
  reply: (n: number) => { status: number; body: unknown } = () => ({
    status: 200,
    body: {
      data: {
        detections: [{ label: 'person', confidence: 0.9, bbox: [0, 0, 1, 1] }],
        runtimeVersion: '1.4.2',
        executionProvider: 'CPUExecutionProvider',
        model: { id: 'yolov8n-1.0.0' },
      },
    },
  }),
): void {
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      captured.push({ url, body: JSON.parse(init.body) as Captured['body'] });
      const { status, body } = reply(n++);
      return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
          return JSON.stringify(body);
        },
      };
    }),
  );
}

const frame = (seq: number, sessionId?: string): Frame => ({
  seq,
  at: new Date('2026-02-14T18:30:00.000Z'),
  data: new Uint8Array([1, 2, 3]),
  ...(sessionId === undefined
    ? {}
    : {
        provenance: {
          sourceKind: 'stored-media' as const,
          sourceId: 'analyses/ana_1/source.mp4',
          analysisId: 'ana_1',
          sessionId,
          mediaOffsetSeconds: (seq - 1) / 2,
          ptsSeconds: (seq - 1) / 2,
          frameRate: 2,
          decoder: 'test',
        },
      }),
});

beforeEach(() => {
  captured = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deliver — the lossless path', () => {
  it('waits for the runtime and reports what it said', async () => {
    stubRuntime();
    const sink = new HttpFrameSink({ url: 'http://rt:8085', internalKey: KEY, capabilityId: 'cap' });

    const outcome = await sink.deliver('tnt_a', 'cam_1', frame(1, 'ases_1'), never);

    expect(outcome.outcome).toBe('delivered');
    expect(outcome.detections).toBe(1);
    /* ⭐ Provenance read from the ANSWER, never from configuration — see `AnalysisProvenance`. */
    expect(outcome.runtimeVersion).toBe('1.4.2');
    expect(outcome.modelId).toBe('yolov8n-1.0.0');
    expect(outcome.executionProvider).toBe('CPUExecutionProvider');
  });

  /**
   * ⛔ **The property the whole design rests on.** A separate offline request builder would let the
   * two paths drift about what the runtime is told, and the parity run would still pass because both
   * offline runs would drift identically.
   */
  it('sends a byte-identical request to the one push sends, apart from the correlation id', async () => {
    stubRuntime();
    const sink = new HttpFrameSink({ url: 'http://rt:8085', internalKey: KEY, capabilityId: 'cap' });

    sink.push('tnt_a', 'cam_1', frame(1));
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    await sink.deliver('tnt_a', 'cam_1', frame(1), never);
    expect(captured).toHaveLength(2);

    expect(captured[1]?.url).toBe(captured[0]?.url);
    expect(captured[1]?.body).toEqual(captured[0]?.body);
  });

  /**
   * ⭐ **The session's correlation key — the one channel the frozen runtime echoes.**
   *
   * `AI Runtime v1.0` is closed, so nothing can be added to the frame it accepts. It already carries
   * `frame.correlationId` through to `DetectionResult.correlationId`, which `services/events` puts
   * on `EventEnvelope.correlationId` — indexed and queryable. Every event an offline session
   * produces is therefore findable by session id, through contracts that already exist.
   */
  it('carries the session id as the correlation id when the frame has provenance', async () => {
    stubRuntime();
    const sink = new HttpFrameSink({ url: 'http://rt:8085', internalKey: KEY, capabilityId: 'cap' });

    await sink.deliver('tnt_a', 'cam_1', frame(1, 'ases_7'), never);

    expect(captured[0]?.body.frame.correlationId).toBe('ases_7');
  });

  /**
   * ⚠️ **Absent for a live frame, and that is what keeps live behaviour byte-identical.** The event
   * publisher stamps `tenant:camera:seq` when a result carries none — frame grain, right for a
   * camera that never ends. Sending a correlation id here would silently change every live trace.
   */
  it('sends no correlation id for a frame with no provenance', async () => {
    stubRuntime();
    const sink = new HttpFrameSink({ url: 'http://rt:8085', internalKey: KEY, capabilityId: 'cap' });

    await sink.deliver('tnt_a', 'cam_1', frame(1), never);

    expect(captured[0]?.body.frame).not.toHaveProperty('correlationId');
  });

  /**
   * ⭐ **Strict ordering, which is what makes the analysis reproducible.**
   *
   * The runtime's tracker *skips* a frame older than the last one it saw. The live path keeps four
   * requests in flight, so under concurrency which frames get skipped depends on scheduling — and
   * two runs of one file would disagree. Awaiting each frame is the fix.
   */
  it('never has two frames in flight', async () => {
    let inflight = 0;
    let maxInflight = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 1));
        inflight -= 1;
        return { ok: true, status: 200, async text() { return '{"data":{"detections":[]}}'; } };
      }),
    );
    const sink = new HttpFrameSink({ url: 'http://rt:8085', internalKey: KEY, capabilityId: 'cap' });

    for (let seq = 1; seq <= 12; seq += 1) {
      await sink.deliver('tnt_a', 'cam_1', frame(seq, 'ases_1'), never);
    }

    expect(maxInflight).toBe(1);
  });

  /**
   * ⛔ **Nothing is dropped.** Twenty frames delivered in a row all reach the runtime, where `push`
   * with a queue depth of 2 would have shed most of them. This is the difference between an analysis
   * and an analysis with silent holes in it.
   */
  it('drops nothing, where push would have shed most of the frames', async () => {
    stubRuntime();
    const sink = new HttpFrameSink({
      url: 'http://rt:8085',
      internalKey: KEY,
      capabilityId: 'cap',
      queuePerCamera: 2,
    });

    for (let seq = 1; seq <= 20; seq += 1) {
      await sink.deliver('tnt_a', 'cam_1', frame(seq, 'ases_1'), never);
    }

    expect(captured).toHaveLength(20);
    expect(captured.map((c) => c.body.frame.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(sink.stats().droppedQueueFull).toBe(0);
  });

  it('reports a refusal with its reason rather than throwing', async () => {
    stubRuntime(() => ({ status: 503, body: { error: 'model loading' } }));
    const sink = new HttpFrameSink({ url: 'http://rt:8085', internalKey: KEY, capabilityId: 'cap' });

    const outcome = await sink.deliver('tnt_a', 'cam_1', frame(1, 'ases_1'), never);

    expect(outcome.outcome).toBe('failed');
    expect(outcome.reason).toContain('503');
    expect(outcome.detections).toBe(0);
  });

  /** ⚠️ A frame with no pixels is never sent, and says so — see the no-image counter's own note. */
  it('refuses a frame with no pixels instead of posting an empty image', async () => {
    stubRuntime();
    const sink = new HttpFrameSink({ url: 'http://rt:8085', internalKey: KEY, capabilityId: 'cap' });

    const outcome = await sink.deliver(
      'tnt_a',
      'cam_1',
      { seq: 1, at: new Date(), data: new Uint8Array() },
      never,
    );

    expect(outcome.outcome).toBe('no-image');
    expect(captured).toHaveLength(0);
  });

  /** ⚠️ An already-cancelled session must not send one more frame at the runtime. */
  it('sends nothing once the session is cancelled', async () => {
    stubRuntime();
    const sink = new HttpFrameSink({ url: 'http://rt:8085', internalKey: KEY, capabilityId: 'cap' });
    const controller = new AbortController();
    controller.abort();

    const outcome = await sink.deliver('tnt_a', 'cam_1', frame(1, 'ases_1'), controller.signal);

    expect(outcome.outcome).toBe('failed');
    expect(captured).toHaveLength(0);
  });

  /**
   * ⭐ **A delivered frame with no detections is not a failure.** `0` here is a real answer — the
   * frame was analysed and nothing was in it — and conflating it with "not analysed" would make an
   * empty car park indistinguishable from a runtime outage.
   */
  it('separates "analysed, saw nothing" from "not analysed"', async () => {
    stubRuntime(() => ({ status: 200, body: { data: { detections: [] } } }));
    const sink = new HttpFrameSink({ url: 'http://rt:8085', internalKey: KEY, capabilityId: 'cap' });

    const outcome = await sink.deliver('tnt_a', 'cam_1', frame(1, 'ases_1'), never);

    expect(outcome.outcome).toBe('delivered');
    expect(outcome.detections).toBe(0);
  });
});

describe('the assignment gate governs offline analysis too', () => {
  /**
   * ⭐ **L-54, answered.** A recording pushed through a camera whose AI is switched off must produce
   * nothing *loudly*. The alternative is an investigation that quietly analyses footage the operator
   * believes is excluded — and reports it as a completed analysis that found nothing.
   */
  it('refuses a frame for an unassigned camera, and names why', async () => {
    stubRuntime();
    const sink = new HttpFrameSink({
      url: 'http://rt:8085',
      internalKey: KEY,
      capabilityId: 'cap',
      gate: {
        decide: () => ({ deliver: false as const, reason: 'unassigned' as const }),
        zonesByCamera: () => [],
        delivered: () => {},
        failed: () => {},
      } as never,
    });

    const outcome = await sink.deliver('tnt_a', 'cam_1', frame(1, 'ases_1'), never);

    expect(outcome.outcome).toBe('skipped-unassigned');
    expect(outcome.reason).toContain('no AI processing assignment');
    expect(captured).toHaveLength(0);
    /* ⚠️ Its own counter, not folded into a drop — policy and symptom must stay distinguishable. */
    expect(sink.stats().skippedUnassigned).toBe(1);
    expect(sink.stats().droppedQueueFull).toBe(0);
  });

  it('distinguishes a paused camera from an unassigned one', async () => {
    stubRuntime();
    const sink = new HttpFrameSink({
      url: 'http://rt:8085',
      internalKey: KEY,
      capabilityId: 'cap',
      gate: {
        decide: () => ({ deliver: false as const, reason: 'held' as const }),
        zonesByCamera: () => [],
        delivered: () => {},
        failed: () => {},
      } as never,
    });

    const outcome = await sink.deliver('tnt_a', 'cam_1', frame(1, 'ases_1'), never);

    expect(outcome.outcome).toBe('skipped-held');
    expect(outcome.reason).toContain('paused');
    expect(sink.stats().skippedHeld).toBe(1);
  });
});
