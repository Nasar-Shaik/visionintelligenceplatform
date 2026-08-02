# Platform Roadmap

**Governance only.** This document records the shape of the work and the order of the layers. It is
not a schedule, not a commitment, and nothing in it authorises a milestone. Authorisation happens at
architectural review, one slice at a time.

Status: living · Established P-3 · Last revised 2026-08-02.

---

## The four layers

Each layer is built on the one above it and never reaches past it. A layer is entered only once the
layer above is complete.

```
┌─ Foundation Layer ─────────────────────── COMPLETE · SIX FROZEN ─────┐
│  ✓ Platform Core   ✓ AI Runtime        ✓ Operational Runtime         │
│  ✓ Camera          ✓ Evidence          ✓ Location Hierarchy          │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─ Product Layer ────────────────────────────────────── STARTED ───────┐
│  ✓ Location Management (P-3, frozen)   ✓ Rule Designer (P-4)         │
│    Incidents · Evidence Player · Dashboards · Administration          │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─ Business Layer ───────────────────────────────────────── PLANNED ───┐
│  Licensing · Subscription · Audit                                    │
│  Notification Policies · Reports                                     │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─ Solution Layer ───────────────────────────────────────── PLANNED ───┐
│  Retail · Manufacturing · Warehouse · Hospital · School · Smart City │
└──────────────────────────────────────────────────────────────────────┘
```

---

> **Where the project stands.** The infrastructure layer is complete and six foundations are frozen.
> The first product slice — Location Management — is delivered and itself frozen. **Next: P-4, product
> features.** From here, development is customer-facing capability rather than architectural work.
>
> Canonical register: [FOUNDATIONS](FOUNDATIONS.md).

## Foundation Layer — complete, frozen

| Foundation              | Version | Frozen     | Record                                                                |
| ----------------------- | ------- | ---------- | --------------------------------------------------------------------- |
| **Platform Core**       | 1.0     | 2026-07-01 | [PHASE1_EXIT_REVIEW](PHASE1_EXIT_REVIEW.md)                           |
| **AI Runtime**          | 1.0     | 2026-08-01 | [CONSTRAINTS §18–24](CONSTRAINTS.md)                                  |
| **Operational Runtime** | 1.0     | 2026-08-01 | [CONSTRAINTS §18–24](CONSTRAINTS.md) · AI-5a baseline                 |
| **Camera Foundation**   | 1.0     | 2026-08-02 | [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md)       |
| **Evidence Foundation** | 1.0     | 2026-08-02 | [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md)       |
| **Location Hierarchy**  | 1.0     | 2026-08-02 | [HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md) |

Also declared in code as governance metadata: `FOUNDATIONS` in `@vip/contracts`. Nothing branches on
it, and a test enforces that nothing can.

**These evolve by addition only.** A breaking change requires an ADR. See
[FOUNDATION_PRINCIPLES](FOUNDATION_PRINCIPLES.md).

---

## Product Layer — in progress

The layer where a customer sees value. Every item consumes the foundations; none of them redesigns
one.

| Slice   | Feature                | Status    | Delivers                                                       |
| ------- | ---------------------- | --------- | -------------------------------------------------------------- |
| **P-3** | **Location Hierarchy** | ✅ frozen | The customer's physical world: where every camera actually is. |
| P-4     | Rules                  | planned   | Rule designer over the frozen behavior contracts.              |
| P-5     | Incidents              | planned   | Workflow, assignment, resolution, escalation.                  |
| P-6     | Evidence Player        | planned   | Investigation: play the evidence, not just read about it.      |
| P-7     | Dashboards             | planned   | Operational and estate-level views, analytics.                 |
| P-8     | Administration         | planned   | Users, roles, permissions, tenant settings, onboarding.        |

### What the platform can now support

With the Location Hierarchy frozen, the platform supports — verified, not asserted:

| Capability                        | Where it is proven                                                                |
| --------------------------------- | --------------------------------------------------------------------------------- |
| **Enterprise organizations**      | Eight levels, skippable; 101,001 nodes in one tenant built in one pass            |
| **Multi-site deployments**        | `under()` at any level, one indexed lookup                                        |
| **Multi-building deployments**    | Full `org → … → zone` depth, with breadth at every level                          |
| **Large camera estates**          | Cursor-paged, index-covered reads; 1,000,000-camera target reviewed               |
| **Historical evidence**           | Ids survive rename, move, archive and restore; archived nodes resolve             |
| **Operational monitoring**        | Location-scoped camera queries, without either context learning the other's model |
| **Future non-camera assets**      | The hierarchy stores no occupancy and names no device type                        |
| **Future enterprise integration** | Additive metadata and external references verified additive                       |
| **Future product capabilities**   | P-4 rule scoping verified against the frozen contracts                            |

