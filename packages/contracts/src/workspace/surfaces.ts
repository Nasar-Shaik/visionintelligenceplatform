/**
 * Reserved workspace surfaces (P-5.3) — **shapes settled, nothing implemented.**
 *
 * The dashboard, the notification centre, the offline bundle, report preview and demo mode. Each is
 * declared here so the milestone that builds it consumes a settled shape; none of them has a
 * producer, a store or a route today.
 *
 * ⚠️ Every one of them appears in the workspace as a **`not-built` dependency** (see
 * `WorkspaceHealth`), not as an empty panel. The gap is on the screen, not only in this file.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId, Uuid } from '../common/primitives.js';
import { EventPriority } from '../events/priority.js';
import { SearchEntityKind } from '../search/search.js';
import { ReportModel, ReportPresentation } from '../reporting/report.js';

// ---------------------------------------------------------------------------------------------
// Investigation dashboard (requirement 8)
// ---------------------------------------------------------------------------------------------

/**
 * A dashboard section. **Extends additively.**
 *
 * ⚠️ This is a **register of sections, not a widget framework.** `DashboardWidget` /
 * `DashboardLayout` / `DashboardPreset` remain **Q-4**, queued as their own milestone — a widget
 * system is a composition model with its own permission, sizing and data-binding questions, and
 * settling those as a side-effect of listing five panels would answer them by accident.
 */
export const InvestigationDashboardSection = z.enum([
  'recent-incidents',
  'critical-alerts',
  'offline-cameras',
  'saved-investigations',
  'system-health',
  /** ⚠️ Reserved. No model produces a summary — the panel states that rather than showing none. */
  'ai-summary',
]);
export type InvestigationDashboardSection = z.infer<typeof InvestigationDashboardSection>;

export const InvestigationDashboardCard = z.object({
  section: InvestigationDashboardSection,
  title: z.string().min(1).max(80),
  permission: z.string().min(1),
  /** ⚠️ Set when the section has no producer. The card states the reason; it never renders empty. */
  unavailableReason: z.string().min(1).max(300).optional(),
});
export type InvestigationDashboardCard = z.infer<typeof InvestigationDashboardCard>;

// ---------------------------------------------------------------------------------------------
// Notification centre (requirement 9; the P-5.2.0 queue's Q-3)
// ---------------------------------------------------------------------------------------------

/**
 * What the workspace can tell an operator about, in-app.
 *
 * ⚠️ **This is the in-app centre, not the delivery abstraction.** Q-3 — the transport-agnostic seam
 * that email, SMS, WhatsApp, push, webhook, Slack and Teams plug into — stays queued as its own
 * milestone. Conflating the two would put transport concerns (retry, bounce, opt-out, per-channel
 * templating) inside a UI surface, and the Incident domain publishes events; it does not deliver
 * (INCIDENT_BOUNDARY, ownership rule 1).
 */
export const WorkspaceNotificationKind = z.enum([
  'incident-updated',
  'incident-assigned-to-you',
  'playback-available',
  'evidence-ready',
  'export-complete',
  'job-failed',
  'camera-offline',
  /** ⚠️ Reserved. No AI produces anything to complete. */
  'ai-completed',
]);
export type WorkspaceNotificationKind = z.infer<typeof WorkspaceNotificationKind>;

/**
 * One in-app notification. **A reference and a sentence — never a copy of the record.**
 *
 * The same rule as persisted workspace state (CONSTRAINTS §66): a notification carrying an
 * incident's title and status is a copy that goes stale and survives revoked access. It carries the
 * id; opening it re-fetches under the reader's permissions.
 */
export const WorkspaceNotification = z.object({
  id: Uuid,
  tenantId: TenantId,
  kind: WorkspaceNotificationKind,
  /** Who it is for. A notification is never broadcast to a tenant. */
  principalId: z.string().min(1),
  /** The thing it is about, so the client can navigate and re-fetch. */
  entity: SearchEntityKind.optional(),
  targetId: z.string().min(1).optional(),
  summary: z.string().min(1).max(300),
  severity: EventPriority.optional(),
  correlationId: z.string().min(1).optional(),
  readAt: IsoDateTime.optional(),
  at: IsoDateTime,
});
export type WorkspaceNotification = z.infer<typeof WorkspaceNotification>;

