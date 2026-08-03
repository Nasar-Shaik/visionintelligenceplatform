/**
 * Derived evidence artefacts (P-5.4.1, Architect refinements 1 and 2) — what a rendered copy has to
 * carry to be worth anything years later.
 *
 * A snapshot, a redacted disclosure copy and an exported clip are all the same shape of thing: a
 * **new evidence record produced from an existing one**. Modelled once, here, rather than three
 * times in the three places that produce them — three copies would drift, and the one that drifted
 * would be the one somebody relied on.
 *
 * ### ⚠️ Reproducibility is the whole requirement, and it needs the renderer too
 *
 * `sourceEvidenceId` alone answers *what it came from*. It does not answer *whether this is what
 * that renderer would produce today* — and a blur radius, a codec default or a scaling filter that
 * changed between releases produces a visibly different artefact from identical inputs. So the
 * record carries `rendererVersion` and the **exact operations applied**, in order.
 *
 * ⚠️ `appliedOperations` is ordered because rendering is not commutative: masking a region and then
 * downscaling is not the same picture as downscaling and then masking, and the second one can leave
 * recoverable detail at the region's edge.
 *
 * ### ⚠️ Three timestamps, because three different instants get confused for each other
 *
 * `recordedAt` is when the camera saw it. `playbackOffsetSeconds` is where in the session it sat.
 * `exportedAt` is when this file was made. An artefact carrying one timestamp gets read as
 * `recordedAt` by whoever receives it — which turns "exported at 14:05" into a claim that something
 * happened at 14:05. See {@link DerivedTimeBasis}.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId, Uuid } from '../common/primitives.js';

/** What a renderer did, as a verb. **Extends additively.** */
export const RenderOperation = z.enum([
  'blur',
  'mask',
  'timestamp-burn-in',
  'crop',
  'scale',
  'transcode',
  'trim',
  'concat',
  'watermark',
]);
export type RenderOperation = z.infer<typeof RenderOperation>;

/** One applied operation, with the parameters that would be needed to reproduce it. */
export const AppliedOperation = z.object({
  /** ⚠️ Position in the pipeline, from 0. Rendering is not commutative — see the module note. */
  order: z.number().int().min(0),
  operation: RenderOperation,
  /**
   * The parameters, as recorded by the renderer. Opaque to the platform on purpose: a blur radius
   * means something to the renderer and nothing here, and typing it would make every renderer
   * change a contract change.
   */
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type AppliedOperation = z.infer<typeof AppliedOperation>;

/**
 * ⚠️ **Three instants, named separately** (refinement 2).
 *
 * Preserving the frame timestamp through an export is the point: an exported clip whose only date
 * is the export date is a file that says the wrong thing about when the events in it happened.
 */
export const DerivedTimeBasis = z.object({
  /** ⚠️ When the camera captured the first frame. **The authoritative instant.** */
  recordedAt: IsoDateTime,
  /** When the last frame was captured, for a range. */
  recordedUntil: IsoDateTime.optional(),
  /**
   * Where this sat in the playback session it was taken from, in seconds from the session start.
   * ⚠️ Meaningless outside that session — kept for traceability, never for dating the content.
   */
  playbackOffsetSeconds: z.number().nonnegative().optional(),
  /** When this artefact was produced. ⚠️ Never a substitute for `recordedAt`. */
  exportedAt: IsoDateTime,
  /**
   * ⚠️ **How much the recording clock can be trusted**, carried through to the artefact.
   *
   * Mirrors `PlaybackClockConfidence`. An export from a source whose clock was never verified must
   * not present `recordedAt` as established fact — that is the same claim `PlaybackSyncGroup`
   * refuses to make about a wall, and it survives the export or it was never worth making.
   */
  clockConfidence: z.enum(['synchronised', 'device-clock', 'unknown']).default('unknown'),
  /**
   * ⚠️ Required when more than one source is combined and the alignment was **estimated** rather
   * than verified. "Never imply synchronization if clock alignment is estimated" — an artefact is
   * exactly where that implication becomes permanent.
   */
  alignmentCaveat: z.string().min(1).max(300).optional(),
});
export type DerivedTimeBasis = z.infer<typeof DerivedTimeBasis>;

/**
 * The provenance every derived artefact carries.
 *
 * ⚠️ **`derivedEvidenceId !== sourceEvidenceId` is enforced.** A "derivation" whose output id
 * equals its input is an in-place mutation wearing a provenance record, and it is precisely the
 * shape a well-meaning optimisation would take.
 */
export const DerivedArtifact = z
  .object({
    derivedEvidenceId: z.string().min(1),
    /** ⚠️ Read, never written. */
    sourceEvidenceId: z.string().min(1),
    tenantId: TenantId,
    /** The export or render profile this was produced under, when one applied. */
    renderProfileId: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug')
      .max(60)
      .optional(),
    /** ⚠️ Ordered. See the module note. */
    appliedOperations: z.array(AppliedOperation).max(50).default([]),
    /** ⚠️ Required — the artefact is not reproducible without it. */
    rendererVersion: z.string().min(1).max(80),
    time: DerivedTimeBasis,
    /**
     * ⚠️ The derived artefact's **own** hash, over its own bytes. Never copied from the source: two
     * different files with the same hash is the one thing an integrity claim must never produce.
     */
    integrityHash: z.string().min(1).max(200),
    hashAlgorithm: z.string().min(1).max(40).default('sha256'),
    /** The custody entry recorded when it was produced. */
    producedBy: z.string().min(1),
    /** The `media.render` job, when one produced it. */
    jobId: Uuid.optional(),
  })
  .superRefine((artifact, ctx) => {
    if (artifact.derivedEvidenceId === artifact.sourceEvidenceId) {
      ctx.addIssue({
        code: 'custom',
        path: ['derivedEvidenceId'],
        message:
          'a derived artefact is a new record: an output id equal to its input is an in-place mutation',
      });
    }
    const orders = artifact.appliedOperations.map((operation) => operation.order);
    if (new Set(orders).size !== orders.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['appliedOperations'],
        message: 'operation order must be unique — the pipeline is not commutative',
      });
    }
    if (artifact.time.recordedUntil !== undefined) {
      if (Date.parse(artifact.time.recordedUntil) < Date.parse(artifact.time.recordedAt)) {
        ctx.addIssue({
          code: 'custom',
          path: ['time', 'recordedUntil'],
          message: 'a recording cannot end before it starts',
        });
      }
    }
  });
export type DerivedArtifact = z.infer<typeof DerivedArtifact>;

/**
 * Operations that remove information irreversibly.
 *
 * Exported as data so the rule is greppable: an artefact carrying any of these can never be
 * presented as the original, and {@link isDestructive} is what the viewer's mode derives from.
 */
export const DESTRUCTIVE_OPERATIONS = ['blur', 'mask', 'crop', 'trim'] as const;

/** Did this derivation remove information that the original still holds? */
export function isDestructive(artifact: DerivedArtifact): boolean {
  return artifact.appliedOperations.some((applied) =>
    (DESTRUCTIVE_OPERATIONS as readonly string[]).includes(applied.operation),
  );
}
