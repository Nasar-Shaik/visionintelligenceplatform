# AI Pipeline Capability Audit

**What the platform computes, versus what it shows.** Produced 2026-08-07, read-only, against the
deployed production stack — no code was changed to write this.

## How this was measured

Every number below comes from **one real recording the Architect uploaded**, analysed **twice**:

| | |
| --- | --- |
| File | `10622415-uhd_2160_4096_25fps.mp4` — 43,359,551 bytes |
| Container / codec | `mp4` / `h264`, tag `avc1` |
| Frame | **2160 × 4096 portrait**, 25 fps source, 33.28 s |
| Analysis | `ana_90c5f94c8a664d5894355429f283d3c1`, camera `cam_retail_entrance` |
| Run 1 | `ases_07dea…0cbd66` · ×3.55 · 4 incidents |
| Run 2 | `ases_1078e…0527d` · ×3.42 · 2 incidents |
| Runtime | `yolox-nano`, `CPUExecutionProvider`, runtime `0.1.0`, pipeline `1.0.0`, capability `perception.person-detection`, analysis frame rate **2 fps** |

⚠️ Run 2 was started **by this audit** to answer "can I verify rerun reproducibility?". It is a real
second run on your analysis and it is expected to be there.

---

## ⛔ The one number that explains most of this document

```
   67 frames analysed
  285 detections returned by the runtime
   24 events persisted          ← 8.4% survive
    9 distinct footage offsets  ← 13% of frames leave any trace at all
```

**The platform does not store what it saw. It stores a sample of what it concluded.**

Event identity is `tenant | type | camera | zone | track | floor(occurredAt / 10s)` — so **one event
survives per track per 10-second bucket** ([L-57]). Everything downstream — the timeline, the track
lane, the density lane, the export report — is assembled from those 24, never from the 285.

⛔ **This is the single most important thing to understand before scoping the next feature.** Any UI
that draws boxes on video, plays back detections, or charts a trajectory needs data that is currently
**thrown away seconds after it is computed**. That is a persistence decision, not a UI task.

---

## The 18 stages

Legend: ✅ yes · ⚠️ partial · ⛔ no

| # | Stage | Implemented | Runs | Persisted | API | UI | Where the data is |
| --- | --- | :---: | :---: | :---: | :---: | :---: | --- |
| 1 | Frame decoding | ✅ | ✅ | ⚠️ counts only | ✅ | ✅ | `analysisSessions.counts` |
| 2 | Object detection | ✅ | ✅ | ⚠️ count + 8.4% | ✅ | ⚠️ count only | `analysisSessions.counts.detections`, `events` |
| 3 | Detection confidence | ✅ | ✅ | ✅ per event | ✅ | ⛔ | `events[].confidence` |
| 4 | Bounding boxes | ✅ | ✅ | ✅ per event | ✅ | ⛔ | `events[].subjects[].bbox` |
| 5 | Person tracking | ✅ | ✅ | ⚠️ id only | ✅ | ⛔ | `events[].subjects[].trackId` |
| 6 | Track IDs | ✅ | ✅ | ✅ | ✅ | ⛔ | same |
| 7 | Track lifetime | ✅ | ✅ | ⚠️ derived | ✅ | ⛔ | computed on read from `events` |
| 8 | **Track trajectory** | ✅ | ✅ | ⛔ **never** | ⚠️ live only | ⛔ | **runtime process memory** |
| 9 | Event generation | ✅ | ✅ | ✅ | ✅ | ⚠️ live only | `events` |
| 10 | Rule evaluation | ✅ | ✅ | ✅ | ✅ | ✅ | `rules`, `rule_versions` |
| 11 | Timeline generation | ✅ | ✅ | ⛔ by design | ✅ 4 lanes | ⚠️ 1 of 4 | assembled per request |
| 12 | Incident generation | ✅ | ✅ | ✅ | ✅ | ✅ | `incidents` |
| 13 | Evidence snapshots | ⚠️ | ✅ | ⚠️ object only | ⚠️ write-only | ✅ | MinIO `analyses/{id}/snapshots/…` |
| 14 | Analysis metadata | ✅ | ✅ | ✅ | ✅ | ⚠️ 3 of 10 | `analyses.asset` |
| 15 | Runtime statistics | ✅ | ✅ | ⛔ live gauge | ✅ | ⚠️ | runtime memory + `progress` |
| 16 | Session provenance | ✅ | ✅ | ✅ | ✅ | ⚠️ 1 of 6 | `analysisSessions.provenance` |
| 17 | Export contents | ✅ | ✅ | ⛔ assembled | ✅ | ⛔ **no button** | assembled per request |
| 18 | Investigation data | ✅ | ✅ | ✅ | ✅ | ⚠️ | `analyses` + `analysisSessions` |

