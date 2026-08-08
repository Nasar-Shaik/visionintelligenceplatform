/**
 * P-9 — the run-continuity guard (`tools/validation/lib/continuity.mjs`).
 *
 * ⛔ **Regression for a false number that was one commit from publication.** The 30-minute live
 * soak of 2026-08-08 sent 7181 frames at a true, exact 4.000 fps. The host then suspended for 966
 * seconds and the run ended on wake, so the harness divided 7181 frames by 2761 seconds of wall
 * clock and wrote down **2.6 fps** — a 35 % shortfall against target that never happened, in a
 * document whose whole purpose is to be the baseline future models are compared against.
 *
 * ⚠️ Both existing guards passed while this happened. Nothing was rejected (0 of 7181) and the
 * platform's accepted count matched the sender's exactly, ruling out the duplicate sender that
 * invalidated the previous attempt. The run was wrong in a dimension neither guard measures.
 *
 * These tests hold the detector to the property that matters: **a rate derived from a span the
 * process did not run for must be refused, not reported.**
 */
import { describe, expect, it } from 'vitest';
import {
  analyseContinuity,
  describeContinuity,
  sliceUninterrupted,
} from '../../validation/lib/continuity.mjs';

/** Heartbeats on a fixed grid, the way every sampler in `tools/validation` writes them. */
const grid = (startIso: string, count: number, everyMs: number, payload: (i: number) => object = () => ({})) =>
  Array.from({ length: count }, (_, i) => ({
    at: new Date(Date.parse(startIso) + i * everyMs).toISOString(),
    ...payload(i),
  }));

describe('a run the host stayed awake for', () => {
  it('is intact, and the uninterrupted window is the whole run', () => {
    const c = analyseContinuity({ samples: grid('2026-08-08T09:00:00.000Z', 360, 5_000), intervalMs: 5_000 });

    expect(c.intact).toBe(true);
    expect(c.inconclusive).toBe(false);
    expect(c.suspensions).toEqual([]);
    expect(c.totalSeconds).toBe(1795);
    expect(c.uninterrupted.seconds).toBe(1795);
    expect(c.uninterrupted.count).toBe(360);
    expect(describeContinuity(c)).toContain('✅ continuous');
  });

  it('tolerates ordinary timer jitter — a busy event loop is not a suspension', () => {
    /*
     * Real samplers drift by tens of milliseconds and occasionally by a second or two, because the
     * sample itself does work (a `docker stats`, an HTTP probe) before the next timer is armed.
     * Deltas here run 5.0–7.0 s against a 15 s threshold.
     */
    let t = Date.parse('2026-08-08T09:00:00.000Z');
    const jittery = Array.from({ length: 100 }, (_, i) => {
      const at = new Date(t).toISOString();
      t += 5_000 + (i % 7) * 300;
      return { at };
    });

    const c = analyseContinuity({ samples: jittery, intervalMs: 5_000 });

    expect(c.intact).toBe(true);
    expect(c.suspensions).toEqual([]);
    expect(c.backwardsSteps).toEqual([]);
  });
});

