"""Python mirror of the @vip/contracts behavior schemas (AI-3). The TS package is the source of
truth; these dataclasses produce dicts with the SAME camelCase field names as `behavior-result`,
`track-snapshot`, `behavior-config`, and `behavior-analyzer-metrics`. Stdlib-only.

The whole point (Architect AI-3 direction): **optimize for the BehaviorResult contract, not for a
behavior algorithm.** A `BehaviorResult` is NOT an event — a single `BehaviorResultTranslator` maps it
to a canonical EventEnvelope; analyzers never emit envelopes. A `TrackSnapshot` is an IMMUTABLE view of
a Track, so behavior analysis is deterministic and safe to parallelize (analyzers own no mutable state).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple

BBox = Tuple[float, float, float, float]
Point = Tuple[float, float]


class BehaviorState(str, Enum):
    """Behavior lifecycle (Architect AI-3 rec 2) — mirrors TrackState discipline."""

    DETECTED = "detected"
    STARTED = "started"
    ONGOING = "ongoing"
    UPDATED = "updated"
    ENDED = "ended"
    EXPIRED = "expired"


class BehaviorCategory(str, Enum):
    """Coarse, reusable grouping ORTHOGONAL to behaviorType (Architect AI-3 rec 5)."""

    SECURITY = "security"
    SAFETY = "safety"
    OPERATIONAL = "operational"
    RETAIL = "retail"
    CROWD = "crowd"
    COMPLIANCE = "compliance"


@dataclass(frozen=True)
class TrackSnapshot:
    """An immutable read-only view of a Track at one frame — the ONLY track shape analyzers receive."""

    track_id: str
    tenant_id: str
    camera_id: str
    label: str
    state: str  # TrackState value
    confidence: float
    bbox: BBox
    age: int
    hits: int
    frame_index: int
    at: str
    session_id: Optional[str] = None
    centroid: Optional[Point] = None
    tracking_confidence: Optional[float] = None

    @property
    def point(self) -> Point:
        """Centroid if present, else the bbox centre (analyzers reason in normalized [0,1] space)."""
        if self.centroid is not None:
            return self.centroid
        return (self.bbox[0] + self.bbox[2] / 2.0, self.bbox[1] + self.bbox[3] / 2.0)

    def to_dict(self) -> dict:
        out: dict = {
            "trackId": self.track_id,
            "tenantId": self.tenant_id,
            "cameraId": self.camera_id,
            "label": self.label,
            "state": self.state,
            "confidence": round(float(self.confidence), 6),
            "bbox": [round(float(v), 6) for v in self.bbox],
            "age": int(self.age),
            "hits": int(self.hits),
            "frameIndex": int(self.frame_index),
            "at": self.at,
        }
        if self.session_id is not None:
            out["sessionId"] = self.session_id
        if self.centroid is not None:
            out["centroid"] = [round(float(self.centroid[0]), 6), round(float(self.centroid[1]), 6)]
        if self.tracking_confidence is not None:
            out["trackingConfidence"] = round(float(self.tracking_confidence), 6)
        return out


@dataclass
class BehaviorResult:
    """The SOLE output contract of every analyzer, regardless of implementation (window/heuristic/ML)."""

    behavior_id: str
    behavior_type: str
    category: BehaviorCategory
    tenant_id: str
    camera_id: str
    state: BehaviorState
    confidence: float
    first_observed: str
    last_observed: str
    frame_index: int
    session_id: Optional[str] = None
    zone_id: Optional[str] = None
    subjects: List[str] = field(default_factory=list)
    metrics: Dict[str, float] = field(default_factory=dict)
    window_ms: Optional[float] = None
    producer: Optional[str] = None
    behavior_version: Optional[str] = None  # Architect AI-3 refinement 1 (reserved, analyzer-stamped)
    severity: Optional[str] = None  # Architect AI-3 refinement 5 (reserved; never set by AI-3 runtime)
    correlation_id: Optional[str] = None  # Architect AI-3 refinement 4
    # --- AI-4 relationships / evidence / composition (all optional/reserved) ---
    parent_behavior_id: Optional[str] = None  # rec 2
    follows_behavior_id: Optional[str] = None  # rec 2
    related_behavior_ids: Optional[List[str]] = None  # rec 2
    evidence: Optional[Dict[str, object]] = None  # rec 3 (contributingTracks/Zones; frames/dets reserved)
    composite: Optional[Dict[str, object]] = None  # rec 1/2 (present only on composite results)
    attributes: Dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        out: dict = {
            "behaviorId": self.behavior_id,
            "behaviorType": self.behavior_type,
            "category": self.category.value,
            "tenantId": self.tenant_id,
            "cameraId": self.camera_id,
            "state": self.state.value,
            "confidence": round(float(self.confidence), 6),
            "firstObserved": self.first_observed,
            "lastObserved": self.last_observed,
            "frameIndex": int(self.frame_index),
            "subjects": list(self.subjects),
            "metrics": {k: round(float(v), 6) for k, v in self.metrics.items()},
            "attributes": dict(self.attributes),
        }
        if self.session_id is not None:
            out["sessionId"] = self.session_id
        if self.zone_id is not None:
            out["zoneId"] = self.zone_id
        if self.window_ms is not None:
            out["windowMs"] = round(float(self.window_ms), 3)
        if self.producer is not None:
            out["producer"] = self.producer
        if self.behavior_version is not None:
            out["behaviorVersion"] = self.behavior_version
        if self.severity is not None:
            out["severity"] = self.severity
        if self.correlation_id is not None:
            out["correlationId"] = self.correlation_id
        if self.parent_behavior_id is not None:
            out["parentBehaviorId"] = self.parent_behavior_id
        if self.follows_behavior_id is not None:
            out["followsBehaviorId"] = self.follows_behavior_id
        if self.related_behavior_ids is not None:
            out["relatedBehaviorIds"] = list(self.related_behavior_ids)
        if self.evidence is not None:
            out["evidence"] = dict(self.evidence)
        if self.composite is not None:
            out["composite"] = dict(self.composite)
        return out


@dataclass
class BehaviorConfig:
    """Common analyzer configuration (Architect AI-3 refinement 2) — one shape for every analyzer, so a
    future UI has a single form. Analyzer-specific knobs ride in `custom_parameters` (numbers/flags)."""

    enabled: bool = True
    confidence_threshold: Optional[float] = None
    cooldown_seconds: Optional[float] = None
    window_seconds: Optional[float] = None
    custom_parameters: Dict[str, object] = field(default_factory=dict)

    def param(self, key: str, default):
        v = self.custom_parameters.get(key, default)
        return v if isinstance(v, type(default)) or default is None else default

    @staticmethod
    def from_dict(raw: Optional[dict]) -> "BehaviorConfig":
        raw = raw or {}
        return BehaviorConfig(
            enabled=bool(raw.get("enabled", True)),
            confidence_threshold=(float(raw["confidenceThreshold"]) if raw.get("confidenceThreshold") is not None else None),
            cooldown_seconds=(float(raw["cooldownSeconds"]) if raw.get("cooldownSeconds") is not None else None),
            window_seconds=(float(raw["windowSeconds"]) if raw.get("windowSeconds") is not None else None),
            custom_parameters=dict(raw.get("customParameters", {})),
        )

    def to_dict(self) -> dict:
        out: dict = {"enabled": bool(self.enabled), "customParameters": dict(self.custom_parameters)}
        if self.confidence_threshold is not None:
            out["confidenceThreshold"] = float(self.confidence_threshold)
        if self.cooldown_seconds is not None:
            out["cooldownSeconds"] = float(self.cooldown_seconds)
        if self.window_seconds is not None:
            out["windowSeconds"] = float(self.window_seconds)
        return out
