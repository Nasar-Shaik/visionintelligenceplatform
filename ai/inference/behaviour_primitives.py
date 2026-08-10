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

import math
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
    #: ⛔ Whether membership for this observation has been **decided** — a different question from
    #: whether it found any. `False` means nothing has said yet; `True` with an empty `zone_ids`
    #: means something said "inside none". Membership is resolved a frame after the box (ADR-0053),
    #: so an undecided point read as "outside" would close a zone visit that never ended.
    zones_settled: bool = False

    def __post_init__(self) -> None:
        # ⭐ Non-empty membership implies settled, enforced here so the contradiction cannot be
        # built. A point carrying `("z_till",)` with `zones_settled=False` says "nothing has decided
        # this, and it was inside the till zone" — two callers reading it would reasonably disagree
        # about which half to believe. One invariant in one place beats a rule every construction
        # site has to remember.
        if self.zone_ids and not self.zones_settled:
            object.__setattr__(self, "zones_settled", True)

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

    #: ⛔ Whether this zone can only answer for a point whose membership has been **decided**.
    #:
    #: A geometric zone answers for any point — it holds the polygon. A `MembershipZone` answers only
    #: from what an upstream said, and membership arrives a frame after the box does (ADR-0053), so a
    #: point it has not yet heard about must be *skipped* rather than treated as outside. Expressed on
    #: the zone rather than on the caller because it is a property of how the zone knows things.
    requires_membership: bool

    def holds(self, point: "TrackPoint", *, use_foot_point: bool = True) -> bool: ...


def observed_points(points: Sequence["TrackPoint"], zone: ZoneRegion) -> List["TrackPoint"]:
    """The points `zone` is able to answer for.

    ⛔ **Everything zone-shaped walks consecutive points, so a skipped point is not the same as an
    excluded one.** Dropping an undecided point joins the observations either side of it, which is
    right: the subject did not leave and come back, we simply have not been told about the moment in
    between. Treating it as "outside" is what produces a `left` transition that never happened.
    """
    if not getattr(zone, "requires_membership", False):
        return list(points)
    return [p for p in points if p.zones_settled]


