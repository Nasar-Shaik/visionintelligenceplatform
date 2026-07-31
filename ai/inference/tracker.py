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
    """The ONLY interface the TrackManager uses to talk to a tracking algorithm."""

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
