"""Behavior analyzers (AI-3). Each implements the `BehaviorAnalyzer` seam, consumes the immutable
`BehaviorContext`, and returns pure `BehaviorObservation`s — no mutable state, no knowledge of the
tracker/detector, no direct EventEnvelope emission. They never call one another (Architect AI-3 rec 4).

`default_registry()` wires the four AI-3 capabilities in a deterministic order. Adding a future
capability is a one-line `register(...)` here — no pipeline change (rec 13).
"""

from __future__ import annotations

from typing import Optional

from behavior_registry import BehaviorRegistry
from behaviors.crowd import CrowdAnalyzer
from behaviors.fire import FireAnalyzer
from behaviors.intrusion import IntrusionAnalyzer
from behaviors.loitering import LoiteringAnalyzer
from behaviors.occupancy import OccupancyAnalyzer
from behaviors.queue import QueueAnalyzer

# Every generic primitive analyzer, by name — the set a BehaviorProfile configures (rec 3/9).
ANALYZER_TYPES = {
    "loitering": LoiteringAnalyzer,
    "queue": QueueAnalyzer,
    "intrusion": IntrusionAnalyzer,
    "crowd": CrowdAnalyzer,
    "occupancy": OccupancyAnalyzer,
    "fire": FireAnalyzer,
}


def default_registry(options: Optional[dict] = None) -> BehaviorRegistry:
    """The generic analyzer set: loitering · queue · intrusion · crowd · occupancy · fire/smoke.
    Deterministic order. `options[name]` are per-analyzer kwargs (thresholds)."""
    opts = options or {}
    registry = BehaviorRegistry()
    for name, cls in ANALYZER_TYPES.items():
        registry.register(cls(**opts.get(name, {})))
    return registry


__all__ = [
    "default_registry",
    "ANALYZER_TYPES",
    "LoiteringAnalyzer",
    "QueueAnalyzer",
    "IntrusionAnalyzer",
    "CrowdAnalyzer",
    "OccupancyAnalyzer",
    "FireAnalyzer",
]
