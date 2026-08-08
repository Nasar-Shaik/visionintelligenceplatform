# Detector Comparison — P-10 Workstream A2

**2026-08-08.** Two detectors, the same 40 frames, the same preprocessing code, the same decoder
registry, the same output contract. Measured inside the deployed inference image
(`vip/inference:local`, onnxruntime 1.19.2, `CPUExecutionProvider`, 10-core host, no GPU).

> ⭐ **Nothing here re-implements the pipeline.** `ai/mlops/compare_detectors.py` calls
> `model_formats.preprocess()` and whatever `get_decoder()` returns for each catalogue entry — the
> same two functions the ONNX adapter calls in production. A harness that could disagree with the
> runtime would be measuring itself.

---

## 1. Verdict

| | |
| --- | --- |
| ⭐ **The plugin seam holds** | Two families, two output layouts, two coordinate conventions, two resize policies — **zero changes above `adapters/model_formats.py`**. No pipeline change, no second inference path, no code outside the decoder knows which detector ran |
| ⭐ **RT-DETR detects strictly more people** | 33 vs 26 person detections over the same 40 frames, and **never fewer in any frame** |
| ⛔ **RT-DETR is 22.9× slower on CPU** | 944 ms vs 41 ms per frame. At **1.05 fps** it cannot serve the live path, which needs 4 fps inside an 87 ms end-to-end budget |
| **Recommendation** | **Keep `yolox-nano` as the CPU default.** RT-DETR is a GPU / offline-batch candidate, and is registered `disabled` |

---

## 2. Measured

40 frames, 3 discarded as warm-up, confidence floor 0.30 for the counts.

| | yolox-nano | rtdetr-r18vd |
| --- | ---: | ---: |
| Licence | Apache-2.0 | Apache-2.0 |
| Artifact | 3.66 MB | 81.06 MB |
| Input | 416×416 letterbox | 640×640 stretch |
| Session load | 24.1 ms | 279.9 ms |
| Preprocess | 3.58 ms | 5.56 ms |
| **Inference avg** | **41.16 ms** | **944.12 ms** |
| Inference p95 | 49.38 ms | 1129.43 ms |
| Decode | 1.36 ms | 0.73 ms |
| **Total per frame** | **46.09 ms** | **950.41 ms** |
| **FPS, single stream** | **21.7** | **1.05** |
| Peak RSS | 79.5 MiB | 335.8 MiB |
| Person detections | 26 | 33 |
| Frames containing a person | 26 / 40 | 31 / 40 |
| People per frame | 0.65 | 0.825 |
| Mean top-person score | 0.849 | 0.794 |

⚠️ **The two are not compared at equal input size**, deliberately. Each runs the configuration its
authors published — 416 letterbox for YOLOX-nano, 640 stretch for RT-DETR — because that is what the
weights were trained for and what a deployment would actually run. A same-size comparison would
measure a configuration neither model ships.

⭐ **The decode step is not the cost.** 1.36 ms and 0.73 ms against 41 ms and 944 ms of inference —
so the choice of decoder, and the NMS inside it, is irrelevant to throughput. RT-DETR's decode is
*faster* despite producing more detections, because it runs no suppression at all.

---

## 3. ⭐ Do they agree? — the check that verifies the decoder

| | |
| --- | ---: |
| Frames where both report the same number of people | **35 / 40** |
| Frames within one | 38 / 40 |
| Frames where RT-DETR found more | 5 |
| Frames where YOLOX found more | **0** |
| Person boxes compared | 26 |
| **Matched at IoU ≥ 0.5** | **26 / 26 (100 %)** |
| **Mean best IoU** | **0.95** |
| Median best IoU | 0.96 |

⛔ **Counting agreement alone would have been the wrong check.** A decoder with a broken coordinate
transform returns the *right number* of boxes in the wrong places, and "35 of 40 frames agree" reads
as a verified decoder. The localisation figure is what actually verifies it: two independently
trained models, different architectures, different input sizes, and coordinate conventions that share
no code path — grid-stride offsets in tensor pixels versus normalized `cxcywh` — landing on the same
person to a mean IoU of **0.95**. That cannot happen by accident, and no single-model test can
produce it.

It verifies, together: `decode_rtdetr`'s `cxcywh`→corners maths, the normalized→input-pixel scaling,
`to_source_bbox` in `stretch` mode, and the RT-DETR preprocessing spec.

