"""Session Health Monitoring (AI-5d) — health as a decomposed score and a trend, not a boolean.

Before AI-5d a session was `healthy` while its heartbeat was fresh and `degraded` otherwise. That
answers "is it alive?" and nothing else: a camera reconnecting every ninety seconds, dropping a third
of its frames and missing its SLA reports `healthy` right up until it stops entirely. This module
replaces that single bit with two things production actually needs:

  - **Decomposition** (Architect AI-5d rec 2). `overallHealth = 83` says something is wrong;
    `connection 98 · inference 81 · scheduler 76 · resources 92 · recovery 100` says *where*. Every
    component is required in the output, because a health report that silently omits a subsystem is
    exactly the report that sends someone looking in the wrong place.
  - **Projection** (rec 1). Each indicator carries a `Trend`, so the monitor reports not only where
    health *is* but where it is *heading*. Acting on the projection is what makes degradation
    preventive; by the time the observed score has collapsed, frames are already lost.

**Health decides nothing.** It produces evidence, and the `ResourceGovernor` remains the only thing
that moves a session down the degradation ladder. Two components able to degrade a session
independently is how you get an oscillation nobody can debug, so the seam is deliberate and narrow:
`HealthMonitor` → `predicted_decline` → the governor's existing pressure path.

**No new instrumentation.** Every indicator is derived from a measurement the runtime already
produces — AI-5b ingestion/backpressure stats and AI-5c session accounts. `frame-loss` is genuine
backpressure loss (`framesDropped`) and never sampling (`framesSkipped`); conflating them would
report a runtime as sick every time an operator lowered the frame rate.

Deterministic + stdlib-only: the clock is injected and scoring is pure arithmetic over inputs, so a
health score is reproducible in a unit test without a loaded machine.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from operational_log import SessionIdentity
from resources import Trend, ladder_index

# Mirrors @vip/contracts `HealthComponent`.
HEALTH_COMPONENTS = ("connection", "inference", "scheduler", "resources", "recovery")

# Mirrors `HealthIndicatorName` → the component each indicator rolls up into.
INDICATOR_COMPONENTS: Dict[str, str] = {
    "stream-availability": "connection",
    "reconnect-frequency": "connection",
    "inference-latency": "inference",
    "event-latency": "inference",
    "queue-growth": "scheduler",
    "frame-loss": "scheduler",
    "sla-attainment": "scheduler",
    "degradation-level": "scheduler",
    "cpu-utilization": "resources",
    "memory-utilization": "resources",
    "recovery-attempts": "recovery",
    "restart-frequency": "recovery",
}

# Reference latency (ms) used when a deployment declares no explicit budget. A default is needed for
# the indicator to exist at all; it is deliberately generous so an un-budgeted deployment is not
# reported as unhealthy for merely being un-budgeted.
_DEFAULT_LATENCY_BUDGET_MS = 250.0

# How much one occurrence costs, in score points. Linear and explainable on purpose: an operator can
# read "three reconnects, so connection lost 60 points" straight off the numbers.
_RECONNECT_PENALTY = 20.0
_RECOVERY_PENALTY = 25.0
_RESTART_PENALTY = 25.0
_DEGRADATION_PENALTY = 20.0

# A trend slope smaller than this is noise, not a direction.
_TREND_EPSILON = 0.5


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


@dataclass
class HealthPolicy:
    """Health scoring configuration — thresholds and weights as policy, never constants in code.

    Mirrors the `HealthPolicy` contract, so a deployment profile can make a hospital stricter than a
    parking lot without either one needing a code change.
    """

    component_weights: Dict[str, float] = field(default_factory=dict)
    degraded_below: float = 80.0
    unhealthy_below: float = 50.0
    trend_window_samples: int = 5
    projection_horizon_samples: int = 3
    predictive_degradation: bool = True
    stabilization_samples: int = 3

    def __post_init__(self) -> None:
        from errors import ConfigurationFailure

        if not 0 <= self.unhealthy_below < self.degraded_below <= 100:
            raise ConfigurationFailure(
                "health thresholds must satisfy 0 <= unhealthyBelow < degradedBelow <= 100 "
                f"(got {self.unhealthy_below} and {self.degraded_below})"
            )
        for component in self.component_weights:
            if component not in HEALTH_COMPONENTS:
                raise ConfigurationFailure(
                    f"unknown health component '{component}' (expected one of {HEALTH_COMPONENTS})"
                )

    def weight_for(self, component: str) -> float:
        return float(self.component_weights.get(component, 1.0))

    def status_for(self, score: float, *, samples: int = 1) -> str:
        """Map a score onto the four-value `SessionHealth` vocabulary.

        `down` means "running but not delivering usable service" — which is what an operator needs to
        see. It never contradicts the state-derived verdict: a stopped session is `down` either way,
        and the caller (`reconcile`) lets state win whenever the two could disagree.
        """
        if samples <= 0:
            return "unknown"
        if score >= self.degraded_below:
            return "healthy"
        if score > self.unhealthy_below:
            return "degraded"
        return "down"


@dataclass
class HealthIndicator:
    """One scored signal. `measured` is kept next to `score` deliberately — an operator needs the raw
    number ("queue at 91%") as well as the normalized one, because only the raw number is actionable."""

    name: str
    component: str
    score: float
    measured: Optional[float] = None
    slope: Optional[float] = None
    trend: str = "stable"
    weight: float = 1.0
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {
            "name": self.name,
            "component": self.component,
            "score": round(self.score, 3),
            "trend": self.trend,
            "weight": round(self.weight, 3),
        }
        for key, value in (("measured", self.measured), ("slope", self.slope)):
            if value is not None:
                out[key] = round(float(value), 3)
        if self.detail is not None:
            out["detail"] = self.detail
        return out


@dataclass
class HealthScore:
    """A session's composite operational health — mirrors the `HealthScore` contract."""

    identity: SessionIdentity
    score: float
    status: str
    components: Dict[str, float]
    indicators: List[HealthIndicator] = field(default_factory=list)
    trend: str = "stable"
    projected_score: Optional[float] = None
    projected_status: Optional[str] = None
    predicted_decline: bool = False
    samples: int = 0
    at: Optional[str] = None
    # Rolling per-component history, oldest first (Architect AI-5d follow-up rec 2). Operators care
    # more about the shape of the last N observations than about any single value: `82` means little,
    # `98 → 94 → 88 → 82` means something is going wrong right now.
    component_trends: Dict[str, List[float]] = field(default_factory=dict)

    def component(self, name: str) -> float:
        return self.components.get(name, 100.0)

    def sparkline(self, component: str, *, width: int = 10) -> str:
        """A fixed-width bar for one component, e.g. `████████░░` (rec 2).

        Rendered from the CURRENT score rather than the history, because the bar answers "how full is
        this subsystem's health right now?" — the trend answers the other question, and conflating
        the two into one glyph would make neither readable.
        """
        filled = int(round(self.component(component) / 100.0 * width))
        return "█" * max(0, min(width, filled)) + "░" * max(0, width - filled)

    def render_components(self, *, width: int = 10) -> str:
        """The whole breakdown as the operator view the Architect sketched (rec 2)."""
        rows = []
        for name in sorted(self.components):
            arrow = {"improving": "↑", "deteriorating": "↓", "stable": "→"}[
                _direction(_slope(self.component_trends.get(name, [])))
            ]
            rows.append(f"{name:<11} {self.sparkline(name, width=width)} {self.component(name):5.1f} {arrow}")
        return "\n".join(rows)

    @property
    def weakest_component(self) -> Optional[str]:
        """The subsystem dragging the score down — what an operator should look at first (rec 2)."""
        if not self.components:
            return None
        return min(sorted(self.components), key=lambda c: self.components[c])

    def to_dict(self) -> dict:
        out: dict = {
            "identity": self.identity.to_dict(),
            "score": round(self.score, 3),
            "status": self.status,
            "components": {k: round(v, 3) for k, v in sorted(self.components.items())},
            "indicators": [i.to_dict() for i in self.indicators],
            "trend": self.trend,
            "predictedDecline": self.predicted_decline,
            "samples": self.samples,
        }
        if self.component_trends:
            out["componentTrends"] = {
                k: [round(v, 3) for v in vs] for k, vs in sorted(self.component_trends.items())
            }
        if self.projected_score is not None:
            out["projectedScore"] = round(self.projected_score, 3)
        if self.projected_status is not None:
            out["projectedStatus"] = self.projected_status
        if self.at is not None:
            out["at"] = self.at
        return out


