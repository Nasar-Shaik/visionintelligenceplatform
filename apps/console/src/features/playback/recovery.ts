/**
 * Surviving the things that actually happen to an investigator's browser (P-5.6).
 *
 * A playback session is a **signed URL with an expiry**, handed to a `<video>` element that will
 * hold it for as long as the tab is open. Investigations are not short. The failure this module
 * exists for is mundane and constant: an operator opens a clip at 14:00, sleeps the laptop, comes
 * back at 17:00, presses play, and the video reports an error. Nothing is broken. The URL simply
 * expired three hours ago.
 *
 * ### ⚠️ "Try again" on a dead URL is not a recovery
 *
 * The first version of the error overlay offered a retry that called `video.load()` — which reloads
 * **the same expired URL** and fails identically. A retry that cannot succeed is worse than no retry
 * at all: the operator presses it three times, concludes the evidence is corrupt, and escalates.
 * Recovery has to go back to the server for a *fresh signature*, which means invalidating the query,
 * not reloading the element.
 *
 * ### ⚠️ Expiry is judged against the wall clock, not against a timer
 *
 * A `setTimeout` for the expiry moment does not survive sleep — the machine wakes and the timer
 * fires late, or does not fire at all until the event loop catches up. So the session records when
 * it was resolved and this module compares *now* to that, on every wake, on every visibility change,
 * and before every play. A slept laptop is the common case, not the exotic one.
 */

/** Seconds of margin before declared expiry at which a session stops being trusted. */
export const EXPIRY_MARGIN_SECONDS = 60;

export interface SessionClock {
  /** When the session was resolved, from the server's own `derivedAt`. */
  derivedAt: string;
  /** The shortest segment lifetime in the session. */
  expiresInSeconds: number;
}

/**
 * Read the clock off a resolved session.
 *
 * ⚠️ The **earliest** expiry across segments, not the latest. A multi-segment source is only as
 * playable as its first dead link, and taking the maximum would report a healthy session while the
 * operator stares at a broken second half.
 */
export function sessionClock(session: {
  derivedAt: string;
  segments: readonly { expiresInSeconds: number }[];
}): SessionClock | undefined {
  const earliest = session.segments.reduce<number | undefined>(
    (min, segment) =>
      min === undefined ? segment.expiresInSeconds : Math.min(min, segment.expiresInSeconds),
    undefined,
  );
  if (earliest === undefined) return undefined;
  return { derivedAt: session.derivedAt, expiresInSeconds: earliest };
}

/**
 * Seconds of usable life left, from the wall clock.
 *
 * Negative once expired. ⚠️ `undefined` when the session declares no segments or an unparseable
 * `derivedAt` — the caller must treat that as "cannot tell", never as "fine".
 */
export function secondsRemaining(clock: SessionClock | undefined, now: Date): number | undefined {
  if (clock === undefined) return undefined;
  const derivedMs = Date.parse(clock.derivedAt);
  if (Number.isNaN(derivedMs)) return undefined;
  return clock.expiresInSeconds - (now.getTime() - derivedMs) / 1000;
}

/**
 * Is this session too old to hand to a media element?
 *
 * ⚠️ Fails **closed**: an unreadable clock counts as expired. The cost of refetching a session that
 * was actually still good is one signed-URL request; the cost of the opposite is an operator
 * watching an error overlay and believing the evidence is gone.
 */
export function sessionExpired(clock: SessionClock | undefined, now: Date): boolean {
  const remaining = secondsRemaining(clock, now);
  if (remaining === undefined) return true;
  return remaining <= EXPIRY_MARGIN_SECONDS;
}

/** Why playback stopped, insofar as the browser told us. */
export type PlaybackFailure =
  'expired' | 'network' | 'decode' | 'aborted' | 'refused' | 'no-video' | 'unknown';

