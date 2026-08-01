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

### Tracking + Zones + Counting (AI-2)

Continuous object identity + spatial analytics, added after detection — **optimized for the Track
contract, not the tracker** (any engine is swappable behind the association boundary):

```
Detection → [TrackerAdapter: associate] → [TrackManager: lifecycle] → Zone Engine → Counting Engine → EventEnvelope
```

- **[`tracker`](tracker.py)** — `TrackerAdapter` does **association only** (`Association` = indices +
  scores); `IouAssociator` default. ByteTrack/BoT-SORT/DeepSORT/OC-SORT/custom drop in here with no
  downstream change.
- **[`track_manager`](track_manager.py)** — owns the **Track lifecycle** (created→tentative→confirmed→
  lost→removed), store/lookup, cleanup, **bounded history**, **trackId policy** (unique per
  tenant→camera→session, never reused), and observability stats.
- **[`zones`](zones.py)** — pure geometry (point-in-polygon, line-crossing); **[`counting`](counting.py)**
  — business-neutral entry/exit + occupancy over **confirmed tracks only**; **[`coordinates`](coordinates.py)**
  — `CoordinateTransform` seam (identity now; homography/calibration later).
- Emits `spatial.zone.entered|exited` + `analytics.occupancy.changed` (event confidence from track
  quality). Playground adds **`tracks.json`** (Track Replay: lifecycle + history + transitions) and
  `--zones/--session/--diagnostics`. See [AI-2-TRACKING](../../docs/tracker/AI-2-TRACKING.md).

### Behavior Analysis (AI-3)

Behavioral intelligence over the tracks — **optimized for the BehaviorResult contract, not the
behavior** (any analyzer is swappable; a heuristic today, an ML/LLM reasoner tomorrow):

```
Track → [BehaviorAnalyzer(s) via Registry] → BehaviorResult → [BehaviorResultTranslator] → EventEnvelope
```

- **[`behavior`](behavior.py)** — the `BehaviorAnalyzer` seam, the immutable `BehaviorContext` (the ONLY
  input analyzers see), and the `BehaviorLifecycleStore` (started→updated→ongoing→ended→expired, stable
  ids, correlation, cooldown). Analyzers are **stateless** and never call one another.
- **[`temporal_window`](temporal_window.py)** — the ONE reusable timing primitive (dwell, queue average,
  every future timed behavior); **[`behavior_registry`](behavior_registry.py)** — discover / enable /
  disable / configure + orchestrate, with per-analyzer metrics.
- **[`behaviors/`](behaviors/)** — loitering · queue · intrusion · **fire/smoke** (detector-independent,
  reads labels only). Zone opt-in via generic `attributes` flags; thresholds are detection sensitivity,
  not business rules.
- **[`behavior_translator`](behavior_translator.py)** — the single `BehaviorResult → EventEnvelope`
  bridge; analyzers never emit envelopes. Emits `behavior.loitering.detected`, `analytics.queue.length`,
  `security.intrusion.detected`, `perception.fire.detected|smoke.detected`. Playground adds
  **`behaviors_timeline.json`** (Behavior Replay) + `--no-behaviors/--loiter-seconds/--queue-min` and
  behavior overlays. See [AI-3-BEHAVIOR](../../docs/tracker/AI-3-BEHAVIOR.md).

### Composite Behaviors + Profiles (AI-4)

The fifth platform contract — **configurable customer solutions from generic contracts** (retail is a
profile, not code):

```
BehaviorResult → [CompositeBehaviorAnalyzer(s) via CompositeRegistry] → CompositeBehavior → Translator → EventEnvelope
```

- **[`composite`](composite.py)** — `CompositeBehaviorAnalyzer` consumes ONLY `BehaviorResult`s (a
  `CompositeContext` of active behaviors + a zone-role map; never Tracks/Detections/zones). The generic
  **`RuleCompositeAnalyzer`** evaluates a declarative co-occurrence rule (required types + zone role +
  dwell) — customers define composites in **config, not code**. Confidence strategy is replaceable
  (`min/max/mean/weighted`).
- **[`composite_registry`](composite_registry.py)** — orchestrates the deterministic second pass,
  **rejects circular composite graphs** (`validate_acyclic`), and records match/miss/latency metrics.
- **[`profiles`](profiles.py)** — `BehaviorProfile` is the **portable** deployment mechanism (generic
  zone roles + config, no tenant/camera/zone ids) with **fail-fast validation**. The retail pilot is
  **[`profiles/retail.json`](profiles/retail.json)** — the 4-camera layout as pure configuration.
