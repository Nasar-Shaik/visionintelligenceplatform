/**
 * The platform's **evidence vocabulary** — one enum, shared by everything that makes a claim.
 *
 * This started life inside the certification contracts (AI-5e), where the rule "a device is not
 * certified without `hardware` evidence" was expressed in the shapes themselves. P-2 needed the same
 * vocabulary for a completely different question — may a camera be called `connected`? — and the
 * honest answer was that there is only *one* question here, asked twice: **what was this observed
 * on?** So the enum lives at the root rather than being copied, because two evidence vocabularies
 * would drift, and a drifted evidence vocabulary is how a simulation quietly starts counting as a
 * measurement somewhere nobody is looking.
 *
 * (Mechanically, `certification.ts` imports `camera.ts`, so `camera.ts` cannot import back from it.
 * The cycle is what surfaced the design question; the shared root is the right answer regardless.)
 */
import { z } from 'zod';

/**
 * What a result was actually observed on. Ordered weakest → strongest, and that order is the whole
 * point: a report is only as strong as its weakest check, and certification requires `hardware`.
 *
 * - `simulated` — deterministic simulated sources + stub adapters. Proves the plumbing.
 * - `recorded-footage` — real CCTV footage through the real pipeline. Proves perception, not devices.
 * - `hardware` — a physical camera/DVR/NVR/GPU/edge device. The only class that certifies.
 */
export const EvidenceClass = z.enum(['simulated', 'recorded-footage', 'hardware']);
export type EvidenceClass = z.infer<typeof EvidenceClass>;

/**
 * True when the evidence came from a physical device. The single predicate behind every rule that
 * distinguishes "the software works" from "it works on your equipment" — certification status,
 * capability maturity promotion, and (P-2) whether a camera may enter a measured lifecycle state.
 */
export function isHardwareEvidence(evidence: EvidenceClass): boolean {
  return evidence === 'hardware';
}
