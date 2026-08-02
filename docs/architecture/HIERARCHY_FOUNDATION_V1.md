# Location Hierarchy Foundation v1.0 — Freeze Record

```
Foundation:  Location Hierarchy
Version:     1.0
Status:      FROZEN
Evolution:   Additive only
Frozen:      2026-08-02 (Principal Architect, P-3 acceptance)
Authority:   ADR-0025 · CONSTRAINTS §33, §35–39
```

> This version is **governance metadata**. Nothing in the platform branches on it, and nothing ever
> may — the same rule, and the same test, as every other foundation.

---

## A note on the name

The Architect's review recommended calling this subsystem the **Location Hierarchy** rather than the
Organization Hierarchy, because it models the **physical world** rather than organizational
ownership. That is right, and the documentation adopts it.

**The code keeps its existing names** — `OrgNode`, `OrgNodeType`, `/org-nodes`, `orgNodes`. Renaming
published contracts and routes is the one change the freeze forbids without an ADR, and the benefit
here is clarity of prose rather than of behaviour. A rename would be a breaking change bought for a
documentation improvement. The console already says "Locations" everywhere a customer can see.

Read `Org*` in code as "a node of the location hierarchy". The root type is still `org`, and
correctly so: the top of a customer's physical world is their organization.

---

## What is frozen

| Concern                | Where it lives                                                          |
| ---------------------- | ----------------------------------------------------------------------- |
| Containment rules      | `@vip/contracts` `ORG_NODE_TYPES` · `canContain` · `allowedChildTypes`  |
| Node model             | `@vip/contracts` `OrgNode` · `OrgNodeStatus`                            |
| Resolved read models   | `@vip/contracts` `OrgLocation` · `OrgCrumb` · `OrgTreeNode` · `OrgTree` |
| Bounded queries        | `@vip/contracts` `OrgNodeQuery` · `OrgLocationPage`                     |
| Traversal & validation | `services/tenant/src/domain/hierarchy.ts`                               |
| Use-cases              | `services/tenant/src/application/tenant-service.ts`                     |
| Persistence + indexes  | `services/tenant/src/adapters/mongo.ts` (`org_nodes`)                   |
| Estate presentation    | `apps/console/src/features/organization/`                               |

## What "frozen" means

**Allowed, without ceremony:**

- a new optional field on `OrgNode` or `OrgLocation` (metadata, external references — see below)
- a new derived read (a query verb, a projection, a rollup)
- a new bounded query parameter
- a bug fix that makes the code match the documented behaviour

**Requires an ADR:**

- changing what an existing field means
- removing or renaming anything published (including the `Org*` names)
- **adding a level to `ORG_NODE_TYPES`** — see the caveat
- making an existing optional field required
- storing anything currently derived (breadcrumb, label, depth, health, counts)
- a `DELETE` path on a location, in any form

> **The enum caveat, again.** `ORG_NODE_TYPES` is an ordered, published enum and the containment
> rules are computed from its **order**. Inserting a level changes the rank of every level below it.
> Existing records are unaffected — ranks are computed, never stored — but a strict consumer parsing
> `OrgNodeType` rejects a value it does not know. Eight levels were chosen to cover the enterprise
> case; adding a ninth is an ADR, not a convenience.

---

## The four load-bearing decisions

Recorded in full in [ADR-0025](../adr/ADR-0025-organization-hierarchy.md).

1. **Containment is enforced.** Any _strictly outer_ type may contain any inner one — levels may be
   skipped, never inverted.
2. **Traversal is owned by the backend**, and reads arrive resolved. No client rebuilds ancestry.
3. **Locations are archived, never deleted.** There is no `DELETE` route; its absence is the
   guarantee.
4. **Occupants reference locations; locations do not know their occupants.** One direction, one
   owner.

---

# The invariants

The architectural laws of this subsystem. Each is asserted by a test in
`services/tenant/test/hierarchy-invariants.test.ts` — a law recorded only in prose is one nobody
finds out has been broken.

