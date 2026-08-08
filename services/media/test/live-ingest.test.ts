/**
 * Live frame ingest (P-9).
 *
 * ⛔ **The assertion this file exists for is the first one**: an ingested frame reaches the *same*
 * `FrameSink` a decoded frame does. That is the whole claim of the milestone — one live pipeline,
 * many sources — and it is the kind of claim that stays true only while something checks it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Frame, FrameSink } from '../src/application/ports.js';
import { LiveIngest } from '../src/application/live-ingest.js';

/** A sink that records exactly what the live path would have been handed. */
function fakeSink() {
  const pushed: { tenantId: string; cameraId: string; frame: Frame }[] = [];
  const sink: FrameSink = {
    push: (tenantId, cameraId, frame) => void pushed.push({ tenantId, cameraId, frame }),
  };
  return { sink, pushed };
}

const jpeg = (n = 8) => new Uint8Array(Array.from({ length: n }, (_, i) => i));

function build(nowMs = Date.parse('2026-08-08T09:00:00.000Z')) {
  const clock = { ms: nowMs };
  const { sink, pushed } = fakeSink();
  const ingest = new LiveIngest({
    sink,
    now: () => new Date(clock.ms),
    newId: () => 'lis_test',
  });
  return { ingest, pushed, clock };
}

describe('the ingested frame reaches the live sink', () => {
  it('⭐ pushes to the same FrameSink the decoder pushes to', () => {
    const { ingest, pushed } = build();
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.frame('t-1', 'cam-1', jpeg());

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ tenantId: 't-1', cameraId: 'cam-1' });
    expect(pushed[0]?.frame.data).toBeInstanceOf(Uint8Array);
  });

  /**
   * ⚠️ The sequence is what the assignment gate's session epoch and the publisher's ordering gate
   * are both built on. A source that reused or reset it mid-session would look exactly like the
   * re-enabled camera that published 0 events and dropped 32 (P-8 Phase 5).
   */
  it('numbers frames from 1, monotonically', () => {
    const { ingest, pushed } = build();
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    for (let i = 0; i < 3; i += 1) ingest.frame('t-1', 'cam-1', jpeg());
    expect(pushed.map((p) => p.frame.seq)).toEqual([1, 2, 3]);
  });

  it('keeps two cameras in separate sequences', () => {
    const { ingest, pushed } = build();
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.open({ tenantId: 't-1', cameraId: 'cam-2', frameRate: 4 });
    ingest.frame('t-1', 'cam-1', jpeg());
    ingest.frame('t-1', 'cam-2', jpeg());
    ingest.frame('t-1', 'cam-1', jpeg());
    expect(pushed.map((p) => `${p.cameraId}#${String(p.frame.seq)}`)).toEqual([
      'cam-1#1',
      'cam-2#1',
      'cam-1#2',
    ]);
  });

  /** ⚠️ One tenant must never be able to feed another tenant's camera by reusing a camera id. */
  it('scopes a session to its tenant', () => {
    const { ingest } = build();
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    expect(() => ingest.frame('t-2', 'cam-1', jpeg())).toThrow(/no live ingest session/i);
  });

  it('refuses a frame for a camera with no open session', () => {
    const { ingest } = build();
    expect(() => ingest.frame('t-1', 'cam-1', jpeg())).toThrow(/no live ingest session/i);
  });

  it('refuses an empty frame and counts it', () => {
    const { ingest } = build();
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    expect(() => ingest.frame('t-1', 'cam-1', new Uint8Array())).toThrow(/no bytes/i);
    expect(ingest.get('t-1', 'cam-1')?.framesRejected).toBe(1);
  });

  it('refuses a nonsense frame rate at open', () => {
    const { ingest } = build();
    expect(() => ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 0 })).toThrow();
    expect(() => ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 240 })).toThrow();
  });
});

/**
 * ⛔ **The clock tests. A client-supplied evidentiary time is a forgery surface, not a rounding
 * concern.** `at` becomes an event's `occurredAt`, which becomes an incident's time, which is what a
 * customer hands to an insurer. Anything holding a token could otherwise place a person somewhere at
 * a time of its choosing.
 */
