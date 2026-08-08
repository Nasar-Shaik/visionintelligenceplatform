# Live Performance Baseline

> ⭐ **This is the permanent comparison baseline for future AI models.** Every number below was
> measured on a real deployment through a real browser. When a model, a runtime, an engine or an
> execution provider changes, it is re-measured with the same tools and compared to this page —
> which is why the exact hardware, the exact commands and the exact caveats are recorded beside the
> numbers rather than left to memory.

**Measured 2026-08-08** · P-9 Live Video Validation · commit at freeze.

---

## 1. The bench

| | |
| --- | --- |
| Host | macOS (Darwin 25.5.0), **10 CPUs**, Docker Desktop with **7.75 GiB** allocated |
| Deployment | `./infra/docker/prod.sh` production compose, 14 containers, all healthy |
| Runtime | AI Runtime **0.1.0**, pipeline **1.0.0**, capability `perception.person-detection` |
| Model | **`yolox-nano`** v1.0.0, **`CPUExecutionProvider`** |
| Tracker | `predictive-iou` — minIou 0.3 · minIouLost 0.45 · minHits 2 · maxAgeFrames 8 · reentryGap 12 s |
| Capture | Chromium via Playwright, `--use-file-for-fake-video-capture`, 640 px longest edge, JPEG q 0.8 |
| Frame size | ~5.6 KB per 640×360 JPEG (matrix), ~14 KB per bench frame |
| Camera | one, `cam_4b8cbcbab9ec4685821b35a01c52efd2`, profile `person-tracking` |

⚠️ **Every figure is single-camera on CPU.** Multi-camera, GPU and edge-hardware numbers do not
exist and must not be extrapolated from these — §7.

---

## 2. Stage-by-stage latency

**90 s continuous capture at 4 fps · 361 frames.** Three kinds of number, never mixed:

- **measured** — a stopwatch around exactly this stage, on one clock
- **reported** — the component's own measurement of itself, on its own clock
- **derived** — a remainder after subtracting measured parts from a measured span

| Stage | Kind | Measured by | n | min ms | avg ms | p95 ms | max ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Capture (video → canvas) | measured | browser | 361 | 0.2 | **0.7** | 1.5 | 4.1 |
| JPEG encode (canvas → blob) | measured | browser | 361 | 0.8 | **2.5** | 5.9 | 10.1 |
| HTTP upload (round trip) | measured | browser | 361 | 6.0 | **9.2** | 13.0 | 56.0 |
| Transport (capture → media accept) | measured | media service clock | 361 | 5.0 | **9.3** | 14.0 | 53.0 |
| Media ingest → runtime round trip | measured | media service | — | — | **67.1** | — | — |
| ├─ Runtime inference | reported | AI runtime | — | — | **57.0** | — | — |
| └─ Tracking | reported | AI runtime | — | — | **0.2** | — | — |
| Frame stamped → event persisted | measured | media + events clocks | 9 | 58.0 | **82.4** | 141.0 | 141.0 |
| Publish + broker + persist | **derived** | subtraction | — | — | **15.3** | — | — |
| Event persisted → incident raised | measured | events + workflow clocks | 3 | 8.0 | **12.3** | 16.0 | 16.0 |
| **END TO END — frame stamped → incident raised** | measured | platform clocks | 3 | 70.0 | **87.3** | 109.0 | 109.0 |
| Browser render (overlay behind preview) | measured | browser | 37 | 100.0 | **183.8** | 300.0 | 400.0 |

**Clock check: browser is +3 ms ± 5 ms from the platform, over a 9 ms round trip.** The two clocks
agree to within the measurement, so the transport figure is transport and not skew.

### ⚠️ How to read this table honestly

- **Inference is 85 % of the round trip and 65 % of end-to-end.** Everything else — capture, encode,
  network, tracking, the broker, the rule engine, incident creation — costs ~30 ms combined. A
  faster model is the only change that materially moves this number.
- **Tracking is 0.2 ms.** Not a typo, and not a rounding of something larger: the tracker operates on
  a handful of boxes, not on pixels.
- **The `n` column matters.** Browser stages have 361 samples; the platform stages have 9 and 3,
  because events are deduplicated per track per 10 s (L-57) and incidents per rule per subject per
  60 s. A p95 over 3 samples **is** the maximum. Reported rather than smoothed.
- **The derived row can be negative** on another run. It inherits the error of both terms it is
  subtracted from; printing it as `0` would be a silent claim that publishing is instant.
- **Browser render is presentation lag, not pipeline lag.** It is bounded below by the 2 s track
  poll; 184 ms means the poll usually lands soon after the frame that produced the track.