| #   | Invariant                   | Statement                                                                                |
| --- | --------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | **One parent**              | Every node has exactly one parent, or is a root (`parentId: null`).                      |
| 2   | **No cycles**               | A node is never its own ancestor. A move under self or a descendant is refused.          |
| 3   | **Path validity**           | `node.path === [...parent.path, parent.id]`, and every id in it resolves.                |
| 4   | **Depth correctness**       | `node.depth === node.path.length`, always, including after a move.                       |
| 5   | **Bounded depth**           | Containment caps any chain at 8 nodes, so depth never exceeds 7.                         |
| 6   | **Immutable identity**      | `id` never changes. `type` never changes. Neither is editable through any route.         |
| 7   | **Editable names**          | `name` is a label; changing it alters no id, path, parent or reference.                  |
| 8   | **Containment preserved**   | Every parent–child pair satisfies `canContain`, before and after any move.               |
| 9   | **Backend-owned traversal** | Breadcrumb, depth, label and permitted children are derived server-side.                 |
| 10  | **No deletion**             | Locations are archived. No route removes one, and an archived node still resolves.       |
| 11  | **Occupant independence**   | The hierarchy stores no occupancy of any kind and names no device type.                  |
| 12  | **Tenant isolation**        | Every query is tenant-scoped by the repository guard; every index leads with `tenantId`. |

Invariant 5 is worth reading twice: it is a **consequence of containment**, not a convention.
`canContain` requires the parent's rank to be strictly lower than the child's, so a root-to-leaf chain
has strictly increasing ranks drawn from eight values. No import, customer or bug can produce a deeper
one — which is what makes the depth-recursive helpers safe rather than a stack overflow waiting for a
large estate.

---

# Algorithmic complexity

The architectural expectations. `n` = nodes in the tenant; `d` = depth (≤ 7); `k` = subtree size;
`p` = page size.

| Operation                   | Complexity        | How                                                        |
| --------------------------- | ----------------- | ---------------------------------------------------------- |
| `lookup(node)`              | **O(1)**          | `_id_`, unique.                                            |
| `breadcrumb(node)`          | **O(d)** ≤ 7      | One `$in` over the stored path; `d` map lookups to render. |
| `ancestors(node)`           | **O(d)**, 1 query | The path _is_ the ancestry — no walk.                      |
| `children(node)`            | **O(log n + p)**  | `tenant_parent`, paged.                                    |
| `siblings(node)`            | **O(log n + p)**  | `tenant_parent`, paged.                                    |
| `subtree(node)` / `under()` | **O(log n + k)**  | `tenant_path` multikey — one seek, then a walk.            |
| `locations()` page          | **O(log n + p)**  | Indexed seek to the cursor, then `p` entries.              |
| `tree()`                    | **O(n)**          | One pass over one query; `n` bounded by the tree ceiling.  |
| `move(subtree)`             | **O(k)**          | One `bulkWrite`; paths computed, not re-derived per node.  |
| `archive(subtree)`          | **O(k)**          | One `updateMany` over the multikey index.                  |
| `create(node)`              | **O(1)**          | Path is the parent's path plus the parent.                 |
| `rename(node)`              | **O(1)**          | One document. No descendant is touched.                    |
| `camera lookup by location` | **O(log n + p)**  | `tenant_zone`, `$in` over the resolved subtree, paged.     |

Two of these are load-bearing and easy to lose:

- **`rename` is O(1) and `move` is O(k).** They differ because a name is not part of anyone's
  ancestry. Storing a name in the path would make renaming O(k) — the reason the path holds ids.
- **`breadcrumb` is O(d), not O(n).** Verified at a 100,000-node estate: resolving a leaf costs seven
  map lookups whether the estate holds ten nodes or a hundred thousand.

---

# Index coverage report

Generated from the declared specs in `src/adapters/indexes.ts` and asserted by
`test/index-coverage.test.ts`, which fails if a query pattern is added without a covering index.

The check answers **"will the planner use this?"**, not "does it exist" — equality keys must occupy a
contiguous prefix, and the sort key must be the next key. Anything looser would have called the two
gaps below covered.

## `org_nodes`

