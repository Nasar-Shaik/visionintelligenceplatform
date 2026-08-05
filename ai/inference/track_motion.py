"""Track motion (P-8 Phase 4) — duration, travelled path, speed, direction and dwell, derived from a
track's own bounded history and nothing else.

### ⚠️ Pure functions over a history, deliberately

Nothing here holds state, reads a clock, or knows what a camera is. Motion is a *view* of the history
the `TrackManager` already keeps, so it can be recomputed from an archived track and produce the same
answer — which is the property that makes it usable as evidence. A stateful accumulator would give a
different answer depending on when you asked.

### ⚠️ NORMALIZED UNITS, never metres

`bbox` and `centroid` are fractions of the frame. A speed computed from them is **frame widths per
second**. Converting to m/s needs camera intrinsics, mounting height, tilt and a ground-plane
homography — none of which this platform has. Two people walking at identical real speeds, one near
the lens and one far from it, produce very different numbers here, and that is a property of the
measurement rather than a defect in it. Every field is named for what it actually is.

### ⚠️ Direction is IMAGE space

`0°` is +x (right); degrees increase **clockwise** because image `y` grows downward, so `90°` is down
the screen. It is not a compass bearing and says nothing about which way the subject was facing.

Stdlib-only, deterministic.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import List, Optional, Sequence, Tuple

from tracking_contracts import HEADING_LABELS, BBox, Point, TrackHistoryPoint, TrackMotion

#: Steps at or below this speed count as dwell rather than travel, in normalized units per second.
#: ⚠️ A threshold, not a truth: a detector's box jitters by a pixel or two even on a motionless
#: subject, so "speed exactly 0" never occurs in practice and a zero threshold would report zero
#: dwell for a person standing still. 0.01 is roughly one percent of the frame per second.
DWELL_SPEED = 0.01

#: How many recent steps "current speed" and heading are computed over. Small enough to react, large
#: enough that one jittery box does not swing the reported direction by 180°.
RECENT_STEPS = 5

#: Below this displacement the track has no direction worth reporting, in normalized units. Under it
#: the heading is omitted — never defaulted to 0°, which would read as "travelling right".
MIN_HEADING_DISPLACEMENT = 0.01


def centroid(bbox: BBox) -> Point:
    """Centre of `[x, y, w, h]`."""
    return (bbox[0] + bbox[2] / 2.0, bbox[1] + bbox[3] / 2.0)


def distance(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def seconds_of(value: str) -> Optional[float]:
    """Parse a history timestamp to seconds.

    ⚠️ Two formats exist in this runtime and both are load-bearing: the live path stamps ISO
    (`2026-08-05T09:00:00.123Z`), while batch analysis and the deterministic tests use a relative
    `12.5s`. Returning `None` for anything else is the point — a fabricated 0 would turn an
    unparseable timestamp into "this happened at the epoch", and every duration derived from it into
    a confident lie.
    """
    if not isinstance(value, str) or value == "":
        return None
    text = value.strip()
    if text.endswith("s") and not text.endswith("Z"):
        try:
            return float(text[:-1])
        except ValueError:
            return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text).timestamp()
    except (TypeError, ValueError):
        return None


def heading_of(dx: float, dy: float) -> float:
    """Image-space heading in degrees: 0 = +x (right), increasing clockwise (because +y is down)."""
    return math.degrees(math.atan2(dy, dx)) % 360.0


def heading_label(degrees: float) -> str:
    return HEADING_LABELS[int(round(degrees / 45.0)) % 8]


def _points(history: Sequence[TrackHistoryPoint]) -> List[Tuple[Point, Optional[float]]]:
    return [(h.centroid or centroid(h.bbox), seconds_of(h.at)) for h in history]


def motion_from_history(history: Sequence[TrackHistoryPoint]) -> Optional[TrackMotion]:
    """Compute motion over a bounded history, or `None` when there is not enough of it.

    ⚠️ Returns `None` for a single point rather than a zero-filled motion. One observation carries no
    movement information at all, and "speed 0.0, straight line" is a description of a stationary
    object — a claim this function has no basis for making about an object seen once.
    """
    if len(history) < 2:
        return None

    pts = _points(history)
    first_pt, first_t = pts[0]
    last_pt, last_t = pts[-1]

    path = 0.0
    dwell = 0.0
    for i in range(1, len(pts)):
        (pa, ta), (pb, tb) = pts[i - 1], pts[i]
        step = distance(pa, pb)
        path += step
        if ta is not None and tb is not None and tb > ta:
            dt = tb - ta
            if step / dt <= DWELL_SPEED:
                dwell += dt

    duration = last_t - first_t if (first_t is not None and last_t is not None and last_t >= first_t) else 0.0
    displacement = distance(first_pt, last_pt)

    average_speed = path / duration if duration > 0 else 0.0

    # Recent window: the last RECENT_STEPS steps, which is RECENT_STEPS + 1 points.
    recent = pts[-(RECENT_STEPS + 1) :]
    recent_path = sum(distance(recent[i - 1][0], recent[i][0]) for i in range(1, len(recent)))
    r_first_t, r_last_t = recent[0][1], recent[-1][1]
    recent_duration = (
        r_last_t - r_first_t if (r_first_t is not None and r_last_t is not None and r_last_t > r_first_t) else 0.0
    )
    current_speed = recent_path / recent_duration if recent_duration > 0 else 0.0

    heading_degrees: Optional[float] = None
    label: Optional[str] = None
    dx = recent[-1][0][0] - recent[0][0][0]
    dy = recent[-1][0][1] - recent[0][0][1]
    if math.hypot(dx, dy) >= MIN_HEADING_DISPLACEMENT:
        heading_degrees = heading_of(dx, dy)
        label = heading_label(heading_degrees)

    # ⚠️ Straightness is undefined, not 1.0, for a track that has not moved: dividing a zero
    # displacement by a zero path is 0/0, and "perfectly straight" is the flattering reading of it.
    straightness = min(1.0, displacement / path) if path > 0 else None

    return TrackMotion(
        duration_seconds=duration,
        path_length=path,
        displacement=displacement,
        average_speed=average_speed,
        current_speed=current_speed,
        dwell_seconds=dwell,
        samples=len(history),
        heading_degrees=heading_degrees,
        heading_label=label,
        straightness=straightness,
    )
