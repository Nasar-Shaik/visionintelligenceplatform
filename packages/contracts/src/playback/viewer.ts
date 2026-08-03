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
import type { DerivedArtifact } from '../evidence/derived.js';
import { isDestructive } from '../evidence/derived.js';

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
 * How a comparison is arranged (P-5.4). ⚠️ Presentation only — every mode shows both artefacts
 * unaltered, and `before-after` in particular does **not** imply one was derived from the other.
 */
export const EvidenceComparisonMode = z.enum([
  /** Two panes, both fully visible. */
  'side-by-side',
  /** A draggable divider over one frame. */
  'before-after',
  /** Two frames at the same instant, stepped together. */
  'frame',
]);
export type EvidenceComparisonMode = z.infer<typeof EvidenceComparisonMode>;

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
  /** How the two sides are arranged (P-5.4). Presentation only; neither side is altered. */
  mode: EvidenceComparisonMode.default('side-by-side'),
  /**
   * Play both sides against one clock (P-5.4).
   *
   * ⚠️ **Only meaningful when the two sources' clocks can be reconciled.** Two cameras compared
   * "synchronously" on unverified device clocks assert a simultaneity nobody measured — the same
   * claim `PlaybackClockConfidence` exists to qualify. When this is true and the underlying group
   * is not verified, the surface carries the group's caveat; it does not quietly drop it.
   */
  synchronised: z.boolean().default(false),
  /**
   * Offset applied to the right side to line the two up, in seconds (P-5.4, "timeline alignment").
   *
   * ⚠️ Absent means **not aligned**, never zero. A `0` asserts the two are already in step, which is
   * precisely the claim an operator dragging one track into place has not yet made.
   */
  alignmentOffsetSeconds: z.number().optional(),
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
export const EvidenceViewMode = z.enum([
  /** The stored bytes, shown as captured. */
  'original',
  /** The stored bytes, with a **reversible display adjustment** — brightness, contrast, zoom. */
  'enhanced',
  /**
   * ⚠️ A **different artefact**: information has been irreversibly removed (blur, mask, crop, trim).
   *
   * P-5.4 added this. Showing a redacted copy labelled `original` is the exact failure §75 exists to
   * prevent, one layer up: the operator concludes the bystander was never in frame.
   */
  'redacted',
  /**
   * ⚠️ A different artefact produced by a non-destructive render — transcoded, scaled, watermarked.
   *
   * Distinct from `enhanced` because the change is **in the file, not in the viewer**: closing the
   * adjustment panel restores an enhanced view to the original, and does nothing at all to this one.
   */
  'derived',
]);
export type EvidenceViewMode = z.infer<typeof EvidenceViewMode>;

/**
 * The mode a view is in. Derived, so the label cannot disagree with the artefact.
 *
 * ⚠️ **Provenance outranks adjustment.** A derived artefact is `redacted` or `derived` whatever the
 * viewer is doing to it — brightening a redacted clip does not make it "enhanced", it makes it a
 * brightened redaction, and the stronger of the two claims is the one an operator needs on screen.
 * Order matters here and is asserted by a test.
 */
export function viewMode(
  adjustment: EvidenceViewAdjustment | undefined,
  derivation?: DerivedArtifact | undefined,
): EvidenceViewMode {
  if (derivation !== undefined) return isDestructive(derivation) ? 'redacted' : 'derived';
  return adjustment !== undefined && isAdjusted(adjustment) ? 'enhanced' : 'original';
}

/**
 * ⚠️ Modes that must be shown **prominently and persistently**, not in a tooltip (refinement 4).
 *
 * Exported as data so the console asserts on it rather than a designer remembering. `original` is
 * absent because it is the default state and a permanent "this is the original" badge trains
 * operators to stop reading badges — which is what makes the other three invisible.
 */
export const MODES_REQUIRING_PROMINENT_LABEL = ['enhanced', 'redacted', 'derived'] as const;