/**
 * Did the **video track** fail to decode while the file otherwise played?
 *
 * ### ⚠️ The worst silent failure found in this whole subsystem
 *
 * Measured in P-5.7. Chromium 151 was handed a real H.265 clip with an AAC audio track. It did not
 * error. It reported `readyState` fine, a 10 s duration, a running `currentTime` — and
 * **`videoWidth === 0`**. It played the audio and dropped the video entirely.
 *
 * On screen that is a **black player with a moving scrubber and no message whatsoever**. An
 * investigator reviewing a night-time corridor concludes the camera recorded darkness. There is no
 * error event to classify, no failed request to retry, and — because the container opened and the
 * codec probe may return `unknown` for a codec string the platform cannot translate — no earlier
 * gate necessarily catches it.
 *
 * The check is one number, available the moment metadata loads: a source the session says is video,
 * whose decoded frame is zero pixels wide, has no video.
 *
 * @param contentType the stored MIME type
 * @param videoWidth the element's `videoWidth` after `loadedmetadata`
 * @param isStill true when the session carries a snapshot rather than a clip
 */
export function videoTrackMissing(
  contentType: string,
  videoWidth: number,
  isStill: boolean,
): boolean {
  /* A still image is drawn by an `<img>`; it has no media element to interrogate. */
  if (isStill) return false;
  if (!contentType.startsWith('video/')) return false;
  /* ⚠️ `0` only. `NaN` or `undefined` means "not reported yet", which is not the same as "absent". */
  return videoWidth === 0;
}

/**
 * Classify a `MediaError`.
 *
 * ⚠️ The classification exists because **the three causes need three different sentences**. A
 * decode failure means the file is damaged and no retry will help; a network failure means try
 * again; an expiry means fetch a new signature. Collapsing them into "the media could not be
 * loaded" — which is what the player did before this — tells the operator nothing they can act on,
 * and in the expiry case actively misleads them about the state of the evidence.
 *
 * `MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED` is ambiguous by specification: it is what a browser
 * reports both for a codec it cannot decode *and* for a URL that returned 403. Which one it is
 * depends on whether the session's own clock says the signature is still alive, so the clock is a
 * required argument rather than a hint.
 */
export function classifyFailure(code: number | undefined, clockExpired: boolean): PlaybackFailure {
  if (clockExpired) return 'expired';
  switch (code) {
    case 1:
      return 'aborted';
    case 2:
      return 'network';
    case 3:
      return 'decode';
    case 4:
      /*
       * ⚠️ The browser refused the source outright, with a signature that is still alive.
       *
       * Measured in P-5.6: WebKit and Safari 26.5.2 both answer `probably` to
       * `video/mp4; codecs="avc1.42E01E"` and then reject an actual H.264-in-MP4 file with this
       * code. **A positive capability probe is not a guarantee of decode** — so this is not a rare
       * pathological case, it is the ordinary way an engine says "not this file". Naming it lets
       * the overlay suggest the two things that actually help (another browser, or the original
       * download) rather than shrugging.
       */
      return 'refused';
    default:
      return 'unknown';
  }
}

export interface FailureCopy {
  title: string;
  detail: string;
  /** Whether a fresh session should be fetched. `false` ⇒ retrying cannot help. */
  recoverable: boolean;
  /** Label for the action, when there is one worth offering. */
  action?: string;
}

