/**
 * Playback contracts (P-5.2.0, Architect rec 2) — **the evidence playback surface, frozen before
 * implementation**, and the immediate customer priority: recorded CCTV, no live camera required.
 *
 * ### ⚠️ Three decisions that shape everything below
 *
 * **1. A playback session is derived, never stored.** The obvious reading of "PlaybackSession" is a
 * server-side resource with a lifecycle. There is nothing to keep: the segments, markers and signed
 * URLs are all recomputed from records that already exist, and a stored session would go stale the
 * moment a URL expired while claiming to be current. So `PlaybackSession` is what a `GET` returns —
 * a resolved descriptor with a `derivedAt` — exactly like `ClipPlayback`, `IncidentTimeline` and
 * every other composed read on this platform (CONSTRAINTS §46).
 *
 * **2. View state is not a contract.** Zoom, playback speed, frame stepping and the current
 * position are the operator's browser, not the platform's data. Modelling them server-side would
 * invent persistence for something nobody stores and would put a write on the path of every scrub.
 * What *is* persisted is a bookmark — a deliberate act of saving a moment — and that is the one
 * thing here that is written down.
 *
 * **3. Bookmarks and annotations belong to the Incident context.** Evidence is immutable and that
 * immutability is the entire value of the Evidence Foundation. An annotation is an investigator's
 * *statement about* evidence, so it lives with the investigation and references the evidence by id
 * — see [CONTEXT_OWNERSHIP](../../../../docs/architecture/CONTEXT_OWNERSHIP.md) line 1. Nothing in
 * this file adds a mutable field to an evidence record, and nothing here may.
 */
import { z } from 'zod';
import { EventType, IsoDateTime, TenantId, Uuid } from '../common/primitives.js';
import { EventPriority } from '../events/priority.js';

// ---------------------------------------------------------------------------------------------
// What is being played
// ---------------------------------------------------------------------------------------------

/**
 * What a playback session is playing. Each resolves through a different context, and each is
 * already a persisted record — playback never invents a source.
 */
export const PlaybackSourceKind = z.enum([
  /** An Evidence Foundation clip (`EvidenceKind: 'clip'`) — immutable, chain-of-custody logged. */
  'evidence',
  /** A recorded segment from the Media catalog. */
  'recording',
  /** A Media clip: a named time range, possibly not yet materialised. */
  'clip',
  /**
   * An operator-uploaded file being reviewed before it becomes evidence. ⚠️ Reserved for the Demo
   * Readiness milestone; **no upload path exists** (TD-9 G-2).
   */
  'upload',
]);
export type PlaybackSourceKind = z.infer<typeof PlaybackSourceKind>;

export const PlaybackSource = z.object({
  kind: PlaybackSourceKind,
  /** The id of the record in its owning context. */
  id: z.string().min(1),
  cameraId: z.string().min(1).optional(),
  /** Absent for an upload with no known provenance — which is itself worth showing an operator. */
  incidentId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
});
export type PlaybackSource = z.infer<typeof PlaybackSource>;

/**
 * One playable object in the session, with its place on the wall clock.
 *
 * `url` is a **short-lived signed target** — media access is signed-URL only, never public
 * (STORAGE_ARCHITECTURE). It expires; the client re-requests the session rather than caching it.
 */