@dataclass(frozen=True)
class Zone:
    """An axis-aligned region of the frame, in normalized coordinates.

    ⚠️ A rectangle, and honest about it. VIP's operator-drawn zones are polygons — use `PolygonZone`,
    which delegates to the runtime's existing `zones.point_in_polygon` rather than reimplementing it.
    """

    zone_id: str
    bbox: Box
    #: It holds the geometry, so it can answer for any point. See `ZoneRegion.requires_membership`.
    requires_membership: bool = False

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
    #: It holds the geometry, so it can answer for any point. See `ZoneRegion.requires_membership`.
    requires_membership: bool = False

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
    #: It knows nothing the point does not carry. See `ZoneRegion.requires_membership`.
    requires_membership: bool = True

    def holds(self, point: "TrackPoint", *, use_foot_point: bool = True) -> bool:
        return point.zones_settled and self.zone_id in point.zone_ids


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

    ⛔ Points the zone cannot answer for are **skipped**, not counted as outside — see
    `observed_points`. For a `MembershipZone` that is every point whose membership has not come back
    from the resolver yet, which on the live path is always the newest one.
    """
    points = observed_points(points, zone)
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


#: "Near" in **frame widths**, not metres. ⚠️ Named once because three call sites and every API that
#: reports a proximity must agree about it; a proximity claim whose threshold differs between the
#: computation and the sentence describing it is a claim nobody made.
NEAR_THRESHOLD = 0.05


def near(a: TrackPoint, b: TrackPoint, *, threshold: float = NEAR_THRESHOLD) -> bool:
    """Within `threshold` frame widths, **or** overlapping at all.

    ⚠️ Both tests, because a hand reaching *behind* an object is centre-distant and overlapping,
    while a hand beside a large object is close but not overlapping. Either alone misses a case that
    matters for `hand_near_object`.
    """
    return distance_between(a, b) <= threshold or iou(a.bbox, b.bbox) > 0.0


def co_presence_seconds(
    a: Sequence[TrackPoint], b: Sequence[TrackPoint], *, threshold: float = NEAR_THRESHOLD
) -> float:
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


#: Labels a person can plausibly carry — the domain of `carried`, `picked`, `dropped` and `handover`.
#:
#: ⛔ **Found by the first real multi-class run, slice 2.10.** "Object" had meant *any label that is
#: not a subject* since slice 2.2, and the diagnostic on that run reported the association layer's
#: input as `["backpack", "car", "suitcase"]` — a **parked car**, sitting in the population
#: `associations()` scans, one proximity away from the sentence *"this person carried a car"*.
#:
#: ⚠️ **It did not produce that span, and the distinction is the honest one.** The car never came
#: within `NEAR_THRESHOLD` of the walker, so nothing false was published. What was wrong was that
#: only the geometry stood between the platform and the claim — and in a car park a person passing
#: close to a car is not an unusual event, it is the whole scene. This removes the possibility
#: rather than an observation.
#:
#: ⚠️ **This narrows one family, not the object concept.** A car stays a tracked object with an
#: identity; proximity, approach and departure remain perfectly meaningful about it. Only the
#: statement *carried* requires that the thing can be picked up, and that is a fact about the world
#: rather than about this scene, so it belongs in a named list rather than in a threshold.
#:
#: ⚠️ COCO's vocabulary, because that is what the deployed detector emits. A deployment whose model
#: has other labels passes its own set — the same way `subject_labels` has always worked.
DEFAULT_CARRIABLE_LABELS: Tuple[str, ...] = (
    "backpack",
    "handbag",
    "suitcase",
    "bottle",
    "cup",
    "wine glass",
    "laptop",
    "book",
    "cell phone",
    "umbrella",
    "sports ball",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "frisbee",
    "remote",
    "keyboard",
    "mouse",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
    "knife",
    "spoon",
    "fork",
    "bowl",
    "vase",
    "tie",
)


def carriable(points: Sequence[TrackPoint], *, labels: Sequence[str] = DEFAULT_CARRIABLE_LABELS) -> bool:
    """Whether this object is the kind of thing a person can carry.

    ⚠️ Decided on the **last** observation's label, matching how every other module names an object.
    A track whose label changed mid-run is a tracking defect, and resolving it here would hide it.
    """
    return bool(points) and points[-1].label in set(labels)


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


@dataclass(frozen=True)
class ObjectEvent:
    """One moment in an object's relationship with the subjects around it.

    ⛔ **`kind` states what was observed, never why.** `picked` means *an object that was travelling
    with nobody began travelling with someone*; it does not mean taken, and certainly not stolen. The
    distance between those sentences is the distance between Layer 2 and an accusation, and it is the
    reason a rule has to add evidence this layer does not have.
    """

    kind: str
    object_identity: str
    at_seconds: float
    subject_identity: Optional[str] = None
    #: How long the object had been in the preceding state — the carry that ended, the gap that
    #: closed. ⚠️ `None` where the run began or ended mid-state, so the duration is unknown rather
    #: than zero.
    seconds: Optional[float] = None


def object_events(
    object_points: Sequence[TrackPoint],
    subjects: Mapping[str, Sequence[TrackPoint]],
    *,
    expected_interval: float,
    threshold: float = NEAR_THRESHOLD,
    gap_factor: float = 2.5,
) -> List[ObjectEvent]:
    """`picked`, `dropped`, `missing` and `returned`, for one object.

    ⭐ **Four business words, two mechanisms already in this file.** `picked` and `dropped` are the
    edges of an `associations` span; `missing` and `returned` are the edges of an
    `observation_gaps` interval. Nothing new is computed — which is the point, because a second way
    of deciding "is this object with that person" would be a second answer to the same question.

    ⚠️ **An object put down and an object hidden are the same observation.** A bag placed on a shelf
    and a bag pushed into a coat both stop being detected, and this reports `missing` for each. That
    ambiguity is the whole reason the word is `missing` rather than `concealed` — separating them
    needs the subject's behaviour around the moment, which is a rule's job.

    ⛔ An open span produces **no** `dropped`, and a gap still open at the end produces no
    `returned`. The run ending is not an event.
    """
    if not object_points:
        return []
    out: List[ObjectEvent] = []
    spans = associations(object_points, {i: list(p) for i, p in subjects.items()}, threshold=threshold)
    for span in spans:
        out.append(
            ObjectEvent(
                kind="picked",
                object_identity=span.object_identity,
                at_seconds=span.interval.start_seconds,
                subject_identity=span.subject_identity,
            )
        )
        if not span.open_ended:
            out.append(
                ObjectEvent(
                    kind="dropped",
                    object_identity=span.object_identity,
                    at_seconds=span.interval.end_seconds,
                    subject_identity=span.subject_identity,
                    seconds=span.interval.seconds,
                )
            )

    if expected_interval > 0:
        identity = object_points[0].identity_id
        holder_at = _holder_at(spans)
        for gap in observation_gaps(object_points, expected_interval=expected_interval, factor=gap_factor):
            out.append(
                ObjectEvent(
                    kind="missing",
                    object_identity=identity,
                    at_seconds=gap.start_seconds,
                    # ⚠️ Who it was last with, which is the join a rule needs and the one thing the
                    # gap itself cannot say. `None` when it was with nobody — an object that simply
                    # stopped being detected where it lay.
                    subject_identity=holder_at(gap.start_seconds),
                )
            )
            out.append(
                ObjectEvent(
                    kind="returned",
                    object_identity=identity,
                    at_seconds=gap.end_seconds,
                    subject_identity=holder_at(gap.end_seconds),
                    seconds=gap.seconds,
                )
            )

    out.sort(key=lambda e: (e.at_seconds, e.kind))
    return out


def _holder_at(spans: Sequence[Association]):
    def holder(at_seconds: float) -> Optional[str]:
        for span in spans:
            if span.interval.start_seconds <= at_seconds <= span.interval.end_seconds:
                return span.subject_identity
        return None

    return holder


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


# --- staying put ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Episode:
    """A span during which one identity stayed within a bounded patch of the frame."""

    identity_id: str
    interval: Interval
    #: Largest distance from the point that opened the episode, in frame widths. ⭐ Reported so a
    #: caller can tell "stood on one tile" from "shuffled around a two-foot circle" — both are
    #: stationary under the same threshold, and a rule may reasonably care which.
    radius_normalized: float = 0.0
    #: True when the track ended while the episode was still open, so its duration is a lower bound.
    open_ended: bool = False
    samples: int = 0


def stationary_episodes(
    points: Sequence[TrackPoint],
    *,
    radius: float,
    min_seconds: float,
    use_foot_point: bool = True,
) -> List[Episode]:
    """Spans where a subject stayed within `radius` frame widths of where the span began.

    ⭐ **One mechanism, four business words.** Idling, waiting, loitering and queueing are this
    function at different thresholds — see `PRIMITIVE_READINGS`, which is the only place those words
    are attached to numbers. Writing `idle()` and `linger()` as separate functions would have been two
    implementations of one geometry, and the first divergence between them would be a defect nobody
    could see: both would keep returning plausible seconds.

    ⛔ **Anchored to the point that opened the episode, not to a running mean.** A centre that follows
    the subject drifts with them, so a person strolling steadily across the frame never breaks any
    threshold and is reported as having stood still for the whole clip. Anchoring bounds an episode's
    total displacement to `radius` by construction. ⚠️ The cost is that a subject who genuinely
    shuffles a little further than `radius` and comes back is split into two episodes rather than one
    — the conservative direction, since it under-reports rather than inventing a long stay.

    ⚠️ Foot point by default, for the reason `TrackPoint.foot_point` gives: a person standing still
    while a camera sees them from a changing angle has a centroid that moves more than their feet do.
    """
    if radius <= 0:
        raise ValueError("radius must be positive")
    if min_seconds < 0:
        raise ValueError("min_seconds must not be negative")
    if len(points) < 2:
        return []

    anchor_of = (lambda p: p.foot_point) if use_foot_point else (lambda p: p.centroid)
    episodes: List[Episode] = []
    start = 0

    def close(first: int, last: int, *, open_ended: bool) -> None:
        span = Interval(points[first].at_seconds, points[last].at_seconds)
        if span.seconds < min_seconds:
            return
        origin = anchor_of(points[first])
        spread = max(_distance(origin, anchor_of(points[i])) for i in range(first, last + 1))
        episodes.append(
            Episode(
                identity_id=points[first].identity_id,
                interval=span,
                radius_normalized=round(spread, 6),
                open_ended=open_ended,
                samples=last - first + 1,
            )
        )

    for index in range(1, len(points)):
        if _distance(anchor_of(points[start]), anchor_of(points[index])) <= radius:
            continue
        # ⚠️ The episode ended at the PREVIOUS point — the one still inside the patch. Ending it at
        # `index` would credit the subject with standing still through the step that moved them.
        close(start, index - 1, open_ended=False)
        start = index

    close(start, len(points) - 1, open_ended=True)
    return episodes


#: ⭐ **The one place a business word is attached to a number.**
#:
#: Every entry names a mechanism above and the thresholds that make it mean what the word means. This
#: is the answer to *"where is `linger` implemented?"* — it is not implemented, it is `read`: a
#: reading of `stationary_episodes` at 0.08 frame widths over 15 seconds. Two consequences that are
#: the whole reason the table exists:
#:
#: 1. ⛔ **A word cannot drift from its mechanism**, because there is nothing else for it to be. An
#:    `idle()` function and a `linger()` function would be two copies of one geometry, and the day
#:    they diverged both would still return plausible seconds and nothing would fail.
#: 2. ⚠️ **The numbers are conventions, not measurements**, and saying so here is the point. Nobody
#:    has established that 15 seconds is when standing becomes lingering — that is a deployment's
#:    judgement about its own floor, and it is tunable precisely because it is not a fact. They are
#:    published through the Behaviour API so a reader of an incident can see the threshold that
#:    produced it rather than guess at it.
#:
#: ⛔ Every word here passes the hospital test ([ADR-0052]): a ward, a warehouse, a school and a
#: factory all use them unchanged. None of them names an intent — `linger` is a duration, not a
#: motive, and the difference between it and `loiter` is exactly the line this layer does not cross.
PRIMITIVE_READINGS: Dict[str, Dict[str, object]] = {
    "idle": {
        "mechanism": "stationary_episodes",
        "radiusNormalized": 0.02,
        "minSeconds": 3.0,
        "means": "barely moved at all, for at least a few seconds",
    },
    "linger": {
        "mechanism": "stationary_episodes",
        "radiusNormalized": 0.08,
        "minSeconds": 15.0,
        "means": "stayed around one spot for a sustained period",
    },
    "queue": {
        "mechanism": "stationary_groups",
        "radiusNormalized": 0.08,
        "minSeconds": 8.0,
        "thresholdNormalized": 0.15,
        "minSize": 2,
        "means": "two or more subjects stationary together, for a sustained period",
    },
    "follow": {
        "mechanism": "following",
        "maxDistanceNormalized": 0.30,
        "headingToleranceDegrees": 45.0,
        "minSpeedNormalizedPerSecond": 0.01,
        "minSeconds": 3.0,
        "means": "moved behind another subject, on their heading, keeping station",
    },
    "approach": {
        "mechanism": "distance_changes",
        "minChangeNormalized": 0.05,
        "minSeconds": 1.0,
        "means": "the gap between two subjects closed",
    },
    "recede": {
        "mechanism": "distance_changes",
        "minChangeNormalized": 0.05,
        "minSeconds": 1.0,
        "means": "the gap between two subjects opened",
    },
    # ⛔ **Proximity and gap are parameterised, and saying otherwise is a false statement about a
    # business word.** "Was near" means *within 0.15 of the frame width for at least 2 s, debounced*;
    # "was not observed" means *a sampling interval passed without an observation for more than 2.5×
    # the expected one*. The console's Primitive Inspector rendered "not parameterised" beside both
    # until these entries existed (found in a browser run against the deployment, slice 2.8), which
    # reads as "no threshold decided this" — the opposite of the truth.
    #
    # ⚠️ `gap`'s threshold is **relative to the run's own sampling rate**, so it has no absolute
    # number here: an analysis at 2 fps and one at 8 fps call very different silences a gap, and
    # publishing one figure would be wrong for every run but one.
    "gap": {
        "mechanism": "observation_gaps",
        "expectedIntervalFactor": 2.5,
        "means": "no observation arrived for more than 2.5x the run's own sampling interval",
    },
    "proximity": {
        "mechanism": "togetherness",
        "thresholdNormalized": 0.15,
        "minSeconds": 2.0,
        "means": "two subjects stayed close to each other for a sustained period",
    },
    "group_merge": {
        "mechanism": "group_changes",
        "thresholdNormalized": 0.15,
        "minSeconds": 2.0,
        "means": "two groups of subjects became one",
    },
    "group_split": {
        "mechanism": "group_changes",
        "thresholdNormalized": 0.15,
        "minSeconds": 2.0,
        "means": "one group of subjects became two",
    },
    "cross_line": {
        "mechanism": "crossings",
        "means": "a subject's path crossed a configured line, from one named side to the other",
    },
    "enter_zone": {
        "mechanism": "zone_transitions",
        "means": "a subject's membership of a zone began",
    },
    "exit_zone": {
        "mechanism": "zone_transitions",
        "means": "a subject's membership of a zone ended",
    },
    "carry_object": {
        "mechanism": "associations",
        "thresholdNormalized": NEAR_THRESHOLD,
        "means": "an object stayed with a subject as they moved",
    },
    "pick_object": {
        "mechanism": "object_events",
        "thresholdNormalized": NEAR_THRESHOLD,
        "means": "an object that was travelling with nobody began travelling with a subject",
    },
    "drop_object": {
        "mechanism": "object_events",
        "thresholdNormalized": NEAR_THRESHOLD,
        "means": "an object stopped travelling with the subject it had been with",
    },
    "object_missing": {
        "mechanism": "object_events",
        "means": "a tracked object stopped being observed, with whoever it was last with named",
    },
    "object_returned": {
        "mechanism": "object_events",
        "means": "a tracked object was observed again after not being observed",
    },
    "approach_object": {
        "mechanism": "distance_changes",
        "minChangeNormalized": 0.05,
        "minSeconds": 1.0,
        "means": "the gap between a subject and an object closed",
    },
    "leave_object": {
        "mechanism": "distance_changes",
        "minChangeNormalized": 0.05,
        "minSeconds": 1.0,
        "means": "the gap between a subject and an object opened",
    },
    "handover": {
        "mechanism": "handovers",
        "maxGapSeconds": 2.0,
        "means": "an object's nearest subject changed from one to another",
    },
}


def _reading(name: str, key: str, fallback: float) -> float:
    value = PRIMITIVE_READINGS.get(name, {}).get(key, fallback)
    return float(value) if isinstance(value, (int, float)) else fallback


def stationary_readings(points: Sequence[TrackPoint]) -> Dict[str, List[Episode]]:
    """`idle` and `linger`, computed from `PRIMITIVE_READINGS` rather than from inline numbers.

    ⚠️ An `idle` episode is usually *inside* a `linger` episode rather than beside it — the thresholds
    are nested, so the same standing still is reported under both names. That is the correct reading
    of overlapping definitions and not double counting; a caller summing across names would be adding
    two descriptions of one event.
    """
    out: Dict[str, List[Episode]] = {}
    for name in ("idle", "linger"):
        out[name] = stationary_episodes(
            points,
            radius=_reading(name, "radiusNormalized", 0.05),
            min_seconds=_reading(name, "minSeconds", 5.0),
        )
    return out


# --- crossing a line --------------------------------------------------------------------------------


@dataclass(frozen=True)
class Line:
    """An operator-drawn polyline, in normalized coordinates — the platform's `kind: "line"` zone.

    ⭐ **`ZONE_EVALUATION` in `packages/contracts/src/zones/zone.ts` predicted this exactly.** It marks
    `line` storable but not evaluable, and names what evaluating one would need: *"a side-of-line test
    carried between frames per subject. Membership is instantaneous; crossing is a transition, so it
    needs the previous frame — state the resolver does not keep."* The resolver does not keep it; a
    trajectory **is** it. That is why crossing belongs in this layer and membership belongs in media.
    """

    line_id: str
    points: Sequence[Tuple[float, float]]
    #: ⚠️ Which side is which is decided by the order the operator drew the points, and by nothing
    #: else. Reversing a line swaps `left` and `right` — so a rule naming a direction is bound to a
    #: zone *version*, which is why every incident already carries one.
    name: Optional[str] = None


@dataclass(frozen=True)
class Crossing:
    """One passage of a subject's path through a line, with the direction it went."""

    identity_id: str
    line_id: str
    at_seconds: float
    #: `left` / `right` relative to the polyline's own direction of travel, first point toward last.
    from_side: str
    to_side: str
    #: Which segment of the polyline was crossed — an operator's line may bend.
    segment_index: int


