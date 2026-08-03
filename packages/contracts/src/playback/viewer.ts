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
