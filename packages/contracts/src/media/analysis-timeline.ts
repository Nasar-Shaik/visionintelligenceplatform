/**
 * The **investigation timeline** (P-8 Phase 8, slice 4).
 *
 * ### ⭐ Derived, never stored
 *
 * Every value here is computed from the events one analysis session persisted. Nothing is written
 * down, and that is the point: a stored timeline can disagree with the events it claims to
 * summarise, and the disagreement surfaces months later in front of a customer. The events are the
 * record; this is a view of them.
 *
 * ### ⭐ Footage time, and the media offset beside it
 *
 * Every entry carries `offsetSeconds` — seconds from the start of the recording — as well as the
 * footage-clock `occurredAt`. The offset is what a scrubber, an evidence clip range and a "jump to
 * this moment" control all need, and deriving it in the browser would put the milestone's central
 * arithmetic in three places instead of one.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';

/**
 * One thing that happened, placed in the footage.
 *
 * ⚠️ It carries the event's own id so the timeline can link to the record it came from. A timeline
 * that cannot be traced back to its evidence is a picture, not an investigation.
 */
export const AnalysisTimelineEntry = z.object({
  eventId: z.string().min(1),
  type: z.string().min(1),
  /** Footage-clock instant. ⭐ Where in the recording, on the recording's own clock. */
  occurredAt: IsoDateTime,
  /** Seconds from the start of the recording. ⭐ The scrubber's x-axis. */
  offsetSeconds: z.number().min(0),
  /** What was seen — the subject's class, e.g. `person`. */
  label: z.string().min(1).max(120),
  /** ⚠️ `null` when the runtime returned no confidence, never 0 — see ADR-0039. */
  confidence: z.number().min(0).max(1).nullable(),
  /** The tracked identity, when the tracker gave one (ADR-0041). */
  trackId: z.string().min(1).optional(),
  /** The detection zone the subject was inside, when it was inside one (ADR-0044). */
  zoneId: z.string().min(1).optional(),
});
export type AnalysisTimelineEntry = z.infer<typeof AnalysisTimelineEntry>;

/**
 * ⭐ **One subject's span through the footage** — where a person entered and left the frame.
 *
 * ⚠️ Grouped by `trackId` and **not** by identity across gaps. `identityId` (ADR-0041) bridges an
 * occlusion, and a span drawn on it would render as one unbroken bar across a period the subject was
 * not visible — which is a claim the footage does not support. Two bars with a gap is the honest
 * picture, and the gap is often the interesting part.
 */
export const AnalysisTrackSpan = z.object({
  trackId: z.string().min(1),
  label: z.string().min(1).max(120),
  fromOffsetSeconds: z.number().min(0),
  toOffsetSeconds: z.number().min(0),
  /** Events attributed to this track. ⚠️ Sampled by the dedup window, not one per frame (L-57). */
  observations: z.number().int().min(1),
  /** Highest confidence seen. `null` when none was reported. */
  peakConfidence: z.number().min(0).max(1).nullable(),
});
export type AnalysisTrackSpan = z.infer<typeof AnalysisTrackSpan>;

/**
 * Detection density over the footage, for the lane a scrubber draws behind everything else.
 *
 * ⚠️ Bucketed rather than per-event because a four-hour analysis has more entries than a screen has
 * pixels, and sending them all so the browser can throw them away is a cost paid on every open.
 */
export const AnalysisDensityBucket = z.object({
  fromOffsetSeconds: z.number().min(0),
  toOffsetSeconds: z.number().min(0),
  count: z.number().int().min(0),
});
export type AnalysisDensityBucket = z.infer<typeof AnalysisDensityBucket>;

/** Buckets across the whole recording. ⚠️ Bounded, so a long analysis cannot produce a huge body. */
export const TIMELINE_BUCKETS = 120;

/**
 * ⛔ **How many events one timeline will read.**
 *
 * A ceiling exists because the alternative is an endpoint whose cost is set by how much footage a
 * customer uploaded. When it is hit the timeline says so (`truncated`) rather than presenting a
 * partial picture as a complete one.
 */
export const TIMELINE_MAX_EVENTS = 2000;

/**
 * An incident this run raised, placed in the footage.
 *
 * ⚠️ **`raisedAt` is deliberately absent.** An incident carries a wall-clock `raisedAt` — when the
 * analysis was executed — and putting it beside a footage-time offset on one row is how somebody
 * reads "18:30" as the time of day something happened. The timeline speaks one clock.
 */
export const AnalysisTimelineIncident = z.object({
  incidentId: z.string().min(1),
  title: z.string().min(1).max(300),
  status: z.string().min(1).max(40),
  severity: z.string().min(1).max(40).optional(),
  ruleId: z.string().min(1).optional(),
  /** Footage-clock instant of the triggering event. */
  occurredAt: IsoDateTime,
  /** Seconds from the start of the recording. */
  offsetSeconds: z.number().min(0),
});
export type AnalysisTimelineIncident = z.infer<typeof AnalysisTimelineIncident>;

