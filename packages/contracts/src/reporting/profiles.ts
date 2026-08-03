/**
 * Evidence export profiles (P-5.4, Architect rec 3) — **"profiles may change presentation only,
 * never evidence content."**
 *
 * ### ⚠️ Why these are records and not an enum
 *
 * The recommendation names seven profiles: Court, Police, Internal, Executive, Compliance, Customer
 * and Insurance. Written as `z.enum(['court', 'police', …])` that would put six industry and
 * jurisdiction nouns into the platform's type system, which CONSTRAINTS §36 refuses and which
 * `ReportThemeId` already refused for the same reason — a deployment in a country whose disclosure
 * regime has no equivalent of "police" would then be carrying a type it cannot use, and adding an
 * eighth profile would be a release rather than a configuration change.
 *
 * So the id is an **opaque slug** and the seven ship as {@link EXPORT_PROFILE_PRESETS} — data, not
 * vocabulary. A tenant adds a profile by adding a record. Everything a profile can express is
 * presentation, enforced below.
 *
 * ### ⚠️ The boundary: a profile may require a redaction, never perform one
 *
 * The genuinely hard case is a court or police profile, which in practice differs from an internal
 * one by *what has been removed* — and removal is content. A profile that could redact would be a
 * presentation object silently changing evidence, which is the one thing this contract exists to
 * prevent.
 *
 * The resolution is that redaction is a separate, accountable act with its own artefact
 * (`RedactionRequest` → a new evidence record), and a profile may only **decline to export until
 * that act has happened**: `requiresRedactionReview` is a gate, not a transform. The profile says
 * "this recipient class needs a redaction review"; a human does the review; the export then carries
 * the derived copies. Nothing about the underlying evidence changes because a profile was selected.
 *
 * ⚠️ **Frozen with no producer.** No exporter reads these.
 */
import { z } from 'zod';
import { ReportPresentation } from './report.js';

/** An opaque profile slug. ⚠️ Deliberately not an enum — see the module note. */
export const ExportProfileId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug')
  .max(60);
export type ExportProfileId = z.infer<typeof ExportProfileId>;

/**
 * A named export preset.
 *
 * ⚠️ **There is no `sections` field, and there must never be one.** `ReportRequest.sections`
 * selects content and belongs to the person requesting the export; a profile that could also select
 * sections would give two objects authority over the same decision, and the one the operator did
 * not look at would win. {@link PROFILE_FORBIDDEN_KEYS} exists so a test asserts this rather than a
 * reviewer remembering it.
 */
export const EvidenceExportProfile = z.object({
  id: ExportProfileId,
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  /** ⚠️ Presentation only. The whole configurable surface of a profile. */
  presentation: ReportPresentation,
  /**
   * ⚠️ A **gate**, not a transform. When true, an export refuses until a redaction review has been
   * recorded for the evidence it would carry. The profile never edits anything itself.
   */
  requiresRedactionReview: z.boolean().default(false),
  /**
   * When true, the export must carry integrity hashes and a verification manifest alongside the
   * artefact. Presentation of the *manifest*, not selection of evidence.
   */
  requiresIntegrityManifest: z.boolean().default(false),
  /**
   * ⚠️ Required when the profile targets anyone outside the tenant — the sentence that ends up in
   * the access audit beside `export`. A disclosure without a stated basis is the audit entry that
   * cannot be answered a year later.
   */
  disclosureBasis: z.string().min(1).max(300).optional(),
  /** Does this profile send evidence outside the tenant? Drives the requirement above. */
  external: z.boolean().default(false),
});
export type EvidenceExportProfile = z.infer<typeof EvidenceExportProfile>;

/**
 * Keys a profile must never carry, exported as data so the rule is greppable and asserted.
 *
 * Every one of these selects or alters **content**. If a future change adds one of them to
 * {@link EvidenceExportProfile}, the P-5.4 test fails and the reviewer is pointed at this note.
 */
export const PROFILE_FORBIDDEN_KEYS = [
  'sections',
  'evidenceIds',
  'incidentIds',
  'redactions',
  'omissions',
  'filters',
] as const;