---

## Stage detail — where the answer is not simply "yes"

### 1 · Frame decoding ✅ complete

ffmpeg decodes at `analysisFrameRate: 2`, not at the source's 25 fps: 33.28 s × 2 = 66.6 → **67
frames**. `framesDecoded: 67, framesAnalysed: 67, framesDropped: 0`.

⚠️ **You are seeing 2 of every 25 frames.** Not a defect — it is the declared sampling rate — but it
bounds everything: a person visible for 400 ms can cross the frame between two analysed frames and be
detected zero times. **Verify:** the `Frames` column reads `67 / 67`. Non-zero drops would be a
finding on the run.

### 2–4 · Detection, confidence, bounding boxes — computed and stored, invisible

A stored event carries **everything you would need to draw a box**:

```json
{ "confidence": 0.797689,
  "subjects": [{ "class": "person",
                 "bbox": [0.454124, 0.592513, 0.158532, 0.264006],
                 "trackId": "trk_…_3", "identityId": "trk_…_3" }],
  "payload": { "label": "person", "frameSeq": 1,
               "executionProvider": "CPUExecutionProvider", "runtimeVersion": "0.1.0" } }
```

Normalised `[x, y, w, h]`, so it is resolution-independent and works on your portrait 4K unchanged.

⛔ **The timeline API deliberately drops it.** A timeline `entry` is `{eventId, type, occurredAt,
offsetSeconds, label, confidence, trackId}` — **no bbox**. So even a UI that rendered the timeline's
event lane still could not draw boxes without a second call to the events API.

⭐ **A `DetectionOverlay` component already exists** (`apps/console/src/ui/soc/detection-overlay.tsx`)
— normalised coords → `%`, label and confidence badge — and `video-player-container.tsx` accepts an
overlay layer. Both are used **only in the design-system gallery** (`/design`). The renderer is built
and wired to nothing.

⚠️ **The model is not person-only.** Deployment totals show `detectionsByLabel: {person: 23805,
kite: 8, keyboard: 3}` — COCO classes. `person`/`pedestrian` → `perception.person.detected`,
vehicles → `perception.vehicle.detected`, fire/smoke likewise, and **everything else falls back to
`perception.object.detected`**. Nothing is discarded; it is retyped.

### 5–7 · Tracking, ids, lifetime — ⚠️ the lifetime you can see is a lower bound

Tracker: `predictive-iou`, `minIou 0.3`, `minHits 2`, `maxAgeFrames 8`, `reentryGapSeconds 12`.

Your run produced **10 tracks**. The timeline reports each as:

```json
{ "trackId": "trk_…_1", "label": "person",
  "fromOffsetSeconds": 0, "toOffsetSeconds": 6, "observations": 2, "peakConfidence": 0.875576 }
```

⛔ **`observations: 2` does not mean the tracker saw this person twice.** It means two *events
survived dedup*. The tracker's own record says `age: 59, hits: 56`. So a track shown as "0 → 6 s,
2 observations" may have been continuously tracked for 30 seconds across 56 frames. **The timeline's
track lane understates every track it shows**, and there is currently nothing on screen that says so.

### 8 · Track trajectory — ⛔ computed, then discarded

