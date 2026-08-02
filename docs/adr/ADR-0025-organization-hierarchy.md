# ADR-0025 — The organization hierarchy: containment, movement, archival and backend-owned traversal

- **Status:** Accepted
- **Date:** 2026-08-02 · **Accepted:** 2026-08-02 (Architect decision, P-3 approval)
- **Deciders:** Principal Architect + development
- **Touches:** `@vip/contracts` (`OrgNodeStatus`, `ORG_NODE_TYPES`, `canContain`, `allowedChildTypes`, `OrgCrumb`, `OrgLocation`, `OrgTreeNode`, `OrgTree`, `OrgNodeQuery`, `OrgLocationPage`, `UpdateOrgNodeInput`, `CameraQuery`, `CameraPage`); `services/tenant` (`domain/hierarchy.ts`, org routes); `services/camera` (`query`); `apps/console` (`features/organization`). Relates to [ADR-0024], [CONSTRAINTS §33, §35–38], [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md).

## Context

P1-1 created `OrgNode` — a tenant-scoped tree of eight types with a materialized ancestry `path` —
and then nothing used it. Cameras carried a `zoneId` that the console hardcoded to the string
`on_default`, named in a comment as a placeholder so it would not become a silent assumption.

P-3 is the first product slice: the customer's physical world, and the thing every later module
attaches to. A rule is scoped to a site; an incident happened somewhere; a permission grants access
to a branch; a report covers a region. All four sentences need this to exist first.

Four questions had to be settled before any of that could be built on it.

## Decision

### 1. Containment is enforced, and levels may be skipped but never inverted

A node may sit under any node of a **strictly outer** type. `org → site → zone` is a valid
three-level estate for a customer with one building; `floor → region` is not a hierarchy at all.

P1-1 validated only that an `org` had no parent and a non-`org` had one — a zone could contain a
region. The documented order existed; nothing enforced it. This is recorded as a **bug fix that makes
the code match the documented behaviour**, which the Camera Foundation freeze permits without
ceremony, and is noted here because it does narrow what an existing endpoint accepts.

Requiring all eight levels was rejected: it makes the model unusable for the small customer
([PRODUCT_PRINCIPLES §7](../project/PRODUCT_PRINCIPLES.md)). Allowing inversion was rejected because
it makes "everything under this site" an unanswerable question.

### 2. Traversal is owned by the backend and served resolved

`OrgLocation` carries `breadcrumb`, `depth`, `label`, `allowedChildTypes` and `hasChildren`, all
derived on read and none of them stored.

A console that walks `parentId` to build a breadcrumb has re-implemented containment in the
presentation tier, where it will disagree with the service the first time the rules change. P-2
already made this mistake once — the console derived a probe-failure headline by scanning for the
first failing check — and removing it was a deletion, not a feature
([PLATFORM_BOUNDARIES](../architecture/PLATFORM_BOUNDARIES.md) rule 3).

Serving `allowedChildTypes` is the same decision applied to writes: the "add a location" menu offers
what the server said is permitted, so the console contains no containment rule at all.

### 3. Locations are archived, never deleted

Evidence, incidents and audit records reference locations by id for as long as they are retained. A
delete turns a two-year-old investigation into a dangling id at the exact moment someone needs to read
it. Archiving cascades to the subtree, removes it from working views, and leaves every historical
reference resolving — breadcrumb included.

There is deliberately **no `DELETE` route** on the resource. Its absence is the guarantee; a route
that exists and is discouraged is a route that gets called.

### 4. The Camera Service filters by zone ids and never learns what a site is

"Every camera under this site" resolves the subtree in the **Tenant** context, where the tree lives,
and reaches the Camera Service as a **set of zone ids** — a filter, not a hierarchy.

A synchronous call from the camera context into the tenant context to resolve a subtree is how a
distributed monolith starts ([PLATFORM_BOUNDARIES](../architecture/PLATFORM_BOUNDARIES.md) rule 4).
Denormalising the ancestry onto each camera was also rejected: it is a second copy of another
context's fact, wrong from the instant a site is renamed or moved, and re-deriving it on every move
is a fan-out write across an inventory to serve a read that already had an answer.

## Consequences

- **Identity is stable and names are free.** `id` is the identity everywhere; `name` is a
  customer-editable label the system never reads. A rename touches one document and no reference —
  which is what makes renaming safe enough to expose as a one-click action.
- **`type` is immutable.** `UpdateOrgNodeInput` has no `type` field. A floor does not become a region
  because someone edited a form; that reinterprets every record that referenced it. Getting it wrong
  means creating the right node and moving the children — an operation whose cost is visible.
- **Movement is bulk and atomic-ish.** A move rewrites the node's ancestry and every descendant's in
  one `bulkWrite`. N awaited updates would be N round trips and N chances to be interrupted halfway,
  leaving the tree describing two shapes at once.
- **Nothing recursive touches the store.** Ancestry is materialized (`path`, multikey-indexed) and
  depth is indexed. A subtree is one lookup; a page of locations resolves in three queries regardless
  of estate size; the tree is a single pass. A 5,000-node estate is a test, not an aspiration.