- **[`behaviors/crowd`](behaviors/crowd.py)** + **[`behaviors/occupancy`](behaviors/occupancy.py)** —
  new generic primitives. Playground: composite graph + dependency graph + execution order in
  `behaviors_timeline.json`; `--profile <name>` / `--no-composites`. See
  [AI-4-COMPOSITE](../../docs/tracker/AI-4-COMPOSITE.md).

### Benchmark Harness (AI-5a — Production Readiness)

**Operational** measurement of the frozen v1.0 runtime (adds no capability, changes no perception
contract) — the platform's official performance baseline:

- **[`benchmark`](benchmark.py)** — pure, unit-tested KPI math (`percentile`, `evaluate_budget`,
  `build_report`) + `run_benchmark` over the real pipeline (stub adapter + synthetic frames,
  deterministic; real cameras/GPU are AI-5b+). **Warm-up is separated from measurement**; multi-camera
  workloads (1/4/8) aggregate. Mirrors [`@vip/contracts/benchmark`](../../packages/contracts/src/benchmark/benchmark.ts).
- **[`benchmarks/budgets.json`](benchmarks/budgets.json)** — per-deployment-class budgets/SLOs
  (dev-laptop · mini-pc-i5 · rtx-desktop · edge-device). Verdicts are `pass/warning/fail/na`
  (informational). **[`benchmark_cli.py`](benchmark_cli.py)**: `--deployment <class> --suite` writes the
  5-file bundle (`benchmark.json · summary.txt · runtime_metrics.json · environment.json ·
configuration.json`) and exits non-zero on a FAIL. Governance:
  [PRODUCTION_KPIS](../../docs/architecture/future/PRODUCTION_KPIS.md), [AI-5a-BENCHMARK](../../docs/tracker/AI-5a-BENCHMARK.md).

### Live Ingestion & Multi-Camera Sessions (AI-5b — Production Readiness)

Turns the runtime from **offline/batch** into **continuous streaming**. Five tiers with strictly
non-overlapping ownership (Architect refinement 2) — each module's header restates its own boundary:

```
StreamSource  →  StreamPipeline  →  VideoAnalyzer  →  SessionRunner  →  SessionSupervisor
connection       queue                AI processing     orchestration     capacity · fleet
reconnect        frame lifecycle      only              only              shutdown
acquisition      drop policy
```

- **[`stream_source`](stream_source.py)** — `StreamSource` is a **transport-neutral Protocol**: RTSP is
  only the first implementation, and the runtime dispatches on the **declared type, never by sniffing
  the URI**, so HTTP/USB/file/WebRTC/ONVIF/cloud plug in with no runtime change. `ConnectionSupervisor`
  owns the lifecycle (`idle→connecting→connected→lost→reconnecting→stopped|failed`), **deterministic
  bounded-exponential backoff**, reconnect count, availability % and recovery time. Budget exhaustion is
  **reported operationally, never raised**. `redact_uri` strips credentials from every stat/log/error.
  `SimulatedStreamSource` + `FaultPlan` make loss/recovery ordinary unit tests — no camera, no network.
- **[`stream_pipeline`](stream_pipeline.py)** — `BoundedFrameQueue` (`drop-oldest` default, `drop-newest`
  available) + backpressure metrics (`queueHighWatermark`/`queueUtilization`/`averageQueueDepth`/
  `processingDelayMs`). **Sampling (`framesSkipped`) is execution policy; queue overflow
  (`framesDropped`) is the only real degradation** — never conflated.
- **[`session_runner`](session_runner.py)** — `SessionRunner` binds one session to one pipeline and does
  exactly five things (**read · execute · heartbeat · metrics · lifecycle**), finally producing the
  heartbeats G-3 defined. `SessionSupervisor` owns capacity (**409 rather than degrading everyone**),
  tenant-scoped lookup, fleet stats and shutdown. Sessions carry a **logical identity**
  `(tenantId, cameraId, sessionId[, correlationId])` — never a thread or process id.
- **[`operational_log`](operational_log.py)** — every reconnect, recovery and failure is a structured
  record correlated with that identity, carrying the failure **category · code · recovery path**.
