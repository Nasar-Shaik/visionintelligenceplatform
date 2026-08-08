# Benchmark Framework

**Status: IMPLEMENTED (P-10 Workstream B, 2026-08-08).** The comparative harness specified below is
built and unit-tested. See [BENCHMARK_GUIDE](BENCHMARK_GUIDE.md) for how to run it.

> ⭐ **Three quarters of Workstream B already existed**, which is the third time this milestone has
> found that. `ai/datasets/` holds a corpus across 18 scenario categories; `dataset.py` verifies
> footage by digest and carries expectations; `evaluation.py::analyze_case` runs a clip through the
> **same `VideoAnalyzer` the playground and live runtime use** — decode → detect → track →
> behaviours → events. What was missing was one axis: **the detector**.

## What P-10 B added

| | |
| --- | --- |
| `ai/inference/detector_benchmark.py` | The **model × case matrix**: `DetectorRun`, `run_matrix`, `summarise`, `render_summary`, `model_ref` |
| `ai/inference/tests/test_detector_benchmark.py` | 17 tests, none of which needs a model, a video or onnxruntime |

⭐ **Model selection required no runtime change.** `ModelAdapter.load()` has always taken a resolved
catalogue entry, so pointing the pipeline at a different registered detector is a dictionary
(`model_ref`) rather than a feature. Adding GroundingDINO, Florence-2, YOLO12 or SAM2 to this
benchmark is a **catalogue entry and nothing else** — if a future detector ever needs a branch in
`detector_benchmark.py`, the plugin architecture has failed and the branch is the evidence.

## ⛔ The three properties that make a comparison honest

**1. The matrix is dense, and a failure is a row.** Every model runs every case. A model that cannot
decode a clip produces `status: "error"`; it is never omitted. **Omission is how a detector wins a
benchmark** — the hard cases vanish from its column and its averages improve. `summarise()` raises
`UnevenMatrix` when detectors completed different case sets, and names the divergent cases.

**2. The environment is printed above the table, not beneath it.** Every latency, FPS and CPU figure
is a property of the host as much as of the detector. When `hostContended` is set, the report opens
with a refusal to let those columns be quoted — detection, track and event counts remain valid,
because they do not depend on how busy the machine was.

**3. What cannot be measured is named, every time.**

| Absent | Why | What is reported instead |
| --- | --- | --- |
| **Precision / recall** | Needs per-frame ground truth the corpus does not carry | Detections per frame — ⚠️ a count, not an accuracy; more detections may be people or may be coat racks |
| **Ground-truth ID switches** | Needs per-frame identity annotation (MOTA) | `trackReassignments` — how often a `trackingId` changed within one `identityId`, named as the proxy it is |
| **Incidents** | ⛔ Architecture, not omission: the runtime emits `EventEnvelope` and creates no incidents | `None` at the runtime tier; the platform tier fills it |

## The two tiers

```
Tier 1 — runtime      video → decode → detect → track → behaviours → events
                      deterministic · one container · no platform · where detectors are compared

Tier 2 — platform     events → rules → incidents → reports
                      needs the deployed stack
```

⚠️ **Incident counts confound the detector with the rule configuration.** Two detectors under one
rule set produce different incident counts for reasons that are half rules; the tier boundary keeps
that visible rather than folding it into a single "detector score".

---

*The sections below are the original specification, kept because the reasoning is the useful part.*

---

## 1. Two questions, never merged

| | Question | Existing code | Metrics |
| --- | --- | --- | --- |
| **Operational** | Can it keep up? | `benchmark.py` — workloads, budgets, KPIs, 1/4/8-camera aggregation | fps, latency percentiles, drops, CPU, memory |
| **Accuracy** | Did it see the right thing? | `evaluation.py` — precision/recall, absence scored | precision, recall, F1, ID switches, false-recovery rate |
| **Comparative** | Is B better than A? | ⛔ **does not exist** | Δ on both, at equal cost |

⚠️ **Merging the first two produces a number that means nothing.** A model that is 3× faster and
misses half the people scores well on any weighted blend, and no such blend is defensible: whether
speed or recall matters more is a property of the deployment, not of the model. They are reported
side by side, always, and the adoption decision is made by a human reading both.

---

## 2. What the comparative harness must do

```
                    ┌───────────────────────────────────┐
   ┌──────────┐     │  ONE dataset, ONE frame sequence  │     ┌──────────┐
   │ Model A  │◀────┤  decoded ONCE, fed to both        ├────▶│ Model B  │
   └────┬─────┘     └───────────────────────────────────┘     └────┬─────┘
        │                                                          │
   operational + accuracy                              operational + accuracy
        └───────────────────────┬──────────────────────────────────┘
                                ▼
                      comparison report (Δ, both directions)
```

### ⛔ Decode once, feed both

Running each model over its own decode of the same file is the obvious implementation and it is
wrong. Two decodes of one MP4 can differ — B-frame handling, dropped frames at a seek, a container
whose PTS disagree with the frame count (`timestamps-diverged`, already a known finding). The two
models would then be scored on *different pixels*, and a 2 % recall difference would be
indistinguishable from a decoder artefact.

