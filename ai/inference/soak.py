"""Long-duration soak testing (AI-5e, deliverable 5).

**Why drift and not level.** Every failure mode that actually matters in surveillance is a slow one.
A runtime that leaks 2 MB an hour looks perfect in a benchmark and dies on a Tuesday night three weeks
after handover, in a shop with no engineer. A latency that creeps 4% per hour passes every check until
the eleventh hour. So this framework does not ask "is memory acceptable" — it asks **"is memory the
same at hour 24 as it was at hour 1"**, which is a question a short run structurally cannot answer.

**Sampling, not streaming.** A soak run takes a periodic sample of the runtime's own reported state
(health score, queue, latency, memory, counters) and derives per-metric drift at the end. It adds no
instrumentation: every number comes from `SessionRunner.diagnostics()`, `HealthScore` and the process
RSS, which is what keeps a soak observational rather than a second, divergent view of the runtime.

**Determinism.** The sampler's clock and its sampling trigger are both injected, so a 72-hour soak can
be simulated in milliseconds by advancing a fake clock — the same trick the scheduler simulations use.
A soak you cannot run in CI is a soak nobody runs, and the *procedure* deserves regression tests even
though the *result* requires real hours on real hardware.

Stdlib-only.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence

from certification import EVIDENCE_CLASSES, evidence_for_source, weakest

#: The standard durations from the Architect's AI-5e brief. Any positive duration is accepted; these
#: are the ones the certification procedure names, so results stay comparable between sites.
STANDARD_DURATIONS_HOURS = (6.0, 12.0, 24.0, 48.0, 72.0)

#: Default tolerated drift per metric, as a percentage of the first sample. These are deliberately
#: tight for memory (a leak is a leak) and loose for latency (real machines have neighbours).
DEFAULT_TOLERANCES: Dict[str, float] = {
    "memoryMb": 10.0,
    "inferenceLatencyMs": 25.0,
    "fps": 10.0,
    "queueUtilization": 50.0,
    "healthScore": 15.0,
}

#: Metrics where a *decrease* is the regression (throughput, health) rather than an increase.
_HIGHER_IS_BETTER = frozenset({"fps", "healthScore"})


@dataclass
class SoakPolicy:
    """What a soak run measures and what it will tolerate."""

    planned_hours: float = 24.0
    #: Wall seconds between samples. 300s over 24h is 288 samples — enough to see a trend, small
    #: enough that the sample set itself never becomes the memory leak.
    sample_interval_seconds: float = 300.0
    tolerances: Dict[str, float] = field(default_factory=lambda: dict(DEFAULT_TOLERANCES))
    #: Restarts beyond this over the whole run fail the soak regardless of drift. A runtime that
    #: recovers forty times in a night is not stable, however good its final numbers look.
    max_restarts: int = 3
    #: Frame loss ceiling over the whole run (percent).
    max_dropped_percent: float = 1.0

    def tolerance_for(self, metric: str) -> Optional[float]:
        return self.tolerances.get(metric)


@dataclass(frozen=True)
class SoakSample:
    """One periodic observation. Frozen — a sample is history."""

    at_seconds: float
    metrics: Dict[str, float]
    restarts: int = 0
    recoveries: int = 0
    reconnects: int = 0
    degradations: int = 0
    frames_processed: int = 0
    frames_dropped: int = 0


@dataclass
class Drift:
    """How one metric moved across the run."""

    metric: str
    first: float
    last: float
    minimum: float
    maximum: float
    tolerated_percent: Optional[float] = None

    @property
    def drift(self) -> float:
        return self.last - self.first

    @property
    def drift_percent(self) -> float:
        if self.first == 0:
            # A metric that started at zero has no meaningful percentage. Reporting "infinite drift"
            # would fail every run whose first sample happened before the pipeline warmed up.
            return 0.0
        return round(100.0 * (self.last - self.first) / abs(self.first), 4)

    @property
    def status(self) -> str:
        if self.tolerated_percent is None:
            return "skipped"
        moved = self.drift_percent
        # Only the bad direction counts. Memory falling 30% is not a failure; fps falling 30% is.
        adverse = -moved if self.metric in _HIGHER_IS_BETTER else moved
        return "pass" if adverse <= self.tolerated_percent else "fail"

    def to_dict(self) -> dict:
        out = {
            "metric": self.metric,
            "first": round(self.first, 4),
            "last": round(self.last, 4),
            "min": round(self.minimum, 4),
            "max": round(self.maximum, 4),
            "drift": round(self.drift, 4),
            "driftPercent": self.drift_percent,
            "status": self.status,
        }
        if self.tolerated_percent is not None:
            out["toleratedPercent"] = self.tolerated_percent
        if self.metric in ("memoryMb", "healthScore", "fps"):
            out["unit"] = {"memoryMb": "MB", "healthScore": "score", "fps": "fps"}[self.metric]
        return out


class SoakRun:
    """Collects samples over a long run and turns them into a `SoakReport`.

    The run does not drive the runtime — it observes one. That separation matters: the same `SoakRun`
    watches a simulated fleet in CI and a real camera on a bench, and neither knows about the other.
    """

    def __init__(
        self,
        target_id: str,
        *,
        policy: Optional[SoakPolicy] = None,
        source_type: str = "simulated",
        runtime_version: str = "1.0.0",
        clock: Callable[[], float] = time.monotonic,
        now_iso: Callable[[], str] = None,  # noqa: ANN001
        environment: Optional[dict] = None,
    ) -> None:
        self.target_id = target_id
        self.policy = policy or SoakPolicy()
        self.runtime_version = runtime_version
        self.evidence_class = evidence_for_source(source_type)
        self._clock = clock
        self._now_iso = now_iso or _now_iso
        self.environment = environment
        self._started = self._clock()
        self._started_iso = self._now_iso()
        self._last_sample_at: Optional[float] = None
        self.samples: List[SoakSample] = []
        self.aborted_reason: Optional[str] = None

    # --- collection ---------------------------------------------------------

    @property
    def elapsed_hours(self) -> float:
        return max(0.0, (self._clock() - self._started) / 3600.0)

    @property
    def due(self) -> bool:
        """Whether the sampling interval has elapsed. Callers poll this instead of sleeping, so the
        caller keeps control of its own loop — a soak must never own the runtime's thread."""
        if self._last_sample_at is None:
            return True
        return (self._clock() - self._last_sample_at) >= self.policy.sample_interval_seconds

    def sample(self, metrics: Dict[str, float], **counters: int) -> SoakSample:
        """Record one observation. Counters are cumulative totals, not deltas."""
        entry = SoakSample(
            at_seconds=round(self._clock() - self._started, 3),
            metrics={k: float(v) for k, v in metrics.items() if v is not None},
            restarts=int(counters.get("restarts", 0)),
            recoveries=int(counters.get("recoveries", 0)),
            reconnects=int(counters.get("reconnects", 0)),
            degradations=int(counters.get("degradations", 0)),
            frames_processed=int(counters.get("frames_processed", 0)),
            frames_dropped=int(counters.get("frames_dropped", 0)),
        )
        self.samples.append(entry)
        self._last_sample_at = self._clock()
        return entry

    def sample_session(self, runner, **counters: int) -> Optional[SoakSample]:  # noqa: ANN001
        """Take a sample straight from a live `SessionRunner`. Reads only what the runtime already
        publishes — diagnostics + health — so the soak adds no instrumentation of its own."""
        diagnostics = runner.diagnostics()
        backpressure = dict(diagnostics.get("backpressure") or {})
        ingestion = dict(diagnostics.get("ingestion") or {})
        health = getattr(runner, "health", None) or (
            runner.score_health() if hasattr(runner, "score_health") else None
        )
        metrics: Dict[str, float] = {
            "queueUtilization": float(backpressure.get("queueUtilization") or 0.0),
            "processingDelayMs": float(backpressure.get("processingDelayMs") or 0.0),
            "availabilityPercent": float(ingestion.get("availabilityPercent") or 0.0),
        }
        if health is not None:
            metrics["healthScore"] = float(getattr(health, "score", 0.0))
        rss = _rss_mb()
        if rss is not None:
            metrics["memoryMb"] = rss
        return self.sample(
            metrics,
            restarts=counters.get("restarts", int(diagnostics.get("restartCount") or 0)),
            recoveries=counters.get("recoveries", 0),
            reconnects=counters.get("reconnects", int(ingestion.get("reconnectCount") or 0)),
            degradations=counters.get("degradations", 0),
            frames_processed=counters.get(
                "frames_processed", int(backpressure.get("framesProcessed") or 0)
            ),
            frames_dropped=counters.get(
                "frames_dropped", int(backpressure.get("framesDropped") or 0)
            ),
        )

    def abort(self, reason: str) -> None:
        """End the run early. The report records the actual duration, so a 3-hour abort can never be
        mistaken for a completed 24-hour soak."""
        self.aborted_reason = reason

    # --- analysis -----------------------------------------------------------

    def drift(self) -> List[Drift]:
        """Per-metric drift across the run. Metrics that appear in only one sample are skipped —
        a single reading has no trend, and inventing one from it would be fabrication."""
        if len(self.samples) < 2:
            return []
        names = sorted({name for s in self.samples for name in s.metrics})
        out: List[Drift] = []
        for name in names:
            series = [s.metrics[name] for s in self.samples if name in s.metrics]
            if len(series) < 2:
                continue
            out.append(
                Drift(
                    metric=name,
                    first=series[0],
                    last=series[-1],
                    minimum=min(series),
                    maximum=max(series),
                    tolerated_percent=self.policy.tolerance_for(name),
                )
            )
        return out

    def health_trend(self) -> List[float]:
        return [round(s.metrics["healthScore"], 2) for s in self.samples if "healthScore" in s.metrics]

    def blockers(self) -> List[str]:
        """Everything that stops this soak from passing."""
        out: List[str] = []
        if self.aborted_reason:
            out.append(f"run aborted: {self.aborted_reason}")
        if len(self.samples) < 2:
            out.append("fewer than two samples — no trend can be derived")
        elapsed = self.elapsed_hours
        if elapsed + 1e-6 < self.policy.planned_hours:
            out.append(
                f"ran {elapsed:.2f}h of a planned {self.policy.planned_hours:g}h"
            )
        for drift in self.drift():
            if drift.status == "fail":
                out.append(
                    f"{drift.metric} drifted {drift.drift_percent:+.1f}% "
                    f"(tolerance {drift.tolerated_percent:g}%)"
                )
        last = self.samples[-1] if self.samples else None
        if last is not None:
            if last.restarts > self.policy.max_restarts:
                out.append(f"{last.restarts} restarts exceeds the budget of {self.policy.max_restarts}")
            loss = _loss_percent(last)
            if loss > self.policy.max_dropped_percent:
                out.append(
                    f"dropped {loss:.2f}% of frames (ceiling {self.policy.max_dropped_percent:g}%)"
                )
        if not _is_hardware(self.evidence_class):
            out.append(
                f"evidence class is '{self.evidence_class}' — a soak certifies nothing without hardware"
            )
        return out

    def report(self, *, report_id: Optional[str] = None) -> dict:
        """A `SoakReport` dict. `passed` requires an unaborted full-duration run, every drift within
        tolerance, and hardware evidence — the same rule the compatibility report uses."""
        drift = self.drift()
        blockers = self.blockers()
        last = self.samples[-1] if self.samples else None
        trend = self.health_trend()
        out: dict = {
            "id": report_id or f"soak_{self.target_id}",
            "targetId": self.target_id,
            "runtimeVersion": self.runtime_version,
            "plannedHours": self.policy.planned_hours,
            "actualHours": round(self.elapsed_hours, 4),
            "samples": len(self.samples),
            "drift": [d.to_dict() for d in drift],
            "recoveries": last.recoveries if last else 0,
            "restarts": last.restarts if last else 0,
            "reconnects": last.reconnects if last else 0,
            "degradations": last.degradations if last else 0,
            "framesProcessed": last.frames_processed if last else 0,
            "droppedFramePercent": _loss_percent(last) if last else 0.0,
            "healthTrend": trend,
            "passed": not blockers,
            "blockers": blockers,
            "evidenceClass": self.evidence_class,
            "startedAt": self._started_iso,
            "recordedAt": self._now_iso(),
        }
        if trend:
            out["healthFirst"] = trend[0]
            out["healthLast"] = trend[-1]
            out["healthMin"] = min(trend)
        if self.environment:
            out["environment"] = dict(self.environment)
        return out


