/**
 * The annotation layer (P-5.4, Architect rec 4) — **"non-destructive… original evidence must remain
 * immutable."**
 *
 * The requirement lists rectangles, polygons, arrows, text, blur, redaction, timestamps and
 * revisions as one feature. Reserved here as **two**, because they are not the same kind of thing
 * and treating them alike is a data leak.
 *
 * ### ⚠️ The finding: a redaction drawn as an overlay is not a redaction
 *
 * An overlay is a shape stored beside the media and painted over it at display time. That is
 * exactly right for a rectangle an investigator drew round a suspect, and it is exactly wrong for a
 * blur over a bystander's face:
 *
 * - The bytes still contain the face. Anyone with the evidence id and `evidence:read` sees it
 *   unobscured the moment they open the original, use a different viewer, or export the clip.
 * - The overlay is investigation-context data (CONSTRAINTS §60). Evidence exported through any path
 *   that does not consult the investigation carries no redaction at all.
 * - A disclosure copy is the *one* artefact where "the viewer chose not to paint it" is the whole
 *   failure. Handing a police force a file whose redaction is a client-side rendering hint is worse
 *   than handing them the unredacted original, because everyone involved believes it is redacted.
 *
 * So `blur`, `redaction` and burnt-in `timestamp` are **not shapes**. They are a
 * {@link RedactionTreatment} on a {@link RedactionRequest}, which runs as a `media.render` job and
 * produces a **new Evidence record** with its own integrity hash and its own custody log — the same
 * rule `CapturePlaybackSnapshotInput` already follows. The original is never touched, and the
 * derived copy is the thing you can hand over.
 *
 * ### Revisions supersede; they never mutate
 *
 * An annotation is a statement a named person made about evidence at a time. Editing one in place
 * rewrites what somebody said, in a context whose value depends on that being impossible. So a
 * revision is a **new record pointing at the one it replaces**, and the chain is readable.
 *
 * ⚠️ **Frozen with no producer.** Nothing renders an overlay, runs a render job, or stores a
 * revision. Every surface reports `not-built`.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId, Uuid } from '../common/primitives.js';
import { PlaybackSource } from './playback.js';

// ---------------------------------------------------------------------------------------------
// Overlays — non-destructive, stored in the investigation, painted at display time
// ---------------------------------------------------------------------------------------------

/**
 * Shapes an investigator may draw. **Overlay only** — see the module note for why `blur` and
 * `redaction` are deliberately absent from this list.
 *
 * ⚠️ Extends `PlaybackAnnotationShape` (P-5.2) rather than replacing it: `box`, `point`, `polyline`
 * and `freehand` keep their spellings so stored annotations stay readable. As recorded in ED-0057
 * and twice since, **an enum extension is additive for the platform but not for a strict external
 * parser** — a consumer pinned to the P-5.2 vocabulary rejects a `polygon`. The same trade-off is
 * accepted here for the same reason: the alternative is a second annotation vocabulary.
 */
export const AnnotationOverlayKind = z.enum([
  /** P-5.2 spellings, unchanged. */
  'box',
  'point',
  'polyline',
  'freehand',
  /** P-5.4 additions. */
  'polygon',
  'arrow',
  /** Two points: centre and a point on the circumference. */
  'circle',
  /** Two points: opposite corners of the bounding box. */
  'ellipse',
  /** Two points. Distinct from `arrow` because a line asserts no direction. */
  'line',
  /** A text note anchored to a position in the frame. `points` carries the anchor. */
  'text',
]);
export type AnnotationOverlayKind = z.infer<typeof AnnotationOverlayKind>;

/** How many normalised points each overlay kind requires. Exported so a test can assert it. */
export const OVERLAY_POINT_ARITY: Record<AnnotationOverlayKind, { min: number; max?: number }> = {
  point: { min: 1, max: 1 },
  text: { min: 1, max: 1 },
  box: { min: 2, max: 2 },
  ellipse: { min: 2, max: 2 },
  circle: { min: 2, max: 2 },
  arrow: { min: 2, max: 2 },
  line: { min: 2, max: 2 },
  polyline: { min: 2 },
  polygon: { min: 3 },
  freehand: { min: 2 },
};

/**
 * Does this overlay carry the right number of points?
 *
 * Derived from one table so the schema, the console and the tests cannot disagree — an arrow with
 * one point is a rendering crash, and a polygon with two is a line pretending to be an area.
 */
export function overlayArityIsValid(kind: AnnotationOverlayKind, pointCount: number): boolean {
  const arity = OVERLAY_POINT_ARITY[kind];
  if (pointCount < arity.min) return false;
  return arity.max === undefined || pointCount <= arity.max;
}

/**
 * An annotation revision.
 *
 * ⚠️ `supersedes` is absent on the first statement and present on every later one. A revision is a
 * new immutable record; nothing edits the record it replaces. `revision` counts from 1 so a reader
 * can order the chain without resolving every link.
 */
export const AnnotationRevision = z.object({
  revision: z.number().int().min(1),
  /** The annotation id this one replaces. Absent ⇒ this is the original statement. */
  supersedes: Uuid.optional(),
  /** ⚠️ Required from revision 2 onward — why the earlier statement was changed. */
  reason: z.string().min(1).max(500).optional(),
});
export type AnnotationRevision = z.infer<typeof AnnotationRevision>;

/**
 * A shape drawn over a frame, with what the investigator meant by it.
 *
 * ⚠️ **Investigation context, never Evidence** (§60). Coordinates are normalised `[0,1]` so an
 * annotation drawn on a 4K stream lands correctly on a downscaled review copy.
 */
