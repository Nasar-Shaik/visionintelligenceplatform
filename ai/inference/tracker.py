"""TrackerAdapter (AI-2) — the swappable **association** stage, and nothing more.

Architect direction: **optimize for the Track contract, not the tracker.** The adapter's ONLY job is
to answer "which of this frame's detections belongs to which existing track?" — it owns no track
state, no lifecycle, no history. That is the `TrackManager`'s job (track_manager.py). Keeping
association pure + stateless is what makes IoU → ByteTrack → BoT-SORT → DeepSORT → OC-SORT → custom
fully interchangeable: no tracker-specific object ever crosses this boundary — only `Association`
(indices + scores) goes in-house, and only the platform `Track` comes out of the manager.

AI-2 ships `IouAssociator` (greedy IoU, same-label, deterministic). Stdlib-only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Protocol, Sequence, Tuple

from contracts import Detection
from tracking_contracts import BBox, Track


def iou(a: BBox, b: BBox) -> float:
    """Intersection-over-union of two `[x, y, w, h]` boxes (normalized)."""
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


@dataclass(frozen=True)
class Association:
    """The tracker's output: a pure matching between existing tracks and this frame's detections.
    No track objects are created or mutated here — the manager applies these."""

    matches: List[Tuple[str, int, float]]  # (trackId, detectionIndex, score)
    unmatched_detections: List[int]
    unmatched_tracks: List[str]


class TrackerAdapter(Protocol):
    """The ONLY interface the TrackManager uses to talk to a tracking algorithm.

    ⚠️ An adapter that needs to know *which frame this is* — because it predicts motion across a gap —
    sets `uses_frame_index = True` and takes a third argument. The flag exists so the seam could grow
    without breaking `IouAssociator`, whose two-argument signature is still exactly right for it: an
    associator that only compares observed boxes has no use for the frame number, and widening the
    Protocol for everyone would have forced a parameter on every future tracker that ignores it.
    """

    name: str

    def associate(self, detections: Sequence[Detection], tracks: Sequence[Track]) -> Association: ...


class IouAssociator:
    """Deterministic greedy-IoU association (same-label, best-first, 1:1). Stateless."""

    name = "iou"

    def __init__(self, min_iou: float = 0.3) -> None:
        self._min_iou = min_iou

    def associate(self, detections: Sequence[Detection], tracks: Sequence[Track]) -> Association:
        candidates: List[Tuple[float, str, int]] = []
        for t in tracks:
            for di, det in enumerate(detections):
                if det.label != t.label:
                    continue
                score = iou(t.bbox, det.bbox)
                if score >= self._min_iou:
                    candidates.append((score, t.track_id, di))
        candidates.sort(key=lambda c: (-c[0], c[1], c[2]))  # deterministic

        matches: List[Tuple[str, int, float]] = []
        used_tracks: set[str] = set()
        used_dets: set[int] = set()
        for score, tid, di in candidates:
            if tid in used_tracks or di in used_dets:
                continue
            used_tracks.add(tid)
            used_dets.add(di)
            matches.append((tid, di, score))

        unmatched_dets = [i for i in range(len(detections)) if i not in used_dets]
        unmatched_tracks = [t.track_id for t in tracks if t.track_id not in used_tracks]
        return Association(matches, unmatched_dets, unmatched_tracks)

def velocity_of(track: Track, max_steps: int = 3) -> Tuple[float, float]:
    """Per-frame centroid velocity from a track's own history, or `(0, 0)` when it cannot be measured.

    ⚠️ Derived from `track.history` rather than remembered, which is what keeps the associator
    stateless and therefore interchangeable (see the module docstring). A tracker that cached velocity
    would own state the manager is supposed to own, and swapping it would silently lose that state.
    """
    hist = track.history
    if len(hist) < 2:
        return (0.0, 0.0)
    window = hist[-(max_steps + 1) :]
    first, last = window[0], window[-1]
    frames = last.frame_index - first.frame_index
    if frames <= 0:
        return (0.0, 0.0)
    a = first.centroid or ((first.bbox[0] + first.bbox[2] / 2.0), (first.bbox[1] + first.bbox[3] / 2.0))
    b = last.centroid or ((last.bbox[0] + last.bbox[2] / 2.0), (last.bbox[1] + last.bbox[3] / 2.0))
    return ((b[0] - a[0]) / frames, (b[1] - a[1]) / frames)


def predict_bbox(track: Track, frame_index: int, max_coast_frames: int = 15) -> BBox:
    """Where a track's box is expected to be at `frame_index`, coasting at its measured velocity.

    Size is held constant — only position is predicted. A constant-velocity model has no basis for
    claiming an object grew, and a box that inflates while coasting will happily swallow a
    neighbouring detection, which is precisely how an identity switch happens.

    ⚠️ Coasting is CAPPED. Extrapolating a velocity across a long gap produces a box somewhere off in
    the corner of the frame with total confidence, and it will match whatever happens to be there. Past
    the cap the last observed position is a better guess than a long extrapolation of a stale one.
    """
    gap = frame_index - track.last_seen_frame
    if gap <= 0:
        return track.bbox
    vx, vy = velocity_of(track)
    if vx == 0.0 and vy == 0.0:
        return track.bbox
    steps = min(gap, max_coast_frames)
    x, y, w, h = track.bbox
    # Clamped to the frame: a predicted box outside [0,1] cannot overlap any real detection anyway,
    # and letting it drift produces negative coordinates that read as corrupt in a diagnostics dump.
    nx = min(max(x + vx * steps, -w), 1.0)
    ny = min(max(y + vy * steps, -h), 1.0)
    return (nx, ny, w, h)


class PredictiveIouAssociator:
    """Greedy IoU association over a **motion-predicted** box (P-8 Phase 4).

    ### ⚠️ Why plain IoU cannot survive an occlusion

    `IouAssociator` compares a detection against a track's *last observed* box. That works while the
    object is visible every frame. The moment it is hidden — behind a pillar, a shelf, another person
    — the box stops being updated, and the object keeps walking. When it reappears two seconds later
    it no longer overlaps where it was last seen, IoU is 0, the association fails, and the platform
    reports a **new identity for the same person**. That is not a tuning problem: at 2 fps a person at
    normal walking pace clears their own width in about a second, so the overlap is genuinely zero and
    no threshold recovers it.

    So a lost track is matched against where it *would be* if it had kept moving. The predicted box is
    used only when it scores better than the observed one, so this can only ever recover a match that
    plain IoU would have missed — a visible, well-tracked object is associated exactly as before.

    ### ⚠️ The gate is tighter for lost tracks than for visible ones

    A coasting prediction is a guess, and a guess should have to clear a higher bar before it is
    allowed to claim an identity. `min_iou_lost` is therefore separate from and stricter than
    `min_iou`. Getting this backwards produces a tracker that looks excellent on a stability metric
    (few identity changes) while quietly swapping people whenever two of them pass each other.

    Stateless and deterministic: candidates are sorted by score with id/index tie-breaks, so the same
    frames always produce the same associations.
    """

    name = "predictive-iou"
    #: Tells the TrackManager to pass the current frame index — see `TrackerAdapter`.
    uses_frame_index = True

    def __init__(
        self,
        min_iou: float = 0.3,
        *,
        min_iou_lost: float = 0.45,
        max_coast_frames: int = 15,
        reacquire_radius: float = 1.5,
        reacquire_size_ratio: float = 2.0,
    ) -> None:
        self._min_iou = min_iou
        self._min_iou_lost = min_iou_lost
        self._max_coast = max_coast_frames
        self._reacquire_radius = reacquire_radius
        self._reacquire_size_ratio = reacquire_size_ratio

    def associate(
        self, detections: Sequence[Detection], tracks: Sequence[Track], frame_index: int = -1
    ) -> Association:
        candidates: List[Tuple[float, str, int]] = []
        for t in tracks:
            # ⚠️ `> 1`, not `> 0`. At the moment of association a healthy track's `last_seen_frame` is
            # ALWAYS the previous frame, so `frame_index > last_seen_frame` is true for every track on
            # every frame — which made the strict coasting gate the normal path and the tracker
            # created a fresh identity per frame. Coasting means "not seen last frame", and a gap of
            # one is not a gap.
            coasting = False
            floor = self._min_iou_lost if coasting else self._min_iou
            predicted = predict_bbox(t, frame_index, self._max_coast)
            for di, det in enumerate(detections):
                if det.label != t.label:
                    continue
                # ⚠️ max(observed, predicted), never predicted alone: an object that stopped moving
                # is best matched where it actually is, and its stale velocity would predict past it.
                score = max(iou(t.bbox, det.bbox), iou(predicted, det.bbox))
                if score >= floor:
                    candidates.append((score, t.track_id, di))
                elif coasting:
                    reacquired = self._reacquire_score(t, predicted, det)
                    if reacquired is not None:
                        candidates.append((reacquired, t.track_id, di))
        candidates.sort(key=lambda c: (-c[0], c[1], c[2]))

        matches: List[Tuple[str, int, float]] = []
        used_tracks: set[str] = set()
        used_dets: set[int] = set()
        for score, tid, di in candidates:
            if tid in used_tracks or di in used_dets:
                continue
            used_tracks.add(tid)
            used_dets.add(di)
            matches.append((tid, di, score))

        unmatched_dets = [i for i in range(len(detections)) if i not in used_dets]
        unmatched_tracks = [t.track_id for t in tracks if t.track_id not in used_tracks]
        return Association(matches, unmatched_dets, unmatched_tracks)

    def _reacquire_score(self, track: Track, predicted: BBox, det: Detection):
        """Distance-based re-acquisition for a coasting track, or `None` when it does not qualify.

        ### ⚠️ Why IoU alone cannot recover a real occlusion

        IoU does not degrade — it **collapses**. Two boxes overlap, and then at one pixel of
        separation they score exactly 0, with no signal about whether the miss was by a hair or by
        half the frame. Over a three-second gap a person changes pace slightly, the prediction lands
        a little short, and the identity is lost with the score reporting the same `0.0` it would
        report for someone on the other side of the room. Measured: a walker who slowed from 0.040 to
        0.033 normalized units per frame across a six-frame occlusion scored 0.43 against a 0.45 gate
        and was issued a new identity.

        Centre distance degrades smoothly and is the right tool for the reacquisition question:
        *"did something plausible turn up near where I predicted?"* It is scaled by the track's own
        box, so the tolerance is about one and a half body-widths rather than a fixed fraction of the
        frame — a distant figure gets a tight radius and a near one a generous one, which is what the
        geometry actually implies.

        ### ⚠️ These matches always rank BELOW any real overlap

        The score returned is strictly under `min_iou_lost`, so every genuine IoU match anywhere in
        the frame is preferred over every distance-based guess. This can only recover an identity
        that would otherwise have been lost; it can never take one away from a better-evidenced match.
        """
        area_t = track.bbox[2] * track.bbox[3]
        area_d = det.bbox[2] * det.bbox[3]
        if area_t <= 0 or area_d <= 0:
            return None
        ratio = area_d / area_t
        if not (1.0 / self._reacquire_size_ratio) <= ratio <= self._reacquire_size_ratio:
            return None
        limit = self._reacquire_radius * max(track.bbox[2], track.bbox[3])
        if limit <= 0:
            return None
        px, py = predicted[0] + predicted[2] / 2.0, predicted[1] + predicted[3] / 2.0
        dx, dy = det.bbox[0] + det.bbox[2] / 2.0, det.bbox[1] + det.bbox[3] / 2.0
        d = math.hypot(dx - px, dy - py)
        if d > limit:
            return None
        return self._min_iou_lost * 0.99 * (1.0 - d / limit)

