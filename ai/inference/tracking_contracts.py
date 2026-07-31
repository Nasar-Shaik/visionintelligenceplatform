"""Python mirror of the @vip/contracts tracking schemas (AI-2). The TS package is the source of
truth; these dataclasses produce dicts with the SAME camelCase field names as `track` / `zone` /
`zone-transition` / `counting-snapshot` (parity mirrors contracts.py). Stdlib-only.

Track identity is deliberately DISTINCT from Detection identity: a Detection is one observation; a
Track is a continuous identity across frames. Downstream consumes Track, never a tracker object.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Sequence, Tuple

BBox = Tuple[float, float, float, float]
Point = Tuple[float, float]


class TrackState(str, Enum):
    CREATED = "created"
    TENTATIVE = "tentative"
    CONFIRMED = "confirmed"
    LOST = "lost"
    REMOVED = "removed"


@dataclass(frozen=True)
class TrackHistoryPoint:
    frame_index: int
    at: str
    bbox: BBox
    centroid: Optional[Point] = None

    def to_dict(self) -> dict:
        out: dict = {
            "frameIndex": int(self.frame_index),
            "at": self.at,
            "bbox": [round(float(v), 6) for v in self.bbox],
        }
        if self.centroid is not None:
            out["centroid"] = [round(float(self.centroid[0]), 6), round(float(self.centroid[1]), 6)]
        return out


@dataclass
class TrackQuality:
    tracking_confidence: Optional[float] = None
    occlusion_ratio: Optional[float] = None
    visibility: Optional[float] = None
    prediction_frames: Optional[int] = None
    lost_frames: Optional[int] = None

    def to_dict(self) -> dict:
        out: dict = {}
        if self.tracking_confidence is not None:
            out["trackingConfidence"] = round(float(self.tracking_confidence), 6)
        if self.occlusion_ratio is not None:
            out["occlusionRatio"] = round(float(self.occlusion_ratio), 6)
        if self.visibility is not None:
            out["visibility"] = round(float(self.visibility), 6)
        if self.prediction_frames is not None:
            out["predictionFrames"] = int(self.prediction_frames)
        if self.lost_frames is not None:
            out["lostFrames"] = int(self.lost_frames)
        return out


@dataclass
class Track:
    track_id: str
    tenant_id: str
    camera_id: str
    label: str
    state: TrackState
    confidence: float
    bbox: BBox
    first_seen_frame: int
    first_seen_at: str
    last_seen_frame: int
    last_seen_at: str
    age: int
    hits: int
    class_id: Optional[int] = None
    session_id: Optional[str] = None
    centroid: Optional[Point] = None
    quality: TrackQuality = field(default_factory=TrackQuality)
    history: List[TrackHistoryPoint] = field(default_factory=list)
    attributes: Dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        out: dict = {
            "trackId": self.track_id,
            "tenantId": self.tenant_id,
            "cameraId": self.camera_id,
            "label": self.label,
            "state": self.state.value,
            "confidence": round(float(self.confidence), 6),
            "bbox": [round(float(v), 6) for v in self.bbox],
            "firstSeen": {"frameIndex": int(self.first_seen_frame), "at": self.first_seen_at},
            "lastSeen": {"frameIndex": int(self.last_seen_frame), "at": self.last_seen_at},
            "age": int(self.age),
            "hits": int(self.hits),
            "quality": self.quality.to_dict(),
            "history": [h.to_dict() for h in self.history],
            "attributes": dict(self.attributes),
        }
        if self.class_id is not None:
            out["classId"] = int(self.class_id)
        if self.session_id is not None:
            out["sessionId"] = self.session_id
        if self.centroid is not None:
            out["centroid"] = [round(float(self.centroid[0]), 6), round(float(self.centroid[1]), 6)]
        return out


class ZoneKind(str, Enum):
    AREA = "area"
    LINE = "line"


@dataclass(frozen=True)
class Zone:
    id: str
    camera_id: str
    name: str
    kind: ZoneKind
    points: Sequence[Point]
    attributes: Dict[str, object] = field(default_factory=dict)

    @staticmethod
    def from_dict(raw: dict) -> "Zone":
        return Zone(
            id=str(raw["id"]),
            camera_id=str(raw.get("cameraId", "")),
            name=str(raw.get("name", raw["id"])),
            kind=ZoneKind(str(raw.get("kind", "area"))),
            points=[(float(p[0]), float(p[1])) for p in raw["geometry"]["points"]],
            attributes=dict(raw.get("attributes", {})),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "cameraId": self.camera_id,
            "name": self.name,
            "kind": self.kind.value,
            "geometry": {"points": [[float(p[0]), float(p[1])] for p in self.points]},
            "attributes": dict(self.attributes),
        }


@dataclass(frozen=True)
class ZoneTransition:
    tenant_id: str
    camera_id: str
    zone_id: str
    track_id: str
    transition: str  # "entered" | "exited"
    frame_index: int
    at: str
    confidence: Optional[float] = None
    session_id: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {
            "tenantId": self.tenant_id,
            "cameraId": self.camera_id,
            "zoneId": self.zone_id,
            "trackId": self.track_id,
            "transition": self.transition,
            "frameIndex": int(self.frame_index),
            "at": self.at,
        }
        if self.confidence is not None:
            out["confidence"] = round(float(self.confidence), 6)
        if self.session_id is not None:
            out["sessionId"] = self.session_id
        return out


@dataclass(frozen=True)
class CountingSnapshot:
    tenant_id: str
    camera_id: str
    zone_id: str
    entered: int
    exited: int
    occupancy: int
    at: str

    def to_dict(self) -> dict:
        return {
            "tenantId": self.tenant_id,
            "cameraId": self.camera_id,
            "zoneId": self.zone_id,
            "entered": int(self.entered),
            "exited": int(self.exited),
            "occupancy": int(self.occupancy),
            "at": self.at,
        }