def side_of_line(a: Tuple[float, float], b: Tuple[float, float], point: Tuple[float, float]) -> str:
    """`left`, `right` or `on`, for `point` against the directed segment a→b.

    ⚠️ Screen y grows downward, so the cross product's sign is flipped to make `left` mean what a
    person walking a→b would call their left. The same trap `direction_degrees` documents, and the
    reason both conventions look correct in isolation.
    """
    cross = (b[0] - a[0]) * -(point[1] - a[1]) - -(b[1] - a[1]) * (point[0] - a[0])
    if cross > 1e-12:
        return "left"
    if cross < -1e-12:
        return "right"
    return "on"


def crossings(
    points: Sequence[TrackPoint],
    line: Line,
    *,
    use_foot_point: bool = True,
) -> List[Crossing]:
    """Every time a subject's path passed through `line`, in time order.

    ⚠️ The façade over `_crossings_and_misses`, which is where the docstring lives. Callers that need
    to know *why* a line reported nothing use that instead — see `LineDiagnostic`.
    """
    found, _ = _crossings_and_misses(points, line, use_foot_point=use_foot_point)
    return found


def _crossings_and_misses(
    points: Sequence[TrackPoint],
    line: Line,
    *,
    use_foot_point: bool = True,
) -> Tuple[List[Crossing], int]:
    """Every time a subject's path passed through `line`, in time order.

    ⚠️ `segments_intersect` is imported from the runtime's `zones` module rather than reimplemented,
    for the same reason `PolygonZone` borrows `point_in_polygon`: two geometry engines that must agree
    is a defect waiting for a boundary case.

    ⛔ **A subject observed either side of a gap counts as having crossed.** If someone is seen left of
    the line, is occluded for four seconds, and reappears on the right, they crossed it — a detector
    that missed the moment does not undo the passage. The crossing is timed at the *later* point,
    because that is the first observation that establishes it, and `observation_gaps` is where a
    caller learns the interval was uncertain.

    ⛔ **The side is carried from the last observation that had one, not from the previous frame.**
    Landing exactly *on* the line is not rare — an operator draws a line down the middle of a doorway
    and a subject walking through it is sampled there. Comparing only adjacent points made that
    subject's `on` reading break the comparison on both sides of itself, so a clean walk across
    produced **no crossing at all**. Found by the first smoke test of this function, on a path that
    stepped exactly onto x = 0.5.
    """
    if len(points) < 2 or len(line.points) < 2:
        return [], 0
    from zones import segments_intersect  # noqa: WPS433 - local, keeps this module import-light

    at = (lambda p: p.foot_point) if use_foot_point else (lambda p: p.centroid)
    out: List[Crossing] = []
    #: Per polyline segment: the last observation that lay on a named side, and which side it was.
    #: ⚠️ Per segment, because "left of" is a statement about one straight edge — an operator's line
    #: may bend, and a single global side would be meaningless the moment it did.
    anchored: Dict[int, Tuple[int, str]] = {}
    #: ⛔ Side flips that did NOT pass through the drawn segment — see `LineDiagnostic`.
    missed = 0

    for index, point in enumerate(points):
        here = at(point)
        for segment in range(len(line.points) - 1):
            a, b = line.points[segment], line.points[segment + 1]
            side = side_of_line(a, b, here)
            if side == "on":
                continue
            previous = anchored.get(segment)
            anchored[segment] = (index, side)
            if previous is None or previous[1] == side:
                continue
            # ⚠️ The side flipped, which is necessary and not sufficient: the *infinite* line divides
            # the frame, the drawn segment does not. Somebody walking round the end of a line changes
            # side without passing through it, and counting that would make a tripwire fire for
            # everyone in the room.
            start = at(points[previous[0]])
            if not segments_intersect(start, here, a, b):
                missed += 1
                continue
            out.append(
                Crossing(
                    identity_id=point.identity_id,
                    line_id=line.line_id,
                    at_seconds=point.at_seconds,
                    from_side=previous[1],
                    to_side=side,
                    segment_index=segment,
                )
            )
    out.sort(key=lambda c: (c.at_seconds, c.segment_index))
    return out, missed


