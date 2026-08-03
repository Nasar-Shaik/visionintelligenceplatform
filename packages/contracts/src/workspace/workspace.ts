/**
 * Investigation Workspace contracts (P-5.2.0, Architect rec 1) — **the canonical layout, frozen as
 * data**.
 *
 * The recommendation described a four-region layout and asked that it "become the reference
 * implementation and evolve only additively". A prose description cannot be evolved additively,
 * because nothing fails when someone adds a panel — so the layout is declared here as data a test
 * can read, in the same way index specifications are (CONSTRAINTS §60). Adding a region is a
 * breaking edit that fails a test; adding a panel is one line.
 *
 * ### ⚠️ What this contract is, and what it is not
 *
 * It is a **register of panels**: what each one is called, which context owns its data, which
 * permission it needs, and — the part that matters — **whether a producer for it exists yet**.
 *
 * It is not styling, sizing, or component structure. Those are the console's, and freezing them
 * here would make a CSS change a contract change. See
 * [INVESTIGATION_WORKSPACE](../../../../docs/architecture/INVESTIGATION_WORKSPACE.md) for the
 * visual specification and the keyboard map.
 *
 * ### ⚠️ Why `availability` is a first-class field
 *
 * Two panels in the approved layout have **no producer today**: AI Recommendations (no model emits
 * an `IncidentRecommendation` — P-5.1) and the cross-context halves of the timeline (the upstream
 * clients are P-5.2). A workspace that renders an empty box for these asserts "there is nothing
 * here", which is a different and wrong claim from "this deployment cannot answer that" — §44 and
 * §63 applied to a screen instead of a query. Every panel therefore declares what it needs, and the
 * console renders an explicit unavailable state rather than a void.
 */
import { z } from 'zod';

/**
 * The four regions of the workspace. **Frozen** — the layout is the layout, and a fifth region is
 * a redesign, not an addition.
 *
 * A region is also a **dock area**: `left`/`right` resize horizontally, `bottom` vertically, and
 * `center` takes whatever is left. That asymmetry is why panel size constraints below are stated
 * along an *axis* rather than as a width (see `WorkspacePanel.minSizePx`).
 */
export const WorkspaceRegion = z.enum(['left', 'center', 'right', 'bottom']);
export type WorkspaceRegion = z.infer<typeof WorkspaceRegion>;

/**
 * Which dimension a region resizes along. Derived from the region, never stored beside it — two
 * fields that must agree eventually disagree (CONSTRAINTS §46).
 */
export function regionAxis(region: WorkspaceRegion): 'horizontal' | 'vertical' {
  return region === 'bottom' ? 'vertical' : 'horizontal';
}

/**
 * Every panel in the canonical layout. **Extends additively**; a consumer that meets an unknown id
 * skips the panel rather than failing, which is why the id is the only thing it needs to know.
 */
export const WorkspacePanelId = z.enum([
  // left — what to work on
  'incident-queue',
  'saved-investigations',
  'filters',
  // center — the thing being investigated
  'evidence-viewer',
  'video-playback',
  'timeline',
  // right — what is known about it
  'incident-details',
  'rule-explanation',
  'assignments',
  'comments',
  'attachments',
  'ai-recommendations',
  // bottom — what it relates to
  'related-events',
  'related-incidents',
  'audit-trail',
]);
export type WorkspacePanelId = z.infer<typeof WorkspacePanelId>;

/**
 * Which context answers for a panel. Not decoration: a panel whose source is not `workflow` costs a
 * cross-context call, and the timeline's call budget (§63) is spent on exactly these.
 */
export const WorkspacePanelSource = z.enum([
  /** The incident document itself — no upstream call. */
  'workflow',
  'events',
  'evidence',
  'media',
  'rules',
  'camera',
  'notify',
  /** Held entirely in the browser (filters, view state). Nothing is fetched. */
  'client',
]);
export type WorkspacePanelSource = z.infer<typeof WorkspacePanelSource>;

/**
 * Whether a panel can actually answer.
 *
 * - `available` — a producer exists and the panel renders data.
 * - `deferred` — the contract is frozen and **nothing emits it yet**. The panel renders a stated
 *   reason. ⚠️ This is the value that keeps the layout honest: it is how "approved but not built"
 *   survives contact with a screen.
 * - `optional` — the deployment may or may not have configured it (an SLA policy, a notification
 *   transport). Absent is a legitimate answer, not a defect.
 */
export const WorkspacePanelAvailability = z.enum(['available', 'deferred', 'optional']);
export type WorkspacePanelAvailability = z.infer<typeof WorkspacePanelAvailability>;

