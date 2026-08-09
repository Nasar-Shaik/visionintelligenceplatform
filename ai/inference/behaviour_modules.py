"""Behaviour primitives as perception plugins (P-11 slice 2.2) — Layer 2, behind the P-10 registry.

    registry.register(TASK_BEHAVIOUR, "motion", MotionModule)
    registry.create(TASK_BEHAVIOUR, "motion").analyse(context)  → PerceptionOutput

⭐ **`register_task("behaviour", …)` is the point of this module, and it is the P-10 design being
tested rather than described.** The perception registry was built with an *open* task set precisely
so a plugin could bring a task nobody had designed for; behaviour is the first one to actually do it.
Nothing in `perception.py`, `perception_registry.py` or the pipeline changes to accommodate it. If
this file had needed either widened, the P-10 design would have been wrong and that would have been
the finding.

### ⚠️ These modules consume tracks, not pixels

A `PerceptionModule` is defined by its four verbs (`load`/`preprocess`/`analyse`/`unload`), not by
taking an image. `preprocess` here receives a `BehaviourContext` — identities, their points, the
zones — and `analyse` returns the same `PerceptionOutput` a pose model would. That is why the P-10
contract made `bbox` optional and gave `FrameLabel` no box at all: a statement about the *scene*
("six identities present") and a statement about a *subject* ("stationary for 47 s") are both
expressible without inventing a side-channel.

### ⛔ Domain-neutral or it does not belong here

Every module below passes the hospital test ([ADR-0052]): a hospital, a warehouse, a school and a
factory can all use it without renaming it. `dwell` passes; `concealment` does not, and its absence
is enforced by an executable test that scans this module's exported names for domain words.

Stdlib-only, pure, deterministic. No clock, no I/O, no model.

[ADR-0052]: ../../docs/adr/ADR-0052-behaviour-reasoning-is-not-perception.md
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import behaviour_primitives as bp
from perception import FrameLabel, PerceptionOutput, RawInstance, register_task
from perception_registry import PerceptionRegistry

#: The task this milestone brings. Registered at import, exactly as a third-party plugin would.
TASK_BEHAVIOUR = "behaviour"

register_task(
    TASK_BEHAVIOUR,
    "Geometric and temporal facts derived from tracked subjects — never an intent",
)

#: Where a subject's behaviour facts ride inside the frozen `Detection.attributes` map. Declared once
#: here for the same reason `ATTR_POSE` is declared once in `perception.py`: a module that spells it
#: inline has forked the contract in a way no test would notice.
ATTR_BEHAVIOUR = "behaviour"

#: The attribute media stamps zone membership into, decided in
#: `services/media/src/application/zone-resolver.ts`. ⚠️ **This string must equal `ZONE_ATTRIBUTE`
#: there**, and the two cannot import each other across the language boundary — the same note that
#: file carries about `services/events`. A `tools/contracts` check asserts they agree.
ZONE_ATTRIBUTE = "zoneIds"

#: Identities compared pairwise per frame. The relational scan is O(n²) under the caller's lock, so
#: it is capped rather than left to grow — a frame with more simultaneous identities than this has a
#: perception problem, not a proximity-metric problem. Mirrors `MAX_CROSSING_TRACKS` in the tracker.
#:
#: ⚠️ Re-exported under the name it has had since slice 2.2; the value now lives beside `Scene`, which
#: is what applies it. Two modules each holding their own 32 is how the read path came to be capped in
#: one place and uncapped in the other.
MAX_RELATIONAL_IDENTITIES = bp.MAX_RELATIONAL_IDENTITIES


@dataclass(frozen=True)
class BehaviourContext:
    """One frame's worth of tracked history, prepared for the primitive modules.

    ⚠️ `subjects` and `objects` are split by label rather than by anything the model said, because
    the *question* differs: a subject moves under its own power and a thing is carried. Both are
    grouped by `identity_id` — never `track_id` — before they get here.
    """

    tenant_id: str
    camera_id: str
    stream_id: Optional[str] = None
    frame_index: int = 0
    at_seconds: float = 0.0
    subjects: Mapping[str, Sequence[bp.TrackPoint]] = field(default_factory=dict)
    objects: Mapping[str, Sequence[bp.TrackPoint]] = field(default_factory=dict)
    zones: Sequence[bp.ZoneRegion] = ()
    #: Operator-drawn `kind: "line"` zones, for `CrossingModule` (P-11 slice 2.5).
    #:
    #: ⚠️ **Separate from `zones`, because a line is not a region.** A `ZoneRegion` answers *was this
    #: observation inside me*, and a polyline has no inside — which is exactly why
    #: `ZONE_EVALUATION` marks the shape storable and not evaluable. Crossing is a question about two
    #: consecutive observations, so it needs the geometry rather than a membership fact, and it can
    #: only be answered by a caller that holds the line.
    lines: Sequence[bp.Line] = ()
    #: The subjects prepared for pairwise work — time index, headings, position bounds, memoised
    #: distance series — built **once** by whoever assembles this context.
    #:
    #: ⭐ **This is what "prepared for the primitive modules" already claimed to mean.** Three modules
    #: here do pairwise work, and each building its own preparation meant every identity's headings
    #: and every pair's distance series were computed three times per read. ⚠️ Optional, and every
    #: module falls back to building its own: a test that authors a context by hand must not have to
    #: know this exists, and a module must never be *wrong* without it — only slower.
    scene: Optional[bp.Scene] = None
    #: Frame interval in footage seconds, used to tell an occlusion from a normal sampling gap.
    #: ⚠️ Derived from observed timestamps by the caller, never from a configured fps: the two
    #: disagree the moment a camera drops frames, and this is the one that was actually true.
    expected_interval_seconds: float = 0.5
    #: ⛔ False when no detection carried zone membership. Without it every dwell is 0.0, which is
    #: indistinguishable from "nobody lingered" — see `BehaviourStage` for why it is reported.
    zone_membership_present: bool = False

    def all_identities(self) -> Dict[str, Sequence[bp.TrackPoint]]:
        merged: Dict[str, Sequence[bp.TrackPoint]] = dict(self.subjects)
        merged.update(self.objects)
        return merged

    def prepared_scene(self) -> bp.Scene:
        """The shared preparation, or a fresh one for a caller that did not supply it."""
        return self.scene if self.scene is not None else bp.Scene(self.subjects)


class _BehaviourModule:
    """The shared four verbs. ⚠️ `load`/`unload` are genuinely empty here and that is not an
    oversight: a primitive has no weights to bring into memory, and pretending otherwise by faking a
    load would make the registry's lifecycle report lie about what a deployment is holding."""

    task = TASK_BEHAVIOUR
    execution_provider = "cpu"
    name = "behaviour"

    def __init__(self) -> None:
        self._ref: Dict[str, object] = {}

    def load(self, ref: Optional[dict] = None) -> None:
        self._ref = dict(ref or {})

    def preprocess(self, ctx: BehaviourContext) -> BehaviourContext:
        return ctx

    def analyse(self, prepared: BehaviourContext) -> PerceptionOutput:  # pragma: no cover - abstract
        raise NotImplementedError

    def unload(self) -> None:
        self._ref = {}


