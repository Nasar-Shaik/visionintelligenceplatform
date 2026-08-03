/**
 * Evidence Viewer contracts (P-5.2, Architect rec 6) — **frozen now, implemented later**.
 *
 * The instruction was to freeze viewer capabilities so the contract does not change when the
 * implementation arrives: zoom, rotate, brightness, contrast, frame advance, frame compare,
 * picture-in-picture, metadata, evidence hash, chain of custody, synchronized playback.
 *
 * Most of that is view state and belongs in the browser (see `playback.ts`, decision 2). Two things
 * in the list are not, and they are the reason this file exists rather than a boolean on the panel.
 *
 * ### ⚠️ 1. Brightness and contrast change what the evidence looks like
 *
 * Lifting the shadows on a dark clip is a legitimate, standard investigative technique — and it is
 * also how a shape becomes a person. The adjustment is not the problem; the problem is an adjusted
 * frame that travels without its adjustment. An operator brightens a clip, exports a snapshot, and
 * the snapshot lands in a report where it is indistinguishable from the original.
 *
 * So an adjustment is a **recorded value on the derived artefact**, not a transient slider:
 * `EvidenceViewAdjustment` is carried on any snapshot captured while it was applied, and a viewer
 * showing adjusted footage must say so on the surface, not in a menu. The original media is never
 * touched — that is the Evidence Foundation's guarantee and nothing here weakens it.
 *
 * ### ⚠️ 2. Integrity and custody are displayed, never recomputed here
 *
 * The viewer shows `EvidenceIntegrity.hash` and the custody chain because an investigator needs to
 * know the artefact is the one that was captured. It **reads** them from the Evidence context. A
 * viewer that recomputed a hash client-side would be a second implementation of the platform's
 * tamper-evidence, and the first divergence between the two would be indistinguishable from
 * tampering.
 */
import { z } from 'zod';
import { IsoDateTime } from '../common/primitives.js';

/**
 * What a viewer may offer for a given evidence item. Declared per item, like
 * `PlaybackCapabilities` — an image supports rotate and zoom but not frame advance, and offering a
 * control that silently does nothing is worse than not offering it.
 */
export const EvidenceViewerCapabilities = z.object({
  zoom: z.boolean(),
  rotate: z.boolean(),
  /** Brightness/contrast adjustment. ⚠️ See the header — an adjustment is recorded, not transient. */
  adjust: z.boolean(),
  /** Frame-by-frame stepping. False for stills and for non-materialised clips. */
  frameAdvance: z.boolean(),
  /** Side-by-side comparison with another evidence item or another moment. */
  compare: z.boolean(),
  /** Picture-in-picture, so footage stays visible while the operator writes their note. */
  pictureInPicture: z.boolean(),
  /** The manifest, overlay metadata and AI sidecar are viewable. */
  metadata: z.boolean(),
  /** The integrity hash is displayed. */
  integrity: z.boolean(),
  /** The chain-of-custody log is viewable (needs `evidence:read`; every view is itself audited). */
  custody: z.boolean(),
  /** This item can join a `PlaybackSyncGroup`. */
  synchronised: z.boolean(),
});
export type EvidenceViewerCapabilities = z.infer<typeof EvidenceViewerCapabilities>;

/**
 * A visual adjustment applied while viewing.
 *
 * ⚠️ **Recorded on anything derived from the adjusted view**, so an exported snapshot carries the
 * fact that it was brightened. Values are multipliers around 1.0 (`1` = untouched), and `rotate` is
 * a quarter-turn count, because arbitrary rotation resamples the image and a resampled frame is a
 * new image rather than the same one turned around.
 */
export const EvidenceViewAdjustment = z.object({
  brightness: z.number().min(0.1).max(4).default(1),
  contrast: z.number().min(0.1).max(4).default(1),
  /** Quarter turns clockwise: 0, 1, 2 or 3. Lossless. */
  rotateQuarters: z.number().int().min(0).max(3).default(0),
  zoom: z.number().min(1).max(32).default(1),
});
export type EvidenceViewAdjustment = z.infer<typeof EvidenceViewAdjustment>;

/** True when the adjustment changes what the viewer sees — the test for "must be disclosed". */
export function isAdjusted(adjustment: EvidenceViewAdjustment): boolean {
  return (
    adjustment.brightness !== 1 || adjustment.contrast !== 1 || adjustment.rotateQuarters !== 0
  );
}

/**
 * Two items or moments shown side by side (rec 6, "frame compare").
 *
 * Each side carries its own adjustment, because comparing a brightened frame against an untouched
 * one is exactly the comparison that needs labelling.
 */
export const EvidenceComparison = z.object({
  leftEvidenceId: z.string().min(1),
  rightEvidenceId: z.string().min(1),
  leftAt: IsoDateTime.optional(),
  rightAt: IsoDateTime.optional(),
  leftAdjustment: EvidenceViewAdjustment.optional(),
  rightAdjustment: EvidenceViewAdjustment.optional(),
  /** ⚠️ False when either side is adjusted — the comparison is not like-for-like and must say so. */
  likeForLike: z.boolean(),
});
export type EvidenceComparison = z.infer<typeof EvidenceComparison>;

// ---------------------------------------------------------------------------------------------
// P-5.3 — the professional player and timeline surfaces (mid-milestone requirements 1–3).
// ---------------------------------------------------------------------------------------------