---

## 3. Frame-rate benchmark

**60 s per rate, one upload in flight, 15 s gap between rates** (longer than the tracker's 12 s
re-entry window, so one rate's departing subject is never linked to the next rate's arriving one).

| Target fps | Sent | Achieved fps | Skipped | Upload p95 ms | Frames tracked | Tracking ms avg | **inference CPU %** | media CPU % | inference RSS MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 60 | **1.00** | 0 | 23 | 60 | 0.160 | **47.3** | 1.6 | 135 |
| 2 | 120 | **2.00** | 0 | 21 | 120 | 0.159 | **86.3** | 1.9 | 135 |
| 4 | 240 | **4.00** | 0 | 20 | 240 | 0.159 | **172.0** | 6.0 | 135 |
| 8 | 480 | **8.00** | 0 | 12 | 480 | 0.157 | **305.5** | 4.2 | 135 |
| 15 | 899 | **14.98** | 1 | 18 | 891 | 0.154 | **628.4** | 8.3 | 135 |

⭐ **The achieved rate is exact at every target.** No frame was rejected and none was lost.

⭐ **CPU scales linearly at ~42 % of one core per frame per second**, and memory is **completely
flat at 135 MiB** across a fifteen-fold change in load. The runtime allocates its arenas once.

**Sizing consequence, stated plainly:** on this 10-core box, one camera of person detection costs
about 0.42 cores per fps. Four cameras at 4 fps ≈ 6.7 cores. ⚠️ That is arithmetic from a
single-camera measurement, not a multi-camera measurement — see §7.

### ⛔ These numbers were wrong once, and the reason is recorded

The first run reported achieved rates of 0.82 / 1.52 / 2.81 / 5.62 / 10.55 — a constant **70 % of
target at every rate** — and inference CPU of 0.08–2.98 %.

Both were the harness. The resource sampler called `docker stats` through **`execFileSync`**, which
blocks the entire Node event loop for the ~1 s the command takes; the sender's timers did not fire
and its in-flight uploads did not resolve. ⚠️ **The signature was the constancy** — a platform limit
does not scale perfectly with the load offered to it, a fixed overhead does — and 9 skipped frames
appeared even at **1 fps**, where a 16 ms upload cannot collide with a 1000 ms interval.

Fixed with promisified `execFile`. The harness now computes its own `skipRatio` and flags a phase
`harnessBound` when the driver, not the deployment, bounded the rate.

---

## 4. Back-pressure

**Baseline (4 fps, 1 in flight, 60 s) → overload (25 fps, 12 in flight, 90 s) → recovery (4 fps,
1 in flight, 90 s)**, one continuous sampler across all three so the recovery curve is unbroken.

| Phase | Target fps | In flight | Sent | Achieved | Rejected | Upload p95 ms | Queue max | Drops | Pipeline latency avg ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 4 | 1 | 240 | **4.00** | 0 | 18 | **0** | **0** | 56.3 |
| overload | 25 | 12 | 2250 | **25.00** | 0 | 30 | 1 | **11** | 94.0 |
| recovery | 4 | 1 | 360 | **4.00** | 0 | 17 | **0** | **0** | 64.6 |

| Service | CPU min % | CPU avg % | CPU p95 % | **CPU max %** |
| --- | ---: | ---: | ---: | ---: |
| media | 2.0 | 8.4 | 23.4 | 25.1 |
| **inference** | 153.9 | 450.2 | 945.3 | **949.5** |
| events | 0.3 | 1.6 | 3.4 | 3.7 |
| rules | 0.3 | 0.5 | 1.8 | 2.8 |

⭐ **At 25 fps the runtime reached 949 % CPU — 9.5 of the box's 10 cores — and still lost only 11
frames of 2250 (0.5 %).** Nothing was rejected, no request failed, and the queue never exceeded 1.

⭐ **Recovery is complete and immediate.** Queue depth and drops both return to zero in the third
phase, and pipeline latency returns to within 15 % of baseline. This is the property the third phase
exists to prove: an overload phase alone shows only that a system bends.

### ⚠️ What this measurement cannot see

The queue is sampled every 2 s. A queue that fills and drains between samples is invisible to it —
which is why `queue max: 1` sits beside `drops: 11` without contradiction. **The drop counter is the
reliable signal**; the depth gauge is a coarse one. Reporting depth alone would have said the
overload phase was uneventful.

**The ceiling is therefore ~25 fps on one camera on this box**, reached at 95 % of total CPU. That is
the number to size against, and it is a *saturation* point rather than a recommendation.