def _subject_instance(identity_id: str, points: Sequence[bp.TrackPoint], payload: dict) -> RawInstance:
    """One statement about one identity, boxed at its most recent observation.

    ⚠️ The box is the *latest* point's, so a behaviour fact drawn on a frame lands where the subject
    is now rather than where the span began. `identityId` rides in `attributes` because a
    `RawInstance` has no identity field — it describes a region, and identity is the tracker's answer
    about that region rather than the model's.
    """
    last = points[-1]
    return RawInstance(
        score=float(last.confidence),
        bbox=last.bbox,
        label=last.label,
        attributes={"identityId": identity_id, **payload},
    )


class MotionModule(_BehaviourModule):
    """Path, speed, heading and the gaps in between — one identity at a time.

    ⚠️ Speed is **frame widths per second** and is named that way in the payload, because a number
    called `speed` that means 0.3 screens/s will be read as m/s by the first person who sees it.
    `None` where it cannot be measured, never `0.0`.
    """

    name = "motion"

    def analyse(self, prepared: BehaviourContext) -> PerceptionOutput:
        instances: List[RawInstance] = []
        for identity, points in prepared.all_identities().items():
            if not points:
                continue
            gaps = (
                bp.observation_gaps(points, expected_interval=prepared.expected_interval_seconds)
                if prepared.expected_interval_seconds > 0
                else []
            )
            payload: Dict[str, object] = {
                "samples": len(points),
                "durationSeconds": round(points[-1].at_seconds - points[0].at_seconds, 4),
                "pathLengthNormalized": bp.path_length(points),
                "speedNormalizedPerSecond": bp.velocity_frames_per_second(points),
                "directionDegrees": bp.direction_degrees(points),
                "observationGaps": [
                    {"fromSeconds": g.start_seconds, "toSeconds": g.end_seconds, "seconds": g.seconds}
                    for g in gaps
                ],
            }
            instances.append(_subject_instance(identity, points, {"motion": payload}))
        return PerceptionOutput(task=TASK_BEHAVIOUR, instances=instances)