export const PlaybackSegment = z.object({
  /** Stable within one derivation — a React key and a scrub target, not a durable id. */
  id: z.string().min(1),
  key: z.string().min(1),
  url: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  contentType: z.string().min(1),
  codec: z.string().min(1).optional(),
  /** Wall-clock start of this segment's first frame. */
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  durationSeconds: z.number().nonnegative(),
  /** Offset of this segment's start from the session's `startedAt`, in seconds. */
  offsetSeconds: z.number().nonnegative(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type PlaybackSegment = z.infer<typeof PlaybackSegment>;

/**
 * ⚠️ **A hole in the recording, stated out loud.**
 *
 * Recorded CCTV is not continuous: a camera drops, a disk fills, a retention sweep purges the
 * middle of a day. A scrubber built over concatenated segments silently compresses those holes, so
 * the operator sees 14:00 run straight into 14:20 and reads it as twenty uneventful minutes. That
 * is the playback equivalent of an omitted timeline source (§63) and it is worse, because it is the
 * gap in the footage that an investigation is usually about.
 *
 * Every discontinuity between consecutive segments is reported here, and the console renders it as
 * a break in the track rather than closing it up.
 */
export const PlaybackGapReason = z.enum([
  /** No recording exists for this range — the camera was down, or was not recording. */
  'no-recording',
  /** The bytes were retained past their window and purged. The record may still exist. */
  'purged',
  /** The caller lacks permission for a segment in this range. */
  'forbidden',
  /** The owning context did not answer in time. */
  'unavailable',
]);
export type PlaybackGapReason = z.infer<typeof PlaybackGapReason>;

export const PlaybackGap = z.object({
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  durationSeconds: z.number().nonnegative(),
  offsetSeconds: z.number().nonnegative(),
  reason: PlaybackGapReason,
  detail: z.string().min(1).max(300),
});
export type PlaybackGap = z.infer<typeof PlaybackGap>;

// ---------------------------------------------------------------------------------------------
// What is marked on it
// ---------------------------------------------------------------------------------------------

/**
 * A point of interest on the track. **Derived** from records in other contexts — an event, an
 * incident transition, a piece of evidence — never authored.
 *
 * A bookmark (below) is the authored counterpart, and the two are deliberately different types: one
 * is a projection that changes when its source does, the other is something a person wrote down.
 */
export const PlaybackMarkerKind = z.enum([
  'event',
  'incident-raised',
  'incident-state-change',
  'evidence-captured',
  'detection',
]);
export type PlaybackMarkerKind = z.infer<typeof PlaybackMarkerKind>;

export const PlaybackMarker = z.object({
  id: z.string().min(1),
  kind: PlaybackMarkerKind,
  at: IsoDateTime,
  /** Seconds from the session's `startedAt`. Negative is impossible; a marker outside is dropped. */
  offsetSeconds: z.number().nonnegative(),
  /**
   * End of the marked interval, when it has one (P-5.2 rec 3, "timeline ranges"). Loitering,
   * tailgating and a queue building are **durations**, not instants — a point marker for a
   * four-minute loiter puts one tick at the start and hides the thing being investigated.
   * Absent ⇒ a point in time.
   */
  endAt: IsoDateTime.optional(),
  endOffsetSeconds: z.number().nonnegative().optional(),
  label: z.string().min(1).max(200),
  severity: EventPriority.optional(),
  /**
   * Detector confidence in [0,1], for `kind: 'detection'`. ⚠️ **Absent means absent** — not zero and
   * not certain. A detection rendered without its confidence is indistinguishable from an operator's
   * own mark, which is how a 0.31 guess ends up cited as an observation.
   */
  confidence: z.number().min(0).max(1).optional(),
  /**
   * What produced an AI marker, so a wrong one is traceable. ⚠️ **Advisory only** — a detection
   * marker never changes incident state, and no AI principal holds a permission that could
   * (P-5.1's boundary, unchanged).
   */
  producer: z.object({ name: z.string().min(1), version: z.string().min(1) }).optional(),
  eventId: z.string().min(1).optional(),
  eventType: EventType.optional(),
  evidenceId: z.string().min(1).optional(),
  incidentId: z.string().min(1).optional(),
});
export type PlaybackMarker = z.infer<typeof PlaybackMarker>;

/**
 * An operator's saved moment. **Persisted, and owned by the Workflow context** — it is part of an
 * investigation, not part of the footage.
 *
 * ⚠️ It stores `at` (wall clock) **and** `offsetSeconds`, and `at` is the authority. An offset is
 * meaningless the moment the session is derived over a different range — which happens as soon as
 * someone opens the bookmark from a different starting point.
 */
export const PlaybackBookmark = z.object({
  id: Uuid,
  tenantId: TenantId,
  incidentId: z.string().min(1),
  source: PlaybackSource,
  /** The authoritative instant. */
  at: IsoDateTime,
  /** Convenience for the session it was created in. Recomputed on read; never trusted from storage. */
  offsetSeconds: z.number().nonnegative().optional(),
  label: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
  createdBy: z.string().min(1),
  createdAt: IsoDateTime,
});
export type PlaybackBookmark = z.infer<typeof PlaybackBookmark>;

/**
 * A shape an investigator drew over a frame, with what they meant by it.
 *
 * ⚠️ **This is a statement about evidence, stored in the investigation.** Coordinates are
 * **normalised [0,1]**, so an annotation drawn on a 4K stream still lands correctly on a
 * downscaled review copy — pixel coordinates would silently drift the first time a resolution
 * changed.
 */
export const PlaybackAnnotationShape = z.enum(['box', 'point', 'polyline', 'freehand']);
export type PlaybackAnnotationShape = z.infer<typeof PlaybackAnnotationShape>;

export const PlaybackAnnotation = z.object({
  id: Uuid,
  tenantId: TenantId,
  incidentId: z.string().min(1),
  source: PlaybackSource,
  /** The frame this was drawn on, as wall clock. */
  at: IsoDateTime,
  shape: PlaybackAnnotationShape,
  /** Normalised [0,1] `[x, y]` pairs. A `box` is two points; a `point` is one. */
  points: z
    .array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]))
    .min(1)
    .max(200),
  label: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
  colour: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex colour')
    .optional(),
  createdBy: z.string().min(1),
  createdAt: IsoDateTime,
});
export type PlaybackAnnotation = z.infer<typeof PlaybackAnnotation>;

