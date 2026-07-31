"""Loitering analyzer (AI-3) — a confirmed subject dwelling in a monitored area zone beyond a
configured duration. Stateless: dwell time is derived from a `TemporalWindow` in the context, never
from analyzer-owned state (Architect AI-3 refinement 3). Detector-independent: reads TrackSnapshots +
zone geometry only.

Zone opt-in is configuration, not business meaning: a zone participates when its generic `attributes`
carry a truthy `loitering` flag. The Rule Engine still decides what a loiter *means* (after-hours,
VIP area, etc.) — this analyzer only states that dwell exceeded the sensitivity threshold.
"""

from __future__ import annotations

from typing import List

from behavior import BehaviorContext, BehaviorObservation
from behavior_contracts import BehaviorCategory, BehaviorConfig
from tracking_contracts import ZoneKind


class LoiteringAnalyzer:
    name = "loitering"
    behavior_type = "loitering"
    category = BehaviorCategory.SECURITY
    version = "1.0.0"

    def __init__(self, *, dwell_seconds: float = 3.0, config: BehaviorConfig | None = None) -> None:
        self.config = config or BehaviorConfig(window_seconds=max(dwell_seconds * 4, 30.0))
        self._dwell_seconds = float(self.config.custom_parameters.get("dwellSeconds", dwell_seconds))

    def analyze(self, ctx: BehaviorContext) -> List[BehaviorObservation]:
        out: List[BehaviorObservation] = []
        monitored = [z for z in ctx.zones if z.kind == ZoneKind.AREA and z.camera_id == ctx.camera_id and z.attributes.get("loitering")]
        if not monitored:
            return out
        for snap in ctx.confirmed():
            point = snap.point
            for zone in monitored:
                if zone.id not in ctx.zones_containing(point):
                    continue
                key = f"{zone.id}:{snap.track_id}"
                win = ctx.windows.window(self.name, key, window_seconds=self.config.window_seconds)
                win.record(ctx.t)
                dwell = win.span_seconds()
                if dwell >= self._dwell_seconds:
                    out.append(
                        BehaviorObservation(
                            key=key,
                            confidence=snap.tracking_confidence if snap.tracking_confidence is not None else snap.confidence,
                            subjects=[snap.track_id],
                            metrics={"dwellSeconds": round(dwell, 3)},
                            zone_id=zone.id,
                            window_ms=dwell * 1000.0,
                        )
                    )
        return out
