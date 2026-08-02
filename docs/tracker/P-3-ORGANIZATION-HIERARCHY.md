# P-3 — Organization Hierarchy

**Status:** code + tests complete · ⏳ awaiting architectural review
**Authorized:** 2026-08-02 (Architect, P-3 approval)
**Layer:** Product — the first slice built on the frozen foundations.

> P-3 **consumes** the Camera Foundation. It does not redesign it
> ([CONSTRAINTS §33](../project/CONSTRAINTS.md)).

---

## What this is for

The customer's physical world:

```
Organization → Region → Country → Branch → Site → Building → Floor → Zone → Camera
```

Every later module attaches to it. A rule is scoped to a site; an incident happened somewhere; a
permission grants access to a branch; a report covers a region. Building the hierarchy second would
mean retrofitting it into five features instead of consuming it from one.

## Where it started

P1-1 built `OrgNode` — eight types, a materialized ancestry `path`, tenant-scoped — and then nothing
used it. A tenant was provisioned with an `org` root and never gained a second node. Cameras carried a
`zoneId` the console hardcoded:

```ts
// The default zone until the org-hierarchy picker lands…
const zoneId = 'on_default';
```

Named rather than hidden, so it was obvious it was a placeholder. **It is gone.**

---

## Implemented

### Contracts (`@vip/contracts`, additive)

| Addition                                                   | Purpose                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| `OrgNodeStatus` · `OrgNode.status` · `OrgNode.archivedAt`  | Archive instead of delete. Defaults, so old records parse. |
| `ORG_NODE_TYPES` · `orgNodeRank` · `canContain`            | The containment order, as data and as a predicate.         |
| `allowedChildTypes`                                        | Served, so no client re-implements the rule.               |
| `UpdateOrgNodeInput`                                       | Rename and/or move. **No `type`** — it is immutable.       |
| `OrgCrumb` · `OrgLocation`                                 | A node resolved for display: breadcrumb, depth, label.     |
| `OrgTreeNode` · `OrgTree`                                  | The estate as a forest, with `orphaned` and `truncated`.   |
| `OrgNodeQuery` · `OrgLocationPage` · `ORG_NODE_PAGE_LIMIT` | Bounded, filtered, cursor-paged reads.                     |
| `CameraQuery` · `CameraPage` · `CAMERA_ZONE_FILTER_LIMIT`  | The zone-set filter — the estate reaching the inventory.   |

### Tenant service

- **`domain/hierarchy.ts`** (new, pure): `containmentError` · `resolveLocation` · `buildTree` ·
  `moveError` · `movedPaths` · `archiveError` · `restoreError` · `pathUnder` · `isActive`.
- **Use-cases:** `orgTree` · `locations` · `location` · `updateOrgNode` · `archiveOrgNode` ·
  `restoreOrgNode`, plus containment validation on `createOrgNode`.
- **Routes:** `GET /org-tree` · `GET /locations` · `GET /locations/:nodeId` ·
  `PATCH /org-nodes/:nodeId` · `POST /org-nodes/:nodeId/archive` · `.../restore`.
- **Events:** `org.node.created` · `renamed` · `moved` · `archived` · `restored` — the audit hook.
- **Indexes:** `tenant_path` (multikey) · `tenant_depth` · `tenant_status`.
- **`@vip/tenancy`:** `updateMany` and `bulkUpdate` added to `TenantRepository`.

### Camera service (additive only)

`query(scope, CameraQuery)` filters by `zoneIds`, status, lifecycle and name, cursor-paged and served
by the existing `tenant_zone` index. `GET /cameras` still returns a bare array when nothing is asked
of it, so every existing consumer is untouched.

### Console

- **`features/organization/`** — `LocationsPage` (tree, create, rename, archive/restore),
  `LocationPicker`, `orgPresentation`, `useOrganization`.
- **`on_default` removed.** Onboarding, DVR channels and discovery all ask where the camera is; the
  camera list filters by location; the detail sheet shows the resolved path.
- Nav entry + `/locations` route.

---

## The four decisions

Recorded in full in [ADR-0025](../adr/ADR-0025-organization-hierarchy.md).

1. **Containment is enforced; levels may be skipped, never inverted.** `org → site → zone` is a valid
   estate for a one-building customer. `floor → region` is not a hierarchy.
2. **Traversal is owned by the backend and served resolved.** The console renders breadcrumbs; it
   never builds them.
3. **Locations are archived, never deleted.** No `DELETE` route exists.
4. **The Camera Service filters by zone ids and never learns what a site is.**

---

## Tests

| Area                             | Where                                 | What it protects                                      |
| -------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| Containment                      | `hierarchy.test.ts`, `tenant.test.ts` | Order, skipping, inversion, self-nesting, root rules. |
| Breadcrumbs                      | `hierarchy.test.ts`, `http.test.ts`   | Ancestry, depth, label; gaps left visible.            |
| Tree                             | `hierarchy.test.ts`                   | Nesting, orphans, sibling order, forests, subtrees.   |
| Cycle prevention                 | `hierarchy.test.ts`, `http.test.ts`   | Under itself, under a descendant.                     |
| Movement                         | both                                  | Subtree travels intact; depth tracks path.            |
| Archive                          | `hierarchy.test.ts`, `http.test.ts`   | Cascade, still resolvable, restore order, no delete.  |
| Scale                            | `hierarchy.test.ts`                   | 5,000 nodes in one pass; no O(n²) walk.               |
| Bulk readiness                   | `hierarchy.test.ts`                   | Rules are pure functions of (candidate, parent).      |
| Location filter                  | camera `http.test.ts`                 | Zone sets, paging, literal search, tenant isolation.  |
| Console renders, derives nothing | `organization.test.tsx`               | Options are the server's; no delete control exists.   |

---

## Future extension points

Documented in [ADR-0025](../adr/ADR-0025-organization-hierarchy.md), **none implemented**:

inherited permissions (Organization Admin → Branch Admin → Floor Supervisor) · bulk import
(CSV/Excel, bulk move/assign/archive) · location templates (Retail Store, Warehouse, Hospital…) ·
audit trail · localisation · non-camera assets (NVR, DVR, door controller, reader, alarm panel, fire
panel, IoT sensor, barrier).

## Out of scope

RBAC · bulk import · templates · geospatial coordinates · floor plans · capacity modelling ·
cross-tenant federation · bulk camera reassignment.

## Carried forward

- `Camera.health` is a stored summary that Foundation Principle 2 forbids (ED-0050/0051). Still open;
  it touches a shared read path.
- Camera groups (P-1 rec 5) · installer diagnostics report (rec 6) · broader onboarding UX (rec 9).

## Related

- [ADR-0025](../adr/ADR-0025-organization-hierarchy.md) — the decisions and their alternatives.
- [PRODUCT_PRINCIPLES](../project/PRODUCT_PRINCIPLES.md) · [PLATFORM_ROADMAP](../project/PLATFORM_ROADMAP.md).
- [CONSTRAINTS §33, §35–38](../project/CONSTRAINTS.md).
- [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md) — the foundation this consumes.
