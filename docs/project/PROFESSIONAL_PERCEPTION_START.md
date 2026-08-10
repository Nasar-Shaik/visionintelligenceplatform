# Professional Perception — start gate

**Date:** 2026-08-10 · **Branch:** `feature/v1` · **Phase 2 closed at** `430d974`

Sections 2–7 of the required output are the sections of this document; the Re-ID governance decision
is separate, at `docs/adr/ADR-0055-reidentification-governance.md`.

> ⛔ **Three audit findings change this plan before it starts.** They are stated first because each
> one moves work that the phase order otherwise assumes is ready.

| | Finding | Consequence |
| --- | --- | --- |
| **1** | The benchmark lab is **not greenfield** — `detector_benchmark.py` already implements the model × case matrix | P3.1 is *completion and wiring*, not a build |
| **2** | RT-DETR has **already been benchmarked** against YOLOX through the production code path (`DETECTOR_COMPARISON.md`, 2026-08-08) | Much of P3.2's RT-DETR question is answered |
| **3** | ⛔ **31 of 38 corpus clips are authored (synthetic). There is no real video of real people at all.** | **P3.2 cannot produce a trustworthy verdict.** Footage is the critical path, not models |

---

## 1. Current baseline

| | |
| --- | --- |
| Detector | `yolox-nano` 1.0.0 |
| Input | 416×416, letterbox, BGR, NCHW |
| Execution | CPU · ONNX Runtime 1.19.2 · `CPUExecutionProvider` |
| Measured | **41.16 ms/frame** inference · 46.09 ms total · **21.7 fps** single stream · 79.5 MiB peak RSS |
| Artifact | 3.66 MB · Apache-2.0 · sha256 `c789161e…` · COCO 2017 |
| Capability | 80 COCO classes · boxes · confidence · tracking · identity · object association |

⛔ **The detector is the accuracy ceiling.** Measured, not asserted: a confidence floor tuned for
`person` (which scores up to 0.919) zeroed four of five carriable classes for three milestones, and
the true-positive maximum for `backpack` across a 42-image CC0 corpus was **0.2151**. Object recall
is 9 of 30 photographs chosen *because* they contain a carried object.

⭐ **Everything above perception is already capable of consuming more.** The behaviour layer, graph,
reasoning engine, WHY chains, evidence model and console are frozen, verified, and model-agnostic —
`perception-boundary.mjs` §A–§L proves nothing outside `ai/` names a model concept. The vocabulary is
already larger than the detector can feed: `dropped`, `objectMissing`, `objectReturned` and
`handover` are implemented, deployed, and have **never had real input**.

---

## 2. Detector benchmark plan (P3.1)

### What already exists

| Component | State |
| --- | --- |
| `ai/inference/detector_benchmark.py` | ⭐ **384 lines, complete matrix logic** — dense model × case, `status` per row, `summarise()` **refuses** to aggregate models whose completed case sets differ |
| `PinnedModelAdapter` | selects a catalogue entry by building the ref `ModelAdapter.load()` already takes — no detector-specific code |
| `ai/mlops/compare_detectors.py` | two-model harness calling the **production** `preprocess()` / `get_decoder()` |
| Decoders | `yolox`, `rtdetr`, **`yolo11`** all registered |
| `models/registry.json` | licence, checksum, size, provenance, input spec, label space per model |

### What is missing — the actual P3.1 work

1. ⛔ **No runner.** `detector_benchmark.py` is imported by its tests and by nothing else. Nothing
   drives the matrix over a corpus end to end.
2. ⛔ **No corpus binding.** There is no declared set of benchmark cases, so "the same footage" is a
   promise nothing enforces.
3. ⛔ **No ground truth anywhere.** Therefore **no precision, no recall, no mAP** may be reported —
   only counts, distributions and cost.
4. **No report artifact.** No `DETECTOR_BENCHMARK.md` equivalent generated from a matrix run.

### The controls that make a comparison honest

