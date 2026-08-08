"""Behaviour primitives (P-11 slice 2.1) — geometric and temporal facts, and nothing else.

    perception  →  BEHAVIOUR PRIMITIVES  →  domain rules
    observations    facts about geometry     the only layer that names an intent
                    and time

⛔ **Every function here must pass the hospital test**: a hospital, a warehouse, a school and a
factory must all be able to use it without renaming it. `dwell` passes — waiting, queueing, idling
and loitering are one primitive under four business meanings. `concealment` fails, which is exactly
why it is not in this file and lives in a rule instead ([ADR-0052]).

### The three traps this module exists to not fall into

1. ⛔ **Accumulate by `identity_id`, never `track_id`.** A person briefly occluded returns with a
   **new** track id — ADR-0038 forbids reuse — so anything summed over time that groups by track id
   sees *two short visits instead of one long one*. A 60-second loitering rule then never fires for
   anyone who walks behind a display, and every dwell figure in the report looks normal. Every
   accumulating function here takes points already grouped by identity, and `group_by_identity()` is
   the only supported way to produce them.

2. ⛔ **Time is footage time, in seconds.** Track age advances per *frame* in the runtime, and
   `CAMERA_IDLE_SECONDS = 300`, so a camera at 1 fps ages tracks five times slower than one at 5 fps.
   A primitive that counted frames would give two different answers for the same clip at two rates.
   Every duration here is derived from `at_seconds`.

3. ⚠️ **Coordinates are normalized `[0,1]`, so speed is not metric.** `velocity()` returns
   **frame-widths per second** and the unit is in the return type's name, because a number called
   "speed" that means "0.3 screens/s" will be read as m/s by the first person who sees it, and two
   cameras with different fields of view will disagree about the same walk. Calibration is the
   `CoordinateTransform` seam in `coordinates.py`; until it is wired, this is the honest unit.

Stdlib-only, pure, deterministic. No I/O, no model, no clock.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Protocol, Sequence, Tuple

Box = Tuple[float, float, float, float]  # (x, y, w, h), normalized, origin top-left


@dataclass(frozen=True)
class TrackPoint:
    """One subject, in one frame, at one footage time."""

    identity_id: str
    at_seconds: float
    bbox: Box
    label: str = "person"
    track_id: Optional[str] = None
    frame_index: Optional[int] = None
    confidence: float = 1.0
    #: Zones this point was **already found to be inside**, decided upstream (P-11 slice 2.2).
    #:
    #: ⭐ **Membership is an input fact here, not a computation.** The platform resolves it exactly
    #: once, in `services/media/src/application/zone-resolver.ts`, against operator-drawn polygons
    #: that are deployment configuration rather than perception. A second polygon engine in this
    #: layer would be a second answer to "which zone was this person in", and the first time the two
    #: disagreed nobody would be able to say which was right. `MembershipZone` reads this; the
    #: geometric zones below are for callers that hold the geometry themselves.
    zone_ids: Tuple[str, ...] = ()

    @property
    def centroid(self) -> Tuple[float, float]:
        x, y, w, h = self.bbox
        return (x + w / 2.0, y + h / 2.0)

    @property
    def foot_point(self) -> Tuple[float, float]:
        """Bottom-centre — where the subject meets the floor.

        ⚠️ **Zone membership uses this, not the centroid.** A person standing at the edge of a zone
        has a centroid floating at chest height that can sit outside a floor region they are plainly
        standing in, and the error grows with how close the camera is. For an *object* the centroid
        is right, which is why both are offered rather than one being imposed.
        """
        x, y, w, h = self.bbox
        return (x + w / 2.0, y + h)


class ZoneRegion(Protocol):
    """What every zone-shaped thing must answer: *was this observation inside me?*

    ⭐ **The seam takes the whole `TrackPoint`, not a coordinate**, and that is what lets membership
    arrive as a fact (`MembershipZone`) or be computed from geometry (`Zone`, `PolygonZone`) behind
    one interface. A coordinate-only seam would have forced every caller to hold the geometry.
    """

    zone_id: str

    def holds(self, point: "TrackPoint", *, use_foot_point: bool = True) -> bool: ...


@dataclass(frozen=True)
class Zone:
    """An axis-aligned region of the frame, in normalized coordinates.

    ⚠️ A rectangle, and honest about it. VIP's operator-drawn zones are polygons — use `PolygonZone`,
    which delegates to the runtime's existing `zones.point_in_polygon` rather than reimplementing it.
    """

    zone_id: str
    bbox: Box

    def contains(self, point: Tuple[float, float]) -> bool:
        x, y, w, h = self.bbox
        return x <= point[0] <= x + w and y <= point[1] <= y + h

    def holds(self, point: "TrackPoint", *, use_foot_point: bool = True) -> bool:
        return self.contains(point.foot_point if use_foot_point else point.centroid)


@dataclass(frozen=True)
class PolygonZone:
    """An operator-drawn zone, as the platform actually stores them.

    ⚠️ `point_in_polygon` is imported from the runtime's `zones` module rather than copied. Two
    ray-casts that must agree is a defect waiting for a boundary case, and this layer is not where
    that question gets a second opinion.
    """

    zone_id: str
    points: Sequence[Tuple[float, float]]

    def contains(self, point: Tuple[float, float]) -> bool:
        from zones import point_in_polygon  # noqa: WPS433 - local, keeps this module import-light

        return point_in_polygon(point, self.points)

    def holds(self, point: "TrackPoint", *, use_foot_point: bool = True) -> bool:
        return self.contains(point.foot_point if use_foot_point else point.centroid)


@dataclass(frozen=True)
class MembershipZone:
    """A zone whose membership was decided upstream and travels on the point.

    ⭐ **The production shape.** The platform resolves zones once, in media, and stamps the result
    into the frozen contract's `Detection.attributes["zoneIds"]`. This reads that back, so dwell,
    visits and transitions are computed from the same membership every event in the system already
    carries — no second polygon engine, no second answer.

    ⛔ **A point with no `zone_ids` is outside every zone, which is indistinguishable from a point
    whose membership was never resolved.** That ambiguity is real and it is why the behaviour stage
    reports whether membership was present at all, rather than publishing a confident 0.0 s dwell for
    a deployment that simply never sent it.
    """

    zone_id: str

    def holds(self, point: "TrackPoint", *, use_foot_point: bool = True) -> bool:
        return self.zone_id in point.zone_ids


@dataclass(frozen=True)
class Interval:
    """A closed span of footage time, with the frames that bounded it."""

    start_seconds: float
    end_seconds: float

    @property
    def seconds(self) -> float:
        return round(max(0.0, self.end_seconds - self.start_seconds), 4)


@dataclass(frozen=True)
class ZoneVisit:
    """One continuous stay in one zone by one identity."""

    identity_id: str
    zone_id: str
    interval: Interval
    #: True when the track ended while still inside — the visit was cut off, not completed.
    open_ended: bool = False


# --- grouping -------------------------------------------------------------------------------------


def group_by_identity(points: Iterable[TrackPoint]) -> Dict[str, List[TrackPoint]]:
    """⭐ The only supported way to prepare points for an accumulating primitive.

    Sorts each identity's points by footage time. ⚠️ Points arriving out of order is not
    hypothetical — the runtime records `outOfOrderFrames` precisely because it happens — and a
    trajectory assembled in the wrong order produces negative durations and a heading that points
    backwards.
    """
    grouped: Dict[str, List[TrackPoint]] = {}
    for point in points:
        grouped.setdefault(point.identity_id, []).append(point)
    for identity in grouped.values():
        identity.sort(key=lambda p: p.at_seconds)
    return grouped


# --- motion ---------------------------------------------------------------------------------------


def trajectory(points: Sequence[TrackPoint]) -> List[Tuple[float, float]]:
    """The path, as centroids in time order."""
    return [p.centroid for p in points]


def path_length(points: Sequence[TrackPoint]) -> float:
    """Total distance travelled, in **frame widths**. Fewer than two points is 0.0, not an error."""
    total = 0.0
    for previous, current in zip(points, points[1:]):
        total += _distance(previous.centroid, current.centroid)
    return round(total, 6)


def velocity_frames_per_second(points: Sequence[TrackPoint]) -> Optional[float]:
    """Average speed in **frame widths per second**, or `None` when it cannot be computed.

    ⛔ `None`, never `0.0`, when there is nothing to measure. A stationary person and an empty
    history are different facts, and `0.0` reads as the first while meaning the second — the failure
    mode this project has now caught eight times.
    """
    if len(points) < 2:
        return None
    elapsed = points[-1].at_seconds - points[0].at_seconds
    if elapsed <= 0:
        return None
    return round(path_length(points) / elapsed, 6)


def direction_degrees(points: Sequence[TrackPoint]) -> Optional[float]:
    """Net heading in degrees, 0° = east, 90° = **north** (up the screen), or `None`.

    ⚠️ Screen y grows downward, so the sign is flipped here. A heading that silently reports 'south'
    for a subject walking up the frame is the kind of defect that survives review because both
    conventions look right in isolation.
    """
    if len(points) < 2:
        return None
    import math

    (x1, y1), (x2, y2) = points[0].centroid, points[-1].centroid
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return None
    return round(math.degrees(math.atan2(-dy, dx)) % 360.0, 4)


# --- zones ----------------------------------------------------------------------------------------


def zone_visits(points: Sequence[TrackPoint], zone: ZoneRegion, *, use_foot_point: bool = True) -> List[ZoneVisit]:
    """Every continuous stay in `zone`, in time order.

    ⭐ **Returns visits, not a boolean.** "Was this person in the zone" cannot express someone who
    entered, left and came back — and that pattern is what separates a shopper from a loiterer.

    ⚠️ A visit still open when the track ends is marked `open_ended`. A truncated stay reported as a
    completed one understates dwell for exactly the subjects who stayed longest.
    """
    if not points:
        return []
    identity = points[0].identity_id
    visits: List[ZoneVisit] = []
    start: Optional[float] = None
    previous_at = points[0].at_seconds

    for point in points:
        inside = zone.holds(point, use_foot_point=use_foot_point)
        if inside and start is None:
            start = point.at_seconds
        elif not inside and start is not None:
            visits.append(ZoneVisit(identity, zone.zone_id, Interval(start, previous_at)))
            start = None
        previous_at = point.at_seconds

    if start is not None:
        visits.append(ZoneVisit(identity, zone.zone_id, Interval(start, previous_at), open_ended=True))
    return visits


def dwell_seconds(points: Sequence[TrackPoint], zone: ZoneRegion, **kwargs) -> float:
    """Total time inside `zone`, summed across every visit.

    ⛔ Summed across visits deliberately: a shopper who steps out of frame and returns has one dwell,
    not two — provided the points were grouped by `identity_id` (see `group_by_identity`).
    """
    return round(sum(v.interval.seconds for v in zone_visits(points, zone, **kwargs)), 4)


def zone_transitions(
    points: Sequence[TrackPoint], zones: Sequence[ZoneRegion], **kwargs
) -> List[Tuple[float, str, str]]:
    """`(at_seconds, event, zone_id)` where event is `entered` or `left`, in time order."""
    events: List[Tuple[float, str, str]] = []
    for zone in zones:
        for visit in zone_visits(points, zone, **kwargs):
            events.append((visit.interval.start_seconds, "entered", zone.zone_id))
            if not visit.open_ended:
                events.append((visit.interval.end_seconds, "left", zone.zone_id))
    events.sort(key=lambda e: (e[0], e[2], e[1]))
    return events


# --- relational -----------------------------------------------------------------------------------


def distance_between(a: TrackPoint, b: TrackPoint) -> float:
    """Centre-to-centre distance in **frame widths**."""
    return round(_distance(a.centroid, b.centroid), 6)


def iou(a: Box, b: Box) -> float:
    """Overlap of two boxes, 0.0–1.0."""
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    overlap = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = a[2] * a[3] + b[2] * b[3] - overlap
    return round(overlap / union, 6) if union > 0 else 0.0


def near(a: TrackPoint, b: TrackPoint, *, threshold: float = 0.05) -> bool:
    """Within `threshold` frame widths, **or** overlapping at all.

    ⚠️ Both tests, because a hand reaching *behind* an object is centre-distant and overlapping,
    while a hand beside a large object is close but not overlapping. Either alone misses a case that
    matters for `hand_near_object`.
    """
    return distance_between(a, b) <= threshold or iou(a.bbox, b.bbox) > 0.0


def co_presence_seconds(a: Sequence[TrackPoint], b: Sequence[TrackPoint], *, threshold: float = 0.05) -> float:
    """How long two identities were near each other, sampled at `a`'s frames.

    ⚠️ Asymmetric by construction, and that is a limitation rather than a design: it assumes the two
    subjects were observed on the same frames. Matching across differing timelines needs
    interpolation, which is deferred rather than approximated.
    """
    if len(a) < 2:
        return 0.0
    by_time = {round(p.at_seconds, 3): p for p in b}
    total = 0.0
    for previous, current in zip(a, a[1:]):
        partner = by_time.get(round(previous.at_seconds, 3))
        if partner is not None and near(previous, partner, threshold=threshold):
            total += current.at_seconds - previous.at_seconds
    return round(total, 4)


def occupancy_count(
    subjects: Dict[str, Sequence[TrackPoint]],
    *,
    at_seconds: float,
    zone: Optional[ZoneRegion] = None,
    tolerance: float = 0.001,
    use_foot_point: bool = True,
) -> int:
    """How many identities were present at one instant, optionally inside one zone.

    ⭐ **Identities, not detections.** Counting boxes double-counts a subject the detector split
    across two overlapping proposals, and counting `track_id`s double-counts anyone who was briefly
    occluded — the same trap as dwell, in a number an operator reads on a dashboard.

    ⚠️ `tolerance` exists because footage timestamps are floats: two subjects observed on the same
    frame can differ in the last decimal, and an exact match would report an empty room.
    """
    total = 0
    for points in subjects.values():
        match = next((p for p in points if abs(p.at_seconds - at_seconds) <= tolerance), None)
        if match is None:
            continue
        if zone is None or zone.holds(match, use_foot_point=use_foot_point):
            total += 1
    return total


# --- presence and occlusion -------------------------------------------------------------------------


def observation_gaps(points: Sequence[TrackPoint], *, expected_interval: float, factor: float = 2.5) -> List[Interval]:
    """Spans where a subject was tracked, vanished, and came back.

    ⭐ The primitive under `occlusion`, `object_disappeared` and `object_reappeared` — one mechanism,
    three business words. ⚠️ It cannot say *why*: a shopper behind a display, an object in a bag and
    a detector that simply missed three frames produce identical gaps. Naming it `observation_gaps`
    rather than `occlusion` keeps that ambiguity visible to whoever writes the rule.
    """
    if expected_interval <= 0:
        raise ValueError("expected_interval must be positive")
    threshold = expected_interval * factor
    gaps: List[Interval] = []
    for previous, current in zip(points, points[1:]):
        delta = current.at_seconds - previous.at_seconds
        if delta > threshold:
            gaps.append(Interval(previous.at_seconds, current.at_seconds))
    return gaps


# --- object association -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Association:
    """A span during which an object stayed near one subject."""

    object_identity: str
    subject_identity: str
    interval: Interval
    open_ended: bool = False


def associations(
    object_points: Sequence[TrackPoint],
    subjects: Dict[str, Sequence[TrackPoint]],
    *,
    threshold: float = 0.05,
) -> List[Association]:
    """Which subject an object travelled with, over time.

    ⭐ **This is what makes `picked_object`, `returned_object` and `handover` geometry rather than
    guesswork.** Without object identity across frames, taking and replacing are the same skeleton;
    with it, they are two zone-crossings of a tracked box.

    ⚠️ Nearest-subject-per-frame, which is a heuristic and is named as one. Two people reaching at
    once will flip the association between them, and the resulting rapid alternation is a signal a
    rule should treat as *ambiguous* rather than as a handover.
    """
    by_time: Dict[float, List[Tuple[str, TrackPoint]]] = {}
    for identity, points in subjects.items():
        for point in points:
            by_time.setdefault(round(point.at_seconds, 3), []).append((identity, point))

    spans: List[Association] = []
    current: Optional[str] = None
    started: Optional[float] = None
    previous_at: Optional[float] = None

    for point in object_points:
        candidates = by_time.get(round(point.at_seconds, 3), [])
        nearest, best = None, None
        for identity, subject_point in candidates:
            if not near(point, subject_point, threshold=threshold):
                continue
            gap = distance_between(point, subject_point)
            if best is None or gap < best:
                nearest, best = identity, gap

        if nearest != current:
            if current is not None and started is not None and previous_at is not None:
                spans.append(Association(point.identity_id, current, Interval(started, previous_at)))
            current, started = nearest, point.at_seconds if nearest is not None else None
        previous_at = point.at_seconds

    if current is not None and started is not None and previous_at is not None:
        spans.append(Association(object_points[0].identity_id, current, Interval(started, previous_at), True))
    return spans


def handovers(spans: Sequence[Association], *, max_gap_seconds: float = 2.0) -> List[Tuple[float, str, str]]:
    """`(at_seconds, from_identity, to_identity)` where one object passed between two subjects.

    ⭐ The primitive behind staff–customer collusion in retail, an instrument pass in a hospital and
    a tool transfer in a factory — one mechanism, three business meanings, which is what makes it a
    Layer 2 primitive rather than a retail feature.
    """
    events: List[Tuple[float, str, str]] = []
    for previous, current in zip(spans, spans[1:]):
        gap = current.interval.start_seconds - previous.interval.end_seconds
        if 0 <= gap <= max_gap_seconds and previous.subject_identity != current.subject_identity:
            events.append((current.interval.start_seconds, previous.subject_identity, current.subject_identity))
    return events


def _distance(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
