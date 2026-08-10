import { describe, expect, it } from 'vitest';
import { epochSecondsOf, historyPointSeconds, placeInRecording, sinceOrigin } from './footage';

/**
 * ⛔ **The tests that stop the console seeking to the wrong frame.**
 *
 * Every case below is a real payload shape this platform produces. The defect they guard is silent
 * in every one of them: a wrong `currentTime` renders a perfectly good video frame, and an operator
 * has no way to tell it is the wrong one.
 */
describe('placing a behaviour fact in the recording', () => {
  /** A 30 s recording starting at a real wall-clock instant — the offline analysis shape. */
  const wallClock = {
    startedAtSeconds: Date.parse('2026-08-05T09:00:00.000Z') / 1000,
    durationSeconds: 30,
  };

  it('subtracts the recording start from an absolute footage second', () => {
    const placed = placeInRecording(wallClock.startedAtSeconds + 12.5, wallClock);
    expect(placed.basis).toBe('footage-clock');
    expect(placed.offsetSeconds).toBeCloseTo(12.5, 6);
  });

  /**
   * ⛔ The defect this module exists for. `atSeconds` is measured from the run's first observation;
   * if nobody is in shot until 8 s in, seeking to it lands 8 s early — on a frame where the thing
   * being explained has not happened.
   */
  it('does not treat a run-relative offset as a video position', () => {
    const firstObservationAt = wallClock.startedAtSeconds + 8;
    const factAtRunOffset = 4; /* what `entry.atSeconds` would say */
    const factFootageSecond = firstObservationAt + factAtRunOffset;

    const correct = placeInRecording(factFootageSecond, wallClock);
    expect(correct.offsetSeconds).toBeCloseTo(12, 6);
    expect(correct.offsetSeconds).not.toBeCloseTo(factAtRunOffset, 6);
  });

  it('accepts a runtime that already reported seconds against the recording', () => {
    /* The batch/deterministic path stamps `12.5s`, so the footage second IS the offset. */
    const placed = placeInRecording(12.5, wallClock);
    expect(placed.basis).toBe('relative');
    expect(placed.offsetSeconds).toBeCloseTo(12.5, 6);
  });

  /**
   * ⛔ Refused, not guessed. An instant that falls in neither reading is a fact this recording
   * cannot show, and a best guess would be presented with exactly the confidence of a correct seek.
   */
  it('refuses an instant that lands in neither reading', () => {
    const placed = placeInRecording(wallClock.startedAtSeconds + 5000, wallClock);
    expect(placed.basis).toBe('unplaceable');
    expect(placed.offsetSeconds).toBeNull();
  });

  it('refuses when the analysis declared no footage start and the value is an epoch instant', () => {
    const placed = placeInRecording(1.786e9, { startedAtSeconds: null });
    expect(placed.basis).toBe('unplaceable');
    expect(placed.offsetSeconds).toBeNull();
  });

  it('uses the epoch discriminant when no duration was declared', () => {
    const clock = { startedAtSeconds: wallClock.startedAtSeconds };
    expect(placeInRecording(wallClock.startedAtSeconds + 3, clock)).toEqual({
      offsetSeconds: 3,
      basis: 'footage-clock',
    });
    expect(placeInRecording(3, clock)).toEqual({ offsetSeconds: 3, basis: 'relative' });
  });

  it('tolerates a fact a fraction past the declared duration rather than rejecting it', () => {
    /* ⚠️ The last analysed frame can sit past the duration ffprobe declared. */
    const placed = placeInRecording(wallClock.startedAtSeconds + 30.4, wallClock);
    expect(placed.basis).toBe('footage-clock');
    expect(placed.offsetSeconds).toBe(30);
  });

  it('reports unplaceable rather than 0 for a missing or unparseable value', () => {
    for (const value of [undefined, null, Number.NaN]) {
      expect(placeInRecording(value, wallClock).offsetSeconds).toBeNull();
    }
  });
});

describe('epochSecondsOf', () => {
  it('parses an ISO instant', () => {
    expect(epochSecondsOf('2026-08-05T09:00:00.000Z')).toBe(1785920400);
  });

  /** ⛔ `null`, never 0 — the epoch is a real and very wrong instant. */
  it('returns null rather than 0 for nothing', () => {
    expect(epochSecondsOf(undefined)).toBeNull();
    expect(epochSecondsOf('')).toBeNull();
    expect(epochSecondsOf('not a date')).toBeNull();
  });
});

describe('historyPointSeconds', () => {
  /** ⛔ Both formats `track_motion.seconds_of` produces. Knowing only one loses a whole path. */
  it('parses the live path ISO stamp', () => {
    expect(historyPointSeconds('2026-08-05T09:00:12.500Z')).toBeCloseTo(1785920412.5, 3);
  });

  it('parses the batch relative stamp', () => {
    expect(historyPointSeconds('12.5s')).toBe(12.5);
  });

  it('returns null for anything else', () => {
    expect(historyPointSeconds('later')).toBeNull();
    expect(historyPointSeconds(undefined)).toBeNull();
  });
});

describe('sinceOrigin', () => {
  /** ⛔ The defect that shipped once: "was inside the zone at 1786221387.294 s". */
  it('turns an absolute graph instant into a readable offset', () => {
    expect(sinceOrigin(1786221387.294, 1786221370)).toBeCloseTo(17.294, 3);
  });
});
