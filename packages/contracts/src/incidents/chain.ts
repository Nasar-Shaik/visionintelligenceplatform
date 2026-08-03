/**
 * The evidence chain (P-5.3, Architect rec 7) — **camera → detection → rule → incident → evidence →
 * playback → export → report**, derived end to end.
 *
 * This is the platform's own traceability story told as one object: *why does this incident exist,
 * and what can be shown for it*. Nothing here is stored. Every link is recomputed from records that
 * already exist — `Incident.triggeredBy` carries the camera and the triggering event,
 * `Incident.source` carries the rule and its version, `EvidenceSource` carries the way back
 * (CONSTRAINTS §46).
 *
 * ### ⚠️ A chain is only useful if it can be broken
 *
 * The temptation is a diagram where every arrow is drawn because the shape says there should be
 * one. A chain like that cannot answer the question it exists for. In practice links break
 * routinely and for different reasons:
 *
 * - the triggering **event aged out** of the retention window — the incident is still valid, and
 *   the event that caused it is genuinely gone;
 * - the **camera was archived** or reassigned since;
 * - the **rule version** that fired has been superseded — the current rule is a different rule;
 * - **no evidence was captured**, because the extractor is a no-op pending the media frame source
 *   (TD-15);
 * - the reader **may not see** a link — evidence needs `evidence:read`, the rule needs `rule:read`.
 *
 * Each of those is a *different* answer, and a customer-facing traceability feature that renders
 * them all as a missing arrow is worse than no feature: it invites the conclusion that the platform
 * lost something.
 */
import { z } from 'zod';
import { EventType, IsoDateTime, TenantId, Uuid } from '../common/primitives.js';

/** The stages, in order. **Extends additively** at the tail. */
export const EvidenceChainStage = z.enum([
  'camera',
  'detection',
  'rule',
  'incident',
  'evidence',
  'playback',
  'export',
  'report',
]);
export type EvidenceChainStage = z.infer<typeof EvidenceChainStage>;

/** Canonical order, so a renderer never has to know it. */
export const EVIDENCE_CHAIN_ORDER: readonly EvidenceChainStage[] = [
  'camera',
  'detection',
  'rule',
  'incident',
  'evidence',
  'playback',
  'export',
  'report',
];

/**
 * Why a stage is not resolved. ⚠️ Each maps to a different thing the reader should do.
 */
export const EvidenceChainBreak = z.enum([
  /** The record it points at no longer exists — usually retention. The chain is intact; the data aged out. */
  'retained-elsewhere',
  /** The referenced record was archived (a camera retired, a location closed). */
  'archived',
  /** Nothing was ever produced for this stage. */
  'never-produced',
  /** ⚠️ No producer exists in this build. A release fixes it; a config change does not. */
  'not-built',
  /** The reader lacks the permission that guards this context. */
  'forbidden',
  /** The owning context did not answer. */
  'unavailable',
]);
export type EvidenceChainBreak = z.infer<typeof EvidenceChainBreak>;

export const EvidenceChainLink = z.object({
  stage: EvidenceChainStage,
  /** True when the stage resolved to something real. */
  resolved: z.boolean(),
  /** The record's id, when resolved. */
  ref: z.string().min(1).max(200).optional(),
  /** A human label — a camera name, a rule name. Resolved at derivation, never cached. */
  label: z.string().min(1).max(200).optional(),
  at: IsoDateTime.optional(),
  /** How many items this stage covers (evidence count, event count). Absent ⇒ not counted. */
  count: z.number().int().min(0).optional(),
  /** ⚠️ Required when `resolved` is false — which of the six breaks this is. */
  brokenBecause: EvidenceChainBreak.optional(),
  /** ⚠️ Required alongside `brokenBecause` — the sentence the operator reads. */
  detail: z.string().min(1).max(300).optional(),
});
export type EvidenceChainLink = z.infer<typeof EvidenceChainLink>;

/**
 * One incident's full provenance, derived.
 *
 * `complete` is derived from the links rather than asserted, so the flag and the chain cannot
 * disagree — the same reason `PlaybackSyncGroup.alignmentVerified` is computed rather than stored.
 */
export const EvidenceChain = z
  .object({
    tenantId: TenantId,
    incidentId: Uuid,
    /** The correlation spine every stage threads onto. */
    correlationId: z.string().min(1),
    eventType: EventType.optional(),
    links: z.array(EvidenceChainLink).min(1),
    /** ⚠️ True only when **every** stage resolved. Derived — see `chainIsComplete`. */
    complete: z.boolean(),
    derivedAt: IsoDateTime,
  })
  .superRefine((chain, ctx) => {
    for (const link of chain.links) {
      if (!link.resolved && (link.brokenBecause === undefined || link.detail === undefined)) {
        ctx.addIssue({
          code: 'custom',
          message: `chain stage ${link.stage} is unresolved and must say why`,
          path: ['links'],
        });
      }
    }
  });
export type EvidenceChain = z.infer<typeof EvidenceChain>;

/** Derived, so the flag can never disagree with the links it summarises. */
export function chainIsComplete(links: readonly EvidenceChainLink[]): boolean {
  return links.every((link) => link.resolved);
}
