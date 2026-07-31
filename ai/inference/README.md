# inference — AI Capability Runtime (Python)

The **Perception context** runtime (Phase 1, P1-6) — the first data-plane **AI** service. It runs a
model-**agnostic** capability over a frame and emits normalized detections, **without hardcoding any
model**. Built as a durable AI Runtime Platform: manifest-driven capabilities, a model-adapter
backend seam, a staged pipeline, lifecycle health, metrics, and full version provenance.

> Design: [phase1/AI_PIPELINE](../../docs/architecture/phase1/AI_PIPELINE.md) ·
> [05-CAPABILITY-ARCHITECTURE](../../docs/architecture/05-CAPABILITY-ARCHITECTURE.md) ·
> [08-AI-ML-PLATFORM](../../docs/architecture/08-AI-ML-PLATFORM.md); ADR-0002 (model-agnostic),
> ADR-0012 (adapter layer). Python (like [ai/mlops](../mlops/)); TS services live under `services/`.

## Architecture (Principal-Architect review, P1-6)

1. **Capability manifests** ([manifest.py](manifest.py), [manifests/](manifests/)) — every capability
   is a machine-readable manifest; the runtime **loads capabilities from manifests** ([registry.py](registry.py)),
   never hardcoded registrations. Zero-code registration, discovery, dynamic enable/disable,
   (later) tenant-specific sets.
2. **Model Adapter layer** ([pipeline.py](pipeline.py) `ModelAdapter`; [adapters/](adapters/)) — the
   runtime **never imports onnxruntime directly**. `FakeModelAdapter` (stub) and `OnnxModelAdapter`
   (real) sit behind one interface; TensorRT/OpenVINO/PyTorch/Triton drop in the same way.
3. **FrameContext** ([contracts.py](contracts.py)) — capabilities receive full request context
   (tenant/org/camera/stream/frame/timing/correlation), never a bare image.
4. **Model-independent detections** — `Detection` carries `bbox/label/confidence` + generic
   `attributes/embedding/metadata/trackingId`; no YOLO/vendor fields.
5. **Lifecycle health** — capabilities expose a state (`LOADING/READY/FAILED/DISABLED/UNAVAILABLE`),
   not a boolean (`GET /status`).
6. **Metrics from day one** ([metrics.py](metrics.py)) — latency, decode, frames processed/dropped,
   FPS, detection count, avg confidence, RSS/CPU (`GET /metrics`).
7. **Version metadata** — every result stamps runtime + capability + model version, execution
   provider, and timestamp (auditability/rollback).
8. **Staged pipeline** ([pipeline.py](pipeline.py)) — `preprocess → infer → postprocess → track →
translate → publish`; each stage is a replaceable Protocol (interfaces over inheritance).

**Fail-closed:** a frame without a tenant context is dropped (counted), never inferred. The
capability **persists no tenant data**; results flow onward as tenant-tagged events (P1-5).

## HTTP surface (internal, stdlib `http.server` — no FastAPI/uvicorn)

| Method                            | Path                               | Purpose                                            | Auth                             |
| --------------------------------- | ---------------------------------- | -------------------------------------------------- | -------------------------------- |
| POST                              | `/infer`                           | run a capability over one frame → DetectionResult  | `x-internal-key`                 |
| GET                               | `/capabilities`                    | descriptors of all loaded capabilities (discovery) | —                                |
| GET                               | `/status`                          | per-capability lifecycle state + metrics           | —                                |
| GET                               | `/metrics`                         | Prometheus text                                    | —                                |
| GET                               | `/health` `/ready` `/`             | liveness / readiness / info                        | —                                |
| **Model registry (P2-2 G-3)**     |                                    |                                                    | `x-internal-key` + `x-tenant-id` |
| GET                               | `/models`                          | list a tenant's models (`?capability=&status=`)    | internal-key + tenant            |
| POST                              | `/models`                          | register a model                                   | internal-key + tenant            |
| GET                               | `/models/:id`                      | get one model                                      | internal-key + tenant            |
| POST                              | `/models/:id/versions`             | append a version (`activate:true` to select)       | internal-key + tenant            |
| POST                              | `/models/:id/activate`             | set the active version                             | internal-key + tenant            |
| POST                              | `/models/:id/enable` \| `/disable` | enable/disable (enable needs an active version)    | internal-key + tenant            |
| **Inference sessions (P2-2 G-3)** |                                    |                                                    | `x-internal-key` + `x-tenant-id` |
| GET                               | `/sessions`                        | list sessions (`?cameraId=&state=`)                | internal-key + tenant            |
| POST                              | `/sessions`                        | start a session (created → starting → running)     | internal-key + tenant            |
| GET                               | `/sessions/:id`                    | get one session                                    | internal-key + tenant            |
| POST                              | `/sessions/:id/:action`            | `stop` \| `pause` \| `resume` \| `restart`         | internal-key + tenant            |

The control-plane routes are `x-internal-key`-gated (like `/infer`) and tenant-scoped via a trusted
`x-tenant-id` header — a tenant can never address another's models/sessions (cross-tenant → `404`).

## P2-2 G-3 — Inference platform (registry · sessions · metrics · events)

G-3 extends this runtime (no new service) with the control plane the console/rules drive, all
contract-first against `@vip/contracts` (the runtime mirrors the shapes; TS is the source of truth):

- **Model Registry** ([model_registry.py](model_registry.py)) — managed **models** (YOLOv11/12, Fire,
  Smoke, Face, Pose, PPE …) with **append-only versions**, an **active version** selection,
  **enable/disable** (enable requires an active version), free-form **metadata**, and a structured
  **capability profile** (supported event types + categories, input size, expected FPS, acceleration,
  confidence-threshold range) so rules/UI can _reason about_ a model instead of parsing its name.
  Tenant-scoped; distinct from the manifest-driven `CapabilityRegistry` (which loads capabilities).