One requirement from the P-3 review is **not** met and is carried forward:
evidence resolves a location's ancestry as it is _now_, not as it was when the event occurred. The
fix belongs in the Evidence context and needs no hierarchy change —
[HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md).

### Why the hierarchy comes first

Every later module attaches to it:

```
                 Organization Hierarchy
                          │
   ┌────────┬────────┬────┴────┬─────────┬──────────┬─────────┐
 Rules  Evidence  Incidents  Permissions  Analytics  Reports  Notifications
```

A rule is scoped to a site. An incident happened somewhere. A permission grants access to a branch. A
report covers a region. Every one of those sentences needs the hierarchy to exist first — which is
why building it second would mean retrofitting it into five features instead of consuming it from
one.

---

## Business Layer — planned

Commercial and operational concerns that sit above the product and below the customer's own
processes.

| Feature                   | Delivers                                                      |
| ------------------------- | ------------------------------------------------------------- |
| **Licensing**             | Entitlements, camera counts, feature gating per tenant.       |
| **Subscription**          | Plans, billing periods, usage.                                |
| **Audit**                 | Who did what, when, from where — across every product action. |
| **Notification Policies** | Who is told what, through which channel, under what rules.    |
| **Reports**               | Scheduled and ad-hoc, scoped to any node in the hierarchy.    |

Audit is the one with a foundation dependency worth naming early: it is an **evidence family**, and it
inherits the universal evidence envelope rather than inventing a parallel log
([CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md)).

---

## Solution Layer — planned

Industry solutions are **configuration, profiles and templates** over the identical generic platform.
Retail and Hospital deployments run the same code.

| Solution      | Expressed as                                                           |
| ------------- | ---------------------------------------------------------------------- |
| Retail        | Behavior profiles · rule templates · dashboard layouts · report packs. |
| Manufacturing | Behavior profiles · zone templates · escalation policies.              |
| Warehouse     | Behavior profiles · rule templates.                                    |
| Hospital      | Behavior profiles · access policies · retention profiles.              |
| School        | Behavior profiles · schedule profiles.                                 |
| Smart City    | Behavior profiles · multi-tenant federation · reporting.               |

No industry noun ever enters a type name ([Product Principle 3](PRODUCT_PRINCIPLES.md)). If a
solution cannot be expressed as configuration, the generic model is missing a knob — and adding the
knob is the work, not adding the solution.

---

## The P-4 guardrail

**P-4 consumes the Location Hierarchy exactly as it exists today.**

A rule scopes to a **node id** and resolves the zones beneath it with one indexed predicate. That is
verified — `hierarchy-invariants.test.ts › "P-4 readiness"` asserts a rule needs no hierarchy field,
contract or route that does not already exist.

Any modification to a hierarchy contract requires, in order: **an ADR · architectural review ·
approval**. Not one of the three is optional, and "P-4 would be easier if" is not a reason — the first
exception granted is the one that ends the freeze ([CONSTRAINTS §33](CONSTRAINTS.md)).

The same guardrail applies to every other frozen foundation P-4 touches: the behaviour contracts, the
evidence envelope and the camera model are all consumed, never reshaped.

## What this roadmap does not do

- It does not authorise anything. Each slice is authorised at review, on its merits, in sequence.
- It does not estimate. No dates, no sizes.
- It does not lock ordering within a layer. P-4 through P-8 may be re-ordered by customer need; the
  **layers** may not.
- It does not reopen the Foundation Layer. Work that appears to need a foundation change is an
  additive contract with an ADR, or it is a design that has not finished yet.

## Related

- [PRODUCT_PRINCIPLES](PRODUCT_PRINCIPLES.md) — how product decisions are made.
- [FOUNDATION_PRINCIPLES](FOUNDATION_PRINCIPLES.md) — how the platform is built. Frozen.
- [PROJECT_ROADMAP](PROJECT_ROADMAP.md) — the delivery history, phase by phase.
- [MASTER_PROGRESS](../tracker/MASTER_PROGRESS.md) — where every milestone actually stands.