class ZoneModule(_BehaviourModule):
    """Dwell, visits and transitions — for every zone whose membership reached this frame.

    ⛔ **Emits nothing at all when no zone membership is present.** A dwell of 0.0 s for every subject
    is what an unconfigured deployment and an empty shop both look like, and publishing the first as
    though it were the second is the exact failure this project has now met eight times. The absence
    is reported by the stage instead, where an operator can see it.
    """

    name = "zone"

    def analyse(self, prepared: BehaviourContext) -> PerceptionOutput:
        if not prepared.zones or not prepared.zone_membership_present:
            return PerceptionOutput(task=TASK_BEHAVIOUR)

        instances: List[RawInstance] = []
        for identity, points in prepared.subjects.items():
            if not points:
                continue
            zones_payload: Dict[str, object] = {}
            for zone in prepared.zones:
                visits = bp.zone_visits(points, zone)
                if not visits:
                    continue
                zones_payload[zone.zone_id] = {
                    "dwellSeconds": round(sum(v.interval.seconds for v in visits), 4),
                    "visits": len(visits),
                    "present": any(v.open_ended for v in visits),
                }
            transitions = [
                {"atSeconds": at, "transition": event, "zoneId": zone_id}
                for at, event, zone_id in bp.zone_transitions(points, prepared.zones)
            ]
            if not zones_payload and not transitions:
                continue
            instances.append(
                _subject_instance(identity, points, {"zone": {"zones": zones_payload, "transitions": transitions}})
            )

        # ⛔ Counted at the latest instant whose membership has been DECIDED, not at "now".
        #
        # Membership comes back a frame after the box (ADR-0053), so at `prepared.at_seconds` every
        # subject's membership is still unknown — and `holds` answers `False` for unknown. Counting
        # there would report an empty zone on every frame of a busy shop, which is the most plausible
        # wrong number this module could produce. `None` when nothing has been decided yet: no label
        # at all, rather than a confident zero.
        settled_at = _last_settled(prepared.subjects)
        labels = (
            []
            if settled_at is None
            else [
                FrameLabel(
                    "occupancy",
                    attributes={
                        "zoneId": zone.zone_id,
                        "count": bp.occupancy_count(dict(prepared.subjects), at_seconds=settled_at, zone=zone),
                        "atSeconds": round(settled_at, 4),
                    },
                )
                for zone in prepared.zones
            ]
        )
        return PerceptionOutput(task=TASK_BEHAVIOUR, instances=instances, frame_labels=labels)