@dataclass(frozen=True)
class LineDiagnostic:
    """Why a line reported what it reported (slice 2.9).

    ⛔ **This exists because a correctly-drawn tripwire and a badly-drawn one both report nothing.**

    Measured on the deployment: an operator drew a vertical line from y = 0.05 to y = 0.95 — visually
    spanning the frame — and a person walked straight across it with **zero** crossings reported. The
    code was right. Zone membership is anchored at the **foot point**, a standing person's feet sit at
    y ≈ 0.95, and the walk therefore passed *around the bottom end* of the drawn segment. The
    `segments_intersect` guard rejected it exactly as designed, because somebody walking round the end
    of a line has not passed through it.

    That is correct and it is invisible. `side_changes` counts every time a subject moved from one
    side of the line's *infinite extension* to the other; `crossings` counts how many of those passed
    through the **drawn** segment. `side_changes > 0` with `crossings == 0` is a line that people are
    walking past rather than through — almost always one drawn too short — and that is a sentence an
    operator can act on, where silence is not.

    ⚠️ It is a diagnostic, never an event. A missed side change is **not** reported as a crossing, and
    nothing here loosens the geometry: the fix is to draw the line correctly, not to lower the bar.
    """

    line_id: str
    side_changes: int
    crossings: int

    @property
    def missed_the_segment(self) -> int:
        return self.side_changes - self.crossings

    def to_dict(self) -> dict:
        return {
            "lineId": self.line_id,
            "sideChanges": self.side_changes,
            "crossings": self.crossings,
            "missedTheSegment": self.missed_the_segment,
        }


def line_diagnostics(
    subjects: Mapping[str, Sequence[TrackPoint]],
    lines: Sequence[Line],
    *,
    use_foot_point: bool = True,
) -> List[LineDiagnostic]:
    """One diagnostic per line, across every subject in the scene."""
    out: List[LineDiagnostic] = []
    for line in lines:
        crossed = 0
        missed = 0
        for points in subjects.values():
            found, near = _crossings_and_misses(points, line, use_foot_point=use_foot_point)
            crossed += len(found)
            missed += near
        out.append(LineDiagnostic(line.line_id, crossed + missed, crossed))
    return out


@dataclass(frozen=True)
class AssociationDiagnostic:
    """Why the association layer reported what it reported (slice 2.10).

    ⛔ **This exists because `AssociationModule` ran on every frame for three milestones and never
    once had an object to associate — and nothing anywhere said so.** Every read returned no
    association, which is exactly what a working platform returns for a scene where nobody carried
    anything. Four completely different situations render identically:

    | what happened | what the read shows |
    | --- | --- |
    | nobody carried anything | no association |
    | the detector never returned a carriable class at all | no association |
    | objects and people were seen, never in the same frame | no association |
    | they were in the same frame and never close enough | no association |

    The first is the product working. The second was the truth for three milestones, and its cause
    turned out to be a single confidence floor chosen for `person` (see `minConfidenceByLabel`). The
    third is a timestamp join failing. The fourth is a real measurement about the scene. Only the
    first is silence a customer should ever be shown.

    ⚠️ **A diagnostic, never an event.** Nothing here creates an association, loosens
    `NEAR_THRESHOLD` or promotes a near miss. `closest_normalized` reports the best approach actually
    observed so an operator can see *how far* the scene was from associating — which is the one
    number that separates "nearly" from "not remotely".
    """

    #: Distinct identities whose label made them a subject, and a thing to be carried.
    subjects: int
    #: ⚠️ **Carriable objects only** — the population `associations()` actually runs over. Counting
    #: the parked cars here would say "4 objects, no association" about a scene with one bag.
    objects: int
    #: Labels of the carriable objects, so "no objects" can be told from "no *carriable* objects".
    object_labels: Tuple[str, ...] = ()
    #: Tracked objects excluded because nobody carries one, with their labels. ⛔ Reported rather
    #: than dropped: once slice 2.10 narrowed `carried` to things a person can pick up, "the detector
    #: saw nothing" and "the detector saw a car and a bench" would have become the same silence
    #: again — the exact failure this whole dataclass exists to prevent.
    not_carriable: int = 0
    not_carriable_labels: Tuple[str, ...] = ()
    #: Frames where at least one subject and at least one object were both observed. ⛔ Zero here is
    #: the entry condition of `associations()` never being met, and no amount of proximity can help.
    frames_together: int = 0
    #: Object observations whose rounded timestamp matched no subject observation. ⚠️ The silent one:
    #: `associations()` joins on `round(at_seconds, 3)`, so an object and a person a few milliseconds
    #: apart are infinitely far apart. Non-zero with `frames_together` high means a clock problem,
    #: not a geometry one.
    unjoined_object_points: int = 0
    #: Pairs that were close enough on at least one frame.
    pairs_near: int = 0
    #: Closest approach observed between any object and any subject, in frame widths. `None` when no
    #: object and subject were ever observed at the same instant — ⛔ never 0.0, which would read as
    #: "they touched" (ADR-0039).
    closest_normalized: Optional[float] = None
    threshold_normalized: float = NEAR_THRESHOLD
    spans: int = 0

    @property
    def reason(self) -> Optional[str]:
        """The first thing that stopped an association, or `None` when one was produced.

        ⚠️ Ordered as a failure should be read — outside in. Reporting "never close enough" for a run
        whose detector returned no object at all would send an operator to move a camera when the
        problem is a threshold.
        """
        if self.spans > 0:
            return None
        if self.objects == 0:
            # ⚠️ Two different absences. "Nothing was detected" sends someone to the detector;
            # "a car was detected and nobody carries a car" sends them nowhere, correctly.
            return "no-carriable-objects" if self.not_carriable > 0 else "no-objects-detected"
        if self.subjects == 0:
            return "no-subjects-detected"
        if self.frames_together == 0:
            return "never-observed-together"
        if self.pairs_near == 0:
            return "never-close-enough"
        return "no-span-formed"

    def to_dict(self) -> dict:
        out: dict = {
            "subjects": self.subjects,
            "objects": self.objects,
            "objectLabels": list(self.object_labels),
            "notCarriable": self.not_carriable,
            "notCarriableLabels": list(self.not_carriable_labels),
            "framesTogether": self.frames_together,
            "unjoinedObjectPoints": self.unjoined_object_points,
            "pairsNear": self.pairs_near,
            "thresholdNormalized": self.threshold_normalized,
            "spans": self.spans,
        }
        # ⛔ Omitted rather than zeroed when nothing was ever observed together: `0.0` is the one
        # value that means "touching", and it is the opposite of what happened.
        if self.closest_normalized is not None:
            out["closestNormalized"] = self.closest_normalized
        reason = self.reason
        if reason is not None:
            out["reason"] = reason
        return out


def association_diagnostic(
    objects: Mapping[str, Sequence[TrackPoint]],
    subjects: Mapping[str, Sequence[TrackPoint]],
    *,
    threshold: float = NEAR_THRESHOLD,
    spans: Optional[int] = None,
) -> AssociationDiagnostic:
    """One diagnostic for the whole scene.

    ⚠️ `spans` is passed in rather than recomputed. The caller has already run `associations()`, and
    a second count here would be a second answer to "did this associate" — the first time the two
    disagreed nobody could say which was right.

    ⚠️ `objects` is filtered to carriable labels here for the same reason `AssociationModule` filters
    it: this describes the population association actually ran over. What was excluded is reported
    beside it rather than dropped.
    """
    carriable_objects = {i: p for i, p in objects.items() if carriable(p)}
    excluded = {i: p for i, p in objects.items() if i not in carriable_objects}
    object_labels = sorted({p.label for points in carriable_objects.values() for p in points if p.label})
    excluded_labels = sorted({p.label for points in excluded.values() for p in points if p.label})
    objects = carriable_objects

    # The same join `associations()` performs, so a failure here is that failure and not a model of it.
    subject_times: Dict[float, List[TrackPoint]] = {}
    for points in subjects.values():
        for point in points:
            subject_times.setdefault(round(point.at_seconds, 3), []).append(point)

    frames = set()
    unjoined = 0
    closest: Optional[float] = None
    near_pairs = set()
    for identity, points in objects.items():
        for point in points:
            partners = subject_times.get(round(point.at_seconds, 3), [])
            if not partners:
                unjoined += 1
                continue
            frames.add(round(point.at_seconds, 3))
            for partner in partners:
                gap = distance_between(point, partner)
                if closest is None or gap < closest:
                    closest = gap
                if near(point, partner, threshold=threshold):
                    near_pairs.add((identity, partner.identity_id))

    return AssociationDiagnostic(
        subjects=len(subjects),
        objects=len(objects),
        object_labels=tuple(object_labels),
        not_carriable=len(excluded),
        not_carriable_labels=tuple(excluded_labels),
        frames_together=len(frames),
        unjoined_object_points=unjoined,
        pairs_near=len(near_pairs),
        closest_normalized=None if closest is None else round(closest, 6),
        threshold_normalized=threshold,
        spans=0 if spans is None else spans,
    )