// ---------------------------------------------------------------------------------------------
// What the player may offer
// ---------------------------------------------------------------------------------------------

/**
 * ⚠️ **What this source actually supports** — the honest half of the feature list.
 *
 * The recommendation asks for frame stepping and variable speed. Both depend on the media: exact
 * frame stepping needs seekable, keyframe-dense video, and an un-materialised Media clip is a
 * *reference to a time range across segments*, which cannot be stepped frame-accurately at all.
 * Advertising the control anyway produces a button that does nothing on some sources and works on
 * others, with no way for an operator to know which — so capability is declared per session and the
 * console renders only what is offered.
 */
export const PlaybackCapabilities = z.object({
  /** Byte-range requests are supported, so scrubbing does not download the whole object. */
  seek: z.boolean(),
  /** Frame-accurate stepping. False for multi-segment or non-materialised sources. */
  frameStep: z.boolean(),
  /** Playback rates the source can sustain. `[1]` means normal speed only. */
  rates: z.array(z.number().positive()).min(1),
  /** A still frame can be extracted server-side into a new evidence record. */
  snapshot: z.boolean(),
  /** The range may be exported as a standalone file (a background job — see `JobKind`). */
  export: z.boolean(),
  /** Nominal frames per second, when the source declares one. Absent ⇒ unknown, never assumed 30. */
  frameRate: z.number().positive().optional(),
});
export type PlaybackCapabilities = z.infer<typeof PlaybackCapabilities>;

/**
 * The resolved playback descriptor — **derived per request, never stored** (decision 1 above).
 *
 * `startedAt`/`endedAt` are the wall-clock range the session covers, and every `offsetSeconds` in
 * it is relative to `startedAt`. `durationSeconds` is the **wall-clock span including gaps**, not
 * the sum of the segments: those two numbers differ exactly when footage is missing, and the
 * difference is the thing an investigator needs to see.
 */
