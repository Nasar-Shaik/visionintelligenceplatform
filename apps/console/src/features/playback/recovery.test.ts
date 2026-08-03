/**
 * Recovery arithmetic and the sentences it produces (P-5.6).
 *
 * ⚠️ The behaviour under test is the one the operator meets after lunch: a session resolved at
 * 14:00, a laptop slept until 17:00, and a play button that must not report the evidence as broken.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPIRY_MARGIN_SECONDS,
  classifyFailure,
  failureCopy,
  endedEarly,
  secondsRemaining,
  sessionClock,
  sessionExpired,
  videoTrackMissing,
} from './recovery';

const at = (iso: string) => new Date(iso);
const DERIVED = '2026-08-03T14:00:00.000Z';

const clockOf = (expiresInSeconds: number, segments = 1) =>
  sessionClock({
    derivedAt: DERIVED,
    segments: Array.from({ length: segments }, () => ({ expiresInSeconds })),
  });

describe('the session clock', () => {
  it('⚠️ takes the earliest expiry across segments, never the latest', () => {
    const clock = sessionClock({
      derivedAt: DERIVED,
      segments: [{ expiresInSeconds: 3600 }, { expiresInSeconds: 300 }, { expiresInSeconds: 900 }],
    });
    /* A source is only as playable as its first dead link. */
    expect(clock?.expiresInSeconds).toBe(300);
  });

  it('is undefined when there are no segments', () => {
    expect(sessionClock({ derivedAt: DERIVED, segments: [] })).toBeUndefined();
  });
});

describe('expiry is judged against the wall clock', () => {
  it('counts down in real time', () => {
    const clock = clockOf(3600);
    expect(secondsRemaining(clock, at('2026-08-03T14:00:00.000Z'))).toBe(3600);
    expect(secondsRemaining(clock, at('2026-08-03T14:30:00.000Z'))).toBe(1800);
    expect(secondsRemaining(clock, at('2026-08-03T15:30:00.000Z'))).toBe(-1800);
  });

  it('⚠️ a slept laptop wakes to an expired session, and the clock knows it', () => {
    const clock = clockOf(3600);
    /* Slept at 14:05, woke at 17:00. No timer survived that; the comparison does. */
    expect(sessionExpired(clock, at('2026-08-03T17:00:00.000Z'))).toBe(true);
  });

  it('⚠️ expires a margin early, because refetching at the exact second races the network', () => {
    const clock = clockOf(3600);
    const justInside = new Date(Date.parse(DERIVED) + (3600 - EXPIRY_MARGIN_SECONDS - 1) * 1000);
    const justOutside = new Date(Date.parse(DERIVED) + (3600 - EXPIRY_MARGIN_SECONDS) * 1000);
    expect(sessionExpired(clock, justInside)).toBe(false);
    expect(sessionExpired(clock, justOutside)).toBe(true);
  });

  it('⚠️ fails closed: an unreadable clock counts as expired', () => {
    expect(sessionExpired(undefined, at(DERIVED))).toBe(true);
    expect(sessionExpired({ derivedAt: 'not a date', expiresInSeconds: 3600 }, at(DERIVED))).toBe(
      true,
    );
  });
});

describe('a failure is classified before it is described', () => {
  it('⚠️ an expired signature outranks whatever code the element reported', () => {
    /* MEDIA_ERR_SRC_NOT_SUPPORTED is what a browser reports for a 403 *and* for a bad codec. */
    expect(classifyFailure(4, true)).toBe('expired');
    expect(classifyFailure(2, true)).toBe('expired');
  });

  it('maps the media error codes it can', () => {
    expect(classifyFailure(1, false)).toBe('aborted');
    expect(classifyFailure(2, false)).toBe('network');
    expect(classifyFailure(3, false)).toBe('decode');
  });

  it('⚠️ refuses to guess when the browser reported no code at all', () => {
    expect(classifyFailure(undefined, false)).toBe('unknown');
    expect(classifyFailure(99, false)).toBe('unknown');
  });
});

