"""Occupancy analyzer (AI-4) — a generic threshold behavior: the number of confirmed subjects in a
monitored area zone reaches/holds a configured level. Reusable (exit occupancy validation, room caps,
etc.). Distinct from AI-2 counting (which emits per-crossing snapshots): this is a *behavioral*
level-crossing with lifecycle. Zone opt-in via a truthy `occupancy` attribute. Stateless.
"""

from __future__ import annotations

from typing import List

from behavior import BehaviorContext, BehaviorObservation
from behavior_contracts import BehaviorCategory, BehaviorConfig
from tracking_contracts import ZoneKind


class OccupancyAnalyzer:
    name = "occupancy"
    behavior_type = "occupancy"
    category = BehaviorCategory.OPERATIONAL
    version = "1.0.0"

    def __init__(self, *, level: int = 10, config: BehaviorConfig | None = None) -> None:
        self.config = config or BehaviorConfig()
        self._level = int(self.config.custom_parameters.get("level", level))

    def analyze(self, ctx: BehaviorContext) -> List[BehaviorObservation]:
        out: List[BehaviorObservation] = []
        monitored = [z for z in ctx.zones if z.kind == ZoneKind.AREA and z.camera_id == ctx.camera_id and z.attributes.get("occupancy")]
        if not monitored:
            return out
        confirmed = ctx.confirmed()
        for zone in monitored:
            members = [s for s in confirmed if zone.id in ctx.zones_containing(s.point)]
            occupancy = len(members)
            if occupancy >= self._level:
                out.append(
                    BehaviorObservation(
                        key=zone.id,
                        confidence=1.0,
                        subjects=[s.track_id for s in members],
                        metrics={"occupancy": float(occupancy), "level": float(self._level)},
                        zone_id=zone.id,
                        change_value=float(occupancy),
                    )
                )
        return out
