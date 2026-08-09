"""Behaviour, recomputed for a whole analysis (P-11 slice 2.3) — the read path.

    track history ──▶ BehaviourContext ──▶ the same four modules ──▶ primitives
                 └──▶ the same pure functions ──▶ episodes ──▶ timeline

⭐ **Nothing here is stored, and that is the design rather than an economy.** Track history is the
one durable substrate ([ADR-0051] decision 3, [ADR-0054]); primitives, scene observations and this
timeline are pure functions over it. A corrected formula therefore *fixes* history instead of being
unable to reach it — a stored dwell would have frozen the definition at the moment it was written.

⭐ **The primitive read runs the same modules the live path runs.** `primitives_for` builds a
`BehaviourContext` and hands it to the registry, exactly as `BehaviourStage` does per frame. A
primitive cannot exist on one path and not the other, and Layer 2 cannot drift into two
implementations — which is the failure the "no Layer 2 in two places" rule exists to prevent.

### ⛔ The timeline explains; it never accuses

Every entry is a geometric or temporal fact with a footage-time interval and a pointer to the frame
it came from. `kind` is a **closed** vocabulary, and an executable test asserts both that it stays
closed and that neither a kind nor a generated sentence contains a word that names an intent. A
timeline that said "concealed" would have moved Layer 3 into the runtime ([ADR-0052]) — and would
have done it in the one component an investigator reads as neutral.

### ⚠️ Footage time, never wall-clock

Every `atSeconds` is the frame's own time, per [ADR-0051] decision 4. `at` beside it is the frame's
ISO timestamp, carried so a viewer can seek; the durations are computed from the seconds.

Stdlib-only, pure, deterministic. No clock, no I/O, no model.

[ADR-0051]: ../../docs/adr/ADR-0051-track-history-becomes-durable.md
[ADR-0052]: ../../docs/adr/ADR-0052-behaviour-reasoning-is-not-perception.md
[ADR-0054]: ../../docs/adr/ADR-0054-a-scene-observation-is-not-a-detection.md
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import behaviour_primitives as bp
from behaviour_modules import (
    DEFAULT_MODULES,
    TASK_BEHAVIOUR,
    BehaviourContext,
    default_behaviour_registry,
)
from perception_registry import ModuleUnavailable, PerceptionRegistry
from track_history import TrackHistoryRecord, TrackHistoryRecorder

#: Labels treated as subjects. Everything else is a thing that gets carried. Mirrors
#: `behaviour_stage.DEFAULT_SUBJECT_LABELS` — one deployment-wide answer to "what moves under its
#: own power", not two.
DEFAULT_SUBJECT_LABELS: Tuple[str, ...] = ("person",)

#: The frame interval assumed when a stream is too short to measure one. ⚠️ Used only to size the
#: occlusion test; a stream with fewer than two points has no gaps to find anyway.
FALLBACK_INTERVAL_SECONDS = 0.5

#: ⛔ **The closed vocabulary.** Adding to it is a decision, not an implementation detail: every kind
#: must pass the hospital test (a hospital, a warehouse, a school and a factory can all use it under
#: their own name) and must state a fact rather than a motive. A test asserts this tuple is exactly
#: the set the projection emits, so a new kind cannot arrive unreviewed.
TIMELINE_KINDS: Tuple[str, ...] = (
    "observed",
    "gap",
    "zoneVisit",
    "zoneEntry",
    "zoneExit",
    "proximity",
    "carried",
    "handover",
)

#: How many entries one timeline answer may carry. ⚠️ An analysis with 98 identities over an hour
#: produces thousands; a read API that could return all of them is a read API that can be used to
#: exhaust the runtime. The cap is reported alongside the result, never applied silently.
DEFAULT_MAX_ENTRIES = 2000


@dataclass(frozen=True)
class TimelineEntry:
    """One fact about one identity, over one interval, with the frame it came from.

    ⛔ **`at_seconds` is an OFFSET into the run, not an absolute footage clock**, and the difference
    was found on real footage rather than reasoned out. A recording stamped with wall-clock capture
    times gives footage seconds around 1.77e9; every duration computed from them is correct and every
    *instant* is unreadable — the first deployed timeline said a subject "was observed from
    1.77109e+09 s to 1.77109e+09 s", which is true, useless, and hides the fifteen seconds between.
    The absolute instant is kept beside it as `at`, because that is what a viewer seeks to.
    """

    kind: str
    identity_id: str
    at_seconds: float
    camera_id: str
    summary: str
    end_seconds: Optional[float] = None
    stream_id: Optional[str] = None
    attributes: Mapping[str, object] = field(default_factory=dict)
    #: Where to look: the frame index and the track that produced it.
    #: ⚠️ `trackId`, not `identityId` — an investigator seeking a frame needs the observation, and
    #: the identity is already the entry's subject.
    evidence: Mapping[str, object] = field(default_factory=dict)
    #: Footage second the run's first observation was taken at, subtracted from every instant here.
    origin_seconds: float = 0.0

    def _offset(self, seconds: float) -> float:
        return round(float(seconds) - self.origin_seconds, 4)

    def to_dict(self) -> dict:
        out: dict = {
            "kind": self.kind,
            "identityId": self.identity_id,
            "atSeconds": self._offset(self.at_seconds),
            # ⚠️ The absolute footage second, kept so a caller joining against `HistoryPoint.at` or
            # against an event's timestamp has the number those carry. Reported alongside rather than
            # instead of the offset: one is readable, the other is joinable.
            "footageSeconds": round(float(self.at_seconds), 4),
            "cameraId": self.camera_id,
            "summary": self.summary,
            "attributes": dict(self.attributes),
            "evidence": dict(self.evidence),
        }
        if self.end_seconds is not None:
            out["endSeconds"] = self._offset(self.end_seconds)
            out["seconds"] = round(float(self.end_seconds) - float(self.at_seconds), 4)
        if self.stream_id is not None:
            out["streamId"] = self.stream_id
        return out


# --- gathering ---------------------------------------------------------------------------------


def collect(
    recorder: TrackHistoryRecorder,
    tenant_id: str,
    *,
    camera_id: Optional[str] = None,
    stream_id: Optional[str] = None,
    identity_id: Optional[str] = None,
    include_live: bool = True,
) -> Tuple[List[TrackHistoryRecord], dict]:
    """Every record matching a query, durable and live, with where each came from.

    ⭐ **The provenance is returned, not folded in.** An analysis that is still running has its
    identities in memory and none on disk; one that finished has the opposite. A caller shown a
    single number cannot tell "this run produced two identities" from "this run is 3 % through", and
    those read identically in a report.

    ⚠️ Live records are **open**: their last interval has not ended. Every duration derived from one
    is a lower bound, which is why `zoneVisit` carries `open` and why this says how many there were.
    """
    # ⭐ `stream_id` goes to the store, not to a list comprehension after it. Filtering here instead
    # made an analysis-scoped read cost the whole tenant's history — the P-11 soak watched these two
    # endpoints climb 330 → 608 ms while every other operation stayed flat.
    durable = recorder.store.records(
        tenant_id, camera_id=camera_id, identity_id=identity_id, stream_id=stream_id
    )
    live: List[TrackHistoryRecord] = []
    if include_live:
        live = recorder.find_live(
            tenant_id, camera_id=camera_id, stream_id=stream_id, identity_id=identity_id
        )
    # ⚠️ An identity is in exactly one of the two — retirement removes it from the live buffer before
    # the record is queued — but the guard is here anyway: a duplicate would double every dwell.
    seen = {(r.identity_id, r.camera_id, r.stream_id) for r in durable}
    merged = list(durable) + [r for r in live if (r.identity_id, r.camera_id, r.stream_id) not in seen]
    merged.sort(key=lambda r: (r.first_seconds if r.first_seconds is not None else 0.0, r.identity_id))
    return merged, {"durable": len(durable), "live": len(merged) - len(durable), "records": len(merged)}


def points_by_identity(
    records: Sequence[TrackHistoryRecord],
) -> Dict[str, List[bp.TrackPoint]]:
    """Track points per identity, in footage-time order, dropping anything undated.

    ⚠️ Grouped by `identity_id` — never `track_id` (ADR-0038/0041). Two records for one identity on
    two cameras merge here, which is correct for "what did this person do" and is why the camera is
    carried on each entry rather than assumed.
    """
    out: Dict[str, List[bp.TrackPoint]] = {}
    for record in records:
        for point in record.points:
            seconds = point.at_seconds
            if seconds is None:
                continue
            out.setdefault(record.identity_id, []).append(
                bp.TrackPoint(
                    identity_id=record.identity_id,
                    at_seconds=seconds,
                    bbox=point.bbox,
                    label=point.label,
                    track_id=point.track_id,
                    frame_index=point.frame_index,
                    confidence=point.confidence,
                    zone_ids=point.zone_ids,
                    zones_settled=point.zones_settled,
                )
            )
    for points in out.values():
        points.sort(key=lambda p: (p.at_seconds, p.frame_index))
    return out


def observed_interval_seconds(records: Sequence[TrackHistoryRecord]) -> Optional[float]:
    """The typical gap between consecutive frames, as the **median** of what was observed.

    ⚠️ Measured, never taken from a configured fps: the two disagree the instant a camera drops a
    frame, and this is the one that was true. ⚠️ The median rather than the mean, because an
    occlusion is a large outlier and a mean would let one 9-second gap declare the stream to be
    running at 0.1 fps — which would then hide every other gap.
    """
    deltas: List[float] = []
    for record in records:
        seconds = [p.at_seconds for p in record.points if p.at_seconds is not None]
        seconds.sort()
        deltas.extend(b - a for a, b in zip(seconds, seconds[1:]) if b > a)
    if not deltas:
        return None
    deltas.sort()
    middle = len(deltas) // 2
    if len(deltas) % 2 == 1:
        return round(deltas[middle], 6)
    return round((deltas[middle - 1] + deltas[middle]) / 2.0, 6)


def context_for(
    records: Sequence[TrackHistoryRecord],
    *,
    subject_labels: Sequence[str] = DEFAULT_SUBJECT_LABELS,
) -> BehaviourContext:
    """A `BehaviourContext` covering a whole analysis rather than one frame.

    ⭐ **The same object the live stage builds**, which is what lets the read path run the same
    modules. The only differences are that `at_seconds` is the last moment observed rather than now,
    and that the points span the run rather than the last `historyMax` frames.
    """
    grouped = points_by_identity(records)
    labels = frozenset(subject_labels)
    label_of = {record.identity_id: record.label for record in records}
    subjects: Dict[str, Sequence[bp.TrackPoint]] = {}
    objects: Dict[str, Sequence[bp.TrackPoint]] = {}
    zone_ids: set = set()
    latest = 0.0
    for identity, points in grouped.items():
        if not points:
            continue
        latest = max(latest, points[-1].at_seconds)
        for point in points:
            if point.zones_settled:
                zone_ids.update(point.zone_ids)
        (subjects if label_of.get(identity) in labels else objects)[identity] = points

    first = records[0] if records else None
    interval = observed_interval_seconds(records)
    return BehaviourContext(
        tenant_id=first.tenant_id if first is not None else "",
        camera_id=first.camera_id if first is not None else "",
        stream_id=first.stream_id if first is not None else None,
        frame_index=0,
        at_seconds=latest,
        subjects=subjects,
        objects=objects,
        zones=tuple(bp.MembershipZone(zone_id) for zone_id in sorted(zone_ids)),
        expected_interval_seconds=interval if interval is not None else FALLBACK_INTERVAL_SECONDS,
        zone_membership_present=bool(zone_ids),
    )


# --- the primitive read ------------------------------------------------------------------------


def primitives_for(
    records: Sequence[TrackHistoryRecord],
    *,
    registry: Optional[PerceptionRegistry] = None,
    modules: Optional[Sequence[str]] = None,
    subject_labels: Sequence[str] = DEFAULT_SUBJECT_LABELS,
) -> dict:
    """Every primitive, for every identity in an analysis — the Behaviour API's answer.

    ⚠️ Independent of the UI and of any rule: this returns what the primitives *say*, with no
    threshold applied and no verdict attached. A rule that wants "dwell over 60 s" reads this; it
    does not get to change what this reports.
    """
    registry = registry if registry is not None else default_behaviour_registry()
    names = list(modules) if modules is not None else [name for name, _ in DEFAULT_MODULES]
    context = context_for(records, subject_labels=subject_labels)

    identities: Dict[str, Dict[str, object]] = {}
    scene: List[dict] = []
    failures: Dict[str, str] = {}
    for name in names:
        try:
            module = registry.create(TASK_BEHAVIOUR, name)
        except ModuleUnavailable as exc:
            failures[name] = str(exc)
            continue
        module.load({})
        try:
            output = module.analyse(module.preprocess(context))
        except Exception as exc:  # noqa: BLE001 - one bad primitive must not fail the read
            failures[name] = f"{type(exc).__name__}: {exc}"
            continue
        finally:
            module.unload()
        for instance in output.instances:
            identity = instance.attributes.get("identityId")
            if not isinstance(identity, str):
                continue
            bucket = identities.setdefault(identity, {})
            for attribute, value in instance.attributes.items():
                if attribute != "identityId":
                    bucket[attribute] = value
        scene.extend(label.to_scene_observation() for label in output.frame_labels)

    return {
        "task": TASK_BEHAVIOUR,
        "modules": names,
        "identities": identities,
        "scene": scene,
        # ⛔ Three-valued, as everywhere else: `absent` says the zone primitives were inert because
        # nothing ever supplied membership, which is a different answer from "nobody entered a zone".
        "zoneMembership": "present" if context.zone_membership_present else "absent",
        "observedIntervalSeconds": observed_interval_seconds(records),
        "moduleFailures": failures,
    }


# --- the timeline projection -------------------------------------------------------------------


def timeline_for(
    records: Sequence[TrackHistoryRecord],
    *,
    subject_labels: Sequence[str] = DEFAULT_SUBJECT_LABELS,
    max_entries: int = DEFAULT_MAX_ENTRIES,
) -> Tuple[List[TimelineEntry], bool]:
    """An ordered, per-identity account of what was observed. Returns the entries and whether the
    cap truncated them.

    ⚠️ Ordered by footage time, then kind, then identity — fully deterministic, because a projection
    used for investigation must produce the same document twice.
    """
    context = context_for(records, subject_labels=subject_labels)
    label_of = {record.identity_id: record.label for record in records}
    camera_of: Dict[str, str] = {}
    stream_of: Dict[str, Optional[str]] = {}
    for record in records:
        camera_of.setdefault(record.identity_id, record.camera_id)
        stream_of.setdefault(record.identity_id, record.stream_id)
    tracks_of: Dict[str, List[str]] = {}
    for record in records:
        tracks_of.setdefault(record.identity_id, []).extend(record.track_ids)

    entries: List[TimelineEntry] = []

    everything = dict(context.subjects)
    everything.update(context.objects)

    #: ⛔ The run's first observation. Every instant reported is an offset from it — see
    #: `TimelineEntry`. `0.0` for an empty run, where there is nothing to offset from.
    origin = min((points[0].at_seconds for points in everything.values() if points), default=0.0)

    def since(seconds: float) -> float:
        return round(seconds - origin, 4)

    def emit(kind: str, identity: str, at: float, **kwargs) -> None:
        entries.append(
            TimelineEntry(
                kind=kind,
                identity_id=identity,
                at_seconds=at,
                camera_id=camera_of.get(identity, ""),
                stream_id=stream_of.get(identity),
                origin_seconds=origin,
                **kwargs,
            )
        )

    for identity, points in sorted(everything.items()):
        if not points:
            continue
        noun = "identity" if identity in context.subjects else "object"
        first, last = points[0], points[-1]
        tracks = tracks_of.get(identity, [])
        emit(
            "observed",
            identity,
            first.at_seconds,
            end_seconds=last.at_seconds,
            summary=(
                f"{noun} {identity} was observed on camera {camera_of.get(identity, '?')} "
                f"from {since(first.at_seconds):g} s to {since(last.at_seconds):g} s "
                f"across {len(tracks) or 1} track(s)"
            ),
            attributes={
                "label": label_of.get(identity, last.label),
                "samples": len(points),
                "trackIds": tracks,
                "pathLengthNormalized": bp.path_length(points),
                "speedNormalizedPerSecond": bp.velocity_frames_per_second(points),
                "directionDegrees": bp.direction_degrees(points),
            },
            evidence=_evidence(first),
        )

        for gap in bp.observation_gaps(points, expected_interval=context.expected_interval_seconds):
            emit(
                "gap",
                identity,
                gap.start_seconds,
                end_seconds=gap.end_seconds,
                summary=(
                    f"{noun} {identity} was not observed from {since(gap.start_seconds):g} s "
                    f"to {since(gap.end_seconds):g} s ({gap.seconds:g} s)"
                ),
                attributes={"seconds": gap.seconds},
                evidence=_evidence(_point_at(points, gap.start_seconds)),
            )

    for zone in context.zones:
        for identity, points in sorted(context.subjects.items()):
            for visit in bp.zone_visits(points, zone):
                emit(
                    "zoneVisit",
                    identity,
                    visit.interval.start_seconds,
                    end_seconds=visit.interval.end_seconds,
                    summary=(
                        f"identity {identity} was inside zone {zone.zone_id} from "
                        f"{since(visit.interval.start_seconds):g} s to "
                        f"{since(visit.interval.end_seconds):g} s "
                        f"({visit.interval.seconds:g} s)"
                        + (" and had not left" if visit.open_ended else "")
                    ),
                    attributes={
                        "zoneId": zone.zone_id,
                        "seconds": visit.interval.seconds,
                        # ⚠️ An open visit's duration is a lower bound. Said here rather than left for
                        # a reader to infer from a timestamp that happens to be the last one.
                        "open": visit.open_ended,
                    },
                    evidence=_evidence(_point_at(points, visit.interval.start_seconds)),
                )
        for identity, points in sorted(context.subjects.items()):
            for at_seconds, event, zone_id in bp.zone_transitions(points, [zone]):
                emit(
                    "zoneEntry" if event == "entered" else "zoneExit",
                    identity,
                    at_seconds,
                    summary=f"identity {identity} {event} zone {zone_id} at {since(at_seconds):g} s",
                    attributes={"zoneId": zone_id},
                    evidence=_evidence(_point_at(points, at_seconds)),
                )

    identities = sorted(context.subjects)
    for index, identity in enumerate(identities):
        points = context.subjects[identity]
        for other in identities[index + 1 :]:
            seconds = bp.co_presence_seconds(points, context.subjects[other])
            if seconds <= 0.0:
                continue
            overlap = _overlap(points, context.subjects[other])
            if overlap is None:
                continue
            emit(
                "proximity",
                identity,
                overlap[0],
                end_seconds=overlap[1],
                summary=(
                    f"identity {identity} was within {bp.NEAR_THRESHOLD:g} frame widths "
                    f"of identity {other} for {seconds:g} s"
                ),
                attributes={
                    "withIdentityId": other,
                    "seconds": seconds,
                    # The number the sentence quotes, machine-readable. A proximity fact whose
                    # threshold a reader has to guess is a fact they cannot check.
                    "thresholdNormalized": bp.NEAR_THRESHOLD,
                },
                evidence=_evidence(_point_at(points, overlap[0])),
            )

    subjects = {identity: list(points) for identity, points in context.subjects.items()}
    for identity, points in sorted(context.objects.items()):
        spans = bp.associations(points, subjects)
        for span in spans:
            emit(
                "carried",
                identity,
                span.interval.start_seconds,
                end_seconds=span.interval.end_seconds,
                summary=(
                    f"object {identity} travelled with identity {span.subject_identity} from "
                    f"{since(span.interval.start_seconds):g} s to "
                    f"{since(span.interval.end_seconds):g} s"
                    + (" and had not been put down" if span.open_ended else "")
                ),
                attributes={
                    "heldByIdentityId": span.subject_identity,
                    "seconds": span.interval.seconds,
                    "open": span.open_ended,
                },
                evidence=_evidence(_point_at(points, span.interval.start_seconds)),
            )
        for at_seconds, giver, taker in bp.handovers(spans):
            emit(
                "handover",
                identity,
                at_seconds,
                summary=(
                    f"object {identity} passed from identity {giver} to identity {taker} "
                    f"at {since(at_seconds):g} s"
                ),
                attributes={"fromIdentityId": giver, "toIdentityId": taker},
                evidence=_evidence(_point_at(points, at_seconds)),
            )

    entries.sort(key=lambda e: (e.at_seconds, e.kind, e.identity_id, str(e.attributes)))
    truncated = len(entries) > max_entries
    return entries[:max_entries], truncated


# --- helpers -------------------------------------------------------------------------------------


def _evidence(point: Optional[bp.TrackPoint]) -> Dict[str, object]:
    if point is None:
        return {}
    return {"frameIndex": point.frame_index, "trackId": point.track_id}


def _point_at(points: Sequence[bp.TrackPoint], seconds: float) -> Optional[bp.TrackPoint]:
    """The observation at or immediately before a moment — what an investigator should be shown.

    ⚠️ Not the nearest in either direction. A fact that began at 12.0 s is evidenced by the frame
    that *established* it, and a viewer sent forwards to 12.5 s would be shown the consequence.
    """
    match: Optional[bp.TrackPoint] = None
    for point in points:
        if point.at_seconds <= seconds + 1e-9:
            match = point
        else:
            break
    return match if match is not None else (points[0] if points else None)


def _overlap(
    a: Sequence[bp.TrackPoint], b: Sequence[bp.TrackPoint]
) -> Optional[Tuple[float, float]]:
    """The footage-time window in which two identities were both observed, or `None`."""
    if not a or not b:
        return None
    start = max(a[0].at_seconds, b[0].at_seconds)
    end = min(a[-1].at_seconds, b[-1].at_seconds)
    return None if end < start else (start, end)