describe('the client does not own the clock', () => {
  it('⛔ stamps the frame with the service clock, never the agent’s capturedAt', () => {
    const serverMs = Date.parse('2026-08-08T09:00:00.000Z');
    const { ingest, pushed } = build(serverMs);
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });

    /* An agent claiming the frame was captured an hour ago. */
    ingest.frame('t-1', 'cam-1', jpeg(), serverMs - 3_600_000);

    expect(pushed[0]?.frame.at.toISOString()).toBe('2026-08-08T09:00:00.000Z');
  });

  it('measures transport lag from capturedAt without trusting it for time', () => {
    const serverMs = Date.parse('2026-08-08T09:00:00.000Z');
    const { ingest } = build(serverMs);
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    const accepted = ingest.frame('t-1', 'cam-1', jpeg(), serverMs - 40);
    expect(accepted.arrivalLagMs).toBe(40);
    expect(accepted.at).toBe('2026-08-08T09:00:00.000Z');
  });

  /**
   * ⚠️ A client clock ahead of the server yields a negative lag, and a client clock hours behind
   * yields an absurd one. Averaging either into the reported figure would put a fabricated number in
   * the validation document — the failure [absence-hides-defects] describes.
   */
  it('ignores a lag that is negative or absurd rather than averaging it in', () => {
    const serverMs = Date.parse('2026-08-08T09:00:00.000Z');
    const { ingest } = build(serverMs);
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    expect(ingest.frame('t-1', 'cam-1', jpeg(), serverMs + 5_000).arrivalLagMs).toBeNull();
    expect(ingest.frame('t-1', 'cam-1', jpeg(), serverMs - 600_000).arrivalLagMs).toBeNull();
    expect(ingest.get('t-1', 'cam-1')?.arrivalLagMsAvg).toBeNull();
  });
});

/**
 * ⭐ An ingested stream writes no MP4 segments, so there is no recording to cut a clip from later.
 * If the frame is not kept as it arrives, a live incident has no evidence at all.
 */
describe('frames held for evidence', () => {
  it('returns the frame nearest an instant', () => {
    const t0 = Date.parse('2026-08-08T09:00:00.000Z');
    const { ingest, clock } = build(t0);
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    for (let i = 0; i < 5; i += 1) {
      clock.ms = t0 + i * 250;
      ingest.frame('t-1', 'cam-1', jpeg(i + 1));
    }
    const shot = ingest.nearestFrame('t-1', 'cam-1', t0 + 760);
    expect(shot?.seq).toBe(4);
    expect(shot?.deltaMs).toBe(10);
  });

  /**
   * ⛔ **Nothing, rather than a frame from a different moment.** Returning the closest frame at any
   * distance would let an incident be illustrated by a picture of something else — the one thing an
   * evidence path may never do.
   */
  it('⛔ returns nothing when no held frame is within tolerance', () => {
    const t0 = Date.parse('2026-08-08T09:00:00.000Z');
    const { ingest } = build(t0);
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.frame('t-1', 'cam-1', jpeg());
    expect(ingest.nearestFrame('t-1', 'cam-1', t0 + 30_000)).toBeUndefined();
  });

  /** ⚠️ Bounded. An unbounded ring is a leak whose size is set by how long a demo runs. */
  it('holds a bounded number of frames', () => {
    const t0 = Date.parse('2026-08-08T09:00:00.000Z');
    const { ingest, clock } = build(t0);
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    for (let i = 0; i < 200; i += 1) {
      clock.ms = t0 + i * 250;
      ingest.frame('t-1', 'cam-1', jpeg());
    }
    /* The oldest are gone: an instant from the start of the run is no longer held. */
    expect(ingest.nearestFrame('t-1', 'cam-1', t0)).toBeUndefined();
    expect(ingest.nearestFrame('t-1', 'cam-1', clock.ms)).toBeDefined();
  });
});

