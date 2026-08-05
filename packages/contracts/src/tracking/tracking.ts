/**
 * Tracking + spatial contracts (AI Processing Phase, AI-2) — the platform-owned **Track** and
 * **Zone** primitives, as fundamental as `Detection`/`DetectionResult`/`EventEnvelope`.
 *
 * The whole point (Architect AI-2 direction): **optimize for the Track contract, not for a tracker.**
 * Any engine — ByteTrack, BoT-SORT, DeepSORT, OC-SORT, or a custom tracker — sits behind a
 * `TrackerAdapter` and emits ONLY this `Track`, so a tracker swap never touches downstream consumers.
 *
 * Detection vs Track (kept independent throughout the platform — Architect AI-2 rec 5):
 *
 *     Detection  →  Track Association  →  Track
 *
 *   A **Detection** is a single observation in one frame; a **Track** is the continuous identity of an
 *   object across frames. Association (which observation belongs to which identity) is the tracker's
 *   only job; lifecycle bookkeeping is the TrackManager's. Downstream consumes `Track`, never a
 *   Detection or a tracker-specific object — so a tracker swap is invisible to consumers.
 *
 * Track-ID policy (Architect AI-2 rec 2):
 *   - **Uniqueness scope:** a `trackId` is unique per **tenant → camera → inference session**.
 *   - **Lifetime:** from `created` to `removed` within one session.
 *   - **Reuse:** **never reused within a running session** (ids are monotonic; removed ids not recycled).
 *   - **Reset:** the id space resets only when a new session starts (or the manager resets).
 *   - **Persistence:** session-scoped, NOT durable identity — cross-session/cross-camera association is
 *     a future capability (it would live in `attributes` / a global id map, not here).
 *
 * Other invariants: `cameraId` (+ optional `sessionId`) ride on every Track (never assume single-camera
 * → future cross-camera fusion); `quality` is additive metadata, not business logic; `history` is
 * bounded by the producer (max points / time window), never unbounded; `Zone` is PURE geometry +
 * metadata (business meaning is the Rule Engine's); `attributes` is the extension seam.
 *
 * Grounds: docs/architecture/future/AI_EXECUTION_ARCHITECTURE.md, 05/08/09; ADR-0002/0012.
 *
 * FROZEN — AI Runtime Architecture v1.0 (ED-0039): `Track` is one of the five frozen AI contracts.
 * Evolve ADDITIVELY only (optional fields); breaking changes require an ADR + major bump.
 *
 * ### P-8 Phase 4 — what was added, and what deliberately was not (ADR-0038)
 *
 * Added, all optional: `schemaVersion`, `motion`, `identityId`, `precededBy`, `recoveries`; plus the
 * new `TrackMotion`, `TrackTimelineEntry`, `TrackDetail` and `TrackingStats` shapes. Nothing existing
 * changed type, became required, or changed meaning — an archived v1.0 track still parses.
 *
 * ⚠️ **The id policy above was NOT relaxed, and that was the design decision of the phase.** The
 * obvious way to "handle re-entry" is to give a returning object its old `trackId` back. That would
 * break the one guarantee this contract makes — ids are never reused — and it would do so silently,
 * for every consumer already holding the earlier id. Re-entry is therefore a **link** (`identityId`,
 * `precededBy`), never a reassignment. See the note on `identityId`.
 *
 * ⚠️ **Tracking answers "where did object X move?" and never "was that suspicious?"** No field here
 * carries a judgement, a threshold or a business meaning — `dwellSeconds` is geometry, not loitering.
 * The Rule Engine assigns meaning; keeping that out of this file is what stops a vertical's semantics
 * from leaking into every consumer of a Track.
 */
import { z } from 'zod';
import { BBox, Confidence, IsoDateTime, TenantId } from '../common/primitives.js';

/** A point in normalized [0,1] image coordinates (pixel-space today; world-space is a future seam). */
export const Point2D = z.tuple([z.number(), z.number()]);
export type Point2D = z.infer<typeof Point2D>;

/**
 * Track lifecycle (Architect AI-2 rec 2). Counting/analytics act on `confirmed` tracks only, so a
 * flickering detector never double-counts. Semantics:
 *   created   — just instantiated from a first detection
 *   tentative — seen a few times; not yet trusted (min-hits not reached)
 *   confirmed — trusted continuous identity (drives counting/analytics)
 *   lost      — missed recent frames; coasting on prediction, may recover to confirmed
 *   removed   — exceeded max-age while lost; terminal
 */
