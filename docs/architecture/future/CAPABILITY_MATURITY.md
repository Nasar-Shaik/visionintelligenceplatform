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
latency p50/p95, throughput) on reference hardware — measured by the AI-5a harness against the documented
budgets in [PRODUCTION_KPIS](PRODUCTION_KPIS.md) and reported through the additive `RuntimeMetrics`. This
register is updated as that evidence lands; it never requires a contract change.

### Evidence delivered by AI-5b (live ingestion)

AI-5b supplies the **ingestion half** of that evidence and nothing more — an important distinction when
reading this register:

- **Delivered:** the runtime can consume a **live, unbounded, disconnect-prone source** across
  reconnects, run **N cameras concurrently** under a capacity limit, and report ingestion health
  (availability · recovery · reconnects) and backpressure (queue depth/high-watermark/utilization/
  processing delay) per session. Live benchmark workloads (`--live`) measure this against the AI-5a
  baseline.
- **NOT delivered, so no capability is promoted on AI-5b alone:** validation against a **real camera**
  and a **real model**. Every AI-5b run is deterministic (simulated sources, stub adapter), which proves
  the _plumbing_ — not detection accuracy. Real-camera/GPU validation is **AI-5e**, and that is what
  moves a perception capability from Beta to Production.

In short: AI-5b makes capabilities _runnable in production shape_; it does not make them _proven in
production_.

### Evidence delivered by AI-5c (scheduling + resource management)

- **Delivered:** the runtime can run **many cameras on one box predictably** — fair scheduling with no
  starvation, admission control that refuses work it cannot serve, ordered graceful degradation instead
  of failure, and per-session cost/SLA accounting. Validated by 4/8/16/32-camera simulation against the
  real scheduler.
- **NOT delivered:** still no real camera and no real model. AI-5c raises confidence that a capability
  will _keep running_ under load; it says nothing about whether it _detects correctly_. Promotion to
  `Production` continues to require the AI-5e certification matrix in
  [PRODUCTION_COMPATIBILITY §3](PRODUCTION_COMPATIBILITY.md).

### Evidence delivered by AI-5d (health, auto-recovery, model lifecycle)

- **Delivered:** the runtime can now report **why** a capability is unwell (a 0–100 score decomposed
  across connection · inference · scheduler · resources · recovery, with a projection), **recover from
  failure within a configured budget** rather than staying down until an operator notices, and **change
  model versions without interrupting a running session**. Ten production-condition simulations
  (prolonged operation, burst reconnects, repeated model failures, simultaneous recoveries, degraded
  hardware, recovery storms, …) assert the operational logic holds under conditions a benchmark never
  creates.
- **NOT delivered, and important for this register:** model validation is **operational, not
  accuracy**. `ModelValidation` proves an artifact loads, infers, returns well-formed output, meets a
  latency budget, and detects a comparable _volume_ to the incumbent. It cannot certify recall without
  labelled footage. **No capability may be promoted to `Production` on an AI-5d validation pass** —
  a green model transition means the model _runs_, not that it _sees correctly_.

In short: AI-5b made capabilities runnable in production shape, AI-5c made them survive a loaded box,
AI-5d made them survive a bad night. Only AI-5e can make them _proven_.
