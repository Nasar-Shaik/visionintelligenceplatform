"""Behavior Registry (AI-3, Architect rec 2 + 13) — discovery + orchestration for behavior analyzers.

Analyzers are registered (not hardcoded into the pipeline), and can be enabled / disabled / reconfigured
without touching pipeline code — so future capabilities (abandoned object, tailgating, crowd density,
running, slip/fall, vehicle analytics, PPE compliance, custom customer behaviors) drop in as new
analyzers with zero architectural change. The registry is the ORCHESTRATOR (rec 4): it runs each
enabled analyzer in a deterministic order, feeds their stateless observations to the shared
`BehaviorLifecycleStore`, and records per-analyzer metrics (refinement 7). Analyzers never call one
another. Stdlib-only, deterministic.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from behavior import BehaviorAnalyzer, BehaviorContext, BehaviorLifecycleStore
from behavior_contracts import BehaviorConfig, BehaviorResult


@dataclass
class _AnalyzerStat:
    executions: int = 0
    total_time_ms: float = 0.0
    last_time_ms: float = 0.0
    confidence_sum: float = 0.0
    confidence_samples: int = 0
    produced: int = 0

    def to_metrics(self, analyzer: str) -> dict:
        avg_exec = self.total_time_ms / self.executions if self.executions else 0.0
        avg_conf = self.confidence_sum / self.confidence_samples if self.confidence_samples else 0.0
        return {
            "analyzer": analyzer,
            "executionCount": int(self.executions),
            "averageExecutionTimeMs": round(avg_exec, 6),
            "lastExecutionTimeMs": round(self.last_time_ms, 6),
            "averageConfidence": round(avg_conf, 6),
            "behaviorsProduced": int(self.produced),
        }


class BehaviorRegistry:
    """A configurable, ordered set of behavior analyzers + their per-analyzer runtime metrics."""

    def __init__(self, *, clock: Callable[[], float] = time.perf_counter) -> None:
        self._analyzers: Dict[str, BehaviorAnalyzer] = {}
        self._order: List[str] = []
        self._stats: Dict[str, _AnalyzerStat] = {}
        self._clock = clock

    def register(self, analyzer: BehaviorAnalyzer) -> "BehaviorRegistry":
        if analyzer.name in self._analyzers:
            raise ValueError(f"analyzer '{analyzer.name}' already registered")
        self._analyzers[analyzer.name] = analyzer
        self._order.append(analyzer.name)
        self._stats[analyzer.name] = _AnalyzerStat()
        return self

    def enable(self, name: str) -> None:
        self._require(name).config.enabled = True

    def disable(self, name: str) -> None:
        self._require(name).config.enabled = False

    def configure(self, name: str, config: BehaviorConfig) -> None:
        self._require(name).config = config

    def _require(self, name: str) -> BehaviorAnalyzer:
        if name not in self._analyzers:
            raise KeyError(f"unknown analyzer '{name}'")
        return self._analyzers[name]

    def names(self) -> List[str]:
        return list(self._order)

    def enabled(self) -> List[BehaviorAnalyzer]:
        """Enabled analyzers in deterministic registration order (Architect rec 4 — pipeline owns order)."""
        return [self._analyzers[n] for n in self._order if self._analyzers[n].config.enabled]

    def run(self, ctx: BehaviorContext, store: BehaviorLifecycleStore) -> List[BehaviorResult]:
        """Orchestrate one frame: each enabled analyzer independently consumes `ctx`; the store assigns
        lifecycle; per-analyzer metrics are recorded. Analyzers never see each other's output."""
        results: List[BehaviorResult] = []
        for analyzer in self.enabled():
            stat = self._stats[analyzer.name]
            t0 = self._clock()
            observations = analyzer.analyze(ctx)
            stat.last_time_ms = (self._clock() - t0) * 1000.0
            stat.total_time_ms += stat.last_time_ms
            stat.executions += 1
            for obs in observations:
                stat.confidence_sum += obs.confidence
                stat.confidence_samples += 1
            produced = store.ingest(analyzer, observations, frame_index=ctx.frame_index, at=ctx.at, t=ctx.t)
            stat.produced += len(produced)
            results.extend(produced)
        return results

    def analyzer_metrics(self) -> List[dict]:
        """Per-analyzer breakdown (refinement 7) — spot a slow/noisy analyzer in production."""
        return [self._stats[n].to_metrics(n) for n in self._order]

    def aggregate_metrics(self, *, frames: int, behavior_latency_ms: float) -> dict:
        """Aggregate behavior counters for additive RuntimeMetrics fields (Architect rec 8)."""
        total_exec = sum(s.total_time_ms for s in self._stats.values())
        total_invocations = sum(s.executions for s in self._stats.values())
        confs = [(s.confidence_sum, s.confidence_samples) for s in self._stats.values()]
        conf_sum = sum(c for c, _ in confs)
        conf_n = sum(n for _, n in confs)
        return {
            "analyzerExecutionTime": round(total_exec / total_invocations, 6) if total_invocations else 0.0,
            "analyzerInvocationCount": int(total_invocations),
            "averageBehaviorConfidence": round(conf_sum / conf_n, 6) if conf_n else 0.0,
            "behaviorLatency": round(behavior_latency_ms / max(1, frames), 6),
        }
