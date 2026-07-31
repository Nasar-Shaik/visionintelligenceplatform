# AI-2 — Object Tracking + Zones + Entry/Exit Counting

> **Milestone:** AI Processing Phase **AI-2** · **Status:** ✅ code + tests complete · ⏳ **Architect review pending**
> **Scope:** add continuous object identity (**Tracks**), generic **Zones**, and business-neutral
> **entry/exit + occupancy counting** to the AI-1 pipeline — **in `ai/inference`, no new service**.
> **North star (Architect):** _optimize for the Track contract, not the tracker._
> Reference: [AI_EXECUTION_ARCHITECTURE](../architecture/future/AI_EXECUTION_ARCHITECTURE.md) · [ED-0036](../project/ENGINEERING_DECISION_LOG.md). **Author:** Claude · _2026-07-31_

---

## 1. Architecture — the tracker is replaceable; the contract is the product

```
Detection → [TrackerAdapter: associate] → [TrackManager: lifecycle] → Zone Engine → Counting Engine → Event Generator
                     (swappable)                (platform-owned)        (geometry)     (analytics)        (EventEnvelope)
```

The decoupling that makes IoU → ByteTrack → BoT-SORT → DeepSORT → OC-SORT → custom interchangeable with
**zero downstream impact**:

- **`TrackerAdapter`** ([tracker.py](../../ai/inference/tracker.py)) does **association only** — "which
  detection is which existing track?" — returning a pure `Association` (indices + scores). No track
  objects, no state, no lifecycle cross this boundary. AI-2 ships the deterministic `IouAssociator`.
- **`TrackManager`** ([track_manager.py](../../ai/inference/track_manager.py), Architect rec 1) owns
  everything else: the active-track store + lookup, lifecycle transitions, expired cleanup + a bounded
  archive, **bounded history pruning** (max points and/or time window), **trackId allocation**, a
  lifecycle-transition log, and aggregate **observability** stats.
- Only the platform-owned **`Track`** ([`@vip/contracts/tracking`](../../packages/contracts/src/tracking/tracking.ts))
  comes out — consumed by zones/counting/events/rules/dashboard, none of which know the tracker.

## 2. Platform primitives (contract-first, +4 → 59 schemas)

- **`Track`** — continuous identity, DISTINCT from `Detection` (one observation): `trackId · tenantId ·
cameraId · sessionId? · label · state · confidence · bbox · centroid · firstSeen · lastSeen · age ·
hits · quality · history[] · attributes`.
- **`TrackState`** lifecycle: `created → tentative → confirmed → lost → removed`.
- **`TrackQuality`** (additive, not business logic): `trackingConfidence · occlusionRatio · visibility ·
predictionFrames · lostFrames`.
- **`Zone`** — PURE geometry + metadata (`kind: area|line`, normalized `geometry.points`, generic
  `attributes`). No business zone types; meaning is the Rule Engine's.
- **`ZoneTransition`** / **`CountingSnapshot`** — business-neutral crossings + occupancy.
- **`RuntimeMetrics`** extended additively with tracking observability (active/confirmed/tentative/lost/
  removed tracks, avg age/lifetime/length/velocity, zoneCrossings, countingRate, detectionFps, frameDrop%).

**Track-ID policy** (documented in the contract): unique per **tenant → camera → session**, monotonic,
**never reused within a session**, session-scoped (not durable identity). `sessionId` + `cameraId` ride
on every Track/transition (multi-camera-ready).

## 3. Recommendations — where each landed (22 total across the AI-2 reviews)

