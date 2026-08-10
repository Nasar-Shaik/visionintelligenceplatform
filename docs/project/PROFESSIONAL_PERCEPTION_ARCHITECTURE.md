# Phase 3 — Professional Perception: architecture

**Design only. ⛔ No implementation has begun and none is authorised by this document.**

2026-08-10, written at `a8d5095` against the platform Phase 2 closed. Every measured number quoted
here comes from this deployment; every number about a model that is *not yet deployed* is marked as a
published figure or an estimate, and the two are never mixed.

> **The thesis.** VIP is a behaviour engine whose behaviour vocabulary is now larger than what its
> detector can see. Phase 2 measured that precisely: nine of thirty photographs chosen for a carried
> object had it admitted, and `handover`, `dropped` and `object_missing` have never executed because
> nothing produced their inputs. ⭐ **Phase 3 is not "add models". It is raising the perception floor
> under a behaviour layer that is already built, already explainable, and already waiting.**

---

## 0. ⛔ The precondition: slice 3.0 before any of this

Phase 2 closed with one blocker: **a subject still in shot when a run ends is never written to
durable track history** (`PHASE2_COMPLETION_REPORT.md` § 8.1). Measured across three runs, with zero
write failures — nothing failed, nothing was attempted.

⛔ **Every capability below multiplies the facts a run produces.** Multiplying facts that are not
durably stored multiplies the loss, and it does so invisibly. Pose, segmentation and re-ID would all
be verified by reads taken minutes after a run and would all quietly degrade by the hour.

**Slice 3.0 fixes durability. Nothing in this document starts before it lands.**

---

## 1. What must not change

These are the guardrails Phase 2 held at every slice, and Phase 3 is a harder test of them because it
is the first milestone that genuinely wants new models.

| guarantee | how Phase 3 keeps it |
| --- | --- |
| **One production pipeline** | every model below enters through `ModelAdapter` + a decoder. `perception-boundary.mjs` §A proves the runtime has exactly one caller and that check does not weaken |
| **No new services** | none proposed. The benchmark lab is a CLI, not a daemon |
| **No new pipeline stages** | new perception rides `StageChain`, which is how behaviour arrived in slice 2.2 without adding a layer |
| **Events-only boundary** | no service gains knowledge of a model. §C already forbids naming a model concept outside `ai/` |
| **Perception-only runtime** | pose, masks and embeddings are *observations*. Meaning stays in rules (ADR-0052) |
| **Additive contracts** | every field below is optional; a deployment that declares nothing behaves exactly as today |
| **Explainability** | ⛔ **the hard one.** See § 12 |

⭐ **The seam already exists and has already been exercised twice.** `model_formats.register_decoder(
output_format, decoder)` plus `get_decoder()`; the catalogue entry carries `input` (size, layout,
colour order, resize policy, padding, scale, mean/std) and `outputParams`. RT-DETR was integrated
through it with **zero changes above `adapters/model_formats.py`** — two families, two output
layouts, two coordinate conventions, two resize policies. That is measured, not asserted.

---

## 2. Detector abstraction

### 2.1 What is already there

```
RegisteredModel(id, family, task, artifact, sha256, licence, trainedOn,
                input: InputSpec, outputFormat, outputParams, accelerators, status)
        │
        ▼
OnnxModelAdapter ──▶ model_formats.preprocess(bytes, spec) ──▶ tensor, Geometry
        │                                                          │
        └──▶ session.run ──▶ get_decoder(outputFormat)(outputs, spec, geometry, params)
                                                │
                                                ▼
                                    List[RawDetection(bbox, score, class_id)]
```

`ModelStore` resolves a `ModelSelector` (task, family, versionRange, accelerator) from the manifest.
`CapabilityManifest` carries `minConfidence` and, since slice 2.10, `minConfidenceByLabel`.

### 2.2 What Phase 3 adds — and it is deliberately small

⛔ **`RawDetection` cannot carry a pose, a mask or an embedding, and it must not be widened to.** It
is the contract every decoder and every stage agrees on; growing it would make every existing decoder
responsible for fields it will never produce.