# --- the gap between two subjects ---------------------------------------------------------------------


@dataclass(frozen=True)
class DistanceChange:
    """A span over which the gap between two identities moved consistently one way."""

    identity_id: str
    other_identity_id: str
    #: `approach` when the gap closed, `recede` when it opened. Both are facts; neither is a motive.
    kind: str
    interval: Interval
    from_normalized: float
    to_normalized: float

    @property
    def delta_normalized(self) -> float:
        return round(self.to_normalized - self.from_normalized, 6)


def distance_series(
    a: Sequence[TrackPoint], b: Sequence[TrackPoint], *, tolerance: float = 0.001
) -> List[Tuple[float, float]]:
    """`(at_seconds, distance)` for every instant **both** identities were observed.

    ⛔ Only shared instants, and no interpolation across the rest. Two subjects one frame apart can be
    anywhere relative to each other; a gap computed against a stale position is a proximity claim
    nobody made — the same rule `_distance_at` follows in `behaviour_modules`.
    """
    return _matched(_prepare(a), _prepare(b), tolerance=tolerance)


def distance_changes(
    a: Sequence[TrackPoint],
    b: Sequence[TrackPoint],
    *,
    min_change: float = 0.05,
    min_seconds: float = 1.0,
    deadband: float = 0.004,
) -> List[DistanceChange]:
    """Sustained approaches and recessions between two identities.

    ⚠️ **`deadband` is what stops a jittering bounding box producing a hundred alternating episodes.**
    A step smaller than it neither extends nor breaks a run: the box moved, the people did not. Set to
    roughly a pixel's worth of a normalized frame, and named rather than inlined because the number is
    the difference between a readable timeline and a wall of noise.

    ⛔ Both `min_change` and `min_seconds` must be met. A gap that closes 0.4 frame widths in one
    frame is a tracking artefact, not an approach; one that drifts 0.001 over a minute is nothing.
    """
    if not a or not b:
        return []
    return _changes_between(
        _prepare(a),
        _prepare(b),
        min_change=min_change,
        min_seconds=min_seconds,
        deadband=deadband,
    )


def _changes_between(
    a: "_Series",
    b: "_Series",
    *,
    min_change: float,
    min_seconds: float,
    deadband: float,
) -> List[DistanceChange]:
    return _changes_from(
        _matched(a, b),
        a.identity_id,
        b.identity_id,
        min_change=min_change,
        min_seconds=min_seconds,
        deadband=deadband,
    )


def _changes_from(
    series: Sequence[Tuple[float, float]],
    identity: str,
    other: str,
    *,
    min_change: float,
    min_seconds: float,
    deadband: float,
) -> List[DistanceChange]:
    if len(series) < 2:
        return []

    out: List[DistanceChange] = []
    start = 0
    direction = 0  # -1 closing, +1 opening, 0 undecided

    def close(first: int, last: int) -> None:
        if last <= first:
            return
        (t0, d0), (t1, d1) = series[first], series[last]
        if t1 - t0 < min_seconds or abs(d1 - d0) < min_change:
            return
        out.append(
            DistanceChange(
                identity_id=identity,
                other_identity_id=other,
                kind="approach" if d1 < d0 else "recede",
                interval=Interval(t0, t1),
                from_normalized=round(d0, 6),
                to_normalized=round(d1, 6),
            )
        )

    for index in range(1, len(series)):
        step = series[index][1] - series[index - 1][1]
        if abs(step) <= deadband:
            continue
        sign = 1 if step > 0 else -1
        if direction == 0:
            direction = sign
        elif sign != direction:
            close(start, index - 1)
            start, direction = index - 1, sign
    close(start, len(series) - 1)
    return out


# --- groups ------------------------------------------------------------------------------------------

#: "Together" for grouping, in frame widths between centroids. ⚠️ Deliberately looser than
#: `NEAR_THRESHOLD`, which asks whether a *hand* is on an object; this asks whether two people are
#: walking as a pair, and at 0.05 two friends side by side would be counted as strangers. A
#: convention, like everything in `PRIMITIVE_READINGS`, not a measurement.
GROUP_THRESHOLD = 0.15

# ⛔ **The published number and the number that decides must be the same number.**
#
# `PRIMITIVE_READINGS` is defined above this constant, so it cannot reference it and carries the
# literal instead — and a published threshold that has drifted from the one the code applies is
# worse than none: the console prints it beside the word it supposedly explains, and an operator
# defending a finding quotes a figure nothing measured. This turns that drift into an import
# failure, which is the only kind nobody can ignore.
for _name in ("proximity", "group_merge", "group_split", "queue"):
    _published = PRIMITIVE_READINGS[_name].get("thresholdNormalized")
    if _published != GROUP_THRESHOLD:  # pragma: no cover - a guard, not a branch
        raise AssertionError(
            f"PRIMITIVE_READINGS[{_name!r}]['thresholdNormalized'] is {_published}, "
            f"but GROUP_THRESHOLD is {GROUP_THRESHOLD}"
        )
del _name, _published


def togetherness(
    a: Sequence[TrackPoint],
    b: Sequence[TrackPoint],
    *,
    threshold: float = GROUP_THRESHOLD,
    min_seconds: float = 2.0,
) -> List[Interval]:
    """Spans during which two identities stayed within `threshold` of each other, debounced.

    ⛔ **The debounce is the whole function.** Two people standing exactly `threshold` apart cross it
    on every frame, and an undebounced group detector would then emit a merge and a split per frame
    for the rest of the clip — thousands of entries describing one conversation. A run of separation
    shorter than `min_seconds` is bridged rather than believed, and a run of togetherness shorter than
    `min_seconds` is discarded.
    """
    return _together_from(distance_series(a, b), threshold=threshold, min_seconds=min_seconds)


def _together_from(
    series: Sequence[Tuple[float, float]], *, threshold: float, min_seconds: float
) -> List[Interval]:
    if len(series) < 2:
        return []

    runs: List[Tuple[float, float]] = []
    start: Optional[float] = None
    previous: Optional[float] = None
    for at_seconds, gap in series:
        if gap <= threshold:
            if start is None:
                start = at_seconds
        elif start is not None:
            runs.append((start, previous if previous is not None else at_seconds))
            start = None
        previous = at_seconds
    if start is not None and previous is not None:
        runs.append((start, previous))

    # ⚠️ Bridge first, then filter. Filtering first would delete the two halves of a span that a
    # single missed frame split, and the bridge would then have nothing left to join.
    bridged: List[Tuple[float, float]] = []
    for run in runs:
        if bridged and run[0] - bridged[-1][1] < min_seconds:
            bridged[-1] = (bridged[-1][0], run[1])
        else:
            bridged.append(run)
    return [Interval(s, e) for s, e in bridged if e - s >= min_seconds]


def groups_at(
    subjects: Dict[str, Sequence[TrackPoint]],
    *,
    at_seconds: float,
    threshold: float = GROUP_THRESHOLD,
    tolerance: float = 0.001,
) -> List[Tuple[str, ...]]:
    """The identities present at one instant, partitioned into groups by proximity.

    ⚠️ **Groups are transitive and that is a choice with a consequence.** A, B and C in a line, each
    `threshold` from the next, form one group of three even though A and C are twice `threshold`
    apart. That is the right reading for a queue and the wrong one for a huddle, and no threshold
    fixes it — a caller who needs the tighter meaning should read the pairwise distances instead.

    Every group is returned sorted, and the list is sorted, so two runs over one clip produce the same
    document.
    """
    present: Dict[str, TrackPoint] = {}
    for identity, points in subjects.items():
        match = next((p for p in points if abs(p.at_seconds - at_seconds) <= tolerance), None)
        if match is not None:
            present[identity] = match
    if not present:
        return []

    parent: Dict[str, str] = {identity: identity for identity in present}

    def find(identity: str) -> str:
        while parent[identity] != identity:
            parent[identity] = parent[parent[identity]]
            identity = parent[identity]
        return identity

    names = sorted(present)
    for index, identity in enumerate(names):
        for other in names[index + 1 :]:
            if distance_between(present[identity], present[other]) <= threshold:
                root_a, root_b = find(identity), find(other)
                if root_a != root_b:
                    parent[root_b] = root_a

    grouped: Dict[str, List[str]] = {}
    for identity in names:
        grouped.setdefault(find(identity), []).append(identity)
    return sorted(tuple(sorted(members)) for members in grouped.values())


