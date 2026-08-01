# Production Compatibility & Certification

> **Status:** governance · **Owner:** Principal Architect + Claude · _2026-08-01_
> Consolidates four standing commitments from the AI-5b acceptance review (recommendations 5, 8, 9, 10):
> **offline replay is permanent**, **existing customer infrastructure is a first-class target**,
> **real hardware certifies production readiness**, and **the frozen architecture stays frozen**.
> Companion docs: [PRODUCTION_KPIS](PRODUCTION_KPIS.md) · [AI_EXECUTION_ARCHITECTURE](AI_EXECUTION_ARCHITECTURE.md) · [CAPABILITY_MATURITY](CAPABILITY_MATURITY.md)

---

## 1. Offline replay is preserved forever (rec 5)

**Streaming did not replace offline execution, and never will.** AI-5b made the runtime live; it did
not make it live-only. Both paths run through the **same `analyze_frame()` implementation**, which is
what makes the guarantee credible rather than aspirational — there is no second pipeline to drift.

| Capability                      | Why it must survive                                                      | Where it lives                             |
| ------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| **MP4 replay**                  | Validate a model on real footage before it touches a camera              | `playground_cli.py`, `OpenCvFrameDecoder`  |
| **Deterministic regression**    | CI must never need a camera; results must be byte-reproducible           | `StubFrameDecoder`, the whole Python suite |
| **Benchmark replay**            | Compare runtime versions on identical input (AI-5a baseline)             | `benchmark.py` offline workloads           |
| **Evidence replay**             | Re-derive what the system saw for an incident, after the fact            | `FileStreamSource` (finite + looping)      |
| **Customer issue reproduction** | "It missed an intruder at 14:32" must be reproducible from the recording | `FileStreamSource` + `AnalyzeOptions`      |

**Standing gate:** the streaming≡batch equivalence test
(`tests/test_stream_pipeline.py::StreamingEqualsBatchTest`) is a permanent CI check. If the two paths
ever diverge, everything the AI-1…AI-4 suites prove about batch analysis stops being true of
production, so that test failing is a release blocker, not a flake to skip.

## 2. Existing customer infrastructure is a first-class target (rec 8)

Customers do not replace their cameras to buy software. The platform meets the estate it finds, and
`StreamSource` was designed so that meeting it never requires runtime changes — the runtime dispatches
on **declared type**, never on URI sniffing.

| Environment                | Status                  | How it plugs in                                                                                                       |
| -------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Existing DVRs**          | supported today         | DVR RTSP output → `type: rtsp`; per-channel URLs become per-camera sources                                            |
| **Existing NVRs**          | supported today         | NVR RTSP/ONVIF re-stream → `type: rtsp` / `onvif`; NVR remains the recorder                                           |
| **Direct RTSP cameras**    | supported today         | `type: rtsp` → `RtspStreamSource` (profile selection + TCP transport, AI-5e)                                          |
| **ONVIF cameras**          | **implemented** (AI-5e) | `type: onvif` → `RtspStreamSource`; `ai/inference/onvif.py` discovers + negotiates and populates `CameraCapabilities` |
| **USB / built-in webcams** | supported today         | `type: usb` with `options.deviceIndex`                                                                                |
| **HTTP / MJPEG**           | supported today         | `type: http`                                                                                                          |
| **Recorded files**         | supported today         | `type: file` (looping supported for soak tests)                                                                       |
| **Future cloud cameras**   | contract ready          | `type: cloud` — a new implementation behind the same Protocol                                                         |
| **WebRTC**                 | contract ready          | `type: webrtc`                                                                                                        |
| **Edge deployments**       | **packaged** (AI-5e)    | `edge/packaging/` — Docker · mini-PC · NUC · Jetson · industrial PC. Packaged, **not certified**                      |

**Design commitments that make this hold:**

- **Sub-stream by default.** Most DVR/NVR estates publish a low-resolution sub-stream; analyzing it
  instead of the 4K main stream is the single cheapest performance decision available, and deployment
  profiles set `preferredStreamProfile: sub` for exactly that reason.
- **Never require ONVIF.** ONVIF is used when present (`capabilities.onvif`) and never assumed —
  plenty of working estates do not expose it.
- **Never require credentials in a URL.** Credentials are referenced (`credentialRef`) and redacted
  everywhere, because DVR estates commonly share one credential across many channels.
- **Tolerate flaky links.** Bounded-backoff reconnect + availability accounting assume the network
  will fail, because in a warehouse or a parking lot it does.

## 3. Real-hardware certification — **framework delivered in AI-5e, execution pending hardware**

