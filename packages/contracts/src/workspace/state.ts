/**
 * Workspace state persistence (P-5.2.0, refinement 3) — **"persist only UI state, never business
 * state", made structural**.
 *
 * ### ⚠️ Where the line actually falls
 *
 * The instruction is right, and the list it came with quietly crosses it in three places: "current
 * incident", "selected evidence" and "applied filters" are not UI state in the way a panel width
 * is. The distinction that survives contact with the code is not *UI vs business* but:
 *
 * > **A reference may be persisted. A record may not.**
 *
 * `incidentId: "abc"` is a pointer. It goes stale safely — you re-fetch and get a 404, a 403, or
 * the current truth. `{id: "abc", status: "resolved", title: "Loitering at Dock 3"}` is a *copy*,
 * and a copy in a browser is a second source of truth with no invalidation, no tenant check and no
 * permission check. It renders a stale status confidently, and it renders it after the operator's
 * access has been revoked.
 *
 * So every field below is a scalar, an enum, a number, or an **id**. There is no place in this
 * contract to put a record, and that is the design.
 *
 * ### ⚠️ Two consequences that are easy to miss
 *
 * **Restore is a re-fetch, not a rehydrate.** Every persisted id is resolved through the API on
 * restore, under the current principal's permissions. A reference that no longer resolves is
 * **dropped and reported** (`WorkspaceStateRestore.dropped`), never silently ignored — an operator
 * whose workspace quietly loses a tab assumes they closed it.
 *
 * **State is scoped per tenant *and* per principal.** A shared control-room browser must not
 * restore one operator's open incidents for the next shift, and a user with access to two tenants
 * must not carry tenant A's incident id into tenant B — where it resolves to nothing, or, far
 * worse, to a different record with the same id. The scope is part of the storage key, not a field
 * that a reader is trusted to check.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId, Uuid } from '../common/primitives.js';
import { WorkspacePanelId, WorkspaceRegion } from './workspace.js';

/**
 * The persisted shape's own version.
 *
 * ⚠️ Distinct from `WorkspaceLayout.version`, and deliberately so. The layout version changes when
 * a *panel* is added, which must **not** reset an operator's saved sizes; this one changes when the
 * *shape of this file* changes, which must discard them. Conflating the two either throws away
 * layouts on every feature, or half-applies an incompatible one.
 */
export const WORKSPACE_STATE_SCHEMA_VERSION = 1;

/**
 * One panel's remembered presentation. Every field is view state; none of it is data.
 *
 * ⚠️ **`panelVersion` is per panel, and that is the whole point** (P-5.3, rec 3). The requirement —
 * *future panel evolution must never invalidate saved layouts* — is not met by a global counter: a
 * global bump discards every panel's state to fix one. A per-panel version lets exactly the panel
 * whose state shape changed be reset to its registry default while every other panel's sizing,
 * collapse and dock survive untouched.
 *
 * Absent means version 1, so every layout saved before this field existed keeps working.
 */
export const WorkspacePanelState = z.object({
  panelId: WorkspacePanelId,
  panelVersion: z.number().int().min(1).optional(),
  collapsed: z.boolean().optional(),
  hidden: z.boolean().optional(),
  /** Along the region's resize axis — see `regionAxis`. */
  sizePx: z.number().int().min(0).max(4000).optional(),
  /** Set only when the operator moved the panel out of its default dock. */
  region: WorkspaceRegion.optional(),
  floating: z.boolean().optional(),
});
export type WorkspacePanelState = z.infer<typeof WorkspacePanelState>;

/**
 * One open tab — **an id and when it was opened, and nothing else.**
 *
 * The temptation is to cache the title so the tab strip renders before the fetch resolves. That
 * cached title is a record (see the header), it outlives the operator's access to it, and it is
 * wrong the moment someone renames or resolves the incident. A tab renders a skeleton instead.
 */
export const WorkspaceTab = z.object({
  incidentId: z.string().min(1),
  openedAt: IsoDateTime,
});
export type WorkspaceTab = z.infer<typeof WorkspaceTab>;

/** Transient view state for the centre region. Pure presentation. */
export const WorkspaceViewState = z.object({
  /** Seconds from the playback session's start. Meaningless without `selectedSource`, hence paired. */
  playbackPositionSeconds: z.number().min(0).optional(),
  /**
   * Playback rate the operator left it at (P-5.2 rec 4). Restored so a reviewer who works at 4×
   * does not reset to 1× on every incident.
   */
  playbackRate: z.number().positive().max(64).optional(),
  /** Zoom factor on the timeline track. 1 = the full incident window. */
  timelineZoom: z.number().min(0.1).max(100).optional(),
  /** Zoom factor on the evidence/playback viewport. 1 = fit. */
  viewerZoom: z.number().min(0.1).max(32).optional(),
  /** Which evidence item is open in the viewer — an id, resolved on restore. */
  selectedEvidenceId: z.string().min(1).optional(),
  /** Which camera's footage is showing — an id, resolved on restore (rec 4). */
  selectedCameraId: z.string().min(1).optional(),
  /** Which incident is in focus — an id, resolved on restore. */
  currentIncidentId: z.string().min(1).optional(),
});
export type WorkspaceViewState = z.infer<typeof WorkspaceViewState>;