Same footage · same `preprocess()` · same decoder registry · same confidence evaluation · same
container (`vip/inference:local`) · same host · same output schema. ⭐ These are not new
disciplines — they are the ones `compare_detectors.py` already enforces by calling the production
functions rather than reimplementing them.

⚠️ **Warm-up is discarded and said out loud.** The existing comparison discarded 3 of 40 frames;
session load alone is 24.1 ms for YOLOX and 279.9 ms for RT-DETR, so a benchmark that included it
would be measuring the loader.

---

## 3. Dataset / coverage matrix

**Audited 2026-08-10** from `infra/docker/fixtures/media/validation/manifest.json` (38 clips) and
`docs/validation/object-corpus.json` (42 images).

| Class | Count | What it is |
| --- | ---: | --- |
| **A. Authored fixtures** | **31** | Synthetic, rendered. 27 are 640×360 @ 15 fps |
| **B. Real phone footage** | **0** | ⛔ none |
| **C. Real-world photographs** | **42 stills** + 1 derived clip | CC0/PD, `object-corpus.json`; `carried-objects.mp4` is a pan over them |
| **D. Retail-like scenarios** | **0 real** | `retail-loitering.mp4`, `queue-formation.mp4` are authored |
| **E. Negative controls** | 1 clip + authored fixture | `empty-scene.mp4`; the photographic negative control was **withdrawn** as invalid (real crowd photos contain real bags) |
| Damaged-file fixtures | 6 | Transport/corruption tests, not perception |

### Required-scenario coverage

⚠️ **`AUTHORED` is not a pass.** A rendered shape is not a person, and a detector benchmarked on one
measures rasterisation, not perception.

| Scenario | State | Scenario | State |
| --- | --- | --- | --- |
| single person | AUTHORED | small objects | PARTIAL (stills only) |
| multiple people | AUTHORED | bottle / cup | PARTIAL (stills only) |
| crowded scene | AUTHORED | backpack / handbag / suitcase | PARTIAL (stills only) |
| partial occlusion | AUTHORED | person carrying object | PARTIAL (1 derived clip) |
| person at different distances | ⛔ **PENDING FOOTAGE** | two people interacting | ⛔ **PENDING FOOTAGE** |
| side-facing person | ⛔ **PENDING FOOTAGE** | object handover | ⛔ **PENDING FOOTAGE** |
| rear-facing person | ⛔ **PENDING FOOTAGE** | person hidden behind shelf | ⛔ **PENDING FOOTAGE** |
| top-down camera | AUTHORED (`angle-overhead`) | poor lighting | AUTHORED (`night-footage`) |
| low-angle camera | AUTHORED (`angle-wide`) | backlighting | ⛔ **PENDING FOOTAGE** |
| motion blur | AUTHORED (`blur`) | portrait video | ⛔ **PENDING FOOTAGE** |
| 4K video | ⛔ **PENDING FOOTAGE** (max is 1080p) | CCTV-like low resolution | AUTHORED (`res-180p`) |

**Score: 0 of 25 scenarios covered by real footage.** 13 authored, 4 partial, **8 with nothing at
all**.

⛔ **This is the phase's critical path.** A YOLOX-vs-YOLO11-vs-RT-DETR verdict computed on this
corpus would be precise, reproducible, and about the wrong thing.

---

## 4. Model candidate matrix

| Model | Task | Registered | Artifact obtained | Measured here | Verdict |
| --- | --- | --- | --- | --- | --- |
| **yolox-nano** | detection | ✓ enabled, default | ✓ sha256 pinned | ✓ 41.16 ms · 21.7 fps | ⭐ **permanent baseline** |
| **rtdetr-r18vd** | detection | ✓ **disabled** | ✓ sha256 pinned, self-exported | ✓ 944 ms · 1.05 fps · +27 % people | GPU / offline-batch candidate |
| **YOLO11** | detection | ⛔ **no entry** | ⛔ **never obtained** | ✗ | blocked on licence — § 5 |
| RF-DETR / D-FINE / YOLOv10 | detection | ✗ | ✗ | ✗ | Apache-2.0 alternatives to survey in P3.2 |
| RTMPose / MoveNet / ViTPose | pose | ✗ | ✗ | ✗ | P3.3 — design only |
| SAM2 | segmentation | ✗ | ✗ | ✗ | ⚠️ **not automatically selected** — § 9 of the phase brief |
| OSNet / CLIP-ReID | re-ID | ✗ | ✗ | ✗ | ⛔ blocked on ADR-0055 |
| GroundingDINO / Florence-2 | open-vocab | ✗ | ✗ | ✗ | P3.6 — must clear a real retail need first |

