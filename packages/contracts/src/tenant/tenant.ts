/**
 * Tenant + organizational-hierarchy contracts (Phase 1, P1-1).
 * The tenant is the root of all data; every record carries its `tenantId` (Law 5).
 * Grounds: docs/architecture/06-MULTI-TENANT-SAAS.md, 18-DATA-ARCHITECTURE.md,
 * docs/architecture/phase1/TENANT_ARCHITECTURE.md.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';

/**
 * Tenant lifecycle (docs/architecture/phase1/TENANT_ARCHITECTURE.md §1):
 * provisioning → active → (suspended ↔ active) → deprovisioning.
 */
export const TenantStatus = z.enum(['provisioning', 'active', 'suspended', 'deprovisioning']);
export type TenantStatus = z.infer<typeof TenantStatus>;

/**
 * DNS-safe tenant slug (also usable as a key/namespace prefix): lowercase alphanumeric +
 * internal hyphens, 3–40 chars. Stable for the life of the tenant.
 */
export const TenantSlug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'must be dns-safe: [a-z0-9-], 3–40 chars');
export type TenantSlug = z.infer<typeof TenantSlug>;

/** A tenant record as persisted/returned. */
export const Tenant = z.object({
  id: TenantId,
  slug: TenantSlug,
  name: z.string().min(1).max(200),
  status: TenantStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Tenant = z.infer<typeof Tenant>;

/** Input to create a tenant (server assigns id/status/timestamps). */
export const CreateTenantInput = z.object({
  slug: TenantSlug,
  name: z.string().min(1).max(200),
});
export type CreateTenantInput = z.infer<typeof CreateTenantInput>;

/**
 * Input to update a tenant (name and/or lifecycle transition).
 *
 * ⚠️ `slug` is **absent and stays absent.** It is DNS-safe and documented as stable for the life of
 * the tenant; it is used as a key and namespace prefix, so changing it would strand every reference
 * that already spells it. A tenant that needs a different slug is a new tenant.
 *
 * ### `expectedUpdatedAt` — optimistic concurrency, added in P-6.3
 *
 * ⚠️ **Optional, and that is a compatibility decision rather than a soft guarantee.** Making it
 * required would break every existing caller — the seed, the runbooks, `curl` — on a schema whose
 * whole point is that it is additive. When it is supplied the server compares it with the stored
 * `updatedAt` and refuses a mismatch with **409**; when it is omitted the write proceeds as it
 * always has, last-write-wins.
 *
 * The console always sends it. Two administrators editing the same tenant therefore see a conflict
 * rather than one of them silently losing their change — which is the behaviour that matters,
 * because the losing administrator has no way to discover the loss.
 *
 * `updatedAt` is the version token rather than a separate counter: the tenant record has no version
 * field, and adding one would mean a migration plus a second thing that can disagree with the
 * timestamp already there.
 */
export const UpdateTenantInput = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: TenantStatus.optional(),
    expectedUpdatedAt: IsoDateTime.optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: 'at least one of name or status is required',
  });
export type UpdateTenantInput = z.infer<typeof UpdateTenantInput>;

/**
 * Organizational hierarchy node types (docs/architecture/phase1/TENANT_ARCHITECTURE.md,
 * CAMERA_ARCHITECTURE.md): `org → region → country → branch → site → building → floor → zone`.
 * The camera leaf is modeled by the camera contracts (P1-3), not here.
 */
export const OrgNodeType = z.enum([
  'org',
  'region',
  'country',
  'branch',
  'site',
  'building',
  'floor',
  'zone',
]);
export type OrgNodeType = z.infer<typeof OrgNodeType>;

/**
 * Whether a node is part of the live estate or retired from it (P-3).
 *
 * Hierarchy nodes are **never deleted**. Evidence, incidents and audit records reference locations
 * by id forever, and a reorganisation two years from now must not turn last year's investigation
 * into a dangling id. Archiving removes a node from the working estate while leaving every
 * historical reference resolvable.
 */
export const OrgNodeStatus = z.enum(['active', 'archived']);
export type OrgNodeStatus = z.infer<typeof OrgNodeStatus>;

