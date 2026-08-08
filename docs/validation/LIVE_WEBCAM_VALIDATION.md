# Live Webcam Validation — P-9

**2026-08-08.** Live video, captured from a real browser and analysed by the production perception
pipeline. No new AI model, no new engine, no new perception task, and no second pipeline.

> ⭐ **The headline is architectural, not featural.** The live AI pipeline already existed in full.
> Every producer — the RTSP decoder, the offline analysis worker, and now a browser — converges on
> one door, `FrameSink.push()`. What this milestone added is a **producer**, not a pipeline. The
> consequence is that swapping the webcam for an RTSP camera needs **zero new code**, because the
> RTSP path is the one that was already there.

---

## 1. The architecture, as required and as built

```
Offline recording ──▶ FrameSource ──┐
                                     │
Live RTSP / RTMP ──▶ Decoder ────────┼──▶ FrameSink ──▶ Runtime ──▶ Tracker ──▶ Publisher
                                     │                     │
Browser webcam ──▶ LiveIngest ───────┘                     ▼
                                                    Rule engine ──▶ Incidents ──▶ Evidence
Future ONVIF / USB / NVR ──▶ (a producer) ──┘
```

⛔ **The webcam is deliberately NOT a `FrameSource`.** That port is the *offline* one: it demands
`assetKey`, `contentType` and `footageStartedAt`, its `read()` takes `fromOffsetSeconds` +
`durationSeconds`, and it must resume from a checkpoint after a restart. Every one of those is a
statement about *footage time in a file that already exists*. A live camera has no asset, no offset,
no end and nothing to resume — implementing against that interface means inventing four values that
have no meaning and then keeping them true for ever.

The live port is `Decoder`, and the webcam is not one of those either: `Decoder.open` takes a
`StreamConnection` whose `protocol` is `CameraProtocol`, frozen at `['rtsp','rtmp']`. Widening a
frozen enum for a non-network source would have been the wrong trade.

**The convergence point is the sink**, and the assignment gate says so in its own header: *"It is
consulted from `FrameSink.push()`, which is downstream of the decoder."*

### 1.1 The call graph

```
POST /api/media/live/:cameraId/frame            transport/routes/live.ts
  └─ LiveIngest.frame()                         application/live-ingest.ts
       ├─ at = this.#now()                      ⛔ the SERVICE clock, never the client's
       ├─ session.ring.push(...)                bounded 40-frame evidence ring
       └─ this.#sink.push(tenantId, cameraId, frame)
            │
            ▼   ← the RTSP decoder's onFrame() enters HERE, one line apart
       HttpFrameSink.push()                     adapters/http-frame-sink.ts
         ├─ #admit()  → AssignmentGate.decide() → runtimeUrl, capabilityId, zones
         ├─ queue, drop-oldest on overflow
         └─ #pump() → #send()
              ├─ fetch(`${runtimeUrl}/infer`)   ⭐ the ONLY /infer call in the service
              └─ #record()
                   ├─ resolveZones()
                   └─ EventPublisher.publish()  → NATS → services/events
                                                       → services/rules → services/workflow
```

⭐ **`#send()` is shared by `push` (live) and `deliver` (offline).** They differ only in the
admission policy at the door — live drops the oldest to keep the freshest, offline waits because
there is no such thing as a stale frame in a recording. One request builder, so the two paths cannot
drift about what the runtime is asked.

### 1.2 The proof is a test, not a diagram

`services/media/test/one-pipeline.test.ts` reads the source and **fails** if the architecture stops
holding. A diagram is true the day it is drawn.

| Assertion | What it prevents |
| --- | --- |
| Exactly one file calls `fetch(.../infer)` | A live-only inference path — invisible to every functional test, because it would work |
| `live-ingest.ts` contains no `fetch`, no tracker, no publisher | A producer that grew a pipeline |
| `push` and `deliver` converge on one `#send` | Live and offline drifting about what is sent |
| `new LiveIngest({ sink: frameSink })` in the composition root | ⭐ The whole claim reduces to this one shared reference |
| Only four files know the runtime URL, three of them read-only proxies | A second pipeline that avoids the literal `/infer` |
| No tracker is constructed in this service | Two trackers → two sets of track ids → three views that disagree |

