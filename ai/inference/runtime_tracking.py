"""RuntimeTracker (P-8 Phase 4) — tracking on the LIVE frame path.

### ⚠️ Why this module has to exist at all

Tracking already worked for **batch** analysis: `VideoAnalyzer` materialises a video, holds one
`TrackManager` for the whole file, and walks it frame by frame. The live path cannot do that. Media
posts each frame to `POST /infer` as an independent, stateless request — there is no session, no
ordering guarantee, and nothing that survives between two frames of the same camera. A tracker needs
exactly what that endpoint does not have: memory.

So this is the state `/infer` was missing, held per **(tenant, camera)** and nothing coarser.

### ⚠️ Camera Processing Assignment fits here without redesign, and that shaped the structure

Selective AI processing (C-14c) is designed and not built: today every recording camera's frames are
offered. Nothing in this module assumes otherwise. State is created **lazily, on the first frame that
actually arrives for a camera**, and released when that camera goes quiet. There is no camera list, no
enrolment step, and no "all cameras" anywhere. When assignment does arrive it changes which frames are
sent — and this module needs no change at all, because it already only knows about cameras that sent
something.

### ⚠️ Concurrency is real here, not theoretical

The runtime is a `ThreadingHTTPServer`, and media keeps up to four requests in flight. Two frames from
the same camera can therefore be in `run()` at the same time, and they can arrive **out of order**.
Both are handled explicitly:

  - one lock guards the whole update. It is held for association and lifecycle only — microseconds —
    never across inference, so it costs nothing measurable;
  - a frame older than the last one processed for that camera is **counted and skipped**, not
    tracked. Feeding history backwards produces negative durations and a velocity pointing the wrong
    way, and every number derived from it would be quietly wrong rather than obviously broken.

### What this module refuses to do

It answers "where did object X move?" and never "was that suspicious?". No thresholds with business
meaning, no zones, no rules, no events. `dwellSeconds` is geometry. Loitering is somebody else's job,
and keeping it somebody else's job is what stops a vertical's semantics leaking into every consumer.

Stdlib-only, deterministic given its inputs.
"""

from __future__ import annotations

import threading
import time
from dataclasses import replace
from typing import Dict, List, Optional, Sequence, Tuple

from contracts import Detection, FrameContext
from reentry import ReentryResolver
from track_manager import TrackManager
from track_motion import seconds_of
from tracker import PredictiveIouAssociator, iou
from tracking_contracts import Track, TrackTimelineEntry

#: Cameras whose state is retained. Beyond this the least recently seen is evicted, because a
#: long-running runtime that has met a thousand cameras must not hold a thousand track tables.
MAX_CAMERAS = 64

#: A camera silent for this long is released on the next sweep. ⚠️ Not a timer thread — eviction
#: happens on the update path, so a runtime nobody is talking to does no work at all.
CAMERA_IDLE_SECONDS = 300.0

#: Lifecycle entries retained per track. Bounded for the same reason history is.
MAX_TIMELINE = 64

#: Tenants whose lifetime totals are retained. Bounded like everything else here; a runtime serving
#: more tenants than this has bigger questions than its statistics page.
MAX_TENANT_TOTALS = 256

#: Cameras whose LIFETIME totals are retained — deliberately larger than `MAX_CAMERAS`.
#:
#: ⚠️ Per-camera totals must outlive the per-camera tracking state, and that is a requirement rather
#: than a nicety. Tracking state is released the moment a camera goes quiet; under Camera Processing
#: Assignment (C-14c) going quiet becomes a NORMAL, operator-initiated event. If the counters lived
#: with the state, turning AI off on a camera would erase everything that camera had ever reported,
#: and turning it back on would show a camera that had never seen anybody.
MAX_CAMERA_TOTALS = 512

#: Box overlap at which two tracks are counted as CROSSING. Deliberately low: the metric asks "did
#: two identities occupy the same place?", which is the situation in which a swap becomes possible.
CROSSING_IOU = 0.1

#: Live tracks scanned pairwise for crossings. The scan is O(n²) under the update lock, so it is
#: capped rather than left to grow — a camera with more simultaneous identities than this has an
#: analytics problem, not a crossings-metric problem.
MAX_CROSSING_TRACKS = 32

