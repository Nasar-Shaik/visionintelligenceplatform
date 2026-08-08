"""The behaviour stage (P-11 slice 2.2) — Layer 2 on the live frame path, in the seam that existed.

    ConfidencePostprocessor ─▶ StageChain[ RuntimeTracker ─▶ BehaviourStage ] ─▶ DefaultResultTranslator

### ⭐ Not a new pipeline stage, and the distinction is load-bearing

`pipeline.Tracker` is a structural Protocol — `run(detections, ctx) -> List[Detection]` — and this
class implements exactly it. `StageChain` composes two of them into the one slot `CapabilityRuntime`
already has, so nothing above or below changes: no new stage, no second inference path, no new
configuration channel, and the frozen `DetectionResult` gains no field. The standing guardrail *"AI
Runtime Architecture v1.0 is frozen — no new architectural layers, no new pipeline stages"* is held
literally rather than argued around.

### ⚠️ It runs on both paths because there is only one

Live webcam frames and uploaded-recording frames both reach the runtime through `POST /infer` —
`services/media/src/adapters/http-frame-sink.ts` is the platform's single `/infer` caller, enforced
by `tools/contracts/perception-boundary.mjs` §A. A stage in this position therefore executes for
both, with no duplicated code and nothing detector-specific: it never sees a model, a tensor or a
class id, only tracked identities.

### ⛔ Zone membership arrives as an observation, and its absence is still reported

Zones are resolved once, downstream, in media — an argued decision (`zone-resolver.ts`) that keeps
polygon geometry out of perception, and there is still exactly one point-in-polygon engine in the
platform. Membership comes back to this stage on the **next** frame's request
(`FrameContext.zone_membership`, ADR-0053) or, for a caller that already holds the geometry, stamped
directly onto `Detection.attributes["zoneIds"]`. When neither happens, `ZoneModule` emits **nothing**
and `stats()["zoneMembership"]` reads `"absent"`, because a 0.0 s dwell for every subject is what an
unconfigured deployment and an empty shop both look like.

### ⭐ Frame-level facts leave on the frame (ADR-0054)

Occupancy and handover are statements about a scene, not about a rectangle, so they are appended to
`FrameContext.scene` and drained by the result translator onto `DetectionResult.scene`. No new stage
and no new protocol argument: the context was already threaded through every stage *and* the
translator, so the carrier existed for the same reason the seam did.

Stdlib-only. Deterministic given its inputs — the clock is injected and used only for timing.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import behaviour_primitives as bp
from behaviour_modules import (
    ATTR_BEHAVIOUR,
    DEFAULT_MODULES,
    TASK_BEHAVIOUR,
    ZONE_ATTRIBUTE,
    BehaviourContext,
)
from contracts import Detection, FrameContext
from perception_registry import ModuleUnavailable, PerceptionRegistry
from track_history import TrackHistoryRecorder

#: Frames of scene-level labels retained per stream for the read API. Bounded like everything else
#: here: a runtime up for a month must cost what one up for a minute costs.
MAX_SNAPSHOT_FRAMES = 32

#: Smoothing on the observed frame interval. ⚠️ Derived from timestamps rather than from a configured
#: fps — the two disagree the moment a camera drops frames, and this is the one that was true.
_INTERVAL_ALPHA = 0.3

#: Labels treated as subjects. Everything else is a thing that gets carried.
DEFAULT_SUBJECT_LABELS: Tuple[str, ...] = ("person",)


class BehaviourStage:
    """Runs the registered behaviour modules over track history and stamps the result on detections."""

    def __init__(
        self,
        *,
        recorder: TrackHistoryRecorder,
        registry: Optional[PerceptionRegistry] = None,
        modules: Optional[Sequence[str]] = None,
        zones: Optional[Dict[str, Sequence[bp.ZoneRegion]]] = None,
        subject_labels: Sequence[str] = DEFAULT_SUBJECT_LABELS,
        enabled: bool = True,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        from behaviour_modules import default_behaviour_registry  # noqa: WPS433 - avoids a cycle

        self._recorder = recorder
        self._registry = registry if registry is not None else default_behaviour_registry()
        self._names = list(modules) if modules is not None else [name for name, _ in DEFAULT_MODULES]
        #: camera_id → zones. ⚠️ Only ever populated by a caller that already holds the geometry (the
        #: batch analyzer). The live path holds none, which is why `MembershipZone` exists.
        self._zones = dict(zones or {})
        self._subject_labels = frozenset(subject_labels)
        self._enabled = enabled
        self._clock = clock
        self._lock = threading.RLock()
        self._modules = self._build()
        #: stream key → smoothed footage-time interval between frames.
        self._interval: Dict[Tuple[str, str, Optional[str]], float] = {}
        self._last_at: Dict[Tuple[str, str, Optional[str]], float] = {}
        #: stream key → recent scene-level labels. See the module docstring on why they do not ride
        #: the frozen `DetectionResult`.
        self._snapshots: Dict[Tuple[str, str, Optional[str]], List[dict]] = {}
        #: Streams that have EVER carried zone membership.
        #:
        #: ⛔ Not "did this frame carry membership", which is the bug this replaced. A subject who
        #: steps out of every zone produces a frame with no membership at all, and keying presence
        #: off the current frame made every zone fact — including the `left` transition that had just
        #: happened — disappear on exactly the frame that mattered.
        self._zone_streams: set = set()
        #: Streams whose membership arrives by echo (ADR-0053). ⛔ On those, the
        #: `Detection.attributes["zoneIds"]` path is ignored — see `_apply_membership`.
        self._echo_streams: set = set()
        self._frames = 0
        self._subjects_stamped = 0
        self._zone_frames = 0
        #: Memberships attached to the history point they described, and those with no such point.
        #: ⚠️ The pair, not a ratio: an echo whose frame was dropped, trimmed or retired is a real and
        #: expected outcome, and the two counts together are the only way to tell a working stream
        #: with a lossy queue from a broken join.
        self._zone_applied = 0
        self._zone_missed = 0
        #: Scene observations put on the frame, and those the per-frame cap refused.
        self._scene_emitted = 0
        self._scene_dropped = 0
        self._elapsed_ms = 0.0
        self._failures: Dict[str, int] = {}

    # --- the pipeline stage ------------------------------------------------------

    def run(self, detections: List[Detection], ctx: FrameContext) -> List[Detection]:
        """Stamp `attributes["behaviour"]` onto every detection whose identity has history.

        ⚠️ Returns the detections **unchanged** when nothing can be said. A behaviour key present on
        every detection with empty contents would be indistinguishable from a subject about whom
        there is genuinely nothing to report.
        """
        if not self._enabled or not self._modules:
            return detections
        started = self._clock()
        key = (ctx.tenant_id, ctx.camera_id, ctx.correlation_id)

        applied, missed, membership_seen = self._apply_membership(detections, ctx, key)
        if membership_seen:
            with self._lock:
                self._zone_streams.add(key)
        at_seconds = self._advance(key)
        context = self._context(ctx, at_seconds=at_seconds, key=key)

        payloads: Dict[str, Dict[str, object]] = {}
        labels: List[dict] = []
        for name, module in self._modules:
            try:
                output = module.analyse(module.preprocess(context))
            except Exception as exc:  # noqa: BLE001 - one bad primitive must not fail the frame
                self._note_failure(name, exc)
                continue
            for instance in output.instances:
                identity = instance.attributes.get("identityId")
                if not isinstance(identity, str):
                    continue
                bucket = payloads.setdefault(identity, {})
                for attribute, value in instance.attributes.items():
                    if attribute != "identityId":
                        bucket[attribute] = value
            labels.extend(label.to_scene_observation() for label in output.frame_labels)

        stamped = _stamp(detections, payloads)
        #: ⭐ The scene carrier (ADR-0054) — appended to the context, drained by the translator onto
        #: `DetectionResult.scene`. Outside the lock: `ctx` belongs to exactly one frame on exactly
        #: one thread, so it needs no protection this class could give it.
        kept = ctx.observe_scene(labels) if labels else 0
        with self._lock:
            self._frames += 1
            self._subjects_stamped += sum(1 for d in stamped if ATTR_BEHAVIOUR in d.attributes)
            self._zone_applied += applied
            self._zone_missed += missed
            self._scene_emitted += kept
            self._scene_dropped += len(labels) - kept
            if membership_seen:
                self._zone_frames += 1
            if labels:
                snapshot = self._snapshots.setdefault(key, [])
                snapshot.append({"frameIndex": ctx.frame_number, "at": ctx.timestamp, "scene": labels})
                while len(snapshot) > MAX_SNAPSHOT_FRAMES:
                    snapshot.pop(0)
            self._elapsed_ms += (self._clock() - started) * 1000.0
        return stamped

    # --- zone membership ----------------------------------------------------------

    def _apply_membership(
        self,
        detections: Sequence[Detection],
        ctx: FrameContext,
        key: Tuple[str, str, Optional[str]],
    ) -> Tuple[int, int, bool]:
        """Attach whatever zone membership reached this frame, from either channel.

        ⭐ **Two channels, one meaning** (ADR-0053). `ctx.zone_membership` is media echoing back what
        it resolved for a frame the runtime already answered — the product path, and the only one a
        deployment uses. `Detection.attributes["zoneIds"]` is membership an upstream stamped on the
        detections themselves, which is what a caller holding the geometry (the batch analyzer, a
        test) does. Neither is preferred: both are the same statement about the same subject, and a
        precedence rule between them would be a rule about which upstream to believe.

        ⛔ **Both settle a whole frame, and neither settles a subject.** The echo names the frame it
        describes; the attribute path is the frame in hand. In each case the arrival decides every
        subject observed on that frame — named ones were inside the zones given, and the rest were
        inside none. Deciding subject-by-subject would leave the unnamed ones undecided for ever, and
        an undecided point read as "outside" ends a zone visit that never ended.

        ⛔ **They are mutually exclusive per stream, and that was found by a test rather than
        reasoned out.** On the echo channel a detection never carries `zoneIds`, so the attribute path
        read every current frame as "inside no zone" — settling it *outside* one frame before the echo
        arrived to say the subject was inside. The result was an `entered`/`left` pair on every single
        frame for someone standing still. Once a stream has spoken through the echo, the attribute
        path is ignored for it entirely: two upstreams answering one question is not something to
        merge, it is something to pick.
        """
        applied = 0
        missed = 0
        seen = False
        echo = ctx.zone_membership
        if echo is not None:
            seen = True
            with self._lock:
                self._echo_streams.add(key)
            settled, unmatched = self._recorder.settle_zones(
                tenant_id=ctx.tenant_id,
                camera_id=ctx.camera_id,
                stream_id=ctx.correlation_id,
                frame_index=echo.frame_seq,
                memberships={s.identity_id: s.zone_ids for s in echo.subjects},
                zone_version=echo.zone_version,
            )
            applied += settled
            missed += unmatched
        with self._lock:
            on_echo = key in self._echo_streams
        if on_echo:
            return applied, missed, seen
        direct, stamped = _membership_of(detections)
        # ⛔ Settle on the direct path when this frame carried zones, OR when an earlier frame of
        # this stream did. `zone-resolver.ts` omits the key for a subject inside no zone, so a frame
        # where everybody has stepped outside carries nothing at all — indistinguishable, on its own,
        # from a deployment that never resolves zones. Remembering that the stream has stamped before
        # is what makes the *exit* frame settleable, and without it every visit stayed open for ever
        # and no `left` transition was ever emitted.
        if stamped or (direct and key in self._zone_streams):
            seen = True
            settled, unmatched = self._recorder.settle_zones(
                tenant_id=ctx.tenant_id,
                camera_id=ctx.camera_id,
                stream_id=ctx.correlation_id,
                frame_index=ctx.frame_number,
                memberships=direct,
            )
            applied += settled
            missed += unmatched
        return applied, missed, seen

    # --- context assembly ---------------------------------------------------------

    def _context(
        self,
        ctx: FrameContext,
        *,
        at_seconds: float,
        key: Tuple[str, str, Optional[str]],
    ) -> BehaviourContext:
        subjects: Dict[str, List[bp.TrackPoint]] = {}
        objects: Dict[str, List[bp.TrackPoint]] = {}
        zone_ids: set = set()
        for record in self._recorder.live_records(ctx.tenant_id, ctx.camera_id, ctx.correlation_id):
            points: List[bp.TrackPoint] = []
            for point in record.points:
                seconds = point.at_seconds
                if seconds is None:
                    continue
                # ⚠️ Only settled points contribute zone ids. An unsettled one carries none anyway,
                # but reading it here would make the zone SET depend on arrival order rather than on
                # what was observed.
                if point.zones_settled:
                    zone_ids.update(point.zone_ids)
                points.append(
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
            if not points:
                continue
            target = subjects if record.label in self._subject_labels else objects
            target[record.identity_id] = points

        configured = self._zones.get(ctx.camera_id)
        zones: Sequence[bp.ZoneRegion]
        if configured:
            zones = configured
        else:
            zones = tuple(bp.MembershipZone(zone_id) for zone_id in sorted(zone_ids))

        return BehaviourContext(
            tenant_id=ctx.tenant_id,
            camera_id=ctx.camera_id,
            stream_id=ctx.correlation_id,
            frame_index=ctx.frame_number,
            at_seconds=at_seconds,
            subjects=subjects,
            objects=objects,
            zones=zones,
            expected_interval_seconds=self._interval.get(key, 0.0),
            zone_membership_present=key in self._zone_streams,
        )

    def _advance(self, key: Tuple[str, str, Optional[str]]) -> float:
        """Track footage time and the observed interval between frames, per stream.

        ⚠️ Read off the history rather than off `FrameContext.timestamp`, because the recorder has
        already refused anything it could not parse. Two places deciding what "now" means is how a
        duration comes to depend on which one was asked.
        """
        latest: Optional[float] = None
        for record in self._recorder.live_records(key[0], key[1], key[2]):
            last = record.last_seconds
            if last is not None and (latest is None or last > latest):
                latest = last
        if latest is None:
            return 0.0
        with self._lock:
            previous = self._last_at.get(key)
            if previous is not None and latest > previous:
                delta = latest - previous
                current = self._interval.get(key)
                self._interval[key] = delta if current is None else (
                    _INTERVAL_ALPHA * delta + (1 - _INTERVAL_ALPHA) * current
                )
            self._last_at[key] = latest
        return latest

    # --- reads --------------------------------------------------------------------

    def scene_labels(self, tenant_id: str, camera_id: str, stream_id: Optional[str] = None) -> List[dict]:
        """The most recent frames' scene observations for one stream — a **debugging** read.

        ⚠️ Bounded to `MAX_SNAPSHOT_FRAMES` and lost on restart, which is what makes it a debugging
        read and not the carrier. The carrier is `DetectionResult.scene` (ADR-0054); the durable
        answer for a whole analysis is recomputed from track history by `behaviour_timeline`. Three
        views, one substrate — and when the live view and the recomputed one disagree, the recomputed
        one is right, because it saw more than 32 frames.
        """
        with self._lock:
            return list(self._snapshots.get((tenant_id, camera_id, stream_id), []))

    def forget_tenant(self, tenant_id: str) -> int:
        """Drop every cached scene label for a tenant. Erasure covers derived reads too."""
        with self._lock:
            keys = [k for k in self._snapshots if k[0] == tenant_id]
            for key in keys:
                del self._snapshots[key]
            for holder in (self._interval, self._last_at):
                for key in [k for k in holder if k[0] == tenant_id]:
                    del holder[key]
            self._zone_streams = {k for k in self._zone_streams if k[0] != tenant_id}
            self._echo_streams = {k for k in self._echo_streams if k[0] != tenant_id}
        return len(keys)

    def describe(self) -> dict:
        return {"task": TASK_BEHAVIOUR, "modules": [name for name, _ in self._modules]}

    def stats(self) -> dict:
        with self._lock:
            frames = self._frames
            return {
                "enabled": self._enabled,
                "modules": [name for name, _ in self._modules],
                "frames": frames,
                "subjectsStamped": self._subjects_stamped,
                "averageMs": round(self._elapsed_ms / frames, 4) if frames else 0.0,
                # ⛔ Three-valued on purpose. "absent" is not "none found" — it says no upstream ever
                # supplied membership, so every zone primitive was inert and no dwell was computed.
                "zoneMembership": (
                    "unobserved" if frames == 0 else ("present" if self._zone_frames else "absent")
                ),
                "zoneFrames": self._zone_frames,
                "zoneAnnotationsApplied": self._zone_applied,
                # ⚠️ Expected to be small and non-zero on a live camera: the last frame of every
                # stream has no successor to carry its echo (ADR-0053 decision 3), and a dropped
                # frame drops its membership. A *large* number beside a small applied count is the
                # reading that means the join is broken.
                "zoneAnnotationsMissed": self._zone_missed,
                "sceneObservations": self._scene_emitted,
                "sceneObservationsDropped": self._scene_dropped,
                "moduleFailures": dict(self._failures),
            }

    # --- construction -------------------------------------------------------------

    def _build(self) -> List[Tuple[str, object]]:
        built: List[Tuple[str, object]] = []
        for name in self._names:
            try:
                module = self._registry.create(TASK_BEHAVIOUR, name)
            except ModuleUnavailable:
                self._note_failure(name, ModuleUnavailable(name))
                continue
            module.load({})
            built.append((name, module))
        return built

    def _note_failure(self, name: str, exc: BaseException) -> None:
        with self._lock:
            self._failures[name] = self._failures.get(name, 0) + 1


def _membership_of(
    detections: Sequence[Detection],
) -> Tuple[Dict[str, Tuple[str, ...]], bool]:
    """`(identity → zones, did anything on this frame carry membership)`.

    ⛔ The mapping covers **every identified detection**, with an empty tuple for one inside no zone,
    because `zone-resolver.ts` omits the key rather than writing an empty array. So a subject with no
    attribute is *outside every zone* — provided something resolved the frame at all, which is the
    second half of the return and the caller's decision to make.
    """
    out: Dict[str, Tuple[str, ...]] = {}
    stamped = False
    for detection in detections:
        identity = detection.identity_id
        if identity is None:
            continue
        raw = detection.attributes.get(ZONE_ATTRIBUTE)
        if isinstance(raw, (list, tuple)):
            zones = tuple(str(z) for z in raw if isinstance(z, (str, int)))
            if zones:
                stamped = True
                out[identity] = zones
                continue
        out[identity] = ()
    return out, stamped


def _stamp(detections: Sequence[Detection], payloads: Dict[str, Dict[str, object]]) -> List[Detection]:
    """Rebuild each detection carrying its identity's behaviour payload.

    ⚠️ `Detection` is frozen, so this copies rather than mutates — the same discipline
    `RuntimeTracker._stamp` follows, and for the same reason: what the model saw is a record, and a
    later opinion about it is an addition rather than a correction.
    """
    if not payloads:
        return list(detections)
    from dataclasses import replace  # noqa: WPS433 - local, one call site

    out: List[Detection] = []
    for detection in detections:
        payload = payloads.get(detection.identity_id) if detection.identity_id else None
        if not payload:
            out.append(detection)
            continue
        attributes = dict(detection.attributes)
        attributes[ATTR_BEHAVIOUR] = payload
        out.append(replace(detection, attributes=attributes))
    return out
