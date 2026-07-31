"""Queue analyzer (AI-3) — the number of confirmed subjects standing in a monitored queue zone. A
queue is 'active' while its length meets a configured minimum; the analyzer emits an `updated`
observation whenever the length changes (`change_value`), so the pipeline reports queue growth/shrink
without per-frame spam. Stateless: length samples go into a `TemporalWindow` for the average.

Zone opt-in via a truthy `queue` attribute (configuration, not business meaning). Business-neutral: the
runtime reports the count; the Rule Engine decides whether the queue is 'too long'.
"""

from __future__ import annotations

from typing import List

from behavior import BehaviorContext, BehaviorObservation
from behavior_contracts import BehaviorCategory, BehaviorConfig
from tracking_contracts import ZoneKind


class QueueAnalyzer:
    name = "queue"
    behavior_type = "queue"
    category = BehaviorCategory.OPERATIONAL
    version = "1.0.0"

    def __init__(self, *, min_queue: int = 2, config: BehaviorConfig | None = None) -> None:
        self.config = config or BehaviorConfig(window_seconds=60.0)
        self._min_queue = int(self.config.custom_parameters.get("minQueue", min_queue))

    def analyze(self, ctx: BehaviorContext) -> List[BehaviorObservation]:
        out: List[BehaviorObservation] = []
        monitored = [z for z in ctx.zones if z.kind == ZoneKind.AREA and z.camera_id == ctx.camera_id and z.attributes.get("queue")]
        if not monitored:
            return out
        confirmed = ctx.confirmed()
        for zone in monitored:
            members = [s for s in confirmed if zone.id in ctx.zones_containing(s.point)]
            length = len(members)
            win = ctx.windows.window(self.name, zone.id, window_seconds=self.config.window_seconds)
            win.record(ctx.t, float(length))
            if length >= self._min_queue:
                # Confidence = mean tracking confidence of the queued subjects (business-neutral).
                confs = [s.tracking_confidence if s.tracking_confidence is not None else s.confidence for s in members]
                out.append(
                    BehaviorObservation(
                        key=zone.id,
                        confidence=round(sum(confs) / len(confs), 6) if confs else 0.0,
                        subjects=[s.track_id for s in members],
                        metrics={"queueLength": float(length), "averageQueueLength": round(win.average(), 3)},
                        zone_id=zone.id,
                        change_value=float(length),
                    )
                )
        return out
