/**
 * Dwell accumulation (P-8 Phase 7).
 *
 * The whole feature's semantics live in one pure function, so this is where loitering is actually
 * specified. Every test states a *behaviour a customer would notice*, not an implementation detail —
 * the mutation suite corrupts these behaviours one at a time and expects exactly one to go red.
 */
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, RuleDwell } from '@vip/contracts';
import {
  gapIsUnusual,
  dwellKey,
  moments,
  observe,
  parseDwellKey,
  replayDwell,
  subjectKeyFor,
  timerStateOf,
  zoneKeyFor,
  type DwellOutcome,
} from '../src/domain/dwell.js';

const CONFIG: RuleDwell = {
  minSeconds: 60,
  groupBy: 'identity',
  resetAfterSeconds: 30,
  cooldownSeconds: 300,
};

const T0 = Date.parse('2026-08-06T10:00:00.000Z');

/** Feed a series of observations, `stepSeconds` apart, and return every outcome. */
function walk(
  seconds: readonly number[],
  config: RuleDwell = CONFIG,
  opts: { trackIds?: (string | undefined)[]; confidences?: (number | undefined)[] } = {},
): DwellOutcome[] {
  const outcomes: DwellOutcome[] = [];
  let previous: DwellOutcome | undefined;
  for (const [i, offset] of seconds.entries()) {
    previous = observe(
      previous?.record,
      {
        atMs: T0 + offset * 1000,
        eventId: `ev-${i}`,
        eventType: 'perception.person.detected',
        trackId: opts.trackIds?.[i] ?? 'trk-1',
        confidence: opts.confidences?.[i],
        frameId: `t1:cam-1:${i}`,
      },
      config,
    );
    outcomes.push(previous);
  }
  return outcomes;
}

const last = <T>(xs: readonly T[]): T => xs[xs.length - 1] as T;

describe('subject key', () => {
  const envelope = (subject: Record<string, unknown>): EventEnvelope =>
    ({ subjects: [subject] }) as unknown as EventEnvelope;

  it('prefers identity over track, because a briefly occluded person keeps their identity', () => {
    expect(subjectKeyFor('identity', envelope({ trackId: 't-9', identityId: 'id-1' }))).toBe(
      'id-1',
    );
  });

  it('falls back to the track id when the producer has not adopted ADR-0041', () => {
    expect(subjectKeyFor('identity', envelope({ trackId: 't-9' }))).toBe('t-9');
  });

  it('uses the track id — never the identity — when the rule asked for tracks', () => {
    expect(subjectKeyFor('track', envelope({ trackId: 't-9', identityId: 'id-1' }))).toBe('t-9');
  });

  /**
   * ⚠️ The "Missing Identity" mutation. A fallback here would pool every anonymous detection into
   * one ever-present subject that crosses any threshold in seconds and never leaves.
   */
  it('refuses rather than inventing a subject when the event carries neither id', () => {
    expect(subjectKeyFor('identity', envelope({ class: 'person' }))).toBeUndefined();
    expect(subjectKeyFor('identity', { subjects: [] } as unknown as EventEnvelope)).toBeUndefined();
  });

  it('treats an event with no zone as one whole-frame zone', () => {
    expect(zoneKeyFor({} as EventEnvelope)).toBe('-');
    expect(zoneKeyFor({ zoneId: 'zn-1' } as EventEnvelope)).toBe('zn-1');
  });
});

describe('accumulation', () => {
  it('measures the span from first to most recent sighting', () => {
    const outcomes = walk([0, 10, 20, 30]);
    expect(last(outcomes).observedSeconds).toBe(30);
    expect(last(outcomes).record.observations).toBe(4);
  });

  it('does not fire below the threshold', () => {
    expect(walk([0, 30, 59]).every((o) => !o.fires)).toBe(true);
  });

  it('fires the moment the threshold is reached', () => {
    const outcomes = walk([0, 30, 60]);
    expect(outcomes.slice(0, 2).every((o) => !o.fires)).toBe(true);
    expect(last(outcomes).fires).toBe(true);
    expect(last(outcomes).crossedNow).toBe(true);
  });

  /**
   * ⚠️ A single observation is a visit of zero seconds, not of `minSeconds`. Getting this wrong
   * would fire on every first sighting of every person, which is the loudest possible failure.
   */
  it('treats a lone observation as zero seconds', () => {
    const [only] = walk([0]);
    expect(only?.observedSeconds).toBe(0);
    expect(only?.fires).toBe(false);
  });
});

