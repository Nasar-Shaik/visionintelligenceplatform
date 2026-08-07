/**
 * Deciding which stored boxes belong on screen at a given instant (P-8.6).
 *
 * ⭐ **Pure, and separated from the player on purpose.** jsdom implements no media element — it
 * never loads metadata, never fires `timeupdate` and reports `duration` as `NaN` — so logic left
 * inside the component could only be exercised in a browser. Every decision that can put a box in
 * the wrong place lives here, where a test can drive it with numbers.
 */
import type { AnalysisTimeline } from '@vip/contracts';
import type { DetectionBox } from '@/ui';
import { formatOffset } from './format';

type Entry = AnalysisTimeline['entries'][number];

/** Entries sharing one analysed instant, plus how far the playhead is from it. */
export interface FrameSample {
  offsetSeconds: number;
  entries: Entry[];
  deltaSeconds: number;
}

/**
 * How far from an analysed frame the playhead may sit and still show its boxes.
 *
 * ⚠️ Half a sample interval — at 2 fps that is ±0.25 s. Wider would drag a box across frames it was
 * never measured in, which is exactly the false precision this player exists to avoid. Floored at
 * 0.25 s so a slow run does not make the boxes unreachable, and total for a nonsense frame rate.
 */
export function toleranceFor(analysisFrameRate: number): number {
  if (!Number.isFinite(analysisFrameRate) || analysisFrameRate <= 0) return 0.25;
  return Math.max(0.25, 1 / (2 * analysisFrameRate));
}

/**
 * ⭐ The nearest analysed instant to `at`, with **every** entry recorded at that instant.
 *
 * ⛔ Two subjects seen in one frame must be returned together. Returning only the closest single
 * entry would draw one person's box and silently omit the other standing beside them — which reads
 * as "the platform saw one person" and is a different, wrong answer.
 */
export function nearestFrame(entries: readonly Entry[], at: number): FrameSample | undefined {
  let bestOffset: number | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    const delta = Math.abs(entry.offsetSeconds - at);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestOffset = entry.offsetSeconds;
    }
  }
  if (bestOffset === undefined) return undefined;
  return {
    offsetSeconds: bestOffset,
    entries: entries.filter((e) => e.offsetSeconds === bestOffset),
    deltaSeconds: bestDelta,
  };
}

/**
 * The boxes to draw, or an empty list.
 *
 * ⚠️ Empty is returned in two very different situations — no analysed frame within tolerance, and an
 * analysed frame whose subjects carried no box — so the caller is told which by `inFrame` rather
 * than left to infer it from a length.
 */
export function boxesAt(
  entries: readonly Entry[],
  at: number,
  analysisFrameRate: number,
  focusTrack?: string,
): { boxes: DetectionBox[]; inFrame: boolean; sample: FrameSample | undefined } {
  const sample = nearestFrame(entries, at);
  const inFrame = sample !== undefined && sample.deltaSeconds <= toleranceFor(analysisFrameRate);
  if (!inFrame || sample === undefined) return { boxes: [], inFrame: false, sample };
  const boxes = sample.entries
    .filter((e) => e.bbox !== undefined)
    /* ⭐ Isolating one track is how "which person is Track 7?" gets a visual answer. */
    .filter((e) => focusTrack === undefined || e.trackId === focusTrack)
    .map((e) => {
      const [x, y, width, height] = e.bbox as [number, number, number, number];
      return {
        id: e.eventId,
        label: e.trackId === undefined ? e.label : `${e.label} · ${shortTrack(e.trackId)}`,
        /* ⚠️ 0 only reaches the badge when the model reported no confidence; the tables render
         * that case as an em dash, and a box with no number is better than a box claiming 0 %. */
        confidence: e.confidence ?? 0,
        x,
        y,
        width,
        height,
      };
    });
  return { boxes, inFrame: true, sample };
}

/**
 * `trk_cam_x-tnt_y-cam_x-ases_…_7` → `#7`.
 *
 * ⚠️ The full id embeds tenant, camera and run and is ~90 characters — unusable in a table cell and
 * meaningless to an operator. The trailing ordinal is the part they can hold in their head and say
 * out loud ("which person is Track 7?"), which is the whole point of showing it.
 */
export function shortTrack(trackId: string): string {
  const tail = /_(\d+)$/.exec(trackId);
  return tail === null ? trackId.slice(-6) : `#${tail[1]!}`;
}

/** Distinct analysed instants — how many moments in the recording have anything stored. */
export function analysedInstants(entries: readonly Entry[]): number[] {
  return [...new Set(entries.map((e) => e.offsetSeconds))].sort((a, b) => a - b);
}

/**
 * What the overlay badge says, in words.
 *
 * ⛔ **"no analysed frame at this instant" was a dead end** (V-17). It is a true statement and it
 * leaves the operator with nowhere to go — the recording that prompted this has stored boxes at 5 of
 * its 19 seconds, so it is the message on screen for **97 % of playback**, and it reads as "the AI
 * found nothing" no matter how carefully it is worded. Naming the nearest stored moment and how far
 * away it is turns the same fact into an instruction.
 */
export function overlayStatus(
  boxCount: number,
  inFrame: boolean,
  sample: FrameSample | undefined,
  at: number,
): string {
  if (inFrame && sample !== undefined) {
    return `${String(boxCount)} stored at ${formatOffset(sample.offsetSeconds)}`;
  }
  if (sample === undefined) return 'nothing stored for this run';
  const ahead = sample.offsetSeconds > at;
  return `nearest stored frame ${formatOffset(sample.offsetSeconds)} · ${sample.deltaSeconds.toFixed(1)} s ${ahead ? 'ahead' : 'back'}`;
}

/**
 * How often to re-read `currentTime` while the recording plays, in milliseconds.
 *
 * ⛔ **`timeupdate` alone made the overlay a strobe** (V-17). Measured in Chrome on the reported
 * recording: the event fires every **266 ms** (median and max, 74 samples over 19 s), while the
 * tolerance window around an analysed frame is 500 ms wide. So one or two ticks land inside it and a
 * box was drawn for somewhere between 266 ms and 532 ms — *if* the ticks happened to straddle it.
 * The Architect saw the box on one of their three appearances and reported the other two as
 * undetected. They had been detected; the paint was shorter than a blink.
 *
 * ⚠️ 50 ms, not a frame callback. Ten samples inside the narrowest window is enough to make the
 * paint deterministic, and it costs 20 renders a second instead of 60 — `requestVideoFrameCallback`
 * would tie the render rate to the source's 27 fps for no additional certainty.
 */
export const OVERLAY_SAMPLE_MS = 50;