| Index               | Keys                               | Serves                                       |
| ------------------- | ---------------------------------- | -------------------------------------------- |
| `_id_` _(implicit)_ | `_id`                              | by-id reads · `ancestors()` via `$in`        |
| `tenant_parent`     | `tenantId, parentId, _id`          | `children()` · `siblings()`                  |
| `tenant_type`       | `tenantId, type, _id`              | "every site", "every zone"                   |
| `tenant_path`       | `tenantId, path, _id` _(multikey)_ | `under()` · `descendants()` · archive · move |
| `tenant_path_depth` | `tenantId, path, depth, _id`       | the subtree tree read, shallowest-first      |
| `tenant_depth`      | `tenantId, depth, _id`             | the whole-estate tree read                   |
| `tenant_status`     | `tenantId, status, _id`            | excluding archived from working views        |
| `tenant_name`       | `tenantId, name, _id`              | name ordering and prefix search              |

**Missing: none.** Eleven query patterns, all covered.

## `cameras`

| Index                | Keys                             | Serves                              |
| -------------------- | -------------------------------- | ----------------------------------- |
| `_id_` _(implicit)_  | `_id`                            | by-id reads                         |
| `tenant_cursor`      | `tenantId, _id`                  | the unfiltered paged listing        |
| `uniq_tenant_stream` | `tenantId, streamUrl` _(uniq)_   | idempotent onboarding → 409         |
| `tenant_zone`        | `tenantId, zoneId, _id`          | the resolved location filter, paged |
| `tenant_status`      | `tenantId, status, _id`          | enabled / disabled                  |
| `tenant_lifecycle`   | `tenantId, lifecycle.state, _id` | degraded / offline / retired        |
| `tenant_name`        | `tenantId, name, _id`            | name ordering and prefix search     |

**Missing: none** for queries the service issues. `health.status` and `lastSeen` are filtered in the
console over an already-bounded page, so there is no server-side query to index — an index for a
query nobody issues is write cost for nothing. When either becomes a `CameraQuery` field it needs
`{tenantId, <field>, _id}`, and the coverage test should gain a row.

## What the coverage check found

Three gaps, all fixed in this slice, none of which review had caught:

1. **`tenant_zone` was `{tenantId, zoneId}`.** The location filter sorts by `_id` for its cursor, so
   the filter was indexed and the sort was not — Mongo gathered every camera in the subtree and
   ordered it in memory. Correct on a four-row fixture; a blocking sort against the 32 MB limit on a
   million-camera estate.
2. **The subtree tree read had no covering index.** It filters on `path` and orders by `depth`, which
   `tenant_path` cannot serve. Added `tenant_path_depth`.
3. **The unfiltered paged camera listing had no covering index** — the simplest query an operator can
   issue was the one that sorted in memory. Added `tenant_cursor`.

**Every index now ends in `_id`**, because every bounded read pages by an `_id` cursor. That trailing
key is the difference between a page costing O(page) and O(matches), and it is asserted rather than
remembered.

---

# Verified at review (P-3 acceptance)

Each of these is asserted by a test, not by this document.
See `services/tenant/test/hierarchy-extensibility.test.ts`.

## Physical-infrastructure neutrality

The hierarchy describes **places**. It holds no `cameraCount`, no occupancy field of any kind, and no
device word anywhere in its vocabulary. A camera, an NVR, a DVR, a door controller, an alarm panel, a
fire panel, an IoT sensor or a parking barrier all attach the same way: by referencing a node id.
Adding an occupant type requires **no change to the hierarchy at all**.

## Future query verbs

Every verb the review named is answerable from fields already stored **and already indexed**, with no
new field, collection, join or recursive read:

| Verb                        | The query                                | Index           |
| --------------------------- | ---------------------------------------- | --------------- |
| `path()`                    | the stored `path` — no query             | —               |
| `ancestors()`               | `_id ∈ node.path`                        | `_id`           |
| `descendants()` / `under()` | `path: nodeId` (multikey)                | `tenant_path`   |
| `within(node, type)`        | `path: nodeId, type: t`                  | `tenant_path`   |
| `siblings()`                | `parentId: node.parentId, _id ≠ node.id` | `tenant_parent` |
| `children()`                | `parentId: nodeId`                       | `tenant_parent` |
| `level(n)`                  | `depth: n`                               | `tenant_depth`  |

None is implemented. The verification is that implementing one is a read, not a redesign.

## Enterprise scale

Target: **100 organizations · 10,000 branches · 100,000 zones · 1,000,000 cameras.**

Across 100 tenants that is ~1,100 nodes each — comfortably inside one tree read. The case tested is
the pathological one, a **single tenant holding the whole estate**:

