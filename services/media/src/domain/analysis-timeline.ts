/**
 * Domain: assembling the investigation timeline from persisted events (P-8 Phase 8, slice 4).
 *
 * ⭐ **Pure and total.** Everything a customer reads off the timeline — where a person entered, how
 * long they were visible, how busy a minute was — is decided here, from values, so it can be driven
 * from a test rather than observed in a deployment and hoped about.
 *
 * ⚠️ **This file derives; it never counts frames.** The events it reads are already sampled by the
 * events service's dedup window ([L-57]), so an "observation" is a *bucket in which the subject was
 * seen*, not a frame. Presenting them as frames would overstate what the platform measured — see
 * `AnalysisTrackSpan.observations`.
 */
import {
  TIMELINE_BUCKETS,
  type AnalysisDensityBucket,
  type AnalysisTimelineEntry,
  type AnalysisTrackSpan,
  type EventEnvelope,
} from '@vip/contracts';

/**
 * Where an event sits in the recording.
 *
 * ⛔ **Clamped at zero, and never negative.** An event can precede `footageStartedAt` when an
 * operator corrects the footage start *after* a run — the events keep the time they were analysed
 * with. A negative offset would render off the left edge of every scrubber; clamping puts it at the
 * start, which is where it belongs, and the analysis's own `footageStartSource` says the start was
 * a claim rather than a measurement.
 */
export function offsetSeconds(occurredAt: string, footageStartedAt: string): number {
  const at = Date.parse(occurredAt);
  const start = Date.parse(footageStartedAt);
  if (Number.isNaN(at) || Number.isNaN(start)) return 0;
  return Math.max(0, (at - start) / 1000);
}

/** Project one persisted event onto the timeline. */
export function toEntry(event: EventEnvelope, footageStartedAt: string): AnalysisTimelineEntry {
  const subject = event.subjects[0];
  const label = subject?.class ?? 'object';
  return {
    eventId: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    offsetSeconds: offsetSeconds(event.occurredAt, footageStartedAt),
    label,
    /*
     * ⚠️ `null`, not 0, when the producer reported none (ADR-0039). A timeline showing "0 %
     * confidence" beside a detection the model was sure about is worse than showing nothing.
     */
    confidence: typeof event.confidence === 'number' ? event.confidence : null,
    ...(subject?.trackId === undefined ? {} : { trackId: subject.trackId }),
    ...(event.zoneId === undefined ? {} : { zoneId: event.zoneId }),
    /*
     * ⭐ **The box, carried through rather than projected away** (P-8.6).
     *
     * ⚠️ Taken from the SAME subject the label, confidence and track id came from — `subjects[0]`.
     * Reading it from a different index would attach one person's box to another's identity, which
     * is a wrong answer that looks entirely plausible on screen.
     */
    ...(subject?.bbox === undefined ? {} : { bbox: subject.bbox }),
  };
}

/**
 * ⭐ **One bar per tracked subject**, from first sighting to last.
 *
 * ⚠️ Grouped by `trackId`, deliberately not by `identityId`. Identity bridges an occlusion
 * (ADR-0041), so a span drawn on it would be one unbroken bar across a period the subject was **not
 * visible** — a claim the footage does not support. Two bars with a gap between them is the honest
 * picture, and the gap is frequently the thing an investigator is looking for.
 */
export function toTrackSpans(entries: readonly AnalysisTimelineEntry[]): AnalysisTrackSpan[] {
  const byTrack = new Map<string, AnalysisTrackSpan>();
  for (const entry of entries) {
    if (entry.trackId === undefined) continue;
    const existing = byTrack.get(entry.trackId);
    if (existing === undefined) {
      byTrack.set(entry.trackId, {
        trackId: entry.trackId,
        label: entry.label,
        fromOffsetSeconds: entry.offsetSeconds,
        toOffsetSeconds: entry.offsetSeconds,
        observations: 1,
        peakConfidence: entry.confidence,
      });
      continue;
    }
    /*
     * ⚠️ Both ends are widened rather than assuming the input is ordered. The store returns events
     * newest-first, and a span built by trusting an order it was not promised is a bar that renders
     * backwards — with `from` after `to` — which no consumer would think to guard against.
     */
    existing.fromOffsetSeconds = Math.min(existing.fromOffsetSeconds, entry.offsetSeconds);
    existing.toOffsetSeconds = Math.max(existing.toOffsetSeconds, entry.offsetSeconds);
    existing.observations += 1;
    if (entry.confidence !== null) {
      existing.peakConfidence =
        existing.peakConfidence === null
          ? entry.confidence
          : Math.max(existing.peakConfidence, entry.confidence);
    }
  }
  return [...byTrack.values()].sort(
    (a, b) => a.fromOffsetSeconds - b.fromOffsetSeconds || a.trackId.localeCompare(b.trackId),
  );
}

/**
 * Detection density across the recording, in a fixed number of buckets.
 *
 * ⚠️ **Fixed count, not fixed width.** A scrubber is a fixed number of pixels wide whatever the
 * footage length, so buckets that scaled with duration would send a four-hour analysis thousands of
 * values to be averaged away in the browser, and a thirty-second one three.
 */
export function toDensity(
  entries: readonly AnalysisTimelineEntry[],
  durationSeconds: number | undefined,
  buckets = TIMELINE_BUCKETS,
): AnalysisDensityBucket[] {
  /*
   * ⚠️ Falls back to the last event's offset when the container declared no duration — and to
   * nothing at all when there are no events. An empty array is the honest answer for "no footage
   * length and no observations"; inventing a single zero-width bucket would draw a lane implying a
   * recording of zero length.
   */
  const span =
    durationSeconds !== undefined && durationSeconds > 0
      ? durationSeconds
      : entries.reduce((max, e) => Math.max(max, e.offsetSeconds), 0);
  if (span <= 0 || buckets <= 0) return [];

  const width = span / buckets;
  const counts = new Array<number>(buckets).fill(0);
  for (const entry of entries) {
    /*
     * ⚠️ The last bucket is inclusive of the end. Without the clamp an event at exactly the final
     * offset indexes one past the array and is silently dropped — and the final moment of a
     * recording is disproportionately likely to be the one somebody is looking for.
     */
    const index = Math.min(buckets - 1, Math.floor(entry.offsetSeconds / width));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts.map((count, i) => ({
    fromOffsetSeconds: i * width,
    toOffsetSeconds: (i + 1) * width,
    count,
  }));
}
