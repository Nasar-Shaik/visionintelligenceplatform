"""Python mirror of the @vip/contracts perception schemas + the runtime's request/lifecycle value
objects. The TS package is the source of truth; these dataclasses produce dicts with the SAME
camelCase field names as `detection` / `detection-result` (parity asserted in tests). Stdlib-only.

Contains: FrameContext (#3), Detection/ModelBinding/DetectionResult (#4/#7 — generic + versioned),
and CapabilityState (#5). See docs/architecture/phase1/AI_PIPELINE.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from errors import ContextRequired


class CapabilityState(str, Enum):
    """Lifecycle state a capability exposes (richer than a boolean) — #5."""

    LOADING = "LOADING"
    READY = "READY"
    FAILED = "FAILED"
    DISABLED = "DISABLED"
    UNAVAILABLE = "UNAVAILABLE"


#: How many scene observations one frame may carry. ⚠️ Mirrors `MAX_SCENE_OBSERVATIONS` in
#: `packages/contracts/src/perception/perception.ts`. Bounded because this rides a frozen contract
#: onto a broker: a stage bug must produce a truncated document, never an unbounded publish.
MAX_SCENE_OBSERVATIONS = 64

#: How many subjects one zone-membership echo may describe (ADR-0053). Mirrors the contract's cap.
MAX_ZONE_ECHO_SUBJECTS = 64


@dataclass(frozen=True)
class ZoneObservation:
    """One subject, and the zones an upstream found it inside on one frame (ADR-0053)."""

    identity_id: str
    zone_ids: Tuple[str, ...]


@dataclass(frozen=True)
class ZoneMembership:
    """⭐ **One frame's zone membership, decided** (ADR-0053).

    An observation, not configuration: it names zones the runtime has no opinion about and never
    carries a polygon, which is what keeps exactly one point-in-polygon engine in the platform.

    ⛔ **It settles a FRAME, not a subject.** Its arrival says every subject on `frame_seq` has been
    decided — those in `subjects` were inside the zones named, and every other subject observed on
    that frame was inside none. An empty `subjects` is therefore a real answer, and the reason
    "nobody was in a zone" can be told apart from "the membership never arrived".

    ⚠️ `frame_seq` is the frame this DESCRIBES, not the frame that carried it. With more than one
    request in flight per camera the two differ, and attaching an echo to whichever history point is
    newest would give one frame's zones to another.
    """

    frame_seq: int
    #: Which polygon set answered — `AssignmentPlanEntry.zoneVersion`. Stored with the membership so
    #: an archive can say which geometry produced it (ADR-0053, amending ADR-0051).
    zone_version: int = 0
    subjects: Tuple[ZoneObservation, ...] = ()


@dataclass(frozen=True)
class FrameContext:
    """Everything a capability needs about one frame — never a bare image (#3). Carries the full
    request context so detections/events/logs correlate across cameras, tenants, and time."""

    tenant_id: str
    camera_id: str
    image: bytes
    principal_id: Optional[str] = None
    organization_id: Optional[str] = None
    stream_id: Optional[str] = None
    frame_number: int = 0
    timestamp: Optional[str] = None
    fps: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    source: Optional[str] = None
    correlation_id: Optional[str] = None
    #: Zone membership for an EARLIER frame, carried back by the caller (ADR-0053). `None` on the
    #: first frame of a stream, on any frame whose predecessor was dropped, and wherever no zones
    #: are drawn — three different reasons that all mean "nothing has been settled yet".
    zone_membership: Optional[ZoneMembership] = None
    #: ⭐ **The frame-level carrier** (ADR-0054). Stages append `SceneObservation` dicts; the result
    #: translator drains it onto `DetectionResult.scene`.
    #:
    #: ⚠️ Mutable, on a frozen dataclass, deliberately. A `FrameContext` is built once per `/infer`
    #: request and threaded through every stage *and* the translator, so a collector on it is exactly
    #: frame-scoped — no side channel, no protocol change, and no way for two frames to share one. It
    #: is bounded by `MAX_SCENE_OBSERVATIONS` at the point of append, not here.
    scene: List[dict] = field(default_factory=list)

    def observe_scene(self, observations: Sequence[Mapping[str, object]]) -> int:
        """Append frame-level statements, bounded. Returns how many were kept.

        ⚠️ Silently truncates rather than raising: a stage that produced 200 occupancy statements has
        a bug, and failing the frame would turn that bug into missing perception. The shortfall is
        visible as a count the caller can report.
        """
        room = MAX_SCENE_OBSERVATIONS - len(self.scene)
        if room <= 0:
            return 0
        kept = [dict(o) for o in observations[:room]]
        self.scene.extend(kept)
        return len(kept)

    @staticmethod
    def from_request(body: Mapping[str, object]) -> "FrameContext":
        """Build a FrameContext from an InferenceRequest-shaped dict, fail-closed on missing tenant."""
        context = body.get("context")
        if not isinstance(context, dict):
            raise ContextRequired("a tenant context is required")
        tenant_id = context.get("tenantId")
        if not isinstance(tenant_id, str) or tenant_id.strip() == "":
            raise ContextRequired("context.tenantId is required")

        frame = body.get("frame") if isinstance(body.get("frame"), dict) else {}
        image = _decode_image(body.get("imageBase64"))
        return FrameContext(
            tenant_id=tenant_id,
            principal_id=_opt_str(context.get("principalId")),
            camera_id=str(frame.get("cameraId", "")),
            organization_id=_opt_str(frame.get("organizationId")),
            stream_id=_opt_str(frame.get("streamId")),
            frame_number=int(frame.get("seq", 0)),
            timestamp=_opt_str(frame.get("capturedAt")),
            fps=_opt_float(frame.get("fps")),
            width=_opt_int(frame.get("width")),
            height=_opt_int(frame.get("height")),
            source=_opt_str(frame.get("source")),
            correlation_id=_opt_str(frame.get("correlationId")),
            zone_membership=_zone_membership(frame.get("zoneMembership")),
            image=image,
        )


