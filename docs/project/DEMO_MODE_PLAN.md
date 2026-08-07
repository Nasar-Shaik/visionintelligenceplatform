# Demonstration Mode — the plan

**From "here is a box around a person" to "here is what the product does about it."**

**Written 2026-08-07**, extending the Customer Demonstration Mode delivered in
[P-9 Track A A10](P9_TRACK_A_CLOSEOUT.md). This plans work; it authorises none of it.

> ⭐ **The governing rule, and it is the whole document: a demonstration may not contain a single
> feature the product does not have.** Every mocked panel is a promise somebody will be held to at a
> pilot, by a customer holding a screenshot. This platform's entire culture is that a matrix cell goes
> ✅ only with deployment evidence; a demo is a capability matrix somebody can see.

Related: [PRODUCT_READINESS](PRODUCT_READINESS.md) · [OFFLINE_VIDEO_PLAN](OFFLINE_VIDEO_PLAN.md) ·
[DEMO_GUIDE](../demo/DEMO_GUIDE.md) · [DEMO_DATASET](../demo/DEMO_DATASET.md)

---

## 1 · What exists today

**`ai/inference/demo_cli.py`** (P-9 A10). A standalone Python HTTP server that opens a source, runs
detection and tracking, draws boxes and labels, and serves the result as MJPEG at
`multipart/x-mixed-replace`. It supports `--source rtsp | usb | file`, an in-process engine or the
**deployed runtime** via `--inference-url`, and `--measure` for a headless run.

⭐ **It achieved something no other part of this platform had**: real-world pixels reaching the
perception path — a real lens, the deployed ONNX runtime, 18 fps, ~80 ms inference, tracked identity.
Measured at 308 frames, 143 detections, 1 identity.

⚠️ **And it answers exactly one question: "is the AI real?"** It bypasses the platform entirely. No
events, no rules, no incidents, no evidence, no console. A prospect watching it sees a computer-vision
demo, not a security product — and the gap between those two is where the deal is.

---

## 2 · Two modes, and keeping them apart is the design

|                    | **Mode A — Runtime Preview**        | **Mode B — Product Demonstration**         |
| ------------------ | ----------------------------------- | ------------------------------------------ |
| **Question**       | "Is the AI real?"                   | "What does the product _do_ about it?"     |
| **Audience**       | A technical evaluator, an installer | A security manager, a buyer                |
| **Path**           | `demo_cli.py` → `/infer` → MJPEG    | ⭐ **The console, over the real chain**    |
| **Status**         | ✅ **Shipped** (P-9 A10)            | ⚠️ To build                                |
| **Truthfulness**   | Total — it renders what it measured | Total — every panel is a real product page |
| **Where it lives** | A CLI, run beside the browser       | `/demo` in the console                     |

⛔ **Mode A is not deprecated and must not be folded into Mode B.** It is the installer's instrument
(A7/A9), it runs when the platform is not deployed, and it is the fastest possible answer to _"does
this camera work?"_. Two tools, two questions.

⭐ **Mode B's implementation is: register the demo source as a real camera, and show the real screens.**
Nothing is simulated. The incidents in the incident panel are `Incident` documents raised by the rules
service through the frozen lifecycle. If the demo works, the product works, because they are the same
code — which is the only demo worth giving.

---

## 3 · ⚠️ What was asked for, and what actually exists

Eleven requested elements, mapped to the code. **Nine exist. Two do not, and they must not be faked.**