| Theme                   | Recommendation                                                          | Where                                                                    |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Tracker independence    | optimize for the Track contract; no tracker object crosses the boundary | `TrackerAdapter` returns only `Association`; `Track` is the only output  |
| TrackManager            | separate association from lifecycle                                     | `track_manager.py` owns lifecycle/store/cleanup/ids/history              |
| Track vs Detection      | keep identity independent                                               | contract doc + no `trackingId` back-fill into detections                 |
| Track-ID policy         | uniqueness/lifetime/reuse/reset/persistence                             | documented in `Track` contract; `trk_{camera}_{session}_{seq}`           |
| Track quality           | occlusion/visibility/prediction/lost                                    | `TrackQuality` (additive)                                                |
| Bounded history         | max points / time window                                                | `history_max` (deque) + optional `history_window_seconds`                |
| Generic zones           | geometry only, no counting inside                                       | `ZoneEngine` (point-in-polygon, line-cross) — zero counting              |
| Confirmed-only counting | no double counting                                                      | `CountingEngine` counts `confirmed` tracks only                          |
| Event confidence        | derived from track quality                                              | `ZoneTransition.confidence` → event `confidence`                         |
| Coordinate seam         | pixel→world pluggable                                                   | `CoordinateTransform` + `IdentityTransform` (no-op)                      |
| AI observability        | tracking metrics into RuntimeMetrics                                    | `TrackManager.stats()` → additive `RuntimeMetrics` fields                |
| Multi-camera            | retain tenant/camera/session everywhere                                 | on `Track`, `ZoneTransition`, every event                                |
| AI-3 seam               | future Behavior stage consumes Tracks                                   | zones/counting consume Tracks; documented insertion point                |
| Playground diagnostics  | tracks.json + overlays                                                  | `tracks.json` (lifecycle+history+transitions) + `--diagnostics` overlays |
| Boundaries              | runtime = perception only                                               | emits only `EventEnvelope`s; never incidents                             |

## 4. AI Playground (rec 7/8)

`POST /playground/analyze` and the CLI now return/emit tracks + zone transitions + counting + stats.
New artifact **`tracks.json`** (Track Replay): per-track identity + quality + **bounded history** +
**lifecycle transitions** + zone entry/exit timestamps + counting + observability stats. `--zones FILE`
(generic geometry), `--session`, `--no-tracking`, `--track-min-hits/--track-max-age`, and `--diagnostics`
(annotated overlays: track IDs, confidence, zone boundaries, frame#/timestamp/FPS/stage-timings).

Smoke (deterministic, synthetic): `6 frames → 1 confirmed track (created→tentative→confirmed) → entered a
central zone at frame 2 → 1 transition + 1 occupancy event; 8 events total; trackId
`trk_cam_playground_sess_demo_1``.

## 5. Tests (deterministic, stdlib — no OpenCV/GPU/model)

| Suite                        |      Count | Covers                                                                                                                                                                                                                              |
| ---------------------------- | ---------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts `tracking.test.ts` | 8 (of 136) | Track/Zone/lifecycle/quality/transition/counting shapes                                                                                                                                                                             |
| Python `test_tracking.py`    |         16 | IoU association, TrackManager lifecycle + id-policy + bounded history, ZoneEngine geometry, CountingEngine (confirmed-only, enter/exit/occupancy), tracking events, analyzer integration (zone flow, multi-camera trackId, disable) |

**Contracts 136 · Python 108** (92 + 16). All repo gates green (typecheck 28, import-graph 19-pkg
0-viol, contracts **59**, lint, build, format).

## 6. Definition of Done

- [x] `TrackerAdapter` (association-only) + `TrackManager` (lifecycle) — tracker fully swappable.
- [x] Platform `Track`/`Zone` contracts (+4 → 59); RuntimeMetrics additive tracking fields; id policy documented.
- [x] Zone Engine geometry-only; Counting Engine business-neutral, confirmed-tracks-only; coordinate seam.
- [x] Playground tracks.json + diagnostics overlays + tracking options; runtime boundary held (events only).
- [x] Deterministic tests green; CLI smoke verified; no frozen doc (01–28) change; no new service.
- [ ] **Architect review of AI-2** ⏳ — then behaviour analysis (AI-3).