class RelationalModule(_BehaviourModule):
    """Who was near whom, and for how long.

    ⚠️ Capped at `MAX_RELATIONAL_IDENTITIES` and the cap is reported in the output's attributes, not
    swallowed. A truncated pairwise scan that said nothing about being truncated would show a crowded
    scene as a quiet one.
    """

    name = "relational"

    def analyse(self, prepared: BehaviourContext) -> PerceptionOutput:
        identities = sorted(prepared.subjects)
        truncated = len(identities) > MAX_RELATIONAL_IDENTITIES
        identities = identities[:MAX_RELATIONAL_IDENTITIES]

        instances: List[RawInstance] = []
        for identity in identities:
            points = prepared.subjects[identity]
            if not points:
                continue
            others: List[dict] = []
            for other in identities:
                if other == identity:
                    continue
                other_points = prepared.subjects[other]
                if not other_points:
                    continue
                seconds = bp.co_presence_seconds(points, other_points)
                distance = _distance_at(points[-1], other_points)
                if seconds <= 0.0 and distance is None:
                    continue
                entry: Dict[str, object] = {"identityId": other, "coPresenceSeconds": seconds}
                if distance is not None:
                    entry["distanceNormalized"] = distance
                others.append(entry)
            if not others:
                continue
            others.sort(key=lambda e: (-float(e["coPresenceSeconds"]), str(e["identityId"])))
            instances.append(_subject_instance(identity, points, {"relational": {"near": others}}))

        # ⛔ No subjects at all ⇒ no occupancy statement, rather than `count: 0`.
        #
        # A stream nothing has ever been seen on is not a room with nobody in it: the camera may be
        # down, the stage may never have run, the analysis may not have started. Publishing a
        # confident zero makes all of those look like an empty shop, which is the failure ADR-0039
        # exists to prevent — and this module shipped it in slice 2.2. ⚠️ Zero *is* reported once
        # there are subjects to count and none of them was present at this instant: that is a
        # measurement, and the difference between the two is the whole point.
        labels = (
            []
            if not prepared.subjects
            else [
                FrameLabel(
                    "occupancy",
                    attributes={"count": bp.occupancy_count(dict(prepared.subjects), at_seconds=prepared.at_seconds)},
                )
            ]
        )
        return PerceptionOutput(
            task=TASK_BEHAVIOUR,
            instances=instances,
            frame_labels=labels,
            attributes={"truncated": truncated, "identitiesConsidered": len(identities)},
        )


class AssociationModule(_BehaviourModule):
    """Which subject an object travelled with, and when it changed hands.

    ⭐ **The primitive under `picked_object`, `returned_object` and `handover`** — one mechanism, three
    business words, which is what keeps all three out of Layer 3's way. ⚠️ Nearest-subject-per-frame
    is a heuristic and is named as one: two people reaching at once will make the association
    alternate, and that alternation is a signal a rule should read as *ambiguous*.
    """

    name = "association"

    def analyse(self, prepared: BehaviourContext) -> PerceptionOutput:
        if not prepared.objects or not prepared.subjects:
            return PerceptionOutput(task=TASK_BEHAVIOUR)

        subjects = {identity: list(points) for identity, points in prepared.subjects.items()}
        instances: List[RawInstance] = []
        labels: List[FrameLabel] = []
        for identity, points in prepared.objects.items():
            if not points:
                continue
            spans = bp.associations(points, subjects)
            if not spans:
                continue
            payload: Dict[str, object] = {
                "heldBy": [
                    {
                        "identityId": span.subject_identity,
                        "fromSeconds": span.interval.start_seconds,
                        "toSeconds": span.interval.end_seconds,
                        "seconds": span.interval.seconds,
                        "current": span.open_ended,
                    }
                    for span in spans
                ]
            }
            # ⭐ `picked`, `dropped`, `missing`, `returned` — four business words over two mechanisms
            # this module already runs. ⚠️ They ride on the object's own instance rather than on the
            # subject's, because the object is what the statement is about; a rule joins to the
            # subject through `subjectIdentityId`.
            events = bp.object_events(
                points,
                subjects,
                expected_interval=prepared.expected_interval_seconds,
                threshold=bp.NEAR_THRESHOLD,
            )
            if events:
                payload["events"] = [
                    {
                        "kind": event.kind,
                        "atSeconds": event.at_seconds,
                        "subjectIdentityId": event.subject_identity,
                        "seconds": event.seconds,
                    }
                    for event in events
                ]
                payload["readings"] = {
                    name: dict(bp.PRIMITIVE_READINGS[name])
                    for name in ("pick_object", "drop_object", "object_missing", "object_returned")
                }
            instances.append(_subject_instance(identity, points, {"association": payload}))
            for at_seconds, giver, taker in bp.handovers(spans):
                labels.append(
                    FrameLabel(
                        "handover",
                        attributes={
                            "objectIdentityId": identity,
                            "fromIdentityId": giver,
                            "toIdentityId": taker,
                            "atSeconds": at_seconds,
                        },
                    )
                )
        return PerceptionOutput(task=TASK_BEHAVIOUR, instances=instances, frame_labels=labels)


