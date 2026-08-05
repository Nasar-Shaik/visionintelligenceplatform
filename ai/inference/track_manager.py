"""TrackManager (AI-2, Architect rec 1) — the platform-owned owner of Track lifecycle.

The `TrackerAdapter` only associates; the TrackManager owns everything else:
  - active-track store + lookup,
  - lifecycle transitions (created → tentative → confirmed → lost → removed),
  - expired-track cleanup + a bounded archive,
  - **bounded** history pruning (max points and/or rolling time window — rec 7),
  - trackId allocation per the id policy (unique per tenant → camera → **session**, never reused — rec 2),
  - a lifecycle-transition log + aggregate stats for observability (rec 9).

This split is what makes the tracker interchangeable: swap the associator and the manager — plus the
Track contract, zones, counting, events, and rules — are all unaffected. Stdlib-only, deterministic.
"""

from __future__ import annotations

from collections import deque
from typing import Deque, Dict, List, Optional, Sequence

from contracts import Detection
from track_motion import motion_from_history
from tracker import TrackerAdapter
from tracking_contracts import BBox, Track, TrackHistoryPoint, TrackQuality, TrackState


def _centroid(b: BBox):
    return (b[0] + b[2] / 2.0, b[1] + b[3] / 2.0)


def _seconds(ts: str) -> Optional[float]:
    """Best-effort parse of a `<n>s` or ISO timestamp to seconds (for time-window history pruning)."""
    if ts.endswith("s") and not ts.endswith("Z"):
        try:
            return float(ts[:-1])
        except ValueError:
            return None
    return None


class _Live:
    __slots__ = ("track", "history", "misses", "transitions")

    def __init__(self, track: Track, history: Deque[TrackHistoryPoint]) -> None:
        self.track = track
        self.history = history
        self.misses = 0
        self.transitions: List[dict] = [
            {"frameIndex": track.first_seen_frame, "at": track.first_seen_at, "from": None, "to": track.state.value}
        ]


