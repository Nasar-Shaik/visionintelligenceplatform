# AI Capability Maturity — the readiness register for every perception capability

_Status: Documentation + metadata only · Author: Claude · Date: 2026-07-31 · **AI Runtime Architecture v1.0**_

> Commissioned at **AI-4 acceptance** (Architect closing recommendation). This is a **documentation and
> metadata** register — **no runtime behavior depends on it**. It records how production-ready each
> perception capability is, so customers, deployment tooling, and model management can reason about a
> capability's readiness **independently** of the platform architecture (which is now frozen at v1.0 —
> see [ED-0039](../../project/ENGINEERING_DECISION_LOG.md) and [AI_EXECUTION_ARCHITECTURE](AI_EXECUTION_ARCHITECTURE.md)).
> It is designed to integrate naturally with `BehaviorProfile`s and deployment tooling later, additively.

---

## 1. Maturity ladder

```
Experimental  →  Beta  →  Production  →  Deprecated
```

| Level            | Meaning                                                                                           | Deployment guidance                                         |
| ---------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Experimental** | Contract + deterministic path exist; not validated on real footage/scale; behaviour may change.   | Engineering / playground only. Not for customer pilots.     |
| **Beta**         | Validated on limited real footage; API stable (additive-only); accuracy/perf still being tuned.   | Opt-in pilots with monitoring; flag results as provisional. |
| **Production**   | Validated end-to-end; stable contract; meets accuracy/latency targets on reference hardware.      | Default for customer deployments.                           |
| **Deprecated**   | Superseded; retained for compatibility; scheduled for removal via additive successor + migration. | Do not adopt; migrate to the named successor.               |

**Rules.** Maturity is **per capability**, independent of the platform contracts (which are frozen v1.0,
additive-only). Maturity is metadata: promoting/demoting a capability changes **no** runtime behavior and
requires **no** contract change. A capability advances only with evidence (real-footage validation +
benchmarks). This register is the single source of truth; keep it in sync as capabilities mature.

## 2. Capability register (2026-07-31)

Levels reflect what the deterministic-by-default runtime has **demonstrated to date** (stub-adapter,
synthetic/limited footage). Most capabilities are **Experimental** until AI-5 validates them against
**real camera streams** — which is precisely the production-readiness focus the Architect set for AI-5.

### Perception — detection (AI-1)

| Capability                 | Event type                       | Maturity         | Notes                                                               |
| -------------------------- | -------------------------------- | ---------------- | ------------------------------------------------------------------- |
| Person Detection           | `perception.person.detected`     | **Beta**         | Full pipeline validated deterministically; real-model/RTSP = AI-5.  |
| Object Detection           | `perception.object.detected`     | **Experimental** | Generic fallback; label-map gap (TD-13).                            |
| Vehicle Detection          | `perception.vehicle.detected`    | **Experimental** | Contract + mapping ready; not validated on footage.                 |
| Fire / Smoke               | `perception.fire/smoke.detected` | **Experimental** | Detector-independent behavior path exists; needs a real fire model. |
| Face / Pose / Weapon / PPE | `perception.*`                   | **Experimental** | Catalog + adapters reserved; not yet exercised.                     |

### Tracking (AI-2)

| Capability                       | Contract                              | Maturity | Notes                                                                                                        |
| -------------------------------- | ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| Object Tracking (IoU associator) | `Track`                               | **Beta** | Lifecycle/id-policy/bounded-history validated; alt trackers (ByteTrack/…) Experimental behind the same seam. |
| Zones + Counting                 | `ZoneTransition` / `CountingSnapshot` | **Beta** | Geometry + confirmed-only counting validated deterministically.                                              |

### Behavior — primitives (AI-3/AI-4)

| Capability      | Event type                    | Maturity         | Notes                                               |
| --------------- | ----------------------------- | ---------------- | --------------------------------------------------- |
| Queue Detection | `analytics.queue.length`      | **Beta**         | Config-driven; validated on synthetic flow.         |
| Loitering       | `behavior.loitering.detected` | **Beta**         | Temporal-window dwell; validated deterministically. |
| Intrusion       | `security.intrusion.detected` | **Beta**         | Perception primitive; rules own after-hours.        |
| Crowd Density   | `analytics.crowd.density`     | **Experimental** | New generic primitive; needs real-footage tuning.   |
| Occupancy       | `analytics.occupancy.changed` | **Experimental** | New generic primitive; threshold tuning pending.    |

### Behavior — composites (AI-4)

| Capability                    | Output                     | Maturity         | Notes                                                               |
| ----------------------------- | -------------------------- | ---------------- | ------------------------------------------------------------------- |
| Composite engine              | `CompositeBehavior`        | **Beta**         | Generic, config-driven, cycle-safe; validated on the retail pilot.  |
| Cash-Counter Anomaly (retail) | `behavior.theft.suspected` | **Experimental** | A composition (config), not a class; pilot-validated synthetically. |
| Custom customer behaviors     | `CompositeBehavior`        | **Experimental** | Author via `BehaviorProfile` config; no new code.                   |

## 3. Integration seam (future, additive)

When deployment tooling needs it, this register can surface as **optional metadata** on the existing
G-3 `ModelCapabilityProfile` / a future `BehaviorProfile` field (e.g. `maturity: experimental|beta|
production|deprecated`) — **additively, backward-compatible**, honouring the v1.0 freeze. Until then it
lives here as documentation. No runtime reads it today.

## 4. Promotion criteria (what AI-5 will supply)

A capability moves **Experimental → Beta → Production** as AI-5 (production readiness) delivers the
evidence: real RTSP/live validation, accuracy on representative footage, and **benchmarks** (FPS,
latency p50/p95, throughput) on reference hardware — reported through the existing additive
`RuntimeMetrics`. This register is updated as that evidence lands; it never requires a contract change.