/**
 * The seven profiles the recommendation names, as **seed data**.
 *
 * ⚠️ Ships as configuration, not as a type. A deployment may replace this list entirely; nothing in
 * the platform branches on a particular id.
 */
export const EXPORT_PROFILE_PRESETS: readonly EvidenceExportProfile[] = [
  {
    id: 'court',
    title: 'Court',
    description:
      'Disclosure to a court: full provenance, integrity manifest, redaction review required.',
    presentation: {
      theme: 'security',
      format: 'pdf',
      locale: 'en-GB',
      includeCoverPage: true,
      embedEvidence: true,
    },
    requiresRedactionReview: true,
    requiresIntegrityManifest: true,
    disclosureBasis: 'court order or statutory disclosure obligation',
    external: true,
  },
  {
    id: 'police',
    title: 'Police',
    description: 'Disclosure to a law-enforcement request, with hashes and a redaction review.',
    presentation: {
      theme: 'security',
      format: 'pdf',
      locale: 'en-GB',
      includeCoverPage: true,
      embedEvidence: true,
    },
    requiresRedactionReview: true,
    requiresIntegrityManifest: true,
    disclosureBasis: 'law-enforcement request',
    external: true,
  },
  {
    id: 'insurance',
    title: 'Insurance',
    description: 'A claim pack: incident narrative, timeline and supporting evidence.',
    presentation: {
      theme: 'security',
      format: 'pdf',
      locale: 'en-GB',
      includeCoverPage: true,
      embedEvidence: true,
    },
    requiresRedactionReview: true,
    requiresIntegrityManifest: true,
    disclosureBasis: 'insurance claim',
    external: true,
  },
  {
    id: 'compliance',
    title: 'Compliance',
    description: 'An auditable record: provenance and audit trail forward, presentation plain.',
    presentation: {
      theme: 'security',
      format: 'pdf',
      locale: 'en-GB',
      includeCoverPage: true,
      embedEvidence: false,
    },
    requiresRedactionReview: false,
    requiresIntegrityManifest: true,
    external: false,
  },
  {
    id: 'customer',
    title: 'Customer',
    description: 'A summary for the site owner: what happened and what was done about it.',
    presentation: {
      theme: 'security',
      format: 'pdf',
      locale: 'en-GB',
      includeCoverPage: true,
      embedEvidence: true,
    },
    requiresRedactionReview: true,
    requiresIntegrityManifest: false,
    disclosureBasis: 'contractual reporting to the site owner',
    external: true,
  },
  {
    id: 'executive',
    title: 'Executive',
    description: 'The short version: narrative and outcome, no embedded media.',
    presentation: {
      theme: 'executive',
      format: 'pdf',
      locale: 'en-GB',
      includeCoverPage: true,
      embedEvidence: false,
    },
    requiresRedactionReview: false,
    requiresIntegrityManifest: false,
    external: false,
  },
  {
    id: 'internal',
    title: 'Internal',
    description: 'Working copy for the security team: everything, rendered plainly.',
    presentation: {
      theme: 'security',
      format: 'html',
      locale: 'en-GB',
      includeCoverPage: false,
      embedEvidence: true,
    },
    requiresRedactionReview: false,
    requiresIntegrityManifest: false,
    external: false,
  },
];

/**
 * Whether a profile is safe to export without further checks.
 *
 * ⚠️ Returns the reasons rather than a boolean: "cannot export" is not an answer an operator can
 * act on, and the two conditions here have different remedies — one needs a redaction review, the
 * other needs somebody to state why the disclosure is being made.
 */
export function exportBlockers(
  profile: EvidenceExportProfile,
  context: { redactionReviewed: boolean },
): string[] {
  const blockers: string[] = [];
  if (profile.requiresRedactionReview && !context.redactionReviewed) {
    blockers.push('a redaction review has not been recorded for this evidence');
  }
  if (profile.external && profile.disclosureBasis === undefined) {
    blockers.push('an external profile must state the basis for disclosure');
  }
  return blockers;
}