- **The hierarchy holds no occupancy count.** It describes _places_. Cameras are the first thing an
  estate contains and will not be the last — NVRs, door controllers, readers, alarm panels, sensors
  and barriers all live somewhere. A `cameraCount` here would be both a second copy of another
  context's fact and a standing assumption that cameras are the only occupant.
- **Every page is bounded.** `OrgNodeQuery` and `CameraQuery` default and cap their limits and page by
  cursor rather than offset — an offset skips or repeats rows while an estate is being edited, which
  is exactly what a bulk import would be doing.

## Alternatives considered

- **A `path` of names rather than ids.** Human-readable and immediately wrong: every rename would
  rewrite the ancestry of the whole subtree, and two siblings could collide.
- **Adjacency only, with recursive traversal.** Simplest to write and O(depth) queries per node. The
  materialized path was already there from P1-1; discarding it to reintroduce a walk would have been
  a regression with no benefit.
- **`$graphLookup` for subtree reads.** Works, and is a scan the multikey index makes unnecessary.
- **A `displayName` field alongside `name`.** Requested as vocabulary in the P-3 review. Declined:
  `name` already _is_ the display label and is documented as such, and a second field meaning the same
  thing is precisely the "one shape in two places" that Foundation Principle 5 exists to prevent. The
  substance of the recommendation — immutable ids, editable labels, references by id only — is
  implemented and tested.

## Future extension points (documented, not implemented)

None of the following is built. They are recorded so the milestone that needs one extends a known
shape instead of inventing a parallel one.

- **Inherited permissions.** The hierarchy is the natural ownership surface — Organization Admin,
  Branch Admin, Building Manager, Floor Supervisor. A grant would attach to a node id and apply to its
  subtree, which the materialized path already answers in one query. No authorization concept exists
  in the hierarchy today, deliberately.
- **Bulk operations** (CSV/Excel import, bulk move, bulk assign, bulk archive). Every rule is a pure
  function of a candidate and its parent, so validating ten thousand rows is a loop over the same
  functions with no store round-trip. Tested as such.
- **Location templates** (Retail Store, Warehouse, Office, Hospital, Factory, Parking, School). A
  template is a shape to instantiate — a list of `(type, name, parent)` triples run through the same
  create path. Nothing in the model needs to change to support one; the industry name lives in the
  template's data, never in a type.
- **Audit trail.** `org.node.created/renamed/moved/archived/restored` are already published on the
  event backbone. Audit is an evidence family that inherits the universal envelope
  ([CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md)) rather than a second log.
- **Localisation.** `type` is the neutral stored identifier; `ORG_TYPE_LABELS` in the console is the
  only place it becomes a word a person reads.
- **Non-camera assets.** The hierarchy assumes nothing about what stands in a place. A door controller
  or an alarm panel references a node id exactly as a camera does.

## Addendum — P-3 acceptance hardening (2026-08-02)

Accepted at review with fifteen recommendations, folded in as **verification and governance**; no
runtime behaviour changed and no capability was added.

**Three index defects found by making coverage checkable.** Index specifications became data
(`adapters/indexes.ts`) and a test now asserts that every read the service issues has an index whose
prefix serves its equality keys and whose _next_ key serves its sort. That check found three reads
whose filter was indexed and whose sort was not — each a blocking in-memory sort, each invisible
against a test fixture: the camera location filter (`tenant_zone` lacked `_id`), the subtree tree read
(no index served `path` + `depth`), and the unfiltered paged camera listing (no index at all). Fixed
by `tenant_zone` gaining `_id`, a new `tenant_path_depth`, and a new `tenant_cursor`. Recorded as
[CONSTRAINTS §40](../project/CONSTRAINTS.md): _an index is not coverage until a query plan says so._

**Depth is bounded by containment, not by convention.** `canContain` requires strictly increasing
rank, so a root-to-leaf chain draws from eight values and cannot exceed eight nodes. That is what
makes the depth-recursive helpers safe at any estate size, and it is now asserted rather than assumed.

**Historical location resolution is a named gap, not a future nicety.** Evidence recorded in Zone A
resolves to Zone B after the camera moves. Every reference survives — no link dangles — but the answer
changes, which for an investigation is worse than an error. Neither half of the cause is in the
hierarchy: a camera's `zoneId` is mutable, and a location's ancestry is current. The fix is to freeze
`zoneId` and its `path` **on the evidence record at write time**, an additive Evidence-context change.
The test asserting today's behaviour is written so that fixing it breaks the test.

**Twelve invariants** now define the subsystem, each asserted by a test, and the **algorithmic
complexity** of every core operation is documented as an architectural expectation —
[HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md).

**The subsystem is named the Location Hierarchy** in documentation, because it models the physical
world rather than organizational ownership. The code keeps its `Org*` names: renaming published
contracts and routes is the one change the freeze forbids without an ADR, and clarity of prose does
not buy a breaking change.

**Frozen: Location Hierarchy v1.0**, additive-only, breaking changes by ADR — the same governance as
Platform Core, AI Runtime, Operational Runtime and the Camera Foundation, and the first product-layer
subsystem to receive it.

## Out of scope for P-3

RBAC · bulk import · templates · geospatial coordinates · floor plans · capacity or occupancy
modelling · cross-tenant federation · moving cameras between locations in bulk.