⭐ The rule: **the frame sequence is the experimental control.** Decode once into a deterministic
sequence, hash it, record the hash in the report. Two reports with different sequence hashes are not
comparable and the tool must say so rather than print a Δ.

### ⛔ Equal cost, or state the inequality

"Model B has 4 % better recall" is meaningless if B is 6× slower. Every comparison reports the
operating point:

- CPU-seconds per analysed frame
- peak RSS during the run
- achieved fps at the target camera count
- the execution provider and thread count (⚠️ `OMP_NUM_THREADS` alone moves ONNX latency by 2–3×;
  an unrecorded thread count invalidates every comparison in the report)

### ⚠️ Same preprocessing, or the difference is not the model

Letterbox vs stretch, BGR vs RGB, mean/std normalisation, input resolution — each changes accuracy
measurably. `preprocessingVersion` is already stamped on `DetectionResult`; the comparison report
must show it for both sides and flag a mismatch as **not comparable**, not as a result.

---

## 3. Report shape

```jsonc
// DESIGN ONLY
{
  "datasetId": "cctv-core-v1",
  "frameSequenceHash": "sha256:…",          // ⚠️ equality is a precondition, not a detail
  "cases": 412,
  "negativeControls": 68,                    // ⭐ scored, and reported separately
  "arms": [
    {
      "modelId": "yolox-nano", "modelVersion": "1.0.0",
      "engine": "onnx", "executionProvider": "CPUExecutionProvider",
      "threads": 4, "preprocessingVersion": "1.0.0",
      "operational": {
        "fps": { "min": 0, "avg": 0, "p95": 0, "max": 0 },
        "inferenceMs": { "min": 0, "avg": 0, "p95": 0, "max": 0 },
        "cpuSecondsPerFrame": 0, "peakRssMiB": 0
      },
      "accuracy": {
        "precision": 0, "recall": 0, "f1": 0,
        "falsePositivesOnNegativeControls": 0,   // ⛔ the number that loses deployments
        "idSwitches": null,                       // null when the case has no identity ground truth
        "byCategory": { "low-light": {}, "crowd": {}, "occlusion": {} }
      }
    }
  ],
  "delta": { "recall": 0, "precision": 0, "p95InferenceMs": 0 },
  "verdict": "not-decided",   // never computed; a human writes it with a reason
  "reason": ""
}
```

⚠️ **`verdict` is never computed.** A framework that emits `"adopt"` invites adoption without anyone
reading the per-category breakdown — and the per-category breakdown is where a model that is 3 %
better overall turns out to be 20 % worse in low light, which is half of retail's operating hours.

⚠️ **`byCategory` is mandatory, not optional.** An aggregate over a corpus whose composition nobody
controls is a weighted average of an arbitrary weighting. Reporting per category makes the weighting
the reader's choice.

---

## 4. Where a benchmark must run

| Environment | Purpose | Gate |
| --- | --- | --- |
| **Unit** (stub adapter, synthetic frames) | the KPI maths is correct | every commit — already exists (`benchmark.py` pure functions are unit-tested with injected numbers) |
| **Nightly** (real runtime, fixture corpus) | catch a regression from a dependency bump | nightly stage, per the verification-economy policy |
| **Comparative** (real runtime, real CCTV corpus) | adopt or reject a model | on demand; ⛔ **required** before any model change reaches a customer |
| **Deployment** (the actual box) | sizing | before a customer install |

⚠️ **A benchmark that never runs against the real runtime measures the stub.** `benchmark.py`
defaults to the stub adapter and says so; that is right for CI and useless for adoption. The
comparative harness must refuse to produce a report from stub adapters, rather than producing one
that looks the same.

---

## 5. Budgets

The existing `PerformanceBudget` / `evaluate_budget` machinery carries this. What must be added when
multi-stage profiles arrive:

- a **per-stage** budget, not only per frame — otherwise "the profile is over budget" cannot be
  attributed;
- a budget expressed at a **camera count**, because the interesting failure is at 8 cameras, not 1;
- a **degradation budget**: how many frames a stage may skip before the profile is reported degraded
  rather than healthy.

---

## 6. What this framework cannot tell you

- Whether the model works on **your** camera. Every number here comes from a corpus; the corpus is
  not the customer's shop.
- Whether it works on a **GPU**. Numeric kernels differ; accuracy must be re-measured, not carried.
- Whether it works at **scale**. 8 cameras on one box is not 800 across an estate.
- Whether the *pipeline* is fast enough end to end. That is
  [LIVE_PERFORMANCE_BASELINE.md](../validation/LIVE_PERFORMANCE_BASELINE.md), which measures nine
  stages of which inference is one.

---

## 7. Related

- [MODEL_EVALUATION_PLAN.md](MODEL_EVALUATION_PLAN.md) — the adoption process this feeds
- [DATASET_STRATEGY.md](DATASET_STRATEGY.md) — the corpus
- [MODEL_PLUGIN_GUIDE.md](MODEL_PLUGIN_GUIDE.md) §6 — a plugin's benchmark obligation
