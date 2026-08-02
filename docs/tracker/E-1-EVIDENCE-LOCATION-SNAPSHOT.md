# E-1 — Evidence Location Snapshot

**Status:** 📋 TRACKED · not started · **not authorized**
**Raised:** 2026-08-02 (P-3 Hardening review, Architect recommendation 1)
**Owner:** **Evidence context** — `services/camera` (probe archive, timeline) + `@vip/contracts` evidence schemas
**Not owned by:** the Location Hierarchy. No change to `services/tenant` or the `Org*` contracts is required or permitted by this item.
**Severity:** investigation correctness · **medium-high** — silent, not loud
**Debt register:** [TD-20](../../tracking/TECH-DEBT.md)

---

## The defect

> Evidence created while a camera belongs to **Zone A** resolves to **Zone B** after the camera moves.

Nothing errors. Nothing dangles. Every id still resolves — renames, moves, archives and restores
change no identity, which is exactly why the reference survives. **The answer changes**, and nothing
signals that it did.

For an investigation that is worse than an error. An operator reading a six-month-old incident is
told, with full confidence and a complete breadcrumb, that it happened somewhere it did not.

## Why it happens — two independent causes

**1. Evidence references the camera, not the place.**

```
evidence.cameraId → camera.zoneId → location
                    ^^^^^^^^^^^^^ mutable
```

`UpdateCameraInput` accepts `zoneId`. A camera legitimately moves — re-sited during a refit,
re-pointed at a different entrance, moved between floors. Resolving location _through_ the camera
therefore answers "where is this camera now", which is a different question from "where did this
happen".

**2. A location's ancestry is current, not historical.**

`OrgLocation.breadcrumb` is derived on read from the node's `path` **as it is today**. Evidence naming
a zone that has since moved between buildings resolves to the new building. This is correct behaviour
for the hierarchy — a derived value must reflect the data it derives from
([Foundation Principle 2](../project/FOUNDATION_PRINCIPLES.md)) — and wrong for a historical record.

## Why it is not fixed in the hierarchy

The hierarchy is doing its job correctly in both cases. A location that refused to report its current
ancestry would be a broken location.

The problem is that **a historical record is trusting a live derivation**. The fix is for the record
to stop trusting it — to capture the answer when the event happened, exactly as `CameraProbeRecord`
already captures `ProbeConfigurationSnapshot` rather than re-reading the camera's configuration at
render time. That pattern is already in the codebase and already reviewed; this applies it to
location.

**The hierarchy needs no change.** Verified by test: it already supplies everything a writer needs
(`zoneId`, `path`, `depth`) at the moment of writing.

---

## What implementation must do

### 1. Freeze the location on the evidence record at write time

An additive optional field on each evidence-producing record:

```ts
/** Where this happened, captured when it happened. Never re-derived. */
readonly location?: {
  readonly zoneId: string;
  /** The zone's ancestry at write time, root-first. */
  readonly path: readonly string[];
  /** Denormalized for display when an ancestor is later archived beyond reach. */
  readonly label?: string;
};
```

Applies to: `CameraProbeRecord` · `CameraTimelineEntry` · any future evidence family. It belongs in
the **universal evidence envelope**
([CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md)) so every family inherits it rather
than each inventing its own.

### 2. Resolve historical reads from the snapshot, never from today's hierarchy

```
if (evidence.location) → render evidence.location   // the answer at the time
else                   → resolve through the camera // pre-E-1 records, marked as such
```

The fallback must be **visibly labelled** in the console. A record with no snapshot cannot answer the
question, and saying "location not captured" is honest where showing today's location is not.

### 3. Consider, do not assume: a hierarchy version stamp

The review suggested optionally storing a hierarchy version. **Recommendation: do not.** A version
identifies a shape, not a state — it would not tell a reader what the ancestry _was_, which is the
whole question, and the `path` snapshot already answers it exactly. Revisit only if a concrete read
appears that the snapshot cannot serve.

### 4. Backfill: no

Records written before E-1 have no captured location and there is no correct value to invent —
back-filling from today's hierarchy would write the wrong answer permanently, converting a detectable
gap into an undetectable one. Old records stay honest by staying empty.

---

## Acceptance criteria

- [ ] Evidence written while a camera is in Zone A resolves to **Zone A** after the camera moves to Zone B.
- [ ] Evidence written while a zone sat under Building 1 resolves to **Building 1** after the zone moves.
- [ ] A record with no captured location renders as "location not captured", never as today's location.
- [ ] The snapshot is written once and never updated — the archive stays append-only
      ([CONSTRAINTS §27](../project/CONSTRAINTS.md)).
- [ ] No change to any `Org*` contract, route or index.
- [ ] The P-3 test `hierarchy-invariants.test.ts › "resolves through the camera to its CURRENT
location — the named limitation"` is **rewritten as the guarantee**. It is deliberately written
      to fail when this lands.

## Out of scope

Camera move history · location move history · a temporal query API over the hierarchy · re-deriving
past ancestry from an audit log. All are ways of reconstructing the answer; capturing it is cheaper
and exact.

## Sequencing

Independent of P-4. Best scheduled with the next Evidence-context slice, since it touches the
evidence envelope and every consumer of it. It is **additive** — an optional field on records that
already exist — so it does not require unfreezing anything.

## Related

- [HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md) — where the gap is recorded.
- [ADR-0025](../adr/ADR-0025-organization-hierarchy.md) — why it is not a hierarchy concern.
- [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md) — the universal evidence envelope.
- [ED-0053](../project/ENGINEERING_DECISION_LOG.md) — the review that found it.
- [P-3 tracker](P-3-ORGANIZATION-HIERARCHY.md) · [TD-20](../../tracking/TECH-DEBT.md).