export const PlaybackSession = z.object({
  tenantId: TenantId,
  source: PlaybackSource,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  durationSeconds: z.number().nonnegative(),
  /** Sum of the segment durations. `durationSeconds - playableSeconds` is the total missing time. */
  playableSeconds: z.number().nonnegative(),
  segments: z.array(PlaybackSegment).default([]),
  /** ⚠️ Empty means genuinely continuous. */
  gaps: z.array(PlaybackGap).default([]),
  markers: z.array(PlaybackMarker).default([]),
  bookmarks: z.array(PlaybackBookmark).default([]),
  annotations: z.array(PlaybackAnnotation).default([]),
  capabilities: PlaybackCapabilities,
  derivedAt: IsoDateTime,
});
export type PlaybackSession = z.infer<typeof PlaybackSession>;

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** Ask for a session over a source, optionally narrowed to a window and specific overlays. */
export const PlaybackSessionQuery = z.object({
  kind: PlaybackSourceKind,
  id: z.string().min(1),
  /** Narrow to a sub-range. Absent ⇒ the source's own range. */
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  /**
   * Overlays to resolve. **Opt-in**, because each costs an upstream call — the same budget
   * discipline as `IncidentTimeline` (§63). Omitted overlays come back as empty arrays *and* the
   * session says nothing was asked for, so a reader never mistakes one for the other.
   */
  include: z
    .array(z.enum(['markers', 'bookmarks', 'annotations']))
    .max(3)
    .default([]),
});
export type PlaybackSessionQuery = z.infer<typeof PlaybackSessionQuery>;

export const CreatePlaybackBookmarkInput = z.object({
  source: PlaybackSource,
  at: IsoDateTime,
  label: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
});
export type CreatePlaybackBookmarkInput = z.infer<typeof CreatePlaybackBookmarkInput>;

export const CreatePlaybackAnnotationInput = z.object({
  source: PlaybackSource,
  at: IsoDateTime,
  shape: PlaybackAnnotationShape,
  points: z
    .array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]))
    .min(1)
    .max(200),
  label: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
  colour: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex colour')
    .optional(),
});
export type CreatePlaybackAnnotationInput = z.infer<typeof CreatePlaybackAnnotationInput>;

/**
 * Extract a still frame.
 *
 * ⚠️ **This creates a new Evidence record; it never modifies the source.** A snapshot taken during
 * an investigation is a derived artefact with its own integrity hash and its own custody log,
 * carrying `source.recordingId`/`source.evidenceId` back to what it came from. "Export a snapshot"
 * must not mean "write a frame into the clip you took it from" — that would break the one property
 * the Evidence Foundation exists to guarantee.
 */
export const CapturePlaybackSnapshotInput = z.object({
  source: PlaybackSource,
  at: IsoDateTime,
  incidentId: z.string().min(1),
  label: z.string().min(1).max(200).optional(),
  note: z.string().max(2000).optional(),
  /** Attach the resulting evidence to the incident as an `IncidentAttachment`. */
  attachToIncident: z.boolean().default(true),
});
export type CapturePlaybackSnapshotInput = z.infer<typeof CapturePlaybackSnapshotInput>;

// ---------------------------------------------------------------------------------------------
// P-5.2 rec 3 — multiple sources and synchronized playback.
// ---------------------------------------------------------------------------------------------

/**
 * ⚠️ **How much the platform trusts a source's clock** — and the reason synchronized playback is
 * not simply "line up the timestamps".
 *
 * Two cameras' timestamps come from **two different clocks**. A cheap IP camera with no NTP drifts
 * by seconds a day; a camera that lost power comes back on a factory default. Aligning frames by
 * their recorded times and presenting the result as *simultaneous* is a claim about those clocks,
 * and it is the claim that decides whether a person appears at Door A before or after Door B.
 *
 * That is not a rendering detail. It is the difference between "the suspect left before the alarm"
 * and "after", from the same footage. So the confidence is carried on every member of a sync group,
 * and a group containing an unverified clock **says so** rather than drawing a confident wall.
 */