Everything through AI-5d is deterministic and simulated. That proves the **plumbing**, not the
**perception**. No capability is promoted to `Production` in
[CAPABILITY_MATURITY](CAPABILITY_MATURITY.md) on simulated evidence alone.

**AI-5e built the procedure and deliberately did not execute it.** The harness
(`ai/inference/certification.py`), the CLI (`vip certify`), the soak framework, the compatibility
registry and the promotion gate all exist and are tested. **No device has been physically validated**,
so every row below and every row of the
[compatibility registry](../../../ai/inference/profiles/cameras/) reads `Pending Validation`.

That is enforced structurally, not by convention: `EvidenceClass` records what every check ran on, a
report is only as strong as its weakest check, and `certified` is unreachable without `hardware`
evidence. A complete run against a simulated source — every check green — still returns
`pending-validation`, and a negative-control test asserts it
(`tests/test_certification.py::EvidenceClassTest::test_a_flawless_simulated_run_is_still_not_certified`).

**Certification matrix** — each row runs the standard + live benchmark suites, records a
`BenchmarkReport` (with configuration + hardware fingerprints), and is compared against the AI-5a
baseline:

| #   | Target                     | What it certifies                                            |
| --- | -------------------------- | ------------------------------------------------------------ |
| 1   | **Hikvision** (RTSP/ONVIF) | The most common enterprise estate; ONVIF profile enumeration |
| 2   | **Dahua** (RTSP/ONVIF)     | Second most common; differing ONVIF dialect                  |
| 3   | **CP Plus** (RTSP)         | Value-segment estate typical of the pilot market             |
| 4   | **Generic ONVIF camera**   | That discovery works without vendor-specific code            |
| 5   | **Generic RTSP camera**    | The no-ONVIF baseline path                                   |
| 6   | **USB webcam**             | The `usb` transport + device-index option                    |
| 7   | **Recorded MP4 playback**  | That offline replay still matches live output (§1 guarantee) |

**Per-target checks:** connect · sustained 1-hour run · deliberate cable pull → reconnect + recovery
time · credential redaction in every log · sub-stream selection from declared capabilities · FPS/latency
against the deployment-class budget · frame-loss distinguishable from sampling · clean shutdown with no
leaked threads, queues, or sockets.

**Exit criterion:** a capability may be promoted to `Production` maturity only with a passing
certification row on at least one real device of its class, plus a benchmark comparison showing no
regression against the accepted baseline.

## 4. The architecture stays frozen (rec 10)

**AI Runtime Architecture v1.0 is complete.** AI-5 and everything after it improve **reliability,
scalability, throughput, latency, deployment, observability, hardware compatibility and operational
excellence** — they do not expand the architecture.

**The rule:** no new architectural layer and no new contract without a compelling _platform-wide_
justification, an ADR, and a review. "It would be convenient here" is not a justification.

**What AI-5b and AI-5c added, and why none of it is a new layer:**

| Addition                      | Why it is not architectural expansion                                              |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `StreamSource` (AI-5b)        | **Stage 1** of the reference architecture, which always specified a Video Source   |
| `StreamPipeline` (AI-5b)      | The queue between existing stages 3 and 5 — no new stage                           |
| `InferenceScheduler` (AI-5c)  | **Stage 4**, specified since the reference architecture was written                |
| `ComputeResource` (AI-5c)     | An operational abstraction behind the unchanged `ModelAdapter` seam                |
| `HealthMonitor` (AI-5d)       | Interprets measurements existing stages already emit — no new instrumentation      |
| `AutoRecovery` (AI-5d)        | **Executes** the frozen AI-5b failure taxonomy; adds no new judgement              |
| `ModelSlot` (AI-5d)           | One indirection **behind** the unchanged `ModelAdapter` seam — not a new stage     |
| `DiagnosticsJournal` (AI-5d)  | A **sink** on the operational log a session already writes to — not a new emitter  |
| `RtspStreamSource` (AI-5e)    | `OpenCvStreamSource` + declared-profile selection — a subclass, not a new tier     |
| ONVIF discovery (AI-5e)       | Produces **configuration**. It never touches the pipeline; discovery is data       |
| Certification harness (AI-5e) | An **observer** of the frozen runtime — it reads diagnostics, it changes nothing   |
| Soak framework (AI-5e)        | Samples what the runtime already publishes; adds no instrumentation                |
| Operational contracts (all)   | Additive, operational-only; the **five frozen perception contracts are untouched** |

The five frozen contracts — `DetectionResult` → `Track` → `BehaviorResult` → `CompositeBehavior` →
`EventEnvelope` — remain additive-only, exactly as [ED-0039](../../project/ENGINEERING_DECISION_LOG.md)
froze them. Every AI-5 slice so far has held that line, and each one has said so in its own review.