class HealthMonitor:
    """Scores ONE session's health over time. Owned exclusively by that session (AI-5c refinement 7).

    `observe()` is called on the supervisor's governor cadence, not per frame: health is a slow signal
    and sampling it per frame would make every trend a measure of frame-to-frame jitter.
    """

    def __init__(
        self,
        identity: SessionIdentity,
        *,
        policy: Optional[HealthPolicy] = None,
        now_iso: Optional[Callable[[], str]] = None,
    ) -> None:
        self.identity = identity
        self._policy = policy or HealthPolicy()
        self._now_iso = now_iso or _now_iso
        self._trends: Dict[str, Trend] = {}
        self._component_trends: Dict[str, Trend] = {
            component: Trend(self._policy.trend_window_samples) for component in HEALTH_COMPONENTS
        }
        self._score_trend = Trend(self._policy.trend_window_samples)
        self._samples = 0
        self._healthy_streak = 0
        self._last: Optional[HealthScore] = None

    @property
    def policy(self) -> HealthPolicy:
        return self._policy

    @property
    def samples(self) -> int:
        return self._samples

    @property
    def last(self) -> Optional[HealthScore]:
        return self._last

    @property
    def stabilized(self) -> bool:
        """Whether health has been non-degraded for `stabilization_samples` consecutive observations.

        This is the health-side input to the anti-oscillation guard (Architect AI-5d rec 6): a session
        that has just recovered has not *proven* anything until it stays recovered.
        """
        return self._healthy_streak >= self._policy.stabilization_samples

    def observe(
        self,
        *,
        account=None,  # noqa: ANN001 - resources.SessionAccount
        ingestion: Optional[dict] = None,
        backpressure: Optional[dict] = None,
        snapshot=None,  # noqa: ANN001 - compute.ResourceSnapshot
        recovery_attempts: int = 0,
        restart_count: int = 0,
        target_latency_ms: Optional[float] = None,
        memory_ceiling_mb: Optional[float] = None,
    ) -> HealthScore:
        """Record one observation and produce the current score.

        Every argument is optional because health must degrade gracefully with its inputs: a runtime
        with no resource monitor simply has no `resources` indicators, and scores the components it
        can actually see rather than inventing the ones it cannot.
        """
        indicators: List[HealthIndicator] = []
        ingestion = ingestion or {}
        backpressure = backpressure or {}

        # --- connection ------------------------------------------------------------
        if "availabilityPercent" in ingestion:
            indicators.append(
                self._indicator(
                    "stream-availability",
                    score=_clamp(float(ingestion["availabilityPercent"])),
                    measured=float(ingestion["availabilityPercent"]),
                    detail="share of session uptime the source was connected",
                )
            )
        reconnects = float(ingestion.get("reconnectCount", getattr(account, "reconnect_count", 0) or 0))
        indicators.append(
            self._indicator(
                "reconnect-frequency",
                score=_clamp(100.0 - _RECONNECT_PENALTY * reconnects),
                measured=reconnects,
                detail=f"{int(reconnects)} reconnect(s) this session",
            )
        )

        # --- inference -------------------------------------------------------------
        budget = float(target_latency_ms or _DEFAULT_LATENCY_BUDGET_MS)
        if account is not None:
            indicators.append(
                self._latency_indicator(
                    "inference-latency", account.inference_latency_ms, budget
                )
            )
            indicators.append(
                self._latency_indicator("event-latency", account.event_latency_ms, budget)
            )

        # --- scheduler -------------------------------------------------------------
        utilization = float(
            backpressure.get("queueUtilization", getattr(account, "queue_utilization", 0.0) or 0.0)
        )
        indicators.append(
            self._indicator(
                "queue-growth",
                score=_clamp(100.0 - utilization),
                measured=utilization,
                detail="bounded-queue occupancy; rising occupancy precedes frame loss",
            )
        )
        processed = float(backpressure.get("framesProcessed", getattr(account, "frames_processed", 0) or 0))
        # `framesDropped` ONLY — `framesSkipped` is deliberate sampling and is not a health signal.
        dropped = float(backpressure.get("framesDropped", getattr(account, "dropped_frames", 0) or 0))
        total = processed + dropped
        loss_percent = (100.0 * dropped / total) if total > 0 else 0.0
        indicators.append(
            self._indicator(
                "frame-loss",
                score=_clamp(100.0 - loss_percent),
                measured=loss_percent,
                detail="backpressure loss only; sampled-away frames are not loss",
            )
        )
        if account is not None:
            indicators.append(
                self._indicator(
                    "sla-attainment",
                    score=_clamp(account.attainment_percent),
                    measured=account.attainment_percent,
                    detail="actual vs target FPS",
                )
            )
            level = ladder_index(account.degradation)
            indicators.append(
                self._indicator(
                    "degradation-level",
                    score=_clamp(100.0 - _DEGRADATION_PENALTY * level),
                    measured=float(level),
                    detail=f"degradation rung '{account.degradation}'",
                )
            )

        # --- resources -------------------------------------------------------------
        if snapshot is not None and getattr(snapshot, "cpu_percent", None) is not None:
            cpu = float(snapshot.cpu_percent)
            indicators.append(
                self._indicator(
                    "cpu-utilization",
                    score=_clamp(100.0 - cpu),
                    measured=cpu,
                    detail="process CPU share (attributed, not per-session kernel accounting)",
                )
            )
        if (
            snapshot is not None
            and getattr(snapshot, "memory_mb", None) is not None
            and memory_ceiling_mb
        ):
            used = float(snapshot.memory_mb)
            indicators.append(
                self._indicator(
                    "memory-utilization",
                    score=_clamp(100.0 * (1.0 - used / max(1.0, memory_ceiling_mb))),
                    measured=used,
                    detail=f"RSS against the {memory_ceiling_mb:g} MB ceiling",
                )
            )

        # --- recovery --------------------------------------------------------------
        indicators.append(
            self._indicator(
                "recovery-attempts",
                score=_clamp(100.0 - _RECOVERY_PENALTY * float(recovery_attempts)),
                measured=float(recovery_attempts),
                detail=f"{recovery_attempts} recovery attempt(s) in the current window",
            )
        )
        indicators.append(
            self._indicator(
                "restart-frequency",
                score=_clamp(100.0 - _RESTART_PENALTY * float(restart_count)),
                measured=float(restart_count),
                detail=f"{restart_count} restart(s) this session",
            )
        )

        return self._compose(indicators)

    # --- scoring internals ---------------------------------------------------------

    def _indicator(
        self,
        name: str,
        *,
        score: float,
        measured: Optional[float] = None,
        detail: Optional[str] = None,
    ) -> HealthIndicator:
        trend = self._trends.setdefault(name, Trend(self._policy.trend_window_samples))
        trend.observe(score)
        slope = trend.slope
        return HealthIndicator(
            name=name,
            component=INDICATOR_COMPONENTS[name],
            score=score,
            measured=measured,
            slope=slope,
            trend=_direction(slope),
            weight=1.0,
            detail=detail,
        )

    def _latency_indicator(self, name: str, measured: float, budget: float) -> HealthIndicator:
        """Latency scores as budget/actual: at or under budget is 100, double the budget is 50.

        Ratio rather than subtraction because latency budgets differ by an order of magnitude across
        deployments, and a fixed points-per-millisecond penalty would be meaningless in both.
        """
        score = 100.0 if measured <= 0 else _clamp(100.0 * budget / max(measured, 1e-6))
        return self._indicator(
            name,
            score=score,
            measured=measured,
            detail=f"{measured:.1f} ms against a {budget:g} ms budget",
        )

    def _compose(self, indicators: List[HealthIndicator]) -> HealthScore:
        by_component: Dict[str, List[HealthIndicator]] = {c: [] for c in HEALTH_COMPONENTS}
        for indicator in indicators:
            by_component[indicator.component].append(indicator)

        components: Dict[str, float] = {}
        for component in HEALTH_COMPONENTS:
            found = by_component[component]
            # A component with no observable indicator scores 100 rather than 0: absence of a reading
            # is not evidence of ill health, and a missing GPU probe must not fail a healthy box.
            components[component] = (
                sum(i.score * i.weight for i in found) / sum(i.weight for i in found)
                if found
                else 100.0
            )

        for component, value in components.items():
            self._component_trends[component].observe(value)

        weights = {c: self._policy.weight_for(c) for c in HEALTH_COMPONENTS}
        total_weight = sum(weights.values()) or 1.0
        score = sum(components[c] * weights[c] for c in HEALTH_COMPONENTS) / total_weight

        self._samples += 1
        self._score_trend.observe(score)
        status = self._policy.status_for(score, samples=self._samples)
        self._healthy_streak = self._healthy_streak + 1 if status == "healthy" else 0

        projected = _clamp(self._score_trend.project(self._policy.projection_horizon_samples))
        projected_status = self._policy.status_for(projected, samples=self._samples)
        # A decline is "predicted" only when the projection crosses a threshold the CURRENT score has
        # not — otherwise the governor would be told to act on something already visible to it.
        predicted_decline = bool(
            self._policy.predictive_degradation
            and self._samples >= 2
            and status == "healthy"
            and projected < self._policy.degraded_below
            and self._score_trend.slope < -_TREND_EPSILON
        )

        result = HealthScore(
            identity=self.identity,
            score=score,
            status=status,
            components=components,
            indicators=indicators,
            trend=_direction(self._score_trend.slope),
            projected_score=projected,
            projected_status=projected_status,
            predicted_decline=predicted_decline,
            samples=self._samples,
            at=self._now_iso(),
            component_trends={k: t.samples for k, t in self._component_trends.items()},
        )
        self._last = result
        return result

    def reconcile(self, score: HealthScore, state: Optional[str]) -> HealthScore:
        """Let the session's lifecycle state override the scored status where the two could disagree.

        The score explains *why* a session is unwell; it never gets to claim a stopped session is
        healthy. State is authoritative for existence, the score for quality of service.
        """
        if state in ("stopped", "failed"):
            score.status = "down"
        elif state == "created":
            score.status = "unknown"
        return score

    def reset(self) -> None:
        """Forget every trend — used on restart, when history describes a session that no longer is."""
        self._trends.clear()
        for trend in self._component_trends.values():
            trend.reset()
        self._score_trend.reset()
        self._samples = 0
        self._healthy_streak = 0
        self._last = None


def _slope(samples: List[float]) -> float:
    """Least-squares slope over a plain list — the same estimator `Trend` uses, for rendering a
    trend that was serialized rather than held live."""
    n = len(samples)
    if n < 2:
        return 0.0
    mean_x = (n - 1) / 2.0
    mean_y = sum(samples) / n
    numerator = sum((x - mean_x) * (y - mean_y) for x, y in enumerate(samples))
    denominator = sum((x - mean_x) ** 2 for x in range(n))
    return numerator / denominator if denominator else 0.0


def _direction(slope: float) -> str:
    if slope > _TREND_EPSILON:
        return "improving"
    if slope < -_TREND_EPSILON:
        return "deteriorating"
    return "stable"


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
