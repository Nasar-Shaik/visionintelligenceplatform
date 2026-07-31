"""Intrusion analyzer (AI-3) — a confirmed subject present in a zone designated restricted. This is a
PERCEPTION primitive, NOT a business decision (Architect AI-3 rec 12): the analyzer states 'a subject
is in the restricted zone'; whether that is an intrusion (after-hours, unauthorized personnel,
emergency mode) is the Rule Engine's call. Detector-independent: TrackSnapshots + zone geometry only.

Zone opt-in via a truthy `restricted` attribute (configuration). Stateless.
"""

from __future__ import annotations

from typing import List

from behavior import BehaviorContext, BehaviorObservation
from behavior_contracts import BehaviorCategory, BehaviorConfig
from tracking_contracts import ZoneKind


class IntrusionAnalyzer:
    name = "intrusion"
    behavior_type = "intrusion"
    category = BehaviorCategory.SECURITY
    version = "1.0.0"

    def __init__(self, *, config: BehaviorConfig | None = None) -> None:
        self.config = config or BehaviorConfig()

    def analyze(self, ctx: BehaviorContext) -> List[BehaviorObservation]:
        out: List[BehaviorObservation] = []
        restricted = [z for z in ctx.zones if z.kind == ZoneKind.AREA and z.camera_id == ctx.camera_id and z.attributes.get("restricted")]
        if not restricted:
            return out
        for snap in ctx.confirmed():
            inside = ctx.zones_containing(snap.point)
            for zone in restricted:
                if zone.id in inside:
                    out.append(
                        BehaviorObservation(
                            key=f"{zone.id}:{snap.track_id}",
                            confidence=snap.tracking_confidence if snap.tracking_confidence is not None else snap.confidence,
                            subjects=[snap.track_id],
                            metrics={"presentFrames": float(snap.hits)},
                            zone_id=zone.id,
                        )
                    )
        return out
