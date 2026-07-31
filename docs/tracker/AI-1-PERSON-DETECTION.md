# AI-1 — Person Detection Pipeline + AI Playground

> **Milestone:** AI Processing Phase **AI-1** · **Status:** ✅ code + tests complete · ⏳ **Architect review pending**
> **Scope:** prove the **complete AI processing pipeline** end-to-end (MP4 → decode → sample →
> person detection → bounding boxes → `DetectionResult` → `EventEnvelope` → the existing spine),
> exercised by the **AI Playground**. Objective is the pipeline, not detection accuracy.
> Reference: [AI_EXECUTION_ARCHITECTURE](../architecture/future/AI_EXECUTION_ARCHITECTURE.md) · [ED-0036](../project/ENGINEERING_DECISION_LOG.md). **Author:** Claude · _2026-07-31_

---

## 1. What shipped (all in `ai/inference`, no new service)

Modular, independently-testable stages (flat modules, matching the runtime convention) that **reuse
every existing per-frame seam** (`ModelAdapter`, `ConfidencePostprocessor`, `NoopTracker`,
`DefaultResultTranslator`, `detections_to_events`, `EventSink`) — nothing re-implemented:

- [`video_frame`](../../ai/inference/video_frame.py) — immutable `Frame` + metadata (rec 3).
- [`video_decoder`](../../ai/inference/video_decoder.py) — `FrameDecoder` port; `StubFrameDecoder`
  (stdlib, deterministic), `OpenCvFrameDecoder` (real MP4, lazy `cv2`), `IterableFrameDecoder`.
- [`video_sampler`](../../ai/inference/video_sampler.py) — target-FPS/stride sampling + dropped-frame count.
- [`video_analyzer`](../../ai/inference/video_analyzer.py) — the modular orchestrator + **per-stage timings** (rec 6); keeps `DetectionResult` **AI-neutral** (rec 2).
- [`playground`](../../ai/inference/playground.py) + [`playground_cli`](../../ai/inference/playground_cli.py) — the engineering workbench (rec 2 & 8): HTTP `analyze_request` + the `playground-output/` artifact set.
- `POST /playground/analyze` on the runtime (internal-key + `x-tenant-id`).

## 2. Architect recommendations — where each landed

| #   | Recommendation                            | Where                                                                                                                                                 |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Completely modular pipeline (no monolith) | one file per stage; analyzer only composes them                                                                                                       |
| 2   | `DetectionResult` stays AI-neutral        | reuses the existing generic `Detection`/`DetectionResult` (label/confidence/bbox/classId/attributes/trackingId — no vendor fields); asserted in tests |
| 3   | Preserve original frame metadata          | `Frame.meta()` (frameIndex, timestamp, original/processed W×H, samplingRate, sourceVideo)                                                             |
| 4   | Annotated video output                    | CLI writes `original.mp4` + `annotated.mp4` (OpenCV) + `detections.json`/`events.json`                                                                |
| 5   | Playground configurable options           | `--model --engine --labels --confidence --iou --fps --resize --annotate --publish` (all optional, defaulted)                                          |
| 6   | Stage-level timings                       | `StageTimings` (decode/sampling/preprocess/inference/postprocess/eventGeneration) in `metrics.json`                                                   |
| 7   | Future-proof `ModelAdapter`               | unchanged G-3 `ModelAdapter`/`EngineRegistry` seam; stub default, onnx lazy; pipeline unaware                                                         |
| 8   | Playground as the engineering workbench   | the sole validation path for detectors; endpoint + CLI                                                                                                |
| +   | `playground-output/` artifact set         | `original.mp4 · annotated.mp4 · detections.json · events.json · metrics.json · summary.txt`                                                           |

## 3. Demonstrable outcome (validation checklist)

An engineer runs `python playground_cli.py --input clip.mp4 --annotate` (or `--synthetic N` with no
OpenCV) and gets: MP4 decoding ✓ · frame sampling ✓ · detection generation ✓ · bounding boxes ✓ ·
`DetectionResult` correctness ✓ · `EventEnvelope` generation ✓ (`perception.person.detected`) · event
publication ✓ (`--publish` → backbone → spine → **G-5 dashboard**) · playground endpoint ✓ · CLI output ✓
· deterministic tests ✓ · integration (HTTP round-trip) ✓ · metrics ✓ · documentation ✓.

Smoke (synthetic, deterministic): `6 frames → sampled 2 (stride 3, 4 dropped) → 2 person detections →
2 EventEnvelopes` + the 4 artifact documents.

## 4. Tests (deterministic, stdlib — no OpenCV/GPU/model)

| Suite                    | Count | Covers                                                                                                                                                 |
| ------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test_video_pipeline.py` |     9 | frame metadata, FPS/stride sampling + drops, analyzer → person detections + events, AI-neutral `DetectionResult`, per-stage timings, confidence gating |
| `test_playground.py`     |     6 | `analyze_request` (base64 + synthetic + confidence), `write_artifacts` (4 documents), HTTP round-trip (401/400/200 + events)                           |

**Python suite: 92 tests (77 + 15).** No new JS contract needed — generated events use the frozen
`EventEnvelope`; the stage-latency observability is an offline engineering artifact (not a live-session
wire contract). The additive `RuntimeMetrics`/`ModelRegistration` extensions land in **AI-2** when a
live inference session actually emits them (disciplined YAGNI; noted below).

## 5. Deliberate refinement vs the approved plan

The approved AI-1 plan mentioned extending `RuntimeMetrics`/`ModelRegistration` now. On build, that
proved premature: the playground is **offline** analysis, not a live session, so session-metric contract
fields have no emitter yet. Per the platform rule _"document the extension point, don't build ahead of
need,"_ AI-1 keeps the TS contracts untouched (events already use the frozen `EventEnvelope`) and defers
those additive extensions to **AI-2** (live sessions + tracking). Flagged for the Architect.

## 6. Definition of Done

- [x] Modular stages; reuse existing seams; runtime boundary held (events only, never incidents).
- [x] Deterministic-by-default (stub); real ONNX/OpenCV integration-only behind the adapter seam.
- [x] AI Playground endpoint + CLI + `playground-output/` artifacts; configurable options.
- [x] Python tests green (92); CLI smoke verified; no frozen doc (01–28) change; no new service.
- [ ] **Architect review of AI-1** ⏳ — then object tracking + zones (AI-2).
