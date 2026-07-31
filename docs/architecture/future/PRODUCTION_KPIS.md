# Production KPIs, SLOs & Performance Budgets — the platform's performance governance

_Status: Governance · Author: Claude · Date: 2026-07-31 · **AI-5a (Production Readiness)**_

> Established at **AI-5a** (Architect Production-Readiness recommendations 1/3 + performance-budgets
> addendum). This document defines **what "good" means** for AI Runtime Architecture **v1.0** in
> production, so every optimization is **evidence-driven** (measure first) and every deployment is
> validated against explicit acceptance criteria. **Benchmarking is now part of engineering governance:**
> record the baseline before changing anything, then compare.
>
> This is **operational governance**, not architecture. The five frozen contracts
> ([ED-0039](../../project/ENGINEERING_DECISION_LOG.md)) are untouched. Contracts:
> [`@vip/contracts/benchmark`](../../../packages/contracts/src/benchmark/benchmark.ts); harness:
> [`ai/inference/benchmark.py`](../../../ai/inference/benchmark.py); budgets:
> [`ai/inference/benchmarks/budgets.json`](../../../ai/inference/benchmarks/budgets.json).

---

## 1. KPIs — what we measure (the baseline set)

Every benchmark run records these (contract: `BenchmarkKpis`):

| KPI                                    | Meaning                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| **fps**                                | sustained frames/sec processed (per camera)                   |
| **inferenceLatencyP50Ms**              | median inference latency                                      |
| **inferenceLatencyP95Ms**              | tail inference latency                                        |
| **eventLatencyMs**                     | end-to-end frame → emitted `EventEnvelope`                    |
| **eventThroughput**                    | events emitted per second                                     |
| **droppedFramePercent**                | genuine frame loss (backpressure/failure — not down-sampling) |
| **framesProcessed**                    | frames processed in the run                                   |
| **durationSeconds**                    | measured wall-clock (warm-up excluded)                        |
| **cpuPercent / gpuPercent / memoryMb** | resource usage (where measurable)                             |

**Warm-up is excluded from measurement** (initialization cost must not skew the baseline). Runs are
**deterministic-synthetic by default** (stub adapter); real RTSP/GPU benchmarks arrive with AI-5b+.

## 2. SLOs / Performance Budgets — the acceptance criteria

A budget (contract: `PerformanceBudget`) is the **production acceptance criteria** for a deployment
class. A benchmark **passes** when every constrained KPI is within budget; a KPI within 10% of its limit
is a **WARNING** (informational — it never fails the run or changes runtime behavior in AI-5a).
Verdicts: `pass · warning · fail · na`.

### Performance budgets by deployment class (starting targets — tune with real evidence)

| Deployment class | minSustainedFps | maxEventLatencyMs | maxInferenceLatencyMs (p95) | maxFrameLoss% | maxRecovery(s) | resource ceilings         |
| ---------------- | --------------: | ----------------: | --------------------------: | ------------: | -------------: | ------------------------- |
| **dev-laptop**   |              10 |               150 |                          40 |             2 |              5 | —                         |
| **mini-pc-i5**   |               8 |               200 |                          60 |             3 |              8 | —                         |
| **rtx-desktop**  |              25 |               100 |                          20 |             1 |              5 | GPU ≤ 90%                 |
| **edge-device**  |               5 |               200 |                          80 |             5 |             15 | CPU ≤ 90% · RAM ≤ 1024 MB |

These encode the Architect's performance-budget addendum (e.g. **edge: sustained ≥ 5 FPS, end-to-end
event latency ≤ 200 ms, bounded recovery**) and are the source of truth in
[`benchmarks/budgets.json`](../../../ai/inference/benchmarks/budgets.json). Adjust per measured evidence
as AI-5b…e land real cameras/hardware.

## 3. Deployment classes (Architect rec 2)

The harness is **hardware-neutral** but reports **hardware-specific** results tagged with the class it
ran on, plus an **environment fingerprint** (OS/arch/Python/cores) so results compare across machines:

```
dev-laptop → mini-pc-i5 → rtx-desktop → edge-device
```

Each class = target FPS + camera count + resolution + budget. This ties deployment classes to
`BehaviorProfile`s (a future, additive integration) so customer hardware is benchmarked consistently.

## 4. Benchmark workloads / scenarios (Architect rec 5/7)

Operational realism over synthetic peaks. The standard suite:

| Scenario       | Cameras | Notes                                          |
| -------------- | ------: | ---------------------------------------------- |
| single-camera  |       1 | latency floor                                  |
| four-cameras   |       4 | typical small deployment                       |
| eight-cameras  |       8 | fan-out / scheduling pressure                  |
| continuous run |    1..N | long-duration stability (extensible)           |
| stress test    |     > N | saturation / graceful-degradation (extensible) |

Mixed resolutions/frame rates and long-duration runs are supported by extending `BenchmarkWorkload`.

## 5. Governance rules

- **Benchmark before optimizing** (rec 9): record a baseline `BenchmarkReport` first; every change is
  measured against it. `BenchmarkReport` carries `benchmarkVersion` + `runtimeVersion` + `environment` +
  `configuration` for **reproducibility**, and a reserved `baselineId` for future comparison (no
  regression logic in AI-5a).
- **Additive-only** (rec 10): benchmarking never changes the frozen contracts or runtime behavior.
- **Capability Maturity** (rec 12): promotion Experimental → Beta → Production requires **benchmark
  evidence + real-deployment validation**, recorded in [CAPABILITY_MATURITY](CAPABILITY_MATURITY.md).
- **CI-gateable**: the benchmark CLI exits non-zero on a budget **FAIL** (warnings do not fail), so a
  baseline regression can gate a pipeline when desired.

## 6. Artifact bundle

`python benchmark_cli.py --deployment <class> --suite` writes a reproducible bundle:
`benchmark.json` · `summary.txt` · `runtime_metrics.json` · `environment.json` · `configuration.json`.

## 7. What AI-5a does NOT cover (later slices)

Real RTSP/live latency (AI-5b), scheduler backpressure + genuine drop measurement (AI-5c), recovery-time
benchmarks (AI-5d), and the full Production Readiness Checklist + edge validation (AI-5e). AI-5a
establishes the **measurement baseline** those slices optimize against.