@dataclass(frozen=True)
class GroupChange:
    """One moment at which the partition of subjects into groups changed."""

    #: `merge` or `split`. ⚠️ Both, never a single "regrouped" — an investigator asking who joined
    #: whom is asking a different question from who walked away, and one word answers neither.
    kind: str
    at_seconds: float
    #: The group the change is *about*: the one that formed on a merge, the one that broke on a split.
    identities: Tuple[str, ...]
    before: Tuple[Tuple[str, ...], ...]
    after: Tuple[Tuple[str, ...], ...]


def group_changes(
    subjects: Mapping[str, Sequence[TrackPoint]],
    *,
    threshold: float = GROUP_THRESHOLD,
    min_seconds: float = 2.0,
) -> List[GroupChange]:
    """Every merge and split, from the debounced pairwise relation.

    ⛔ **Only identities observed on both sides of a moment are compared.** Someone walking out of
    frame shrinks their group without anyone having split from anyone, and someone walking in grows it
    without a merge; counting either would make every entrance and exit in a busy scene produce a
    social event. The restriction means a two-person group whose second member simply leaves produces
    *nothing*, which is correct and is the case a naive implementation gets wrong.
    """
    scene = scene_of(subjects)
    if len(scene.identities) < 2:
        return []

    #: pair → the spans it was together for, debounced once and reused at every instant below.
    spans = togetherness_spans(scene, threshold=threshold, min_seconds=min_seconds)
    if not spans:
        return []

    instants = sorted(
        {round(p.at_seconds, 3) for i in scene.identities for p in scene.series(i).points}
    )
    observed_at: Dict[float, set] = {}
    for identity in scene.identities:
        for point in scene.series(identity).points:
            observed_at.setdefault(round(point.at_seconds, 3), set()).add(identity)

    # ⚠️ The edges active at an instant, found from a sorted event list rather than by re-scanning
    # every span at every instant. The partition only *can* change when an edge opens or closes or
    # when the set of identities present changes, and both are cheap to detect.
    edges = sorted(spans)

    def active(at_seconds: float) -> frozenset:
        return frozenset(
            pair
            for pair in edges
            if any(i.start_seconds <= at_seconds <= i.end_seconds for i in spans[pair])
        )

    def partition(at_seconds: float, live: frozenset) -> List[Tuple[str, ...]]:
        here = sorted(observed_at.get(at_seconds, set()))
        parent = {identity: identity for identity in here}

        def find(identity: str) -> str:
            while parent[identity] != identity:
                parent[identity] = parent[parent[identity]]
                identity = parent[identity]
            return identity

        for left, right in live:
            if left not in parent or right not in parent:
                continue
            root_a, root_b = find(left), find(right)
            if root_a != root_b:
                parent[root_b] = root_a

        grouped: Dict[str, List[str]] = {}
        for identity in here:
            grouped.setdefault(find(identity), []).append(identity)
        return sorted(tuple(sorted(members)) for members in grouped.values())

    out: List[GroupChange] = []
    previous_at = instants[0]
    previous_live = active(previous_at)
    previous = partition(previous_at, previous_live)
    for at_seconds in instants[1:]:
        live = active(at_seconds)
        current = (
            previous
            if live == previous_live and observed_at.get(at_seconds) == observed_at.get(previous_at)
            else partition(at_seconds, live)
        )
        previous_live = live
        shared = observed_at.get(previous_at, set()) & observed_at.get(at_seconds, set())
        before = _restrict(previous, shared)
        after = _restrict(current, shared)
        if before != after:
            for group in after:
                sources = [g for g in before if set(g) & set(group)]
                if len(sources) > 1:
                    out.append(GroupChange("merge", at_seconds, group, tuple(sources), (group,)))
            for group in before:
                targets = [g for g in after if set(g) & set(group)]
                if len(targets) > 1:
                    out.append(GroupChange("split", at_seconds, group, (group,), tuple(targets)))
        previous, previous_at = current, at_seconds
    return out


@dataclass(frozen=True)
class StationaryGroup:
    """Several identities, stationary, together, for a sustained period — the `queue` mechanism."""

    identities: Tuple[str, ...]
    interval: Interval
    #: 0.0–1.0, how close the members' positions lay to a straight line at the group's midpoint.
    #:
    #: ⚠️ **Reported, never used as a gate.** People queue round corners and along counters, so a
    #: linearity threshold would drop real queues; and a linear cluster is not always a queue. The
    #: number is here so a Layer 3 rule can weigh it, which is where a judgement of that kind belongs.
    linearity: float = 0.0


def stationary_groups(
    subjects: Mapping[str, Sequence[TrackPoint]],
    *,
    radius: float = 0.08,
    min_seconds: float = 8.0,
    threshold: float = GROUP_THRESHOLD,
    min_size: int = 2,
) -> List[StationaryGroup]:
    """Groups of subjects who were all standing still, near each other, for a while.

    ⭐ **A composition, not a new geometry** — `stationary_episodes` for "standing still", the same
    pairwise relation `group_changes` uses for "together". Waiting rooms, tills, bus stops and
    assembly lines are one shape; `PRIMITIVE_READINGS["queue"]` is the word for it and the thresholds
    that make it mean that.
    """
    scene = scene_of(subjects)
    still: Dict[str, List[Interval]] = {}
    for identity in scene.identities:
        episodes = stationary_episodes(
            scene.series(identity).points, radius=radius, min_seconds=min_seconds
        )
        if episodes:
            still[identity] = [e.interval for e in episodes]
    if len(still) < min_size:
        return []

    points_of = {identity: scene.series(identity).points for identity in still}
    instants = sorted({round(p.at_seconds, 3) for pts in points_of.values() for p in pts})
    runs: Dict[Tuple[str, ...], List[Tuple[float, float]]] = {}
    for at_seconds in instants:
        standing = {
            identity: points_of[identity]
            for identity, intervals in still.items()
            if any(i.start_seconds <= at_seconds <= i.end_seconds for i in intervals)
        }
        if len(standing) < min_size:
            continue
        for group in groups_at(standing, at_seconds=at_seconds, threshold=threshold):
            if len(group) < min_size:
                continue
            spans = runs.setdefault(group, [])
            if spans and at_seconds - spans[-1][1] <= min_seconds:
                spans[-1] = (spans[-1][0], at_seconds)
            else:
                spans.append((at_seconds, at_seconds))

    out: List[StationaryGroup] = []
    for group, spans in runs.items():
        for start, end in spans:
            if end - start < min_seconds:
                continue
            out.append(
                StationaryGroup(
                    identities=group,
                    interval=Interval(start, end),
                    linearity=_linearity(points_of, group, (start + end) / 2.0),
                )
            )
    out.sort(key=lambda g: (g.interval.start_seconds, g.identities))
    return out


# --- following ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FollowEpisode:
    """A span during which one identity moved behind another, on their heading."""

    identity_id: str
    leader_identity_id: str
    interval: Interval
    mean_distance_normalized: float = 0.0


def following(
    follower: Sequence[TrackPoint],
    leader: Sequence[TrackPoint],
    *,
    max_distance: float = 0.30,
    heading_tolerance_degrees: float = 45.0,
    min_speed: float = 0.01,
    min_seconds: float = 3.0,
    window_seconds: float = 1.0,
) -> List[FollowEpisode]:
    """Spans where `follower` was behind `leader`, moving their way and keeping station.

    Four conditions, all required at each instant, then sustained for `min_seconds`:

    1. both are **moving** — a pair standing still together is a group, not a pursuit;
    2. they are within `max_distance` frame widths;
    3. their **headings agree** within `heading_tolerance_degrees`;
    4. the follower is **behind**: the vector from follower to leader points along the leader's own
       heading.

    ⚠️ **A heuristic, and named as one.** Condition 4 is what separates following from walking side by
    side, and it is also what this cannot do reliably in a corridor where everyone walks the same way
    — an aisle produces "following" for every pair in it. ⛔ That ambiguity is why this returns a
    geometric span with a distance and never a word like *tailing*: a rule that needs to accuse
    somebody must add evidence this layer does not have.

    ⚠️ Headings are local, over `window_seconds`, not net over the whole track. A net heading calls a
    subject who walked out and back "stationary", and two people doing that at different times would
    read as following each other.
    """
    if not follower or not leader:
        return []
    return _follow_between(
        _prepare(follower, window_seconds=window_seconds),
        _prepare(leader, window_seconds=window_seconds),
        max_distance=max_distance,
        heading_tolerance_degrees=heading_tolerance_degrees,
        min_speed=min_speed,
        min_seconds=min_seconds,
    )