export const TrackState = z.enum(['created', 'tentative', 'confirmed', 'lost', 'removed']);
export type TrackState = z.infer<typeof TrackState>;

/** One bounded point on a track's trajectory (Architect AI-2 rec 6 / history). */
export const TrackHistoryPoint = z.object({
  frameIndex: z.number().int().nonnegative(),
  at: IsoDateTime,
  bbox: BBox,
  centroid: Point2D.optional(),
});
export type TrackHistoryPoint = z.infer<typeof TrackHistoryPoint>;

/**
 * Lightweight track-quality indicators (Architect AI-2 rec 1) — additive metadata for behaviour
 * analytics / debugging / rule confidence, never business logic. All optional.
 */
export const TrackQuality = z
  .object({
    /** Tracker's own association confidence for the latest match (distinct from detection confidence). */
    trackingConfidence: Confidence.optional(),
    /** Estimated fraction of the object occluded in the latest frame. */
    occlusionRatio: z.number().min(0).max(1).optional(),
    /** Estimated visible fraction of the object. */
    visibility: z.number().min(0).max(1).optional(),
    /** Consecutive frames the track has coasted on prediction (no detection). */
    predictionFrames: z.number().int().nonnegative().optional(),
    /** Total frames the track has been in the `lost` state. */
    lostFrames: z.number().int().nonnegative().optional(),
  })
  .default({});
export type TrackQuality = z.infer<typeof TrackQuality>;

/**
 * The version of the `Track` shape itself (P-8 Phase 4).
 *
 * ⚠️ Distinct from the tracker that produced it. This answers **"how do I read this document?"** —
 * the question a consumer holding an archived track cannot answer from the engine name.
 *
 * `1.1` because the frozen v1.0 contract gained optional fields in P-8 Phase 4 (`schemaVersion`,
 * `motion`, `identityId`, `precededBy`, `recoveries`). Additive only; a breaking change needs an ADR
 * and a major bump (ED-0039).
 */
export const TRACK_SCHEMA_VERSION = '1.1';

/**
 * Movement derived from a track's own history (P-8 Phase 4, additive).
 *
 * ### ⚠️ Every distance here is in NORMALIZED IMAGE UNITS, not metres
 *
 * `bbox` and `centroid` are fractions of the frame, so a "speed" computed from them is **frame widths
 * per second** and nothing else. Converting to m/s needs camera calibration — intrinsics, mounting
 * height, tilt, and a ground-plane homography — none of which this platform has or asks for. The
 * fields are therefore named for what they are: a person walking towards the lens covers very few
 * normalized units while covering real metres, and a field called `speedMps` would be a fabricated
 * physical quantity in an evidence product.
 *
 * ### ⚠️ `headingDegrees` is IMAGE space, not compass bearing
 *
 * `0°` is +x (right), increasing **clockwise** because image `y` grows downward — so `90°` is down
 * the screen. It is not north-referenced and says nothing about which way the subject faced.
 */
export const TrackMotion = z.object({
  /** First seen → last seen, in seconds. Wall time, so it includes frames the track was lost for. */
  durationSeconds: z.number().nonnegative(),
  /** Sum of centroid steps along the retained history — the travelled path, in normalized units. */
  pathLengthNormalized: z.number().nonnegative(),
  /** Straight line from the first retained point to the latest, in normalized units. */
  displacementNormalized: z.number().nonnegative(),
  /** `pathLength / duration`, in normalized units per second. See the unit warning above. */
  averageSpeedNormalized: z.number().nonnegative(),
  /** Speed over the most recent steps only — what an operator sees as "moving now". */
  currentSpeedNormalized: z.number().nonnegative(),
  /**
   * Image-space heading of recent movement. ⚠️ Absent — never `0` — when the track has not moved far
   * enough to have a direction, because `0°` means "travelling right" and would be a claim.
   */
  headingDegrees: z.number().min(0).lt(360).optional(),
  /** The same heading as one of eight readable buckets, so a UI never re-derives it differently. */
  headingLabel: z
    .enum(['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'])
    .optional(),
  /** Cumulative seconds the track was effectively stationary — dwell, in the geometric sense only. */
  dwellSeconds: z.number().nonnegative(),
  /** `displacement / pathLength`: 1 is a straight line, near 0 is milling about. Absent if unmoved. */
  straightness: z.number().min(0).max(1).optional(),
  /**
   * ⚠️ How much of the retained history this was computed from. History is **bounded**, so a
   * long-lived track's `pathLength` describes its recent past, not its whole life — and a consumer
   * that does not know the sample count cannot tell those apart.
   */
  samples: z.number().int().nonnegative(),
});
export type TrackMotion = z.infer<typeof TrackMotion>;