⭐ **The proposal: a second decoder family, not a bigger detection.** `perception.py` already has the
richer vocabulary — `RawInstance` carries optional attributes, and `FrameLabel` describes the frame
with no box at all. That is the vocabulary ADR-0050 named as *the plugin boundary*, and it was built
for exactly this.

```
task: "object-detection"  ──▶ decoder ──▶ RawDetection      (today, unchanged)
task: "pose-estimation"   ──▶ decoder ──▶ RawInstance(attributes.pose)
task: "segmentation"      ──▶ decoder ──▶ RawInstance(attributes.mask)
task: "re-identification" ──▶ decoder ──▶ RawInstance(attributes.embedding)
task: "open-vocabulary"   ──▶ decoder ──▶ RawDetection + prompt provenance
```

Each is a `task` in the open task set P-10 built. Each is one catalogue entry, one decoder, one
manifest. ⚠️ **If any of them requires a change to `pipeline.py`, `capability.py` or
`perception_registry.py`, the design is wrong and that is the finding** — the same test slice 2.2
applied to behaviour.

### 2.3 Manifest additions (all optional)

| field | purpose |
| --- | --- |
| `requiredModel.task` | already present — selects the family |
| `minConfidenceByLabel` | already present (slice 2.10) |
| `preferredAccelerator` | `cuda` \| `cpu`, with CPU fallback declared rather than assumed |
| `maxLatencyMs` | ⭐ a capability that cannot meet its budget refuses to load rather than degrading the live path silently |
| `fallbackCapability` | the capability to run when this one cannot load |

---

## 3. The benchmark lab

⭐ **Built second, and used to justify everything after it.** `ai/mlops/compare_detectors.py` already
does this for two detectors and produced the RT-DETR decision; Phase 3 generalises it.

### 3.1 What it measures

| axis | metric | why |
| --- | --- | --- |
| Accuracy | mAP@50, mAP@50-95, **per-class AP** | ⛔ aggregate mAP hides exactly the defect Phase 2 found: a model can be excellent overall and blind to `handbag` |
| Small objects | AP_small (COCO < 32² px) | the carried-object case, named |
| Latency | avg, p50, p95, p99 per frame | p95 is what a live path lives or dies by |
| Throughput | fps, single stream and at concurrency | |
| Memory | peak RSS, model artifact size | edge deployability |
| Load | session construction ms | restart behaviour |
| Agreement | IoU vs the incumbent, per class | ⭐ a swap that changes *which* people are found is a different event from one that finds more |

### 3.2 The methodology, and the rules that make it honest

1. **The same seam as production.** The lab calls `model_formats.preprocess()` and `get_decoder()` —
   a harness that could disagree with the runtime would be measuring itself.
2. **Each model in its published configuration.** 416 letterbox for YOLOX-nano, 640 stretch for
   RT-DETR. ⚠️ A same-size comparison measures a configuration neither model ships.
3. **Warm-up frames discarded and the count declared.**
4. **`caffeinate -dimsu`.** 966 s of host suspension once turned a true 4.000 fps into a recorded 2.6.
5. **A negative control every time**: frames with nothing in them must produce nothing.
6. **⛔ Prove the instrument can move before trusting a clean run.** An empty result equals an empty
   result; a benchmark that cannot fail has measured nothing.
7. **Per-class floors calibrated per model**, on the pinned corpus, with the false-positive cost on
   object-free authored footage stated — the slice-2.10 procedure, generalised.
8. **A held-out set.** ⚠️ COCO val is what these models were tuned against; the platform's own
   corpus and real customer footage are the honest test.

### 3.3 Success criteria for the lab itself

The lab is done when it can answer, without a human editing anything: *"for this footage, which model
finds more of what we care about, at what latency, at what memory, and where do they disagree?"*

---

## 4. YOLO11 — the migration, and why it is first

