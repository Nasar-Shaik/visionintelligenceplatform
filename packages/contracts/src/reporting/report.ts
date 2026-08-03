/**
 * Report contracts (P-5.2.0, Architect rec 5 + refinement 4) — **one model every generator
 * consumes**, and presentation kept strictly out of it.
 *
 * The instruction was: define a report model before implementing exports, and have all report
 * generators consume it rather than building reports independently. A second instruction added
 * optional theme metadata, with content independent from presentation.
 *
 * ### ⚠️ Four decisions
 *
 * **1. A report is a snapshot of a record that keeps changing.** An incident report generated at
 * 14:00 and one generated at 15:00 differ, and nothing in a PDF says which is current. So the model
 * carries `incidentVersion` and `generatedAt`, and a renderer must print them. Without that, two
 * copies of "the incident report" circulate and there is no way to tell which one is stale — which
 * matters precisely when the report is the artefact someone acted on.
 *
 * **2. A section that has no data is omitted, and the omission is stated.** Not an empty section,
 * not a zero. `omissions[]` records what was left out and why, because "AI Findings: none" and "no
 * AI has ever looked at this" are different claims and only one of them is true today
 * (CONSTRAINTS §53).
 *
 * **3. A theme may not choose content.** Presentation reorders and styles; it never includes or
 * excludes a section. The moment a theme can drop the audit trail, "the Executive report" and "the
 * Police report" of the same incident say different things while both claiming to be the report —
 * which is the failure an evidentiary document exists to prevent. Asserted by a test: the same
 * model under two themes yields the same section kinds.
 *
 * **4. A theme id is an opaque configured string, not an enum of industries.** The refinement named
 * Executive, Security, Retail, Manufacturing, Healthcare and Police. Those ship as **presets in
 * configuration**, exactly like AI-4's behaviour profiles — because CONSTRAINTS §36 forbids an
 * industry noun entering the platform's types, and because a customer who needs "Logistics" should
 * add a preset, not wait for a contract release.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId, Uuid } from '../common/primitives.js';

/**
 * The canonical sections, in the order the Architect gave them. **Extends additively**; a renderer
 * that meets an unknown kind renders its `title` and `body` generically rather than failing.
 */
export const ReportSectionKind = z.enum([
  'executive-summary',
  'incident-details',
  'timeline',
  'evidence',
  'ai-findings',
  'operator-notes',
  'attachments',
  'audit-trail',
]);
export type ReportSectionKind = z.infer<typeof ReportSectionKind>;

/** Canonical section order. Presentation may reorder within a theme; content may not vary. */
export const REPORT_SECTION_ORDER: readonly ReportSectionKind[] = [
  'executive-summary',
  'incident-details',
  'timeline',
  'evidence',
  'ai-findings',
  'operator-notes',
  'attachments',
  'audit-trail',
];

/**
 * One row inside a section — the neutral unit every renderer understands.
 *
 * Deliberately flat. A richer tree would let each generator interpret nesting differently, which is
 * the divergence this model exists to prevent.
 */
export const ReportEntry = z.object({
  /** Left-hand label, or the row's headline. */
  label: z.string().min(1).max(200),
  /** The value or body. Plain text — a renderer decides typography, never the model. */
  value: z.string().max(8000).optional(),
  at: IsoDateTime.optional(),
  /** Who, when the row is attributable. Already resolved — a renderer never looks anything up. */
  actor: z.string().max(200).optional(),
  /** An id the renderer may link or embed (an evidence item, an event). */
  ref: z.string().min(1).max(200).optional(),
});
export type ReportEntry = z.infer<typeof ReportEntry>;

export const ReportSection = z.object({
  kind: ReportSectionKind,
  title: z.string().min(1).max(200),
  /** A paragraph introducing the section, when one adds anything. */
  summary: z.string().max(4000).optional(),
  entries: z.array(ReportEntry).max(2000).default([]),
});
export type ReportSection = z.infer<typeof ReportSection>;

/** Why a section is not in the report (decision 2). */
export const ReportOmissionReason = z.enum([
  /** The section genuinely has no content — no notes were written, no evidence captured. */
  'no-data',
  /** ⚠️ No producer exists in this deployment. Different from `no-data`, and the difference matters. */
  'not-available',
  /** The requester lacks the permission that guards the underlying records. */
  'forbidden',
  /** The owning context did not answer in time. */
  'unavailable',
  /** The requester excluded it. */
  'not-requested',
]);
export type ReportOmissionReason = z.infer<typeof ReportOmissionReason>;