| Requested             | Reality today                                                                        | New work                                                     |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **USB webcam**        | ✅ `demo_cli.py --source usb`; not registrable as a platform camera                  | ⚠️ **Demo ingest shim** — §4.1                               |
| **RTSP stream**       | ✅ Full camera onboarding, recording, assignment, analysis                           | None                                                         |
| **Recorded MP4**      | ⛔ C-21 — no upload path anywhere                                                    | ⭐ **Inherited from [Offline Video](OFFLINE_VIDEO_PLAN.md)** |
| **Live overlays**     | ⛔ **TD-28 — no live transport exists.** No browser plays RTSP                       | ⚠️ **A decision, not a task** — §4.2                         |
| **FPS**               | ✅ AI Runtime page, `/metrics`, frame-sink stats                                     | Surface it on one page                                       |
| **Inference time**    | ✅ `inferenceMsAvg`, `frameLatencyMsAvg`, reported by the runtime's own clock        | Surface it                                                   |
| **Tracking IDs**      | ✅ Live Tracks, Track Detail, Track Timeline, Runtime Track Statistics — 4 pages     | None                                                         |
| **Rule state**        | ✅ Live Rule Status page, `LiveDwellTimer` (`accumulating` ▸ `met` ▸ `cooling-down`) | None                                                         |
| **Incident panel**    | ✅ Incidents page, frozen lifecycle, assignment, SLA                                 | None                                                         |
| **Timeline**          | ✅ Incident timeline, investigation workspace, playback timeline                     | None                                                         |
| **Evidence snapshot** | ⛔ **TD-15 — the extractor is a no-op.** Nothing is captured at incident time        | ⛔ **A real gap** — §4.3                                     |
| **Export report**     | ⛔ **C-47/C-48 — no generator, no packager.** C-46 has no worker                     | ⛔ **A real gap** — §4.4                                     |

⭐ **The two ⛔ rows are the finding of this document.** A "polished customer demo" that shows an
evidence snapshot and a PDF report is not polish — it is **two unbuilt milestones**. There are exactly
three honest options, and the recommendation is the second.

---

## 4 · The four decisions

### 4.1 ⚠️ USB and file sources must become _cameras_, not a parallel path

The chain begins at `StreamConnection` and everything downstream — assignment, zones, rules, incidents
— is keyed on a `cameraId`. A demo source that is not a camera cannot reach any of it.

**Decision: a demo source is registered as an ordinary camera whose `streamUrl` is a local device or a
file.** The ffmpeg decoder already branches `conn.protocol === 'rtsp' ? [...] : ['-i', url]`, so a
non-RTSP input is already a supported shape. What is needed:

- A camera **kind** (or a `protocol` value) that means "this is a demonstration source", so it is
  visibly not a real camera on the estate — ⚠️ additive, and it must be **visible in the console**, not
  a hidden flag. A demo camera that looks like a production camera is how a demo dataset ends up quoted
  as a deployment.
- ⛔ **The media container must be able to see the device.** On Linux, `--device /dev/video0`. On macOS,
  Docker Desktop **cannot** pass a host camera into a container — measured in P-9 A9 — so on macOS the
  USB path runs `demo_cli.py` on the host with `--inference-url`, and that is Mode A. **State the
  platform limitation; do not build around it.**

**Recommendation:** ⭐ **file and RTSP first, USB last.** A recorded MP4 gives a _repeatable_ demo, and
a demo that depends on a webcam, a room's lighting and a volunteer walking past is a demo that fails in
front of a customer.

### 4.2 ⛔ "Live overlays" cannot be the product's live view, and the demo must say so

There is no live video transport (C-22, TD-28) and no ADR for one. Three options were considered:

| Option                                      | Verdict                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Build HLS/WebRTC now                        | ⛔ **No.** It is a service-sized decision needing its own ADR, and it is P-8's named dependency, not a demo task |
| Fake it with a looping video                | ⛔ **Absolutely not.** A fake live view is the single most damaging thing on this list                           |
| ⭐ **MJPEG side channel, labelled as such** | ✅ **Recommended.** It is what A10 already does, it is honest, and the label is part of the demo script          |

**Decision:** the demo's moving picture is **MJPEG from the demo ingest**, rendered in a panel that
says _"Preview — MJPEG. The product's live view arrives with the transport ADR (TD-28)."_ ⚠️ The panel
is **not** on `/live` and does not pretend to be. `/live` continues to tell the truth (P-6 item 9).

⭐ **Say it out loud during the demo, before anyone asks.** A limitation you disclose is a credential;
a limitation they discover is a defect.

### 4.3 ⛔ Evidence snapshot — TD-15, and it is now unblocked

