# Benchmark Framework

**Status: DESIGN ONLY** for the comparative harness. The *operational* half already exists
(`ai/inference/benchmark.py`, AI-5a); what does not exist is the ability to run **two models over one
dataset and compare them**, which is the requirement this document specifies.

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
