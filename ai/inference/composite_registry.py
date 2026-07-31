"""Composite Registry (AI-4, Architect rec 5/6 + refinement 8) — discovery + orchestration for
composite analyzers, the SECOND pass after primitive behaviors:

    Primitive Behaviors → Composite Pass → Translator → EventEnvelope

Like `BehaviorRegistry` but over `CompositeContext` (BehaviorResults, not Tracks). It adds two things:
  - **Cycle protection** (rec 5): a composite that (transitively) consumes its own output type is a
    circular graph; `validate_acyclic()` detects and rejects it at startup with a clear diagnostic.
  - **Composite metrics** (refinement 8): evaluations / matches / misses / latency / confidence.

Stdlib-only, deterministic.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Set

from behavior import BehaviorLifecycleStore, BehaviorObservation
from behavior_contracts import BehaviorResult
from composite import CompositeBehaviorAnalyzer, CompositeContext


class CompositeCycleError(ValueError):
    """Raised when composite definitions form a circular dependency (A→B→A)."""


@dataclass
class _CompositeStat:
    evaluations: int = 0
    matches: int = 0
    misses: int = 0
    total_time_ms: float = 0.0
    last_time_ms: float = 0.0
    confidence_sum: float = 0.0
    confidence_samples: int = 0
    produced: int = 0

    def to_metrics(self, analyzer: str) -> dict:
        avg_exec = self.total_time_ms / self.evaluations if self.evaluations else 0.0
        avg_conf = self.confidence_sum / self.confidence_samples if self.confidence_samples else 0.0
        return {
            "analyzer": analyzer,
            "evaluations": int(self.evaluations),
            "matches": int(self.matches),
            "misses": int(self.misses),
            "averageExecutionTimeMs": round(avg_exec, 6),
            "lastExecutionTimeMs": round(self.last_time_ms, 6),
            "averageConfidence": round(avg_conf, 6),
            "behaviorsProduced": int(self.produced),
        }


class CompositeRegistry:
    """A configurable, ordered set of composite analyzers + their per-analyzer runtime metrics."""

    def __init__(self, *, clock: Callable[[], float] = time.perf_counter) -> None:
        self._analyzers: Dict[str, CompositeBehaviorAnalyzer] = {}
        self._order: List[str] = []
        self._stats: Dict[str, _CompositeStat] = {}
        self._clock = clock

    def register(self, analyzer: CompositeBehaviorAnalyzer) -> "CompositeRegistry":
        if analyzer.name in self._analyzers:
            raise ValueError(f"composite '{analyzer.name}' already registered")
        self._analyzers[analyzer.name] = analyzer
        self._order.append(analyzer.name)
        self._stats[analyzer.name] = _CompositeStat()
        return self

    def names(self) -> List[str]:
        return list(self._order)

    def enabled(self) -> List[CompositeBehaviorAnalyzer]:
        return [self._analyzers[n] for n in self._order if self._analyzers[n].config.enabled]

    def validate_acyclic(self) -> None:
        """Reject circular composite graphs (Architect AI-4 rec 5). Edge: composite output type →
        each required type that is ALSO a composite output. A cycle over those edges is illegal."""
        outputs: Dict[str, Set[str]] = {}
        for a in self._analyzers.values():
            required = set(getattr(getattr(a, "rule", None), "required_types", []) or [])
            outputs.setdefault(a.behavior_type, set()).update(required)
        composite_types = {a.behavior_type for a in self._analyzers.values()}
        # Restrict edges to composite→composite (primitive types are leaves, never cyclic).
        graph = {t: {r for r in deps if r in composite_types} for t, deps in outputs.items()}

        WHITE, GREY, BLACK = 0, 1, 2
        color: Dict[str, int] = {t: WHITE for t in graph}

        def dfs(node: str, path: List[str]) -> None:
            color[node] = GREY
            for nxt in sorted(graph.get(node, set())):
                if color.get(nxt, WHITE) == GREY:
                    raise CompositeCycleError(
                        f"composite dependency cycle: {' → '.join(path + [nxt])}"
                    )
                if color.get(nxt, WHITE) == WHITE:
                    dfs(nxt, path + [nxt])
            color[node] = BLACK

        for t in sorted(graph):
            if color[t] == WHITE:
                dfs(t, [t])

    def run(self, ctx: CompositeContext, store: BehaviorLifecycleStore) -> List[BehaviorResult]:
        """One composite pass: each enabled analyzer independently evaluates the active BehaviorResults;
        the store assigns lifecycle; match/miss + latency + confidence metrics are recorded."""
        results: List[BehaviorResult] = []
        for analyzer in self.enabled():
            stat = self._stats[analyzer.name]
            t0 = self._clock()
            observations: List[BehaviorObservation] = analyzer.analyze(ctx)
            stat.last_time_ms = (self._clock() - t0) * 1000.0
            stat.total_time_ms += stat.last_time_ms
            stat.evaluations += 1
            if observations:
                stat.matches += 1
            else:
                stat.misses += 1
            for obs in observations:
                stat.confidence_sum += obs.confidence
                stat.confidence_samples += 1
            produced = store.ingest(analyzer, observations, frame_index=ctx.frame_index, at=ctx.at, t=ctx.t)
            stat.produced += len(produced)
            results.extend(produced)
        return results

    def analyzer_metrics(self) -> List[dict]:
        return [self._stats[n].to_metrics(n) for n in self._order]

    def aggregate_metrics(self) -> dict:
        evals = sum(s.evaluations for s in self._stats.values())
        matches = sum(s.matches for s in self._stats.values())
        misses = sum(s.misses for s in self._stats.values())
        total_time = sum(s.total_time_ms for s in self._stats.values())
        conf_sum = sum(s.confidence_sum for s in self._stats.values())
        conf_n = sum(s.confidence_samples for s in self._stats.values())
        return {
            "compositeEvaluations": int(evals),
            "compositeMatches": int(matches),
            "compositeMisses": int(misses),
            "averageCompositeLatency": round(total_time / evals, 6) if evals else 0.0,
            "compositeExecutionTime": round(total_time / evals, 6) if evals else 0.0,
            "averageCompositeConfidence": round(conf_sum / conf_n, 6) if conf_n else 0.0,
        }