class PresenceModule(_BehaviourModule):
    """How long each subject stayed put, and how tightly — `idle` and `linger`.

    ⭐ **Two words, one mechanism.** Both are readings of `stationary_episodes` at thresholds declared
    in `bp.PRIMITIVE_READINGS`, and the thresholds travel in the payload beside the episodes. An
    operator reading "lingered for 42 s" can see that lingering meant *0.08 frame widths for at least
    15 s here*, rather than having to trust a word — and a deployment that disagrees changes the
    number instead of the meaning.

    ⚠️ Idle episodes nest inside linger episodes rather than sitting beside them. Summing across the
    two names would double-count one person standing still.
    """

    name = "presence"

    def analyse(self, prepared: BehaviourContext) -> PerceptionOutput:
        instances: List[RawInstance] = []
        for identity, points in prepared.subjects.items():
            if len(points) < 2:
                continue
            readings = bp.stationary_readings(points)
            payload: Dict[str, object] = {}
            for reading, episodes in readings.items():
                if not episodes:
                    continue
                payload[reading] = {
                    "episodes": [_episode(e) for e in episodes],
                    "totalSeconds": round(sum(e.interval.seconds for e in episodes), 4),
                    # ⚠️ The thresholds that produced the number, not just the number. A duration
                    # whose definition a reader has to guess is a duration they cannot check.
                    "reading": dict(bp.PRIMITIVE_READINGS[reading]),
                }
            if payload:
                instances.append(_subject_instance(identity, points, {"presence": payload}))
        return PerceptionOutput(task=TASK_BEHAVIOUR, instances=instances)


class CrossingModule(_BehaviourModule):
    """Which configured lines each subject crossed, and in which direction.

    ⭐ **This is `ZONE_EVALUATION`'s reserved `line` shape becoming evaluable**, in the layer that has
    what the contract said it needed. `packages/contracts/src/zones/zone.ts` records the requirement
    verbatim — *"a side-of-line test carried between frames per subject … crossing is a transition, so
    it needs the previous frame — state the resolver does not keep"* — and a trajectory is that state.

    ⛔ **Emits nothing when no line geometry reached this context**, for the same reason `ZoneModule`
    does: "nobody crossed the line" and "no line was configured" are different facts, and a module
    that publishes an empty crossing list for both makes them identical to every reader downstream.
    """

    name = "crossing"

    def analyse(self, prepared: BehaviourContext) -> PerceptionOutput:
        if not prepared.lines:
            return PerceptionOutput(task=TASK_BEHAVIOUR)
        instances: List[RawInstance] = []
        for identity, points in prepared.subjects.items():
            if len(points) < 2:
                continue
            crossed: List[dict] = []
            for line in prepared.lines:
                crossed.extend(
                    {
                        "lineId": c.line_id,
                        "atSeconds": c.at_seconds,
                        "fromSide": c.from_side,
                        "toSide": c.to_side,
                        "segmentIndex": c.segment_index,
                    }
                    for c in bp.crossings(points, line)
                )
            if not crossed:
                continue
            crossed.sort(key=lambda c: (c["atSeconds"], str(c["lineId"])))
            instances.append(_subject_instance(identity, points, {"crossing": {"crossings": crossed}}))
        return PerceptionOutput(task=TASK_BEHAVIOUR, instances=instances)