/**
 * A continuous object identity across frames — the platform-owned Track. Engine-agnostic: produced by
 * any `TrackerAdapter`, consumed by zones/counting/behaviour/events without knowing the tracker.
 */
export const Track = z.object({
  /** How to read this document. Optional so archived v1.0 tracks stay valid; the runtime stamps it. */
  schemaVersion: z.string().min(1).optional(),
  trackId: z.string().min(1),
  tenantId: TenantId,
  /** Owning camera — carried on every Track (multi-camera-ready; trackId is scoped per (tenant,camera)). */
  cameraId: z.string().min(1),
  /** Inference session this track belongs to (the third scope of the trackId — see id policy above). */
  sessionId: z.string().min(1).optional(),
  label: z.string().min(1),
  classId: z.number().int().nonnegative().optional(),
  state: TrackState,
  /** Detection confidence of the latest associated observation. */
  confidence: Confidence,
  /** Latest position `[x, y, w, h]` in normalized [0,1] image coordinates. */
  bbox: BBox,
  centroid: Point2D.optional(),
  firstSeen: z.object({ frameIndex: z.number().int().nonnegative(), at: IsoDateTime }),
  lastSeen: z.object({ frameIndex: z.number().int().nonnegative(), at: IsoDateTime }),
  /** Frames since the track was created. */
  age: z.number().int().nonnegative(),
  /** Number of detections associated to this track. */
  hits: z.number().int().nonnegative(),
  quality: TrackQuality,
  /** Bounded trajectory (producer caps by count or time window). */
  history: z.array(TrackHistoryPoint).default([]),
  /** Movement derived from `history` (P-8 Phase 4). Absent when the producer computes none. */
  motion: TrackMotion.optional(),
  /**
   * Identity across a *gap the tracker could not bridge* (P-8 Phase 4, additive).
   *
   * ### ⚠️ Why this is not just the trackId
   *
   * The frozen id policy above says a `trackId` is **never reused within a session**, and that stays
   * true: when an object leaves and comes back, the new track gets a **new** `trackId`. Recycling the
   * old one would make two different observation series share an identifier, and any consumer holding
   * the earlier one — an event, an evidence reference, a rule's memory — would silently start
   * referring to a different appearance.
   *
   * So re-entry is expressed as a **link, not an overwrite**: `identityId` is equal to the
   * `trackId` of the first track in the chain, and `precededBy` names the immediate predecessor. A
   * consumer that wants "the same person" groups by `identityId`; one that wants "this uninterrupted
   * observation" uses `trackId`. Both questions are legitimate and they are different questions.
   *
   * ⚠️ Occlusion **shorter** than the tracker's tolerance is not a re-entry at all — the same
   * `trackId` survives it, and `quality.lostFrames` records that it happened.
   */
  identityId: z.string().min(1).optional(),
  /** The `trackId` this track re-entered from, when the engine linked one. */
  precededBy: z.string().min(1).optional(),
  /** How many times this identity has been re-linked across a gap. `0` for a first appearance. */
  recoveries: z.number().int().nonnegative().optional(),
  /** Generic extension map (no industry semantics; world-coordinates/dwell land here later). */
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type Track = z.infer<typeof Track>;

/**
 * One entry in a track's lifecycle timeline (P-8 Phase 4) — what happened to this identity and when.
 *
 * ⚠️ **Append-only and never rewritten.** The timeline is the audit trail of an identity: a track
 * that was lost and recovered must still show that it was lost, because "was this the same person
 * throughout?" is exactly the question an investigator asks, and a timeline that quietly smoothed the
 * gap would answer it wrongly with total confidence.
 */
export const TrackTimelineEntry = z.object({
  frameIndex: z.number().int().nonnegative(),
  at: IsoDateTime,
  from: TrackState.nullable().optional(),
  to: TrackState,
  /** Why the transition happened, when the engine can say — e.g. `re-entry`, `max-age exceeded`. */
  reason: z.string().min(1).optional(),
});
export type TrackTimelineEntry = z.infer<typeof TrackTimelineEntry>;

/** A track plus its lifecycle — what the Track Detail and Track Timeline pages read. */
export const TrackDetail = z.object({
  track: Track,
  timeline: z.array(TrackTimelineEntry).default([]),
});
export type TrackDetail = z.infer<typeof TrackDetail>;

/**
 * Aggregate tracking observability for one runtime (P-8 Phase 4).
 *
 * ⚠️ Counts only, and every one of them is **measured or absent** — never a placeholder zero. A
 * runtime that has tracked nothing reports `null` for the derived averages, because `0.0 s average
 * track lifetime` and "nothing has been tracked" look identical on a dashboard and mean opposite
 * things.
 */
export const TrackingStats = z.object({
  /** Cameras with tracking state right now. ⚠️ Cameras being *analysed*, not cameras configured. */
  camerasTracked: z.number().int().nonnegative(),
  activeTracks: z.number().int().nonnegative(),
  confirmedTracks: z.number().int().nonnegative(),
  tentativeTracks: z.number().int().nonnegative(),
  lostTracks: z.number().int().nonnegative(),
  /** Tracks that reached the terminal state over this runtime's life. */
  removedTracks: z.number().int().nonnegative(),
  /** Tracks created in total — the denominator for identity stability. */
  createdTracks: z.number().int().nonnegative(),
  /** Identities re-linked across a gap (`precededBy` was set). */
  recoveredTracks: z.number().int().nonnegative(),
  /** Frames in which the engine ran. */
  framesTracked: z.number().int().nonnegative(),
  /** Mean wall-clock cost of the association + lifecycle stage, per frame. */
  averageTrackingMs: z.number().nonnegative().nullable(),
  averageTrackLifetimeSeconds: z.number().nonnegative().nullable(),
  averageTrackHits: z.number().nonnegative().nullable(),
  /**
   * ⚠️ **Not an accuracy metric.** Tracks created per confirmed track: an engine that fragments one
   * person into six identities scores 6.0, and one that never confirms anything scores `null`. It
   * measures fragmentation, which is a *symptom* of identity switching — proving that two identities
   * were genuinely swapped needs ground truth the runtime does not have.
   */
  fragmentation: z.number().nonnegative().nullable(),
});
export type TrackingStats = z.infer<typeof TrackingStats>;

// --- Zones (pure geometry) ----------------------------------------------------------------------

/** `area` = a closed polygon (occupancy/entry); `line` = an ordered polyline (directional crossing). */
export const ZoneKind = z.enum(['area', 'line']);
export type ZoneKind = z.infer<typeof ZoneKind>;

/** Geometry in normalized [0,1] coordinates: ≥3 points for an area, ≥2 for a line. */
export const ZoneGeometry = z.object({ points: z.array(Point2D).min(2) });
export type ZoneGeometry = z.infer<typeof ZoneGeometry>;

/**
 * A generic spatial region — PURE geometry + metadata. No business type (no CashCounterZone/ExitZone);
 * meaning is assigned by the Rule Engine via `attributes`. Configuration-driven.
 */
export const Zone = z.object({
  id: z.string().min(1),
  cameraId: z.string().min(1),
  name: z.string().min(1),
  kind: ZoneKind,
  geometry: ZoneGeometry,
  /** Generic metadata the Rule Engine interprets (e.g. `{ purpose: "entrance" }`). */
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type Zone = z.infer<typeof Zone>;

/** A confirmed track entering/exiting a zone (business-neutral geometry event). */
export const ZoneTransition = z.object({
  tenantId: TenantId,
  cameraId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  zoneId: z.string().min(1),
  trackId: z.string().min(1),
  transition: z.enum(['entered', 'exited']),
  frameIndex: z.number().int().nonnegative(),
  at: IsoDateTime,
  /** Event confidence derived from track quality (Architect AI-2 rec 5) — additive, not business logic. */
  confidence: Confidence.optional(),
});
export type ZoneTransition = z.infer<typeof ZoneTransition>;

/** A business-neutral counting/occupancy snapshot for a zone (drives analytics events). */
export const CountingSnapshot = z.object({
  tenantId: TenantId,
  cameraId: z.string().min(1),
  zoneId: z.string().min(1),
  entered: z.number().int().nonnegative(),
  exited: z.number().int().nonnegative(),
  /** Current occupancy (entered − exited, floored at 0). */
  occupancy: z.number().int().nonnegative(),
  at: IsoDateTime,
});
export type CountingSnapshot = z.infer<typeof CountingSnapshot>;