**7 tests, all passing.**

---

## 2. What was built

| | |
| --- | --- |
| `services/media/src/application/live-ingest.ts` | Session lifecycle, service-clock stamping, 40-frame evidence ring, idle reaper |
| `services/media/src/transport/routes/live.ts` | `open` · `frame` · `close` · `sessions` · `snapshot` |
| `apps/console/src/features/livecam/capture.ts` | Pacing, drop-not-queue, stage timers, percentiles, clock-offset estimation, base64 chunking, error mapping — **pure and unit-tested** |
| `apps/console/src/features/livecam/LiveCamPage.tsx` | The operator page: preview, overlay, browser stages, platform stages |
| `infra/docker/Caddyfile` | `camera=(self)`, microphone still denied |
| `services/gateway/.../gateway.ts` | Binary body forwarding |
| `tools/validation/livecam/*`, `tools/e2e-browser/livecam-*` | The measurement harness |

**Tests added: 34 console · 7 structural · 9 browser certification** (plus the 23 ingest tests from
slice 1).

---

## 3. Scenario matrix — 28 scenarios

Real footage with published ground truth, played through Chrome's fake video device so that
`getUserMedia`, the `<video>` decode, the canvas draw, the JPEG encode and the upload are all real.
**15 s capture at 4 fps per scenario, fresh browser each time.**

| Scenario | Group | Detections | Frames with a detection | Frames with none | Det/frame | Tracks created | Active at end | Events | Incidents | Ground truth |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| empty-room | scene | **0** | 0 | 73 | — | 0 | 0 | 0 | 0 | **0** |
| one-person | scene | 59 | 59 | 6 | 1.00 | 1 | 1 | 2 | 1 | 1 |
| two-people | scene | 137 | 73 | 0 | 1.88 | 3 | 2 | 4 | 3 | 2 |
| three-plus-people | scene | 280 | 70 | 0 | **4.00** | 2 | 4 | 0 | 0 | **4** |
| crowd | scene | 592 | 74 | 0 | **8.00** | 5 | 8 | 8 | 8 | **8** |
| fast-walking | motion | 56 | 56 | 17 | 1.00 | 4 | 1 | 7 | 5 | 1 |
| slow-walking | motion | 71 | 71 | 3 | 1.00 | 1 | 1 | 3 | 1 | 1 |
| entering-leaving | motion | 73 | 73 | 0 | 1.00 | 1 | 1 | 1 | 1 | 1 |
| partial-occlusion | motion | 59 | 59 | 15 | 1.00 | 1 | 1 | 1 | 1 | 1 |
| occl-static-object | occlusion | 59 | 59 | 15 | 1.00 | 2 | 1 | 4 | 2 | 1 |
| occl-by-person | occlusion | 137 | 73 | 0 | 1.88 | 3 | 2 | 4 | 4 | 2 |
| occl-partial-body | occlusion | 74 | 74 | 0 | 1.00 | 1 | 1 | 3 | 1 | 1 |
| occl-exit-reentry | occlusion | 66 | 66 | 4 | 1.00 | 0 | 1 | 2 | 1 | 1 |
| low-light (authored) | lighting | 67 | 67 | 6 | 1.00 | 1 | 1 | 3 | 2 | 1 |
| light-office | lighting | 68 | 68 | 6 | 1.00 | 1 | 1 | 2 | 2 | — |
| light-bright | lighting | 68 | 68 | 6 | 1.00 | 1 | 1 | 3 | 1 | — |
| light-low (darkened + noised) | lighting | 68 | 66 | 8 | 1.03 | 3 | 1 | 1 | 1 | — |
| light-glare | lighting | 68 | 68 | 6 | 1.00 | 1 | 1 | 3 | 1 | — |
| light-side | lighting | 68 | 65 | 11 | 1.05 | 2 | 1 | 4 | 1 | — |
| **light-backlight** | lighting | **23** | **21** | **48** | 1.10 | 3 | 2 | 0 | 0 | — |
| orient-portrait (tall crop) | orientation | 34 | 34 | 37 | 1.00 | 1 | 1 | 1 | 1 | 1 |
| orient-landscape (720p) | orientation | 68 | 68 | 6 | 1.00 | 1 | 1 | 3 | 1 | 1 |
| **orient-rotated-90** | orientation | **0** | **0** | **73** | — | 0 | 0 | 0 | 0 | — |
| move-pan | movement | 50 | 50 | 23 | 1.00 | 1 | 1 | 2 | 1 | — |
| move-shake | movement | 65 | 65 | 9 | 1.00 | 2 | 2 | 2 | 1 | — |
| move-rotate | movement | 68 | 68 | 6 | 1.00 | 1 | 1 | 2 | 1 | — |
| move-angle (overhead) | movement | 58 | 58 | 15 | 1.00 | 1 | 1 | 3 | 1 | 1 |
| **webcam-live** | device | — | — | — | — | — | — | — | — | **NOT EXECUTED** |

