"""Behavior analyzers (AI-3). Each implements the `BehaviorAnalyzer` seam, consumes the immutable
`BehaviorContext`, and returns pure `BehaviorObservation`s — no mutable state, no knowledge of the
tracker/detector, no direct EventEnvelope emission. They never call one another (Architect AI-3 rec 4).

`default_registry()` wires the four AI-3 capabilities in a deterministic order. Adding a future
capability is a one-line `register(...)` here — no pipeline change (rec 13).
"""

from __future__ import annotations

from typing import Optional

from behavior_registry import BehaviorRegistry
from behaviors.fire import FireAnalyzer
from behaviors.intrusion import IntrusionAnalyzer
from behaviors.loitering import LoiteringAnalyzer
from behaviors.queue import QueueAnalyzer


def default_registry(options: Optional[dict] = None) -> BehaviorRegistry:
    """The AI-3 analyzer set: loitering · queue · intrusion · fire/smoke. Order is deterministic."""
    opts = options or {}
    registry = BehaviorRegistry()
    registry.register(LoiteringAnalyzer(**opts.get("loitering", {})))
    registry.register(QueueAnalyzer(**opts.get("queue", {})))
    registry.register(IntrusionAnalyzer(**opts.get("intrusion", {})))
    registry.register(FireAnalyzer(**opts.get("fire", {})))
    return registry


__all__ = [
    "default_registry",
    "LoiteringAnalyzer",
    "QueueAnalyzer",
    "IntrusionAnalyzer",
    "FireAnalyzer",
]