#: The counters `stats()` cannot fill in, and why.
#:
#: ⚠️ These are **absent, not zero.** Each one asks whether the tracker was RIGHT, and being right is
#: defined against which real object each identity belonged to — which no live camera provides. A
#: switch looks exactly like two people walking on. Emitting `0` would put a confident, verified-
#: looking number on a dashboard that nothing measured, and on an evidence product that is worse than
#: an empty cell. They ARE measured, against authored ground truth, by the tracking verification.
GROUND_TRUTH_METRICS = ("identitySwitches", "reidentificationSuccessRate", "falseRecoveries")

GROUND_TRUTH_REASON = (
    "these ask whether an identity was CORRECT, which is only answerable against ground truth: "
    "which real object each track belonged to. A live camera does not carry that."
)

#: Where they are measured for real — authored scenarios whose trajectories are written down first.
GROUND_TRUTH_SOURCE = "docs/review/p8/tracking.mjs"

#: Mirrors `TRACKING_STATS_SCHEMA_VERSION` in packages/contracts. ⚠️ Kept in step by
#: `pnpm verify:contracts`, which is the only thing standing between two languages and one meaning.
TRACKING_STATS_SCHEMA_VERSION = "1.0"

#: Lifetime counters held per tenant. ⚠️ Declared in one place so a tenant seen after this list grows
#: is not missing a key that `stats()` then reads as absent-and-therefore-zero for one tenant only.
_TOTAL_KEYS = (
    "created",
    "removed",
    "recovered",
    "frames",
    "outOfOrder",
    "occlusions",
    "crossings",
    "reentryOpportunities",
)


class _CameraState:
    """Everything tracked for one (tenant, camera). One manager, one re-entry pool, one frame clock."""

    __slots__ = (
        "manager",
        "reentry",
        "frame_index",
        "last_capture_seconds",
        "last_touched",
        "timelines",
        "created",
        "recovered",
        "out_of_order",
        "frames",
        "prev_state",
        "overlapping",
    )

    def __init__(self, session_id: str, options: "TrackingOptions") -> None:
        self.manager = TrackManager(
            PredictiveIouAssociator(
                min_iou=options.min_iou,
                min_iou_lost=options.min_iou_lost,
                max_coast_frames=options.max_age,
            ),
            session_id=session_id,
            min_hits=options.min_hits,
            max_age=options.max_age,
            history_max=options.history_max,
            compute_motion=True,
        )
        self.reentry = ReentryResolver(
            max_gap_seconds=options.reentry_gap_seconds,
            max_distance=options.reentry_distance,
        )
        # ⚠️ OUR frame counter, not media's `seq`. Media's sequence restarts when a stream restarts,
        # and a counter that jumps backwards makes every age, gap and lifetime meaningless. The source
        # sequence is still recorded on the track, where it is useful and cannot do harm.
        self.frame_index = 0
        self.last_capture_seconds: Optional[float] = None
        self.last_touched = time.monotonic()
        self.timelines: Dict[str, List[TrackTimelineEntry]] = {}
        self.created = 0
        self.recovered = 0
        self.out_of_order = 0
        self.frames = 0
        #: Last observed lifecycle state per live track — the only way to see a `lost → confirmed`
        #: edge, which is an occlusion the identity SURVIVED. Pruned with the tracks themselves.
        self.prev_state: Dict[str, str] = {}
        #: Track pairs currently overlapping. A crossing is counted once per episode, on the frame
        #: the pair meets; without this a pair that stays overlapped for ten frames scores ten.
        self.overlapping: set = set()


class TrackingOptions:
    """Tuning for the live tracker. Defaults are for 2 fps CPU-only perception, which is what the
    deployment measures at — a tracker tuned for 30 fps coasts far too little to survive a real gap."""

    def __init__(
        self,
        *,
        enabled: bool = True,
        min_iou: float = 0.3,
        min_iou_lost: float = 0.45,
        min_hits: int = 2,
        max_age: int = 8,
        history_max: int = 50,
        reentry_gap_seconds: float = 12.0,
        reentry_distance: float = 0.35,
    ) -> None:
        self.enabled = enabled
        self.min_iou = min_iou
        self.min_iou_lost = min_iou_lost
        # ⚠️ 2, not the batch default of 3. At 2 fps a third hit costs a further half second before an
        # identity is trusted, and a person crossing a doorway can be gone by then.
        self.min_hits = min_hits
        # ⚠️ 8 frames ≈ 4 seconds at 2 fps — long enough to walk behind a pillar, short enough that a
        # departed person stops occupying an identity that a new arrival would then have to fight for.
        self.max_age = max_age
        self.history_max = history_max
        self.reentry_gap_seconds = reentry_gap_seconds
        self.reentry_distance = reentry_distance

    def describe(self) -> dict:
        return {
            "enabled": self.enabled,
            "associator": "predictive-iou",
            "minIou": self.min_iou,
            "minIouLost": self.min_iou_lost,
            "minHits": self.min_hits,
            "maxAgeFrames": self.max_age,
            "historyMax": self.history_max,
            "reentryGapSeconds": self.reentry_gap_seconds,
            "reentryDistance": self.reentry_distance,
        }