| | |
| --- | --- |
| Why first | ⭐ the cheapest large gain. It is a **drop-in detector swap** through a seam already proven twice, and better small-object recall lifts § 8.2 of the Phase 2 report directly |
| Licence | ⛔ **AGPL-3.0** (Ultralytics), or a commercial licence. **This is a business decision, not an engineering one, and it must be taken before any weights are downloaded.** Every model in the catalogue today is Apache-2.0 |
| Variants | n / s / m / l / x — published COCO mAP@50-95 ≈ 39.5 / 47.0 / 51.5 / 53.4 / 54.7 |
| Incumbent | `yolox-nano`, **25.8** published mAP, **41.2 ms** measured on this host |
| Estimate | YOLO11n ≈ yolox-nano cost at materially higher mAP; YOLO11s ≈ **2–3× slower** on CPU — *estimated from parameter count, to be replaced by measurement* |
| Export | ONNX, so `OnnxModelAdapter` is unchanged |
| Decoder | one new `outputFormat: "yolo11"` — the anchor-free head differs from YOLOX's |

⚠️ **The licence question may end this line entirely.** If AGPL is unacceptable, the alternatives are
RT-DETR (Apache-2.0, already in the catalogue), D-FINE, or RTMDet (Apache-2.0). ⭐ **The detector
abstraction is what makes that a configuration decision rather than a rewrite** — which is the
strongest argument for building § 2 and § 3 before choosing.

### Rollout

```
shadow ──▶ compare ──▶ canary ──▶ default ──▶ retire
  │           │           │          │
  │           │           │          └─ yolox-nano stays `enabled` in the catalogue
  │           │           └─ one camera, floors recalibrated for THIS model
  │           └─ per-class AP + agreement vs incumbent, on the platform's own corpus
  └─ both models on the same frames, offline; production still serves yolox-nano
```

⛔ **Per-class floors are model-specific and must be re-measured, never inherited.** 0.20 is a fact
about `yolox-nano`'s score distribution. Carrying it to another model would be carrying one model's
evidence as another model's configuration — the precise mistake that made `minConfidence: 0.5` a
person-detector threshold applied to eighty classes.

---

## 5. RT-DETR

| | |
| --- | --- |
| State | ⭐ **already in the catalogue, `status: disabled`**, Apache-2.0, exported by `ai/mlops/export_rtdetr_onnx.py` |
| Measured here | **944 ms/frame**, 1.05 fps, 335.8 MiB peak — **22.9× slower** than yolox-nano on CPU |
| Accuracy, measured here | 33 vs 26 person detections over the same 40 frames, **never fewer in any frame** |
| Verdict | ⛔ unusable on the live CPU path (4 fps inside an 87 ms budget). ⭐ Viable for **GPU** and for **offline batch analysis**, where latency is not the constraint |

⭐ **This is Phase 3's first architectural decision, and it is already evidence-backed: the platform
needs two execution profiles, not one model.** Live CPU wants the fastest adequate detector; offline
investigation can afford the best one. The catalogue and `ModelSelector` already express this —
`accelerator` is part of the selector, `AnalyzeOptions` is separate from the live capability, and
nothing needs inventing.

⚠️ Requires a GPU-capable image (`onnxruntime-gpu` + CUDA). That is a deployment change and belongs
in § 10 rather than here.

---

## 6. Pose estimation

| | |
| --- | --- |
| Candidates | YOLO11-Pose (AGPL) · RTMPose (Apache-2.0) · ViTPose (Apache-2.0) |
| Recommendation | ⭐ **RTMPose-t/s** — Apache-2.0, ONNX-exportable, designed for CPU, top-down so it reuses the person boxes already produced |
| Output | 17 COCO keypoints + per-keypoint confidence, on `RawInstance.attributes.pose` (`ATTR_POSE` already exists in `perception.py`) |
| Cost estimate | top-down runs **per person**: `frame_cost + n_people × pose_cost`. ⚠️ A queue of eight makes it the dominant cost — **must be measured before committing** |

### What it unlocks, in behaviour-layer terms

