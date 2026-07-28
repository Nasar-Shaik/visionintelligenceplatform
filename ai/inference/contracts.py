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

    def to_dict(self) -> dict:
        out: dict = {
            "label": self.label,
            "confidence": round(float(self.confidence), 6),
            "bbox": [round(float(v), 6) for v in self.bbox],
            "attributes": dict(self.attributes),
            "metadata": dict(self.metadata),
        }
        if self.class_id is not None:
            out["classId"] = int(self.class_id)
        if self.embedding is not None:
            out["embedding"] = [float(v) for v in self.embedding]
        if self.tracking_id is not None:
            out["trackingId"] = self.tracking_id
        return out


@dataclass(frozen=True)
class ModelBinding:
    """The concrete model resolved by selector (provenance)."""

    name: str
    version: str
    task: str
    family: str = "*"
    accelerator: str = "cpu"

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "task": self.task,
            "family": self.family,
            "accelerator": self.accelerator,
        }


@dataclass(frozen=True)
class DetectionResult:
    """Tenant-tagged, fully version-stamped inference result (#7). The capability persists none of it."""

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

    def to_dict(self) -> dict:
        out = {
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
        return out


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
