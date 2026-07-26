# 19 — Performance & Scale

## Purpose
Explain how the architecture scales from **2 to 10,000+ cameras** per tenant (and 100k+ platform-wide) with linear cost, and define the techniques and per-tier strategy.

## Responsibilities
- Identify the core constraints and the levers that relieve them.
- Provide a per-scale capacity/topology strategy and a cost model.

---

## 1. Core constraints
The binding constraints are **GPU inference throughput** and **stream fan-out**. Strategy: push inference to the **edge**, keep cloud services **stateless & horizontally scalable**, store **events not video**, and analyze **only frames that matter**.

## 2. Scaling levers (in impact order)
1. **Motion-gated adaptive sampling** — analyze only changed frames; the single biggest efficiency win.
2. **Edge offload** — real-time inference on-site; only events/evidence to cloud (bandwidth + cloud-GPU savings).
3. **Model sharing & batching** — one model instance serves many streams via GPU batching.
4. **ROI masking** — restrict compute to relevant zones.
5. **Capability placement & scheduling** — heavy/batch to cloud, real-time to edge ([05 §4](05-CAPABILITY-ARCHITECTURE.md)).
6. **Stateless services + autoscaling** — HPA on APIs, queue-depth scaling on workers, GPU pools on inference backlog.
7. **Sharded OLTP + Redis cluster + per-tenant vector namespaces**.
8. **Materialized read models** — dashboards read pre-aggregated data, not OLTP hot paths.
9. **Tiered smart-clip storage** — linear storage cost.
10. **Backpressure & graceful degradation** — shed non-critical capabilities/FPS before dropping safety-critical frames.

## 3. Per-scale strategy

| Cameras | Compute | Data / infra |
|---|---|---|
| **2** | Single edge box (Jetson Orin Nano) or one cloud worker; one pipeline | Single-node stores or shared cloud tenant |
| **10** | 1 edge box; batched inference + motion-gating | Shared cloud tenant DB; Redis cache |
| **100** | Edge server (RTX/L4) or multiple Jetsons; model sharing across streams; worker pool | Sharded-ready Mongo; Redis; CDN for HLS; hybrid sync |
| **1,000** | Multi-edge per site + cloud GPU pool (L4/L40S); autoscaled workers | Mongo sharding by tenant; Redis cluster; per-tenant vector; read models |
| **10,000+** | Distributed edge fleet + K8s GPU cluster (L40S/A100/H-class) for batch/search/train; multi-region | PB tiered object storage; read replicas + materialized models; global control plane, regional data planes; edge fleet management |

## 4. Latency budgets
- Frame→event (edge, real-time): **p95 < 300 ms**. Event→critical-alert: **p95 < 3 s**. Live view (WebRTC): sub-second. These are SLOs ([16 §8](16-OBSERVABILITY.md)) verified in load/stress tests.

## 5. Load & stress testing
- Camera **simulators** ([tools/](../../tools/)) drive N-camera GPU saturation and backpressure tests; k6/Locust for API/WS throughput and stream fan-out. A **1,000-camera load test** and a **10,000-camera fleet simulation** are milestone gates ([../../tracking/MILESTONES.md](../../tracking/MILESTONES.md)).

## 6. Cost/capacity model
- Per-camera cost `= f(capabilities enabled, FPS, resolution, edge vs cloud placement)`. Edge-heavy hybrid keeps **cloud-GPU cost near-zero per camera** (only batch/search/train in cloud), enabling aggressive per-camera pricing. Autoscale floors/ceilings + budget alerts; right-size from telemetry ([16 §7](16-OBSERVABILITY.md)).

## Design decisions
- **Edge-first + events-not-video** is what makes cost scale sub-linearly with cameras.
- **Priority lanes for safety-critical capabilities** guarantee fire/weapon/fall never starve under load.

## Advantages
- Predictable, near-linear cost at extreme camera counts; the same architecture serves 2 and 10,000 cameras.

## Tradeoffs
- Edge fleet + hybrid orchestration complexity, accepted for the cost/latency/privacy wins.

## Future expansion
- Global multi-camera re-ID at city scale; GPU MIG partitioning; adaptive model selection per scene; spot/preemptible GPU for batch/training.

## Cross-references
[05-CAPABILITY-ARCHITECTURE](05-CAPABILITY-ARCHITECTURE.md) · [14-EDGE-PLATFORM](14-EDGE-PLATFORM.md) · [16-OBSERVABILITY](16-OBSERVABILITY.md) · [17-DEVOPS-AND-INFRA](17-DEVOPS-AND-INFRA.md) · [18-DATA-ARCHITECTURE](18-DATA-ARCHITECTURE.md)
