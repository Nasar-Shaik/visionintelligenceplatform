# First Product Validation

> **P-8.5 · 2026-08-07.** The first time this platform was used the way a customer will use it:
> real recordings uploaded through a real browser to a real deployment, and every number below
> measured rather than expected.

**Verdict: 🟡 GO for supervised customer demonstration. NO-GO for unsupervised production.**
The reasoning is in [Go / No-Go](#go--no-go) and it turns on two things — six defects that only a
deployment could find are now fixed, and [L-1](KNOWN_LIMITATIONS.md) has not moved.

---

## What this was

Nine slices of P-8 Phase 8 shipped with 68/68 repo tasks green. That gate proves **the code is
right**. It cannot prove **the product works**, because every one of its tests runs against a double.

So this phase did the other thing: 37 generated recordings, 8 to 37 per sweep, driven through
upload → object storage → ffmpeg → ONNX → tracker → rules → events → timeline → incidents → evidence
→ export, in four browsers, against the deployed stack.

⭐ **It found six defects. Not one was visible to any of the 1 700 tests that were already passing.**

---

## What worked

| Step | Result |
| --- | --- |
| **Deployment** | 17/17 containers healthy; 31/31 checks — edge TLS, HSTS, CSP, plaintext redirect, 8 services through the gateway, runtime, MinIO, JetStream (5 streams), console bundle |
| **Upload** | Presigned PUT straight to object storage (ADR-0036). 4–48 MB/s on loopback; never through the gateway |
| **Asset creation** | ffprobe through an **internal** signed URL; codec, tag, geometry, rate and duration recorded |
| **Analysis** | 8/8 standard, 37/37 sweep. Speed factor **×8.8–×9.1**, stable across a 30× duration range |
| **Runtime inference** | Real ONNX, `yolox-nano`, CPU. 116 detections on a 60-frame clip |
| **Tracking** | Correct after V-2. `crowd` → 8 tracks; `queue-formation` → 4; occlusion survived |
| **Rules** | Fired on real events; `after-hours presence` and `person at checkout` both raised |
| **Events** | Scale linearly and exactly: 4 events/min, 1 track/min on the ladder |
| **Timeline** | Derived from events, never stored. 21 ms at 30 s, 74 ms at 30 min |
| **Incidents** | Reproducible across reruns after V-4. Isolated from the live queue by default |
| **Evidence** | Real JPEGs at footage offsets. **~130 ms regardless of recording length** — accurate seek is O(1) |
| **Export report** | Self-consistent; counts derived from what the report contains |
| **Demonstration mode** | One parameter on the same pipeline; measurably paced |
| **Browsers** | **20/20 Chromium · 4/4 Edge · 4/4 Firefox · 4/4 WebKit** |
| **Concurrency** | 10 simultaneous uploads → **10 identical results**, zero findings |
| **Corrupt input** | 4 of 6 refused with the actual reason; 2 decoded honestly |

### ⭐ The negative control

`empty-scene` — a recording of nobody — produced **0 detections, 0 tracks, 0 events, 0 incidents**,
and the UI said *"Nothing was detected in this recording"* rather than rendering a blank panel.

Every other test asserts the platform finds something. Only this one asserts it does not **invent**,
and a customer's first false alarm on an empty shop is the fastest way to lose their trust.

---

## What failed

Six defects, all found by real usage, all fixed, deployed and re-verified.

### ⛔ V-1 · A full runtime never recovers from a failover · **functional bug, critical**

Restarting the inference container failed over all 4 of `maxCameras: 4`. Every retry then recorded
`placementFailure: capacity-exceeded` — because `#runtimeLoad()` counts `error` as an occupied slot
(correctly: an errored camera is still assigned), and the failover path passed `currentRuntimeId:
null`, withholding the one fact that lets the strategy discount the camera's *own* seat.

**The camera was refused a seat it was itself sitting in, forever.** The planner cycled 669 times
without recovering. Freeing one slot by hand moved the other three to `recovering` in one cycle —
that measurement is what isolated the cause.

> ⛔ The product consequence was worse than a stuck camera: with no assignment, every subsequent
> analysis completed as **`succeeded`** having analysed **nothing**, reporting **×280 real time** for
> a run that looked at zero frames.

⭐ The pinned branch of `LeastLoadedPlacement` already documents this exact trap and guards it. The
reasoning was never carried across to failover. The strategy needed no change — it needed the truth.

**Fix:** `services/camera/src/application/assignment-service.ts` — pass `doc.runtimeId`.
**Test:** `services/camera/test/assignment.test.ts` — fails without the fix; a second test asserts a
runtime full of *other* cameras is still refused, so the fix cannot decay into an overcommit bug.

### ⛔ V-2 · Offline analysis produced no tracking at all · **functional bug, critical**

The runtime's tracker skips frames whose capture time went backwards, keyed on `(tenant, camera)`.
An offline analysis stamps **footage** time, and footage time does not advance between runs.

Measured before the fix: **`framesTracked: 906` against `outOfOrderFrames: 1244`** — more frames
rejected than tracked. Two identical reruns raised the rejected count by exactly 120, the whole of
both runs. Five of eight clips finished with zero tracks.

⭐ **This is the fourth layer of one defect class.** Three mechanisms identified a stream as
`(tenant, camera)` + a forward-moving number; ADR-0047 fixed three of them. This was the fourth, and
it lives inside the runtime.

**Fix:** `ai/inference/runtime_tracking.py` — state keyed by `(tenant, camera, correlation_id)`.
Media attaches `correlationId` only to stored-media frames, so **live behaviour is byte-identical**.
**Verified:** `framesTracked 180 / outOfOrderFrames 0` across three reruns.

> ⚠️ The sharper edge: an analysis of footage dated *ahead* of now would have poisoned the live gate
> and silently stopped tracking the real camera. There is a test for that.

### ⛔ V-3 · Eight people produced the same event count as one · **functional bug, high**

`crowd` (8 people) produced **3 events and 0 tracks** — identical to a single walker. The dedup key
falls back to the subject **class** when there is no `trackId`, so all eight collapsed into one key
per 10 s bucket.

⭐ **Not a separate defect — a symptom of V-2, and the measurement that proved it.** After V-2:
**24 events, 8 tracks.** The finding that survives is that the dedup key's degradation mode *hides
scale*: without track ids, a crowd is indistinguishable from one person.

### ⛔ V-4 · Re-running an analysis produced no incidents · **functional bug, critical**

A five-minute recording raised **8 incidents on its first run and 0 on an identical second run**,
while its events, timeline and tracks all reproduced correctly.

`candidateDedupKey` is built from `tenant | rule | group | footage-time-bucket` and **ADR-0047 never
reached it**. Footage time never advances, so the collision is permanent.

> ⛔ This is the exact promise ADR-0047 makes — *"both analyses persisted independently, both
> independently queryable"* — holding for events and silently failing for incidents.

**Fix:** `services/rules/src/domain/incident.ts` — append `analysisSessionId` when present, so live
keys stay **byte-identical**. **Verified:** two identical runs → 20 events, 5 tracks, **10 incidents
each**.

### ⛔ V-5 · A presigned credential was returned in an error body · **security, high**

Uploading a text file renamed `.mp4` returned ffprobe's message verbatim — and ffprobe names the
input it failed on, which is a **presigned URL**. The HTTP 400 body carried `X-Amz-Credential`,
`X-Amz-Signature` and the internal endpoint `http://minio:9000`.

**A live, tenant-scoped read credential, obtainable on demand by anyone willing to upload a file that
will not open** — plus the storage topology, which is free reconnaissance.

**Fix:** `redactUrls()` in `analysis-service.ts`. ⚠️ Redacted, not discarded — ffprobe's diagnosis
survives, because an operator needs to know whether the file, the codec or the store was at fault.
**Verified:** `"ffprobe exited 1: <source>"`.

### ⛔ V-6 · Two navigation items were both labelled "Investigations" · **UX, medium**

`/investigations` (analyse a recording) and `/workspace` (work an existing incident) sat next to each
other in the same nav section under the same word. An operator clicking "Investigations" got
whichever they happened to hit.

⭐ **Found because the browser certification could not proceed** — a name-based locator matched two
elements and Playwright refused to guess. No unit test noticed, because each page renders perfectly
on its own; the defect exists only in the *relationship* between them.

**Fix:** "Recorded Video" and "Incident Workspace". Routes unchanged, so every bookmark still lands.
**Test:** asserts *no two nav items share a label or a destination* — a general rule, not a
restatement of these two.

---

## ⚠️ V-7 · Found, deliberately not fixed

**The timeline UI renders incidents only.** `entries`, `tracks` and `density` — the whole of slice
4's timeline model — are fetched, computed by the backend, and never displayed. The truncation
banner even reads *"Showing the first N events of a longer run"* for events that are never shown.

This is a **missing feature**, and the brief for this phase says: *do not implement new product
features during this phase*. So it is recorded, not built. It is the single largest gap between what
the platform computes and what a customer can see, and it is the first thing P-8.6 should close.

---

## Performance

Full numbers, hardware and method: **[PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md)**.

| | 1 min | 5 min | 10 min | 30 min |
| --- | --- | --- | --- | --- |
| Frames analysed | 121 | 600 | 1 200 | 3 600 |
| Analysis wall clock | 4.1 s | 29.6 s | 63.2 s | 197.1 s |
| Reported speed factor | ×8.8 | ×9.1 | ×9.0 | ×9.0 |
| Timeline query | 22 ms | 21 ms | 26 ms | 74 ms |
| Evidence still | 130 ms | 128 ms | 127 ms | 136 ms |
| media RSS | 141 MiB | 151 MiB | 160 MiB | 173 MiB |

⭐ **Speed factor is flat across a 30× range in duration**, and an evidence still costs the same at
30 minutes as at 1 — accurate seek is O(1) in recording length.

⚠️ Queue wait is a consistent **~3.5 s** regardless of size: the runner's poll interval, not load.

**Concurrency** — 1 · 2 · 5 · 10 simultaneous uploads. All complete, results identical, zero
findings. The queue serialises correctly (`maxConcurrent: 1`, [L-41]); 10 uploads took 50.7 s wall.

---

## Screenshots

`tools/e2e-browser/artifacts/screens/` — captured from the deployed system, nothing mocked.

| File | Shows |
| --- | --- |
| `p85-01-login.png` | The real login form over HTTPS |
| `p85-02-investigations.png` | The list, with limits stated **before** a file is chosen |
| `p85-05-running.png` | Progress moving mid-analysis |
| `p85-07-timeline.png` | ⭐ Run succeeded · **6.7× real time · 60/60 frames · 116 detections · yolox-nano**, the footage-time warning, and four incidents |
| `p85-08-evidence.png` | A real JPEG at a footage offset |
| `p85-09-empty-scene.png` | ⭐ *"Nothing was detected in this recording"* |
| `p85-10-demonstration.png` | Demonstration Mode pacing |
| `p85-sec-not-found.png` | A real 404 page, no stack trace |

---

## Remaining limitations

The full list is [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md). The ones that bear on a demonstration:

| | |
| --- | --- |
| **[L-1] No camera has ever been connected** | ⛔ Unchanged and unchangeable by this phase. Every vendor-compatibility statement is still a prediction |
| **[L-2] No behaviour detection** | person · vehicle · fire · smoke. Not theft, falls, fights or PPE |
| **[V-7] Timeline shows incidents only** | Events, tracks and density are computed and not rendered |
| **[L-63] Synthetic fixtures only** | ⚠️ **New.** Every clip is real person pixels on authored motion. Nothing here measures detector accuracy in a real venue — see [TEST_DATASET.md](TEST_DATASET.md) |
| **[L-64] Six real-venue recordings are unmet** | Shop, mall, warehouse, hospital, factory, car park |
| **[L-65] Analysis needs a live camera assignment** | ⚠️ **New.** Offline analysis of stored footage requires the camera to hold an AI assignment |
| **[L-66] 2 GB / 5 GB uploads not executed** | ⚠️ **New.** The ceiling is enforced and tested; a real multi-gigabyte transfer is not |
| **[TD-15] Stills are not under evidence custody** | `registeredAsEvidence: false`. The picture exists; retention does not yet apply |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| ⛔ Detector accuracy on real footage is unknown | **High** | **High** | [L-1]. Sell the workflow, let the pilot answer it. Procure the six recordings in [TEST_DATASET.md](TEST_DATASET.md) |
| A demo camera loses its assignment mid-demo | Medium | High | V-1 is fixed; watch `/api/media/perception/assignment` → `plannedCameras` before the demo |
| ⚠️ A run "succeeds" having analysed nothing | Medium | **High** | The finding is recorded honestly, but `succeeded` + a headline speed factor is what an operator sees first. **Open — see Recommendations** |
| Customer uploads a 3 GB file | Medium | Low | Refused before any bytes move, with the limit named |
| WebKit cannot play `hev1` | Low | Medium | [TD-29]. The dataset ships both tags; use `hvc1` for demos |

---

## Recommendations

1. **Close V-7** — render the timeline the backend already computes. Largest visible gap; P-8.6.
2. **⚠️ A run that analysed nothing must not present as an ordinary success.** The finding is
   recorded correctly, but state `succeeded` and "×280 real time" are what an operator reads first.
   This was the most misleading thing in the whole validation.
3. **Procure the six real-venue recordings.** Everything about accuracy is blocked behind them.
4. **Close TD-15's second half** — stills under evidence custody, so an export survives retention.
5. **Run the 2 GB upload once** on real hardware and record it.
6. **Add the assignment planner's recovery to the nightly**, so a V-1-shaped regression is caught by
   a schedule rather than by a customer.

---

## Go / No-Go

### 🟢 GO — supervised customer demonstration

Justified: the full journey works in four browsers against a real deployment; results are
reproducible and concurrent-safe; the platform refuses bad input with real reasons; and it does not
invent findings on an empty scene. The demonstration story in
[DEMO_VIDEO_LIBRARY.md](DEMO_VIDEO_LIBRARY.md) is backed by measurements in this document.

**Conditions.** Run [CUSTOMER_ACCEPTANCE_CHECKLIST.md](CUSTOMER_ACCEPTANCE_CHECKLIST.md) beforehand;
state [L-1] out loud; demo from the library, not from customer footage seen for the first time.

### 🔴 NO-GO — unsupervised production

Not because of anything found and left unfixed, but because of what has **not been measured**: no
camera has ever been connected ([L-1]), no real venue footage exists ([L-63], [L-64]), and detector
accuracy in a customer's building is unknown. Four of the six defects here were **critical and
invisible to 1 700 passing tests** — the honest inference is that a first real deployment will
surface more, and it should do so with an engineer watching.

**What would change this:** P-9 hardware certification, the six recordings analysed, V-7 closed, and
one supervised pilot completed without a critical finding.

---

## Related

- [PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md) · [TEST_PLAN.md](TEST_PLAN.md) · [TEST_DATASET.md](TEST_DATASET.md)
- [UAT_GUIDE.md](UAT_GUIDE.md) · [END_TO_END_TEST_GUIDE.md](END_TO_END_TEST_GUIDE.md)
- [CUSTOMER_ACCEPTANCE_CHECKLIST.md](CUSTOMER_ACCEPTANCE_CHECKLIST.md) · [DEMO_VIDEO_LIBRARY.md](DEMO_VIDEO_LIBRARY.md)
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) · [ADR-0047](../adr/ADR-0047-an-analysis-run-is-part-of-an-events-identity.md)