| new primitive | mechanism | business words |
| --- | --- | --- |
| `reach` | wrist keypoint enters a zone or nears an object box | hand–object interaction, shelf interaction |
| `crouch` / `bend` | hip–knee–ankle angle | tampering, searching a low shelf |
| `orientation` | shoulder line vs camera | facing a shelf, facing away from a till |
| `hand_occupied` | wrist keypoint inside a carried object's box | ⭐ turns "near an object" into "holding it" |

⛔ **Pose is geometry, and it stays geometry.** "Wrist within 3% of the frame width of a bottle for
1.2 s" is a fact. "Concealment" is a claim about intent and belongs in a rule (ADR-0052).

---

## 7. Segmentation

| | |
| --- | --- |
| Candidates | YOLO11-Seg (AGPL) · SAM2 (Apache-2.0, large) · RTMDet-Ins (Apache-2.0) |
| Recommendation | ⚠️ **defer, and use pose first.** Masks are expensive and most of what Phase 3 wants from them — is the hand on the object, did the object leave the shelf — pose answers more cheaply |
| Where a mask genuinely wins | ⭐ occlusion reasoning. A box says two people overlap; a mask says which is in front, which is the input object permanence actually needs |
| SAM2 | prompt-driven and heavy; ⭐ its real fit is **investigation-time, on demand** — an operator asks "segment this object in this frame" — not per-frame perception |

⛔ **A per-frame mask for every subject is not affordable on CPU and should not be attempted.**

---

## 8. Re-identification

| | |
| --- | --- |
| Model | a small appearance embedder (OSNet / FastReID class), 128–512-d, Apache-2.0 available |
| Output | `RawInstance.attributes.embedding`, plus the model id and dimension so two versions never get compared |
| Cost | per person per frame, but embeddings can be sampled — ⭐ once per track per N frames is enough |

### ⛔ The two hard parts, and neither is the model

1. **Where does the gallery live?** An embedding store is state, and the runtime is stateless by
   design. ⚠️ It must not become a new service. `TrackHistoryStore` already stores per-identity
   records durably and is the natural home — **but only after slice 3.0**, because a re-ID gallery
   built on a store that silently loses its most-present subjects would be worse than none.
2. **⛔ Re-identification is biometric processing.** Matching a person across cameras and across days
   is a different legal object from counting bodies in a frame — GDPR/DPIA, retention, consent,
   subject-access. **This needs a governance decision and an ADR before a line of code**, and it is
   the reason re-ID is placed after the detector work rather than first, despite being more valuable.

⚠️ ADR-0038 (no track-id reuse) and ADR-0041 (identityId vs trackingId) already draw the line re-ID
would cross. Both must be re-read, and probably amended, as part of this work.

---

## 9. Object permanence, hand–object, shelf, checkout, open-vocabulary

### 9.1 Object permanence

⭐ Today `object_missing` **is** `observation_gaps` — one mechanism, three business words, and its
docstring is honest that *"a shopper behind a display, an object in a bag and a detector that simply
missed three frames produce identical gaps."*

Permanence is the state machine that separates them: an object that was tracked, then was not,
**while a subject was over it**, is a different fact from one that vanished alone. ⚠️ It needs pose
or masks to know "over it", which is why it follows § 6.

⛔ It must remain an *observation*: `objectOccludedBy: <identityId>` is a fact; "concealed" is not.

### 9.2 Hand–object interaction

The join between § 6 and the association layer that already exists. `hand_occupied` upgrades
`associations()` from **nearest-subject-per-frame** — a heuristic its own docstring names as one —
to a keypoint test. ⭐ It also resolves the ambiguity case that `AssociationModule` has warned about
since slice 2.2 and that has never been checked against reality: two people reaching at once.

### 9.3 Shelf interaction

⚠️ **Mostly not a perception problem.** A shelf is an operator-drawn zone, and `zone_visits`,
`reach` and `carried` already compose into "reached into shelf zone, an object began travelling with
them, they left the zone". ⭐ **No new primitive** — a rule over existing facts, exactly as
`cross_line` turned out to be in slice 2.9.