This is the largest gap between capability and product. The runtime keeps, per track:

```json
{ "bbox": […], "firstSeen": {"frameIndex": 1, "at": "…"},
  "lastSeen": {"frameIndex": 60, "at": "…"}, "age": 59, "hits": 56,
  "quality": {"trackingConfidence": 0.959868, "predictionFrames": 0, "lostFrames": 4},
  "history": [{"frameIndex": 7, "at": "…", "bbox": […], "centroid": [0.192927, 0.683667]}, …] }
```

⭐ **`history[]` is the trajectory** — per-frame bbox *and* centroid, ready to draw as a path.

⛔ **It lives in the runtime process's memory and nowhere else.** Capped at `historyMax: 50` frames,
and evicted as tracks retire (`removedTracks: 325` on this host). **Measured during this audit: your
run's tracks are already gone** — `/api/media/perception/tracking/tracks` returns 4 tracks, none from
`ases_07dea…`. There is no `tracks` collection in any database.

**So:** trajectory is available for a run that is *happening now*, and permanently unavailable for one
that finished. Also note these are the **live** endpoints — they are not scoped to an analysis.

### 9 · Event generation ✅ stored, ⚠️ unreachable in the UI

24 envelopes in `events`, each with `analysisSessionId` and `correlationId` set to the run.

⭐ **The API can select them** — `GET /api/events/events?analysisSessionId=…` returns all 24 with
bboxes, and there is an `includeAnalyses` flag for an unfiltered read. ⛔ **The console's Events page
sets neither**, and the store excludes analysis events by default (`analysisSessionId: {$exists:
false}`). That exclusion is correct and deliberate — an investigation of last month's footage must not
flood the live feed — but it means **offline events have no UI anywhere**.

### 11 · Timeline generation — ⚠️ four lanes computed, one rendered

The API returns, for your run: `entries` **24**, `tracks` **10**, `density` **120 buckets**,
`incidents` **4**, plus `truncated` and `incidentsAvailable`.

⛔ **The page renders `incidents` only.** This is **V-7 / TD-69**, already the top item for P-8.6.

⚠️ Two details worth knowing before that work is scoped:
- `density` counts **events (24)**, not detections (285) — it is an *event* density lane.
- The truncation banner reads *"Showing the first N events of a longer run"* about events that are
  never shown.

⭐ Nothing is stored: the timeline is assembled per request from the events, so it can never disagree
with them.

### 13 · Evidence snapshots — ⚠️ real images, no custody, no list

Works: ffmpeg seeks to the offset, writes JPEG to
`analyses/{analysisId}/snapshots/{sessionId}-{ms}.jpg`, returns a presigned URL. Keyed by **run**, so
two analyses cannot overwrite each other's stills.

⛔ **`registeredAsEvidence: false`** — deliberately honest. No retention, no chain of custody, no
place in an export ([TD-15], half-paid). ⛔ **No database record and no list endpoint**: a still you
captured yesterday cannot be enumerated. Re-capturing the same offset rewrites the same key, so you
can get it back — if you know it existed.

### 14–16 · Metadata, runtime stats, provenance — stored in full, surfaced in part

**Provenance stored** (6 fields): `capabilityId`, `pipelineVersion`, `runtimeVersion`, `modelId`,
`executionProvider`, `analysisFrameRate`. **Shown:** `modelId`.

**Asset stored** (10 fields): originalName, bytes, container, codec, **codecTag**, width, height,
sourceFrameRate, durationSeconds, key. **Shown:** filename, camera, footage start.

**Per-run progress stored:** `mediaOffsetSeconds`, `framesProcessed`, `throughputFps` (7.11),
`speedFactor` (3.55), `etaSeconds`, **`etaUnavailableReason`**. **Shown:** speed factor.

