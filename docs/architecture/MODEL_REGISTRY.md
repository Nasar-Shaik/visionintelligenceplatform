# Model Registry

**What every perception model must declare before it can run in production, and who is allowed to
decide that it may.**

> ⭐ **Most of this exists.** `ai/inference/model_registry.py` already tracks tenant-scoped models
> with append-only versions, an active-version selection, capability profiles and enabled/disabled
> status. `model_lifecycle.py` governs promotion. This document says what P-10 **adds** to it and
> what stays exactly as it is — writing a second registry would be the most expensive possible way to
> gain nothing.

---

## 1. The record

Fields marked ⭐ are new in P-10; the rest exist today.

| Field | Meaning | Why it must be declared |
| --- | --- | --- |
| `modelId` | Stable identity, e.g. `yolox-nano` | Detections are seeded with it ([`detection_id`]) — a model change must change the ids |
| `version` | Immutable, append-only | A version that can be edited is a version nobody can cite |
| ⭐ `task` | One of the registered perception tasks | Without it, "compare these two models" is undefined — an OCR model and a detector are not comparable |
| `supportedClasses` | The label vocabulary | ⚠️ A rule asking for `person` against a model that only knows `vehicle` fails **silently and forever** |
| `confidenceThresholds` | Per-class, with a default | Thresholds are a property of the model, not of the deployment that uses it |
| `runtimeRequirements` | Memory, cores, accelerator, minimum runtime version | The check that must happen *before* a deployment discovers it at 03:00 |
| ⭐ `precision` | `fp32` \| `fp16` \| `int8` | A quantised model is a **different model** for benchmarking. Quoting an fp32 mAP beside an int8 latency is the most common lie in this field |
| `backend` | `onnx` \| `tensorrt` \| `openvino` \| … | Resolved through `EngineRegistry`; recorded so a result is reproducible |
| ⭐ `benchmarkHistory` | Every run against the standard corpus, append-only | See §3 |
| `deploymentStatus` | `registered` → `benchmarked` → `approved` → `active` → `retired` | See §2 |

## 2. The lifecycle, and the gate that matters

```
registered ──▶ benchmarked ──▶ approved ──▶ active ──▶ retired
                    │              │
                    │              └── requires a human decision, recorded with a reason
                    └── requires a complete run against the standard corpus
```

⛔ **A model cannot reach `approved` without a benchmark run whose corpus version is recorded.**
This is the rule the Architect asked for — *"every future model must pass this benchmark before
production approval"* — expressed as a state machine rather than a convention, because a convention
is a thing people are busy on the day it matters.

⚠️ **`benchmarked` is not `approved`.** A model that scores better on average may be worse on the
scenario a customer bought the system for. The transition is a human decision that records *which*
results justified it — the alternative is a leaderboard silently deciding what ships.

## 3. Benchmark history is append-only and belongs to the model

Every entry: corpus version, commit, date, hardware, precision, and the full metric set from
[BENCHMARK_FRAMEWORK](BENCHMARK_FRAMEWORK.md). ⭐ **Never overwritten**, because the question that
matters six months from now is "did this get better or worse", and an overwritten history cannot
answer it.

⚠️ **A benchmark result without its corpus version is unusable**, and it is unusable in the most
dangerous way: it looks comparable. Corpus v2 with harder backlight footage will drop every model's
recall, and a table mixing v1 and v2 rows reads as a regression that did not happen.

## 4. What P-10 does not change

- **Tenant scoping.** Every lookup stays `(tenant_id, model_id)`. Fail-closed, Law 5.
- **The registry never imports an engine.** It records *which* model+version+engine a capability
  should run; execution stays behind `ModelAdapter`.
- **No new service.** This is the existing module, extended.

---

## 5. Open questions, recorded rather than answered

⚠️ **Cross-tenant model sharing.** A benchmark corpus is platform-wide, but models are tenant-scoped.
Whether a platform-provided model appears in every tenant's registry or is referenced from a shared
catalogue is undecided; it affects storage, promotion and billing, and guessing now would be worse
than deciding later with a customer in front of us.

⚠️ **Who owns thresholds after tuning.** If an operator tunes a threshold for one camera, that value
belongs to the deployment, not the model — but the model's `confidenceThresholds` is where a reader
will look for it. The seam exists (`AssignmentGate` already carries per-camera configuration); the
precedence rule is not yet written down.