describe('reset', () => {
  it('starts a fresh visit after a gap longer than the reset', () => {
    const outcomes = walk([0, 10, 100]);
    expect(last(outcomes).reset).toBe(true);
    expect(last(outcomes).observedSeconds).toBe(0);
    expect(last(outcomes).record.observations).toBe(1);
  });

  it('keeps accumulating across a gap shorter than the reset', () => {
    const outcomes = walk([0, 25, 50, 75]);
    expect(outcomes.some((o) => o.reset)).toBe(false);
    expect(last(outcomes).observedSeconds).toBe(75);
  });

  /**
   * ⚠️ The reset boundary is strictly greater-than. A gap of exactly `resetAfterSeconds` continues
   * the visit — otherwise a deployment whose frame interval divides the reset exactly would reset on
   * every single frame, and nothing would ever accumulate.
   */
  it('continues on a gap exactly equal to the reset', () => {
    expect(last(walk([0, 30])).reset).toBe(false);
    expect(last(walk([0, 31])).reset).toBe(true);
  });

  it('records the longest gap it saw, because a duration with a hole in it is a weaker claim', () => {
    const outcomes = walk([0, 5, 30, 35, 60]);
    expect(last(outcomes).longestGapSeconds).toBe(25);
  });
});

describe('cool-down', () => {
  it('stays silent for the cool-down after firing, then fires again', () => {
    /* Crosses at 60, then observations every 60s. Cool-down is 300s. */
    const outcomes = walk([0, 30, 60, 90, 120, 300, 330, 360, 390]);
    const firing = outcomes.filter((o) => o.fires);
    expect(firing).toHaveLength(2);
    expect(outcomes[3]?.coolingDown).toBe(true);
    expect(outcomes[3]?.cooldownRemainingSeconds).toBe(270);
  });

  /**
   * ⚠️ At 2 fps, a rule with no cool-down raises 120 candidates a minute for one stationary person.
   * `0` is legal (a long reset can do the same job) and validation warns about it loudly.
   */
  it('fires on every observation past the threshold when the cool-down is zero', () => {
    const outcomes = walk([0, 30, 60, 61, 62], { ...CONFIG, cooldownSeconds: 0 });
    expect(outcomes.filter((o) => o.fires)).toHaveLength(3);
  });

  /**
   * ⚠️ The clock keeps running through a cool-down. The second candidate reports the WHOLE visit,
   * not the time since the last one — "here for ten minutes" outranks "another five elapsed".
   */
  it('reports the whole visit on a repeat, not the time since the last candidate', () => {
    /*
     * ⚠️ Observations every 20s, not every 60s. A gap larger than `resetAfterSeconds` (30) starts a
     * NEW visit — which is the rule working, and it is what a real 2 fps deployment never hits.
     * Sparse test data here would have "proved" that dwell does not accumulate.
     */
    const outcomes = walk([
      0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 340, 360, 380,
      400,
    ]);
    expect(outcomes[3]?.observedSeconds).toBe(60);
    expect(outcomes[3]?.crossedNow).toBe(true);

    /* Crossed at 60s, cool-down 300s ⇒ the next candidate is at 360s, and it is a repeat. */
    const firing = outcomes.filter((o) => o.fires);
    expect(firing).toHaveLength(2);
    const repeat = firing[1];
    expect(repeat?.observedSeconds).toBe(360);
    expect(repeat?.crossedNow).toBe(false);

    /* And the observations after it are silenced by the new cool-down, still accumulating. */
    expect(last(outcomes).fires).toBe(false);
    expect(last(outcomes).coolingDown).toBe(true);
    expect(last(outcomes).observedSeconds).toBe(400);
  });
});

