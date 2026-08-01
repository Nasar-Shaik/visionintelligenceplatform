# AI-5c — Inference Scheduling & Resource Management

> **Milestone:** Production Readiness **AI-5c** (third slice of AI-5) · **Status:** ✅ code + tests complete, ⏳ awaiting Architect review
> **Scope:** decide **whose frame runs next** across cameras, **refuse work that cannot be served**,
> and **degrade gracefully** instead of failing — plus per-session resource accounting and SLA tracking.
> **In `ai/inference`, no new service; the five frozen v1.0 contracts untouched.**
> **North star (Architect):** _Baseline → Optimization → Re-benchmark → Compare → Accept or reject._
> Reference: [AI_EXECUTION_ARCHITECTURE §2 stage 4](../architecture/future/AI_EXECUTION_ARCHITECTURE.md) · [ED-0042](../project/ENGINEERING_DECISION_LOG.md). **Author:** Claude · _2026-08-01_

---

## 1. The gap AI-5c closes

AI-5b gave each session its own bounded queue, which protects a session **from its own camera**. It
does not protect sessions **from each other**: eight cameras on one box still compete for one CPU, and
nothing decided who wins. Worse, nothing decided whether a ninth camera should be allowed to start —
so accepting it degraded all nine.

| Before AI-5c                                      | After AI-5c                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| Sessions compete; a busy camera can starve others | Weighted-fair rotation; **starvation is structurally impossible**    |
| Any session can start until a raw count is hit    | **Admission control** estimates cost and refuses with a reason       |
| Overload → dropped frames, then failure           | **Ordered degradation ladder**, reversible, never a hard failure     |
| "The box is at 90% CPU"                           | **Per-session accounting** — which camera, at what priority          |
| Guesswork about whether a camera is served        | **Per-session SLA**: target vs actual FPS/latency, `met` yes/no      |
| Reacting after the queue is full                  | **Predictive degradation** on a projected overload                   |
| Hardware-specific assumptions                     | **`ComputeResource`** — abstract units; CPU/CUDA/Metal/NPU identical |
| Env vars applied uniformly                        | **Deployment profiles** — 7 verticals as portable config             |

## 2. Ownership — stage 4, not a new layer

The reference architecture always specified an Inference Scheduler at stage 4, behind the unchanged
`/infer` + `ModelAdapter` seam. AI-5c implements it; it does not invent it.

```
StreamSource → StreamPipeline → [ InferenceScheduler ] → VideoAnalyzer → SessionRunner → SessionSupervisor
connection      queue/lifecycle   whose frame runs next    AI only         orchestration   capacity/fleet
                                  admission · fairness
                                  degradation ladder
```

Three cooperating pieces:

- **`AdmissionController`** — refuses work that cannot be served safely, with a typed reason.
- **`InferenceScheduler`** — weighted-fair rotation, priorities, optional batching, anti-starvation.
- **`ResourceGovernor`** — walks the degradation ladder up under pressure, back down on relief.

## 3. What AI-5c delivers

- **Hardware-independent compute** ([compute.py](../../ai/inference/compute.py)) — `ComputeResource`
  describes capacity in **abstract, dimensionless units**, never cores or VRAM, because the only thing
  every accelerator shares is "how much concurrent work fits". CPU/CUDA/TensorRT/OpenVINO/Metal/TPU/NPU
  are registry entries, not scheduler branches. Ids are **node-qualified** (`node-a/cuda:0`) so a future
  distributed scheduler adds remote resources rather than a redesign.
- **Capacity reservation** — a configurable share (default 10%) is held back from ordinary admission.
  A runtime at 100% committed **cannot recover from its own success**: nothing can restart, and no
  critical camera can start. The reserve is the headroom that makes recovery possible.
- **Admission control** ([scheduler.py](../../ai/inference/scheduler.py)) — estimates a session's cost
  from target FPS × resource kind and refuses when it does not fit, with a distinct reason per cause
  (`session-capacity` / `compute-capacity` / `reserve-protected` / `no-compatible-resource`). Different
  causes need different operator responses; "add a bigger box" does not fix `reserve-protected`.
- **Fair scheduling** — `weighted-fair` (default), `round-robin`, `strict-priority`. Priority influences
  share **without** permitting starvation: `maxConsecutivePerSession` bounds any session's run even
  under strict priority.
- **Degradation ladder** — `none → reduced-fps → reduced-resolution → reduced-behaviors →
shedding-frames → suspended`. Cheapest quality loss first; **hysteresis** on both directions prevents
  flapping; **fully reversible**; `maxDegradation` caps it per deployment (a hospital never suspends).
- **Predictive degradation** — least-squares trend over a bounded window projects utilization forward;
  acting on the projection means acting **while there is still headroom**, rather than after frames are
  already lost.
