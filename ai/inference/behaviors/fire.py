"""Fire/Smoke analyzer (AI-3) — a hazard is present when a track carries a fire/smoke label. It is
strictly DETECTOR-INDEPENDENT (Architect AI-3 rec 10 + refinement 6): it reads normalized labels only
and never knows whether the detection came from YOLO, ONNX, TensorRT, OpenVINO, cloud inference, or a
future custom model. One analyzer covers the small hazard family by overriding `behavior_type` per
observation (`fire` vs `smoke`); category stays `safety`.

No zone needed — a hazard anywhere in view matters. Stateless; not gated on `confirmed` because a
hazard label should surface as soon as it is tracked (tentative included), but flicker is throttled by
the lifecycle store's started/ended semantics.
"""

from __future__ import annotations

from typing import List

from behavior import BehaviorContext, BehaviorObservation
from behavior_contracts import BehaviorCategory, BehaviorConfig

_FIRE_LABELS = {"fire", "flame"}
_SMOKE_LABELS = {"smoke"}


class FireAnalyzer:
    name = "fire"
    behavior_type = "fire"
    category = BehaviorCategory.SAFETY
    version = "1.0.0"

    def __init__(self, *, config: BehaviorConfig | None = None) -> None:
        self.config = config or BehaviorConfig()

    def analyze(self, ctx: BehaviorContext) -> List[BehaviorObservation]:
        out: List[BehaviorObservation] = []
        for snap in ctx.snapshots:
            if snap.state == "removed":
                continue
            label = snap.label.strip().lower()
            if label in _FIRE_LABELS:
                btype = "fire"
            elif label in _SMOKE_LABELS:
                btype = "smoke"
            else:
                continue
            out.append(
                BehaviorObservation(
                    key=f"{btype}:{snap.track_id}",
                    confidence=snap.confidence,
                    subjects=[snap.track_id],
                    metrics={"area": round(snap.bbox[2] * snap.bbox[3], 6)},
                    behavior_type=btype,
                )
            )
        return out
