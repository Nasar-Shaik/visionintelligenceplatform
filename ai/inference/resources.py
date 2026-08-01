"""Per-session resource accounting, SLA tracking, and trend estimation (AI-5c).

Three related jobs, all in service of one goal: make scheduling decisions **data-driven** rather than
heuristic (Architect AI-5c rec 6).

  - **`SessionAccount`** — what one camera actually costs (rec 3 / AI-5b rec 3). "The box is at 90%
    CPU" is not actionable; "cam_17 is consuming 40% of inference time at priority `low`" is.
  - **`SlaTracker`** — target vs actual FPS/latency, so a scheduler can answer "is this camera getting
    what it was promised?" instead of guessing from queue depth alone.
  - **`Trend`** — least-squares slope over a bounded window, so the governor can degrade on a
    *projected* overload rather than an observed one (refinement 2). Reacting only when the queue is
    already full means frames have already been lost.

**Honest attribution.** The runtime is one process, so a session's CPU/memory share cannot be measured
by the kernel per-session. Shares are ATTRIBUTED from measured work (frames × inference time) against
the process total. That is an estimate and is documented as one everywhere it surfaces — false
precision here would be worse than none, because operators make capacity decisions from these numbers.

Deterministic + stdlib-only: every clock is injected, so trends and SLA verdicts are unit-testable
without a loaded machine.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, List, Optional

from operational_log import SessionIdentity

# Mirrors @vip/contracts `DEGRADATION_LADDER` — escalation order, index = severity.
DEGRADATION_LADDER = (
    "none",
    "reduced-fps",
    "reduced-resolution",
    "reduced-behaviors",
    "shedding-frames",
    "suspended",
)

PRIORITIES = ("low", "normal", "high", "critical")
PRIORITY_WEIGHTS = {"low": 1, "normal": 2, "high": 4, "critical": 8}


def ladder_index(level: str) -> int:
    try:
        return DEGRADATION_LADDER.index(level)
    except ValueError:
        return 0


class Trend:
    """Least-squares slope over a bounded sample window — the predictive input (refinement 2).

    Slope is per-sample (not per-second) on purpose: the governor observes on its own cadence, so
    "units per observation" is the natural unit and needs no wall-clock, which keeps it deterministic.
    """

    def __init__(self, window: int = 5) -> None:
        self._window = max(2, int(window))
        self._samples: Deque[float] = deque(maxlen=self._window)

    def observe(self, value: float) -> None:
        self._samples.append(float(value))

    @property
    def samples(self) -> List[float]:
        return list(self._samples)

    @property
    def latest(self) -> float:
        return self._samples[-1] if self._samples else 0.0

    @property
    def slope(self) -> float:
        """Change per sample. 0.0 until there are at least two observations."""
        n = len(self._samples)
        if n < 2:
            return 0.0
        xs = range(n)
        mean_x = (n - 1) / 2.0
        mean_y = sum(self._samples) / n
        numerator = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, self._samples))
        denominator = sum((x - mean_x) ** 2 for x in xs)
        return numerator / denominator if denominator else 0.0

    def project(self, horizon: int = 3) -> float:
        """Value projected `horizon` samples ahead, clamped at zero (a negative queue is meaningless)."""
        return max(0.0, self.latest + self.slope * max(0, horizon))

    def reset(self) -> None:
        self._samples.clear()


@dataclass
class RestoreStep:
    """One entry on a session's **restoration stack** (Architect AI-5d rec 4).

    A rung is not what was actually taken away. `reduced-behaviors` disabled *specific* analyzers, and
    re-enabling a different set is not the reverse of that — it is merely the same rung count. Each
    degradation therefore pushes exactly what it removed and each recovery pops it, which makes
    exact-reverse restoration a structural property rather than an intention.
    """

    level: str
    sequence: int
    disabled_analyzers: List[str] = field(default_factory=list)
    fps_before: Optional[float] = None
    fps_after: Optional[float] = None
    resolution_scale: Optional[float] = None
    at: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {
            "level": self.level,
            "sequence": self.sequence,
            "disabledAnalyzers": list(self.disabled_analyzers),
        }
        for key, value in (
            ("fpsBefore", self.fps_before),
            ("fpsAfter", self.fps_after),
            ("resolutionScale", self.resolution_scale),
            ("at", self.at),
        ):
            if value is not None:
                out[key] = round(value, 3) if isinstance(value, float) else value
        return out


@dataclass
class SessionAccount:
    """Measured cost + service level of ONE session. Owned exclusively by that session (rec 7)."""

    identity: SessionIdentity
    priority: str = "normal"
    target_fps: float = 5.0
    target_latency_ms: Optional[float] = None
    compute_units: float = 0.0
    resource_id: Optional[str] = None
    degradation: str = "none"
    # Measured work
    frames_processed: int = 0
    inference_ms_total: float = 0.0
    event_latency_ms_total: float = 0.0
    dropped_frames: int = 0
    reconnect_count: int = 0
    queue_depth: int = 0
    queue_utilization: float = 0.0
    average_queue_depth: float = 0.0
    effective_fps: float = 0.0
    health: str = "unknown"
    disabled_analyzers: List[str] = field(default_factory=list)
    # AI-5d: what each degradation step took away, newest last. Popped in reverse on recovery, which
    # is what makes progressive restoration exact rather than approximate.
    restore_stack: List[RestoreStep] = field(default_factory=list)
    degradation_sequence: int = 0
    # The health score most recently computed for this session (AI-5d). Evidence only — the governor
    # decides; health never moves a session down the ladder by itself.
    health_score: Optional[float] = None
    predicted_decline: bool = False
    # Attributed shares (estimates — see module docstring)
    cpu_percent: Optional[float] = None
    memory_mb: Optional[float] = None
    gpu_percent: Optional[float] = None
    # Predictive inputs
    queue_trend: Trend = field(default_factory=Trend)
    latency_trend: Trend = field(default_factory=Trend)

    @property
    def inference_latency_ms(self) -> float:
        return self.inference_ms_total / self.frames_processed if self.frames_processed else 0.0

    @property
    def event_latency_ms(self) -> float:
        return self.event_latency_ms_total / self.frames_processed if self.frames_processed else 0.0

    @property
    def attainment_percent(self) -> float:
        """actual / target FPS as a percentage — the headline SLA number."""
        if self.target_fps <= 0:
            return 100.0
        return max(0.0, min(1000.0, 100.0 * self.effective_fps / self.target_fps))

    @property
    def sla_met(self) -> bool:
        """Met when FPS attainment is within tolerance AND (if targeted) latency is under budget."""
        fps_ok = self.attainment_percent >= 90.0
        latency_ok = (
            self.target_latency_ms is None or self.event_latency_ms <= self.target_latency_ms
        )
        return fps_ok and latency_ok

    def observe(self, *, queue_utilization: float, event_latency_ms: float) -> None:
        """Record one governor-cadence observation for trend estimation."""
        self.queue_utilization = queue_utilization
        self.queue_trend.observe(queue_utilization)
        self.latency_trend.observe(event_latency_ms)

    # --- the restoration stack (AI-5d rec 4) --------------------------------------

    def push_restore(self, step: RestoreStep) -> RestoreStep:
        """Record what a degradation step took away, so recovery knows exactly what to give back."""
        self.degradation_sequence += 1
        step.sequence = self.degradation_sequence
        self.restore_stack.append(step)
        for analyzer in step.disabled_analyzers:
            if analyzer not in self.disabled_analyzers:
                self.disabled_analyzers.append(analyzer)
        return step

    def pop_restore(self) -> Optional[RestoreStep]:
        """Undo the most recent degradation step — strictly LIFO, never by rung name."""
        if not self.restore_stack:
            return None
        step = self.restore_stack.pop()
        for analyzer in step.disabled_analyzers:
            if analyzer in self.disabled_analyzers:
                self.disabled_analyzers.remove(analyzer)
        return step

    @property
    def fully_restored(self) -> bool:
        return not self.restore_stack and not self.disabled_analyzers

    def to_usage_dict(self) -> dict:
        """A `SessionResourceUsage`-shaped snapshot (camelCase; mirrors @vip/contracts)."""
        out: dict = {
            "identity": self.identity.to_dict(),
            "priority": self.priority,
            "degradation": self.degradation,
            "averageQueueDepth": round(self.average_queue_depth, 3),
            "queueUtilization": round(self.queue_utilization, 3),
            "inferenceLatencyMs": round(self.inference_latency_ms, 3),
            "eventLatencyMs": round(self.event_latency_ms, 3),
            "reconnectCount": self.reconnect_count,
            "framesProcessed": self.frames_processed,
            "effectiveFps": round(self.effective_fps, 3),
            "disabledAnalyzers": list(self.disabled_analyzers),
        }
        if self.health_score is not None:
            out["healthScore"] = round(self.health_score, 3)
        for key, value in (
            ("cpuPercent", self.cpu_percent),
            ("memoryMb", self.memory_mb),
            ("gpuPercent", self.gpu_percent),
        ):
            if value is not None:
                out[key] = round(float(value), 3)
        return out

    def to_sla_dict(self) -> dict:
        """A `SessionSla`-shaped snapshot — target vs actual (rec 6)."""
        out = {
            "identity": self.identity.to_dict(),
            "targetFps": round(self.target_fps, 3),
            "actualFps": round(self.effective_fps, 3),
            "actualLatencyMs": round(self.event_latency_ms, 3),
            "queueDepth": self.queue_depth,
            "droppedFrames": self.dropped_frames,
            "health": self.health,
            "degradation": self.degradation,
            "met": self.sla_met,
            "attainmentPercent": round(self.attainment_percent, 3),
        }
        if self.target_latency_ms is not None:
            out["targetLatencyMs"] = round(self.target_latency_ms, 3)
        return out


class ResourceAccountant:
    """Owns every session's account and attributes process resources across them.

    Attribution is proportional to **measured inference work** (frames × mean inference time), because
    that is the cost the runtime actually controls. Sessions that analyzed nothing are attributed
    nothing, which keeps an idle camera from appearing expensive.
    """

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._accounts: Dict[str, SessionAccount] = {}
        self._clock = clock

    @staticmethod
    def _key(identity: SessionIdentity) -> str:
        # Tenant-qualified: one tenant can never address another's account (Law 5).
        return f"{identity.tenant_id}::{identity.session_id}"

    def open(
        self,
        identity: SessionIdentity,
        *,
        priority: str = "normal",
        target_fps: float = 5.0,
        target_latency_ms: Optional[float] = None,
        compute_units: float = 0.0,
        resource_id: Optional[str] = None,
        trend_window: int = 5,
    ) -> SessionAccount:
        account = SessionAccount(
            identity=identity,
            priority=priority if priority in PRIORITIES else "normal",
            target_fps=target_fps,
            target_latency_ms=target_latency_ms,
            compute_units=compute_units,
            resource_id=resource_id,
            queue_trend=Trend(trend_window),
            latency_trend=Trend(trend_window),
        )
        self._accounts[self._key(identity)] = account
        return account

    def get(self, identity: SessionIdentity) -> Optional[SessionAccount]:
        return self._accounts.get(self._key(identity))

    def close(self, identity: SessionIdentity) -> Optional[SessionAccount]:
        """Release a session's account — nothing of it survives (refinement 7 / AI-5b rec 8)."""
        return self._accounts.pop(self._key(identity), None)

    def list(self, *, tenant_id: Optional[str] = None) -> List[SessionAccount]:
        out = list(self._accounts.values())
        if tenant_id is not None:
            out = [a for a in out if a.identity.tenant_id == tenant_id]
        return sorted(out, key=lambda a: a.identity.session_id)

    @property
    def count(self) -> int:
        return len(self._accounts)

    def attribute(self, snapshot) -> None:  # noqa: ANN001 - compute.ResourceSnapshot
        """Distribute the process-wide sample across sessions in proportion to measured work.

        These are ESTIMATES (one process, no per-session kernel accounting) — surfaced as such
        wherever they appear.
        """
        accounts = list(self._accounts.values())
        if not accounts:
            return
        weights = [a.inference_ms_total for a in accounts]
        total = sum(weights)
        if total <= 0:
            # No measured work yet: split evenly rather than attributing everything to one session.
            weights = [1.0] * len(accounts)
            total = float(len(accounts))
        for account, weight in zip(accounts, weights):
            share = weight / total
            account.cpu_percent = (
                None if snapshot.cpu_percent is None else snapshot.cpu_percent * share
            )
            account.memory_mb = None if snapshot.memory_mb is None else snapshot.memory_mb * share
            account.gpu_percent = (
                None if snapshot.gpu_percent is None else snapshot.gpu_percent * share
            )

    def totals(self) -> dict:
        """Fleet-level rollup — what every session costs together."""
        accounts = self.list()
        return {
            "sessions": len(accounts),
            "framesProcessed": sum(a.frames_processed for a in accounts),
            "computeUnits": round(sum(a.compute_units for a in accounts), 6),
            "slaMet": sum(1 for a in accounts if a.sla_met),
            "slaBreached": sum(1 for a in accounts if not a.sla_met),
            "degraded": sum(1 for a in accounts if a.degradation != "none"),
        }