/**
 * The persisted workspace state for one principal in one tenant.
 *
 * ⚠️ `filters` and `searchQuery` are stored **as written**, and re-validated on restore against the
 * *current* `IncidentQuery` schema. A filter that no longer parses — because a field was renamed,
 * or because the operator's role changed — is dropped and reported. The alternative, coercing the
 * saved filter into something that parses, silently changes what the operator is looking at while
 * showing them the label they saved.
 */
export const WorkspaceUiState = z.object({
  schemaVersion: z.number().int().min(1),
  /** Part of the storage scope, repeated here so a mis-scoped read is detectable rather than silent. */
  tenantId: TenantId,
  principalId: z.string().min(1),
  /**
   * The layout this state was captured against, so a panel added later is defaulted, not dropped.
   *
   * ⚠️ **There is deliberately no third `migrationVersion`.** The review asked for three counters;
   * two answer distinct questions and a third answers none. `schemaVersion` asks *can this file
   * still be parsed* (a mismatch discards everything); `layoutVersion` asks *which panels existed
   * when this was saved* (a mismatch discards nothing, because per-panel state is independently
   * defaulted); `panelVersion` asks *is this one panel's state still meaningful*. A migration
   * counter would have to mean one of those three, and whichever it meant, two numbers would then
   * have to agree forever.
   */
  layoutVersion: z.number().int().min(1),
  panels: z.array(WorkspacePanelState).max(50).default([]),
  view: WorkspaceViewState.default({}),
  tabs: z.array(WorkspaceTab).max(20).default([]),
  /** The incident filter set as the operator left it. Re-validated on restore, never coerced. */
  filters: z.record(z.string(), z.unknown()).optional(),
  /** The free-text search box's contents. Text, not results. */
  searchQuery: z.string().max(500).optional(),
  /**
   * Bookmarks the operator has open in this session (P-5.2 rec 4) — **ids only**. The bookmark
   * records themselves live in the Workflow context and are re-fetched; caching their labels here
   * would put a copy of a mutable record in a browser, which is the one thing this contract exists
   * to prevent.
   */
  bookmarkIds: z.array(Uuid).max(100).default([]),
  updatedAt: IsoDateTime,
});
export type WorkspaceUiState = z.infer<typeof WorkspaceUiState>;

/*
 * ⚠️ **`InvestigationSession` is the record above.** The P-5.2 review named the concept
 * *InvestigationSession*, and it describes exactly what `WorkspaceUiState` already holds: the
 * incident, the evidence ids, the selected camera, playback position and rate, filters, zoom, open
 * panels, layout and bookmarks.
 *
 * A second exported type carrying the other name would be two schemas for one record — the
 * duplicate source of truth that recommendation 17 of the same review warns against. The
 * vocabulary is recorded here instead, so the name survives without the drift.
 */

/** Why a persisted reference did not survive the restore. */
export const WorkspaceStateDropReason = z.enum([
  /** The referenced record no longer exists. */
  'not-found',
  /** It exists, but this principal may not see it — the case that must never render from cache. */
  'forbidden',
  /** It belongs to a different tenant than the one now active. */
  'wrong-tenant',
  /** The saved filter no longer parses against the current query contract. */
  'invalid',
  /** The state was written by an incompatible schema version and was discarded whole. */
  'stale-schema',
]);
export type WorkspaceStateDropReason = z.infer<typeof WorkspaceStateDropReason>;

export const WorkspaceStateDrop = z.object({
  /** Dotted path into `WorkspaceUiState`, e.g. `tabs[2].incidentId`. */
  path: z.string().min(1),
  reason: WorkspaceStateDropReason,
  detail: z.string().min(1).max(300),
});
export type WorkspaceStateDrop = z.infer<typeof WorkspaceStateDrop>;

/**
 * The result of restoring a workspace: what survived, and ⚠️ **everything that did not, with a
 * reason**. `dropped` empty means the restore was complete.
 */
export const WorkspaceStateRestore = z.object({
  state: WorkspaceUiState,
  dropped: z.array(WorkspaceStateDrop).default([]),
  restoredAt: IsoDateTime,
});
export type WorkspaceStateRestore = z.infer<typeof WorkspaceStateRestore>;

/**
 * The storage key for a principal's workspace state.
 *
 * ⚠️ The tenant and principal are in the **key**, not merely in the value. A reader that has to
 * remember to compare `state.tenantId` will one day not, and the failure is cross-tenant state in a
 * shared browser — the one class of bug the platform's tenant isolation exists to make impossible
 * (Law 5). Getting the key wrong returns nothing; forgetting a field check returns someone else's
 * workspace.
 */
export function workspaceStateKey(tenantId: string, principalId: string): string {
  return `vip.workspace.state.${tenantId}.${principalId}`;
}