**Loss across the whole matrix: 0 frames dropped for a full queue · 1 out of order · 0 publish
failures.**

### 3.1 What the matrix says

⭐ **The counts are exact where ground truth is exact.** `crowd` returned **8.00 detections per
frame** against a ground truth of 8; `three-plus-people` returned **4.00** against 4.

⭐ **`empty-room` is the negative control and it reads zero** — 73 frames, every one suppressed as
carrying no detection. An instrument that cannot read zero cannot be trusted to read eight.

⚠️ **`two-people` produced three tracks for two people.** The two subjects cross at t=15 in that
clip, and the tracker did not carry one identity through the crossing. This is real tracker
behaviour under person-on-person occlusion, and it is the honest answer to "does occlusion work" —
`occl-static-object` (2 tracks for 1 person) shows the same effect against a fixture.

⚠️ **`fast-walking` produced four tracks for one person** and 17 frames with no detection at all.
Fast motion at 4 fps means large inter-frame displacement; IoU association fails and the track
restarts. **This is the strongest argument in the report for a higher capture rate on fast scenes.**

⛔ **Backlight is the worst result in the matrix: 21 of 69 frames, ~30 %.** A subject crushed toward
silhouette against a blown background is largely invisible to this detector, and no incident was
raised at all in that scenario. Recorded as a limitation.

⛔ **A camera mounted 90° from upright detects nothing — 0 of 73 frames.** See §3.2.

### 3.2 ⛔ A fixture bug that would have become a false claim about the product

The first `orient-portrait` fixture was built with ffmpeg's `transpose=1`. That makes the *frame*
portrait — and lays every **person** on their side.

| | detections | frames |
| --- | ---: | ---: |
| `single-person-walking`, upright | 59 | 59 of 65 |
| the same footage, rotated 90° | **0** | **0 of 73** |
| a **tall 9:16 crop**, people upright | 34 | 34 of 71 |

The report would have said *"the platform fails in portrait orientation"*. It does not: a
corridor-mounted CCTV camera in portrait sees people **upright** in a tall frame, and that case
works. What fails is a camera physically mounted the wrong way round — which is a real deployment
event, so it is kept as its own scenario (`orient-rotated-90`) rather than deleted.

⚠️ Portrait is nonetheless *harder*: 48 % of frames versus 92 % in landscape, because the narrow
field of view means the subject is out of frame for longer.

### 3.3 ⚠️ The lighting results are filtered, not filmed

`light-*` scenarios apply an ffmpeg filter to real footage. **A gamma curve is not a dark room.**
Real low light adds sensor-gain noise, motion blur from a longer exposure, and a colour cast from
the white balance giving up — a brightness filter reproduces none of them. The `light-low` scenario
adds synthetic noise for that reason and is still not the same thing.

`low-light` (the authored `night-footage.mp4` fixture) is the more trustworthy of the two, and it
scored 67 of 73 frames. **Neither supports a claim about the detector at night on a real camera.**

