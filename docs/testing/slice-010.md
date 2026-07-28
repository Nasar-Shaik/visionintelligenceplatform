# Slice 10 — P1-6 AI inference (capability runtime)

> **Manually executable by the Product Owner.** Proves the model-agnostic AI runtime: a frame in →
> a normalized detection out, the capability self-describes, the model is bound by selector, health
> is a lifecycle state, metrics are collected, and a frame without tenant context is dropped
> fail-closed. Automated by the `ai/inference` stdlib unittest suite (38 tests) + the TS perception
> contracts. The default `stub` backend needs no model/onnxruntime; the `onnx` backend is separate.

## Prerequisites

```bash
export INTERNAL_API_KEY='change_me_dev_only_min_16_chars'
export PORT=8085
python ai/inference/app.py            # stub backend (default); no pip install needed
B64=$(python -c "import base64;print(base64.b64encode(b'a-fake-jpeg-frame').decode())")
```

## Scenario A — Discovery & self-description (#1 manifests)

| Step | Action              | Expected                                                          |
| ---- | ------------------- | ----------------------------------------------------------------- |
| A1   | `GET /capabilities` | lists `perception.person-detection` with its CapabilityDescriptor |
| A2   | `GET /ready`        | `200` (default capability `READY`)                                |
| A3   | `GET /status`       | capability `state: "READY"`, model provenance, metrics            |

## Scenario B — Inference (a frame → a detection)

`POST /infer` with `x-internal-key` and body
`{"context":{"tenantId":"tnt_a","principalId":"u1"},"frame":{"cameraId":"cam_1","seq":7,"capturedAt":"2026-07-28T00:00:00.000Z","correlationId":"corr_9"},"imageBase64":"$B64"}`

| Step | Action                          | Expected                                                                                                                     |
| ---- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| B1   | `POST /infer` (with key)        | `200`; a `DetectionResult`: `detections[0]` has `label`, `confidence∈[0,1]`, 4-tuple `bbox`                                  |
| B2   | inspect the result's provenance | `capabilityVersion`, `runtimeVersion`, `executionProvider:"stub"`, `model{name,version,task}`, `correlationId:"corr_9"` (#7) |
| B3   | inspect a detection's shape     | generic fields present: `attributes`, `metadata` (no YOLO-specific fields) (#4)                                              |

## Scenario C — Authorization & fail-closed (#3)

| Step | Action                                                    | Expected                               |
| ---- | --------------------------------------------------------- | -------------------------------------- |
| C1   | `POST /infer` with **no** `x-internal-key`                | `401`                                  |
| C2   | `POST /infer` (with key) but **no** `context`             | `400 context_required` (frame dropped) |
| C3   | `GET /status` after C2                                    | `metrics.framesDropped` increased      |
| C4   | `POST /infer` for `capabilityId:"perception.nonexistent"` | `404`                                  |

## Scenario D — Model-agnostic binding (#2) & metrics (#6)

| Step | Action                                                             | Expected                                                                           |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| D1   | `GET /status` → note `model` (resolved by selector, not hardcoded) | a registry model whose `task` matches the manifest selector                        |
| D2   | `GET /metrics`                                                     | Prometheus series: frames processed/dropped, avg confidence, latency, FPS, RSS/CPU |

## Scenario E — Real ONNX backend (optional, integration)

```bash
python -m pip install -r ai/inference/requirements.txt   # onnxruntime + mlflow + numpy + pillow
# register an ONNX object-detection model on the dev-stack MLflow with tags {task,family,accelerators,labels}
INFERENCE_BACKEND=onnx python ai/inference/app.py
```

| Step | Action                    | Expected                                                        |
| ---- | ------------------------- | --------------------------------------------------------------- |
| E1   | `GET /status`             | `executionProvider: "CPUExecutionProvider"`, model from MLflow  |
| E2   | `POST /infer` with a JPEG | real detections (same generic `Detection` contract as the stub) |

## Pass criteria

- **B1–B3** — a frame yields a normalized, model-independent, fully version-stamped detection.
- **C1/C2** — unauthenticated is `401`; a frame without tenant context is dropped `400` (fail-closed).
- **D1** — the model is resolved by selector from the registry (swap the model = registry change, no code).

> Automated equivalent: `python -m unittest discover -s ai/inference/tests -p 'test_*.py'` (38 tests,
> stdlib-only) + `pnpm --filter @vip/contracts test`.
