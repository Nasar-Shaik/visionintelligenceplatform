/**
 * Unit tests for the browser half of the live capture path (P-9).
 *
 * ⭐ These drive the loop with fake capture and upload functions and a fake clock, so every one of
 * them runs in jsdom with no camera, no network and no deployment. That is the point of separating
 * the logic from the component: the decisions that can send the wrong frame or lie in a statistic
 * are testable on every commit, not only on a laptop with a webcam attached.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  LiveCaptureLoop,
  StageTimer,
  bytesToBase64,
  describeCameraError,
  estimateClockOffset,
  fitCapture,
  percentile,
  type CapturedFrame,
  type FrameAttempt,
} from './capture';

const frame = (over: Partial<CapturedFrame> = {}): CapturedFrame => ({
  image: 'aGk=',
  bytes: 1_024,
  captureMs: 2,
  encodeMs: 8,
  capturedAtMs: 1_000,
  ...over,
});

describe('StageTimer', () => {
  it('reports null before anything is measured, never a zeroed record', () => {
    /*
     * ⚠️ The single most important assertion in this file. A stage that has measured nothing and a
     * stage that measured 0 ms render identically once they reach a document, and this milestone's
     * entire output is latency numbers. ADR-0039.
     */
    expect(new StageTimer().stats()).toBeNull();
  });

  it('computes min, avg, p95 and max over the samples it holds', () => {
    const t = new StageTimer();
    for (const ms of [10, 20, 30, 40, 50]) t.add(ms);
    expect(t.stats()).toEqual({ count: 5, min: 10, avg: 30, p95: 50, max: 50 });
  });

  it('ignores negative and non-finite samples rather than poisoning the average', () => {
    const t = new StageTimer();
    t.add(10);
    t.add(-5);
    t.add(Number.NaN);
    t.add(Number.POSITIVE_INFINITY);
    expect(t.stats()?.count).toBe(1);
    expect(t.stats()?.avg).toBe(10);
  });

  it('is bounded — an all-night capture cannot grow the sample array without limit', () => {
    const t = new StageTimer(50);
    for (let i = 0; i < 500; i += 1) t.add(i);
    expect(t.count).toBe(50);
    /* The window slid: the oldest samples are gone, the newest are kept. */
    expect(t.stats()?.min).toBe(450);
    expect(t.stats()?.max).toBe(499);
  });
});

describe('percentile', () => {
  it('uses nearest rank, so every reported value is one that actually occurred', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 50)).toBe(5);
    /* Not 5.5 — an interpolated median would be a number no frame ever took. */
    expect(sorted).not.toContain(5.5);
  });

  it('collapses to max for small samples, which is why count travels with the statistic', () => {
    const small = [4, 9];
    expect(percentile(small, 95)).toBe(9);
    expect(percentile(small, 95)).toBe(Math.max(...small));
  });
});