def _follow_between(
    follower: "_Series",
    leader: "_Series",
    *,
    max_distance: float,
    heading_tolerance_degrees: float,
    min_speed: float,
    min_seconds: float,
) -> List[FollowEpisode]:
    cosine_limit = math.cos(math.radians(heading_tolerance_degrees))
    matches: List[Tuple[float, float, bool]] = []
    lookup = leader.index_at.get
    for index, key in enumerate(follower.keys):
        other = lookup(key)
        if other is None:
            continue
        here, there = follower.centroids[index], leader.centroids[other]
        gap = round(_distance(here, there), 6)
        ours = follower.headings[index]
        theirs = leader.headings[other]
        holds = False
        if ours is not None and theirs is not None and gap <= max_distance:
            (ux, uy, our_speed), (vx, vy, their_speed) = ours, theirs
            if our_speed >= min_speed and their_speed >= min_speed:
                aligned = ux * vx + uy * vy >= cosine_limit
                ahead = _unit((there[0] - here[0], there[1] - here[1]))
                behind = ahead is not None and (ahead[0] * vx + ahead[1] * vy) > 0
                holds = aligned and behind
        matches.append((follower.points[index].at_seconds, gap, holds))

    out: List[FollowEpisode] = []
    start: Optional[int] = None
    for index, (_, _, holds) in enumerate(matches):
        if holds and start is None:
            start = index
        elif not holds and start is not None:
            _emit_follow(out, follower, leader, matches, start, index - 1, min_seconds)
            start = None
    if start is not None:
        _emit_follow(out, follower, leader, matches, start, len(matches) - 1, min_seconds)
    return out


def _emit_follow(
    out: List[FollowEpisode],
    follower: "_Series",
    leader: "_Series",
    matches: Sequence[Tuple[float, float, bool]],
    first: int,
    last: int,
    min_seconds: float,
) -> None:
    if last <= first:
        return
    span = Interval(matches[first][0], matches[last][0])
    if span.seconds < min_seconds:
        return
    gaps = [matches[i][1] for i in range(first, last + 1)]
    out.append(
        FollowEpisode(
            identity_id=follower.identity_id,
            leader_identity_id=leader.identity_id,
            interval=span,
            mean_distance_normalized=round(sum(gaps) / len(gaps), 6),
        )
    )


# --- the same primitives over a whole scene ------------------------------------------------------------
#
# ⛔ **These exist because the per-pair functions above were O(n²) in the wrong place.** Each of them
# recomputes, for every pair, work that belongs to one identity: the time index, the local headings,
# the position bounds. At 98 identities over 120 frames `_local_heading` was called 541 440 times where
# 11 760 would do, and one Behaviour API read took **43 seconds** — measured, not estimated, on the
# benchmark that now guards it.
#
# ⭐ The pair logic is not duplicated. `following` and `follow_episodes` call the same
# `_follow_between`; the difference is only who prepares the series and how many pairs are attempted.
# Two implementations of "is this person behind that one" is exactly what this layer must not have.


class _Series:
    """One identity's points with everything a pairwise primitive would otherwise recompute per pair."""

    __slots__ = (
        "identity_id",
        "points",
        "index_at",
        "headings",
        "first",
        "last",
        "bounds",
        "centroids",
        "keys",
    )

    def __init__(self, points: Sequence[TrackPoint], window_seconds: float) -> None:
        self.identity_id = points[0].identity_id
        self.points = points
        # ⚠️ `centroid` is a property that allocates a tuple on every read, and `round` is not free
        # either — between them they were a fifth of a whole Behaviour API read, because a pairwise
        # walk touches each point once per partner. Both are facts about one point, so both are
        # computed once here.
        self.centroids = [p.centroid for p in points]
        self.keys = [round(p.at_seconds, 3) for p in points]
        self.index_at = {key: i for i, key in enumerate(self.keys)}
        self.headings = [_local_heading(points, i, window_seconds) for i in range(len(points))]
        self.first = points[0].at_seconds
        self.last = points[-1].at_seconds
        xs = [c[0] for c in self.centroids]
        ys = [c[1] for c in self.centroids]
        self.bounds = (min(xs), min(ys), max(xs), max(ys))


def _prepare(points: Sequence[TrackPoint], *, window_seconds: float = 1.0) -> _Series:
    return _Series(list(points), window_seconds)


def _matched(a: _Series, b: _Series, *, tolerance: float = 0.001) -> List[Tuple[float, float]]:
    """`(at_seconds, distance)` at every instant both were observed."""
    out: List[Tuple[float, float]] = []
    lookup = b.index_at.get
    for index, key in enumerate(a.keys):
        other = lookup(key)
        if other is None:
            continue
        at_seconds = a.points[index].at_seconds
        if abs(b.points[other].at_seconds - at_seconds) > tolerance:
            continue
        out.append((at_seconds, round(_distance(a.centroids[index], b.centroids[other]), 6)))
    out.sort()
    return out


def _overlaps_in_time(a: _Series, b: _Series) -> bool:
    """⚠️ Free, and always sound: two identities never observed at the same moment share no instants,
    so every pairwise primitive is empty for them without looking at a single point."""
    return not (a.last < b.first or b.last < a.first)


def _within(a: _Series, b: _Series, distance: float) -> bool:
    """Could these two ever have been within `distance`? ⚠️ Sound only for predicates with a maximum
    separation — following and togetherness have one, `distance_changes` does not, because a gap that
    closes is a fact at any range."""
    ax0, ay0, ax1, ay1 = a.bounds
    bx0, by0, bx1, by1 = b.bounds
    gap_x = max(0.0, max(ax0, bx0) - min(ax1, bx1))
    gap_y = max(0.0, max(ay0, by0) - min(ay1, by1))
    return math.hypot(gap_x, gap_y) <= distance


#: Identities a scene compares pairwise. ⚠️ The pairwise families are O(n² × frames) and no amount of
#: pruning changes that for a genuinely crowded frame, so the honest answer is a cap that says it
#: applied one. Mirrors `MAX_CROSSING_TRACKS` in the tracker; `behaviour_modules` re-exports it under
#: the name it has used since slice 2.2.
MAX_RELATIONAL_IDENTITIES = 32


class Scene:
    """Every subject in one analysis, prepared once — the substrate the pairwise primitives read.

    ⛔ **This class is a performance fix with a measurement behind it, not a tidying.** Each pairwise
    family — following, distance change, togetherness — independently walked every pair and, inside
    that walk, recomputed per-*identity* work: the time index, the local headings, the matched
    distance series. A 98-identity, 512-frame analysis took **43 seconds** to answer one Behaviour
    API read. Preparing each identity once and memoising each pair's distance series once brings the
    same answer back in a fraction of that; `tools/validation/behaviour-bench.mjs` is the guard.

    ⚠️ **Capped, and it says so.** `truncated` is public and every caller publishes it, for the same
    reason `RelationalModule` has always reported its cap: a truncated pairwise scan that said nothing
    about being truncated would render a crowded scene as a quiet one.
    """

    __slots__ = ("identities", "truncated", "considered", "_series", "_matched", "_window")

    def __init__(
        self,
        subjects: Mapping[str, Sequence[TrackPoint]],
        *,
        window_seconds: float = 1.0,
        max_identities: int = MAX_RELATIONAL_IDENTITIES,
    ) -> None:
        usable = sorted(identity for identity, points in subjects.items() if len(points) >= 2)
        self.truncated = len(usable) > max_identities
        self.identities = usable[:max_identities]
        self.considered = len(self.identities)
        self._window = window_seconds
        self._series: Dict[str, _Series] = {
            identity: _prepare(subjects[identity], window_seconds=window_seconds)
            for identity in self.identities
        }
        self._matched: Dict[Tuple[str, str], List[Tuple[float, float]]] = {}

    def series(self, identity: str) -> "_Series":
        return self._series[identity]

    def matched(self, a: str, b: str) -> List[Tuple[float, float]]:
        """The distance series for a pair, computed at most once however many families ask for it."""
        key = (a, b) if a <= b else (b, a)
        found = self._matched.get(key)
        if found is None:
            found = _matched(self._series[key[0]], self._series[key[1]])
            self._matched[key] = found
        return found

    def pairs(self, *, within: Optional[float] = None) -> List[Tuple[str, str]]:
        """Unordered pairs that could possibly interact, cheapest test first.

        ⚠️ `within` prunes on the identities' position bounds and is sound only for a predicate with a
        maximum separation. The temporal test is always applied and always sound: two identities never
        observed at the same moment share no instants, so every pairwise primitive is empty for them.
        """
        out: List[Tuple[str, str]] = []
        for index, identity in enumerate(self.identities):
            a = self._series[identity]
            for other in self.identities[index + 1 :]:
                b = self._series[other]
                if not _overlaps_in_time(a, b):
                    continue
                if within is not None and not _within(a, b, within):
                    continue
                out.append((identity, other))
        return out