export const AnnotationOverlay = z
  .object({
    id: Uuid,
    tenantId: TenantId,
    incidentId: z.string().min(1),
    source: PlaybackSource,
    /** The frame this was drawn on, as wall clock. */
    at: IsoDateTime,
    /** For a treatment spanning time rather than a single frame. Absent ⇒ one frame. */
    endAt: IsoDateTime.optional(),
    kind: AnnotationOverlayKind,
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
    revision: AnnotationRevision.default({ revision: 1 }),
    createdBy: z.string().min(1),
    createdAt: IsoDateTime,
  })
  .superRefine((overlay, ctx) => {
    if (!overlayArityIsValid(overlay.kind, overlay.points.length)) {
      const arity = OVERLAY_POINT_ARITY[overlay.kind];
      ctx.addIssue({
        code: 'custom',
        path: ['points'],
        message: `a ${overlay.kind} needs at least ${arity.min}${
          arity.max === undefined ? '' : ` and at most ${arity.max}`
        } point(s), got ${overlay.points.length}`,
      });
    }
    if (overlay.revision.revision > 1 && overlay.revision.supersedes === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['revision', 'supersedes'],
        message: 'a revision after the first must name the annotation it replaces',
      });
    }
    if (overlay.revision.revision > 1 && overlay.revision.reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['revision', 'reason'],
        message: 'changing a recorded statement about evidence requires a stated reason',
      });
    }
  });
export type AnnotationOverlay = z.infer<typeof AnnotationOverlay>;

// ---------------------------------------------------------------------------------------------
// Treatments — destructive to the *copy*, never to the original
// ---------------------------------------------------------------------------------------------

/**
 * ⚠️ **A treatment changes pixels.** It is requested against an original and produces a *new*
 * evidence record; it never modifies its input.
 */
export const RedactionTreatment = z.enum([
  /** Irreversibly blurred region. */
  'blur',
  /** Solid fill — the region is gone, not softened. */
  'mask',
  /** Burnt-in wall-clock time. Requested as a treatment because it, too, alters pixels. */
  'timestamp',
]);
export type RedactionTreatment = z.infer<typeof RedactionTreatment>;

/** One region to treat, over a time range. */
export const RedactionRegion = z.object({
  treatment: RedactionTreatment,
  /** Normalised `[0,1]` polygon. A rectangle is four points. Ignored for `timestamp`. */
  points: z
    .array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]))
    .max(200)
    .default([]),
  /** Wall-clock range this region applies to. Absent `endAt` ⇒ to the end of the source. */
  startAt: IsoDateTime,
  endAt: IsoDateTime.optional(),
  /** Why this region is being removed — the sentence a disclosure log needs. */
  reason: z.string().min(1).max(500),
});
export type RedactionRegion = z.infer<typeof RedactionRegion>;

/**
 * Ask for a treated copy.
 *
 * ⚠️ **`sourceEvidenceId` is read and never written.** The result is a new evidence record whose
 * provenance points back here, so the chain from disclosure copy to original is walkable in the
 * direction that matters: given a file that reached a third party, you can always find what it came
 * from and who authorised it.
 *
 * ⚠️ **There is deliberately no `overwriteOriginal` flag, and no partial mode.** The Evidence
 * Foundation guarantees the stored artefact matches its hash forever; a flag that could break that
 * is a flag that will eventually be set by an automation nobody remembers writing.
 */
export const RedactionRequest = z.object({
  tenantId: TenantId,
  incidentId: z.string().min(1),
  /** The original. Read-only, always. */
  sourceEvidenceId: z.string().min(1),
  regions: z.array(RedactionRegion).min(1).max(100),
  /** Who asked, and under what authority — a disclosure is an accountable act. */
  requestedBy: z.string().min(1),
  /** ⚠️ Required: the case, warrant, or policy this disclosure is made under. */
  justification: z.string().min(1).max(1000),
  requestedAt: IsoDateTime,
});
export type RedactionRequest = z.infer<typeof RedactionRequest>;

/**
 * The result of a treatment — **a new evidence record**, described.
 *
 * ⚠️ `irreversible` is `z.literal(true)`. A treatment that could be undone from the derived copy
 * would mean the pixels were never removed, only hidden — which is the overlay failure this whole
 * split exists to prevent. Reversal is done by going back to the original, which still exists,
 * under the access controls that govern it.
 */
export const RedactionResult = z.object({
  redactedEvidenceId: z.string().min(1),
  sourceEvidenceId: z.string().min(1),
  /** ⚠️ Always true. Present as a field so a consumer asserts on data, not on documentation. */
  irreversible: z.literal(true),
  regionCount: z.number().int().min(1),
  /** The `media.render` job that produced it. */
  jobId: Uuid,
  producedAt: IsoDateTime,
});
export type RedactionResult = z.infer<typeof RedactionResult>;

/**
 * Treatments that must never be expressed as an overlay, exported as data so a test can assert the
 * two vocabularies stay disjoint rather than relying on review to catch a merge.
 */
export const OVERLAY_FORBIDDEN_KINDS = ['blur', 'mask', 'redaction', 'timestamp'] as const;

/** Is this name one that must go through a render job rather than the overlay layer? */
export function requiresRenderedTreatment(kind: string): boolean {
  return (OVERLAY_FORBIDDEN_KINDS as readonly string[]).includes(kind);
}
