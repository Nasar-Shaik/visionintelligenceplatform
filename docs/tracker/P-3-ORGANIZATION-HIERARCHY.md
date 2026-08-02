# P-3 — Organization Hierarchy

**Status:** ✅ ACCEPTED (Architect, 2026-08-02) · hardening complete · **Location Hierarchy v1.0 FROZEN**
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

---

## Acceptance hardening (2026-08-02)

Approved with fifteen recommendations, folded in as verification and governance. **No runtime
behaviour changed; no capability was added.**

### What the verification found

| #   | Finding                                                                    | Outcome                   |
| --- | -------------------------------------------------------------------------- | ------------------------- |
| 1   | `tenant_zone` lacked `_id` — the location filter's sort was done in memory | fixed                     |
| 2   | The subtree tree read had no index serving `path` + `depth`                | `tenant_path_depth` added |
| 3   | The unfiltered paged camera listing had no covering index                  | `tenant_cursor` added     |
| 4   | Evidence resolves a location's ancestry as it is **now**, not as it was    | **carried forward**       |

Findings 1–3 came from making index coverage _checkable_ rather than reviewable: specs are declared as
data and a test asserts the planner can serve each query without a blocking sort. None had been caught
by review, and none is visible against a test fixture.

### What was verified

- **Twelve invariants**, each asserted by a test — including that containment **bounds depth at 7**,
  which is what makes the depth-recursive helpers safe at any estate size.
- **Move integrity at every level** — zone, floor, building, site, branch, country, region — plus a
  chain of moves and a 10,000-node subtree move, each checking ancestry, breadcrumbs, paths,
  descendants and references.
- **Enterprise scale**: a 101,001-node single-tenant estate built in one pass; growth confirmed
  linear rather than quadratic; breadcrumb cost independent of estate size.
- **Six future query verbs** (`path` · `ancestors` · `descendants`/`under` · `within` · `siblings` ·
  `children`, plus `level`) answerable from indexed fields already stored — none implemented.
- **Additive evolution** for location metadata and external references — none implemented.
- **Asset neutrality**: no occupancy field, no device word in the vocabulary; any occupant attaches
  by reference.
- **Bulk-import reuse**: byte-identical validation from CSV, Excel, ERP, AD, REST or HR; 10,000 rows
  with no store access.
- **P-4 readiness**: a rule scopes to a node id and resolves its zones with one indexed predicate.
  **No hierarchy contract change is required for P-4.**

### Complexity, as an architectural expectation

`lookup` O(1) · `breadcrumb` O(d≤7) · `subtree` O(log n + k) · `page` O(log n + p) · `tree` O(n) ·
`move` O(k) · `rename` O(1) · `camera by location` O(log n + p). Full table in
[HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md).

### 🔒 Frozen

```
Foundation:  Location Hierarchy      Version:   1.0
Status:      FROZEN                  Evolution: Additive only
Frozen:      2026-08-02              Breaking:  ADR required
```

Declared in `FOUNDATIONS` (`@vip/contracts`) and recorded in
[HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md). The first **product-layer**
subsystem to be frozen — for the same reason the foundations were: everything else attaches to it.

## Carried forward

- **Historical location resolution** (P-3 review rec 4). Evidence recorded in Zone A resolves to
  Zone B after the camera moves. No reference dangles; the _answer_ changes. The fix freezes `zoneId`
  and its `path` on the evidence record at write time — an additive **Evidence-context** change
  needing no hierarchy change. The test asserting today's behaviour fails when it is fixed.
- `Camera.health` is a stored summary that Foundation Principle 2 forbids (ED-0050/0051). Still open;
  it touches a shared read path.
- **Unanchored substring search is not index-served.** Bounded, but a scan at extreme scale; the
  mitigation is a text index or anchored prefix search, neither needing a model change.
- Camera groups (P-1 rec 5) · installer diagnostics report (rec 6) · broader onboarding UX (rec 9).

## Related

- [ADR-0025](../adr/ADR-0025-organization-hierarchy.md) — the decisions and their alternatives.
- [PRODUCT_PRINCIPLES](../project/PRODUCT_PRINCIPLES.md) · [PLATFORM_ROADMAP](../project/PLATFORM_ROADMAP.md).
- [CONSTRAINTS §33, §35–38](../project/CONSTRAINTS.md).
- [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md) — the foundation this consumes.
