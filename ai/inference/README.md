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

| Method | Path                   | Purpose                                            | Auth             |
| ------ | ---------------------- | -------------------------------------------------- | ---------------- |
| POST   | `/infer`               | run a capability over one frame → DetectionResult  | `x-internal-key` |
| GET    | `/capabilities`        | descriptors of all loaded capabilities (discovery) | —                |
| GET    | `/status`              | per-capability lifecycle state + metrics           | —                |
| GET    | `/metrics`             | Prometheus text                                    | —                |
| GET    | `/health` `/ready` `/` | liveness / readiness / info                        | —                |

## Backends

- **`stub`** (default) — deterministic, **dependency-free**; the whole runtime + tests run with no
  onnxruntime/model. Proves the pipeline end-to-end.
- **`onnx`** — real ONNX Runtime + MLflow model resolution. Needs `requirements.txt` and a model
  registered on the dev-stack MLflow. Selected via `INFERENCE_BACKEND=onnx`.

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