/** What to tell the operator. ⚠️ Never "try again" where trying again cannot work. */
export function failureCopy(failure: PlaybackFailure): FailureCopy {
  switch (failure) {
    case 'expired':
      return {
        title: 'This playback link expired',
        detail:
          'Signed links are short-lived by design, so evidence cannot be shared by copying a URL. ' +
          'The recording is untouched — fetching a new link resumes from where you were.',
        recoverable: true,
        action: 'Resume playback',
      };
    case 'network':
      return {
        title: 'The connection dropped',
        detail:
          'The recording stopped loading partway through. The evidence is intact; this is a ' +
          'network problem between this browser and the evidence store.',
        recoverable: true,
        action: 'Retry',
      };
    case 'decode':
      return {
        title: 'This recording could not be decoded',
        detail:
          'The browser opened the file and then failed to decode it, which usually means the ' +
          'recording is truncated or damaged — not that the link is wrong. Download the original ' +
          'and check its integrity hash before treating this as evidence.',
        /* ⚠️ Not recoverable. A damaged file is damaged on the second attempt too. */
        recoverable: false,
      };
    case 'aborted':
      return {
        title: 'Loading was cancelled',
        detail: 'The browser stopped loading this recording before it finished.',
        recoverable: true,
        action: 'Retry',
      };
    case 'refused':
      return {
        title: 'This browser refused the recording',
        detail:
          'The browser declined to open the file even though it reported support for the format. ' +
          'Support probes are advisory, not guarantees — the same file often opens in a different ' +
          'browser. The evidence is intact; try another browser or download the original.',
        /* Worth one retry: the same code also covers a storage object that briefly refused. */
        recoverable: true,
        action: 'Retry',
      };
    case 'no-video':
      return {
        title: 'This browser decoded no video from this recording',
        detail:
          'The file opened and its audio is playing, but the video track produced no picture — ' +
          'the browser is missing a decoder for it. A black player with a running clock is not an ' +
          'empty recording. The evidence is intact; open it in another browser, or download the ' +
          'original.',
        /* ⚠️ Not recoverable here: a missing decoder is missing on the second attempt too. */
        recoverable: false,
      };
    case 'unknown':
    default:
      return {
        title: 'Playback stopped',
        detail:
          'The browser reported a failure it did not classify, and the playback link had not ' +
          'expired. The evidence itself is unaffected.',
        recoverable: true,
        action: 'Retry',
      };
  }
}

/**
 * Did playback end **before the record says the footage does**?
 *
 * ### ⚠️ P-5.7 corrects what P-5.6 claimed here
 *
 * P-5.6 concluded that a damaged recording "plays with no error event of any kind". **That was
 * wrong, and it was wrong because the fixtures were wrong.** Those files came from Chromium's
 * `MediaRecorder` — fragmented MP4 with no duration index — so a truncated one simply ran out of
 * data and stopped, which is not what a damaged NVR export does.
 *
 * Re-measured in P-5.7 against `libx264`-encoded MP4s with a real `moov`, which is what a camera or
 * an NVR actually writes:
 *
 * | file | outcome |
 * |---|---|
 * | intact 10 s | `ended` at 10.0 s |
 * | truncated to 55 % | **`MEDIA_ERR_DECODE` at 3.89 s** of a declared 10 s |
 * | byte-corrupted mid-file | **`MEDIA_ERR_DECODE` at 2.25 s** |
 *
 * Identical in Chromium, Chrome and Edge. So the browser *does* complain, `classifyFailure` routes
 * it to `decode`, and the operator is told the file is damaged and to check the integrity hash.
 *
 * P-5.6 also claimed engines disagree on duration for an intact file (6.01 / 3.45 / 1.19 s). That
 * too was the fragmented-MP4 fixtures: with a proper `moov` every engine reports **10.0 s**, and the
 * one-hour fixture reports **3600.0 s** everywhere.
 *
 * ### So why keep this check
 *
 * Because one silent case survived the re-measurement: a file truncated to **headers only** reports
 * `videoWidth` 1280, a full 10 s duration, and fires `ended` normally having decoded nothing. More
 * generally a source may legitimately hold less footage than its record claims. This is a cheap
 * safety net over the declared duration, not — as P-5.6 had it — the only signal there is.
 *
 * ⚠️ It still fires on **where the playhead stopped**, never on the reported `duration`. Duration is
 * a claim the container makes; the playhead is a fact about what was decoded.
 */
export function endedEarly(
  reachedSeconds: number,
  declaredSeconds: number,
  /** Absolute slack for rounding and for a final partial frame. */
  toleranceSeconds = 2,
): boolean {
  if (!Number.isFinite(reachedSeconds) || !Number.isFinite(declaredSeconds)) return false;
  /* A declared duration of zero is a still image, and a very short clip is all tolerance. */
  if (declaredSeconds <= toleranceSeconds) return false;
  return reachedSeconds < declaredSeconds - toleranceSeconds;
}