- **Per-session accounting + SLA** ([resources.py](../../ai/inference/resources.py)) — CPU/memory/GPU
  **attributed** from measured work (documented as estimates, not kernel measurements), plus queue
  depth, latencies, reconnects, and target-vs-actual attainment.
- **Analyzer cost model** — degradation disables the **most expensive** analyzers first, and never a
  `protectedAnalyzers` entry (fire/intrusion stay on).
- **Deployment profiles** ([profiles/deployment/](../../ai/inference/profiles/deployment/)) — retail ·
  warehouse · office · school · hospital · factory · parking, as portable JSON with fail-fast validation.
- **Decision log** — every admission, refusal, throttle, degrade, suspend and resume records identity ·
  action · typed reason · the measurement that triggered it. "Why was THIS camera throttled at 3am?"
- **Simulation** ([scheduler_sim.py](../../ai/inference/scheduler_sim.py)) — 4/8/16/32 cameras through
  the **real** scheduler with synthetic arrivals, byte-identical across runs.
- **Benchmark comparison** — `compare_reports` + `benchmark_cli.py --baseline`, exiting non-zero on a
  regression, so "never merge without measurable improvement" is enforced rather than asked for.

## 4. Recommendations folded in — 10 (AI-5b acceptance) + 8 + 7 = 25

| Source           | Recommendation                          | Where                                                                                                            |
| ---------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| AI-5b accept. 1  | Camera Capability Abstraction           | `CameraCapabilities` **extended** (fpsRange/streamProfiles/onvif); `resolve_stream_settings` reads, never probes |
| AI-5b accept. 2  | Separate operational vs AI metrics      | `METRIC_GROUPS` contract + `Metrics.grouped()`; no overlap (asserted)                                            |
| AI-5b accept. 3  | Session resource accounting             | `SessionResourceUsage` + `ResourceAccountant`; `GET /resources`                                                  |
| AI-5b accept. 4  | Camera deployment profiles              | 7 portable profiles + `deployment.py` fail-fast loader                                                           |
| AI-5b accept. 5  | Preserve offline replay forever         | [PRODUCTION_COMPATIBILITY §1](../architecture/future/PRODUCTION_COMPATIBILITY.md) + permanent equivalence gate   |
| AI-5b accept. 6  | Strengthen session isolation            | `test_session_isolation.py` — structural **and** behavioural verification                                        |
| AI-5b accept. 7  | Evidence-driven optimization            | `compare_reports`/`--baseline`; CI fails on regression                                                           |
| AI-5b accept. 8  | Real customer environments              | [PRODUCTION_COMPATIBILITY §2](../architecture/future/PRODUCTION_COMPATIBILITY.md) DVR/NVR/ONVIF/cloud matrix     |
| AI-5b accept. 9  | Real hardware validation (AI-5e)        | [PRODUCTION_COMPATIBILITY §3](../architecture/future/PRODUCTION_COMPATIBILITY.md) certification matrix           |
| AI-5b accept. 10 | Protect the frozen architecture         | [PRODUCTION_COMPATIBILITY §4](../architecture/future/PRODUCTION_COMPATIBILITY.md); stage 4 was pre-specified     |
| AI-5c a.1        | Generic ComputeResource abstraction     | `compute.py` — 7 kinds, abstract units, node-qualified ids                                                       |
| AI-5c a.2        | Camera/session priorities               | `SessionPriority` + `PRIORITY_WEIGHTS`; protected first under pressure                                           |
| AI-5c a.3        | Graceful degradation, not failure       | 6-rung ladder; suspension last and reversible                                                                    |
| AI-5c a.4        | Scheduler decisions with reasons        | `SchedulerDecision` — typed action + reason + measurement                                                        |
| AI-5c a.5        | Admission control                       | `AdmissionController` with typed refusal reasons                                                                 |
| AI-5c a.6        | Per-session SLA metrics                 | `SessionSla` — target vs actual, `met`, attainment %                                                             |
| AI-5c a.7        | Simulation at 4/8/16/32                 | `scheduler_sim.py` + `test_scheduler_sim.py`                                                                     |
| AI-5c a.8        | No machine-local assumptions            | Scheduler touches only `ComputeRegistry` + logical identities                                                    |
| AI-5c b.1        | Resource reservations                   | `reservedCapacityPercent` + `reserveFor`; privileged placement                                                   |
| AI-5c b.2        | Predictive scheduling                   | `Trend` slope/projection → `predicted-pressure` degradation                                                      |
| AI-5c b.3        | Decision explanations                   | Every action logged with identity + reason + measurement                                                         |
| AI-5c b.4        | Analyzer cost model                     | `AnalyzerCostModel`; most expensive disabled first, protected never                                              |
| AI-5c b.5        | Profiles configure operational defaults | FPS, sampling, behaviors, queues, priorities, degradation — all config                                           |
| AI-5c b.6        | Distributed-ready interfaces            | Abstract capacity + node-qualified ids + `ready()` callback                                                      |
| AI-5c b.7        | Formally verified session isolation     | 11 dedicated tests (structural + behavioural + cross-tenant collision)                                           |