@dataclass(frozen=True)
class Detection:
    """A model-INDEPENDENT detection (#4): bbox + label + confidence, plus optional generic
    attributes / embedding / metadata / trackingId. No YOLO/vendor fields."""

    label: str
    confidence: float
    bbox: Tuple[float, float, float, float]
    class_id: Optional[int] = None
    attributes: Dict[str, object] = field(default_factory=dict)
    embedding: Optional[Sequence[float]] = None
    metadata: Dict[str, object] = field(default_factory=dict)
    tracking_id: Optional[str] = None
    detection_id: Optional[str] = None
    #: Identity across gaps the tracker bridged (P-8 Phase 5, additive — ADR-0041).
    #:
    #: ⚠️ NOT the same question as `tracking_id`, and picking the wrong one fails silently. A person
    #: briefly occluded returns with a NEW tracking_id (ADR-0038 forbids reuse), so anything that
    #: ACCUMULATES over time must group by identity_id or it sees two short visits instead of one
    #: long one. Equal to tracking_id on a first appearance.
    identity_id: Optional[str] = None
    preceded_by: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {
            "label": self.label,
            "confidence": round(float(self.confidence), 6),
            "bbox": [round(float(v), 6) for v in self.bbox],
            "attributes": dict(self.attributes),
            "metadata": dict(self.metadata),
        }
        if self.detection_id is not None:
            out["detectionId"] = self.detection_id
        if self.class_id is not None:
            out["classId"] = int(self.class_id)
        if self.embedding is not None:
            out["embedding"] = [float(v) for v in self.embedding]
        if self.tracking_id is not None:
            out["trackingId"] = self.tracking_id
        if self.identity_id is not None:
            out["identityId"] = self.identity_id
        if self.preceded_by is not None:
            out["precededBy"] = self.preceded_by
        return out


@dataclass(frozen=True)
class ModelBinding:
    """The concrete model resolved by selector (provenance)."""

    name: str
    version: str
    task: str
    family: str = "*"
    accelerator: str = "cpu"
    id: Optional[str] = None

    def to_dict(self) -> dict:
        out = {
            "name": self.name,
            "version": self.version,
            "task": self.task,
            "family": self.family,
            "accelerator": self.accelerator,
        }
        if self.id is not None:
            out["id"] = self.id
        return out


#: The version of the `DetectionResult` SHAPE. ⚠️ Mirrors `DETECTION_RESULT_SCHEMA_VERSION` in
#: `packages/contracts/src/perception/perception.ts`, which is the source of truth; a test asserts
#: the two agree, because a schema version that drifts is worse than none at all.
#:
#: Distinct from runtimeVersion / capabilityVersion / model.version: those say *what produced* the
#: result, this says **how to read it** — the question a consumer holding an archived document three
#: years from now cannot answer from any of the others.
#:
#: `1.2` adds `scene` (ADR-0054) — the first statement this contract can make about a frame rather
#: than about a rectangle in it.
DETECTION_RESULT_SCHEMA_VERSION = "1.2"