export const WorkspacePanel = z.object({
  id: WorkspacePanelId,
  /** The **default dock area**. Where the panel starts, and — unless `allowedRegions` says otherwise
   * — the only place it belongs. */
  region: WorkspaceRegion,
  /** **Default position** within the region. Gaps are intentional so an insert is not a renumber. */
  order: z.number().int().min(0),
  title: z.string().min(1).max(80),
  source: WorkspacePanelSource,
  /**
   * The permission a principal needs to see it. A panel is **omitted, not disabled** when the
   * permission is absent — a greyed-out control still tells you the data exists.
   */
  permission: z.string().min(1),
  availability: WorkspacePanelAvailability,
  /**
   * ⚠️ Required when `availability` is not `available` — the sentence the console shows instead of
   * an empty panel. Enforced below, because "deferred with no explanation" is the failure mode this
   * whole field exists to prevent.
   */
  unavailableReason: z.string().min(1).max(300).optional(),

  // -------------------------------------------------------------------------------------------
  // Dock behaviour (P-5.2.0 refinement 1) — VS Code / Azure Portal / Grafana semantics.
  // -------------------------------------------------------------------------------------------

  /**
   * Dock areas the operator may move this panel to. Defaults to **its own region only** — a panel
   * is not relocatable until someone decides it is, because "draggable everywhere" produces layouts
   * that cannot be supported and screenshots that do not match the documentation.
   */
  allowedRegions: z.array(WorkspaceRegion).min(1).optional(),
  /**
   * Size bounds in CSS pixels **along the region's resize axis** — width for `left`/`right`, height
   * for `bottom`.
   *
   * ⚠️ Deliberately not called `minWidth`. Three of the four regions resize horizontally and one
   * does not; a width-only contract leaves the bottom dock's constraint inexpressible, and the first
   * person to need it either adds a second field or quietly reuses the wrong one.
   */
  minSizePx: z.number().int().min(0).optional(),
  maxSizePx: z.number().int().min(0).optional(),
  /** Starting size along the same axis. Absent ⇒ the region's own default split. */
  defaultSizePx: z.number().int().min(0).optional(),
  /** Whether the operator may drag this panel's edge. */
  resizable: z.boolean().default(true),
  /** Whether the operator may collapse it to its header. */
  collapsible: z.boolean().default(true),
  /** Whether the operator may remove it from the layout entirely. */
  hideable: z.boolean().default(true),
  /**
   * Whether it may float **within the workspace** — a draggable window over the dock grid, the way
   * Grafana floats a panel for a closer look without giving up the surrounding context.
   */
  floatable: z.boolean().default(false),
  /**
   * ⚠️ Whether it may be **detached into a separate OS window** — a second monitor, which is how
   * control rooms actually work (P-5.2 rec 2). **Reserved: no runtime behaviour today.**
   *
   * Deliberately a different field from `floatable`, because they are different problems. Floating
   * is a CSS position inside one document. Detaching crosses a window boundary: a second document
   * with its own React root, its own query cache, and — the part that decides the design — **its own
   * copy of nothing**. A detached panel re-fetches under the same principal and the same tenant; it
   * never receives a serialised record through `postMessage`, because that is a cached business
   * record living outside every permission check that guards it (§66).
   */
  detachable: z.boolean().default(false),
  /**
   * Responsive drop order (rec 1). **Lower survives longer**: when the viewport cannot hold every
   * region, panels are collapsed, then tabbed, then dropped in **descending** priority.
   *
   * ⚠️ This exists so the responsive behaviour is *data* rather than a table in a design document.
   * DESIGN_SYSTEM v2 §20 described the drop order in prose; prose cannot be checked, and the first
   * panel added after it was written would have had no defined place in the sequence.
   */
  priority: z.number().int().min(0).max(100).default(50),
  /**
   * The stable key this panel's per-operator UI state is stored under.
   *
   * ⚠️ **It is not the panel id, and it does not contain the layout version.** A key carrying the
   * version would silently reset every operator's layout on the next additive panel — which is a
   * data loss that looks like a bug in the browser. Namespaced so one key can never collide with
   * another feature's storage, and asserted stable by a test, because changing it is exactly as
   * destructive as deleting the state.
   */
  persistenceKey: z.string().regex(/^vip\.workspace\.[a-z0-9-]+$/, 'must be vip.workspace.<slug>'),
});
export type WorkspacePanel = z.infer<typeof WorkspacePanel>;

/**
 * The canonical layout. `version` is a plain integer, bumped when panels are added, so a stored
 * per-operator layout preference can tell "the user hid this" from "this did not exist yet".
 */
