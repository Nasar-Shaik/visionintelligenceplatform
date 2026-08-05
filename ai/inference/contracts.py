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
DETECTION_RESULT_SCHEMA_VERSION = "1.1"


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


def _opt_str(v: object) -> Optional[str]:
    return v if isinstance(v, str) and v != "" else None


def _opt_int(v: object) -> Optional[int]:
    return int(v) if isinstance(v, (int, float)) else None


def _opt_float(v: object) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) else None