class InteractionModule(_BehaviourModule):
    """What happened *between* pairs of subjects — following, and the gap opening or closing.

    ⚠️ **Ordered pairs, because both are asymmetric.** A following B is not B following A, and the
    module computes both directions rather than picking one; `distance_changes` is symmetric in value
    but is reported on each subject so that reading one identity's payload is enough to see it.

    ⚠️ Capped at `MAX_RELATIONAL_IDENTITIES` like `RelationalModule`, and the cap is reported rather
    than swallowed — a truncated pairwise scan that said nothing about being truncated would show a
    crowded scene as a quiet one.
    """

    name = "interaction"

    def analyse(self, prepared: BehaviourContext) -> PerceptionOutput:
        scene = prepared.prepared_scene()
        identities = list(scene.identities)
        if len(identities) < 2:
            return PerceptionOutput(
                task=TASK_BEHAVIOUR,
                attributes={"truncated": scene.truncated, "identitiesConsidered": scene.considered},
            )

        follow = bp.PRIMITIVE_READINGS["follow"]
        approach = bp.PRIMITIVE_READINGS["approach"]
        # ⛔ The scene-wide entry points, not a pair loop calling the per-pair ones. Preparing each
        # identity once instead of once per partner is the difference between a 58 ms read and a
        # 43-second one — see the note above `_Series` and `tools/validation/behaviour-bench.mjs`.
        follows_by = bp.follow_episodes(
            scene,
            max_distance=float(follow["maxDistanceNormalized"]),
            heading_tolerance_degrees=float(follow["headingToleranceDegrees"]),
            min_speed=float(follow["minSpeedNormalizedPerSecond"]),
            min_seconds=float(follow["minSeconds"]),
        )
        changes_by = bp.distance_change_episodes(
            scene,
            min_change=float(approach["minChangeNormalized"]),
            min_seconds=float(approach["minSeconds"]),
        )

        instances: List[RawInstance] = []
        for identity in identities:
            points = prepared.subjects[identity]
            if len(points) < 2:
                continue
            follows = [
                {
                    "leaderIdentityId": episode.leader_identity_id,
                    "fromSeconds": episode.interval.start_seconds,
                    "toSeconds": episode.interval.end_seconds,
                    "seconds": episode.interval.seconds,
                    "meanDistanceNormalized": episode.mean_distance_normalized,
                }
                for episode in follows_by.get(identity, ())
            ]
            # ⚠️ Reported on the alphabetically first of the pair — `distance_changes` is symmetric,
            # so putting it on both would be the same measurement twice.
            changes = [
                {
                    "withIdentityId": change.other_identity_id,
                    "kind": change.kind,
                    "fromSeconds": change.interval.start_seconds,
                    "toSeconds": change.interval.end_seconds,
                    "seconds": change.interval.seconds,
                    "fromNormalized": change.from_normalized,
                    "toNormalized": change.to_normalized,
                    "deltaNormalized": change.delta_normalized,
                }
                for (left, _right), found in sorted(changes_by.items())
                if left == identity
                for change in found
            ]
            if not follows and not changes:
                continue
            changes.sort(key=lambda c: (c["fromSeconds"], str(c["withIdentityId"])))
            payload: Dict[str, object] = {}
            if follows:
                payload["follows"] = follows
                payload["reading"] = dict(follow)
            if changes:
                payload["distanceChanges"] = changes
            instances.append(_subject_instance(identity, points, {"interaction": payload}))
        return PerceptionOutput(
            task=TASK_BEHAVIOUR,
            instances=instances,
            attributes={"truncated": scene.truncated, "identitiesConsidered": scene.considered},
        )