## 5. Two bugs the work surfaced

1. **Fleet-wide suspension collapse.** The 32-camera simulation showed throughput falling to a third
   (131/300 ticks) because unchecked escalation suspended _every_ session. Suspending the last running
   session means the runtime analyzes nothing, which is strictly worse than every session running
   degraded. The governor now refuses to suspend the last runnable session and protects the highest
   priority; throughput returned to 300/300 at all four scales. **Only the simulation could have found
   this** — no unit test on a single session exhibits it.
2. **Contract/implementation drift.** `AdmissionRefusalReason` lacked `reserve-protected`, which the
   admission controller already returned. The contract test caught it before it shipped.

## 6. Tests (deterministic, stdlib, no camera / no hardware)

| Suite                                | Count | Covers                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_compute.py`                    |    16 | 7 accelerator kinds, abstract capacity, deterministic placement, node-qualified ids, reservations, CPU% derivation, failing GPU probe, absent≠zero                                                                                                                           |
| `test_scheduler.py`                  |    36 | policy validation (hysteresis), admission (all refusal reasons), fairness/weights/anti-starvation, batching, trends, ladder escalation + recovery + caps, **never suspends the last session**, predictive vs reactive, CPU/memory pressure, analyzer costs, decision records |
| `test_scheduler_sim.py`              |    11 | 4/8/16/32 sweep, **zero starvation at every scale**, no throughput collapse, refusal over overcommit, byte-identical reruns, priority shaping                                                                                                                                |
| `test_deployment.py`                 |    23 | all 7 profiles load, genuinely different envelopes, hospital never suspends, safety analyzers protected, portability, fail-fast validation, capability reconciliation (clamp/select/explain, never probe)                                                                    |
| `test_session_isolation.py`          |    11 | **formal isolation** — distinct queue/tracker/behavior/window/metrics/config/connection instances; degrade-one-affects-none; cross-tenant camera-id collision; shutdown leaves nothing                                                                                       |
| `test_benchmark.py` (added)          |    +7 | comparison accept/reject/noise-band, lower-is-better scoring, refuses different hardware/config/workload                                                                                                                                                                     |
| `test_metrics.py` (added)            |    +3 | operational/AI groups disjoint and correctly assigned                                                                                                                                                                                                                        |
| `test_live_sessions_http.py` (added) |    +3 | `/scheduler`, `/sla`, `/resources` tenant-scoped                                                                                                                                                                                                                             |
| contracts `inference.test.ts`        |   +11 | compute neutrality, priorities, ladder order, policy defaults, refusal reasons, decisions, SLA, usage, metric-group disjointness, portable profiles, cost model                                                                                                              |
| contracts `camera.test.ts`           |    +2 | additive capability defaults, fps-range validation                                                                                                                                                                                                                           |

**Contracts 181 · Python 355** (+14 / +108). Schemas **88**. All gates green.

## 7. Definition of Done

- [x] Hardware-independent `ComputeResource` (7 kinds, abstract units, distributed-ready ids).
- [x] Admission control with typed refusal reasons + capacity reservation for critical/recovery work.
- [x] Weighted-fair scheduling with priorities, batching, and structural anti-starvation.
- [x] Ordered, reversible, hysteretic degradation ladder with per-deployment ceiling.
- [x] Predictive degradation from queue/latency trends.
- [x] Per-session resource accounting + SLA tracking; operational/AI metric separation.
- [x] Analyzer cost model driving which behaviors degrade first; protected analyzers never disabled.
- [x] Seven portable deployment profiles + fail-fast loader; camera capabilities consumed, never probed.
- [x] Structured decision log for every scheduler action.
- [x] Simulation at 4/8/16/32 cameras, deterministic and byte-identical.
- [x] Benchmark baseline comparison; CI fails on regression.
- [x] Session isolation formally verified.
- [x] Additive contracts (+9 → 88 schemas); frozen five untouched; no new service; events-only boundary.
- [ ] **Architect review of AI-5c** — ⏳ pending (stop here before AI-5d).

## 8. Deferred

| Item                                                        | Slice                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Auto-recovery policy, health remediation, model hot-reload  | **AI-5d**                                               |
| Real-camera/GPU validation + certification matrix execution | **AI-5e**                                               |
| Production-readiness checklist + edge deployment            | **AI-5e**                                               |
| Distributed/clustered scheduling across nodes               | later (interfaces are ready)                            |
| True per-thread kernel resource measurement                 | later (attribution is documented as estimated)          |
| Real batched inference in the adapter                       | later (scheduler batches; adapters still run per-frame) |