### 9.4 Checkout correlation

⛔ **Not perception at all.** Correlating behaviour with POS transactions is an *integration*: an
external event source joined on camera + time. It belongs with `services/events`, needs a POS
contract, and must not be allowed to pull retail semantics into the runtime.

### 9.5 Open-vocabulary detection

| | |
| --- | --- |
| Candidates | Grounding DINO (Apache-2.0) · Florence-2 (MIT) · OWLv2 |
| Value | ⭐ removes the 80-class ceiling. "A yellow holdall" is not a COCO class and never will be |
| Cost | large models, GPU-class latency — offline/investigation, not the live path |
| Fit | ⭐ **the strongest fit is search**, not detection: "find every frame containing a red rucksack" over stored footage |

⛔ **The honesty problem is the hard part.** An open-vocabulary model will answer *any* prompt with
*some* box and *some* score. A confidence from a prompted model is not comparable to a confidence
from a closed-set one, and presenting them in the same column would be the slice-2.10 defect in a new
form. Any open-vocabulary result must be labelled with its prompt and its provenance, and must never
be folded into a closed-set count.

---

## 10. Execution plan: CPU and GPU

```
                       ┌──────────────── live path (CPU, 4 fps, 87 ms budget) ───────────┐
  camera ──▶ media ──▶ │ detector (yolox-nano → YOLO11n)  ·  tracker  ·  behaviour      │
                       │ ⚠️ pose only if measured within budget, else sampled            │
                       └────────────────────────────────────────────────────────────────┘

                       ┌──────────── investigation path (GPU or batch, no budget) ───────┐
  stored footage ──▶   │ RT-DETR  ·  pose  ·  segmentation on demand  ·  re-ID  ·        │
                       │ open-vocabulary search                                          │
                       └────────────────────────────────────────────────────────────────┘
```

⭐ **Two profiles, one pipeline.** The offline path is `VideoAnalyzer`, which already exists, already
shares `ModelAdapter`, `ConfidencePostprocessor` and `NoopTracker` with the live path, and already
takes its own `AnalyzeOptions`. ⛔ It must stay the same code — a second inference path is how a
platform ends up with two answers to one question.

| profile | image | selector | fallback |
| --- | --- | --- | --- |
| CPU live | `vip/inference:local` today | `accelerator: cpu` | — |
| GPU | new build stage, `onnxruntime-gpu` + CUDA | `accelerator: cuda` | ⭐ **falls back to CPU and says so in `/status`** — never silently |

⚠️ **A GPU image is a deployment change with a real cost**: base image size, driver coupling, and a
CI that cannot test it without a GPU runner. That cost is worth stating before it is discovered.

---

## 11. Migration from YOLOX, and backward compatibility

⭐ **Nothing is removed.** `yolox-nano` stays `enabled` in the catalogue through the whole phase.

| guarantee | mechanism |
| --- | --- |
| A deployment that upgrades and changes nothing behaves identically | the manifest selects by task/family/version; unchanged manifest ⇒ unchanged model |
| Old analyses stay readable | ⭐ nothing derived is persisted (ADR-0054); reads recompute from track history |
| Old analyses are **not silently re-scored** | ⚠️ the model and floors that produced a run are stamped on the result. Two runs under different models are two measurements, and `association-replay.mjs` exists to show the difference |
| Rollback | flip `default` in the catalogue; no data migration, no schema change |
| Contracts | every new attribute optional; a consumer that ignores `pose` sees exactly today's payload |
| Rules | ⛔ a rule written against `carried` keeps working when `carried` gains a keypoint test. If it cannot, the primitive changed meaning and that is a breaking change requiring a new word, not a better implementation |

---

## 12. ⛔ Explainability, which is the real risk of Phase 3

Phase 2's central achievement is that every incident decomposes into geometric facts an operator can
check: *entered zone → stayed 27 s → object began travelling with them → crossed line → rule matched*.
Each step names a threshold, and each is falsifiable against the video.

