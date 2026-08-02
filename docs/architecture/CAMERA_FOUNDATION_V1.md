# Camera Foundation v1.0 — Freeze Record

```
Foundation:  Camera Foundation
Version:     1.0
Status:      FROZEN
Evolution:   Additive only
Frozen:      2026-08-02 (Principal Architect, P-2.3 acceptance)
Authority:   ADR-0024 + amendments · CONSTRAINTS §25–34
```

> This version is **governance metadata**. Nothing in the platform branches on it, and nothing ever
> may. It exists so that a conversation about compatibility has a noun in it.

---

## What is frozen

| Subsystem              | Where it lives                                                                    |
| ---------------------- | --------------------------------------------------------------------------------- |
| Camera discovery       | `ai/inference/onvif.py` · `services/camera` `application/discovery.ts`            |
| Camera identity        | `services/camera/src/domain/identity.ts`                                          |
| Camera lifecycle       | `services/camera/src/domain/lifecycle.ts`                                         |
| Capability cache       | `services/camera/src/domain/capability-cache.ts` · `capability-diff.ts`           |
| Probe pipeline         | `ai/inference/stream_probe.py` (validation provider registry)                     |
| Operational health     | `services/camera/src/domain/health-history.ts` · `confidence.ts`                  |
| Evidence archive       | `services/camera/src/domain/probe-archive.ts` · the `camera_probes` store         |
| Operational timeline   | `services/camera/src/domain/evidence-timeline.ts`                                 |
| Compatibility tracking | `services/camera/src/domain/compatibility.ts` · `ai/inference/camera_registry.py` |
| Explainability         | `services/camera/src/domain/decisions.ts`                                         |

## What "frozen" means

**Allowed, without ceremony:**

- a new optional field on an existing contract
- a new enum member — but see the caveat below
- a new validation provider (`register_provider(...)`)
- a new evidence type or evidence source
- a new derived read (a metric, a projection, an explanation)
- a bug fix that makes the code match the documented behaviour

**Requires an ADR:**

- changing what an existing field means
- removing or renaming anything published
- a new persisted store, or a new write path into a frozen one
- anything that would let a claim be made without the evidence class to support it
- any change to the four boundary rules in [PLATFORM_BOUNDARIES](PLATFORM_BOUNDARIES.md)

> **The enum caveat.** Adding a value to a published enum is _not_ purely additive for a strict
> parser — an older consumer rejects the payload. This is why `diagnostics`, `recovery`,
> `certification` and `session` were declared as evidence sources **before** anything emitted them.
> Prefer declaring the value early over adding it later.

## The rule that protects this from P-3

**P-3 consumes the Camera Foundation. P-3 does not redesign it.**

The organisation hierarchy depends on the Camera Foundation exactly as Rules, Evidence and the
Runtime already do — through its contracts, as a **stable platform dependency**. A camera does not
learn about sites; a site references cameras.

If P-3 finds something it genuinely cannot express, the answer is an additive contract with an ADR —
never a change to a frozen subsystem to make the new thing more convenient. The first exception
granted is the one that ends the freeze.

## Known carried-forward item

`Camera.health` is a **stored summary**, which [Foundation Principle 2](../project/FOUNDATION_PRINCIPLES.md)
forbids. It predates the rule (P1-4), is recomputed from the latest measurement on every write and is
never independently settable — but it is stored. Deriving it touches a read path shared with other
services and is a P-3 change. Recorded here rather than left for someone to discover.

---

# Intended platform direction

Everything below is **documentation of intent**. None of it is implemented, and none of it should be
implemented ahead of a milestone that needs it. It is recorded so that when those milestones arrive,
they extend a known shape instead of inventing a parallel one.

## The universal evidence envelope

The provenance model built for camera evidence is intended to become the platform-wide standard:

```
evidenceId · evidenceType · evidenceClass · source · tenantId · sessionId
producer · producerVersion · runtimeVersion · at · correlationId · links
```

Future evidence families inherit it unchanged — **Camera** (built) · Behavior · Recovery ·
Certification · Rule · Incident · Audit.

The property worth preserving is not the field list; it is that **a consumer reads the envelope
rather than switching on the producer**. That is what lets a new evidence family appear in an existing
investigation surface without a consumer release, and it only holds if every family adopts the same
envelope rather than a similar one.

## From a camera timeline to a platform timeline

Today the unified timeline merges four camera-owned records. The intended evolution is one
investigation surface across the platform:

```
Platform Timeline
 ├── Camera        (built)
 ├── Runtime
 ├── Scheduler
 ├── Recovery
 ├── Evidence
 ├── Incidents
 ├── Rules
 └── Audit
```

The architectural decision that makes this possible is already taken and already proven:
**separate on write, unified on read.** Each producer keeps its own store, its own bounds and its own
retention rules; the timeline merges them at read time. A single physical log would force one
retention policy onto all of them, and the platform would start discarding evidence to keep a UI fast.

## From camera to asset

`Camera` is the first managed asset, not the only one an estate contains. The intended evolution:

```
Asset
 ├── Camera          (built)
 ├── NVR
 ├── DVR
 ├── Door controller
 ├── Alarm
 ├── Access reader
 ├── Barrier
 ├── Sensor
 ├── Speaker
 └── IoT device
```

Most of the Camera Foundation is already asset-shaped rather than camera-shaped: stable device
identity separated from network identity, a lifecycle gated on measured evidence, a capability cache
with provenance, an immutable evidence archive, a compatibility register keyed by (dimension, value).
A door controller needs every one of those and none of them mention video.

The parts that are genuinely camera-specific are the probe pipeline's stages and the stream profile
model — and the pipeline is **already provider-based**, so a door controller becomes a validation
provider declaring which stages it has rather than a second validation path.

**This is direction, not a plan.** Generalising `Camera` into `Asset` before a second asset type
exists would be abstraction bought on speculation, and the shape of the second type is exactly what
would prove the abstraction wrong.

---

## Frozen platform areas (2026-08-02)

| Foundation          | Version | Status | Authority                                    |
| ------------------- | ------- | ------ | -------------------------------------------- |
| Platform Core       | 1.0     | Frozen | Phase 1 exit review                          |
| AI Runtime          | 1.0     | Frozen | AI-5e closure (ED-0045) · CONSTRAINTS §18–24 |
| Operational Runtime | 1.0     | Frozen | AI-5 · AI-5a baseline                        |
| Camera Foundation   | 1.0     | Frozen | This record · ADR-0024 · CONSTRAINTS §25–34  |
| Evidence Foundation | 1.0     | Frozen | P-2.2 / P-2.3 · CONSTRAINTS §27–32           |

Infrastructure is complete. From P-3 the work is customer-facing product built **on** these
foundations.

## Related

- [FOUNDATION_PRINCIPLES](../project/FOUNDATION_PRINCIPLES.md) — mandatory reading before changing a foundation.
- [PLATFORM_BOUNDARIES](PLATFORM_BOUNDARIES.md) — who owns what, permanently.
- [ADR-0024](../adr/ADR-0024-camera-lifecycle-evidence-gate.md) — the lifecycle evidence gate and its P-2.1/2.2/2.3 amendments.
- [CONSTRAINTS §25–32](../project/CONSTRAINTS.md) — the enforceable rules.
- [P-2 tracker](../tracker/P-2-CAMERA-LIFECYCLE.md) — how the foundation was built, slice by slice.