describe('session lifecycle', () => {
  it('replaces a session when an agent reclaims a camera, restarting the sequence', () => {
    const { ingest, pushed } = build();
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.frame('t-1', 'cam-1', jpeg());
    ingest.frame('t-1', 'cam-1', jpeg());
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.frame('t-1', 'cam-1', jpeg());
    expect(pushed.map((p) => p.frame.seq)).toEqual([1, 2, 1]);
  });

  /**
   * ⛔ A browser tab that is closed sends no `close`. Without reaping, the session list grows for
   * ever and every dead entry keeps its held frames alive — a leak sized by how often anyone
   * demonstrates the product.
   */
  it('⛔ reaps a session whose agent stopped sending', () => {
    const t0 = Date.parse('2026-08-08T09:00:00.000Z');
    const { ingest, clock } = build(t0);
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.frame('t-1', 'cam-1', jpeg());
    expect(ingest.list('t-1')).toHaveLength(1);

    clock.ms = t0 + 61_000;
    expect(ingest.list('t-1')).toHaveLength(0);
  });

  it('lists only the asking tenant’s sessions', () => {
    const { ingest } = build();
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.open({ tenantId: 't-2', cameraId: 'cam-9', frameRate: 4 });
    expect(ingest.list('t-1').map((s) => s.cameraId)).toEqual(['cam-1']);
  });

  it('reports what the agent said it was, for the record', () => {
    const { ingest } = build();
    const opened = ingest.open({
      tenantId: 't-1',
      cameraId: 'cam-1',
      frameRate: 4,
      width: 640,
      height: 480,
      agent: 'browser-webcam',
    });
    expect(opened).toMatchObject({ agent: 'browser-webcam', width: 640, height: 480, frameRate: 4 });
  });
});

/**
 * ⚠️ `push` is fire-and-forget by contract — it never awaits, never throws and absorbs a slow
 * runtime by dropping. Ingest must not accidentally become the thing that applies back-pressure to
 * a capture agent, or a slow runtime would stall the browser instead of dropping a frame.
 */
describe('ingest does not add back-pressure', () => {
  it('returns even when the sink is slow, and never awaits it', () => {
    const pushed: Frame[] = [];
    const slowSink: FrameSink = {
      push: (_t, _c, frame) => {
        pushed.push(frame);
      },
    };
    const spy = vi.spyOn(slowSink, 'push');
    const ingest = new LiveIngest({ sink: slowSink });
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    const accepted = ingest.frame('t-1', 'cam-1', jpeg());
    expect(spy).toHaveBeenCalledOnce();
    expect(accepted.seq).toBe(1);
  });
});

/**
 * ⛔ **Found by using it, not by reading it.** The first `close()` deleted the session outright and
 * took the frame ring with it. An agent stops capturing and closes *microseconds* after its last
 * frame, while the incident raised from that frame is created asynchronously afterwards — so the
 * evidence for the last thing the camera saw was reliably the evidence that no longer existed.
 */
describe('a closed session keeps its evidence', () => {
  it('⛔ still serves held frames after close', () => {
    const t0 = Date.parse('2026-08-08T09:00:00.000Z');
    const { ingest, clock } = build(t0);
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    clock.ms = t0 + 250;
    ingest.frame('t-1', 'cam-1', jpeg());
    ingest.close('t-1', 'cam-1');

    const shot = ingest.nearestFrame('t-1', 'cam-1', t0 + 250);
    expect(shot?.seq).toBe(1);
  });

  it('refuses new frames once closed', () => {
    const { ingest } = build();
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.close('t-1', 'cam-1');
    expect(() => ingest.frame('t-1', 'cam-1', jpeg())).toThrow(/closed/i);
  });

  /** ⚠️ And it must not be advertised as a live session while it lingers. */
  it('is absent from the live session list', () => {
    const { ingest } = build();
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.close('t-1', 'cam-1');
    expect(ingest.list('t-1')).toHaveLength(0);
  });

  /** ⚠️ Lingering is bounded by the same reaper, so it cannot become a leak. */
  it('is reaped like any other idle session', () => {
    const t0 = Date.parse('2026-08-08T09:00:00.000Z');
    const { ingest, clock } = build(t0);
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.frame('t-1', 'cam-1', jpeg());
    ingest.close('t-1', 'cam-1');
    clock.ms = t0 + 61_000;
    ingest.reapIdle();
    expect(ingest.nearestFrame('t-1', 'cam-1', t0)).toBeUndefined();
  });

  /** ⭐ A new session on the same camera replaces the closed one and starts clean. */
  it('is replaced by a fresh open', () => {
    const { ingest } = build();
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    ingest.close('t-1', 'cam-1');
    ingest.open({ tenantId: 't-1', cameraId: 'cam-1', frameRate: 4 });
    expect(() => ingest.frame('t-1', 'cam-1', jpeg())).not.toThrow();
    expect(ingest.list('t-1')).toHaveLength(1);
  });
});
