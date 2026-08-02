# Foundation Completion Matrix

**The canonical engineering reference for what is frozen.** Start here when you need to know whether
you may change something.

Status: living register · Last revised 2026-08-02.

---

## The matrix

| Foundation              | Version | Status    | Frozen     | Evolution     | Breaking change | Record                                                                               |
| ----------------------- | ------- | --------- | ---------- | ------------- | --------------- | ------------------------------------------------------------------------------------ |
| **Platform Core**       | 1.0     | 🔒 Frozen | 2026-07-01 | Additive only | ADR required    | [PHASE1_EXIT_REVIEW](PHASE1_EXIT_REVIEW.md)                                          |
| **AI Runtime**          | 1.0     | 🔒 Frozen | 2026-08-01 | Additive only | ADR required    | [CONSTRAINTS §18–24](CONSTRAINTS.md)                                                 |
| **Operational Runtime** | 1.0     | 🔒 Frozen | 2026-08-01 | Additive only | ADR required    | [CONSTRAINTS §18–24](CONSTRAINTS.md) · AI-5a baseline                                |
| **Camera Foundation**   | 1.0     | 🔒 Frozen | 2026-08-02 | Additive only | ADR required    | [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md)                      |
| **Evidence Foundation** | 1.0     | 🔒 Frozen | 2026-08-02 | Additive only | ADR required    | [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md) · CONSTRAINTS §27–32 |
| **Location Hierarchy**  | 1.0     | 🔒 Frozen | 2026-08-02 | Additive only | ADR required    | [HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md)                |

Also declared in code as governance metadata: `FOUNDATIONS` in `@vip/contracts`. **Nothing branches on
it and nothing may** — a test asserts no entry carries a field that could be branched on, because the
first `if (foundation.supportsX)` is the end of "governance metadata only".

**The infrastructure layer is complete.** From P-3 onward the work is customer-facing product built
**on** these, not into them.

---

## What each foundation owns

| Foundation              | Owns                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Platform Core**       | Tenancy + the scope guard · contracts + codegen · config · crypto · auth/permissions · messaging · storage |
| **AI Runtime**          | The decode path · detection · tracking · behaviour · composite behaviours · profiles · certification       |
| **Operational Runtime** | Live ingestion · scheduling · health + recovery · benchmarking · the performance baseline                  |
| **Camera Foundation**   | Discovery · device identity · lifecycle · capability cache · the staged probe pipeline · compatibility     |
| **Evidence Foundation** | Immutable records · provenance · retention · the unified investigation timeline · explainability           |
| **Location Hierarchy**  | Containment · traversal · the resolved read models · archival · the estate presentation                    |

## What "frozen" means, uniformly

**Allowed without ceremony:** a new optional field · a new derived read · a new registration into an
existing registry · a new evidence type or source · a bug fix that makes the code match documented
behaviour.

**Requires an ADR:** changing what an existing field means · removing or renaming anything published ·
making an optional field required · a new persisted store or write path into a frozen one · storing
anything currently derived · anything that lets a claim be made without the evidence class to support
it.

> **The enum caveat.** Adding a value to a published enum is _not_ purely additive for a strict
> parser — an older consumer rejects the payload. Declare values ahead of their producers, as
> `diagnostics`/`recovery`/`certification`/`session` were.

## Public contracts are frozen; terminology is not

Documentation vocabulary may improve independently of published names. The subsystem frozen as
`OrgNode` / `/org-nodes` is _called_ the **Location Hierarchy**, because it models the physical world
rather than organizational ownership — and the code keeps its names.

**Cosmetic API renames are forbidden.** A rename is a breaking change for every consumer, every stored
document and every integration, bought in exchange for a clearer word. If a name is actively
misleading, that is an ADR with a migration path — not a find-and-replace. (CONSTRAINTS §41.)

## Data migration: the three questions

Every future evolution of a frozen foundation must answer them before it is written
([Foundation Principle 11](FOUNDATION_PRINCIPLES.md)):

1. **Can existing data still be read?** A field added must be optional or defaulted. A reader must
   never require what an older writer could not have written.
2. **Can an existing deployment upgrade without rebuilding?** No collection rewrite, no re-index of a
   billion documents on boot, no offline step.
3. **Is the migration additive?** If it is not, it is an ADR — and the ADR must carry the migration
   path, not merely note that one is needed.

## Cross-cutting governance

| Document                                                      | Governs                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [FOUNDATION_PRINCIPLES](FOUNDATION_PRINCIPLES.md)             | How the platform is built. **Mandatory reading before changing a foundation.** |
| [PRODUCT_PRINCIPLES](PRODUCT_PRINCIPLES.md)                   | How product decisions are made.                                                |
| [PLATFORM_BOUNDARIES](../architecture/PLATFORM_BOUNDARIES.md) | Who owns what, permanently.                                                    |
| [INDEX_POLICY](INDEX_POLICY.md)                               | When an index exists, and when it must not.                                    |
| [CONSTRAINTS](CONSTRAINTS.md)                                 | The enforceable rules, with enforcement points.                                |
| [PLATFORM_ROADMAP](PLATFORM_ROADMAP.md)                       | The four layers and their order.                                               |

## Known limitations carried across foundations

Recorded here so they are found, not discovered.

| ID                                                  | Foundation | Limitation                                                                                                    |
| --------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| [E-1](../tracker/E-1-EVIDENCE-LOCATION-SNAPSHOT.md) | Evidence   | Evidence resolves a location's ancestry as it is **now**, not as it was. Tracked, owned, not started.         |
| ED-0050 / ED-0051                                   | Camera     | `Camera.health` is a stored summary that Foundation Principle 2 forbids. Predates the rule.                   |
| —                                                   | Location   | Unanchored substring search is not index-served. Bounded, but a scan at extreme scale.                        |
| [TD-3](../../tracking/TECH-DEBT.md)                 | Camera     | A camera's `zoneId` is not confirmed to reference an existing node (cross-context, deferred to the backbone). |

## Before you change a foundation

1. Is this genuinely additive? If not → ADR.
2. Does it persist a conclusion? (Foundation Principle 2 — derive it instead.)
3. Does it let something be claimed without the evidence class to support it? (Principle 3.)
4. Does it answer the three migration questions above? (Principle 11.)
5. Does it rename anything published? (§41 — almost certainly no.)
6. **Could the need be met by consuming the foundation rather than changing it?** Usually yes — and
   "usually yes" is why the freeze holds.