### 3.4 Occlusion — recovery, identity continuity and detection recovery

The three questions the milestone asked, answered from the runtime's own counters. ⚠️ **`recovered`
and `occlusionsSurvived` are two different mechanisms and are never summed**: a *survived occlusion*
is one the tracker absorbed while **keeping its `trackId`**, so a consumer holding that id sees no
interruption at all; a *recovery* is a **new** track linked to a departed identity via `identityId`
and `precededBy`. Reporting them as one number would hide which mechanism is actually carrying the
deployment.

| Scenario | Tracks created | Recovered (re-linked) | Occlusions survived (id kept) | Active at end | Frames tracked | Out of order |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| occl-static-object (behind a fixture) | 2 | **1** | 0 | 1 | 74 | 0 |
| occl-by-person (they cross at t=15) | 3 | **1** | 0 | 2 | 73 | 0 |
| occl-partial-body | 1 | 0 | 0 | 1 | 74 | 0 |
| occl-exit-reentry (leaves and returns) | **0** | 0 | **1** | 1 | 70 | 0 |
| partial-occlusion | 1 | **1** | **1** | 1 | 74 | 0 |
| fast-walking | 4 | **2** | **6** | 1 | 73 | 0 |
| slow-walking | 1 | 0 | 0 | 1 | 74 | 0 |
| entering-leaving | 1 | 0 | 0 | 1 | 73 | 0 |

⭐ **`occl-exit-reentry` recorded 1 survived occlusion**: a track went `lost` and returned as the
**same** track, so nothing downstream saw an interruption at all. ⚠️ Its `createdTracks: 0` is *not*
independent evidence for that — see the caveat below.

⚠️ **`occl-by-person` created 3 tracks for 2 people, and 1 was re-linked.** The tracker did not carry
one identity cleanly through a person-on-person crossing; it recovered the identity afterwards via
`identityId`, so an accumulating consumer that groups by identity sees one visit while one that
groups by `trackId` sees two. **This is exactly why ADR-0041 exists**, and why the manual guide tells
an operator to group by `identityId` and never by `trackId`.

⚠️ **`fast-walking` is the worst case in the matrix for identity: 4 tracks and 6 survived occlusions
for a single person**, plus 17 frames with no detection at all. At 4 fps a fast walker moves far
enough between frames that IoU association fails. ⭐ **This is the strongest argument in the whole
report for raising the capture rate on fast scenes** — and §3 of the baseline shows 8 fps costs
about 0.42 more cores.

> ### ⚠️ Caveat on every tracking figure in this report
>
> **The runtime releases a camera's tracking state after `CAMERA_IDLE_SECONDS = 300`, and track age
> advances per *frame*, not per second.** The matrix leaves 14 s between scenarios — chosen to exceed
> the tracker's 12 s `reentryGapSeconds` so one scenario's departing subject is never *re-linked* to
> the next scenario's arriving one. It does **not** exceed 300 s, so live tracks from the previous
> scenario are still present when the next one's first frame arrives.
>
> **What this does and does not affect:**
>
> - ⛔ **`createdTracks` and `activeTracksAtEnd` are affected.** A scenario can inherit a track and
>   report creating none — which is why `three-plus-people` shows `createdTracks: 2` beside
>   `activeTracksAtEnd: 4`, and why `occl-exit-reentry` shows 0.
> - ✅ **Detections, frames-with-a-detection and detections-per-frame are unaffected.** They are
>   per-frame model output with no cross-frame state, which is why the headline results — `crowd` at
>   exactly 8.00, `empty-room` at 0 — stand without qualification.
> - ✅ **`recoveredTracks` and `occlusionsSurvived` are transitions, not totals**, so they describe
>   events that happened inside the window.
>
> **Found after the run, by reading `runtime_tracking.py` rather than by any check.** The honest fix
> for a future matrix is a gap longer than 300 s (which would triple the run time) or a per-scenario
> camera — recorded here rather than quietly left for the next reader to trip over.