class GroupModule(_BehaviourModule):
    """How the subjects were grouped, when the grouping changed, and who stood waiting together.

    ⭐ **Scene-level, so it leaves on the frame** (ADR-0054). A merge is a statement about a *scene* —
    it names two groups and belongs to neither — and a `RawInstance` describes one rectangle. Emitting
    it as a `FrameLabel` is what keeps it out of the frozen `Detection` contract and off any one
    subject's record.

    ⚠️ `queue` is `stationary_groups` under `bp.PRIMITIVE_READINGS`. The mechanism is neutral — people
    stationary together for a while — and the word is the reading; a ward, a bus stop and an assembly
    line are the same geometry. `linearity` travels with it, unthresholded, so a Layer 3 rule can
    weigh how line-shaped the group actually was.
    """

    name = "group"

    def analyse(self, prepared: BehaviourContext) -> PerceptionOutput:
        scene = prepared.prepared_scene()
        if len(scene.identities) < 2:
            return PerceptionOutput(
                task=TASK_BEHAVIOUR,
                attributes={"truncated": scene.truncated, "identitiesConsidered": scene.considered},
            )

        merge = bp.PRIMITIVE_READINGS["group_merge"]
        queue = bp.PRIMITIVE_READINGS["queue"]
        labels: List[FrameLabel] = [
            FrameLabel(
                "groupChange",
                attributes={
                    "change": change.kind,
                    "atSeconds": change.at_seconds,
                    "identityIds": list(change.identities),
                    "before": [list(g) for g in change.before],
                    "after": [list(g) for g in change.after],
                    "thresholdNormalized": float(merge["thresholdNormalized"]),
                },
            )
            for change in bp.group_changes(
                scene,
                threshold=float(merge["thresholdNormalized"]),
                min_seconds=float(merge["minSeconds"]),
            )
        ]
        labels.extend(
            FrameLabel(
                "stationaryGroup",
                attributes={
                    "identityIds": list(group.identities),
                    "fromSeconds": group.interval.start_seconds,
                    "toSeconds": group.interval.end_seconds,
                    "seconds": group.interval.seconds,
                    "linearity": group.linearity,
                    "reading": "queue",
                },
            )
            for group in bp.stationary_groups(
                scene,
                radius=float(queue["radiusNormalized"]),
                min_seconds=float(queue["minSeconds"]),
                threshold=float(queue["thresholdNormalized"]),
                min_size=int(queue["minSize"]),
            )
        )
        return PerceptionOutput(
            task=TASK_BEHAVIOUR,
            frame_labels=labels,
            attributes={"truncated": scene.truncated, "identitiesConsidered": scene.considered},
        )


def _episode(episode: bp.Episode) -> dict:
    return {
        "fromSeconds": episode.interval.start_seconds,
        "toSeconds": episode.interval.end_seconds,
        "seconds": episode.interval.seconds,
        "radiusNormalized": episode.radius_normalized,
        "samples": episode.samples,
        # ⚠️ An episode still open when the track ended is a lower bound on its duration. Said, rather
        # than left for a reader to infer from a timestamp that happens to be the last one.
        "open": episode.open_ended,
    }


#: The modules a deployment gets unless it configures otherwise, in execution order.
#:
#: ⚠️ Order is deterministic and matters only for reproducibility — no module reads another's output,
#: which is what "no module should know about another module's implementation" reduces to here.
DEFAULT_MODULES: Tuple[Tuple[str, type], ...] = (
    ("motion", MotionModule),
    ("zone", ZoneModule),
    ("relational", RelationalModule),
    ("association", AssociationModule),
    ("presence", PresenceModule),
    ("crossing", CrossingModule),
    ("interaction", InteractionModule),
    ("group", GroupModule),
)


def register_behaviour_modules(registry: PerceptionRegistry, *, replace: bool = False) -> List[str]:
    """Register every default primitive module. Returns the names registered."""
    for name, factory in DEFAULT_MODULES:
        registry.register(TASK_BEHAVIOUR, name, factory, replace=replace)
    return [name for name, _ in DEFAULT_MODULES]


def default_behaviour_registry() -> PerceptionRegistry:
    """A registry holding only the behaviour modules — what the composition root builds when no wider
    perception registry exists yet."""
    registry = PerceptionRegistry()
    register_behaviour_modules(registry)
    return registry


def _last_settled(subjects: Mapping[str, Sequence[bp.TrackPoint]]) -> Optional[float]:
    """The most recent moment for which zone membership has been decided, or `None`."""
    latest: Optional[float] = None
    for points in subjects.values():
        for point in reversed(points):
            if point.zones_settled:
                if latest is None or point.at_seconds > latest:
                    latest = point.at_seconds
                break
    return latest


def _distance_at(point: bp.TrackPoint, others: Sequence[bp.TrackPoint], *, tolerance: float = 0.001) -> Optional[float]:
    """Distance to another identity **at the same instant**, or `None` if it was not observed then.

    ⛔ `None` rather than the distance to its last known position. Two subjects one frame apart can be
    anywhere relative to each other, and a stale distance presented as a current one is a proximity
    claim nobody made.
    """
    match = next((p for p in others if abs(p.at_seconds - point.at_seconds) <= tolerance), None)
    return None if match is None else bp.distance_between(point, match)
