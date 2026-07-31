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
 * A continuous object identity across frames — the platform-owned Track. Engine-agnostic: produced by
 * any `TrackerAdapter`, consumed by zones/counting/behaviour/events without knowing the tracker.
 */
export const Track = z.object({
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
  /** Generic extension map (no industry semantics; world-coordinates/dwell land here later). */
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type Track = z.infer<typeof Track>;

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