- a **101,001-node** estate builds in **one pass**;
- growth is **linear**, asserted by comparing 5k against 20k (linear ≈ 4×, quadratic ≈ 16×);
- a subtree of any size is one indexed predicate, never a traversal;
- a 25,000-node subtree move produces its rewrites as one batch of data;
- breadcrumb resolution costs `path.length` map lookups — **independent of estate size**.

### The index change this review produced

Every bounded read pages by an `_id` cursor. Indexes that stopped at the filter key served the filter
and left Mongo to sort the matches **in memory** — invisible on a fixture, a blocking sort against
the 32 MB limit on a real estate. Every index now ends in `_id`:

```
org_nodes:  tenant_parent {tenantId, parentId, _id}   tenant_type   {tenantId, type, _id}
            tenant_path   {tenantId, path, _id}       tenant_depth  {tenantId, depth, _id}
            tenant_status {tenantId, status, _id}     tenant_name   {tenantId, name, _id}
cameras:    tenant_zone   {tenantId, zoneId, _id}
```

For the camera filter this matters most: `zoneId: {$in: […]}` sorted by `_id` now walks one range per
zone already in cursor order and merge-sorts, so paging stays O(page) rather than O(matches).

### The known limit, stated plainly

**Substring search does not use an index.** `?search=` is an unanchored regex; at a million nodes it
is a bounded scan. It is bounded (the limit caps the result, not the work), and the mitigation when a
customer reaches that scale is a text index or an anchored prefix search — a change that needs no
model change. Recorded rather than left to be discovered.

Past `ORG_TREE_LIMIT` (5,000 nodes) the whole-estate read is **not** the access path. Reads become
subtree-scoped (`?under=`) or search-scoped (`?search=`), both bounded and both indexed, and the tree
read reports `truncated: true` rather than returning a partial estate that claims to be whole.

## Bulk-import compatibility

Every rule is a pure function of a candidate and its parent, so validation is a loop with no store
access, no ordering requirement between rows and no hidden state. Verified to give **byte-identical
results** whether rows arrive from CSV, Excel, an ERP sync, an Active Directory sync, REST or an HR
feed, and to validate 10,000 rows without touching a store.

## Rename stability

A rename changes no id, no path, no `parentId` and no reference anywhere — and the rendered label
follows immediately, because it is derived rather than stored.

---

# Future capability (documented, not implemented)

Nothing below exists. Each is recorded so the milestone that needs it extends a known shape.

## Location metadata

`timezone` · `address` · `geoCoordinates` · `workingHours` · `emergencyContact` · `occupancyLimit` ·
`customAttributes`.

All arrive as **optional fields on `OrgNode`** — additive, no migration, no version. Verified: a
reader written today parses a record carrying all of them, and a record written today parses under a
schema that has them.

## External references

`externalId` · `sapId` · `erpId` · `oracleId` · `customerReference` · `legacyId`.

Same shape, same additive guarantee. Worth stating once: these are **references, never identities**.
The platform's identity for a location is its `id`, and an ERP that renumbers its own estate must not
be able to break an investigation.

## Derived location health

A building will eventually have a health state — Healthy · Warning · Critical — rolled up from camera
failures, network failures, power and connectivity.

**It must be derived on read and never stored**
([Foundation Principle 2](../project/FOUNDATION_PRINCIPLES.md)). A stored rollup is a second copy
that drifts from the evidence beneath it and freezes an explanation in the words of whatever version
wrote it. The hierarchy is also the wrong owner of the _inputs_: occupancy and device health belong
to the contexts that measure them, so a location health read is a **composition** — the subtree from
here, the health from there — exactly as the camera location filter already works.

Note this is the same shape as the one carried-forward violation: `Camera.health` is stored and
should be derived (ED-0050/0051). Location health must not repeat it.

## Historical location resolution — ⚠️ a known gap, not a future nicety

**The review asked whether evidence recorded in Zone A still resolves to Zone A after the camera
moves to Zone B. It does not. This is the one requirement from the P-3 review that is not met.**

What holds today:

- **Every reference survives.** Renames, moves, archives and restores change no id, so no
  investigation link ever dangles. Asserted by test.
- **Archival preserves history in full.** An archived location resolves with its complete breadcrumb
  — exactly when an operator most needs to know where something _used to be_.

What does not hold, and why it is two problems rather than one:

