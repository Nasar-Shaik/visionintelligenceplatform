# AI-5b — RTSP Live Ingestion & Multi-Camera Session Management

> **Milestone:** Production Readiness **AI-5b** (second slice of AI-5) · **Status:** ✅ code + tests complete, ⏳ awaiting Architect review
> **Scope:** turn the runtime from **offline/batch** into **continuous streaming** — a transport-neutral
> live source with connection lifecycle + reconnect, a bounded-queue streaming pipeline, and N
> concurrent camera sessions actually driven by the G-3 state machine.
> **In `ai/inference`, no new service; no change to the five frozen v1.0 contracts.**
> **North star (Architect):** _measure every improvement against the accepted AI-5a baseline._
> Reference: [AI_EXECUTION_ARCHITECTURE](../architecture/future/AI_EXECUTION_ARCHITECTURE.md) · [ED-0041](../project/ENGINEERING_DECISION_LOG.md). **Author:** Claude · _2026-07-31_

---

## 1. The gap AI-5b closes

G-3 delivered a session **control plane with nothing behind it**: a 7-state machine and a
`heartbeat()` endpoint that no running pipeline ever called. Meanwhile `VideoAnalyzer.analyze()`
materialized `list(decoder.decode())` — a finite source, one camera, synchronous.

A live camera is different **in kind**: it is unbounded, it disconnects, and it must recover. AI-5b
supplies the data plane that makes the control plane real, and does it without inventing a new
architectural layer.

| Before AI-5b                           | After AI-5b                                                     |
| -------------------------------------- | --------------------------------------------------------------- |
| Finite source materialized into a list | Unbounded source streamed frame-by-frame                        |
| One camera per analysis call           | N concurrent sessions, bounded by capacity                      |
| No connection concept                  | Lifecycle + bounded-backoff reconnect + availability accounting |
| `heartbeat()` with no producer         | Every analyzed frame heartbeats with live `RuntimeMetrics`      |
| Unbounded memory on a long run         | Bounded queue + explicit drop policy + bounded analyzer state   |
| One error type                         | Five mutually exclusive failure categories with recovery paths  |

## 2. Ownership — the five tiers (Architect refinement 2)

Strictly non-overlapping. Each module's header states its own boundary, and the tests assert them.

```
StreamSource      owns  connection · reconnect · frame acquisition     stream_source.py
      ↓
StreamPipeline    owns  queue · frame lifecycle · drop policy          stream_pipeline.py
      ↓
VideoAnalyzer     owns  AI processing only                             video_analyzer.py
      ↓
SessionRunner     owns  orchestration only                             session_runner.py
      ↓
SessionSupervisor owns  capacity · fleet · shutdown                    session_runner.py
      ↓
SessionManager    owns  session STATE (G-3, unchanged)                 sessions.py
```

`SessionRunner` does exactly five things — **read · execute · heartbeat · metrics · lifecycle** — and a
test asserts its public surface contains nothing perception-shaped.

## 3. What AI-5b delivers

- **Video Source stage** ([stream_source.py](../../ai/inference/stream_source.py)) — `StreamSource` is a
  **transport-neutral Protocol**; the runtime dispatches on **declared type, never by sniffing the URI**,
  so HTTP/USB/file/WebRTC/ONVIF/cloud need no runtime change. `ConnectionSupervisor` owns the lifecycle
  (`idle→connecting→connected→lost→reconnecting→stopped|failed`), a **deterministic bounded-exponential
  backoff**, reconnect counting, availability %, and recovery time. Budget exhaustion is **reported
  operationally, never raised** — ingestion degradation must not crash a runtime. Credentials are
  stripped by `redact_uri` before reaching any stat, log, or error.
- **Streaming pipeline** ([stream_pipeline.py](../../ai/inference/stream_pipeline.py)) — `BoundedFrameQueue`
  with `drop-oldest` (default; live perception values recency) or `drop-newest`. Producer (`offer`) and
  consumer (`process_next`) are separate operations, so overflow is tested exactly, without threads.
