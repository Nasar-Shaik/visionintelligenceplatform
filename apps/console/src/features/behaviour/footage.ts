/**
 * **The one place a behaviour fact is turned into a video position** (Phase 2.4 slice 2.8).
 *
 *     behaviour fact ──▶ footageSeconds ──▶ recording offset ──▶ video.currentTime
 *                        (absolute)         (0 = first frame)
 *
 * ### ⛔ Why this is a module with tests and not two lines at the call site
 *
 * Three clocks meet on the investigation page and two of them look identical on screen:
 *
 * | value                          | zero point                          | who produces it |
 * |--------------------------------|-------------------------------------|-----------------|
 * | `entry.atSeconds`              | the run's **first observation**     | the runtime     |
 * | `entry.footageSeconds`         | the **epoch**, on the footage clock | the runtime     |
 * | `video.currentTime`            | the **first frame** of the file     | the browser     |
 *
 * `atSeconds` is the readable one and it is *not* a video position: nobody is necessarily in shot at
 * 00:00, so a run whose first person appears eight seconds in reports that moment as `0.0 s`. Seeking
 * a `<video>` to `atSeconds` therefore lands eight seconds early — on a frame where the thing being
 * explained has not happened yet, which is worse than not seeking at all because the operator sees a
 * confident jump to the wrong evidence.
 *
 * ⚠️ **And `footageSeconds` has two producers.** `track_motion.seconds_of` parses both an ISO stamp
 * (live capture, and the analysis path, giving epoch seconds ≈ 1.79e9) and a relative `12.5s` form
 * (batch and deterministic tests). A subtraction that assumed the first would turn the second into
 * roughly minus fifty-six years, and a subtraction that assumed the second would seek to 1.79e9.
 * Neither throws. So the basis is **decided against the recording's own duration** and reported, and
 * a fact that cannot be placed is refused rather than placed wrongly (ADR-0039).
 */

/** What the recording is, as far as placing a fact inside it is concerned. */
export interface RecordingClock {
  /** Footage-clock instant of offset 0, as epoch seconds. `null` when the analysis declared none. */
  startedAtSeconds: number | null;
  /** Length of the file, when the container declared one. */
  durationSeconds?: number | undefined;
}

/**
 * How a footage second was placed in the recording.
 *
 * - `footage-clock` — absolute; the recording's start was subtracted.
 * - `relative` — the runtime already reported it against the recording.
 * - `unplaceable` — ⛔ neither reading lands inside the file. **Nothing is seeked**; the surface
 *   says so instead. A wrong frame presented confidently is the defect this whole module exists for.
 */
export type FootageBasis = 'footage-clock' | 'relative' | 'unplaceable';

export interface PlacedMoment {
  /** Seconds from the first frame of the recording. `null` when `basis === 'unplaceable'`. */
  offsetSeconds: number | null;
  basis: FootageBasis;
}

/**
 * ⚠️ Slack allowed at both ends before a reading is rejected.
 *
 * A behaviour interval is derived from frame timestamps, and the last analysed frame can sit a
 * fraction past the duration ffprobe declared. Two seconds is far below anything an operator would
 * notice as a mis-seek and far above container rounding.
 */
const EDGE_TOLERANCE_SECONDS = 2;

/**
 * The epoch discriminant, used **only when the recording declared no duration**.
 *
 * ⚠️ Exact rather than heuristic for any real input: `1e6` seconds is 11.6 days, longer than any
 * recording this platform accepts (the ceiling is 2 GB), and earlier than 1970-01-12, before which
 * no footage clock can be stamped. Nothing realistic sits on both sides of it.
 */
const EPOCH_DISCRIMINANT_SECONDS = 1e6;

