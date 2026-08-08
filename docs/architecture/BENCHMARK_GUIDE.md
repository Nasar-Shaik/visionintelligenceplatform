# Benchmark Guide

**How to run the detector benchmark, how to add a detector to it, and how to read what comes out.**
The architecture is in [BENCHMARK_FRAMEWORK](BENCHMARK_FRAMEWORK.md).

---

## 1. Before you run: is the host quiet?

⛔ **This is the first step, not a caveat.** Latency, FPS and CPU are properties of the machine as
much as of the detector. Measured on 2026-08-08 while VS Code's renderer alone was consuming
**496 % CPU** — five of ten cores — any timing taken then describes an editor.

```bash
uptime                                   # load average should be near idle
ps -A -o %cpu,command -r | head -5       # nothing large above the benchmark
pgrep -f "tools/validation/soak.mjs"     # ⛔ never benchmark during a release soak
```

⚠️ **Never run a benchmark and a soak on one host.** Each contends with the other and both results
become fiction — the soak reports latency that is really the benchmark, and the benchmark reports
throughput that is really the soak. Run the benchmark, then the soak; not both.

If the host cannot be quiet, run anyway and set `hostContended` in the environment block. The report
then opens with a refusal to let the timing columns be quoted, and the counts — detections, tracks,
events — remain valid because they do not depend on how busy the machine was.

## 2. Running

⚠️ **The CLI runner is not yet written**, and this section describes the shape it must take. The
framework it drives — `detector_benchmark.py` — is complete and tested; what remains is the ~60 lines
that walk the `ModelStore` and the `DatasetLibrary` and call `run_matrix`.

```python
from detector_benchmark import PinnedModelAdapter, model_ref, run_matrix, summarise, render_summary

adapter = PinnedModelAdapter(OnnxModelAdapter(), model_ref(entry, artifact_dir, labels))
analyzer = VideoAnalyzer(adapter, options)      # ⭐ the runtime, unmodified
```

⭐ **`PinnedModelAdapter` is why no runtime change is needed.** `VideoAnalyzer.__init__` calls
`adapter.load({"labels": …})` unconditionally — correct for production, where the backend resolves
its own model from the store, and fatal for a benchmark that must run a *named* detector. The pin
merges the caller's labels into the ref it already holds, so the analyzer's own call loads the model
the benchmark chose. The runtime is untouched.

⛔ **One thing the runner must not do: re-implement `analyze_case`.** The decode → sample → analyse
sequence lives in `evaluation.py` and is the same one the playground and live runtime use; a
benchmark that grew its own copy would drift from production and its results would describe the
copy. The runner composes that path with a pinned adapter — it does not fork it.

Outputs, always together:

| File | What it is |
| --- | --- |
| `benchmark-matrix.json` | ⭐ **Raw evidence** — every cell, every status, the environment block |
| `BENCHMARK_SUMMARY.md` | Generated from that JSON by `render_summary()`, never transcribed by hand |

⭐ **Store the JSON beside every report.** A table nobody can recompute is a table nobody can check;
this is the same rule the P-9 validation runs follow.

## 3. Adding a detector

**A catalogue entry. That is the whole procedure.**

```jsonc
{
  "id": "yolo12s", "family": "yolo12", "engine": "onnx", "outputFormat": "yolo12",
  "artifact": "yolo12s.onnx", "sha256": "…", "license": "…",
  "input":  { "width": 640, "height": 640, "resize": "letterbox", … },
  "outputParams": { "numClasses": 80, … },
  "labels": [ "person", … ]
}
```

Then, **only if its tensor layout is genuinely new**, one function in
`adapters/model_formats.py` and one `register_decoder()` call. Nothing in
`detector_benchmark.py` changes — a test asserts that (`test_adding_a_detector_needs_no_change_to_this_module`).

⚠️ **Use the canonical COCO-80 label strings.** RT-DETR's own config ships VOC spellings at identical
indices (`motorbike`, `sofa`, `tvmonitor`); a benchmark that compared label *strings* across
detectors would report six spurious disagreements. See [MODEL_PLUGIN_GUIDE](MODEL_PLUGIN_GUIDE.md).

## 4. Reading a result

| Column | Read it as | ⚠️ Do not read it as |
| --- | --- | --- |
| Det/frame | How much this detector reports | Accuracy. More may be people or may be coat racks |
| Tracks | Distinct identities the tracker created | People. A person re-entering creates a new track (ADR-0038) |
| Reassign | `trackingId` changes within one `identityId` | A MOTA ID switch — there is no ground truth here |
| Events | What the runtime published | Incidents. Events are deduplicated (L-57) |
| Inference / FPS / RSS | Cost **on this host, at this moment** | A customer's hardware |

⛔ **A detector with better numbers on every column has not been shown to be better.** Without
ground truth, this framework measures *cost and behaviour*, not *correctness*. Promotion to
production runs through the lifecycle in [MODEL_REGISTRY](MODEL_REGISTRY.md), which requires a human
decision recording which results justified it.

## 5. The corpus

Every detector runs the **same** cases — enforced structurally, since `run_matrix` iterates the same
case list per model and `summarise()` refuses to aggregate over divergent sets.

**Existing:** `ai/datasets/` — 18 scenario categories (person_detection, tracking, queue, crowd,
loitering, shoplifting, ppe, fall_detection, violence, …), each case digest-verified so a swapped
clip is an error rather than a different result.

⛔ **The scene taxonomy specified in [DATASET_STRATEGY](DATASET_STRATEGY.md) — supermarket,
warehouse, office, classroom, hospital, parking, entrance, corridor, outdoor, low light, crowd,
empty scene, occlusion, rotated camera, portrait phone, landscape CCTV — is NOT populated.** The
footage does not exist and cannot be conjured; P-9's corpus is 28 authored scenarios plus a handful
of real clips. Two axes are involved and they are not the same question:

- **behaviour** — what should happen in this clip (the existing `category`)
- **scene** — where it was shot and under what optics (the strategy's taxonomy)

A clip is both. Adding the scene axis is an additive field on a case; **acquiring the footage is the
actual work**, and no framework change substitutes for it.

## 6. Regression use

The framework's permanent job is the question *"did this get better or worse?"*. Run it on the same
corpus version before and after any model change, and compare the JSON. ⚠️ **A benchmark result
without its corpus version is unusable in the most dangerous way** — it looks comparable. A harder
corpus lowers every model's numbers, and a table mixing versions reads as a regression that did not
happen.
