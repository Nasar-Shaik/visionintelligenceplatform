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
from tracker import PredictiveIouAssociator
from tracking_contracts import Track, TrackTimelineEntry

#: Cameras whose state is retained. Beyond this the least recently seen is evicted, because a
#: long-running runtime that has met a thousand cameras must not hold a thousand track tables.
MAX_CAMERAS = 64

#: A camera silent for this long is released on the next sweep. ⚠️ Not a timer thread — eviction
#: happens on the update path, so a runtime nobody is talking to does no work at all.
CAMERA_IDLE_SECONDS = 300.0

#: Lifecycle entries retained per track. Bounded for the same reason history is.
MAX_TIMELINE = 64


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
            state = self._state_for(ctx.tenant_id, ctx.camera_id)
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
                return detections

            if captured is not None:
                state.last_capture_seconds = captured
            state.frame_index += 1
            state.frames += 1
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
                state.reentry.retire(removed)
                self._record_transition(state, removed.track_id, state.frame_index, at, "removed", "max-age exceeded")

            for track in tracks:
                if track.track_id not in before:
                    state.created += 1
                    self._adopt_identity(state, track)
                self._sync_timeline(state, track)

            stamped = self._stamp(detections, state.manager.assignment())
            self._sweep(now=state.last_touched)
            self._tracking_ms_total += (time.perf_counter() - started) * 1000.0
            self._tracking_frames += 1
        return stamped

    # --- identity ----------------------------------------------------------------

    def _adopt_identity(self, state: _CameraState, track: Track) -> None:
        """Give a newly created track its own identity, or the one it is returning to."""
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

    def _stamp(self, detections: Sequence[Detection], assignment: Dict[int, str]) -> List[Detection]:
        """Return the detections carrying their track ids.

        ⚠️ `Detection` is a **frozen** dataclass, so this rebuilds rather than mutates — which is the
        right shape anyway: the detection that came out of post-processing is a record of what the
        model saw, and tracking is a later opinion about it rather than a correction to it.
        """
        out: List[Detection] = []
        for index, det in enumerate(detections):
            track_id = assignment.get(index)
            out.append(replace(det, tracking_id=track_id) if track_id is not None else det)
        return out

    # --- camera state ------------------------------------------------------------

    def _state_for(self, tenant_id: str, camera_id: str) -> _CameraState:
        key = (tenant_id, camera_id)
        state = self._cameras.get(key)
        if state is None:
            if len(self._cameras) >= MAX_CAMERAS:
                self._evict_oldest()
            # ⚠️ The TENANT is in the session id, not only the camera. Track ids are built from
            # camera + session + counter, so without it two tenants that both call a camera "cam_1"
            # mint byte-identical track ids. Reads are already isolated, but an id that collides
            # across a tenant boundary is one export, log line or future join away from mattering.
            state = _CameraState(f"{self._session_id}-{tenant_id}-{camera_id}", self._options)
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
            for (tid, cam), state in self._cameras.items():
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
            for (tid, _cam), state in self._cameras.items():
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
                s for (tid, _cam), s in self._cameras.items() if tenant_id is None or tid == tenant_id
            ]
            active = confirmed = tentative = lost = 0
            removed = created = recovered = frames = out_of_order = 0
            lifetimes: List[float] = []
            hits: List[int] = []
            for state in states:
                created += state.created
                recovered += state.recovered
                frames += state.frames
                out_of_order += state.out_of_order
                removed += state.manager.stats().get("removedTracks", 0)
                for track in state.manager.active():
                    active += 1
                    hits.append(track.hits)
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
            "averageTrackHits": _mean(hits),
            # ⚠️ Fragmentation, not accuracy. See the contract's note: an engine that splits one
            # person into six identities scores 6.0, but proving two identities were genuinely
            # SWAPPED needs ground truth this runtime does not have.
            "fragmentation": round(created / confirmed, 4) if confirmed else None,
            "camerasEvicted": self._evictions,
        }

    def describe(self) -> dict:
        """What this tracker is, for the runtime's self-description. No tenant data."""
        return self._options.describe()


def _mean(values: Sequence[float]) -> Optional[float]:
    return round(sum(values) / len(values), 4) if values else None


def _iso(now: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