⚠️ **RT-DETR never finding fewer is a directional signal, not an accuracy result.** It is consistent
with a stronger model (RT-DETR-R18 reports COCO AP ≈ 46.5 against YOLOX-nano's ≈ 25.8 upstream), but
these 40 frames are **unlabelled**, so nothing here says whether the 7 extra detections were people.

---

## 4. ⛔ Precision and recall are NOT in this report

They need the annotated corpus specified in
[DATASET_STRATEGY](../architecture/DATASET_STRATEGY.md), which does not exist yet. Quoting an
accuracy number computed from unlabelled frames — however plausible the arithmetic — is precisely the
failure this project has now documented seven times in its own instruments.

**Expectations, clearly labelled as upstream claims and not VIP measurements:**

| | COCO AP (authors' figures) | Params |
| --- | ---: | ---: |
| yolox-nano | 25.8 | 0.9 M |
| rtdetr-r18vd | 46.5 | 20 M |

⚠️ Those are measured on COCO val2017 by their authors, on full-resolution images, on GPUs. They are
a reason to *run the benchmark*, not a substitute for it. Workstream B builds that benchmark; this
report is what A2 can honestly claim without it.

---

## 5. Accelerator compatibility

⚠️ **ONNX / CPU is the only path measured.** TensorRT and OpenVINO were **not tested** — no such
hardware or runtime is present. What follows is the **operator inventory of the actual graphs**,
which is the factual input to that question, not an answer to it.

| | yolox-nano | rtdetr-r18vd |
| --- | ---: | ---: |
| Opset | 11 | 17 |
| Graph nodes | 369 | 1783 |
| **Distinct operators** | **10** | **44** |
| Ops present | `Conv` `Sigmoid` `Mul` `Concat` `Slice` `Add` `MaxPool` `Reshape` `Resize` `Transpose` | the above plus `GridSample`×9, `ScatterND`×12, `Einsum`×2, `TopK`, `LayerNormalization`, `GatherElements`, `ConstantOfShape`, … |

| | ONNX Runtime CPU | TensorRT | OpenVINO |
| --- | --- | --- | --- |
| **yolox-nano** | ✅ **verified, 41 ms** | Not tested — ten ordinary conv-net ops at opset 11, no known problem operators | Not tested — same |
| **rtdetr-r18vd** | ✅ **verified, 944 ms** | Not tested — ⚠️ **`GridSample` (deformable attention) is the operator to check first**, along with `ScatterND` and `Einsum`; these are the ops that historically need a recent TensorRT or a plugin | Not tested — ⚠️ same three operators |

⭐ **The op inventory is worth more than a guess about compatibility**, because it names exactly which
nine nodes would need attention rather than asserting a yes/no nobody measured.

⚠️ **The exported graph is fixed at 640×640, batch 1.** The export emitted `TracerWarning`s where
anchor generation was folded to constants — correct for the shape it was traced at, and the reason
that shape is pinned in the catalogue rather than left dynamic.

---

## 6. Deployment recommendations

| Scenario | Detector | Why |
| --- | --- | --- |
| **Live capture, CPU** (today's product) | **yolox-nano** | The only one that fits. P-9 measured 87 ms end-to-end at 4 fps; RT-DETR alone is 944 ms |
| **Offline / batch investigation, CPU** | yolox-nano; RT-DETR if recall matters more than turnaround | At 1.05 fps a 30-second clip at 4 fps takes ~2 minutes of compute |
| **GPU deployment** | Re-benchmark both — ⛔ **do not extrapolate** | The 22.9× CPU gap will not hold on a GPU; RT-DETR is designed for one and YOLOX-nano is designed for the absence of one |
| **Edge / low-power** | yolox-nano | 3.66 MB and 79.5 MiB RSS against 81 MB and 335.8 MiB |

⛔ **Neither number in this report licenses a production change.** `yolox-nano` remains the default
and the only `enabled` entry; RT-DETR is registered `disabled` with a real checksum, so it can be
benchmarked and promoted through the lifecycle in [MODEL_REGISTRY](../architecture/MODEL_REGISTRY.md)
rather than switched on by an opinion.

---

## 7. Licensing — a selection criterion, not paperwork

| Detector | Licence | Status in VIP |
| --- | --- | --- |
| **yolox-nano** | Apache-2.0 (Megvii) | Shipped, enabled, default |
| **rtdetr-r18vd** | Apache-2.0 (RT-DETR authors) | Registered, **disabled**, artifact exported by VIP |
| **YOLO11** | ⛔ **AGPL-3.0 (Ultralytics)** | **Decoder only. No catalogue entry, no artifact, never fetched** |

⛔ **YOLO11 is implemented but not registered, and the reason is worth stating precisely.** AGPL-3.0
§13 obliges anyone who lets users interact with the software **over a network** to offer those users
the complete corresponding source of the combined work. A commercial multi-tenant SaaS platform
cannot do that. Verified from Ultralytics' own `LICENSE` file, not from recollection.

⚠️ **No catalogue entry was written for it**, and that is a deliberate refusal rather than an
omission: the entry's most important field is `sha256`, VIP has never obtained the artifact, and an
invented checksum would defeat the only check that makes the catalogue worth having. `decode_yolo11`
is real, unit-tested code so a customer holding an Ultralytics Enterprise licence can supply the
weights and add the entry; MODEL_PLUGIN_GUIDE records its exact shape.

**RT-DETR's artifact is exported by VIP** (`ai/mlops/export_rtdetr_onnx.py`) from the authors'
Apache-2.0 PyTorch weights, because the only ready-made ONNX conversion of that model declares **no
licence of its own**. Apache-2.0 permits derivative works, so the conversion is clean and the
provenance is entirely ours: a script, a named source model, and a sha256 the runtime re-verifies at
start.

---

## 8. Verification matrix — every claim, and what could have falsified it

⚠️ Recorded here rather than in [`review/p6/VERIFICATION_MATRIX`](../review/p6/VERIFICATION_MATRIX.md),
which is the frozen P-6.5 inventory and should not be rewritten by a later milestone.

| # | Claim | How it was verified | ⭐ Could it have failed? |
| --- | --- | --- | --- |
| 1 | RT-DETR's artifact is the one we exported | sha256 recomputed against the catalogue before every run | Yes — a rebuilt export produces a different digest, and the run refuses it |
| 2 | The decoder maps boxes to the right place | **Cross-model localisation**: mean best IoU 0.95, 26/26 at IoU ≥ 0.5 vs YOLOX | Yes — a wrong scale or a missed `stretch` mode drives mean IoU toward 0 while counts stay plausible |
| 3 | Scores are sigmoid, not softmax | Unit test with hand-built logits (`_logit(0.9)` → 0.9) | Yes — softmax returns ≈0.5 for the same fixture |
| 4 | Output tensors cannot be swapped by export order | Decode run twice with the outputs reversed; identical results | Yes — positional reads return 300 fictional detections |
| 5 | YOLO11's transposed layout is caught | Decode with `layout: channels-last` + declared `numClasses` raises | Yes — without the declared count it silently returns 84 detections |
| 6 | No objectness column is consumed on YOLO11 | Score equals the class score exactly | Yes — multiplying by column 4 uses `cx` as a probability |
| 7 | RT-DETR runs no NMS | Two 90 %-overlapping queries both survive | Yes — suppression drops one |
| 8 | Every registered detector shares one label space | Catalogue test comparing all label lists position by position | **It did fail** — RT-DETR's own config carries six VOC spellings; the catalogue now normalises them |
| 9 | Every catalogue `outputFormat` has a decoder | Test walks the shipped catalogue through `get_decoder()` | Yes — a typo'd format raises here instead of at the first frame in production |
| 10 | Every artifact declares a licence and a provenance | Test requires an https source **or** `exportedBy` + `sourceModel`, and that the named script exists on disk | **It did fail** — the self-exported entry had no https source; the invariant was widened to the stronger claim, not weakened |
| 11 | The shipped detector is unchanged | YOLOX preprocessing + decoder tests untouched and green; `yolox-nano` still the only enabled entry | Yes |
| 12 | The numpy tests actually ran | Full suite executed **inside the image**: 1113 tests, **0 skipped** (50 skip locally) | Yes — that is the count the check exists to catch |

⛔ **Two of these checks failed when first run, and both failures were real** — the label-space
divergence and the provenance invariant. A verification matrix where nothing ever went red is a
matrix nobody has tested.

---

## 9. Reproducing

```bash
# 1 — export the artifact (one-off; torch is not in the serving image)
docker run --rm -v "$PWD/ai/mlops:/work:ro" -v "$PWD/out:/out" python:3.12-slim bash -c \
  "pip install -q torch --index-url https://download.pytorch.org/whl/cpu && \
   pip install -q transformers onnx && python /work/export_rtdetr_onnx.py --out /out"

# 2 — compare, inside the image, on identical frames
docker run --rm -v "$PWD/ai:/app/ai:ro" -v "$PWD/out:/models:ro" -v "<frames>:/frames:ro" \
  -v "$PWD/out:/out" vip/inference:local \
  python /app/ai/mlops/compare_detectors.py --frames /frames --models /models --out /out/comparison.json
```

Raw output: [`livecam-runs/detector-comparison.json`](livecam-runs/detector-comparison.json).

⚠️ **One 10-core laptop, CPU only, 40 authored frames, single stream.** A baseline to compare future
runs against — not a statement about a customer's hardware.