⚠️ **A decoder exists for `yolo11` and no catalogue entry does.** That asymmetry is deliberate and
documented in `models/registry.json`: the entry's most important field cannot be filled honestly,
because the artifact has never been obtained, so its `sha256` is unknown. **No checksum will be
invented.**

---

## 5. Licensing matrix

| Model | Licence | Holder | Commercial multi-tenant SaaS? |
| --- | --- | --- | --- |
| yolox-nano | **Apache-2.0** | Megvii, Inc. | ✓ yes |
| rtdetr-r18vd | **Apache-2.0** | Baidu / lyuwenyu | ✓ yes |
| **YOLO11 (Ultralytics)** | **AGPL-3.0** | Ultralytics | ⛔ **NO** — see below |
| SAM2 | Apache-2.0 (weights CC-BY-NC in some variants) | Meta | ⚠️ **verify per artifact** |
| GroundingDINO | Apache-2.0 | IDEA Research | ✓ likely — verify artifact |
| Florence-2 | MIT | Microsoft | ✓ likely — verify artifact |

### ⛔ The YOLO11 decision, already taken and recorded

AGPL-3.0 **section 13** obliges anyone who *makes the software available over a network* to offer
users the complete corresponding source of the combined work. VIP is a commercial, multi-tenant,
network-served platform. It cannot satisfy that clause without publishing the platform.

**Therefore:** VIP ships neither YOLO11 weights nor any means of fetching them. The decoder exists so
that **a licensee who holds an Ultralytics commercial licence** can supply their own artifact and add
a catalogue entry — the path recorded in `MODEL_PLUGIN_GUIDE.md`.

⚠️ **"Open source" ≠ "commercially unrestricted."** This is a product-licensing decision, not an
engineering one, and it is not reopened by benchmark results: a model that wins on every metric is
still unusable if the licence forbids the deployment. ⭐ Benchmarking YOLO11 **is** permitted — a
licensee's evaluation, on a licensee's artifact, is exactly what the decoder is for.

**Every candidate must carry before adoption:** licence · model source · artifact provenance ·
sha256 (obtained, never invented) · intended usage · deployment implications.

---

## 6. Phase 3 acceptance criteria

A perception change is accepted only when **all** hold:

1. ⭐ **It improved VIP, not merely ran.** A measured behaviour-layer improvement — more true
   associations, better recall on a named class, fewer identity fragmentations — not a detector
   metric alone.
2. **`yolox-nano` remains registered, enabled, and the comparison baseline.** No model silently
   replaces it.
3. **Same-code-path measurement**: production `preprocess()` and `get_decoder()`, inside the built
   image, on the same footage and host.
4. **No precision/recall claimed without ground truth.** Counts, distributions and cost only,
   otherwise.
5. **`PENDING FOOTAGE` where footage is missing** — never `PASS`.
6. **Zero changes above `adapters/model_formats.py`.** A new model that needs a branch outside the
   decoder means the plugin seam failed, and the branch is the evidence.
7. **Behaviour engine stays model-agnostic**; `perception-boundary.mjs` §A–§L green.
8. **Gate 70/70 · contracts · browser · deployment**, verified on built images.
9. **Licence, provenance and checksum recorded** before an artifact is registered.
10. **A consumer exists in the platform** before a model is added. A segmentation mask nothing reads
    is surface without a customer.

---

## 7. The first implementation slice — P3.1, exactly

**P3.1 Detector Benchmark Lab.** Nothing else. No YOLO11, no RT-DETR enablement, no pose, no
segmentation, no Re-ID, no theft detection.