`IncidentEvidenceExtractor` is a **no-op**. It was deferred because it needed the media frame source,
which did not exist. ⭐ **It exists.** Frames have flowed since P-8 Phase 2, and the runtime returns
detections with boxes.

⚠️ **This is the single most demo-visible missing feature in the product.** An incident that says
_"person, zone Checkout, 94 s"_ with no picture beside it is an incident an operator does not trust.

**Recommendation: pull TD-15 forward and scope it to a snapshot only.** Capture one key frame at
`incident.raised`, register it through the real evidence API with a real custody entry and a real
integrity hash. ⛔ **Not a ring-buffer clip** — that is a media feature with its own memory budget and
it is not needed to make an incident credible.

⚠️ **This is a product decision to make explicitly, not a demo task to absorb.** It is roughly 2–3
days, it closes long-standing debt, and it benefits every deployment — but it is not free and it is not
"the demo".

### 4.4 ⛔ Export report — do not build it for the demo

C-47 (report generation) and C-48 (signed export bundles) are **P-11**, and both need C-46's job
runner, which the [Offline Video](OFFLINE_VIDEO_PLAN.md) milestone builds first.

**Decision: the demo shows what exists — evidence download with independent integrity verification
(C-49, production-verified)** — and the demo script names the report as the next milestone. ⛔ **Never
demo a PDF that a script generated.** The moment a prospect asks for that PDF, it is a commitment.

⭐ **Once the offline-video job runner lands, a report is a small increment on top of a frozen
`ReportModel`** and it can join the demo honestly. Sequence, do not fake.

---

## 5 · The demonstration, as a product

### 5.1 One route, made of existing pages

`/demo` — an operator-facing **run sheet**, not a new application:

```
┌─ Demo Control ─────────────────────────────────────────────────────┐
│  Source  ( ) Recorded MP4   ( ) RTSP camera   ( ) USB webcam       │
│  Camera  [ Demo — Store 3 Checkout ▾ ]   Zones: 2   Rules: 1       │
│  [ Start ]  [ Reset demo data ]   ⚠️ Preview is MJPEG (TD-28)      │
├────────────────────────────┬───────────────────────────────────────┤
│  Preview  (MJPEG, labelled)│  Runtime      18 fps · 80 ms · onnx   │
│                            │  Tracks       #1 00:42 · #2 00:07     │
│   [ boxes + track ids ]    │  Rule state   Checkout dwell  ▓▓▓░ 71 s│
│                            │  Incidents    ▲ 1 raised              │
├────────────────────────────┴───────────────────────────────────────┤
│  Timeline   ──────▲──────────────────▲────────────────────────     │
└────────────────────────────────────────────────────────────────────┘
      every panel is a live read of the same API the real page uses
```

⚠️ **Each panel is a component extracted from the page that already owns it**, not a re-implementation.
If the Live Rule Status page changes, the demo panel changes with it — otherwise the demo drifts from
the product and nobody notices until it is in front of a customer, which is exactly what happened to
the demo seeder (TD-55).

### 5.2 The seven-minute script

| Min | Beat                              | Screen                       | ⚠️ Say                                                                |
| --- | --------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| 0–1 | "Your estate"                     | Locations, Cameras           | 8 levels, any of them skippable                                       |
| 1–2 | "This is a real model"            | Demo preview + AI Runtime    | ⚠️ "Preview is MJPEG; live view is the next transport milestone"      |
| 2–3 | "It knows _who_, not just _what_" | Live Tracks                  | ⚠️ "Identity does not follow a person between cameras" (L-43)         |
| 3–4 | "You describe the policy"         | Zone editor, rule template   | ⚠️ "The zone is on a picture, not a floor" (L-58)                     |
| 4–5 | "It watches, and it waits"        | Live Rule Status             | ⭐ The dwell bar filling is the most persuasive object in the product |
| 5–6 | "Something happened"              | Incidents → Workspace        | Timeline, custody chain, evidence, integrity hash                     |
| 6–7 | "And the limits"                  | KNOWN_LIMITATIONS, on screen | ⭐ **Do this deliberately.** It is the strongest minute of the seven  |