⭐ The runtime gauge (`/api/media/perception/runtime`) is genuinely rich — `offered`, `delivered`,
`droppedNoImage`, `droppedQueueFull`, `failed`, `inflight`, `queueDepth`, `deliverMsAvg`,
`inferenceMsAvg` (48.3 ms), `detectionsByLabel`, `framesWithDetections` — but it is a **live gauge for
the whole host**, not a per-run record. Once your run ends, its share of those numbers is unrecoverable.

⚠️ **`counts.events` and `counts.incidents` are `0` on the session API** for a run whose timeline holds
24 and 4. Nothing writes them. The **export report overrides both correctly** (24 / 4). [TD-72].

### 17 · Export — ✅ complete, ⛔ no way to reach it

`GET /api/media/analyses/:id/report` returns everything a defensible record needs: source, footage
start **and its source**, analysis start/finish, all six provenance fields, corrected counts, all
findings verbatim, all incidents, all 10 tracks, `truncated`, `incidentsAvailable`, `generatedAt`,
`generatedBy`.

⛔ **There is no button.** `investigationsApi.report()` exists, `useReport()` exists — **and no
component calls it**. Same for `investigationsApi.playback()`, which returns a working presigned URL
for the source video: no hook, no player. **You cannot watch the video you uploaded.**

⚠️ The report contains `tracks` and `incidents` but **not `entries`** — the 24 events are not in the
export.

---

## What you can test today, by hand

| Question | Today | How |
| --- | :---: | --- |
| Does one person keep the same Track ID? | ⚠️ **Indirectly** | API only. `GET /api/events/events?analysisSessionId=…` and group by `subjects[].trackId`. Your run: 10 tracks over 24 events. ⛔ You cannot see this in the UI, and you cannot confirm it is the *same* person without boxes to look at |
| Can I see confidence scores? | ⛔ **Not for uploads** | Present on every event and on every timeline entry; the Events page has a Confidence column but excludes analysis events. API: `entries[].confidence` |
| Can I see bounding boxes? | ⛔ **No** | Stored on all 24 events. No UI renders them, though `DetectionOverlay` exists |
| Can I replay detections? | ⛔ **No** | Two blockers: no video player is wired, and only 8.4% of detections were kept |
| Can I jump to incidents? | ✅ **Yes** | Timeline rows show `mm:ss` footage offsets. ⚠️ It is a *label*, not a link — nothing to click through to |
| Can I inspect evidence? | ✅ **Yes** | **Capture still** on any timeline row → a real JPEG at that footage offset, captioned with footage time. ⚠️ Not listable afterwards |
| Can I verify timeline accuracy? | ✅ **Yes** | Compare `offsetSeconds` against `footageStartedAt + offset`. Your run: incidents at 00:00 and 00:16 = `20:18:44Z` and `20:19:00Z`. ⭐ Do check the amber banner first — the start came from file metadata, unconfirmed |
| Can I compare two analyses of the same video? | ⚠️ **Manually** | Click either row in **Runs**; the timeline switches to that run and never merges them. ⛔ No side-by-side, no diff |
| Can I verify rerun reproducibility? | ✅ **Yes — and I did** | Run 2 returned `67/67/0` frames, **285** detections, **24** entries, **10** tracks, **120** density buckets and **byte-identical confidences**. Incidents differed (4 → 2) **because I changed the rules between runs** — which is the correct behaviour: incidents belong to the rule set at the time of the run |
| Can I verify event ordering? | ⚠️ **API only** | Events return newest-first by `occurredAt` in **footage** time. Your 9 distinct offsets: 0, 0.5, 2, 6, 9.5, 10, 16, 20.5, 26 s |
| Can I inspect analysis metadata? | ⚠️ **Partly** | UI: filename, camera, footage time, frames, detections, model. ⛔ Not shown: resolution, codec, duration, file size, five of six provenance fields, throughput, ETA reason |
| Can I export results? | ⛔ **Not from the UI** | The endpoint is complete. `curl` it with a bearer token |

### The one command that shows you everything the UI hides