---

## 5. Long-running stability

**30 minutes continuous at 4 fps.** Reported first-tenth vs last-tenth rather than as an average,
because a single mean over 30 minutes hides a monotone rise completely.

⚠️ **This is a 30-minute daytime run, not a release soak.** The 6–7 hour release soak that certifies
a build is a separate exercise — see §5.3.

### 5.1 What the run sustained

Sent **7181** frames at **4.000** fps against a 4 fps target · rejected **0** · queue max **0** ·
frames dropped **0**.

| Service | Memory first tenth MiB | Memory last tenth MiB | Drift |
| --- | ---: | ---: | ---: |
| media | 164.7 | 167.0 | +1.4 % |
| inference | 134.8 | 134.8 | +0.0 % |
| events | 109.7 | 109.8 | +0.1 % |
| rules | 111.1 | 111.3 | +0.2 % |

⭐ **The inference container's memory is identical to two decimal places at the start and the end** —
134.77 MiB in both tenths, 134.7–135.2 MiB across every sample. That is the service holding the model
and the tracker state, and it is the one a leak would show in first.

**Pipeline latency drift:** first tenth avg **55.2 ms** (p95 57.3) → last tenth avg **60.2 ms**
(p95 80.8). **Tracking:** 24 tracks created · 0 recovered · **0 out-of-order frames**.

### 5.2 The last tenth is not a trend — read the deciles

| Decile | From (min) | Avg ms | p95 ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.0 | 55.17 | 57.27 | 58.11 |
| 2 | 2.9 | 54.62 | 56.64 | 56.68 |
| 3 | 5.9 | 53.85 | 55.64 | 55.65 |
| 4 | 8.9 | 55.92 | 59.63 | 59.70 |
| 5 | 11.9 | 55.86 | 67.20 | 68.23 |
| 6 | 15.0 | 53.90 | 55.46 | 55.51 |
| 7 | 18.0 | 53.22 | 55.20 | 55.42 |
| 8 | 21.0 | 53.89 | 56.10 | 56.12 |
| 9 | 24.0 | 54.55 | 56.33 | 56.96 |
| 10 | 27.0 | 60.20 | 80.79 | 82.64 |

⭐ **Nine deciles sit between 53.2 and 55.9 ms with no trend in either direction.** The rise is
confined to the tenth, and the tenth is the three minutes immediately before the host suspended
(§5.3). Quoting "latency rose 9 % over 30 minutes" from the two endpoints would have described the
laptop going to sleep as a property of the pipeline — which is why the decile table is here and not
just the two ends.

⚠️ **What this cannot separate.** The final decile's cause is not proven, only located. It coincides
exactly with the host's approach to suspension, and no measurement in this run can distinguish "the
host was already throttling" from "the pipeline degrades after 27 minutes". **The overnight release
soak is what settles it**, because 6–7 hours contains twelve more windows of the same length.

### 5.3 ⛔ The host suspended for 966 seconds, and the harness did not notice

The sender completed its full 1800 s and 7181 frames. The laptop then slept for **966 seconds**, the
process resumed, and the run wrote its file. Because every rate divides work by wall-clock time, the
artefact recorded **`seconds: 2761.2`** and **`achievedFps: 2.6`** — a 35 % shortfall against target
that never happened.

⚠️ **Both existing guards passed.** Nothing was rejected (0 of 7181), and the platform's accepted
count matched the sender's exactly, ruling out the duplicate sender that invalidated the previous
attempt. **A run can be invalidated by the machine underneath it while the sender and the platform
both behave perfectly.**

The measurements above stand — the suspension began *after* the sender had finished — and the
wall-clock fields in `soak.json` do not. The detector is now
[`tools/validation/lib/continuity.mjs`](../../tools/validation/lib/continuity.mjs): a sampler's own
timestamps are its heartbeat, and a gap several times the sampling interval means nobody was running.
It is wired into the live bench, the release soak, and both reports, and it is held to the 2.6-vs-4.0
distinction by twelve tests in
[`tools/e2e/test/run-continuity.test.ts`](../../tools/e2e/test/run-continuity.test.ts).

> ⛔ **`soak.json` is committed with its wrong fields intact** — `seconds: 2761.2` and
> `achievedFps: 2.6` are still in the file. Evidence is not edited to agree with a later
> understanding; `report.mjs` recomputes from the complete raw `series` and `resources`, so the
> tables above are derived by code a reader can re-run rather than by a hand that knew the answer.
> (Only `phase.samples` is truncated to 200 entries, the same rule every artefact here follows — it
> duplicates `series`, which is committed in full.)