def render_report(report: dict) -> str:
    """A one-screen soak result. Drift is printed with its direction, because a leak and a recovery
    look identical if you only print magnitudes."""
    lines = [
        f"Soak — {report['targetId']}",
        "=" * (7 + len(str(report["targetId"]))),
        f"duration : {report['actualHours']:.2f}h of {report['plannedHours']:g}h planned · "
        f"{report['samples']} samples",
        f"counters : restarts={report['restarts']} recoveries={report['recoveries']} "
        f"reconnects={report['reconnects']} degradations={report['degradations']}",
        f"frames   : processed={report['framesProcessed']} dropped={report['droppedFramePercent']:.2f}%",
        f"evidence : {report['evidenceClass']}",
        "drift:",
    ]
    for d in report["drift"] or []:
        lines.append(
            f"  {d['metric']:<20} {d['first']:>10.2f} → {d['last']:>10.2f}  "
            f"({d['driftPercent']:+.1f}%)  {d['status']}"
        )
    if not report["drift"]:
        lines.append("  (no metric had two or more samples)")
    if report["healthTrend"]:
        lines.append(f"health   : {_sparkline(report['healthTrend'])}")
    lines.append(f"passed   : {'YES' if report['passed'] else 'NO'}")
    for blocker in report["blockers"]:
        lines.append(f"  - {blocker}")
    return "\n".join(lines)