@dataclass(frozen=True)
class DetectionResult:
    """Tenant-tagged, fully version-stamped inference result (#7). The capability persists none of it.

    ⚠️ Carries everything needed to REPRODUCE the inference later: the model (id + version + family),
    the execution provider that ran it, the frame's capture time and sequence, the measured
    latencies, and the schema version of this document.
    """

    tenant_id: str
    camera_id: str
    capability_id: str
    capability_version: str
    runtime_version: str
    execution_provider: str
    model: ModelBinding
    frame_seq: int
    frame_captured_at: str
    inference_ms: float
    at: str
    detections: List[Detection] = field(default_factory=list)
    correlation_id: Optional[str] = None
    frame_latency_ms: Optional[float] = None
    preprocessing_version: Optional[str] = None
    confidence_threshold: Optional[float] = None
    #: ⭐ Frame-level facts (ADR-0054). ⚠️ Serialised only when non-empty: an empty array and a
    #: missing key would be a third state meaning the same thing.
    scene: List[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        out = {
            "schemaVersion": DETECTION_RESULT_SCHEMA_VERSION,
            "tenantId": self.tenant_id,
            "cameraId": self.camera_id,
            "capabilityId": self.capability_id,
            "capabilityVersion": self.capability_version,
            "runtimeVersion": self.runtime_version,
            "executionProvider": self.execution_provider,
            "model": self.model.to_dict(),
            "frame": {"seq": int(self.frame_seq), "capturedAt": self.frame_captured_at},
            "detections": [d.to_dict() for d in self.detections],
            "inferenceMs": round(float(self.inference_ms), 3),
            "at": self.at,
        }
        if self.correlation_id is not None:
            out["correlationId"] = self.correlation_id
        if self.frame_latency_ms is not None:
            out["frameLatencyMs"] = round(float(self.frame_latency_ms), 3)
        if self.preprocessing_version is not None:
            out["preprocessingVersion"] = self.preprocessing_version
        if self.confidence_threshold is not None:
            out["confidenceThreshold"] = round(float(self.confidence_threshold), 4)
        if self.scene:
            out["scene"] = [dict(o) for o in self.scene[:MAX_SCENE_OBSERVATIONS]]
        return out


def detection_id(
    tenant_id: str, camera_id: str, captured_at: str, seq: int, model: str, index: int
) -> str:
    """A stable id for one detection (P-8 Phase 3).

    ⚠️ **Derived, never random.** Reprocessing the same frame with the same model must produce the
    same identifiers — on a platform whose outputs become evidence, an id that changes on replay is
    an id that cannot be cited.

    ⚠️ **The model is part of the identity, and that was found by running it.** The first version
    seeded only frame identity + index, so the same frame decoded by two different models produced
    the *same* ids for entirely different detections — `det_2be1…` meant "the person on the left"
    under one model and "the car on the right" under the other. An id that survives a model change
    is worse than no id, because it invites exactly the comparison it cannot support.

    Deliberately NOT seeded with the detection's own geometry or score: those are floats from a
    numeric kernel, and an id that shifts because a different CPU produced a different last bit is
    not stable. Ordering is stable instead — decoders return detections highest-confidence first —
    so `index` means "the Nth most confident detection of this frame under this model".

    Truncated to 20 hex characters: unique among one deployment's detections, short enough to read
    in a log line.
    """
    import hashlib

    seed = f"{tenant_id}|{camera_id}|{captured_at}|{seq}|{model}|{index}".encode("utf-8")
    return "det_" + hashlib.sha256(seed).hexdigest()[:20]


def _decode_image(image_base64: Optional[object]) -> bytes:
    import base64
    import binascii

    if not isinstance(image_base64, str) or image_base64 == "":
        from errors import InferenceError

        raise InferenceError("imageBase64 is required")
    try:
        return base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        from errors import InferenceError

        raise InferenceError(f"invalid base64 image: {exc}") from exc


def _zone_membership(raw: object) -> Optional[ZoneMembership]:
    """Parse `frame.zoneMembership` (ADR-0053), defensively.

    ⚠️ Every field is validated rather than trusted. This crossed a service boundary to get here, and
    a malformed `zoneId` accepted at this point becomes a dwell interval, then a rule's scope, then an
    incident's evidence. Anything unreadable yields `None` — which the stage reports as absent —
    rather than a partial membership nobody can tell from a complete one.

    ⚠️ An echo with **no** subjects parses to a `ZoneMembership` with none, not to `None`. Those are
    the two answers this function exists to keep apart: "the frame was decided and nobody was inside a
    zone" against "nothing decided the frame".
    """
    if not isinstance(raw, dict):
        return None
    seq = raw.get("frameSeq")
    if not isinstance(seq, (int, float)) or isinstance(seq, bool) or seq < 0:
        return None
    subjects = raw.get("subjects")
    if not isinstance(subjects, (list, tuple)):
        return None
    version = raw.get("zoneVersion")
    out: List[ZoneObservation] = []
    for entry in subjects[:MAX_ZONE_ECHO_SUBJECTS]:
        if not isinstance(entry, dict):
            continue
        identity = _opt_str(entry.get("identityId"))
        zones = entry.get("zoneIds")
        if identity is None or not isinstance(zones, (list, tuple)):
            continue
        zone_ids = tuple(z for z in zones if isinstance(z, str) and z != "")
        if not zone_ids:
            continue
        out.append(ZoneObservation(identity_id=identity, zone_ids=zone_ids))
    return ZoneMembership(
        frame_seq=int(seq),
        zone_version=int(version) if isinstance(version, (int, float)) and not isinstance(version, bool) else 0,
        subjects=tuple(out),
    )


def _opt_str(v: object) -> Optional[str]:
    return v if isinstance(v, str) and v != "" else None


def _opt_int(v: object) -> Optional[int]:
    return int(v) if isinstance(v, (int, float)) else None


def _opt_float(v: object) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) else None