**`outOfOrderFrames` is 0 in every scenario.** Frames arrive at the runtime in the order they were
captured, which is what makes the tracking answers reproducible.

---

## 4. Stage-by-stage latency

Full table in [LIVE_PERFORMANCE_BASELINE.md](LIVE_PERFORMANCE_BASELINE.md) §2. Summary:

| | avg |
| --- | ---: |
| Browser: capture + encode + upload | 12.4 ms |
| Transport (service-measured) | 9.3 ms |
| Media → runtime round trip (inference 57.0, tracking 0.2) | 67.1 ms |
| Publish + broker + persist (derived) | 15.3 ms |
| Event → incident | 12.3 ms |
| **⭐ END TO END — camera frame to incident raised** | **87.3 ms** (max 109) |
| Browser render (overlay behind preview) | 183.8 ms |

**Clock offset browser↔platform: +3 ms ± 5 ms.** The clocks agree to within the measurement, so the
transport figure is transport rather than skew — which is why the offset is printed with its
uncertainty on the page itself and not quietly assumed to be zero.

⭐ **Inference is 65 % of end-to-end.** Everything the platform does around the model costs ~30 ms.

---

## 5. Back-pressure

| Phase | Target | Achieved | Rejected | Queue max | Drops | Latency avg |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline (4 fps, 1 in flight) | 4 | **4.00** | 0 | 0 | 0 | 56.3 ms |
| overload (25 fps, 12 in flight) | 25 | **25.00** | 0 | 1 | **11** | 94.0 ms |
| recovery (4 fps, 1 in flight) | 4 | **4.00** | 0 | **0** | **0** | 64.6 ms |

⭐ At 25 fps the runtime reached **949 % CPU (9.5 of 10 cores)** and lost **11 frames of 2250
(0.5 %)**. Nothing was rejected and no request failed.

⭐ **Recovery is the result.** Queue and drops both return to zero and latency returns to within
15 % of baseline. An overload phase alone shows only that a system bends; the third phase is what
shows it comes back.

⚠️ **The depth gauge is coarse.** It is sampled every 2 s, so a queue that fills and drains between
samples is invisible — hence `queue max: 1` beside `drops: 11`. The drop counter is the reliable
signal, and reporting depth alone would have called the overload phase uneventful.

---

## 6. Browser failure and recovery

`tools/e2e-browser/test/livecam.spec.ts` — **9 specs, all passing** against the real deployment.

| Case | Result |
| --- | --- |
| Capture, upload, all browser stages populated, platform agrees it received them | ✅ |
| Clock offset reported **with its uncertainty**, never as a bare number | ✅ |
| Stop releases the session immediately | ✅ |
| Page refresh leaves at most one session | ✅ |
| Restart on the same camera after a stop | ✅ |
| ⛔ **Device stops producing video → capture STOPS** | ✅ |
| Closed tab leaves at most one session; reaped in 60 s | ✅ |
| Unusable camera reaches the operator as an instruction, never `unknown` | ✅ |
| Edge permits `camera=(self)` and still denies `microphone=()` | ✅ |

⛔ **The device-lost case is the most important one here.** Unplugging a camera fires `ended` on the
track and nothing else: the stream object stays, `getUserMedia` never rejects again, and the
`<video>` freezes on its last frame. Without the handler, the page would keep posting that still
image, the runtime would keep detecting the person in it, and the timeline would show somebody
standing perfectly motionless until the tab closed. **That is a fabricated observation, which an
evidence platform must never produce.**

### 6.1 What the certification run found

Headless Chromium rejects with `NotSupportedError`, which had no case in the error mapper and
rendered as **"unknown — Not supported"** — a raw browser string in front of an operator, which is
precisely what the mapper exists to prevent. Now `capture-unsupported`, with an actionable message,
plus a unit test and an assertion that the code is never `unknown`.

---

## 7. Offline / live parity