export const AnalysisTimeline = z.object({
  analysisId: z.string().min(1),
  /** ⭐ The **run** this timeline describes. A rerun has its own, and they never merge (ADR-0047). */
  sessionId: z.string().min(1),
  tenantId: TenantId,
  cameraId: z.string().min(1),
  /** Footage-clock instant of offset 0. ⚠️ Operator-supplied — see `footageStartSource`. */
  footageStartedAt: IsoDateTime,
  /** Length of the recording, when the container declared one. */
  durationSeconds: z.number().min(0).optional(),
  entries: z.array(AnalysisTimelineEntry).max(TIMELINE_MAX_EVENTS),
  tracks: z.array(AnalysisTrackSpan).max(500),
  density: z.array(AnalysisDensityBucket).max(TIMELINE_BUCKETS),
  /** ⭐ What this run raised. ⚠️ Meaningless unless `incidentsAvailable` is `true`. */
  incidents: z.array(AnalysisTimelineIncident).max(500).default([]),
  /**
   * ⛔ **`true` means this timeline is incomplete.** The analysis produced more events than one
   * timeline reads, so what is shown is the earliest `TIMELINE_MAX_EVENTS` of them. Reported rather
   * than hidden, because "the first two thousand events" and "the events" are different claims about
   * an investigation and only one of them is true.
   */
  truncated: z.boolean(),
  /**
   * ⚠️ **Whether incidents could be looked up at all**, distinct from there being none.
   *
   * A deployment with no incident source answers `false`, and the console shows "not available"
   * rather than an empty lane that reads as "nothing was raised". Those are opposite answers to a
   * customer's question — the same rule ADR-0039 applies to a metric, applied to a whole lane.
   */
  incidentsAvailable: z.boolean(),
  /** When this view was computed. ⚠️ Wall clock — the only wall-clock value in the whole shape. */
  generatedAt: IsoDateTime,
});
export type AnalysisTimeline = z.infer<typeof AnalysisTimeline>;

/** Query for a timeline. ⚠️ Omitting `sessionId` means the latest run, never a merge of all runs. */
export const AnalysisTimelineQuery = z.object({
  sessionId: z.string().min(1).optional(),
});
export type AnalysisTimelineQuery = z.infer<typeof AnalysisTimelineQuery>;

// ---------------------------------------------------------------------------------------------
// Evidence snapshots (slice 6 — TD-15 for offline analysis)
// ---------------------------------------------------------------------------------------------

/**
 * Ask for a still from a point in the analysed recording.
 *
 * ⭐ **The offset is footage time, like everything else on the timeline.** An operator clicks a
 * moment on the scrubber, and that is the number that travels — no clock conversion in the browser.
 */
export const AnalysisSnapshotInput = z.object({
  /** Seconds from the start of the recording. */
  offsetSeconds: z.number().min(0),
  /** The incident this still is evidence for, when it is evidence for one. */
  incidentId: z.string().min(1).max(120).optional(),
  /** Longest edge, bounded so evidence cannot become a 4K still per incident. */
  maxWidth: z.number().int().min(160).max(3840).optional(),
});
export type AnalysisSnapshotInput = z.infer<typeof AnalysisSnapshotInput>;

export const AnalysisSnapshot = z.object({
  analysisId: z.string().min(1),
  sessionId: z.string().min(1),
  cameraId: z.string().min(1),
  /** Object key of the stored still. ⚠️ Tenant-prefixed, like every other object this service writes. */
  key: z.string().min(1),
  /** Signed URL a browser can open. ⚠️ Expires — see `expiresAt`. */
  url: z.string().min(1),
  expiresAt: IsoDateTime,
  /** Where in the footage it came from. */
  offsetSeconds: z.number().min(0),
  /** Footage-clock instant of that offset. ⭐ What the still is a picture OF, not when it was taken. */
  occurredAt: IsoDateTime,
  bytes: z.number().int().min(1),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  /** The incident it was captured for, when it was captured for one. */
  incidentId: z.string().min(1).optional(),
  /**
   * ⚠️ Whether it was also registered with the evidence service (custody, retention, export).
   *
   * `false` means the still exists and is signed but is **not** under evidence custody — a
   * deployment without an evidence service, or one that refused it. Reported rather than implied,
   * because "there is a picture" and "there is a picture that will survive retention and appear in
   * an export" are different promises.
   */
  registeredAsEvidence: z.boolean(),
});
export type AnalysisSnapshot = z.infer<typeof AnalysisSnapshot>;
