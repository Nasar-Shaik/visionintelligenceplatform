/**
 * Saved investigation contracts (P-5.2.0, Architect rec 3) — **frozen, not implemented**.
 *
 * The instruction was explicit: prepare additive contracts for saved searches, saved
 * investigations, pins, bookmarks and recents; *do not implement yet*. Nothing in the repository
 * reads or writes any of these, and the search capability register declares `investigation` and
 * `saved-search` unsupported for exactly that reason.
 *
 * ### ⚠️ Three things freezing this shape forces into the open
 *
 * **1. Saving a query makes the query contract a persisted contract.** The moment a `SavedSearch`
 * holds an `IncidentQuery`, every future change to that query surface becomes a data migration over
 * records written by customers. The mitigation is not to freeze the query harder — it is to accept
 * that a saved search can go **stale** and to say so: validity is derived on read, and a search
 * whose filters no longer parse is reported, never silently repaired. Coercing it would change what
 * the operator is looking at while still showing them the name they saved it under.
 *
 * **2. A shared saved search must run as the reader, never as its author.** Otherwise a search
 * saved by an admin becomes a privilege escalation for every viewer who opens it: the filters run,
 * the results come back, and the permission that guards those records was never consulted. The
 * stored object is a *query*, and a query carries no authority.
 *
 * **3. "Recent" is derived, not stored.** A recents list written on every open is a second audit
 * trail — the mistake CONSTRAINTS §46 exists to prevent — and it drifts from the access log that
 * already records exactly this (`AccessAuditAction.open`). Recents are a projection over that log,
 * which also means they work retroactively, for investigations opened before anyone built the
 * feature.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId, Uuid } from '../common/primitives.js';
import { SearchEntityKind } from '../search/search.js';

/**
 * Who can see a saved object.
 *
 * `tenant` shares the *definition*, not the results — see decision 2 in the header. There is
 * deliberately no `public`: nothing crosses a tenant boundary, ever (Law 5).
 */
export const SavedVisibility = z.enum(['private', 'tenant']);
export type SavedVisibility = z.infer<typeof SavedVisibility>;

/**
 * Whether a saved query still means what it meant.
 *
 * ⚠️ **Derived on read, never stored.** A stored validity flag is a cached conclusion about a
 * schema that changes independently of it — it would be computed once, at save time, and be wrong
 * forever after.
 */
export const SavedSearchValidity = z.enum([
  'valid',
  /** The stored filters no longer parse. The search is shown, disabled, with `staleReason`. */
  'stale',
]);
export type SavedSearchValidity = z.infer<typeof SavedSearchValidity>;

/**
 * A named, re-runnable query over one entity.
 *
 * `filters` is stored as written and validated against the *current* schema for `entity` on every
 * read. It is `unknown`-valued on purpose: typing it as `IncidentQuery` here would make this
 * contract depend on every entity's query shape, and would make a saved search for a camera
 * unrepresentable.
 */
