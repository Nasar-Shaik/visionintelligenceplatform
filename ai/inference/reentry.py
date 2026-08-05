"""Re-entry resolution (P-8 Phase 4) — linking an identity across a gap the tracker could not bridge.

### The three gaps, and why only one of them is this module's problem

    1. a frame or two          the associator matches straight through it — nothing happens here
    2. up to `max_age` frames  the track goes `lost` and coasts; the SAME trackId recovers
    3. longer than that        the track is `removed`. A returning object is a NEW track.   ← here

Case 3 is a real event in any deployment: someone walks out of shot and comes back, or stands behind a
pillar for ten seconds. Reporting them as an unrelated stranger throws away the one fact an
investigator most wants.

### ⚠️ The returning track gets a NEW trackId. Always.

The obvious implementation hands the old `trackId` back, and it is wrong. The frozen Track contract
guarantees ids are never reused within a session, and every consumer holding the earlier id — an
event, an evidence reference, a rule's memory — would silently start referring to a different
appearance. Worse, the guarantee would fail *quietly*: nothing would error, the data would just mean
something else.

So a link is recorded instead. `identityId` is the first trackId in the chain, `precededBy` is the
immediate predecessor, and `recoveries` counts the hops. "Same person" and "same uninterrupted
observation" become two questions with two answers, which is what they always were.

### ⚠️ This is appearance-blind, and the limit is stated rather than hidden

Matching is on **position, size, label and elapsed time** — where the object vanished, where one
reappeared, how long it took and whether it plausibly walked there. There is no re-identification
model: no appearance embedding, no clothing colour, no gait. Two similarly-sized people passing
through the same doorway within the gap window are indistinguishable to this logic, and it will link
the wrong one. That is why the gate is deliberately tight and why `identityId` is advisory metadata
rather than an assertion of fact — see L-42.

Stdlib-only, deterministic: candidates are scored and sorted with an id tie-break, so the same
sequence always produces the same links.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Deque, List, Optional
from collections import deque

from track_motion import centroid, seconds_of
from tracking_contracts import Track


@dataclass(frozen=True)
class Candidate:
    """A removed track still eligible to be somebody's previous identity."""

    track_id: str
    identity_id: str
    label: str
    centroid_x: float
    centroid_y: float
    width: float
    height: float
    last_frame: int
    last_at: str
    recoveries: int


@dataclass(frozen=True)
class Link:
    identity_id: str
    preceded_by: str
    recoveries: int


class ReentryResolver:
    """Offers a newly created track the identity of a recently removed one, when the evidence fits.

    The four gates below are ANDed, and each exists because dropping it produces a specific wrong
    answer:

      `max_gap_seconds`   without it, a track removed an hour ago claims a stranger this afternoon
      `max_distance`      without it, a person who left through the north door is "the same" as one
                          who entered through the south — the link becomes a coin flip on a busy scene
      `size_ratio`        without it, a child at the back of the room inherits an adult's identity at
                          the front, because both are "a person near the middle"
      same `label`        a car does not become the person who walked away from it
    """

    def __init__(
        self,
        *,
        max_gap_seconds: float = 12.0,
        max_distance: float = 0.35,
        size_ratio: float = 2.0,
        capacity: int = 64,
    ) -> None:
        self._max_gap = max_gap_seconds
        self._max_distance = max_distance
        self._size_ratio = size_ratio
        # ⚠️ Bounded. This runs for weeks on a live camera; an unbounded list of everyone who has ever
        # left the frame is a memory leak wearing the costume of a feature.
        self._candidates: Deque[Candidate] = deque(maxlen=capacity)
        self.links = 0

    def retire(self, track: Track) -> None:
        """Record a removed track as eligible to be re-entered."""
        cx, cy = track.centroid or centroid(track.bbox)
        self._candidates.append(
            Candidate(
                track_id=track.track_id,
                identity_id=track.identity_id or track.track_id,
                label=track.label,
                centroid_x=cx,
                centroid_y=cy,
                width=track.bbox[2],
                height=track.bbox[3],
                last_frame=track.last_seen_frame,
                last_at=track.last_seen_at,
                recoveries=track.recoveries,
            )
        )

    def resolve(self, track: Track) -> Optional[Link]:
        """Find the best previous identity for a newly created track, or `None`.

        A successful resolve **consumes** the candidate: one departure can only be one return, and
        leaving it in the pool would let a single removed track adopt every new person in the scene.
        """
        now = seconds_of(track.first_seen_at)
        cx, cy = track.centroid or centroid(track.bbox)

        scored: List[tuple] = []
        for cand in self._candidates:
            if cand.label != track.label:
                continue
            then = seconds_of(cand.last_at)
            # ⚠️ An unparseable timestamp on either side means the gap is unknown, and an unknown gap
            # is not a small one. Refusing to link is the fail-closed answer.
            if now is None or then is None:
                continue
            gap = now - then
            if gap < 0 or gap > self._max_gap:
                continue
            dist = math.hypot(cx - cand.centroid_x, cy - cand.centroid_y)
            if dist > self._max_distance:
                continue
            if not self._size_fits(track.bbox[2], track.bbox[3], cand.width, cand.height):
                continue
            scored.append((dist, gap, cand.track_id, cand))

        if not scored:
            return None
        # Nearest wins; then the shorter gap; then the id, so ties never depend on dict ordering.
        scored.sort(key=lambda s: (s[0], s[1], s[2]))
        best: Candidate = scored[0][3]
        self._candidates = deque(
            (c for c in self._candidates if c.track_id != best.track_id),
            maxlen=self._candidates.maxlen,
        )
        self.links += 1
        return Link(
            identity_id=best.identity_id,
            preceded_by=best.track_id,
            recoveries=best.recoveries + 1,
        )

    def _size_fits(self, w: float, h: float, cw: float, ch: float) -> bool:
        area, cand_area = w * h, cw * ch
        if area <= 0 or cand_area <= 0:
            return False
        ratio = area / cand_area
        return (1.0 / self._size_ratio) <= ratio <= self._size_ratio

    def pending(self) -> int:
        return len(self._candidates)