1. **A camera's `zoneId` is mutable, and evidence references the camera, not the place.** Asking
   "where did this happen" resolves through the camera to where the camera is **now**.
2. **A location's ancestry is current.** Evidence naming a zone that has since moved resolves to the
   zone's ancestry today rather than at the time of the event.

Nothing errors. The _answer changes_ — which for an investigation is worse than an error, because
nothing signals that it did.

**Neither half lives in the hierarchy.** The fix is to capture `zoneId` and its `path` **on the
evidence record at write time**, freezing the answer the way `CameraProbeRecord` already freezes a
configuration snapshot. That is an Evidence-context change (`CameraProbeRecord`, the timeline
entries), additive, and squarely a P-4+ item. The hierarchy already supplies everything required —
verified by test — which is why fixing it needs no change to anything frozen here.

Recorded in [ADR-0025](../adr/ADR-0025-organization-hierarchy.md) and carried into the P-3 tracker.
The test asserting today's behaviour is written so that **fixing it makes the test fail**, forcing it
to be rewritten as the guarantee rather than quietly passing either way.

## Inherited permissions

Organization Admin → Branch Admin → Building Manager → Floor Supervisor → Security Operator.

A grant attaches to a node id and applies to its subtree — which `tenant_path` already answers in one
query. **No authorization concept exists in the hierarchy today**, deliberately: the ownership points
are exposed, the policy is not invented ahead of the milestone that needs it.

## Location templates

Retail Store · Warehouse · Office · Hospital · Factory · Parking · School.

A template is a list of `(type, name, parent)` triples run through the same create path. Nothing in
the model changes. The industry name lives in the template's **data**, never in a type
([CONSTRAINTS §36](../project/CONSTRAINTS.md)).

## Audit trail

`org.node.created` · `renamed` · `moved` · `archived` · `restored` already publish on the event
backbone. Audit is an **evidence family** inheriting the universal envelope
([CAMERA_FOUNDATION_V1](CAMERA_FOUNDATION_V1.md)), not a second log.

## Non-camera assets

```
Zone ├── Camera (built) ├── NVR ├── DVR ├── Door controller
     ├── Alarm panel   ├── Fire panel ├── IoT sensor ├── Parking barrier
```

Verified above: the hierarchy needs no change to accept any of them.

---

# Out of scope

RBAC · bulk import · templates · geospatial queries · floor plans · capacity and occupancy modelling ·
cross-tenant federation · bulk camera reassignment · a `DELETE` on a location, permanently.

---

## Frozen platform areas (2026-08-02)

| Foundation             | Version | Status     | Authority                                       |
| ---------------------- | ------- | ---------- | ----------------------------------------------- |
| Platform Core          | 1.0     | Frozen     | Phase 1 exit review                             |
| AI Runtime             | 1.0     | Frozen     | AI-5e closure (ED-0045) · CONSTRAINTS §18–24    |
| Operational Runtime    | 1.0     | Frozen     | AI-5 · AI-5a baseline                           |
| Camera Foundation      | 1.0     | Frozen     | [CAMERA_FOUNDATION_V1](CAMERA_FOUNDATION_V1.md) |
| Evidence Foundation    | 1.0     | Frozen     | P-2.2 / P-2.3 · CONSTRAINTS §27–32              |
| **Location Hierarchy** | **1.0** | **Frozen** | **This record · ADR-0025 · CONSTRAINTS §35–39** |

The Location Hierarchy is the **first product-layer subsystem to be frozen**, and it is frozen for
the same reason the foundations were: everything else attaches to it. Rules, incidents, permissions,
analytics, notifications and reports all reference a location, and a subsystem that keeps moving is
one nobody can build on.

## Related

- [ADR-0025](../adr/ADR-0025-organization-hierarchy.md) — the decisions and their alternatives.
- [FOUNDATION_PRINCIPLES](../project/FOUNDATION_PRINCIPLES.md) — mandatory reading before changing a foundation.
- [PRODUCT_PRINCIPLES](../project/PRODUCT_PRINCIPLES.md) — how product decisions are made.
- [PLATFORM_BOUNDARIES](PLATFORM_BOUNDARIES.md) — who owns what, permanently.
- [P-3 tracker](../tracker/P-3-ORGANIZATION-HIERARCHY.md) — how it was built.
