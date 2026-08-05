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

#: Version of the `Track` shape itself. Bumped to 1.1 in P-8 Phase 4 when the frozen v1.0 contract
#: gained optional motion + identity fields. Mirrors TRACK_SCHEMA_VERSION in @vip/contracts.
TRACK_SCHEMA_VERSION = "1.1"

#: The eight readable heading buckets, indexed by `round(degrees / 45) % 8`. Image space: 0° is +x
#: (right) and degrees increase CLOCKWISE, because image `y` grows downward.
HEADING_LABELS = (
    "right",
    "down-right",
    "down",
    "down-left",
    "left",
    "up-left",
    "up",
    "up-right",
)


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
class TrackMotion:
    """Movement derived from a track's own history (P-8 Phase 4).

    ⚠️ Distances are NORMALIZED IMAGE UNITS — fractions of the frame — so speeds are frame widths per
    second and not m/s. Converting needs camera calibration this platform does not have; a field
    called `speedMps` would be a fabricated physical quantity. See the TS contract for the full note.
    """

    duration_seconds: float
    path_length: float
    displacement: float
    average_speed: float
    current_speed: float
    dwell_seconds: float
    samples: int
    heading_degrees: Optional[float] = None
    heading_label: Optional[str] = None
    straightness: Optional[float] = None

    def to_dict(self) -> dict:
        out: dict = {
            "durationSeconds": round(float(self.duration_seconds), 6),
            "pathLengthNormalized": round(float(self.path_length), 6),
            "displacementNormalized": round(float(self.displacement), 6),
            "averageSpeedNormalized": round(float(self.average_speed), 6),
            "currentSpeedNormalized": round(float(self.current_speed), 6),
            "dwellSeconds": round(float(self.dwell_seconds), 6),
            "samples": int(self.samples),
        }
        # ⚠️ Omitted rather than zeroed. `0°` means "travelling right" and `0.0` straightness means
        # "milling about" — both are claims, and a track that has not moved has made neither.
        if self.heading_degrees is not None:
            out["headingDegrees"] = round(float(self.heading_degrees), 3)
        if self.heading_label is not None:
            out["headingLabel"] = self.heading_label
        if self.straightness is not None:
            out["straightness"] = round(float(self.straightness), 6)
        return out


@dataclass(frozen=True)
class TrackTimelineEntry:
    """One lifecycle transition. Append-only: a recovered track still shows that it was lost."""

    frame_index: int
    at: str
    to: str
    from_state: Optional[str] = None
    reason: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {"frameIndex": int(self.frame_index), "at": self.at, "to": self.to}
        out["from"] = self.from_state
        if self.reason is not None:
            out["reason"] = self.reason
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
    # --- P-8 Phase 4, all optional (additive evolution of a frozen contract) ---------------------
    motion: Optional[TrackMotion] = None
    #: Identity across a gap the tracker could not bridge. Equal to the FIRST trackId in the chain.
    #: ⚠️ The trackId itself is never reused — re-entry is a link, not a reassignment. See the TS
    #: contract's note on `identityId` for why reassignment would be the wrong answer.
    identity_id: Optional[str] = None
    preceded_by: Optional[str] = None
    recoveries: int = 0

    def to_dict(self) -> dict:
        out: dict = {
            "schemaVersion": TRACK_SCHEMA_VERSION,
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
        if self.motion is not None:
            out["motion"] = self.motion.to_dict()
        if self.identity_id is not None:
            out["identityId"] = self.identity_id
        if self.preceded_by is not None:
            out["precededBy"] = self.preceded_by
        if self.recoveries:
            out["recoveries"] = int(self.recoveries)
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