/**
 * A node in a tenant's location tree. The `org` root has `parentId: null`. `path` is the
 * materialized list of ancestor ids (root-first, excluding self) for subtree queries.
 *
 * **`id` is the identity; `name` is a label.** Every reference anywhere in the platform — a camera's
 * `zoneId`, an event's `zoneId`, a future rule scope or permission grant — is by id. `name` is
 * customer-editable and carries no meaning the system reads: renaming "Level 3" to "Third Floor"
 * changes nothing but a screen. The neutral identifier for what a node *is* is `type`, which is why
 * `type` is immutable and never localised (localisation is a presentation concern, P-3 rec 8).
 */
export const OrgNode = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  parentId: z.string().min(1).nullable(),
  type: OrgNodeType,
  /** Customer-editable display label. Never an identifier — see the type doc. */
  name: z.string().min(1).max(200),
  path: z.array(z.string().min(1)).default([]),
  status: OrgNodeStatus.default('active'),
  archivedAt: IsoDateTime.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrgNode = z.infer<typeof OrgNode>;

/** Input to create an org node (root `org` is created with `parentId: null`). */
export const CreateOrgNodeInput = z.object({
  type: OrgNodeType,
  name: z.string().min(1).max(200),
  parentId: z.string().min(1).nullable(),
});
export type CreateOrgNodeInput = z.infer<typeof CreateOrgNodeInput>;

/**
 * Input to update an org node: rename it, move it, or both (P-3).
 *
 * A node's **type is immutable**. A floor does not become a region because someone edited a form;
 * that reinterprets every record that ever referenced it. Getting the type wrong means creating the
 * right node and moving the children — an operation whose cost is visible, which is the point.
 */
export const UpdateOrgNodeInput = z
  .object({
    name: z.string().min(1).max(200).optional(),
    /** New parent. The `org` root cannot be moved, so this is never `null`. */
    parentId: z.string().min(1).optional(),
  })
  .refine((v) => v.name !== undefined || v.parentId !== undefined, {
    message: 'at least one of name or parentId is required',
  });
export type UpdateOrgNodeInput = z.infer<typeof UpdateOrgNodeInput>;

/**
 * The hierarchy's containment order, outermost first. A node may only be placed under a node of a
 * **strictly outer** type (`ORG_NODE_TYPES.indexOf(parent) < indexOf(child)`).
 *
 * Levels may be **skipped** but never inverted: `org → site → zone` is a valid three-level estate
 * for a customer with one building, while `floor → region` is not a hierarchy at all. Requiring all
 * eight levels would make the model unusable for the small customer
 * (`docs/project/PRODUCT_PRINCIPLES.md` §7); allowing inversion would make "everything under this
 * site" an unanswerable question.
 *
 * The camera leaf is deliberately absent: a camera references its zone (`Camera.zoneId`); the tree
 * does not contain cameras. One direction of reference, one owner.
 */
export const ORG_NODE_TYPES = [
  'org',
  'region',
  'country',
  'branch',
  'site',
  'building',
  'floor',
  'zone',
] as const satisfies readonly OrgNodeType[];

/** Containment depth of a node type: `org` is 0, `zone` is 7. Structural, not a tree depth. */
export function orgNodeRank(type: OrgNodeType): number {
  return ORG_NODE_TYPES.indexOf(type);
}

/** Whether `child` may be placed directly under `parent`. Levels may be skipped, never inverted. */
export function canContain(parent: OrgNodeType, child: OrgNodeType): boolean {
  return orgNodeRank(parent) < orgNodeRank(child);
}

/** The types a node of this type may directly contain. Derived; served so no client re-derives it. */
export function allowedChildTypes(parent: OrgNodeType): OrgNodeType[] {
  return ORG_NODE_TYPES.filter((child) => canContain(parent, child));
}

/** One step of a breadcrumb: enough to render and to link, never enough to need a second call. */
export const OrgCrumb = z.object({
  id: z.string().min(1),
  type: OrgNodeType,
  name: z.string().min(1).max(200),
});
export type OrgCrumb = z.infer<typeof OrgCrumb>;

/**
 * A node **resolved for display**: its ancestry, its depth and the child types it accepts.
 *
 * The hierarchy is traversed by the backend and returned resolved (P-3 rec 3). A console that walks
 * `parentId` to build a breadcrumb has re-implemented containment in the presentation tier, where it
 * will disagree with the service the first time the rules change — the same failure P-2 removed when
 * the console stopped deriving probe-failure headlines
 * (`docs/architecture/PLATFORM_BOUNDARIES.md` rule 3).
 *
 * Every field here is **derived on read** and none of it is stored
 * ([Foundation Principle 2](../../../docs/project/FOUNDATION_PRINCIPLES.md)).
 */