describe('the 2026-08-08 soak — 966 seconds of host suspension', () => {
  /*
   * ⭐ The shape of the real run: 359 heartbeats on a 5-second grid, one 966.2-second hole, then a
   * single sample recorded after the host woke and the process exited.
   */
  const LIVE_SAMPLES = 359;
  const GAP_MS = 966_200;
  const FRAMES_SENT = 7181;
  const soak = [
    ...grid('2026-08-08T09:25:49.534Z', LIVE_SAMPLES, 5_000),
    { at: new Date(Date.parse('2026-08-08T09:25:49.534Z') + (LIVE_SAMPLES - 1) * 5_000 + GAP_MS).toISOString() },
  ];

  it('finds exactly one suspension and names its length', () => {
    const c = analyseContinuity({ samples: soak, intervalMs: 5_000 });

    expect(c.intact).toBe(false);
    expect(c.suspensions).toHaveLength(1);
    expect(c.suspensions[0]?.seconds).toBe(966.2);
    expect(c.suspendedSeconds).toBe(966.2);
  });

  it('separates wall-clock elapsed from the time the process actually ran', () => {
    const c = analyseContinuity({ samples: soak, intervalMs: 5_000 });

    expect(c.totalSeconds).toBe(2756.2);
    expect(c.uninterrupted.seconds).toBe(1790);
  });

  it('⛔ is the difference between 2.6 fps and 4.0 fps on the same 7181 frames', () => {
    const c = analyseContinuity({ samples: soak, intervalMs: 5_000 });

    /* What the harness published, dividing by a clock that ran while the process did not. */
    expect(FRAMES_SENT / c.totalSeconds).toBeCloseTo(2.6, 1);
    /* What actually happened, against a 4 fps target. */
    expect(FRAMES_SENT / c.uninterrupted.seconds).toBeCloseTo(4.0, 1);
  });

  it('refuses to bless the run, and says which figures are wrong', () => {
    const text = describeContinuity(analyseContinuity({ samples: soak, intervalMs: 5_000 }));

    expect(text).toContain('⛔ HOST SUSPENDED');
    expect(text).toContain('966.2');
    expect(text).not.toContain('✅');
  });

  it('slices the analysable window down to the samples either side of no hole', () => {
    const window = sliceUninterrupted({ samples: soak, intervalMs: 5_000 });

    expect(window).toHaveLength(LIVE_SAMPLES);
    expect(window.at(-1)?.at).toBe(
      new Date(Date.parse('2026-08-08T09:25:49.534Z') + (LIVE_SAMPLES - 1) * 5_000).toISOString(),
    );
  });
});

describe('the failure modes a long unattended run actually has', () => {
  it('keeps the longer half when the hole is in the middle', () => {
    const samples = [
      ...grid('2026-08-08T09:00:00.000Z', 20, 5_000),
      ...grid('2026-08-08T10:00:00.000Z', 200, 5_000),
    ];

    const c = analyseContinuity({ samples, intervalMs: 5_000 });

    expect(c.suspensions).toHaveLength(1);
    expect(c.uninterrupted.count).toBe(200);
    expect(c.uninterrupted.fromAt).toBe('2026-08-08T10:00:00.000Z');
  });

  it('catches a clock stepping backwards, which makes every rate look better', () => {
    /* ⚠️ NTP correcting a drifted clock shrinks elapsed time, so throughput appears to rise. */
    const samples = [
      ...grid('2026-08-08T09:00:00.000Z', 10, 5_000),
      ...grid('2026-08-08T08:58:00.000Z', 10, 5_000),
    ];

    const c = analyseContinuity({ samples, intervalMs: 5_000 });

    expect(c.backwardsSteps).toHaveLength(1);
    expect(c.backwardsSteps[0]?.seconds).toBeLessThan(0);
    expect(c.intact).toBe(false);
    expect(describeContinuity(c)).toContain('clock stepped back');
  });

  it('reports too-few-samples as inconclusive rather than intact', () => {
    /* ⭐ An absence of gaps in an absence of data is not continuity. */
    const c = analyseContinuity({ samples: [{ at: '2026-08-08T09:00:00.000Z' }], intervalMs: 5_000 });

    expect(c.inconclusive).toBe(true);
    expect(c.intact).toBe(false);
    expect(describeContinuity(c)).toContain('CONTINUITY UNKNOWN');
  });

  it('counts samples the sampler failed to date instead of silently dropping them', () => {
    const samples = [...grid('2026-08-08T09:00:00.000Z', 5, 5_000), { queueDepth: 0 }, { at: 'not-a-date' }];

    const c = analyseContinuity({ samples, intervalMs: 5_000 });

    expect(c.undatedSamples).toBe(2);
    expect(c.sampleCount).toBe(5);
  });

  it('rejects a nonsensical sampling interval rather than inventing a threshold', () => {
    expect(() => analyseContinuity({ samples: [], intervalMs: 0 })).toThrow(/positive number/);
  });
});