_SPARK = "▁▂▃▄▅▆▇█"


def _sparkline(values: Sequence[float]) -> str:
    if not values:
        return ""
    return "".join(_SPARK[min(len(_SPARK) - 1, int(v / 100.0 * len(_SPARK)))] for v in values)


def _loss_percent(sample: SoakSample) -> float:
    total = sample.frames_processed + sample.frames_dropped
    return 0.0 if total <= 0 else round(100.0 * sample.frames_dropped / total, 4)


def _is_hardware(evidence_class: str) -> bool:
    return evidence_class == EVIDENCE_CLASSES[-1]


def _rss_mb() -> Optional[float]:
    """Resident set size in MB, or None where it cannot be read. Optional by design: a soak on a
    platform without `resource` still measures everything else rather than refusing to run."""
    try:
        import resource  # noqa: WPS433 - POSIX-only

        usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    except (ImportError, OSError):  # pragma: no cover - platform-dependent
        return None
    # Linux reports KB, macOS reports bytes.
    return round(usage / (1024.0 * 1024.0), 3) if usage > 1 << 20 else round(usage / 1024.0, 3)


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"


__all__ = [
    "STANDARD_DURATIONS_HOURS",
    "DEFAULT_TOLERANCES",
    "SoakPolicy",
    "SoakSample",
    "Drift",
    "SoakRun",
    "render_report",
    "weakest",
]