- **Failure taxonomy** ([`errors`](errors.py)) — five mutually exclusive categories:
  `connection`/`AI-CONN`/reconnect · `model`/`AI-MODEL`/rebind · `inference`/`AI-INFER`/skip-frame ·
  `pipeline`/`AI-PIPE`/skip-frame · `configuration`/`AI-CONFIG`/**operator (never retried)**.
- **HTTP (additive)** — `POST /sessions` with an optional `source` (omit ⇒ exact G-3 behavior),
  `GET /sessions/{id}/metrics`, `GET /sessions/{id}/stream`, `GET /supervisor`. Benchmarks:
  `benchmark_cli.py --live`. See [AI-5b-LIVE-INGESTION](../../docs/tracker/AI-5b-LIVE-INGESTION.md).

### Scheduling & Resource Management (AI-5c — Production Readiness)

**Stage 4** of the reference architecture (always specified; implemented here, not invented). AI-5b
protected a session from its own camera; AI-5c protects sessions **from each other**.

- **[`compute`](compute.py)** — `ComputeResource` describes capacity in **abstract, dimensionless
  units** (never cores or VRAM), so `cpu`/`cuda`/`tensorrt`/`openvino`/`metal`/`tpu`/`npu` are registry
  entries rather than scheduler branches. Ids are **node-qualified** (`node-a/cuda:0`) so a future
  distributed scheduler adds resources instead of a redesign. `ComputeRegistry` holds back a
  **reservation** (default 10%) that only `critical` work may draw on — a runtime at 100% committed
  cannot recover from its own success. `ResourceMonitor` samples process CPU/RSS with the stdlib only.
- **[`scheduler`](scheduler.py)** — `AdmissionController` estimates a session's cost and **refuses**
  what cannot be served safely, with a typed reason (`session-capacity`/`compute-capacity`/
  `reserve-protected`/`no-compatible-resource`). `InferenceScheduler` chooses whose frame runs next:
  **weighted-fair** (default), `round-robin`, or `strict-priority` — all bounded by
  `maxConsecutivePerSession`, so **starvation is structurally impossible**. `ResourceGovernor` walks
  the ordered ladder `none → reduced-fps → reduced-resolution → reduced-behaviors → shedding-frames →
suspended`, with **hysteresis** both ways, a per-deployment **ceiling**, and **predictive**
  triggering from a queue-utilization trend. Every action is a recorded `SchedulerDecision`
  (identity · action · typed reason · triggering measurement).
- **[`resources`](resources.py)** — per-session accounting (CPU/memory/GPU **attributed** from measured
  work and documented as estimates) + `SessionSla` (target vs actual FPS/latency, `met`, attainment %).
- **[`deployment`](deployment.py)** + **[`profiles/deployment/`](profiles/deployment/)** — seven
  portable operational profiles (retail · warehouse · office · school · hospital · factory · parking)
  with fail-fast validation. Distinct from the AI-4 `BehaviorProfile`: that configures _what to detect_,
  this configures _how hard to work_. `resolve_stream_settings` **reads declared `CameraCapabilities`**
  (fps range, stream profiles, ONVIF) instead of probing the device.
- **[`scheduler_sim`](scheduler_sim.py)** — deterministic 4/8/16/32-camera load simulation driving the
  **real** scheduler; byte-identical across runs. It is what caught the fleet-wide suspension collapse.
- **HTTP (additive)** — `GET /scheduler`, `GET /sla`, `GET /resources` (tenant-scoped).
- **Benchmark evidence gate** — `benchmark_cli.py --baseline <benchmark.json>` compares against a prior
  run and **exits non-zero on regression**. See [AI-5c-SCHEDULING](../../docs/tracker/AI-5c-SCHEDULING.md).

## Configuration (env, `.env` only — ADR-0018)

`HOST`, `PORT` (8085), `LOG_LEVEL`, `INTERNAL_API_KEY` (≥16), `INFERENCE_BACKEND` (`stub`|`onnx`),
`INFERENCE_MANIFESTS_DIR`, `MLFLOW_TRACKING_URI`, `MLFLOW_S3_ENDPOINT_URL` (onnx backend).

Live ingestion (AI-5b; all validated fail-fast at startup): `INFERENCE_MAX_SESSIONS` (8),
`INFERENCE_STREAM_QUEUE_SIZE` (32), `INFERENCE_STREAM_DROP_POLICY` (`drop-oldest`|`drop-newest`),
`INFERENCE_STREAM_TARGET_FPS` (5), `INFERENCE_RECONNECT_MAX_ATTEMPTS` (10, `0` = never reconnect),
`INFERENCE_RECONNECT_BASE_MS` (500), `INFERENCE_RECONNECT_MAX_MS` (30000).

Scheduling (AI-5c): `INFERENCE_DEPLOYMENT_PROFILE` (empty = env settings above; otherwise one of
`retail|warehouse|office|school|hospital|factory|parking`, which supplies FPS, queue size, max
sessions, priority, scheduler policy and degradation ceiling as configuration).

## Run / test

```bash
python -m unittest discover -s ai/inference/tests -p 'test_*.py'   # stdlib-only; no pip install
python ai/inference/app.py                                          # stub backend (default)
# real backend:
python -m pip install -r ai/inference/requirements.txt
INFERENCE_BACKEND=onnx python ai/inference/app.py
```