```bash
TOKEN=$(curl -sk -X POST https://localhost/api/identity/auth/login \
  -H 'content-type: application/json' -H 'x-tenant-id: tnt_demo_retail' \
  -d '{"email":"security.manager@northgate.demo","password":"12345678"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')

# the four timeline lanes — three of which never reach a screen
curl -sk "https://localhost/api/media/analyses/<ANALYSIS_ID>/timeline" \
  -H "authorization: Bearer $TOKEN" | python3 -m json.tool

# every detection that survived, WITH bounding boxes
curl -sk "https://localhost/api/events/events?analysisSessionId=<SESSION_ID>&limit=100" \
  -H "authorization: Bearer $TOKEN" | python3 -m json.tool

# the export report that has no button
curl -sk "https://localhost/api/media/analyses/<ANALYSIS_ID>/report" \
  -H "authorization: Bearer $TOKEN" | python3 -m json.tool
```

---

## Built in the backend, absent from the UI

Ranked by how much product each unlocks per unit of work. **No development is proposed here** — this
is the inventory.

| | What exists | What is missing | Effort |
| --- | --- | --- | --- |
| 1 | Timeline `entries` · `tracks` · `density` — computed every request | Three lanes of rendering. **[V-7 / TD-69]** | UI only |
| 2 | `investigationsApi.playback()` → working presigned source URL | A `<video>` element. **You cannot watch your own upload** | UI only |
| 3 | `investigationsApi.report()` **and** `useReport()` | A button, and a download | UI only |
| 4 | `DetectionOverlay` + `video-player-container` overlay slot | Wiring, and bboxes on the timeline projection (they are on the events) | UI + 1 field |
| 5 | 5 of 6 provenance fields, 7 of 10 asset fields, `throughputFps`, `etaUnavailableReason` | A metadata panel | UI only |
| 6 | `GET /events?analysisSessionId=` and `includeAnalyses` | The Events page never sets either | UI only |
| 7 | Runtime `history[]` — per-frame bbox and centroid | ⛔ **Persistence.** Memory-only, capped at 50 frames, evicted on completion | **Backend** |
| 8 | 285 detections computed per run | ⛔ **Persistence.** 8.4% survive dedup; the rest are never written | **Backend** |
| 9 | Snapshot capture to object storage | A record, a list endpoint, evidence custody. **[TD-15]** | Backend |
| 10 | `counts.events` / `counts.incidents` correct in the report | The session API still says `0`. **[TD-72]** | Contract decision |

⭐ **Six of the ten are UI-only work against APIs that already return the data.** That is the headline
of this audit: the perception pipeline is substantially ahead of the product surface.

⛔ **Two are not.** Trajectory and full-detection replay require **storing data the platform currently
computes and discards**, and that is a schema, retention and cost decision — 285 detections per 33
seconds of one camera at 2 fps extrapolates to roughly 8.5 M rows per camera-day at 25 fps.

---

## What is genuinely absent

So the audit is not read as a list of things merely unshown:

- ⛔ **No behaviour detection** — loitering, theft, crowding, queueing all exist as *rule vocabulary*
  and event types; nothing produces those events. **[L-2]**
- ⛔ **No schedule condition** — "after hours" cannot be expressed. **[L-67]**
- ⛔ **No re-identification across cameras** — `identityId` is currently the track id.
- ⛔ **No zone data on this run** — `zonesLoaded: 0`; incidents carried `zone: -`.
- ⛔ **No live camera has ever been connected.** **[L-1]**

---

## Related

- [FIRST_PRODUCT_VALIDATION](FIRST_PRODUCT_VALIDATION.md) — V-1…V-10 and the Go/No-Go
- [KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md) — L-1, L-2, L-57, L-63, L-67
- [tracking/TECH-DEBT.md](../../tracking/TECH-DEBT.md) — TD-15, TD-69, TD-70, TD-72
- [ADR-0047](../adr/) — an analysis run is part of an event's identity
- [ADR-0048](../adr/ADR-0048-a-tracked-stream-is-not-always-a-camera.md) — a tracked stream is not always a camera