- **`analyze_frame` extraction** ([video_analyzer.py](../../ai/inference/video_analyzer.py)) — ONE per-frame
  path shared by batch and live; batch `analyze()` is now a loop over it plus a terminal `flush()`.
  **Behavior-identical**, guarded by the pre-existing 167-test suite and by a direct streaming≡batch
  equivalence test.
- **Multi-camera sessions** ([session_runner.py](../../ai/inference/session_runner.py)) — `SessionRunner`
  binds one session to one pipeline and produces the heartbeats G-3 defined; `SessionSupervisor` owns
  capacity (**409 rather than degrading everyone**), tenant-scoped lookup, fleet stats, and shutdown.
- **HTTP (additive)** — `POST /sessions` with an optional `source` (omit it ⇒ exact G-3 behavior),
  `GET /sessions/{id}/metrics`, `GET /sessions/{id}/stream`, `GET /supervisor`.
- **Contracts (+9 → 79 schemas)** — operational only; the frozen five are untouched.
- **Live benchmark workloads** — `live-single-camera` · `live-multi-camera` · `continuous-execution` ·
  `reconnect-recovery`, run via `benchmark_cli.py --live`, plus config/hardware fingerprints.

## 4. Two kinds of frame loss — never conflated

The distinction the Architect endorsed in AI-5a, now enforced structurally:

| Signal          | Meaning                                    | Health                                   |
| --------------- | ------------------------------------------ | ---------------------------------------- |
| `framesSkipped` | the sampler down-sampled to the target FPS | **execution policy** — perfect health    |
| `framesDropped` | the bounded queue overflowed under load    | **real degradation** — belongs in an SLO |

A 30 fps camera analyzed at 5 fps skips 83% of frames _by design_. During implementation a
`framesDropped` key collision briefly reported the offline baseline as **80% frame loss**; the live
path now emits a distinct `backpressureDropped`, and a regression test pins offline loss at **0.0%**.

## 5. Failure taxonomy (Architect refinement 4)

Mutually exclusive, each with one diagnostic code and one recovery path:

| Category        | Tier       | Code        | Recovery                             |
| --------------- | ---------- | ----------- | ------------------------------------ |
| `connection`    | ingestion  | `AI-CONN`   | reconnect with backoff (automatic)   |
| `model`         | engine     | `AI-MODEL`  | rebind / roll back the model version |
| `inference`     | per-frame  | `AI-INFER`  | skip the frame; session continues    |
| `pipeline`      | post-infer | `AI-PIPE`   | skip the frame; session continues    |
| `configuration` | control    | `AI-CONFIG` | **operator fix — never retried**     |

`configuration` is deliberately non-recoverable: retrying a bad source config burns the reconnect
budget and hides the real problem.

## 6. Refinements — 4 plan + 8 implementation = 12, all folded in

| #   | Refinement                      | Where                                                                                            |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| P1  | Preserve Frame ownership        | `Frame` frozen; `analyze_frame` pure + retains no frame data; pipeline owns lifetime             |
| P2  | Keep SessionRunner lightweight  | five jobs only; public-surface test forbids perception/camera state                              |
| P3  | Separate ingestion vs inference | five categories + codes + recovery paths (`errors.py`, `RuntimeFailureCategory`)                 |
| P4  | Preserve streaming neutrality   | `StreamSource` Protocol; declared-type dispatch; 7 transports constructible today                |
| 1   | Session identity                | `SessionIdentity(tenant, camera, session[, correlation])`; no thread/pid anywhere                |
| 2   | Stream ownership                | four-tier ownership stated in every module header + asserted in tests                            |
| 3   | Backpressure observability      | `queueHighWatermark`/`queueUtilization`/`averageQueueDepth`/`processingDelayMs`                  |
| 4   | Failure taxonomy (5 categories) | `+ConfigurationFailure`; `FAILURE_CODES`/`FAILURE_RECOVERY`; contract enum + maps                |
| 5   | Benchmark consistency           | `configurationFingerprint` + `hardwareFingerprint` (stable sha256 digests) on every report       |
| 6   | Protocol neutrality             | no RTSP assumption in the runtime; `build_source` dispatches on declared type only               |
| 7   | Operational logging             | `OperationalLog` — every reconnect/recovery/failure carries tenant+camera+session+correlation    |
| 8   | Resource cleanup                | one `_teardown()` for stop/restart/fail/shutdown; queue·source·thread·heartbeat·metrics released |