export const SavedSearch = z.object({
  id: Uuid,
  tenantId: TenantId,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  entity: SearchEntityKind,
  /** Free text, if the saved search included a keyword. */
  text: z.string().max(200).optional(),
  /** The structured filters, exactly as the operator left them. Re-validated on read. */
  filters: z.record(z.string(), z.unknown()).default({}),
  visibility: SavedVisibility.default('private'),
  ownerId: z.string().min(1),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SavedSearch = z.infer<typeof SavedSearch>;

/** A saved search as returned: the record plus the validity derived at read time. */
export const SavedSearchView = z.object({
  search: SavedSearch,
  validity: SavedSearchValidity,
  /** ⚠️ Required when `validity` is `stale` — which filter stopped parsing, and why. */
  staleReason: z.string().min(1).max(300).optional(),
  derivedAt: IsoDateTime,
});
export type SavedSearchView = z.infer<typeof SavedSearchView>;

/**
 * A working set an investigator assembled: **references only**.
 *
 * ⚠️ It stores ids, never copies. An investigation that cached incident titles would show a
 * resolved incident as still open, would survive the viewer losing access to it, and would need its
 * own invalidation path for records it does not own. Every id is resolved on open, under the
 * reader's permissions, and one that no longer resolves is reported rather than dropped — an
 * investigator needs to know a piece of their case is gone.
 */
export const SavedInvestigation = z.object({
  id: Uuid,
  tenantId: TenantId,
  name: z.string().min(1).max(120),
  summary: z.string().max(4000).optional(),
  incidentIds: z.array(z.string().min(1)).max(200).default([]),
  evidenceIds: z.array(z.string().min(1)).max(500).default([]),
  eventIds: z.array(z.string().min(1)).max(500).default([]),
  /** Saved searches that define part of this investigation's scope. */
  savedSearchIds: z.array(Uuid).max(20).default([]),
  visibility: SavedVisibility.default('private'),
  ownerId: z.string().min(1),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SavedInvestigation = z.infer<typeof SavedInvestigation>;

/**
 * A pinned record — the lightweight form of the same idea. `entity` + `id`, and nothing else that
 * could go stale.
 */
export const PinnedItem = z.object({
  id: Uuid,
  tenantId: TenantId,
  entity: SearchEntityKind,
  targetId: z.string().min(1),
  /** The operator's own label, if they gave one. Their words, so it cannot be stale. */
  label: z.string().min(1).max(200).optional(),
  ownerId: z.string().min(1),
  pinnedAt: IsoDateTime,
});
export type PinnedItem = z.infer<typeof PinnedItem>;

/**
 * One entry in "recently opened" — **a projection over the access audit** (decision 3), which is
 * why it has no id, no owner field beyond the one the log already carries, and no write path.
 *
 * `openCount` and `lastOpenedAt` are aggregates over `AccessAuditEntry` rows for one target.
 */
export const RecentItem = z.object({
  entity: SearchEntityKind,
  targetId: z.string().min(1),
  lastOpenedAt: IsoDateTime,
  openCount: z.number().int().min(1),
});
export type RecentItem = z.infer<typeof RecentItem>;

export const RecentItems = z.object({
  tenantId: TenantId,
  principalId: z.string().min(1),
  items: z.array(RecentItem).default([]),
  /**
   * ⚠️ How far back the log was read. A recents list derived from a truncated window is not "the
   * last ten things", it is "the last ten things in the last N days" — and only one of those is
   * what an operator will assume.
   */
  windowDays: z.number().int().min(1),
  derivedAt: IsoDateTime,
});
export type RecentItems = z.infer<typeof RecentItems>;

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export const CreateSavedSearchInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  entity: SearchEntityKind,
  text: z.string().max(200).optional(),
  filters: z.record(z.string(), z.unknown()).default({}),
  visibility: SavedVisibility.default('private'),
});
export type CreateSavedSearchInput = z.infer<typeof CreateSavedSearchInput>;

export const CreateSavedInvestigationInput = z.object({
  name: z.string().min(1).max(120),
  summary: z.string().max(4000).optional(),
  incidentIds: z.array(z.string().min(1)).max(200).default([]),
  evidenceIds: z.array(z.string().min(1)).max(500).default([]),
  eventIds: z.array(z.string().min(1)).max(500).default([]),
  savedSearchIds: z.array(Uuid).max(20).default([]),
  visibility: SavedVisibility.default('private'),
});
export type CreateSavedInvestigationInput = z.infer<typeof CreateSavedInvestigationInput>;

export const CreatePinInput = z.object({
  entity: SearchEntityKind,
  targetId: z.string().min(1),
  label: z.string().min(1).max(200).optional(),
});
export type CreatePinInput = z.infer<typeof CreatePinInput>;

// ---------------------------------------------------------------------------------------------
// P-5.2 rec 8 — saved work is four concepts, not one.
// ---------------------------------------------------------------------------------------------

/**
 * A named workspace layout an operator saved (rec 8).
 *
 * ⚠️ **Kept separate from `SavedSearch` and `SavedInvestigation` deliberately**, because the three
 * have genuinely different lifecycles and merging them would give one record three reasons to
 * change:
 *
 * | Concept                | Lifecycle                                                                    |
 * | ---------------------- | ---------------------------------------------------------------------------- |
 * | `SavedSearch`          | Dies when the query contract changes under it — it can go **stale**          |
 * | `SavedInvestigation`   | Dies when the records it references are archived — it can lose **members**   |
 * | `SavedWorkspaceLayout` | Dies when the **layout version** changes — it can gain **unknown panels**    |
 * | Dashboard layout (Q-4) | Not this. A dashboard is a different surface with different widgets          |
 *
 * A merged "saved thing" would need all three failure modes on one record, and a reader would have
 * to know which fields were meaningful for which kind — the shape that always ends up with a
 * `type` discriminator and three optional halves.
 *
 * ⚠️ It stores **only presentation**, exactly like `WorkspaceUiState`: sizes, collapse, visibility,
 * dock. There is no incident, no filter and no evidence id here, because a *layout* that carried an
 * incident would silently reopen someone else's work when a colleague applied it.
 */
export const SavedWorkspaceLayout = z.object({
  id: Uuid,
  tenantId: TenantId,
  name: z.string().min(1).max(120),
  /** The layout version this was captured against — a panel added later is defaulted, not dropped. */
  layoutVersion: z.number().int().min(1),
  /** Per-panel presentation. Deliberately `unknown`-valued: this contract must not import the
   * console's panel-state shape and become a second definition of it. */
  panels: z.array(z.record(z.string(), z.unknown())).max(50).default([]),
  visibility: SavedVisibility.default('private'),
  ownerId: z.string().min(1),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SavedWorkspaceLayout = z.infer<typeof SavedWorkspaceLayout>;
