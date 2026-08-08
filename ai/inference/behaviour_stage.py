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

### ⛔ Zone membership is reported present-or-absent, never assumed

Zones are resolved once, downstream, in media — an argued decision (`zone-resolver.ts`) that keeps
polygon geometry out of perception. Membership reaches this stage only when an upstream stamped it
into `Detection.attributes["zoneIds"]`. When nothing did, `ZoneModule` emits **nothing** and
`stats()["zoneMembership"]` reads `"absent"`, because a 0.0 s dwell for every subject is what an
unconfigured deployment and an empty shop both look like.

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
        self._frames = 0
        self._subjects_stamped = 0
        self._zone_frames = 0
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

        membership = _membership_of(detections)
        if membership:
            with self._lock:
                self._zone_streams.add(key)
        for identity, zones in membership.items():
            self._recorder.annotate_zones(
                tenant_id=ctx.tenant_id,
                camera_id=ctx.camera_id,
                stream_id=ctx.correlation_id,
                identity_id=identity,
                zone_ids=zones,
            )
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
            labels.extend(label.to_dict() for label in output.frame_labels)

        stamped = _stamp(detections, payloads)
        with self._lock:
            self._frames += 1
            self._subjects_stamped += sum(1 for d in stamped if ATTR_BEHAVIOUR in d.attributes)
            if membership:
                self._zone_frames += 1
            if labels:
                snapshot = self._snapshots.setdefault(key, [])
                snapshot.append({"frameIndex": ctx.frame_number, "at": ctx.timestamp, "labels": labels})
                while len(snapshot) > MAX_SNAPSHOT_FRAMES:
                    snapshot.pop(0)
            self._elapsed_ms += (self._clock() - started) * 1000.0
        return stamped

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
        """Recent scene-level statements for one stream.

        ⚠️ **These do not ride the frozen `DetectionResult`**, which has no frame-level open map —
        only `Detection.attributes`, which is per subject. That is a real finding from this slice and
        it is recorded rather than worked around: occupancy and handover are statements about a scene,
        and today they leave the runtime through this read rather than through an event.
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


def _membership_of(detections: Sequence[Detection]) -> Dict[str, Tuple[str, ...]]:
    """Identity → the zones an upstream said it was inside, off `Detection.attributes["zoneIds"]`."""
    out: Dict[str, Tuple[str, ...]] = {}
    for detection in detections:
        identity = detection.identity_id
        raw = detection.attributes.get(ZONE_ATTRIBUTE)
        if identity is None or not isinstance(raw, (list, tuple)):
            continue
        zones = tuple(str(z) for z in raw if isinstance(z, (str, int)))
        if zones:
            out[identity] = zones
    return out


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