export const PlaybackClockConfidence = z.enum([
  /** The source's clock is disciplined by NTP/PTP and the platform has verified it. */
  'synchronised',
  /** The device's own clock, unverified. The usual case for CCTV, and the reason this enum exists. */
  'device-clock',
  /** ⚠️ Not knowable — a legacy recording, or an upload with no clock provenance at all. */
  'unknown',
]);
export type PlaybackClockConfidence = z.infer<typeof PlaybackClockConfidence>;

export const PlaybackClockAccuracy = z.object({
  confidence: PlaybackClockConfidence,
  /** Known offset from platform time, in seconds. Positive means the source runs fast. */
  offsetSeconds: z.number().optional(),
  /**
   * Worst-case misalignment. ⚠️ **Absent means unknown, never zero.** A `0` here asserts
   * frame-accurate alignment, which is exactly the claim an unverified device clock cannot support.
   */
  maxSkewSeconds: z.number().min(0).optional(),
});
export type PlaybackClockAccuracy = z.infer<typeof PlaybackClockAccuracy>;

/**
 * Budget for a synchronized wall. Each member is a full session resolution — segments, markers and
 * signed URLs — so nine members is nine fan-outs, and this number is the difference between a
 * feature and an outage on the busiest screen in the product.
 */
export const PLAYBACK_SYNC_MAX_SOURCES = 9;

export const PlaybackSyncMember = z.object({
  session: PlaybackSession,
  clock: PlaybackClockAccuracy,
  /** Display order in the wall. Stable so a re-derivation does not reshuffle the operator's grid. */
  order: z.number().int().min(0),
});
export type PlaybackSyncMember = z.infer<typeof PlaybackSyncMember>;

/**
 * Several sources played against **one wall clock** (rec 3).
 *
 * Every member's `offsetSeconds` is relative to this group's `startedAt`, not to its own session —
 * that is what makes the sources comparable, and it is computed here rather than in the client so
 * two consumers cannot disagree about the alignment.
 *
 * ⚠️ **`alignmentVerified` is false whenever any member's clock is not `synchronised`.** It is
 * derived, not asserted, so a wall containing one unverified camera cannot present itself as
 * verified — and the console renders the caveat beside the grid rather than in a tooltip nobody
 * opens.
 */
export const PlaybackSyncGroup = z.object({
  tenantId: TenantId,
  incidentId: z.string().min(1).optional(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  durationSeconds: z.number().nonnegative(),
  members: z.array(PlaybackSyncMember).min(1).max(PLAYBACK_SYNC_MAX_SOURCES),
  /** ⚠️ Derived from the members' clocks. See the note above. */
  alignmentVerified: z.boolean(),
  /** Required when `alignmentVerified` is false — which member, and why it could not be verified. */
  alignmentCaveat: z.string().min(1).max(300).optional(),
  derivedAt: IsoDateTime,
});
export type PlaybackSyncGroup = z.infer<typeof PlaybackSyncGroup>;

/** Ask for a synchronized wall over several sources sharing one time window. */
export const PlaybackSyncQuery = z.object({
  sources: z.array(PlaybackSource).min(1).max(PLAYBACK_SYNC_MAX_SOURCES),
  from: IsoDateTime,
  to: IsoDateTime,
  include: z
    .array(z.enum(['markers', 'bookmarks', 'annotations']))
    .max(3)
    .default([]),
});
export type PlaybackSyncQuery = z.infer<typeof PlaybackSyncQuery>;

/**
 * Whether a group's alignment can be claimed. Derived so the flag and the members cannot disagree
 * (CONSTRAINTS §46) — one function, used by the service and asserted by a test.
 */
export function alignmentIsVerified(members: readonly PlaybackSyncMember[]): boolean {
  return members.every((member) => member.clock.confidence === 'synchronised');
}
