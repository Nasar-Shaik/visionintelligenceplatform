# AI Benchmark Framework (Deliverable 9)

_Status: ⏳ Architect Review Pending · Documentation-only · Builds on [08-AI-ML-PLATFORM](../08-AI-ML-PLATFORM.md) + `ai/mlops` (MLflow + DVC)_

> A repeatable framework to measure every AI capability/model on **performance** and **accuracy**, feed
> results to the **model registry**, and **gate promotion** (experimental → beta → stable). Reuses the
> MLOps registry the platform already has — **not a new service**. Closes the "no model-CI FP/FN gates"
> gap noted in [TD-5].

## What already exists

- **Model Registry (MLflow)** + **Dataset Registry (DVC + MinIO)** in `ai/mlops` — versioned models +
  datasets, experiment tracking.
- **Runtime metrics** (P1-6): latency, decode time, FPS, frames/drops, detection count, avg confidence,
  RSS/CPU — already emitted per capability.
- **Version metadata** on every `DetectionResult` (runtime + capability + model version + execution
  provider) — reproducible, benchmarkable.

## Metrics captured (directive fields → source)

| Metric                                        | Source                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| FPS · Latency                                 | runtime metrics (existing)                                            |
| GPU / CPU Utilization · Memory                | runtime + host telemetry ([16-OBSERVABILITY](../16-OBSERVABILITY.md)) |
| Detection Accuracy · Precision · Recall · mAP | **benchmark run** over a **labeled DVC dataset** (new)                |
| Supported Hardware                            | run matrix (cpu / cuda / edge SKUs) → catalog `supportedHardware`     |

## How benchmarking is performed

```
benchmark(capabilityId, modelVersion, datasetVersion, hardware):
   1. pull labeled dataset (DVC)  +  model (MLflow, by selector)
   2. run the capability over the dataset on target hardware (batch matrix)
   3. compute perf (fps/latency/util/mem) + accuracy (P/R/mAP vs labels)
   4. log a run to MLflow (params: model+dataset+hw; metrics: the above)
   5. compare vs the current baseline → PASS/REGRESS
```

- **Offline + reproducible:** deterministic dataset + pinned model/runtime versions; no tenant data
  (uses curated benchmark datasets).
- **CI integration:** a `model-ci` job runs the benchmark on candidate models; **promotion gates** —
  a model may reach `stable` only if precision/recall ≥ baseline and latency ≤ the capability's
  `latencyBudgetMs` ([AI_CAPABILITY_REGISTRY](AI_CAPABILITY_REGISTRY.md)).
- **Results surface** in the capability catalog (per-capability accuracy/perf on supported hardware) and
  in System Health.

## Proposed shape (future — NOT built)

```
BenchmarkRun = {
  capabilityId, modelVersion, datasetVersion, hardware,
  perf: { fps, p50LatencyMs, p95LatencyMs, gpuUtil, cpuUtil, memMb },
  accuracy: { precision, recall, mAP, threshold },
  baselineDelta, verdict: 'pass'|'regress', at,
}
```

## Value

Objective model-promotion decisions; regression protection (a worse model can't reach `stable`);
hardware-sizing evidence for [19-PERFORMANCE-AND-SCALE](../19-PERFORMANCE-AND-SCALE.md); customer-facing
accuracy claims backed by data.

## Not built now

**Phase 3**, gated on ≥ 2 models/promotion decisions **and** labeled benchmark datasets (AR-6). The
seams (MLflow, DVC, runtime metrics, version metadata) are all present today.
