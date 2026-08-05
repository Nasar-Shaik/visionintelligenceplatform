# ADR-0037 — A model-agnostic runtime with registry-driven model loading

- **Status:** Accepted
- **Date:** 2026-08-05
- **Milestone:** P-8 Phase 3 (real inference) + Phase 3H (production hardening)
- **Supersedes / amends:** none — makes [ADR-0002](ADR-0002-model-agnostic-capability-runtime.md)
  enforceable and gives it a production implementation
- **Related:** [ADR-0012](ADR-0012-adapter-layer.md) (adapter layer),
  [ADR-0018](ADR-0018-env-only-secrets-and-centralized-config.md) (env-only config)

## Context

ADR-0002 declared the perception runtime **model-agnostic**. Until P-8 Phase 3 that was a claim
about code shape, checked by review, with no deployment behind it: the runtime shipped a `stub`
backend that fabricated a detection for any bytes, and the real `onnx` path resolved models through
**MLflow** — a tracking server plus S3, both dev-stack services.

Making inference real forced four decisions that had been deferred, and one of them was not
technical.

### The model that everyone reaches for is licence-incompatible

Ultralytics YOLOv8/v11 is the obvious detector: small, fast, excellent on people, everywhere in the
literature. It is **AGPL-3.0**. Shipping it in a commercial CCTV product means either releasing the
platform under AGPL or buying an enterprise licence, and neither is a decision an engineer makes
while wiring a backend.

### Resolving models through MLflow puts a dev service on the production critical path

A container that must reach a tracking server at start to learn which model to run has two failure
modes it should not have — the server being down, and the server's contents changing underneath a
running deployment. It also means the model a container runs is **not a property of its build**,
which is exactly the property gate 0 exists to protect for every other byte in the image.

### The first real adapter was already family-specific

`OnnxModelAdapter` hard-coded a 640×640 stretch, `/255` normalisation and one assumed output row
layout. All three were wrong for the model the platform actually registers, and none of them would
have been caught by review — they are plausible defaults that happen to describe a different model.

### "Model-agnostic" had no failing test

Nothing in CI could distinguish a runtime that was model-agnostic from one that had YOLO knowledge
spread through five services.

## Decision

**1. The runtime knows nothing about model families. Everything model-specific is data.**

`ai/inference/models/registry.json` is the catalogue. Each entry carries the artifact and its
`sha256`, how a frame becomes a tensor (`input`: size, layout, dtype, colour order, resize policy,
pad value, normalisation), how a tensor becomes detections (`outputFormat` + `outputParams`), the
label space, and the licence. `model_store.py` reads it; `adapters/model_formats.py` holds one
generic `preprocess` driven entirely by the spec, plus a **decoder registry keyed by
`outputFormat`**. Adding a family is a catalogue entry and — only if its tensor layout is genuinely
new — one function.

**2. Production resolves models from the image, not from MLflow.**

`INFERENCE_MODEL_SOURCE=local` is the default. Artifacts are fetched at **build** time by
`fetch_models.py`, verified against the catalogue's `sha256`, and verified **again at process
start** — "a file is present" and "the file we registered is present" are different claims, and a
truncated download answers only the first. MLflow remains available (`=mlflow`) as the authoring
path. The serving image installs `requirements-runtime.txt`, which deliberately excludes MLflow and
boto3.

**3. Licence is a selection criterion, recorded per model.**

Every catalogue entry carries `license` and `licenseHolder`, and a test asserts both are present.
The registered model is **YOLOX-nano (Apache-2.0, Megvii)**. YOLOv11n was declined on licence
grounds and the finding was raised to the Architect before any code depended on it.

**4. One model family is deployed at a time.**

The catalogue supports many and the selector resolves among them; this deployment registers one. A
second family (SSD-MobileNetV1, a `tf-object-detection` head) was implemented and **measured
end-to-end through this same unchanged runtime** — which is the evidence the seam is real — and then
removed, because a decoder no shipped artifact exercises is surface a serving container carries for
nobody.

**5. `DetectionResult` is the only contract downstream, and that is now a gate.**

`tools/contracts/perception-boundary.mjs` runs in `pnpm verify:contracts` and fails the build if:
the runtime is called from more than one file; any service other than media knows where the runtime
lives; any TypeScript source outside `ai/` **names** a model-implementation concept (`yolox`,
`letterbox`, `nms`, `anchors`, `NCHW`, `intraOp`, …) as an identifier; or the detection-result parse
reads a field the frozen schema does not declare.

⚠️ It strips comments and string literals first. The first version was a plain grep and produced
four hits, every one of them correct code — a test fixture _value_ asserting an id passes through
opaquely, two comment examples, and `video-player-container.tsx` using "letterboxes" about video
display. A gate that fires on all of those is one everybody learns to skip.

**6. Every `DetectionResult` carries what it takes to reproduce it.**

`schemaVersion`, `model.id` + `model.version`, `executionProvider`, `preprocessingVersion`,
`confidenceThreshold`, `inferenceMs`, `frameLatencyMs` and the frame's `capturedAt`. The
preprocessing fingerprint (`1.0/letterbox-416x416-NCHW-float32-BGR-pad114`) is an implementation
version plus the resolved input spec: without it, identical weights on an identical frame can give
different detections and no other field on the document would show why.

Detection identity is **derived**, never random: `sha256(tenant | camera | capturedAt | seq | model |
index)`. Including the model was found by running — seeded on frame identity alone, one id meant
"the person on the left" under one model and "the car on the right" under another. Geometry and
score are deliberately **excluded** from the seed: they are floats from a numeric kernel, and an id
that shifts because a different CPU produced a different last bit is not stable.

## Consequences

**Good.** A container's model set is a property of its build and is checksum-verified twice. Swapping
models is a catalogue change. Model-agnosticism is enforced by CI rather than asserted in a document.
Results are reproducible — measured at **zero** confidence variance across twenty runs of the same
frame. The licence position is recorded where an auditor will look.

**Costs.** The serving image is 479 MB (from 205 MB) — onnxruntime, numpy, pillow and a 3.6 MB
artifact. Model artifacts are fetched at build time, so a build needs network access to GitHub
Releases; the checksum makes that reproducible rather than merely convenient. The catalogue is a
second registry alongside the in-memory `ModelRegistry` control plane (P2-2 G-3), which remains the
tenant-scoped management surface — they are not yet unified, and that is recorded as debt.

**Not decided here.** Accuracy. Nothing in this ADR establishes how _well_ a registered model works:
there is no labelled corpus, no mAP, no FP/FN promotion gate (TD-64). The platform may say inference
runs; it may not say how well it works.