describe('identity fragmentation', () => {
  it('counts distinct track ids under one subject, and marks the relink on the timeline', () => {
    const outcomes = walk([0, 10, 20], CONFIG, { trackIds: ['t-1', 't-1', 't-2'] });
    expect(last(outcomes).trackFragments).toBe(2);
    expect(moments(last(outcomes).record).some((m) => m.kind === 'identity-relinked')).toBe(true);
  });

  it('reports one fragment for an unbroken visit — never zero', () => {
    expect(last(walk([0, 10])).trackFragments).toBe(1);
  });
});

describe('out-of-order observations', () => {
  /**
   * ⚠️ Events arrive out of order under load. An older one must never shrink an accumulated
   * duration, or a threshold already crossed could quietly un-cross.
   */
  it('never moves the clock backwards', () => {
    const outcomes = walk([0, 20, 10]);
    expect(outcomes[1]?.observedSeconds).toBe(20);
    expect(last(outcomes).observedSeconds).toBe(20);
    /* The stale observation still counts as evidence the subject was there. */
    expect(last(outcomes).record.observations).toBe(3);
  });

  it('does not treat a backwards jump as an absence', () => {
    /* A 60s backwards step exceeds the 30s reset, but it is reordering, not a gap. */
    expect(last(walk([0, 20, 40, 60, 0])).reset).toBe(false);
  });
});

describe('confidence', () => {
  it('averages what it was given', () => {
    const outcomes = walk([0, 10], CONFIG, { confidences: [0.8, 0.6] });
    expect(last(outcomes).meanConfidence).toBeCloseTo(0.7, 6);
  });

  /** ⚠️ `null`, never 0 — an unmeasured confidence and a confidence of zero mean opposite things. */
  it('reports null when nothing carried a confidence', () => {
    expect(last(walk([0, 10])).meanConfidence).toBeNull();
  });
});

describe('the typical gap (found by the deployment)', () => {
  /**
   * ⚠️ **The defect this exists to prevent shipped and was caught by reading a green run.**
   *
   * `services/events` collapses repeated detections of one subject into one event per dedup bucket
   * (10 s by default), so a *continuously present* person is observed about once every ten seconds
   * however fast the camera runs. The first version reported `longestGapSeconds: 10` on every single
   * incident and the summary said "the longest unobserved gap was 10s" — true, alarming, and
   * describing nothing but the platform's own sampling. An operator would have learned within a week
   * to ignore the one field that exists to make them careful.
   */
  it('reports regular sampling as regular, not as a gap', () => {
    const outcomes = walk([0, 10, 20, 30, 40, 50]);
    const last10 = last(outcomes);
    expect(last10.longestGapSeconds).toBe(10);
    expect(last10.typicalGapSeconds).toBe(10);
    expect(gapIsUnusual(last10.longestGapSeconds, last10.typicalGapSeconds)).toBe(false);
  });

  it('reports a genuine hole as unusual', () => {
    const outcomes = walk([0, 10, 20, 45, 55, 65]);
    const withHole = last(outcomes);
    expect(withHole.longestGapSeconds).toBe(25);
    expect(withHole.typicalGapSeconds).toBe(10);
    expect(gapIsUnusual(withHole.longestGapSeconds, withHole.typicalGapSeconds)).toBe(true);
  });

  /** ⚠️ `null`, not 0 — a visit seen once has no interval, and `0` would claim continuous sampling. */
  it('has no typical gap after a single observation', () => {
    expect(walk([0])[0]?.typicalGapSeconds).toBeNull();
  });

  it('uses the median, so one hole does not redefine what normal looks like', () => {
    /* ⚠️ The hole must stay under `resetAfterSeconds` (30) or it ends the visit and there is
     * nothing left to take a median of — which is the rule working, not a missing statistic. */
    const outcomes = walk([0, 5, 10, 15, 20, 25, 50]);
    /* Five 5s gaps and one 25s hole: the mean would be ~8.3, the median stays 5. */
    expect(last(outcomes).typicalGapSeconds).toBe(5);
    expect(last(outcomes).longestGapSeconds).toBe(25);
  });

  it('never flags a sub-second jitter, however large the ratio', () => {
    expect(gapIsUnusual(0.4, 0.1)).toBe(false);
  });
});