| # | Deliverable | Detail |
| --- | --- | --- |
| 1 | **Benchmark case corpus** | a declared, versioned set of cases binding clip → scenario, so "the same footage" is enforced rather than promised |
| 2 | **Runner** | drives `detector_benchmark.py`'s existing matrix over the corpus inside the built image; every model runs every case; a skip is a recorded row |
| 3 | **`yolox-nano` baseline run** | the reference every future model is compared against |
| 4 | **`rtdetr-r18vd` matrix run** | it is registered and checksum-pinned; running it proves the lab handles two families and two input specs |
| 5 | **Report generator** | `docs/validation/DETECTOR_BENCHMARK.md` from matrix output — measured numbers only |
| 6 | **Coverage report** | what the corpus can and cannot answer, `PENDING FOOTAGE` by scenario |
| 7 | **Regression tests + gates** | 70/70, contracts, boundary, deployment verification |

⛔ **P3.1 will not produce a detector recommendation, and must not be read as one.** With 0 of 25
scenarios covered by real footage, the lab's first honest output is *a measurement of what the corpus
cannot tell us*. Building the instrument and acquiring the footage are independent, and the
instrument is the part that is buildable today.

### Recommended in parallel — footage acquisition

⚠️ Not a code task, and the phase's real critical path. Priority order, chosen by what unblocks the
most: **person carrying an object** (unblocks 4 dormant primitives) → **object handover** → **two
people interacting** → **partial occlusion behind a shelf** → **distance / side / rear-facing** →
**backlighting, portrait, 4K, real CCTV low-res**.

---

## 8. Pose — design now, implement after P3.1/P3.2

⚠️ **Design only.** No pose code until the detector benchmark has been reviewed.

```
Detection (person box) → Pose model → Keypoints → Skeleton → Temporal smoothing → Behaviour primitives
```

**Keypoints:** head · shoulders · elbows · wrists · hips · knees · ankles, each with **confidence**
and **visibility** — ⛔ and those are two different facts, exactly as `zones_settled` is not
`zone_ids`. "The wrist is at (x, y) with confidence 0.2" and "the wrist is occluded" are different
answers, and collapsing them would put a fabricated limb position into a reasoning chain.

**Temporal stability** is a first-class requirement, not a polish item: a skeleton that jitters
between frames turns "reached toward the shelf" into an event that fires continuously. Smoothing is
part of the design, and its parameters travel with the observation like every other threshold.

⛔ **Pose produces observations. Behaviour interprets. Reasoning decides meaning.** The pose layer
will emit `wristAboveShoulder`, `torsoAngle`, `handNearObject` — geometric facts with thresholds
attached. It will **never** emit `concealing`, `stealing` or `suspicious`. Words that name an intent
belong to Layer 3, with evidence, and putting one here would move reasoning into perception in the
component an investigator reads as neutral — the failure
[ADR-0052](../adr/ADR-0052-behaviour-reasoning-is-not-perception.md) exists to prevent.

The eventual vocabulary — reaching, bending, crouching, falling, hand position, body orientation,
object interaction — must each pass the hospital test the timeline vocabulary already passes: a
hospital, a warehouse, a school and a factory can all use the word under their own name.

⚠️ **Candidates are unmeasured.** RTMPose, MoveNet and ViTPose are listed in § 4 as *candidates*; no
artifact has been obtained, no latency measured. Pose on CPU alongside detection inside an 87 ms
live budget is an open question, not an assumption.

---

## 9. Carry-forward from Evidence Integrity

⚠️ Not reopened; tracked in `WORKTRACK.md` and non-blocking for P3.1.

| Item | Why it is still open |
| --- | --- |
| `fsync` / power-loss durability | `write()` returns at the kernel, not the platter |
| Production retention observation | the 72 h horizon has never elapsed under observation |
| Cancelled-run real-footage validation | every cancelled run so far detected nothing before stopping |
| Host-reboot validation | needs the developer machine restarted |