### 5.4 What 30 minutes cannot tell you

⚠️ Thirty minutes at 4 fps is **7181 frames**. A retail deployment runs 4 fps for sixteen hours —
230,000 frames — and the failure modes that matter at that scale (log growth, index bloat, a
fragmenting heap, a slowly filling disk) are all invisible here. This section is a **daytime
stability check**, not a release gate.

**The 6–7 hour release soak is scheduled for tonight** and is the run that certifies the build. See
[`../runbooks/OVERNIGHT_SOAK.md`](../runbooks/OVERNIGHT_SOAK.md).

---

## 6. Offline / live parity

The **same clip** (`single-person-walking.mp4`) through both paths.

| | Offline (uploaded recording) | Live (browser webcam) | Identical? |
| --- | --- | --- | :---: |
| Model id | `yolox-nano` | `yolox-nano` | ✅ |
| Model / runtime version | 0.1.0 | 0.1.0 | ✅ |
| Execution provider | `CPUExecutionProvider` | `CPUExecutionProvider` | ✅ |
| Capability | `perception.person-detection` | `perception.person-detection` | ✅ |
| Pipeline version | 1.0.0 | 1.0.0 | ✅ |
| Event types | `perception.person.detected` | `perception.person.detected` | ✅ |
| Frames analysed | 60 (2 fps, whole 30 s) | 65 (4 fps, 15 s window) | by design |
| Detections | 48 | 59 | by design |
| Detections per analysed frame | 0.800 | 1.000 | comparable |
| Frames dropped | 0 | 0 | ✅ |

⚠️ **The counts differ deliberately and the difference is the design.** Offline uses
`FrameSink.deliver`, which waits and loses nothing; live uses `FrameSink.push`, which samples and
drops under pressure. The rate differs further because the offline run covered the whole 30 s
clip — including the seconds where the subject is off-screen — while the live window was 15 s in the
middle. **What must be identical is the execution path, and it is.**

---

## 7. ⛔ What this baseline does **not** establish

| Not measured | Why it matters |
| --- | --- |
| **Multi-camera** | Every figure is one camera. §3's sizing arithmetic is arithmetic, not a measurement — contention, cache behaviour and queue interaction at 4 or 8 cameras are unknown |
| **GPU / CUDA / TensorRT** | Never run. A GPU changes throughput *and* numeric output; accuracy must be re-measured, not carried over |
| **Real CCTV optics** | Every frame came from an authored clip or Chrome's fake device. No lens, no IR cut-over, no auto-exposure hunting, no sensor noise |
| **RTSP / ONVIF / NVR / DVR** | No IP camera has ever been connected to this platform (L-1) |
| **Customer hardware** | Measured on a 10-core laptop with 7.75 GiB allocated to Docker. An on-premise box is a different machine |
| **Sustained load beyond 30 min** | The soak is 30 minutes. A month of uptime is not established |
| **Network conditions** | `localhost`. Upload latency across a real WAN is not in these numbers |
| **Concurrent offline analysis** | The bench ran with nothing else analysing. L-41 caps concurrency at 1 |

---

## 8. Reproducing this page

Every command is in [COMPLETE_E2E_TEST_GUIDE.md](COMPLETE_E2E_TEST_GUIDE.md) §7–§10. The tables here
are **generated**, not transcribed:

```bash
node tools/validation/livecam/report.mjs \
  --matrix   tools/e2e-browser/artifacts/livecam/matrix.json \
  --latency  tools/e2e-browser/artifacts/livecam/latency.json \
  --pressure /tmp/livecam-pressure.json \
  --fps      /tmp/livecam-fps.json \
  --soak     /tmp/livecam-soak.json \
  --parity   /tmp/livecam-parity.json
```

⚠️ **When comparing a future model to this page, re-run all of it.** A model swap changes inference
time, which changes queue behaviour, which changes the saturation point, which changes the sizing.
Quoting one row of a new run against another row of this one is how a regression gets shipped.

---

## 9. Related

- [LIVE_WEBCAM_VALIDATION.md](LIVE_WEBCAM_VALIDATION.md) — what was validated and what was found
- [COMPLETE_E2E_TEST_GUIDE.md](COMPLETE_E2E_TEST_GUIDE.md) — how to reproduce
- [../architecture/BENCHMARK_FRAMEWORK.md](../architecture/BENCHMARK_FRAMEWORK.md) — how two models are compared
- [../architecture/MODEL_EVALUATION_PLAN.md](../architecture/MODEL_EVALUATION_PLAN.md) — the gate a new model passes