## 7. Tests (deterministic, stdlib, no camera / no network)

| Suite                                | Count | Covers                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_stream_source.py`              |    22 | lifecycle, backoff schedule, cold-start retry, budget exhaustion, availability freeze, redaction, taxonomy, identity-correlated logging, transport neutrality, frame immutability                                                                                      |
| `test_stream_pipeline.py`            |    17 | drop-oldest/newest, high-watermark/utilization/avg-depth, **skip vs drop**, **streaming≡batch equivalence**, cross-frame tracking state, idempotent flush, unbounded sources, per-frame failure survival, cleanup, sampler admission parity                            |
| `test_session_runner.py`             |    23 | live pumping, heartbeat production, completion, coded failure, pause/resume, restart-preserves-identity, multi-camera isolation, capacity 409, fleet stats, metrics/diagnostics tier separation, **cleanup on stop/restart/fail/shutdown**, orchestration-only surface |
| `test_live_sessions_http.py`         |     8 | additive `POST /sessions`, live start, metrics + stream diagnostics, tenant scoping, bad config → 400, capacity → 409, supervisor view, auth                                                                                                                           |
| `test_config.py` (new cases)         |    +3 | live defaults, overrides, fail-fast rejection of nonsense limits                                                                                                                                                                                                       |
| `test_benchmark.py` (new cases)      |    +7 | five reproducibility anchors, stable fingerprints, live suite, reconnect workload, **offline loss stays 0%**                                                                                                                                                           |
| contracts `inference/benchmark.test` |   +11 | transport neutrality, credential-free config, 5 categories/codes/recovery, logical identity, tier split, additive metrics, diagnostics, capacity, fingerprints                                                                                                         |

**Contracts 167 · Python 247** (+11 / +80). All gates green (typecheck, lint, import-graph 0-viol,
codegen **79** schemas, format). AI-5a baseline suite re-run: **PASS, 0.00% dropped** — no regression.

## 8. Definition of Done

- [x] Transport-neutral `StreamSource` + connection lifecycle + bounded reconnect + availability/recovery.
- [x] Streaming pipeline with bounded queue, explicit drop policy, and backpressure tuning metrics.
- [x] `analyze_frame` extraction — one per-frame path for batch and live, equivalence-tested.
- [x] Multi-camera `SessionRunner`/`SessionSupervisor` with real heartbeats, capacity limits, tenant isolation.
- [x] Five-category failure taxonomy with distinct codes + recovery paths; configuration never retried.
- [x] Logical session identity + identity-correlated operational logging.
- [x] Full resource cleanup on stop/restart/fail/shutdown, asserted by tests.
- [x] Additive contracts (+9 → 79); frozen five untouched; additive HTTP; fail-fast config.
- [x] Live benchmark workloads + reproducibility fingerprints; AI-5a baseline re-run clean.
- [x] Deterministic tests green; no new service; no frozen-doc (01–28) change.
- [ ] **Architect review of AI-5b** — ⏳ pending (stop here before AI-5c).

## 9. Deferred (explicitly out of scope)

| Item                                                              | Slice     |
| ----------------------------------------------------------------- | --------- |
| Inference scheduling, batching, per-camera fairness               | **AI-5c** |
| Resource management / graceful degradation under CPU-GPU limit    | **AI-5c** |
| Auto-recovery policy, health remediation, model hot-reload        | **AI-5d** |
| Production-readiness validation + edge deployment                 | **AI-5e** |
| Durable frame buffering across restarts                           | later     |
| Real RTSP integration runs (OpenCV path exists, integration-only) | AI-5e     |

Known limitation: `OpenCvStreamSource` is exercised only by integration (it needs a real camera);
its lifecycle logic is fully unit-tested through the same `ConnectionSupervisor` that drives it, which
is the same pattern G-2 used for the ffmpeg decoder.