// ---------------------------------------------------------------------------------------------
// Offline investigation bundle (P-5.3 rec 12)
// ---------------------------------------------------------------------------------------------

/**
 * An exported investigation, reviewable without the platform.
 *
 * ⚠️ **The hardest honest question this contract has to answer is what "offline evidence" means.**
 * A bundle of *references* is reviewable only while the platform is reachable, which is not
 * offline. A bundle of *bytes* is a copy of regulated media leaving every retention policy, legal
 * hold and access control that governs the original — the moment it is written, the platform can no
 * longer honour a purge request for it.
 *
 * Both are legitimate; they are different products. So the mode is **explicit and recorded on the
 * bundle**, the byte-carrying mode records its own retention intent, and neither is a default.
 */
export const OfflineBundleMode = z.enum([
  /**
   * Metadata, timeline and evidence **manifests with integrity hashes** — no media. Verifiable
   * against the platform; not viewable without it.
   */
  'references',
  /**
   * ⚠️ Includes media bytes. A copy outside the platform's retention and legal-hold enforcement;
   * `custodian` and `expiresAt` are required because somebody has to own it.
   */
  'self-contained',
]);
export type OfflineBundleMode = z.infer<typeof OfflineBundleMode>;

export const OfflineInvestigationBundle = z
  .object({
    id: Uuid,
    tenantId: TenantId,
    incidentId: Uuid,
    incidentVersion: z.number().int().min(1),
    mode: OfflineBundleMode,
    /** Evidence ids included. Manifests always; bytes only in `self-contained`. */
    evidenceIds: z.array(z.string().min(1)).max(500).default([]),
    /** Sections captured — the same vocabulary the report model uses. */
    includesTimeline: z.boolean().default(true),
    includesReports: z.boolean().default(false),
    /** ⚠️ Required for `self-contained`: who holds the copy. */
    custodian: z.string().min(1).max(200).optional(),
    /** ⚠️ Required for `self-contained`: when the copy must be destroyed. */
    expiresAt: IsoDateTime.optional(),
    /** The artefact, as a storage key — never a URL (see `JobResult`). */
    storageKey: z.string().min(1).optional(),
    createdBy: z.string().min(1),
    createdAt: IsoDateTime,
  })
  .superRefine((bundle, ctx) => {
    if (bundle.mode !== 'self-contained') return;
    if (bundle.custodian === undefined || bundle.expiresAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'a self-contained bundle carries regulated media out of the platform and must name a custodian and an expiry',
      });
    }
  });
export type OfflineInvestigationBundle = z.infer<typeof OfflineInvestigationBundle>;

// ---------------------------------------------------------------------------------------------
// Report preview (P-5.3 rec 13)
// ---------------------------------------------------------------------------------------------

/**
 * What a report *would* contain, without producing the artefact — "never export blindly".
 *
 * ⚠️ **The preview is the same `ReportModel` the renderer consumes**, not a second summarising
 * shape. A preview computed differently from the export is a preview that can be wrong about the
 * export, which is worse than no preview: it is a reassurance.
 *
 * `estimatedSizeBytes` is optional and absent when unknown — a number nobody measured, printed
 * beside a download button, is the kind of estimate people plan around.
 */
export const ReportPreview = z.object({
  model: ReportModel,
  presentation: ReportPresentation,
  /** Absent ⇒ not estimated. Never a guess. */
  estimatedSizeBytes: z.number().int().nonnegative().optional(),
  /** How many evidence items would be embedded — the thing that actually drives the size. */
  embeddedEvidenceCount: z.number().int().min(0),
  previewedAt: IsoDateTime,
});
export type ReportPreview = z.infer<typeof ReportPreview>;

// ---------------------------------------------------------------------------------------------
// Demo mode (requirement 10)
// ---------------------------------------------------------------------------------------------