⭐ **Minute 6–7 is not a risk; it is the differentiator.** Every competitor's demo ends at minute 6.

### 5.3 Repeatability

| Need                     | Mechanism                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Reset**                | ✅ `infra/docker/demo.sh reset` (C-62). ⚠️ Rebuild the seeder image first — **TD-55**                                                                                                |
| **Deterministic source** | ⭐ A recorded MP4, not a webcam. Same file, same incidents, every time                                                                                                               |
| **Offline capable**      | Everything is local — Docker, MinIO, the model inside the image. ✅ No internet required                                                                                             |
| **Pre-flight**           | ⭐ A `demo doctor` check: containers healthy, seed current, camera assigned (L-54), rule enabled, zone enabled, source reachable. **Run it before the customer arrives, not during** |
| **Honest dataset**       | ⚠️ TD-41 — the demo data is invented and marked so. Never present it as a deployment                                                                                                 |

---

## 6 · Implementation order

| #     | Slice                                    | Depends on               | Days | Value                                                                                    |
| ----- | ---------------------------------------- | ------------------------ | ---- | ---------------------------------------------------------------------------------------- |
| **1** | **Demo pre-flight (`demo doctor`)**      | nothing                  | 0.5  | ⭐ Highest value per hour in this document — it prevents the demo that fails in the room |
| **2** | **Demo camera kind + file source**       | nothing                  | 1    | A repeatable, deterministic demo                                                         |
| **3** | **`/demo` run sheet**                    | 2                        | 2    | The panels, all extracted not rebuilt                                                    |
| **4** | **MJPEG preview panel, labelled**        | 2                        | 1    | The moving picture, honestly framed                                                      |
| **5** | **Recorded MP4 as a first-class source** | ⭐ **Offline Video**     | 0    | Inherited free                                                                           |
| **6** | **USB webcam ingest**                    | 2 · ⛔ Linux host only   | 1    | ⚠️ Lowest value, highest fragility. **Last**                                             |
| **7** | **Evidence snapshot (TD-15)**            | separate decision — §4.3 | 2–3  | ⭐ Closes debt; benefits every deployment                                                |

**Total: 5.5 days**, or 8 with TD-15. ⚠️ **Slices 3–5 are worth far more after Offline Video ships**,
because "upload your own footage and watch it become incidents" is a better demo than any prepared
file — and it is the customer's own video.

---

## 7 · Verification

⚠️ **A demo is not exempt from the eight deliverables.** It is the most customer-visible surface the
product has, and its failure mode is public.

- **Browser**: a Playwright walk of `/demo` that starts a source, waits for a real incident, and
  asserts every panel has non-placeholder content. ⭐ **Including the honesty labels** — a test that
  fails when the MJPEG disclaimer is removed.
- **Deployment**: the whole script, run against the production stack on a clean tree, end to end.
- **Mutation**: (1) remove the MJPEG label (2) seed a fabricated incident (3) leave the camera
  unassigned. **Each must turn the verification red.**
- **Nightly**: `stages/demo/run-sheet.sh` — ⭐ the demo is checked every night, so it is never
  discovered broken on the morning of a customer visit.
- **Governance**: C-62 extended, TD-41 and TD-55 referenced, TD-15 closed if §4.3 is approved.

---

## 8 · ⛔ What this plan refuses to do

| Refused                                          | Why                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| A **fake live view**                             | The single most damaging thing that could be built here                                         |
| A **fabricated PDF report**                      | The moment it is shown, it is a commitment                                                      |
| **Seeded incidents presented as detections**     | The demo dataset already caused this once (TD-55) and it was caught by a check, not by a person |
| A **separate demo UI** with its own components   | It drifts from the product silently and is discovered by a customer                             |
| **Numbers not measured** — accuracy, uptime, mAP | TD-64 and ADR-0039. There is no accuracy number and one must not appear on a screen             |
| **Hiding the limitations screen** under pressure | It is minute 6–7 and it is the reason the other six are believed                                |