- **Inference Sessions** ([sessions.py](sessions.py)) — the **first-class operational unit**: one
  running pipeline bound to a camera + capability + model version + engine, with a **7-state**
  lifecycle `created → starting → running → paused → stopped → failed → restarting`, a **heartbeat**,
  an immutable transition **history**, embedded **metrics**, and derived **health**
  (`healthy/degraded/down/unknown`). Drives start/stop/pause/resume/restart.
- **Runtime Metrics** ([metrics.py](metrics.py)) — FPS, frames processed/**skipped**/dropped,
  **avg + p50 + p95** latency, **queue depth**, **confidence distribution** (10 buckets), model-load
  time, CPU/**GPU**(best-effort)/memory, **uptime**. Deterministic (clock/monotonic injected) → fully
  unit-tested without hardware. Snapshot mirrors `@vip/contracts` `runtime-metrics`.
- **Event Generation** ([events.py](events.py)) — maps a `DetectionResult` → **`EventEnvelope`**
  objects (label → canonical type; generic fallback) and emits operational **`system.*`** events
  (camera/stream/recording/model/pipeline lifecycle) + `system.model.failed`. **Strict boundary
  (asserted in tests): the runtime NEVER creates incidents/alerts, never calls workflow, never makes
  business decisions** — its responsibility ends at publishing an EventEnvelope. Meaning is assigned
  by the Rule Engine / Workflow (P1-7/P1-8).
- **Engine abstraction** ([engines.py](engines.py)) — an `EngineRegistry` maps every engine name
  (`yolo | onnx | tensorrt | openvino | torchscript | python-custom`) to an adapter factory. YOLO is
  **not** special-cased; a new engine registers a factory without touching capability/pipeline code.

**Canonical event catalog** lives in `@vip/contracts/events` (modular: `event-types.ts` · `schema.ts`
· `catalog.ts` · `validation.ts`) — the single source of truth for the Inference Runtime, Rule
Engine, Dashboard, Alerts, Incidents, and future clients.

**Extension points (config, not architecture):** multi-model / ensembles (multiple enabled models per
capability), camera-specific models (rules select by capability + camera), edge/cloud placement
(`engine` + deployment config), model rollback / A/B (activate a prior/alternate version), GPU
scheduling (accelerator on the version + capability profile) — all additive, no API break.

## Backends

- **`stub`** (default) — deterministic, **dependency-free**; the whole runtime + tests run with no
  onnxruntime/model. Proves the pipeline end-to-end.
- **`onnx`** — real ONNX Runtime + MLflow model resolution. Needs `requirements.txt` and a model
  registered on the dev-stack MLflow. Selected via `INFERENCE_BACKEND=onnx`.

## Video pipeline + AI Playground (AI-1)

The first AI-processing slice: turn a **video** into detections + `EventEnvelope`s through modular,
independently-testable stages that reuse the per-frame seams above. Reference:
[AI_EXECUTION_ARCHITECTURE](../../docs/architecture/future/AI_EXECUTION_ARCHITECTURE.md).

```
Video Source → Frame Decoder → Frame Sampler → [ preprocess → infer → postprocess → track → translate ]
             → DetectionResult → Event Generator → EventEnvelope → (spine → incident → evidence → G-5 dashboard)
```

- **Stages** (flat modules, one responsibility each): [`video_frame`](video_frame.py) (immutable frame
  metadata), [`video_decoder`](video_decoder.py) (`StubFrameDecoder` stdlib-deterministic ·
  `OpenCvFrameDecoder` real MP4, lazy `cv2` · `IterableFrameDecoder`), [`video_sampler`](video_sampler.py)
  (target-FPS/stride + dropped-frame count), [`video_analyzer`](video_analyzer.py) (composes the stages,
  records **per-stage timings**, keeps `DetectionResult` AI-neutral).
- **AI Playground** — the engineering workbench; validate a model before it enters customer workflows:
  - `POST /playground/analyze` (internal-key + `x-tenant-id`) — analyze base64 frames → detections +
    events + stage metrics. Deterministic (stub backend), no OpenCV.
  - `python playground_cli.py --input clip.mp4 --annotate --output playground-output/` — writes
    `original.mp4 · annotated.mp4 · detections.json · events.json · metrics.json · summary.txt`. Options
    (all optional): `--model --engine --labels --confidence --iou --fps --resize --publish`. Real MP4 +
    annotation need OpenCV (`requirements.txt`); `--synthetic N` runs with no OpenCV. `--publish` routes
    events onto the backbone so they flow through the existing spine → the G-5 dashboard.

**Boundary held:** the pipeline emits **only `EventEnvelope`s** (person → `perception.person.detected`),
never incidents/alerts. Deterministic-by-default (stub); real ONNX/YOLO is integration-only behind the
same `ModelAdapter` seam.

## Configuration (env, `.env` only — ADR-0018)

`HOST`, `PORT` (8085), `LOG_LEVEL`, `INTERNAL_API_KEY` (≥16), `INFERENCE_BACKEND` (`stub`|`onnx`),
`INFERENCE_MANIFESTS_DIR`, `MLFLOW_TRACKING_URI`, `MLFLOW_S3_ENDPOINT_URL` (onnx backend).

## Run / test

```bash
python -m unittest discover -s ai/inference/tests -p 'test_*.py'   # stdlib-only; no pip install
python ai/inference/app.py                                          # stub backend (default)
# real backend:
python -m pip install -r ai/inference/requirements.txt
INFERENCE_BACKEND=onnx python ai/inference/app.py
```