/**
 * A presentation-ready walkthrough over recorded footage — the stated immediate product priority.
 *
 * ⚠️ **`isDemo` is on the record, and it is the whole design.** Sample data that is
 * indistinguishable from real data is the failure this contract exists to prevent: a demo incident
 * in a production tenant's queue, counted in a compliance report, is a far more expensive mistake
 * than a missing demo feature. Every demo artefact is flagged, every surface showing one says so,
 * and `reset` deletes exactly the flagged set — which only works because the flag is on the record
 * rather than inferred from a naming convention.
 *
 * ⚠️ **Frozen with no producer.** Demo Readiness v1 crosses TD-4, TD-5, TD-9, TD-13, TD-14, TD-15
 * and TD-16 — it is the first milestone needing the perception path real end to end, and it is
 * scoped as its own milestone in PRODUCT_ROADMAP_QUEUE for that reason.
 */
export const DemoScenarioStep = z.object({
  order: z.number().int().min(0),
  title: z.string().min(1).max(120),
  narration: z.string().min(1).max(1000),
  /** Where the walkthrough should take the viewer. A route, not a component. */
  route: z.string().min(1).max(200),
  /** The panel to highlight, if any. */
  panelId: z.string().min(1).max(80).optional(),
});
export type DemoScenarioStep = z.infer<typeof DemoScenarioStep>;

export const DemoScenario = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  /** ⚠️ Always true. Present as a field so a consumer filters on data, not on an id convention. */
  isDemo: z.literal(true),
  /** Recorded media the scenario plays. No live camera is required — that is the point. */
  recordingKeys: z.array(z.string().min(1)).max(50).default([]),
  steps: z.array(DemoScenarioStep).max(50).default([]),
});
export type DemoScenario = z.infer<typeof DemoScenario>;

/**
 * The demo dataset (P-5.4) — **"demo mode must never mix with production data."**
 *
 * ### ⚠️ The guarantee is a tenant boundary, not a flag
 *
 * `DemoScenario.isDemo` marks a record, and a flag is only as good as every query that remembers to
 * filter on it: one forgotten `where` in one report and a sample incident is counted in a
 * customer's compliance figures. A flag is a convention enforced by attention.
 *
 * A **separate tenant** is enforced by the isolation the platform already applies to every read and
 * write, everywhere, including the ones nobody thought about. So demo data lives in a demo *tenant*
 * — the flag stays, because a surface still needs to label what it is showing, but the flag is the
 * label and the tenant is the guarantee.
 *
 * That also makes `reset` safe to define: it is "delete this tenant's data", scoped by the same
 * boundary, rather than "delete everything flagged", which is one bad predicate away from deleting
 * a customer's incidents.
 *
 * ⚠️ **Frozen with no producer.** Nothing seeds, serves or resets a demo tenant. Demo Readiness v1
 * crosses TD-4, TD-5, TD-9, TD-13, TD-14, TD-15 and TD-16 and is scoped as its own milestone.
 */
export const DemoDataset = z.object({
  /** ⚠️ The demo tenant. Never a production tenant id — that is the whole guarantee. */
  tenantId: TenantId,
  /** ⚠️ Always true, on the tenant. A tenant either is a demo tenant or it is not. */
  isDemo: z.literal(true),
  title: z.string().min(1).max(120),
  /** What the dataset contains, so a surface can say what is sample data before showing it. */
  cameraCount: z.number().int().min(0),
  incidentCount: z.number().int().min(0),
  evidenceCount: z.number().int().min(0),
  reportCount: z.number().int().min(0),
  scenarios: z.array(DemoScenario).max(20).default([]),
  /** When the dataset was last seeded or reset. */
  seededAt: IsoDateTime,
});
export type DemoDataset = z.infer<typeof DemoDataset>;

/**
 * Reset a demo tenant to its seeded state.
 *
 * ⚠️ `confirmTenantId` must equal `tenantId`. A destructive operation whose entire safety rests on
 * the caller passing the right id gets that id typed twice — the same reason a database console
 * makes you retype the name of the thing you are dropping.
 */
export const DemoResetRequest = z
  .object({
    tenantId: TenantId,
    confirmTenantId: TenantId,
  })
  .superRefine((request, ctx) => {
    if (request.tenantId !== request.confirmTenantId) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmTenantId'],
        message: 'the confirmation must repeat the tenant being reset',
      });
    }
  });
export type DemoResetRequest = z.infer<typeof DemoResetRequest>;