describe('what the operator is told', () => {
  it('⚠️ never offers a retry that cannot succeed', () => {
    const decode = failureCopy('decode');
    expect(decode.recoverable).toBe(false);
    expect(decode.action).toBeUndefined();
    /* And it says the file, not the link, is the problem — because that changes what they do next. */
    expect(decode.detail).toMatch(/truncated or damaged/);
  });

  it('⚠️ says the recording is untouched when the link expired', () => {
    const expired = failureCopy('expired');
    expect(expired.recoverable).toBe(true);
    expect(expired.title).toMatch(/expired/i);
    expect(expired.detail).toMatch(/untouched/);
    expect(expired.action).toBe('Resume playback');
  });

  it('blames the network for a network failure, not the evidence', () => {
    expect(failureCopy('network').detail).toMatch(/network problem/);
  });

  it('admits when it does not know', () => {
    expect(failureCopy('unknown').detail).toMatch(/did not classify/);
  });
});

describe('⚠️ a truncated recording raises no error — so early ending is the only signal', () => {
  /*
   * Measured in P-5.6 against real files: a valid 6 s H.264 clip truncated to 55% of its bytes
   * played in Chromium, Chrome and Firefox without a single error event, reporting roughly half the
   * duration. The investigator sees the clip stop and concludes the incident ended there.
   */
  it('flags a clip that stopped well short of what the record declares', () => {
    expect(endedEarly(198, 600)).toBe(true);
  });

  it('does not flag a clip that ran to the end', () => {
    expect(endedEarly(600, 600)).toBe(false);
    expect(endedEarly(599, 600)).toBe(false);
  });

  it('⚠️ tolerates a final partial frame rather than crying wolf on every clip', () => {
    expect(endedEarly(598.1, 600)).toBe(false);
    expect(endedEarly(597.9, 600)).toBe(true);
  });

  it('⚠️ says nothing about a still image or a clip shorter than the tolerance', () => {
    expect(endedEarly(0, 0)).toBe(false);
    expect(endedEarly(0.5, 2)).toBe(false);
  });

  it('refuses to judge unusable numbers', () => {
    expect(endedEarly(Number.NaN, 600)).toBe(false);
    expect(endedEarly(10, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('⚠️ a positive capability probe is not a guarantee of decode', () => {
  /*
   * Measured: WebKit 26.5 and Safari 26.5.2 answer `probably` to `video/mp4; codecs="avc1.42E01E"`
   * and then reject an actual H.264-in-MP4 file with MEDIA_ERR_SRC_NOT_SUPPORTED. The overlay must
   * name that, because "try a different browser" is advice the operator can act on.
   */
  it('classifies a live-signature source rejection as a refusal, not as an unknown', () => {
    expect(classifyFailure(4, false)).toBe('refused');
  });

  it('tells the operator the probe was advisory and the evidence is fine', () => {
    const copy = failureCopy('refused');
    expect(copy.detail).toMatch(/advisory, not guarantees/);
    expect(copy.detail).toMatch(/evidence is intact/i);
    expect(copy.recoverable).toBe(true);
  });
});

describe('⚠️ P-5.7 — a missing video decoder shows black and says nothing', () => {
  /*
   * Measured: Chromium 151 handed a real H.265 clip with an AAC track did not error. It reported a
   * 10 s duration, a running currentTime, and `videoWidth === 0` — audio playing, video dropped.
   * On screen: a black player with a moving scrubber and no message. An investigator reviewing a
   * night-time corridor concludes the camera recorded darkness.
   */
  it('detects a video source that decoded no picture', () => {
    expect(videoTrackMissing('video/mp4', 0, false)).toBe(true);
  });

  it('says nothing about a source that decoded fine', () => {
    expect(videoTrackMissing('video/mp4', 1280, false)).toBe(false);
  });

  it('⚠️ says nothing about a still image, which has no media element to interrogate', () => {
    expect(videoTrackMissing('image/jpeg', 0, true)).toBe(false);
    expect(videoTrackMissing('video/mp4', 0, true)).toBe(false);
  });

  it('⚠️ treats "not reported" as unknown, never as absent', () => {
    expect(videoTrackMissing('video/mp4', Number.NaN, false)).toBe(false);
  });

  it('tells the operator a black player is not an empty recording, and offers no retry', () => {
    const copy = failureCopy('no-video');
    expect(copy.detail).toMatch(/not an empty recording/i);
    expect(copy.detail).toMatch(/evidence is intact/i);
    /* A missing decoder is missing on the second attempt too. */
    expect(copy.recoverable).toBe(false);
  });
});