export const ReportOmission = z.object({
  kind: ReportSectionKind,
  reason: ReportOmissionReason,
  detail: z.string().min(1).max(300),
});
export type ReportOmission = z.infer<typeof ReportOmission>;

/**
 * ⚠️ **Where a report came from.** A report without this is an unfalsifiable document: nobody can
 * tell whether it describes the incident as it is now, or as it was before three more comments and
 * a resolution.
 */
export const ReportProvenance = z.object({
  incidentId: Uuid,
  /** The exact incident version this describes. The single most important field in the file. */
  incidentVersion: z.number().int().min(1),
  correlationId: z.string().min(1),
  generatedAt: IsoDateTime,
  generatedBy: z.string().min(1),
  /** The platform build that produced it, so a rendering defect is traceable to a release. */
  platformVersion: z.string().min(1).optional(),
});
export type ReportProvenance = z.infer<typeof ReportProvenance>;

/**
 * **The report model** — content only. Every generator (PDF, HTML, JSON) consumes exactly this and
 * adds nothing of its own.
 */
export const ReportModel = z.object({
  tenantId: TenantId,
  title: z.string().min(1).max(300),
  provenance: ReportProvenance,
  sections: z.array(ReportSection).default([]),
  /** ⚠️ Empty means the report is genuinely complete. */
  omissions: z.array(ReportOmission).default([]),
});
export type ReportModel = z.infer<typeof ReportModel>;

// ---------------------------------------------------------------------------------------------
// Presentation (refinement 4) — separate, optional, and content-blind.
// ---------------------------------------------------------------------------------------------

/**
 * A theme identifier: **an opaque, configured slug** (decision 4).
 *
 * Shipped presets are `executive`, `security`, `retail`, `manufacturing`, `healthcare` and
 * `police`, defined in deployment configuration rather than here. A tenant adds one by adding a
 * preset; nothing in the platform's types learns an industry noun (CONSTRAINTS §36).
 */
export const ReportThemeId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug')
  .max(60);
export type ReportThemeId = z.infer<typeof ReportThemeId>;

export const ReportFormat = z.enum(['pdf', 'html', 'json']);
export type ReportFormat = z.infer<typeof ReportFormat>;

/**
 * How a report looks. ⚠️ Every field here is presentation; **none of it selects content**
 * (decision 3).
 *
 * `sectionOrder` may reorder the sections a theme receives — it may not add one the model omitted,
 * and a kind it lists that the model does not contain is ignored rather than fabricated.
 */
export const ReportPresentation = z.object({
  theme: ReportThemeId.default('security'),
  format: ReportFormat.default('pdf'),
  /** BCP-47. Affects date and number rendering, never which sections appear. */
  locale: z.string().min(2).max(35).default('en-GB'),
  /** Tenant logo, as a storage key. Resolved by the renderer; never a URL in a stored record. */
  logoStorageKey: z.string().min(1).optional(),
  includeCoverPage: z.boolean().default(true),
  /** ⚠️ Reordering only. See the note above. */
  sectionOrder: z.array(ReportSectionKind).max(20).optional(),
  /** Embed evidence images inline. Off for a lightweight summary; content is unchanged either way. */
  embedEvidence: z.boolean().default(true),
});
export type ReportPresentation = z.infer<typeof ReportPresentation>;

/**
 * A rendered report: the model, the presentation applied to it, and nothing merged between them.
 * Keeping them side by side means the same content can be re-rendered under a different theme with
 * no risk of the second render disagreeing with the first.
 */
export const RenderedReport = z.object({
  model: ReportModel,
  presentation: ReportPresentation,
  /** The artefact, as a job result — a storage key, never a URL (see `JobResult`). */
  storageKey: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  renderedAt: IsoDateTime,
});
export type RenderedReport = z.infer<typeof RenderedReport>;

/**
 * Ask for a report. Submitted as a `Job` of kind `report.render` — reports are slow enough that
 * holding a request open for one is the behaviour rec 4 exists to eliminate.
 */
export const ReportRequest = z.object({
  incidentId: Uuid,
  /** Sections to include. Absent ⇒ all of them; an excluded one appears in `omissions`. */
  sections: z.array(ReportSectionKind).max(20).optional(),
  presentation: ReportPresentation.optional(),
});
export type ReportRequest = z.infer<typeof ReportRequest>;