/** Epoch seconds for an ISO instant, or `null` — never `0`, which is a real and very wrong instant. */
export function epochSecondsOf(iso: string | undefined | null): number | null {
  if (iso === undefined || iso === null || iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * The footage second of a stored history point's `at`.
 *
 * ⛔ **Mirrors `track_motion.seconds_of`, including its second format**, because a history point is
 * stamped by whichever path produced it: the live path writes ISO (`2026-08-05T09:00:00.123Z`) and
 * the batch/deterministic path writes a relative `12.5s`. A parser that knew only the first would
 * return `NaN` for every point of an offline analysis, and a trajectory whose points cannot be
 * placed silently loses its seek.
 *
 * ⚠️ `null` for anything unparseable — never 0. A fabricated zero turns an unreadable timestamp into
 * "this happened at the start of the recording".
 */
export function historyPointSeconds(at: string | undefined | null): number | null {
  if (typeof at !== 'string' || at === '') return null;
  const text = at.trim();
  if (text.endsWith('s') && !text.endsWith('Z')) {
    const value = Number.parseFloat(text.slice(0, -1));
    return Number.isFinite(value) ? value : null;
  }
  return epochSecondsOf(text);
}

/**
 * Place one footage second inside the recording.
 *
 * ⛔ Returns `unplaceable` rather than a best guess. The caller renders "cannot be placed in this
 * recording" and disables the seek — an operator who is told nothing can be shown looks for another
 * route; an operator shown the wrong frame draws a conclusion from it.
 */
export function placeInRecording(
  footageSeconds: number | undefined | null,
  clock: RecordingClock,
): PlacedMoment {
  if (footageSeconds === undefined || footageSeconds === null || !Number.isFinite(footageSeconds)) {
    return { offsetSeconds: null, basis: 'unplaceable' };
  }

  const start = clock.startedAtSeconds;
  const absolute = start === null ? null : footageSeconds - start;
  const duration = clock.durationSeconds;

  /*
   * ⭐ **Decided against the file when the file can decide it.** With a duration in hand the two
   * candidate readings are testable rather than guessed at: exactly one of them lands inside the
   * recording for any real payload, and when neither does, that is a finding.
   */
  if (duration !== undefined && duration > 0) {
    const ceiling = duration + EDGE_TOLERANCE_SECONDS;
    if (absolute !== null && absolute >= -EDGE_TOLERANCE_SECONDS && absolute <= ceiling) {
      return { offsetSeconds: clamp(absolute, duration), basis: 'footage-clock' };
    }
    if (footageSeconds >= -EDGE_TOLERANCE_SECONDS && footageSeconds <= ceiling) {
      return { offsetSeconds: clamp(footageSeconds, duration), basis: 'relative' };
    }
    return { offsetSeconds: null, basis: 'unplaceable' };
  }

  /* No duration — fall back to the discriminant, which is exact for any realistic value. */
  if (footageSeconds >= EPOCH_DISCRIMINANT_SECONDS) {
    if (absolute === null || absolute < -EDGE_TOLERANCE_SECONDS) {
      return { offsetSeconds: null, basis: 'unplaceable' };
    }
    return { offsetSeconds: Math.max(0, absolute), basis: 'footage-clock' };
  }
  if (footageSeconds < -EDGE_TOLERANCE_SECONDS) return { offsetSeconds: null, basis: 'unplaceable' };
  return { offsetSeconds: Math.max(0, footageSeconds), basis: 'relative' };
}

function clamp(value: number, duration: number): number {
  return Math.min(Math.max(value, 0), duration);
}

/**
 * The same placement for a graph edge, whose `atSeconds` is **absolute** where a timeline entry's is
 * an offset.
 *
 * ⚠️ The asymmetry is real and is in the payloads: `BehaviourGraphEdge.atSeconds` is the footage
 * clock and the graph carries `originSeconds` beside it, while `BehaviourTimelineEntry.atSeconds`
 * has already had the origin subtracted and carries `footageSeconds` beside it. Two functions
 * because one function taking "which kind of seconds is this" is a flag nobody reads correctly.
 */
export function placeGraphEdge(atSeconds: number, clock: RecordingClock): PlacedMoment {
  return placeInRecording(atSeconds, clock);
}

/**
 * A run-relative reading for display — what `atSeconds` already is, and what a graph edge is not.
 *
 * ⛔ Offsets are what an operator reads. `originSeconds` exists precisely so a consumer never prints
 * `1786221387.294 s`, which this platform has now shipped once and must not ship again.
 */
export function sinceOrigin(atSeconds: number, originSeconds: number): number {
  return Math.round((atSeconds - originSeconds) * 1000) / 1000;
}