/** Does this mode require the persistent on-screen marking? */
export function requiresProminentLabel(mode: EvidenceViewMode): boolean {
  return (MODES_REQUIRING_PROMINENT_LABEL as readonly string[]).includes(mode);
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

// ---------------------------------------------------------------------------------------------
// P-5.4 rec 7 — the timeline heatmap
// ---------------------------------------------------------------------------------------------

/**
 * What a heatmap band counts. One band per kind, so an operator can see *what* is dense rather than
 * only *that* something is.
 *
 * ⚠️ `motion` is listed because the recommendation asks for it, and it is the one band with **no
 * producer of any kind**: nothing in this platform emits a motion signal — detections come from the
 * AI runtime and are a different thing. It is reserved rather than quietly folded into `detection`,
 * because a heatmap that silently relabels detections as motion would misrepresent what a camera
 * observed.
 */
export const HeatmapBandKind = z.enum([
  'event',
  'detection',
  'alert',
  'evidence',
  'bookmark',
  'ai-marker',
  /** ⚠️ No producer. See the note above. */
  'motion',
]);
export type HeatmapBandKind = z.infer<typeof HeatmapBandKind>;

/** Buckets a heatmap may be computed at. Bounded so a scrub cannot ask for a million buckets. */
export const HEATMAP_MAX_BUCKETS = 720;

/**
 * One band of density over the session's range.
 *
 * ⚠️ **`counts` and `bucketSeconds` describe a fixed grid, and `counted` says whether the grid is
 * complete.** A band computed over a truncated read is a band whose quiet stretches are an artefact
 * of the query rather than of the footage — the same distinction `SearchFacet.counted` draws, and
 * for the same reason: a density map is read as evidence of what did *not* happen, which is the
 * strongest claim on the screen and the easiest one to get wrong.
 */
export const HeatmapBand = z.object({
  kind: HeatmapBandKind,
  /** Seconds each bucket spans. Uniform across the band. */
  bucketSeconds: z.number().positive(),
  /** Counts per bucket, from the session's `startedAt`. Length ≤ `HEATMAP_MAX_BUCKETS`. */
  counts: z.array(z.number().int().min(0)).max(HEATMAP_MAX_BUCKETS).default([]),
  /**
   * ⚠️ False when the underlying read was truncated or the source could not be consulted. A band
   * that is not `counted` is rendered as indeterminate, never as zero.
   */
  counted: z.boolean(),
  /** Required when `counted` is false — what limited it. */
  uncountedReason: z.string().min(1).max(300).optional(),
});
export type HeatmapBand = z.infer<typeof HeatmapBand>;

/**
 * The heatmap over one playback range.
 *
 * ⚠️ `peak` is derived across the bands that are `counted` only. Including an uncounted band would
 * let a truncated read set the scale, and every other band would then be drawn faint against a
 * number that does not mean anything.
 */
export const PlaybackTimelineHeatmap = z
  .object({
    startedAt: IsoDateTime,
    endedAt: IsoDateTime,
    bands: z.array(HeatmapBand).max(8).default([]),
    /** Highest bucket across all `counted` bands. `0` is legitimate: nothing happened. */
    peak: z.number().int().min(0),
    derivedAt: IsoDateTime,
  })
  .superRefine((heatmap, ctx) => {
    for (const band of heatmap.bands) {
      if (!band.counted && band.uncountedReason === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['bands'],
          message: `the ${band.kind} band is not counted and must say why`,
        });
      }
    }
    const expected = heatmapPeak(heatmap.bands);
    if (heatmap.peak !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['peak'],
        message: `peak must be derived from the counted bands (expected ${expected}, got ${heatmap.peak})`,
      });
    }
  });
export type PlaybackTimelineHeatmap = z.infer<typeof PlaybackTimelineHeatmap>;

/**
 * The scale for a heatmap: the highest bucket among **counted** bands.
 *
 * Derived in one place so the schema, the renderer and the tests cannot disagree (CONSTRAINTS §46).
 */
export function heatmapPeak(bands: readonly HeatmapBand[]): number {
  let peak = 0;
  for (const band of bands) {
    if (!band.counted) continue;
    for (const count of band.counts) {
      if (count > peak) peak = count;
    }
  }
  return peak;
}

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
