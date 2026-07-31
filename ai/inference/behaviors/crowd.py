"""Crowd analyzer (AI-4) — a generic density behavior: too many confirmed subjects in a monitored
area zone. Reusable everywhere (shop floor, platform, lobby); the pilot just configures the threshold.
Zone opt-in via a truthy `crowd` attribute (configuration). Business-neutral: emits the density; the
Rule Engine decides whether it matters. Stateless.
"""

from __future__ import annotations

from typing import List

from behavior import BehaviorContext, BehaviorObservation
from behavior_contracts import BehaviorCategory, BehaviorConfig
from tracking_contracts import ZoneKind


class CrowdAnalyzer:
    name = "crowd"
    behavior_type = "crowd"
    category = BehaviorCategory.CROWD
    version = "1.0.0"

    def __init__(self, *, min_density: int = 5, config: BehaviorConfig | None = None) -> None:
        self.config = config or BehaviorConfig()
        self._min_density = int(self.config.custom_parameters.get("minDensity", min_density))

    def analyze(self, ctx: BehaviorContext) -> List[BehaviorObservation]:
        out: List[BehaviorObservation] = []
        monitored = [z for z in ctx.zones if z.kind == ZoneKind.AREA and z.camera_id == ctx.camera_id and z.attributes.get("crowd")]
        if not monitored:
            return out
        confirmed = ctx.confirmed()
        for zone in monitored:
            members = [s for s in confirmed if zone.id in ctx.zones_containing(s.point)]
            density = len(members)
            if density >= self._min_density:
                confs = [s.tracking_confidence if s.tracking_confidence is not None else s.confidence for s in members]
                out.append(
                    BehaviorObservation(
                        key=zone.id,
                        confidence=round(sum(confs) / len(confs), 6) if confs else 0.0,
                        subjects=[s.track_id for s in members],
                        metrics={"density": float(density)},
                        zone_id=zone.id,
                        change_value=float(density),
                    )
                )
        return out