export const WorkspaceLayout = z
  .object({
    version: z.number().int().min(1),
    panels: z.array(WorkspacePanel).min(1),
  })
  .superRefine((layout, ctx) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const panel of layout.panels) {
      if (ids.has(panel.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate panel: ${panel.id}`, path: ['panels'] });
      }
      ids.add(panel.id);

      /* Two panels sharing a persistence key overwrite each other's state — silently, and only for
       * operators who moved both. Cheap to assert, effectively undebuggable in the field. */
      if (keys.has(panel.persistenceKey)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate persistenceKey: ${panel.persistenceKey}`,
          path: ['panels'],
        });
      }
      keys.add(panel.persistenceKey);

      if (panel.availability !== 'available' && panel.unavailableReason === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `panel ${panel.id} is ${panel.availability} and must state why`,
          path: ['panels'],
        });
      }
      if (
        panel.minSizePx !== undefined &&
        panel.maxSizePx !== undefined &&
        panel.minSizePx > panel.maxSizePx
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `panel ${panel.id} has minSizePx > maxSizePx`,
          path: ['panels'],
        });
      }
      /* A panel that cannot be resized but declares a range is stating an intent nothing enforces. */
      if (!panel.resizable && (panel.minSizePx !== undefined || panel.maxSizePx !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          message: `panel ${panel.id} is not resizable and must not declare size bounds`,
          path: ['panels'],
        });
      }
      /*
       * ⚠️ A panel that cannot be hidden cannot be dropped, so it must be one that survives longest.
       * Without this, a non-hideable panel with a high priority produces a responsive rule that
       * contradicts itself — and the resolution would be decided by whichever code path ran first.
       */
      if (!panel.hideable && panel.priority > 20) {
        ctx.addIssue({
          code: 'custom',
          message: `panel ${panel.id} cannot be hidden, so its priority must be <= 20 (is ${panel.priority})`,
          path: ['panels'],
        });
      }
      if (panel.allowedRegions !== undefined && !panel.allowedRegions.includes(panel.region)) {
        ctx.addIssue({
          code: 'custom',
          message: `panel ${panel.id} may not be docked in its own default region`,
          path: ['panels'],
        });
      }
    }
  });
export type WorkspaceLayout = z.infer<typeof WorkspaceLayout>;

/**
 * **The frozen layout** (P-5.2.0). This is the reference implementation the recommendation asked
 * for; the console renders from it rather than hard-coding a region per component.
 *
 * Panels are listed region by region in the order the Architect gave them.
 */