class TrackManager:
    """Owns the lifecycle of every Track produced by an associator (which owns only association)."""

    def __init__(
        self,
        associator: TrackerAdapter,
        *,
        session_id: str,
        min_hits: int = 3,
        max_age: int = 30,
        history_max: int = 50,
        history_window_seconds: Optional[float] = None,
        compute_motion: bool = False,
    ) -> None:
        self._assoc = associator
        self._session_id = session_id
        self._min_hits = min_hits
        self._max_age = max_age
        self._history_max = history_max
        self._history_window = history_window_seconds
        # ⚠️ OFF by default (P-8 Phase 4). Motion is derived from history and costs one pass over it
        # per matched detection — cheap, but not free, and batch analysis has never needed it. Making
        # it opt-in keeps every existing caller's output byte-identical, so a new field on the live
        # runtime cannot quietly change what `tracks.json` has contained since AI-2.
        self._compute_motion = compute_motion
        self._live: Dict[str, _Live] = {}
        self._archive: List[Track] = []  # bounded snapshot of removed tracks (diagnostics)
        self._seq = 0
        self._removed_count = 0
        self._lifetimes: List[int] = []  # frames a removed track lived (created→removed)
        #: Tracks that reached `removed` during the most recent `update`. Drained by the caller; the
        #: live runtime needs them to offer a returning object its previous identity.
        self._just_removed: List[Track] = []

    def reset(self) -> None:
        self._live.clear()
        self._archive.clear()
        self._seq = 0
        self._removed_count = 0
        self._lifetimes.clear()

    # --- lookup -------------------------------------------------------------------
    def get(self, track_id: str) -> Optional[Track]:
        live = self._live.get(track_id)
        return live.track if live else None

    def active(self) -> List[Track]:
        return [live.track for live in self._live.values()]

    # --- frame update -------------------------------------------------------------
    def update(
        self,
        detections: Sequence[Detection],
        *,
        tenant_id: str,
        camera_id: str,
        frame_index: int,
        at: str,
    ) -> List[Track]:
        # ⚠️ A motion-predicting associator needs to know which frame this is, so it can tell a track
        # that was seen last frame from one that has been coasting for twenty. It declares that with
        # `uses_frame_index`; two-argument associators keep working untouched (see TrackerAdapter).
        if getattr(self._assoc, "uses_frame_index", False):
            assoc = self._assoc.associate(detections, self.active(), frame_index)
        else:
            assoc = self._assoc.associate(detections, self.active())
        matched_tracks = set()
        matched_dets = set()
        #: detection index → trackId for THIS frame, matched or newly spawned. The live runtime
        #: stamps `trackingId` back onto each detection from this, and an exact mapping is the only
        #: honest source for it — inferring the pairing afterwards from box equality gets it wrong
        #: the moment two detections share a box, which is exactly when it matters.
        self._last_assignment: Dict[int, str] = {}
        for tid, di, score in assoc.matches:
            matched_tracks.add(tid)
            matched_dets.add(di)
            self._last_assignment[di] = tid
            self._apply_match(self._live[tid], detections[di], score, frame_index, at)

        for di, det in enumerate(detections):
            if di not in matched_dets:
                self._last_assignment[di] = self._spawn(det, tenant_id, camera_id, frame_index, at)

        for tid in assoc.unmatched_tracks:
            self._apply_miss(self._live[tid], frame_index)

        # Cleanup removed → archive; record lifetime.
        self._just_removed = []
        for tid in [t for t, live in self._live.items() if live.track.state == TrackState.REMOVED]:
            live = self._live.pop(tid)
            self._removed_count += 1
            self._lifetimes.append(live.track.last_seen_frame - live.track.first_seen_frame)
            self._just_removed.append(live.track)
            if len(self._archive) < 500:
                self._archive.append(live.track)
        return self.active()

    def drain_removed(self) -> List[Track]:
        """Tracks that reached the terminal state during the last `update`, taken once.

        ⚠️ Draining rather than accumulating: the caller that wants these (the live runtime's re-entry
        resolver) wants each removal exactly once, and a list that only grows is a leak on a runtime
        that is expected to stay up for weeks.
        """
        out = self._just_removed
        self._just_removed = []
        return out

    def timeline(self, track_id: str) -> Optional[List[dict]]:
        """The lifecycle transitions of one live track, or `None` when it is not live."""
        live = self._live.get(track_id)
        return list(live.transitions) if live else None

    def _transition(self, live: _Live, to: TrackState, frame_index: int, at: Optional[str] = None) -> None:
        if live.track.state != to:
            # ⚠️ The timestamp travels with the transition. Without it a consumer has to guess when a
            # state change happened from the track's *current* last-seen time, which dates every
            # historical entry to the present — and a lifecycle whose entries all share one timestamp
            # cannot answer "how long was it lost for?".
            live.transitions.append(
                {
                    "frameIndex": frame_index,
                    "at": at if at is not None else live.track.last_seen_at,
                    "from": live.track.state.value,
                    "to": to.value,
                }
            )
            live.track.state = to

    def _prune_history(self, live: _Live) -> None:
        # Points bound is enforced by the deque maxlen; also honour a rolling time window if set.
        if self._history_window is not None and live.history:
            newest = _seconds(live.history[-1].at)
            if newest is not None:
                while live.history:
                    oldest = _seconds(live.history[0].at)
                    if oldest is None or newest - oldest <= self._history_window:
                        break
                    live.history.popleft()
        live.track.history = list(live.history)

    def _apply_match(self, live: _Live, det: Detection, score: float, frame_index: int, at: str) -> None:
        t = live.track
        live.misses = 0
        t.bbox = det.bbox
        t.centroid = _centroid(det.bbox)
        t.confidence = det.confidence
        t.class_id = det.class_id
        t.hits += 1
        t.last_seen_frame = frame_index
        t.last_seen_at = at
        t.age = frame_index - t.first_seen_frame
        t.quality.tracking_confidence = round(score, 6)
        t.quality.prediction_frames = 0
        live.history.append(TrackHistoryPoint(frame_index, at, det.bbox, t.centroid))
        self._prune_history(live)
        if self._compute_motion:
            t.motion = motion_from_history(t.history)
        self._transition(
            live, TrackState.CONFIRMED if t.hits >= self._min_hits else TrackState.TENTATIVE, frame_index, at
        )

    def _apply_miss(self, live: _Live, frame_index: int) -> None:
        t = live.track
        live.misses += 1
        t.age = frame_index - t.first_seen_frame
        t.quality.prediction_frames = (t.quality.prediction_frames or 0) + 1
        t.quality.lost_frames = (t.quality.lost_frames or 0) + 1
        if live.misses > self._max_age:
            self._transition(live, TrackState.REMOVED, frame_index)
        else:
            self._transition(live, TrackState.LOST, frame_index)

    def _spawn(self, det: Detection, tenant_id: str, camera_id: str, frame_index: int, at: str) -> str:
        self._seq += 1
        # Id policy: unique per tenant→camera→session; never reused within a session.
        tid = f"trk_{camera_id}_{self._session_id}_{self._seq}"
        centroid = _centroid(det.bbox)
        history: Deque[TrackHistoryPoint] = deque(maxlen=self._history_max)
        history.append(TrackHistoryPoint(frame_index, at, det.bbox, centroid))
        initial = TrackState.CREATED if self._min_hits > 1 else TrackState.CONFIRMED
        track = Track(
            track_id=tid,
            tenant_id=tenant_id,
            camera_id=camera_id,
            label=det.label,
            state=initial,
            confidence=det.confidence,
            bbox=det.bbox,
            first_seen_frame=frame_index,
            first_seen_at=at,
            last_seen_frame=frame_index,
            last_seen_at=at,
            age=0,
            hits=1,
            class_id=det.class_id,
            session_id=self._session_id,
            centroid=centroid,
            quality=TrackQuality(tracking_confidence=det.confidence, prediction_frames=0, lost_frames=0),
            history=list(history),
        )
        self._live[tid] = _Live(track, history)
        return tid

    def assignment(self) -> Dict[int, str]:
        """detection index → trackId for the most recent `update`."""
        return dict(getattr(self, "_last_assignment", {}))

    # --- diagnostics + observability ---------------------------------------------
    def lifecycle_log(self) -> List[dict]:
        """Per-track lifecycle transitions (active + archived) for tracks.json diagnostics."""
        out: List[dict] = []
        for live in list(self._live.values()):
            out.append({"trackId": live.track.track_id, "transitions": list(live.transitions)})
        return out

    def diagnostics(self) -> List[dict]:
        """Rich per-track diagnostics: identity, quality, history, lifecycle (active + archived)."""
        rows: List[dict] = []
        for live in list(self._live.values()):
            d = live.track.to_dict()
            d["lifecycle"] = list(live.transitions)
            rows.append(d)
        for t in self._archive:
            d = t.to_dict()
            d["lifecycle"] = [{"to": "removed"}]
            rows.append(d)
        return rows

    def stats(self, *, zone_crossings: int = 0, counting_events: int = 0, frames: int = 1) -> dict:
        """Aggregate tracking observability (Architect rec 9) — additive RuntimeMetrics fields."""
        active = self.active()
        by_state: Dict[str, int] = {}
        ages: List[int] = []
        lengths: List[int] = []
        velocities: List[float] = []
        for t in active:
            by_state[t.state.value] = by_state.get(t.state.value, 0) + 1
            ages.append(t.age)
            lengths.append(len(t.history))
            velocities.append(_avg_velocity(t.history))

        def _avg(xs):
            return round(sum(xs) / len(xs), 6) if xs else 0.0

        return {
            "activeTracks": len(active),
            "confirmedTracks": by_state.get("confirmed", 0),
            "tentativeTracks": by_state.get("tentative", 0) + by_state.get("created", 0),
            "lostTracks": by_state.get("lost", 0),
            "removedTracks": self._removed_count,
            "averageTrackAgeFrames": _avg(ages),
            "averageTrackLength": _avg(lengths),
            "averageTrackVelocity": _avg(velocities),
            "averageTrackLifetime": _avg(self._lifetimes),
            "zoneCrossings": int(zone_crossings),
            "countingRate": round(counting_events / frames, 6) if frames else 0.0,
        }


def _avg_velocity(history: Sequence[TrackHistoryPoint]) -> float:
    if len(history) < 2:
        return 0.0
    total = 0.0
    for i in range(1, len(history)):
        a = history[i - 1].centroid or _centroid(history[i - 1].bbox)
        b = history[i].centroid or _centroid(history[i].bbox)
        total += ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5
    return total / (len(history) - 1)