| | Offline | Live | Identical? |
| --- | --- | --- | :---: |
| Model id / version | `yolox-nano` 1.0.0 | `yolox-nano` 1.0.0 | ✅ |
| Runtime version | 0.1.0 | 0.1.0 | ✅ |
| Execution provider | `CPUExecutionProvider` | `CPUExecutionProvider` | ✅ |
| Capability | `perception.person-detection` | `perception.person-detection` | ✅ |
| Pipeline version | 1.0.0 | 1.0.0 | ✅ |
| Event types | `perception.person.detected` | `perception.person.detected` | ✅ |
| Detections / analysed frame | 0.800 | 1.000 | comparable |
| Frames dropped | 0 | 0 | ✅ |

⚠️ **The volumes differ by design.** Offline uses `FrameSink.deliver` (waits, loses nothing); live
uses `push` (samples, drops under pressure). The rates differ further because the offline run covered
the whole 30 s clip including the seconds where the subject is off-screen, while the live window was
15 s in the middle. **What must be identical is the execution path, and it is.**

---

## 8. Long-running stability

**30 minutes of continuous live ingest at 4 fps — 7181 frames, 0 rejected, 0 dropped, queue never
above 0.** Memory over the run: inference **134.77 → 134.77 MiB** (identical), media +1.4 %, events
+0.1 %, rules +0.2 %. Pipeline latency held between 53.2 and 55.9 ms across nine of ten deciles with
no trend. Tracking created 24 tracks and recorded **0 out-of-order frames** — the ordering property
the live path depends on held for half an hour without a single violation.