describe('LiveCaptureLoop', () => {
  /** Drives the loop for a fixed number of ticks with a fake clock, then stops it. */
  async function drive(
    opts: {
      ticks: number;
      capture?: () => Promise<CapturedFrame | null>;
      upload?: (f: CapturedFrame) => Promise<{ ok: boolean; seq?: number; arrivalLagMs?: number | null }>;
      maxInflight?: number;
    },
  ): Promise<{ loop: LiveCaptureLoop; attempts: FrameAttempt[] }> {
    let now = 0;
    let ticks = 0;
    const attempts: FrameAttempt[] = [];
    const loop = new LiveCaptureLoop({
      fps: 4,
      ...(opts.maxInflight === undefined ? {} : { maxInflight: opts.maxInflight }),
      capture: opts.capture ?? (() => Promise.resolve(frame())),
      upload: opts.upload ?? (() => Promise.resolve({ ok: true, seq: 1, arrivalLagMs: 12 })),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        ticks += 1;
        if (ticks >= opts.ticks) loop.stop();
        /* Yield so any in-flight upload promise settles before the next tick reads `inflight`. */
        await Promise.resolve();
        await Promise.resolve();
      },
      onAttempt: (a) => attempts.push(a),
    });
    await loop.run();
    /* Let the last in-flight upload settle before the caller reads counters. */
    await new Promise((r) => setTimeout(r, 0));
    return { loop, attempts };
  }

  it('records each browser stage separately, so a slow encode is not read as a slow network', async () => {
    const { loop } = await drive({ ticks: 4 });
    expect(loop.stages.capture.stats()?.avg).toBe(2);
    expect(loop.stages.encode.stats()?.avg).toBe(8);
    /* Transport is the SERVICE's measurement, kept apart from our own round trip. */
    expect(loop.stages.transport.stats()?.avg).toBe(12);
  });

  it('counts a rejected frame apart from a failed one', async () => {
    const { loop } = await drive({
      ticks: 3,
      upload: () => Promise.resolve({ ok: false }),
    });
    expect(loop.counters.rejected).toBeGreaterThan(0);
    expect(loop.counters.failed).toBe(0);
  });

  it('counts a thrown upload as failed and keeps running', async () => {
    const { loop } = await drive({
      ticks: 3,
      upload: () => Promise.reject(new Error('network down')),
    });
    expect(loop.counters.failed).toBeGreaterThan(0);
    expect(loop.counters.accepted).toBe(0);
    /* ⚠️ The loop survived: a transient network failure must not end a validation run. */
    expect(loop.counters.ticks).toBeGreaterThanOrEqual(3);
  });

  it('reports no-frame separately from a failure — a camera that has not started is not an error', async () => {
    const { loop, attempts } = await drive({ ticks: 3, capture: () => Promise.resolve(null) });
    expect(loop.counters.noFrame).toBeGreaterThan(0);
    expect(loop.counters.failed).toBe(0);
    expect(attempts.some((a) => a.outcome === 'no-frame')).toBe(true);
  });

  it('⛔ DROPS rather than queues when an upload is still in flight', async () => {
    /*
     * This is the parity assertion. `FrameSink.push()` drops the oldest and keeps the freshest; a
     * browser that queued behind a slow upload would deliver frames stamped — by the service clock —
     * at a time when they already describe a stale scene, and every counter would look healthy.
     */
    let release: (() => void) | undefined;
    const stuck = new Promise<void>((r) => {
      release = r;
    });
    const { loop, attempts } = await drive({
      ticks: 5,
      upload: async () => {
        await stuck;
        return { ok: true, seq: 1 };
      },
    });
    release?.();
    expect(loop.counters.skippedBusy).toBeGreaterThan(0);
    expect(attempts.filter((a) => a.outcome === 'skipped-busy').length).toBeGreaterThan(0);
    /* Nothing was buffered: skipped frames carry no timings, because they were never captured. */
    for (const a of attempts.filter((x) => x.outcome === 'skipped-busy')) {
      expect(a.captureMs).toBeNull();
      expect(a.bytes).toBeNull();
    }
  });

  it('honours maxInflight above 1, which is how back-pressure is deliberately provoked', async () => {
    let release: (() => void) | undefined;
    const stuck = new Promise<void>((r) => {
      release = r;
    });
    const { loop } = await drive({
      ticks: 4,
      maxInflight: 3,
      upload: async () => {
        await stuck;
        return { ok: true };
      },
    });
    release?.();
    /* With three permitted in flight, the first three ticks all captured; only later ones skipped. */
    expect(loop.counters.skippedBusy).toBeLessThan(4);
  });

  it('anchors the cadence to the start time so a late tick does not shift every later one', async () => {
    /*
     * ⚠️ Regression guard for accumulating drift. With `setTimeout(interval)` each tick's delay is
     * added to the previous tick's overrun; over ten minutes at 4 fps that reads as 3.9 fps for
     * reasons that have nothing to do with the platform.
     */
    let now = 0;
    const deadlines: number[] = [];
    const loop = new LiveCaptureLoop({
      fps: 4,
      capture: () => Promise.resolve(frame()),
      upload: () => Promise.resolve({ ok: true }),
      now: () => now,
      sleep: async (ms) => {
        deadlines.push(now + ms);
        /* Simulate a tick that ran 60 ms late — far longer than the 250 ms budget can absorb once. */
        now += ms + 60;
        if (deadlines.length >= 4) loop.stop();
        await Promise.resolve();
      },
      onAttempt: () => undefined,
    });
    await loop.run();
    /* Every deadline is an exact multiple of the interval from the start, despite the overruns. */
    expect(deadlines).toEqual([250, 500, 750, 1000]);
  });

  it('reports achieved fps as null before the first accepted frame, never 0', () => {
    const loop = new LiveCaptureLoop({
      fps: 4,
      capture: () => Promise.resolve(null),
      upload: () => Promise.resolve({ ok: true }),
    });
    expect(loop.achievedFps()).toBeNull();
  });

  it('does not restart if run() is called while already running', async () => {
    const capture = vi.fn(() => Promise.resolve(null));
    let now = 0;
    const loop = new LiveCaptureLoop({
      fps: 4,
      capture,
      upload: () => Promise.resolve({ ok: true }),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        loop.stop();
        await Promise.resolve();
      },
    });
    await Promise.all([loop.run(), loop.run()]);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe('estimateClockOffset', () => {
  it('separates clock skew from transport, and carries its own uncertainty', () => {
    /*
     * Client sends at 1000, receives at 1100 (100 ms round trip). The service stamped 1550 — so the
     * service clock is ~500 ms ahead of the browser's, known to within ±50 ms.
     */
    const est = estimateClockOffset(1_000, 1_100, 1_550);
    expect(est.offsetMs).toBe(500);
    expect(est.uncertaintyMs).toBe(50);
    expect(est.roundTripMs).toBe(100);
  });

  it('reports a negative offset when the browser clock runs ahead', () => {
    /*
     * ⛔ This is the case that silently breaks the transport figure: with the browser ahead, the
     * service computes a negative lag and refuses to believe it, so the stage measures nothing at
     * all and the report shows a clean, empty column rather than a skew warning.
     */
    expect(estimateClockOffset(1_000, 1_020, 700).offsetMs).toBe(-310);
  });
});

describe('fitCapture', () => {
  it('preserves the aspect ratio rather than fitting a fixed box', () => {
    const fit = fitCapture(1_920, 1_080, 640);
    expect(fit.width).toBe(640);
    expect(fit.height).toBe(360);
    expect(fit.width / fit.height).toBeCloseTo(1_920 / 1_080, 2);
  });

  it('handles portrait by scaling the longest edge, not the width', () => {
    const fit = fitCapture(1_080, 1_920, 640);
    expect(fit.height).toBe(640);
    expect(fit.width).toBe(360);
  });

  it('never upscales — a 320-wide sensor is not improved by encoding it at 640', () => {
    const fit = fitCapture(320, 240, 640);
    expect(fit).toEqual({ width: 320, height: 240, scale: 1 });
  });

  it('returns a zero size for a source that has not produced dimensions yet', () => {
    expect(fitCapture(0, 0, 640).width).toBe(0);
  });
});

describe('bytesToBase64', () => {
  it('round-trips bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([...bytes]);
  });

  it('⛔ survives a payload larger than the engine argument limit', () => {
    /*
     * `String.fromCharCode(...bytes)` throws RangeError somewhere around 100k arguments. A 640×480
     * JPEG sits just under it; raise the resolution or the quality and capture starts failing with a
     * stack-overflow nobody would trace back to a base64 helper. 300 KB is a plausible 1080p frame.
     */
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 256;
    const encoded = bytesToBase64(big);
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(big.length);
    expect(decoded[299_999]).toBe(big[299_999]);
  });
});

describe('describeCameraError', () => {
  it('matches on the error NAME, not on the message text', () => {
    /*
     * ⚠️ Browsers reword these between versions. A recovery path keyed on message text stops working
     * silently after an update, in the direction of "unknown error" — which reads to an operator as
     * a platform fault rather than a permission they can grant.
     */
    const err = new Error('Permission dismissed by the user agent, please try again');
    err.name = 'NotAllowedError';
    expect(describeCameraError(err).code).toBe('permission-denied');
    expect(describeCameraError(err).retry).toBe(true);
  });

  it('distinguishes a busy device from a missing one', () => {
    const busy = new Error('x');
    busy.name = 'NotReadableError';
    const missing = new Error('x');
    missing.name = 'NotFoundError';
    expect(describeCameraError(busy).code).toBe('device-busy');
    expect(describeCameraError(missing).code).toBe('no-device');
  });

  it('marks an insecure context as not retryable, because pressing Start again cannot fix it', () => {
    const err = new Error('x');
    err.name = 'SecurityError';
    expect(describeCameraError(err).retry).toBe(false);
  });

  it('⛔ names an absent capture backend rather than showing the browser’s own words', () => {
    /*
     * Regression for the certification finding: `NotSupportedError` had no case, so a headless
     * Chromium's rejection rendered as **"unknown — Not supported"** — a raw browser string in front
     * of an operator, which is the one outcome this whole function exists to prevent.
     */
    const err = new Error('Not supported');
    err.name = 'NotSupportedError';
    const described = describeCameraError(err);
    expect(described.code).toBe('capture-unsupported');
    expect(described.retry).toBe(false);
    expect(described.message).not.toBe('Not supported');
  });

  it('falls back to the message for an unrecognised error rather than inventing a code', () => {
    expect(describeCameraError(new Error('something else')).message).toBe('something else');
    expect(describeCameraError('a string').code).toBe('unknown');
  });
});