describe('timeline', () => {
  it('is ordered by time, always', () => {
    const outcomes = walk(Array.from({ length: 40 }, (_, i) => i * 2));
    const times = moments(last(outcomes).record).map((m) => m.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  /** ⚠️ Bounded: a ten-minute dwell at 2 fps is 1 200 observations and must not travel whole. */
  it('keeps the head and the tail and counts what it dropped', () => {
    const outcomes = walk(Array.from({ length: 100 }, (_, i) => i * 2));
    const record = last(outcomes).record;
    expect(moments(record).length).toBeLessThanOrEqual(30);
    expect(record.omitted).toBeGreaterThan(0);
    /* The very first moment survives — it is the one an investigator looks for. */
    expect(moments(record)[0]?.kind).toBe('first-observed');
  });
});

describe('replay (Architect rec 5)', () => {
  /**
   * The property that makes a timeline evidence rather than decoration: replaying the moments a
   * candidate carries reproduces the candidate's own numbers. If this failed, the timeline would be
   * a plausible story printed next to a decision it did not describe.
   */
  it('reproduces the outcome from the recorded moments', () => {
    const outcomes = walk([0, 20, 40, 60, 80]);
    const original = last(outcomes);
    const replayed = replayDwell(moments(original.record), CONFIG);
    expect(replayed).toBeDefined();
    expect(replayed?.observedSeconds).toBe(original.observedSeconds);
    expect(replayed?.record.observations).toBe(original.record.observations);
    expect(replayed?.trackFragments).toBe(original.trackFragments);
    expect(replayed?.longestGapSeconds).toBe(original.longestGapSeconds);
  });

  it('returns undefined for a timeline with no real observations', () => {
    expect(replayDwell([{ atMs: T0, kind: 'raised' }], CONFIG)).toBeUndefined();
  });
});

describe('live timer state (Architect recs 3 + 6)', () => {
  it('is accumulating below the threshold', () => {
    const { record } = last(walk([0, 30]));
    expect(timerStateOf(record, CONFIG, T0 + 30_000).state).toBe('accumulating');
  });

  it('is met at the threshold with no cool-down running', () => {
    const config = { ...CONFIG, cooldownSeconds: 0 };
    const { record } = last(walk([0, 20, 40, 60], config));
    expect(timerStateOf(record, config, T0 + 60_000).state).toBe('met');
  });

  it('is cooling down after it fired, and counts the remainder honestly', () => {
    const { record } = last(walk([0, 20, 40, 60]));
    const state = timerStateOf(record, CONFIG, T0 + 100_000);
    expect(state.state).toBe('cooling-down');
    expect(state.cooldownRemainingSeconds).toBe(260);
  });

  it('returns to met once the cool-down has run out', () => {
    const { record } = last(walk([0, 20, 40, 60]));
    expect(timerStateOf(record, CONFIG, T0 + 400_000).state).toBe('met');
  });
});

describe('state keys', () => {
  it('round-trips, including a subject id containing colons', () => {
    const key = dwellKey('t-1', 'rule-9', 'zn-3', 'cam-1:trk:42');
    expect(parseDwellKey(key)).toEqual({
      tenantId: 't-1',
      ruleId: 'rule-9',
      zoneKey: 'zn-3',
      subject: 'cam-1:trk:42',
    });
  });

  /** ⚠️ A partly-parsed key would attribute a timer to the wrong rule and show the wrong threshold. */
  it('refuses a malformed key rather than guessing', () => {
    expect(parseDwellKey('t-1:rule-9')).toBeUndefined();
    expect(parseDwellKey('t-1:rule-9:zn-3:')).toBeUndefined();
  });

  it('keeps two rules watching one zone independent', () => {
    expect(dwellKey('t', 'r1', 'z', 's')).not.toBe(dwellKey('t', 'r2', 'z', 's'));
  });
});
