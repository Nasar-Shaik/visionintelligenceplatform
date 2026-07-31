"""Temporal Window abstraction (AI-3, Architect rec 4 + refinements 3/6) — the ONE reusable place for
time-based behavior state. Behaviors that depend on time (loitering, queue length, running, abandoned
object, crowd formation, PPE-compliance duration, vehicle dwell) all reuse this — none implement timing
independently, and no analyzer owns mutable state (all temporal state lives HERE or in the context).

A `TemporalWindow` is a bounded sliding window of (t, value) samples keyed by a subject. A
`TemporalWindowStore` owns the windows across frames and is passed to analyzers through the immutable
`BehaviorContext`. Deterministic: driven by an injected monotonic `t` (frame seconds), never a clock.
Stdlib-only.
"""

from __future__ import annotations

from collections import deque
from typing import Deque, Dict, List, Optional, Tuple


class TemporalWindow:
    """A sliding window of timestamped samples spanning at most `window_seconds` (and `max_samples`)."""

    __slots__ = ("_window_seconds", "_max_samples", "_samples")

    def __init__(self, window_seconds: Optional[float] = None, max_samples: int = 512) -> None:
        self._window_seconds = window_seconds
        self._max_samples = max_samples
        self._samples: Deque[Tuple[float, float]] = deque(maxlen=max_samples)

    def record(self, t: float, value: float = 1.0) -> None:
        """Append a sample at time `t`, then evict anything older than the window horizon."""
        self._samples.append((float(t), float(value)))
        self._evict(float(t))

    def _evict(self, now: float) -> None:
        if self._window_seconds is None:
            return
        horizon = now - self._window_seconds
        while self._samples and self._samples[0][0] < horizon:
            self._samples.popleft()

    def count(self) -> int:
        return len(self._samples)

    def values(self) -> List[float]:
        return [v for _, v in self._samples]

    def average(self) -> float:
        return sum(v for _, v in self._samples) / len(self._samples) if self._samples else 0.0

    def span_seconds(self) -> float:
        """Elapsed time between the oldest and newest retained sample (0 for <2 samples)."""
        if len(self._samples) < 2:
            return 0.0
        return self._samples[-1][0] - self._samples[0][0]

    def first_t(self) -> Optional[float]:
        return self._samples[0][0] if self._samples else None

    def last_t(self) -> Optional[float]:
        return self._samples[-1][0] if self._samples else None


class TemporalWindowStore:
    """Owns TemporalWindows across frames, keyed by (analyzer, subject). Persists for the session; the
    pipeline holds one and hands it to each frame's BehaviorContext — so analyzers stay stateless."""

    def __init__(self) -> None:
        self._windows: Dict[Tuple[str, str], TemporalWindow] = {}

    def window(self, analyzer: str, key: str, *, window_seconds: Optional[float] = None) -> TemporalWindow:
        composite = (analyzer, key)
        win = self._windows.get(composite)
        if win is None:
            win = TemporalWindow(window_seconds=window_seconds)
            self._windows[composite] = win
        return win

    def drop(self, analyzer: str, key: str) -> None:
        self._windows.pop((analyzer, key), None)

    def reset(self) -> None:
        self._windows.clear()