/**
 * ⚠️ **Original or Enhanced — the label, as a contract rather than a UI decision.**
 *
 * The requirement is that any display adjustment be *visibly marked*. Making the mode a value
 * carried on the view (and on anything derived from it) rather than a badge a component decides to
 * render means a renderer cannot forget it: a snapshot, an export or a report section produced from
 * an adjusted view carries `enhanced`, and the marking follows the artefact out of the browser.
 *
 * A badge that lives only on the screen is lost the moment someone screenshots the screen — which
 * is exactly how an enhanced frame ends up in a report presented as the original.
 */
export const EvidenceViewMode = z.enum(['original', 'enhanced']);
export type EvidenceViewMode = z.infer<typeof EvidenceViewMode>;

/** The mode a set of adjustments puts the view in. Derived, so the label cannot disagree. */
export function viewMode(adjustment: EvidenceViewAdjustment | undefined): EvidenceViewMode {
  return adjustment !== undefined && isAdjusted(adjustment) ? 'enhanced' : 'original';
}

/**
 * What the player may show over the picture. Overlays are **additive to the presentation, never to
 * the media** — the original bytes are untouched, which is the Evidence Foundation's guarantee.
 */
export const EvidencePlayerOverlay = z.enum([
  /** Burned-in wall-clock time. ⚠️ Rendered by the player from the manifest, never trusted from the
   * picture itself: a camera's own burned-in clock is the device's claim, not the platform's. */
  'timestamp',
  /** Camera, zone, capture reason, integrity hash. */
  'metadata',
  /** Detection boxes, normalised [0,1]. */
  'detections',
  /** Investigator annotations. */
  'annotations',
]);
export type EvidencePlayerOverlay = z.infer<typeof EvidencePlayerOverlay>;

/**
 * The player's declared surface (mid-milestone requirement 2). **Reserved: not implemented.**
 *
 * ⚠️ Every field here is a *capability*, not a setting, for the reason `PlaybackCapabilities`
 * exists: frame stepping needs seekable keyframe-dense media, and an un-materialised clip cannot do
 * it at all. A control offered on a source that cannot perform it is worse than an absent one.
 */
export const EvidencePlayerSurface = z.object({
  capabilities: EvidenceViewerCapabilities,
  /** Overlays this source can render. Empty is legitimate — a still has no detections. */
  overlays: z.array(EvidencePlayerOverlay).max(4).default([]),
  fullscreen: z.boolean(),
  pictureInPicture: z.boolean(),
  /** Speeds the player offers. Mirrors `PlaybackCapabilities.rates`; never wider. */
  rates: z.array(z.number().positive()).min(1),
  /** ⚠️ The current mode, so the "Enhanced View" marking is part of the surface's state. */
  mode: EvidenceViewMode.default('original'),
});
export type EvidencePlayerSurface = z.infer<typeof EvidencePlayerSurface>;

/**
 * What a professional investigation timeline draws (mid-milestone requirement 1). **Reserved.**
 *
 * ⚠️ **`missing-footage` is a track, not a styling choice.** Every other track is something that
 * happened; this one is the absence of recording, and it is the one an investigation most often
 * turns on. Modelling it as a first-class track means a renderer cannot quietly omit it, and a
 * consumer that does not understand the kind still shows *something* rather than closing the gap.
 */
export const PlaybackTimelineTrackKind = z.enum([
  'evidence',
  'ai-detection',
  'rule-trigger',
  'annotation',
  'bookmark',
  'exported-segment',
  /** ⚠️ See above. Sized to real elapsed time, never compressed away. */
  'missing-footage',
]);
export type PlaybackTimelineTrackKind = z.infer<typeof PlaybackTimelineTrackKind>;

export const PlaybackTimelineTrack = z.object({
  kind: PlaybackTimelineTrackKind,
  label: z.string().min(1).max(80),
  /** Ordered spans on the track. A point is a span whose end equals its start. */
  spans: z
    .array(
      z.object({
        id: z.string().min(1),
        offsetSeconds: z.number().nonnegative(),
        endOffsetSeconds: z.number().nonnegative(),
        label: z.string().max(200).optional(),
        ref: z.string().min(1).max(200).optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(2000)
    .default([]),
  /** ⚠️ Present when the track itself could not be resolved — never rendered as an empty track. */
  unavailableReason: z.string().min(1).max(300).optional(),
});
export type PlaybackTimelineTrack = z.infer<typeof PlaybackTimelineTrack>;

/**
 * ⚠️ **What the operator is actually looking at** (mid-milestone requirement 5).
 *
 * Reserved because a control room cannot afford ambiguity here: an operator who believes they are
 * watching live when they are watching a recording will make a decision about a situation that
 * ended twenty minutes ago. The distinction belongs on the surface, in words, at all times.
 */
export const InvestigationMode = z.enum([
  /** A live stream. ⚠️ No live path exists in this build. */
  'live',
  /** Recorded footage under operator control — the immediate product priority. */
  'playback',
  /** A past incident being reviewed after the fact; footage may be partly purged. */
  'historical',
  /** Working from an exported bundle with no platform connection. */
  'offline',
  /** Nothing can be shown, and the surface says why. */
  'unavailable',
]);
export type InvestigationMode = z.infer<typeof InvestigationMode>;