**Every model in this document threatens that**, in a specific way:

| capability | the threat | the discipline |
| --- | --- | --- |
| Pose | "reached toward" sounds like intent | publish the keypoint, the distance and the threshold, as `PRIMITIVE_READINGS` already does |
| Segmentation | a mask is not human-checkable at a glance | keep the derived *fact* (who occluded whom), not the mask, in the chain |
| Re-ID | ⛔ "the same person" is a **probabilistic claim** presented as an identity | publish the similarity and the threshold; ⛔ never merge identities silently — ADR-0038 exists for this |
| Open-vocabulary | a prompted score is not a closed-set score | label with prompt + provenance; never mix the columns |
| Retail reasoning | the slide from "took an item" to "stole an item" | ADR-0052: the platform states observations; a rule an operator wrote states meaning |

⭐ **The test for every Phase 3 capability: can an operator disagree with it?** If a step in a WHY
chain cannot be checked against the video by a human, it does not belong in the chain — it belongs in
a diagnostic, like `lineDiagnostics` and `associationDiagnostic` before it.

---

## 13. Dependency graph

```
        3.0 durability blocker ⛔ BLOCKS EVERYTHING
                 │
                 ▼
        3.1 detector abstraction ──▶ 3.2 benchmark lab
                 │                        │
                 ├────────────────────────┤
                 ▼                        ▼
        3.3 YOLO11 (licence!) ◀── evidence ──▶ 3.4 RT-DETR on GPU
                 │                                    │
                 ▼                                    ▼
        3.5 pose ──────────────┬──────────▶ 3.7 open-vocabulary (offline search)
                 │             │
                 ▼             ▼
        3.6 hand–object   3.8 segmentation (deferred)
                 │             │
                 ▼             ▼
        3.9 shelf interaction  3.10 object permanence
                 │
                 ▼
        3.11 re-ID ⛔ needs a governance decision + ADR, independent of code
                 │
                 ▼
        3.12 checkout correlation (an integration, not perception)
```

⚠️ **Two items are gated by decisions, not by engineering:** YOLO11's AGPL licence, and re-ID's
biometric-processing status. Both should be raised now, because both can invalidate weeks of work
that has not started.

---

## 14. Success criteria

| # | criterion | how it is proved |
| --- | --- | --- |
| 1 | Durability blocker fixed | a run's subjects readable an hour later, byte-identical via `association-replay.mjs` |
| 2 | A new detector integrated with **zero** changes above `model_formats.py` | the diff |
| 3 | The benchmark lab can fail | a deliberately broken model is reported as broken |
| 4 | Per-class recall on the pinned corpus improves | ⭐ **> 9/30**, measured by `probe_classes.py`, floors recalibrated per model |
| 5 | Live path still meets 4 fps within budget | measured under `caffeinate`, p95 |
| 6 | `handover`, `dropped`, `object_missing` execute on real footage | ⚠️ needs the recording in `OBJECT_FOOTAGE.md` — a decision, not a model |
| 7 | Every new fact is falsifiable against the video | an operator can disagree with every step of a WHY chain |
| 8 | Gate 70/70 and boundary §A–§K green at every slice | unchanged from Phase 2 |
| 9 | Backward compatibility | a deployment that changes no configuration produces byte-identical reads |
| 10 | No new service, no new pipeline stage | §A and §C still pass without amendment |

---

## 15. What this document deliberately does not do

- ⛔ It authorises **no implementation**.
- ⛔ It does not choose YOLO11 over RT-DETR — § 3 exists so that choice is made by measurement.
- ⛔ It does not estimate accuracy gains from published mAP. Published figures are COCO; this
  platform's question is *"does it find a handbag in a shop"*, and only the corpus answers that.
- ⛔ It does not schedule. Slice ordering is a dependency argument, not a plan with dates.
- ⚠️ It contains two open decisions — **YOLO11's licence** and **re-ID's legal status** — that are
  the user's to make, and both should be made before § 3.3 or § 3.11 begins.