def scene_of(subjects: Mapping[str, Sequence[TrackPoint]], **kwargs) -> Scene:
    return subjects if isinstance(subjects, Scene) else Scene(subjects, **kwargs)


def follow_episodes(
    subjects: Mapping[str, Sequence[TrackPoint]],
    *,
    max_distance: float = 0.30,
    heading_tolerance_degrees: float = 45.0,
    min_speed: float = 0.01,
    min_seconds: float = 3.0,
    window_seconds: float = 1.0,
) -> Dict[str, List[FollowEpisode]]:
    """Every follow in a scene, keyed by the identity doing the following."""
    scene = scene_of(subjects, window_seconds=window_seconds)
    out: Dict[str, List[FollowEpisode]] = {}
    for identity, other in scene.pairs(within=max_distance):
        # ⚠️ Both directions, because following is asymmetric — but the pair is only *reached* once,
        # so the pruning above is paid for once rather than twice.
        for follower, leader in ((identity, other), (other, identity)):
            found = _follow_between(
                scene.series(follower),
                scene.series(leader),
                max_distance=max_distance,
                heading_tolerance_degrees=heading_tolerance_degrees,
                min_speed=min_speed,
                min_seconds=min_seconds,
            )
            if found:
                out.setdefault(follower, []).extend(found)
    for episodes in out.values():
        episodes.sort(key=lambda e: (e.interval.start_seconds, e.leader_identity_id))
    return out


def distance_change_episodes(
    subjects: Mapping[str, Sequence[TrackPoint]],
    *,
    min_change: float = 0.05,
    min_seconds: float = 1.0,
    deadband: float = 0.004,
    max_relevant_distance: float = 0.5,
) -> Dict[Tuple[str, str], List[DistanceChange]]:
    """Every sustained approach and recession in a scene, keyed by the **unordered** pair.

    ⚠️ Unordered, because the measurement is symmetric. Reporting it from both sides would put one
    closing gap on a timeline twice under two subjects.

    ⚠️ **`max_relevant_distance` is a stated limitation, not an optimisation that happens to be
    convenient.** A pair who are never within half a frame width of each other are not interacting,
    and their gap wobbling by 0.05 is a fact about two independent walks. Bounding it is what keeps a
    busy scene's timeline about the people who met — and it is declared in `PRIMITIVE_READINGS` so a
    reader can see that the question asked was *"who came near whom"* and not *"every pair"*.
    """
    scene = scene_of(subjects)
    out: Dict[Tuple[str, str], List[DistanceChange]] = {}
    for identity, other in scene.pairs(within=max_relevant_distance):
        found = _changes_from(
            scene.matched(identity, other),
            identity,
            other,
            min_change=min_change,
            min_seconds=min_seconds,
            deadband=deadband,
        )
        if found:
            out[(identity, other)] = found
    return out


def togetherness_spans(
    subjects: Mapping[str, Sequence[TrackPoint]],
    *,
    threshold: float = 0.15,
    min_seconds: float = 2.0,
) -> Dict[Tuple[str, str], List[Interval]]:
    """Every debounced "these two were together" span in a scene, keyed by the unordered pair."""
    scene = scene_of(subjects)
    out: Dict[Tuple[str, str], List[Interval]] = {}
    for identity, other in scene.pairs(within=threshold):
        found = _together_from(
            scene.matched(identity, other), threshold=threshold, min_seconds=min_seconds
        )
        if found:
            out[(identity, other)] = found
    return out


# --- helpers -------------------------------------------------------------------------------------------


def _restrict(
    partition: Sequence[Tuple[str, ...]], keep: set
) -> Tuple[Tuple[str, ...], ...]:
    """A partition with only the named identities left in it, empty groups dropped."""
    out = [tuple(i for i in group if i in keep) for group in partition]
    return tuple(sorted(group for group in out if group))


def _unit(vector: Tuple[float, float]) -> Optional[Tuple[float, float]]:
    length = math.hypot(vector[0], vector[1])
    return None if length <= 1e-9 else (vector[0] / length, vector[1] / length)


def _local_heading(
    points: Sequence[TrackPoint], index: int, window_seconds: float
) -> Optional[Tuple[float, float, float]]:
    """`(unit_x, unit_y, speed)` around one observation, or `None` when nothing moved.

    ⚠️ Centred on `index` where both neighbours exist, one-sided at the ends. A one-sided window at
    the start of a track is a shorter measurement, not a wrong one, and refusing to answer there would
    blind every primitive to a subject's first second.

    ⛔ **At least one neighbour is always taken, whatever the window says.** A stream sampled at 2 fps
    has its neighbours exactly `window_seconds / 2` away, so a window that admits only what is
    strictly nearer than its own half-width admits *nothing* — and `following` then returned an empty
    list for a textbook follow. The window widens the measurement; it must not be able to abolish it.
    """
    at = points[index].at_seconds
    first, last = index, index
    while first > 0 and at - points[first - 1].at_seconds < window_seconds / 2.0:
        first -= 1
    while last < len(points) - 1 and points[last + 1].at_seconds - at < window_seconds / 2.0:
        last += 1
    if first == index and index > 0:
        first = index - 1
    if last == index and index < len(points) - 1:
        last = index + 1
    if last == first:
        return None
    elapsed = points[last].at_seconds - points[first].at_seconds
    if elapsed <= 0:
        return None
    (x1, y1), (x2, y2) = points[first].centroid, points[last].centroid
    unit = _unit((x2 - x1, y2 - y1))
    if unit is None:
        return None
    return (unit[0], unit[1], _distance((x1, y1), (x2, y2)) / elapsed)


def _linearity(
    subjects: Dict[str, Sequence[TrackPoint]], group: Sequence[str], at_seconds: float
) -> float:
    """How close a group's members lay to one straight line, 0.0–1.0, at one instant.

    The ratio of the two principal spreads of their positions: 1.0 for two members or a perfect line,
    towards 0.0 for a circle. ⚠️ Two points are always collinear, so a pair reads 1.0 — true, and
    worth nothing, which is why this is reported rather than thresholded.
    """
    positions: List[Tuple[float, float]] = []
    for identity in group:
        points = subjects.get(identity, ())
        match = min(points, key=lambda p: abs(p.at_seconds - at_seconds), default=None)
        if match is not None:
            positions.append(match.foot_point)
    if len(positions) < 2:
        return 0.0
    mean_x = sum(p[0] for p in positions) / len(positions)
    mean_y = sum(p[1] for p in positions) / len(positions)
    sxx = sum((p[0] - mean_x) ** 2 for p in positions) / len(positions)
    syy = sum((p[1] - mean_y) ** 2 for p in positions) / len(positions)
    sxy = sum((p[0] - mean_x) * (p[1] - mean_y) for p in positions) / len(positions)
    trace, det = sxx + syy, sxx * syy - sxy * sxy
    root = math.sqrt(max(0.0, trace * trace / 4.0 - det))
    major, minor = trace / 2.0 + root, trace / 2.0 - root
    if major <= 1e-12:
        return 0.0
    return round(1.0 - math.sqrt(max(0.0, minor) / major), 6)


def _distance(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