export const INVESTIGATION_WORKSPACE_LAYOUT: WorkspaceLayout = {
  version: 1,
  panels: [
    {
      id: 'incident-queue',
      region: 'left',
      order: 0,
      title: 'Incident Queue',
      source: 'workflow',
      permission: 'incident:read',
      availability: 'available',
      minSizePx: 260,
      maxSizePx: 520,
      defaultSizePx: 320,
      resizable: true,
      /* The queue is what the workspace is for. An operator who hides it has no way back to work. */
      collapsible: false,
      hideable: false,
      floatable: true,
      detachable: true,
      priority: 0,
      persistenceKey: 'vip.workspace.incident-queue',
    },
    {
      id: 'saved-investigations',
      region: 'left',
      order: 10,
      title: 'Saved Investigations',
      source: 'workflow',
      permission: 'investigation:read',
      availability: 'deferred',
      unavailableReason: 'Saved investigations are contract-frozen; no store is implemented yet.',
      minSizePx: 260,
      maxSizePx: 520,
      resizable: true,
      collapsible: true,
      hideable: true,
      floatable: false,
      detachable: false,
      priority: 80,
      persistenceKey: 'vip.workspace.saved-investigations',
    },
    {
      id: 'filters',
      region: 'left',
      order: 20,
      title: 'Filters',
      source: 'client',
      permission: 'incident:read',
      availability: 'available',
      minSizePx: 260,
      maxSizePx: 520,
      resizable: true,
      collapsible: true,
      hideable: true,
      floatable: false,
      detachable: false,
      priority: 50,
      persistenceKey: 'vip.workspace.filters',
    },
    {
      id: 'evidence-viewer',
      region: 'center',
      order: 0,
      title: 'Evidence',
      source: 'evidence',
      permission: 'evidence:read',
      availability: 'available',
      resizable: false,
      collapsible: false,
      hideable: false,
      /* A second monitor showing the footage is how control rooms actually work. */
      floatable: true,
      detachable: true,
      priority: 5,
      persistenceKey: 'vip.workspace.evidence-viewer',
    },
    {
      id: 'video-playback',
      region: 'center',
      order: 10,
      title: 'Playback',
      source: 'media',
      permission: 'stream:read',
      availability: 'available',
      resizable: false,
      collapsible: false,
      hideable: false,
      floatable: true,
      detachable: true,
      priority: 5,
      persistenceKey: 'vip.workspace.video-playback',
    },
    {
      id: 'timeline',
      region: 'center',
      order: 20,
      title: 'Timeline',
      source: 'workflow',
      permission: 'incident:read',
      availability: 'available',
      minSizePx: 120,
      maxSizePx: 400,
      defaultSizePx: 180,
      resizable: true,
      collapsible: true,
      hideable: false,
      floatable: false,
      detachable: false,
      priority: 15,
      persistenceKey: 'vip.workspace.timeline',
    },
    {
      id: 'incident-details',
      region: 'right',
      order: 0,
      title: 'Details',
      source: 'workflow',
      permission: 'incident:read',
      availability: 'available',
      minSizePx: 300,
      maxSizePx: 560,
      defaultSizePx: 380,
      resizable: true,
      collapsible: false,
      hideable: false,
      floatable: false,
      detachable: false,
      priority: 10,
      persistenceKey: 'vip.workspace.incident-details',
    },
    {
      id: 'rule-explanation',
      region: 'right',
      order: 10,
      title: 'Why This Fired',
      source: 'rules',
      permission: 'rule:read',
      availability: 'available',
      minSizePx: 300,
      maxSizePx: 560,
      resizable: true,
      collapsible: true,
      hideable: true,
      floatable: false,
      detachable: false,
      priority: 40,
      persistenceKey: 'vip.workspace.rule-explanation',
    },
    {
      id: 'assignments',
      region: 'right',
      order: 20,
      title: 'Assignment',
      source: 'workflow',
      permission: 'incident:read',
      availability: 'available',
      minSizePx: 300,
      maxSizePx: 560,
      resizable: true,
      collapsible: true,
      hideable: true,
      floatable: false,
      detachable: false,
      priority: 35,
      persistenceKey: 'vip.workspace.assignments',
    },
    {
      id: 'comments',
      region: 'right',
      order: 30,
      title: 'Comments',
      source: 'workflow',
      permission: 'incident:read',
      availability: 'available',
      minSizePx: 300,
      maxSizePx: 560,
      resizable: true,
      collapsible: true,
      hideable: true,
      floatable: false,
      detachable: false,
      priority: 30,
      persistenceKey: 'vip.workspace.comments',
    },
    {
      id: 'attachments',
      region: 'right',
      order: 40,
      title: 'Attachments',
      source: 'workflow',
      permission: 'incident:read',
      availability: 'available',
      minSizePx: 300,
      maxSizePx: 560,
      resizable: true,
      collapsible: true,
      hideable: true,
      floatable: false,
      detachable: false,
      priority: 45,
      persistenceKey: 'vip.workspace.attachments',
    },
    {
      id: 'ai-recommendations',
      region: 'right',
      order: 50,
      title: 'AI Recommendations',
      source: 'workflow',
      permission: 'incident:read',
      availability: 'deferred',
      /*
       * ⚠️ The single most important string in this file. `IncidentRecommendation` was frozen in
       * P-5.1 with no producer, and a panel that renders "no recommendations" for an incident an AI
       * has never looked at is a confident false statement inside an investigation record.
       */
      unavailableReason:
        'No AI advisor is configured. This is not "no recommendations" — nothing has analysed this incident.',
      minSizePx: 300,
      maxSizePx: 560,
      resizable: true,
      collapsible: true,
      hideable: true,
      floatable: false,
      detachable: false,
      priority: 85,
      persistenceKey: 'vip.workspace.ai-recommendations',
    },
    {
      id: 'related-events',
      region: 'bottom',
      order: 0,
      title: 'Related Events',
      source: 'events',
      permission: 'event:read',
      availability: 'available',
      /* Bottom docks resize vertically — these are heights. See `regionAxis`. */
      minSizePx: 140,
      maxSizePx: 600,
      defaultSizePx: 220,
      resizable: true,
      collapsible: true,
      hideable: true,
      floatable: false,
      detachable: false,
      priority: 60,
      persistenceKey: 'vip.workspace.related-events',
    },
    {
      id: 'related-incidents',
      region: 'bottom',
      order: 10,
      title: 'Related Incidents',
      source: 'workflow',
      permission: 'incident:read',
      availability: 'available',
      minSizePx: 140,
      maxSizePx: 600,
      defaultSizePx: 220,
      resizable: true,
      collapsible: true,
      hideable: true,
      floatable: false,
      detachable: false,
      priority: 65,
      persistenceKey: 'vip.workspace.related-incidents',
    },
    {
      id: 'audit-trail',
      region: 'bottom',
      order: 20,
      title: 'Audit Trail',
      source: 'workflow',
      permission: 'incident:read',
      availability: 'available',
      minSizePx: 140,
      maxSizePx: 600,
      defaultSizePx: 220,
      resizable: true,
      collapsible: true,
      hideable: true,
      floatable: false,
      detachable: false,
      priority: 70,
      persistenceKey: 'vip.workspace.audit-trail',
    },
  ],
};