class RuntimeTracker:
    """The `Tracker` pipeline stage, made stateful and tenant-scoped.

    Implements the existing `pipeline.Tracker` Protocol (`run(detections, ctx) -> detections`), so it
    drops into the capability pipeline where `NoopTracker` was and nothing above it changes.
    """

    def __init__(self, options: Optional[TrackingOptions] = None, *, session_id: str = "live") -> None:
        self._options = options or TrackingOptions()
        self._session_id = session_id
        self._lock = threading.RLock()
        self._cameras: Dict[Tuple[str, str], _CameraState] = {}
        self._tracking_ms_total = 0.0
        self._tracking_frames = 0
        self._evictions = 0
        #: Lifetime totals per tenant.
        #:
        #: ⚠️ These live on the TRACKER, not on the per-camera state, and that is a correctness fix
        #: rather than a tidy-up. Summing `created` across live cameras produces a number that FALLS
        #: when an idle camera is released — so a "total identities created" counter went backwards,
        #: and the capacity benchmark differenced it into a negative identity count. A monotonic
        #: total must not be assembled from state that is deliberately transient.
        self._totals: Dict[str, Dict[str, int]] = {}
        #: The same counters at (tenant, camera) grain — see MAX_CAMERA_TOTALS for why they are held
        #: here and not on `_CameraState`. Timing fields live alongside them so per-camera tracking
        #: fps and latency are derived from the same record.
        self._camera_totals: Dict[Tuple[str, str], Dict[str, float]] = {}
        #: Set only when someone explicitly asks for a recording. See track_replay for why it is not
        #: a thing an ordinary deployment ever switches on.
        self._recorder = None

    # --- the pipeline stage ------------------------------------------------------

    def run(self, detections: List[Detection], ctx: FrameContext) -> List[Detection]:
        """Associate this frame's detections with the camera's live identities.

        Returns the detections with `tracking_id` stamped on the ones that matched a track. ⚠️ A
        detection that started a brand-new track is stamped too — the id exists from the first frame,
        even while the track is still `tentative` and not yet trusted for counting.
        """
        if not self._options.enabled:
            return detections
        started = time.perf_counter()
        with self._lock:
            # ⚠️ `correlation_id` identifies the stream, not the camera — see `_state_for`. For a
            # live frame it is absent and the key is unchanged.
            state = self._state_for(ctx.tenant_id, ctx.camera_id, ctx.correlation_id)
            captured = seconds_of(ctx.timestamp) if ctx.timestamp else None

            # ⚠️ Out-of-order frames are skipped, not tracked. Media runs up to four requests in
            # flight, so frame N+1 can genuinely arrive after N+2. Tracking backwards would append
            # history in the wrong order and every duration, speed and heading derived from it would
            # be wrong — silently, and only on a busy camera.
            if (
                captured is not None
                and state.last_capture_seconds is not None
                and captured < state.last_capture_seconds
            ):
                state.out_of_order += 1
                self._bump(ctx.tenant_id, ctx.camera_id, "outOfOrder")
                return detections

            if captured is not None:
                state.last_capture_seconds = captured
            state.frame_index += 1
            state.frames += 1
            self._bump(ctx.tenant_id, ctx.camera_id, "frames")
            state.last_touched = time.monotonic()

            at = ctx.timestamp or _iso(time.time())
            before = {t.track_id for t in state.manager.active()}
            tracks = state.manager.update(
                detections,
                tenant_id=ctx.tenant_id,
                camera_id=ctx.camera_id,
                frame_index=state.frame_index,
                at=at,
            )

            for removed in state.manager.drain_removed():
                self._bump(ctx.tenant_id, ctx.camera_id, "removed")
                state.reentry.retire(removed)
                self._record_transition(state, removed.track_id, state.frame_index, at, "removed", "max-age exceeded")

            for track in tracks:
                if track.track_id not in before:
                    state.created += 1
                    self._bump(ctx.tenant_id, ctx.camera_id, "created")
                    self._adopt_identity(state, track, ctx.tenant_id, ctx.camera_id)
                self._sync_timeline(state, track)

            self._count_occlusions(state, tracks, ctx.tenant_id, ctx.camera_id)
            self._count_crossings(state, tracks, ctx.tenant_id, ctx.camera_id)

            stamped = self._stamp(detections, state.manager.assignment(), state)
            self._sweep(now=state.last_touched)
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            self._tracking_ms_total += elapsed_ms
            self._tracking_frames += 1
            self._record_timing(ctx.tenant_id, ctx.camera_id, elapsed_ms)
            if self._recorder is not None:
                self._recorder.record(ctx, detections, stamped, state.frame_index)
        return stamped

    # --- identity ----------------------------------------------------------------

    def _bump(self, tenant_id: str, camera_id: str, key: str, by: int = 1) -> None:
        """Increment one counter at BOTH grains, so the two views can never disagree."""
        totals = self._totals.get(tenant_id)
        if totals is None:
            if len(self._totals) < MAX_TENANT_TOTALS:
                totals = dict.fromkeys(_TOTAL_KEYS, 0)
                self._totals[tenant_id] = totals
        if totals is not None:
            totals[key] = totals.get(key, 0) + by
        camera = self._camera_record(tenant_id, camera_id)
        if camera is not None:
            camera[key] = camera.get(key, 0) + by

    def _camera_record(self, tenant_id: str, camera_id: str) -> Optional[Dict[str, float]]:
        """The lifetime record for one camera, created on demand and LRU-evicted when full."""
        key = (tenant_id, camera_id)
        record = self._camera_totals.get(key)
        if record is None:
            if len(self._camera_totals) >= MAX_CAMERA_TOTALS:
                oldest = min(self._camera_totals.items(), key=lambda kv: kv[1].get("lastSeen", 0.0))
                del self._camera_totals[oldest[0]]
            record = dict.fromkeys(_TOTAL_KEYS, 0.0)
            record["trackingMsTotal"] = 0.0
            record["firstSeen"] = time.monotonic()
            record["lastSeen"] = record["firstSeen"]
            self._camera_totals[key] = record
        return record

    def _record_timing(self, tenant_id: str, camera_id: str, elapsed_ms: float) -> None:
        record = self._camera_record(tenant_id, camera_id)
        if record is None:
            return
        record["trackingMsTotal"] = record.get("trackingMsTotal", 0.0) + elapsed_ms
        record["lastSeen"] = time.monotonic()

    def _adopt_identity(self, state: _CameraState, track: Track, tenant_id: str, camera_id: str) -> None:
        """Give a newly created track its own identity, or the one it is returning to."""
        # ⚠️ Counted BEFORE resolving, because `resolve()` consumes the candidate it accepts. This is
        # the denominator the link count is meaningful against: how many departed identities were
        # actually available to return, not how many returned.
        if state.reentry.pending():
            self._bump(tenant_id, camera_id, "reentryOpportunities")
        link = state.reentry.resolve(track)
        if link is None:
            # ⚠️ A first appearance is its own identity, set explicitly rather than left absent. A
            # consumer grouping by `identityId` must not have to special-case "the ones with none".
            track.identity_id = track.track_id
            track.recoveries = 0
            return
        track.identity_id = link.identity_id
        track.preceded_by = link.preceded_by
        track.recoveries = link.recoveries
        state.recovered += 1
        self._bump(tenant_id, camera_id, "recovered")

    def _count_occlusions(
        self, state: _CameraState, tracks: Sequence[Track], tenant_id: str, camera_id: str
    ) -> None:
        """Count identities that went `lost` and came back as the SAME track.

        ⚠️ This is the occlusion the tracker *absorbed* — distinct from a recovery, which is a new
        track linked to a departed one. Both are "it came back"; only this one kept its `trackId`,
        and a consumer holding that id sees no interruption at all. Reporting them as one number
        would hide which of the two mechanisms is actually carrying the deployment.
        """
        live = {t.track_id for t in tracks}
        for track in tracks:
            was = state.prev_state.get(track.track_id)
            now = track.state.value
            if was == "lost" and now in ("confirmed", "tentative"):
                self._bump(tenant_id, camera_id, "occlusions")
            state.prev_state[track.track_id] = now
        for gone in [tid for tid in state.prev_state if tid not in live]:
            del state.prev_state[gone]

    def _count_crossings(
        self, state: _CameraState, tracks: Sequence[Track], tenant_id: str, camera_id: str
    ) -> None:
        """Count episodes of two identities occupying the same place.

        ⚠️ A crossing is an OPPORTUNITY for an identity switch, never evidence of one. Two people
        passing each other and the tracker exchanging their ids look identical from here — telling
        them apart needs ground truth. The value of the number is as a denominator: zero crossings
        means a clean identity record proves very little about crowded scenes.
        """
        boxes = [t for t in tracks if t.state.value == "confirmed"][:MAX_CROSSING_TRACKS]
        current = set()
        for i, a in enumerate(boxes):
            for b in boxes[i + 1 :]:
                if iou(a.bbox, b.bbox) < CROSSING_IOU:
                    continue
                pair = (a.track_id, b.track_id) if a.track_id < b.track_id else (b.track_id, a.track_id)
                current.add(pair)
                if pair not in state.overlapping:
                    self._bump(tenant_id, camera_id, "crossings")
        state.overlapping = current

    def _sync_timeline(self, state: _CameraState, track: Track) -> None:
        """Mirror the manager's transitions into the contract shape, append-only and bounded."""
        transitions = state.manager.timeline(track.track_id)
        if transitions is None:
            return
        entries = state.timelines.setdefault(track.track_id, [])
        for raw in transitions[len(entries) :]:
            reason = None
            if not entries and track.preceded_by is not None:
                reason = f"re-entry from {track.preceded_by}"
            entries.append(
                TrackTimelineEntry(
                    frame_index=int(raw.get("frameIndex", 0)),
                    at=str(raw.get("at") or track.last_seen_at),
                    to=str(raw.get("to")),
                    from_state=raw.get("from"),
                    reason=reason,
                )
            )
        if len(entries) > MAX_TIMELINE:
            del entries[: len(entries) - MAX_TIMELINE]

    def _record_transition(
        self, state: _CameraState, track_id: str, frame_index: int, at: str, to: str, reason: str
    ) -> None:
        entries = state.timelines.setdefault(track_id, [])
        entries.append(
            TrackTimelineEntry(frame_index=frame_index, at=at, to=to, from_state="lost", reason=reason)
        )
        if len(entries) > MAX_TIMELINE:
            del entries[: len(entries) - MAX_TIMELINE]

    def _stamp(
        self, detections: Sequence[Detection], assignment: Dict[int, str], state: "_CameraState"
    ) -> List[Detection]:
        """Return the detections carrying their track id AND their identity.

        ⚠️ `Detection` is a **frozen** dataclass, so this rebuilds rather than mutates — which is the
        right shape anyway: the detection that came out of post-processing is a record of what the
        model saw, and tracking is a later opinion about it rather than a correction to it.

        ⚠️ **Identity is stamped here or it never reaches a rule** (P-8 Phase 5, ADR-0041). The
        detection is the only thing that leaves this runtime; a `Track` is a read model that lives
        and dies in memory. A dwell rule downstream grouping by `trackingId` would see a briefly
        occluded person as two short visits — silently, and worse under load — so the identity chain
        travels on the detection itself.
        """
        out: List[Detection] = []
        for index, det in enumerate(detections):
            track_id = assignment.get(index)
            if track_id is None:
                out.append(det)
                continue
            track = state.manager.get(track_id)
            out.append(
                replace(
                    det,
                    tracking_id=track_id,
                    # `identity_id` is set on every track at creation (its own id for a first
                    # appearance), so this is only ever None if the track vanished between the
                    # assignment and this read — which the lock makes impossible.
                    identity_id=None if track is None else track.identity_id,
                    preceded_by=None if track is None else track.preceded_by,
                )
            )
        return out

    # --- camera state ------------------------------------------------------------

    def _state_for(
        self, tenant_id: str, camera_id: str, stream_id: Optional[str] = None
    ) -> _CameraState:
        """Tracking state for one **stream**, which is usually but not always one camera.

        ⛔ **`stream_id` is the fourth layer of a defect this platform has now met four times**
        (P-8.5 Product Validation, V-2). Three mechanisms identified a stream as `(tenant, camera)`
        plus a forward-moving number, and each was fixed in turn: the event publisher's ordering
        gate, the events dedup key, and JetStream's `msgId`. This is the last of them, and it is the
        one that lives inside the runtime.

        An offline analysis stamps **footage** time. Footage time does not advance between runs — a
        second recording, or the same recording analysed twice, replays the same instants. The
        out-of-order guard in `run()` compares against `last_capture_seconds` held per camera, so
        every frame of the second run is older than the first run's last frame and is skipped:
        no association, no `tracking_id`, no dwell, no loitering incident. Silently.

        Measured on the deployed stack before this change: eight analyses on one camera produced
        `framesTracked: 906` against `outOfOrderFrames: 1244` — more frames rejected than tracked —
        and two identical reruns raised the rejected count by exactly 120, the whole of both runs.
        Five of eight clips finished with zero tracks.

        ⚠️ **Live behaviour is byte-identical, and that is not an aspiration.** Media attaches
        `correlationId` only to frames carrying stored-media provenance (`http-frame-sink.ts`), so a
        live frame arrives with `stream_id=None`, the key stays `(tenant, camera)`, and both the
        gate and the minted track ids are exactly what they were. Nothing about a live camera is
        keyed on anything new.

        ⚠️ Live and offline on the same camera also stop interfering, which was the sharper edge of
        the same bug: an offline analysis of footage dated *ahead* of now would have poisoned the
        live gate and silently stopped tracking the real camera.
        """
        key = (tenant_id, camera_id, stream_id)
        state = self._cameras.get(key)
        if state is None:
            if len(self._cameras) >= MAX_CAMERAS:
                self._evict_oldest()
            # ⚠️ The TENANT is in the session id, not only the camera. Track ids are built from
            # camera + session + counter, so without it two tenants that both call a camera "cam_1"
            # mint byte-identical track ids. Reads are already isolated, but an id that collides
            # across a tenant boundary is one export, log line or future join away from mattering.
            #
            # ⚠️ The STREAM is in it for the same reason, one level down: two analyses of one
            # recording must not mint the same track ids, or ADR-0047's promise that runs are
            # independently queryable would hold for events and quietly fail for identities.
            suffix = "" if stream_id is None else f"-{stream_id}"
            state = _CameraState(
                f"{self._session_id}-{tenant_id}-{camera_id}{suffix}", self._options
            )
            self._cameras[key] = state
        return state

    def _evict_oldest(self) -> None:
        oldest = min(self._cameras.items(), key=lambda kv: kv[1].last_touched, default=None)
        if oldest is not None:
            del self._cameras[oldest[0]]
            self._evictions += 1

    def _sweep(self, *, now: float) -> None:
        """Release cameras that have gone quiet. Runs on the update path — no timer, no thread."""
        stale = [k for k, s in self._cameras.items() if now - s.last_touched > CAMERA_IDLE_SECONDS]
        for key in stale:
            del self._cameras[key]

    # --- reads (tenant-scoped, fail-closed) --------------------------------------

    def tracks(self, tenant_id: str, *, camera_id: Optional[str] = None, states: Optional[Sequence[str]] = None) -> List[Track]:
        """Live tracks for one tenant.

        ⚠️ `tenant_id` is required and never optional. A read path that can be called without a tenant
        is one API change away from returning another customer's movements.
        """
        if not tenant_id:
            return []
        out: List[Track] = []
        with self._lock:
            # ⚠️ `_stream` is discarded here on purpose. A caller asking "what is live on this
            # camera" means the camera, and an offline analysis of its footage is genuinely tracking
            # that camera's subjects. Isolation between runs is provided by the track ids and by
            # `analysisSessionId` downstream, not by hiding a run from this view.
            for (tid, cam, _stream), state in self._cameras.items():
                if tid != tenant_id or (camera_id is not None and cam != camera_id):
                    continue
                for track in state.manager.active():
                    if states is not None and track.state.value not in states:
                        continue
                    out.append(track)
        out.sort(key=lambda t: (t.camera_id, t.track_id))
        return out

    def detail(self, tenant_id: str, track_id: str) -> Optional[dict]:
        """One track plus its lifecycle, or `None` when this tenant has no such live track."""
        if not tenant_id:
            return None
        with self._lock:
            for (tid, _cam, _stream), state in self._cameras.items():
                if tid != tenant_id:
                    continue
                track = state.manager.get(track_id)
                if track is None:
                    continue
                timeline = state.timelines.get(track_id, [])
                return {"track": track.to_dict(), "timeline": [e.to_dict() for e in timeline]}
        return None

    def stats(self, tenant_id: Optional[str] = None) -> dict:
        """Aggregate tracking observability. Every derived average is measured or `None` — never 0.0.

        ⚠️ Passing no tenant aggregates the whole runtime, and that is only correct for the
        deployment-wide engineering view, which carries counts and no identities. Anything a customer
        sees passes a tenant.
        """
        with self._lock:
            states = [
                s
                for (tid, _cam, _stream), s in self._cameras.items()
                if tenant_id is None or tid == tenant_id
            ]
            active = confirmed = tentative = lost = 0
            lifetimes: List[float] = []
            hits: List[int] = []
            ages: List[int] = []
            # ⚠️ Lifetime totals come from `_totals`, which survives a camera being released. The
            # live counts below are gauges and are correctly derived from what is live right now.
            if tenant_id is None:
                totals = {
                    key: sum(t.get(key, 0) for t in self._totals.values()) for key in _TOTAL_KEYS
                }
            else:
                totals = self._totals.get(tenant_id, {})
            created = totals.get("created", 0)
            removed = totals.get("removed", 0)
            recovered = totals.get("recovered", 0)
            frames = totals.get("frames", 0)
            out_of_order = totals.get("outOfOrder", 0)
            occlusions = totals.get("occlusions", 0)
            crossings = totals.get("crossings", 0)
            opportunities = totals.get("reentryOpportunities", 0)
            for state in states:
                for track in state.manager.active():
                    active += 1
                    hits.append(track.hits)
                    ages.append(track.age)
                    if track.state.value == "confirmed":
                        confirmed += 1
                    elif track.state.value == "lost":
                        lost += 1
                    else:
                        tentative += 1
                    first = seconds_of(track.first_seen_at)
                    last = seconds_of(track.last_seen_at)
                    if first is not None and last is not None and last >= first:
                        lifetimes.append(last - first)
            tracking_ms = (
                self._tracking_ms_total / self._tracking_frames if self._tracking_frames else None
            )

        return {
            # ⚠️ Consumers branch on this, never on whether a field happens to be present. A missing
            # field means "this runtime does not report it"; the version says which contract applies.
            "schemaVersion": TRACKING_STATS_SCHEMA_VERSION,
            "camerasTracked": len(states),
            "activeTracks": active,
            "confirmedTracks": confirmed,
            "tentativeTracks": tentative,
            "lostTracks": lost,
            "removedTracks": removed,
            "createdTracks": created,
            "recoveredTracks": recovered,
            "framesTracked": frames,
            "outOfOrderFrames": out_of_order,
            "averageTrackingMs": round(tracking_ms, 4) if tracking_ms is not None else None,
            "averageTrackLifetimeSeconds": _mean(lifetimes),
            "averageTrackAgeFrames": _mean(ages),
            "averageTrackHits": _mean(hits),
            # ⚠️ Fragmentation, not accuracy. See the contract's note: an engine that splits one
            # person into six identities scores 6.0, but proving two identities were genuinely
            # SWAPPED needs ground truth this runtime does not have.
            "fragmentation": round(created / confirmed, 4) if confirmed else None,
            "camerasEvicted": self._evictions,
            # --- occlusion and re-entry, as two separate mechanisms ---------------------------
            "occlusionsSurvived": occlusions,
            "crossings": crossings,
            "reentryOpportunities": opportunities,
            # --- and the three the runtime cannot answer ---------------------------------------
            #
            # ⚠️ `None` is the measurement. Every alternative is worse: `0` claims a verified clean
            # record, and omitting the keys makes an unmeasurable metric indistinguishable from a
            # deployment that forgot to wire it up. See ADR-0039.
            "identitySwitches": None,
            "reidentificationSuccessRate": None,
            "falseRecoveries": None,
            "groundTruth": {
                "available": False,
                "reason": GROUND_TRUTH_REASON,
                "metrics": list(GROUND_TRUTH_METRICS),
                "measuredBy": GROUND_TRUTH_SOURCE,
            },
        }

    def cameras(self, tenant_id: str) -> List[dict]:
        """Per-camera tracking metrics for one tenant.

        ⚠️ `tenant_id` is required, exactly as for `tracks()`. A per-camera view without one is a
        list of every customer's camera ids and how busy they are.

        ⚠️ **Two kinds of number in one row, and the names say which.** `activeTracks` is a gauge —
        it is live state and it is `0` for a camera that is currently quiet. Everything ending in a
        total is a lifetime counter that OUTLIVES the tracking state, so a camera whose AI has been
        switched off still reports what it saw. `tracking: false` on a row means exactly that: the
        counters are history, nothing is being analysed right now.
        """
        if not tenant_id:
            return []
        out: List[dict] = []
        with self._lock:
            live: Dict[str, dict] = {}
            # ⚠️ **Summed across a camera's streams, not overwritten by the last one.** The key
            # gained a stream component, so one camera can now hold several states — a live feed and
            # an offline analysis of its own footage. `live[cam] = {...}` would have silently
            # reported whichever happened to be iterated last, which for an operator watching a
            # camera during an investigation is a count that flickers between two truths.
            for (tid, cam, _stream), state in self._cameras.items():
                if tid != tenant_id:
                    continue
                row = live.setdefault(
                    cam, {"activeTracks": 0, "confirmedTracks": 0, "lostTracks": 0}
                )
                for track in state.manager.active():
                    row["activeTracks"] += 1
                    if track.state.value == "confirmed":
                        row["confirmedTracks"] += 1
                    elif track.state.value == "lost":
                        row["lostTracks"] += 1

            for (tid, cam), record in self._camera_totals.items():
                if tid != tenant_id:
                    continue
                frames = int(record.get("frames", 0))
                elapsed = max(0.0, record.get("lastSeen", 0.0) - record.get("firstSeen", 0.0))
                gauges = live.get(cam)
                out.append(
                    {
                        "cameraId": cam,
                        "tracking": gauges is not None,
                        "activeTracks": (gauges or {}).get("activeTracks", 0),
                        "confirmedTracks": (gauges or {}).get("confirmedTracks", 0),
                        "lostTracks": (gauges or {}).get("lostTracks", 0),
                        "createdTracks": int(record.get("created", 0)),
                        "removedTracks": int(record.get("removed", 0)),
                        "recoveredTracks": int(record.get("recovered", 0)),
                        "occlusionsSurvived": int(record.get("occlusions", 0)),
                        "crossings": int(record.get("crossings", 0)),
                        "framesTracked": frames,
                        # ⚠️ Frames this TRACKER declined, which is not the pipeline's frame loss.
                        # Frames dropped before inference are media's number and live in media's
                        # metrics; two different losses under one name is how a dashboard lies.
                        "outOfOrderFrames": int(record.get("outOfOrder", 0)),
                        # ⚠️ `frames - 1`, not `frames`. The window runs from the FIRST frame to the
                        # last, so n frames span n-1 intervals. Dividing by `frames` inflates every
                        # rate, and on a camera that has delivered exactly one frame it divides by
                        # the microseconds that frame itself took — which reported 42,328 fps.
                        # One frame is not a rate, so it is absent.
                        "trackingFps": (
                            round((frames - 1) / elapsed, 3) if frames > 1 and elapsed > 0 else None
                        ),
                        "averageTrackingMs": (
                            round(record.get("trackingMsTotal", 0.0) / frames, 4) if frames else None
                        ),
                    }
                )
        out.sort(key=lambda row: row["cameraId"])
        return out

    def start_recording(self, recorder) -> None:
        """Attach a `TrackingRecorder`. Deliberately not driven by config — see track_replay."""
        with self._lock:
            self._recorder = recorder

    def stop_recording(self):
        with self._lock:
            recorder, self._recorder = self._recorder, None
        return recorder

    def describe(self) -> dict:
        """What this tracker is, for the runtime's self-description. No tenant data."""
        return self._options.describe()


def _mean(values: Sequence[float]) -> Optional[float]:
    return round(sum(values) / len(values), 4) if values else None


def _iso(now: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