export const OrgLocation = OrgNode.extend({
  /** Ancestors root-first, excluding self. Empty for a root. */
  breadcrumb: z.array(OrgCrumb).default([]),
  /** `breadcrumb.length`. A root is 0. */
  depth: z.number().int().nonnegative(),
  /** Full ancestry including self, joined for display: `Acme › EMEA › London › Lobby`. */
  label: z.string().min(1),
  /** Which node types may be created directly beneath this one. */
  allowedChildTypes: z.array(OrgNodeType).default([]),
  /** Whether this node has children. Lets a tree render a disclosure control without a probe call. */
  hasChildren: z.boolean().default(false),
});
export type OrgLocation = z.infer<typeof OrgLocation>;

/**
 * A node with its children — the shape the estate is read as.
 *
 * `cameraCount` is deliberately **absent**, and so is any other occupancy figure. The hierarchy
 * describes *places*; it does not know what stands in them. Cameras are the first thing an estate
 * contains and will not be the last — NVRs, door controllers, readers, alarm panels, sensors and
 * barriers all live somewhere (P-3 rec 10) — and a count served here would be both a second copy of
 * another context's fact and a standing assumption that cameras are the only occupant. Consumers
 * that need counts join the two reads.
 */
export interface OrgTreeNode extends OrgLocation {
  children: OrgTreeNode[];
}

/** Recursive schema for a node and its subtree. */
export const OrgTreeNode: z.ZodType<OrgTreeNode> = z.lazy(() =>
  OrgLocation.extend({ children: z.array(OrgTreeNode) }),
);

/**
 * A tenant's estate as a forest.
 *
 * A forest rather than a single root because a tenant is provisioned with one `org` root but nothing
 * structurally forbids a second, and a reader that assumed exactly one would break on the first
 * customer who has two rather than telling anyone.
 */
export const OrgTree = z.object({
  roots: z.array(OrgTreeNode),
  /** Nodes in the tree. Derived on read; never stored. */
  nodeCount: z.number().int().nonnegative(),
  /** Ids whose parent is missing from the result — surfaced rather than silently dropped. */
  orphaned: z.array(z.string()).default([]),
  /**
   * The estate exceeded what one read assembles and the result is the shallowest part of it.
   * Said out loud, because a partial tree that claims to be whole is worse than no tree.
   */
  truncated: z.boolean().default(false),
});
export type OrgTree = z.infer<typeof OrgTree>;

/** Maximum org nodes returned by one list request. */
export const ORG_NODE_PAGE_LIMIT = 200;

/**
 * A bounded, filterable org-node query (P-3 rec 5 / Architect rec 8).
 *
 * Unbounded list endpoints are fine at a hundred rows and a denial of service at a hundred thousand,
 * and the difference never shows up in a fixture. The cursor is the last node id of the previous
 * page under a stable `_id` sort — an offset would skip or repeat rows as the estate is edited,
 * which is precisely what a bulk import would do while a page was being read.
 */
export const OrgNodeQuery = z.object({
  type: OrgNodeType.optional(),
  parentId: z.string().min(1).optional(),
  /** Case-insensitive substring match on the node name. */
  search: z.string().min(1).max(200).optional(),
  /** Restrict to a subtree: everything beneath this node (excluding the node itself). */
  under: z.string().min(1).optional(),
  /** Archived nodes are excluded unless asked for. History resolves; the working estate stays clean. */
  includeArchived: z.boolean().default(false),
  limit: z.number().int().positive().max(ORG_NODE_PAGE_LIMIT).default(ORG_NODE_PAGE_LIMIT),
  cursor: z.string().min(1).optional(),
});
export type OrgNodeQuery = z.infer<typeof OrgNodeQuery>;

/** One page of resolved locations. `nextCursor` is absent when the page is the last one. */
export const OrgLocationPage = z.object({
  locations: z.array(OrgLocation),
  nextCursor: z.string().min(1).optional(),
});
export type OrgLocationPage = z.infer<typeof OrgLocationPage>;