Full tables, deciles and caveats: [LIVE_PERFORMANCE_BASELINE §5](LIVE_PERFORMANCE_BASELINE.md#5-long-running-stability).

⚠️ **This is a daytime stability check, not a release soak.** Thirty minutes is 7181 frames; a
customer's day is 230,000. Everything that only appears over hours — log growth, index bloat, heap
fragmentation, disk fill — is outside what this run can see.

> ⛔ **The host suspended for 966 s at the end of this run**, after the sender had finished. The
> measurements stand; the artefact's wall-clock fields (`2761.2 s`, `2.6 fps`) do not. This is
> instrument failure #6 in §9 — it is the reason `tools/validation/lib/continuity.mjs` exists, and it
> is now checked automatically by every soak in the repository.

### Deferred to the overnight release soak

**Status: SCHEDULED — full 6–7 hour release soak, tonight (2026-08-08).** Daytime development
resumed, so no further long run is attempted on this host during working hours; nothing measured so
far is discarded, and every artefact above is committed.

| Question | Why 30 minutes cannot answer it |
| --- | --- |
| Memory over a working day | 1.4 % on media over 30 min is noise or a leak; only hours separate the two |
| Log, index and disk growth | Bounded by rotation and TTL policies whose periods exceed this run |
| Latency after hour one | The one anomaly here (decile 10) sits against the host's suspension and needs uninterrupted hours to attribute |
| Track-identity stability over hours | 24 tracks in 30 min exercises creation, not long-horizon identity |
| Recovery from a mid-run restart | Not attempted during a working day — belongs in a run nobody is using the machine for |

---

## 9. ⛔ Seven instrument failures, found before publication

Every one of these would have put a false statement about the product into this report.

| # | The instrument said | It was actually | How it was caught |
| --- | --- | --- | --- |
| 1 | `crowd`: **0 events** with 8 active tracks; `partial-occlusion`: 0 events with a track created | Detection was perfect. Events are deduplicated per track per 10 s (L-57), so an event count is **not** a detection count. The bridge's own counters were clean — 0 dropped, 0 failed | The number was implausible: eight tracked people cannot produce zero of anything. Replaced with `detectionsPublished`, upstream of the dedup |
| 2 | Achieved frame rate **70 % of target at 1, 2, 4, 8 and 15 fps**; inference CPU 0.08–2.98 % | Exact at every rate; inference CPU 47–628 % | ⭐ **The constancy.** A platform limit does not scale perfectly with the load offered to it; a fixed overhead does. `docker stats` ran through `execFileSync`, blocking the Node event loop ~1 s per sample. And 9 skips appeared at **1 fps**, where a 16 ms upload cannot collide with a 1000 ms interval |
| 3 | `move-pan`, `move-shake`, `move-rotate`: `detections: —`, `tracks: null` | The harness's access token expired 30 minutes into the matrix run; every platform read 401'd and the callers turned that into `null`. ⚠️ The browser half kept working, because each scenario logs in through the UI | A dash where a number belongs. The report generator now prints **"INSTRUMENT DID NOT READ — row invalid"** rather than a dash beside real measurements |
| 4 | The 30-minute soak: `sent=3598 rejected=3601`, queue max 0, memory flat | ⛔ **The same token expiry, in the tool that had not been fixed.** The soak's first fifteen minutes sent real frames; the second fifteen sent nothing but 401s — at exactly the cadence a healthy run has. The drift analysis then compared a first tenth **under load** against a last tenth **under none**, and would have reported memory *falling* over the run as evidence of no leak | The rejection count. ⚠️ Nothing else looked wrong: the loop kept its rate, the queue stayed at zero, and `docker stats` dutifully recorded an idle deployment. The soak now **refuses to report** a run with more than 1 % of frames refused, and exits non-zero |

| 5 | The soak retry: a clean **8.00 fps** against a **4 fps** target, everything else healthy | ⛔ **Two sender processes were feeding one camera.** The first had not been killed. Each behaved perfectly; the platform saw double the load, and every latency and CPU figure described a run nobody had configured | The rate was too good and too wrong at once — a 4 fps target does not overshoot to exactly double by accident. The soak now refuses to start if the camera already has a live session, and cross-checks the platform's `framesAccepted` against its own `sent` |
| 6 | The soak that produced this report: **2.6 fps** against a 4 fps target, a 35 % shortfall | Exactly **4.000 fps**. The host suspended for 966 s *after* the sender finished, and the harness divided 7181 frames by a wall clock that had kept running | ⭐ **The arithmetic did not close.** `sent=7181` is 4 fps × 1795 s, which cannot also be 2.6 fps — so either the frame count or the clock was lying. The 5-second sampler's own timestamps showed a 966.2 s hole. ⚠️ **Both existing guards passed**: 0 rejected, and the platform's accepted count matched the sender's exactly |

Plus the fixture bug in §3.2 (rotating the frame also rotated the people), which is the same class:
a measurement that was internally consistent and describing something other than what its label said.

⚠️ **Five of the seven were caught by the shape of a number rather than by any check** — zero events
under eight tracked people, a shortfall identical at every load, a rate at exactly double the target,
a frame count that contradicted its own clock, and 0 of 73 detections in a scenario the others found
easy. That is not a reliable process, and the fix in each case was to make the instrument grade
itself: `skipRatio` and `harnessBound` on the bench, an explicit invalid-row marker in the report
generator, `looped` and `browserLifetimeSeconds` on every matrix row, a pre-flight session check and
an accepted-vs-sent cross-check on the soak, and — for #6 — a continuity check
([`tools/validation/lib/continuity.mjs`](../../tools/validation/lib/continuity.mjs)) that every soak
in the repository now runs against its own sampler heartbeat.

⭐ **The pattern across all seven is that the instrument was never the thing under test, and was
wrong more often than the product.** The runtime, the tracker and the pipeline produced no defects in
this milestone. Six harnesses and one fixture did.

---

## 10. ⛔ Honest validation — what is NOT validated

| | Status |
| --- | --- |
| **RTSP** | ⛔ Never exercised with a real camera. The code path exists and is the one the webcam producer proves the *downstream* of |
| **ONVIF** | ⛔ Discovery is implemented; no device has ever answered it |
| **DVR / NVR** | ⛔ Never connected |
| **Real CCTV optics** | ⛔ **No CCTV lens.** Every frame in *this report* came from an authored clip or Chrome's fake device — no sensor noise, no rolling shutter, no IR cut-over, no auto-exposure hunting, no condensation. ⚠️ See §10.1: a real *webcam* lens has reached the runtime before, by a different route |
| **Multi-camera** | ⛔ One camera throughout. Sizing arithmetic in the baseline is arithmetic, not measurement |
| **GPU deployments** | ⛔ `CPUExecutionProvider` only. A GPU changes throughput **and** numeric output |
| **Hardware certification** | ⛔ Pending. Requires physical devices — see `P9_HARDWARE_PROCUREMENT.md` |
| **The real built-in webcam** | ⚠️ **NOT EXECUTED by this automated run.** Requires a human; see [MANUAL_TEST_GUIDE.md](MANUAL_TEST_GUIDE.md). The matrix reports it as `NOT EXECUTED` rather than omitting it |
| **Firefox / Safari capture** | ⛔ Chromium-only. The fake-device flags are Chromium switches; the specs skip explicitly rather than reporting a Chromium pass as a WebKit one |
| **Mobile browsers** | ⛔ Untested |
| **Detector accuracy on real surveillance footage** | ⛔ **VIP has no measured accuracy on real CCTV footage.** See [../architecture/DATASET_STRATEGY.md](../architecture/DATASET_STRATEGY.md) |
| **Sustained load beyond 30 minutes** | ⛔ Not established |
| **Demographic fairness** | ⛔ Not characterised. The corpus derives from one CC0 photograph of two people |

### 10.1 ⚠️ What P-9 Track A already established, and what it did not

P-9 Track A (2026-08-07) put **real-world pixels through the perception path for the first time in
the project's life** — a real laptop-webcam lens, real optics and real sensor noise through the
deployed ONNX runtime: 308 frames, 78 ms inference, 143 detections, one tracked identity. That is a
real result and this milestone does not supersede it.

⛔ **But it reached the runtime through a demonstration MJPEG transport, explicitly not the product's
live-video path** — its own close-out says so, and TD-28 remained open. So the platform had proved
*the model sees through a real lens* while never having proved *a live camera can drive the
product*.

⭐ **That is exactly the gap this milestone closes, and the gap it does not.** Live frames now travel
the production route — gateway → media → assignment gate → `FrameSink` → runtime → tracker → event
publisher → rule engine → incidents — with the execution path measured identical to offline
analysis. What is still absent is a *CCTV* lens: a webcam is not a surveillance camera, and none of
the mounting height, depression angle, wide-angle distortion or IR behaviour that defines CCTV optics
has ever been in front of this platform.

⚠️ **TD-28 is materially narrower but not closed.** It concerns live *playback* — showing an operator
a live picture in the console — which needs a server-side repackager this platform still does not
have. The Live Capture page shows the operator their own camera, from their own browser; it is not a
live view of a remote RTSP camera.

⭐ **What IS validated:** that a live frame source can be added to this platform without adding a
pipeline; that the browser capture path works end to end through a real edge, gateway, runtime,
tracker, rule engine and incident pipeline; how long each stage takes; how the pipeline behaves under
overload and that it recovers; and that offline and live execute through identical production code.

⚠️ **These results apply only to the exercised workload.** They do not replace real-CCTV validation
or production-environment validation.

---

## 11. New limitations

| | |
| --- | --- |
| **L-72** | Live capture requires a browser — Docker Desktop on macOS cannot pass the host camera to a container |
| **L-73** | Detection under strong backlight falls to ~30 % of frames |
| **L-74** | A camera mounted 90° from upright detects nothing |
| **L-75** | A closed browser tab leaves a live session claimed for up to 60 s |

Full entries in [../project/KNOWN_LIMITATIONS.md](../project/KNOWN_LIMITATIONS.md).

---

## 12. Related

- [LIVE_PERFORMANCE_BASELINE.md](LIVE_PERFORMANCE_BASELINE.md) — the permanent comparison baseline
- [MANUAL_TEST_GUIDE.md](MANUAL_TEST_GUIDE.md) — the real-camera run a human must do
- [COMPLETE_E2E_TEST_GUIDE.md](COMPLETE_E2E_TEST_GUIDE.md) — reproducing every automated result
- [../architecture/PERCEPTION_ENGINE.md](../architecture/PERCEPTION_ENGINE.md) — where multi-model perception goes next
