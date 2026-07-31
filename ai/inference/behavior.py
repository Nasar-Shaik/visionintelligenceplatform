"""Behavior Analysis core (AI-3) — the platform-owned seam that makes behaviors interchangeable.

The chain (each hop independent):  DetectionResult → Track → BehaviorResult → EventEnvelope

Design north star (Architect AI-3): **optimize for the BehaviorResult contract, not the behavior.**
Any analyzer — a temporal-window heuristic today, an ML/LLM reasoner tomorrow — sits behind
`BehaviorAnalyzer`, consumes the immutable `BehaviorContext`, and returns pure `BehaviorObservation`s.
It owns NO mutable state (rec 3): all timing lives in `TemporalWindow`; all lifecycle lives in the
`BehaviorLifecycleStore`. This is what lets a behavior's internals change while the rest of the platform
never knows (replay-deterministic — rec 8: a BehaviorResult is reproducible from snapshots + zone state
+ window + config).

Analyzer independence (rec 4/6): analyzers never call one another; the pipeline orchestrates them and
the store assigns lifecycle. Detector independence (rec 10/refinement 6): analyzers read normalized
TrackSnapshots + labels only, never a detector/tracker object. Boundary (rec 12): an analyzer states
*what was observed*, never *what to do* — severity/schedules/escalation are the Rule Engine's.
Stdlib-only, deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Protocol, Sequence, Tuple

from behavior_contracts import (
    BehaviorCategory,
    BehaviorConfig,
    BehaviorResult,
    BehaviorState,
    TrackSnapshot,
)
from temporal_window import TemporalWindowStore
from tracking_contracts import Track, Zone
from zones import ZoneEngine


def frame_seconds(timestamp: str, frame_index: int) -> float:
    """Best-effort numeric seconds for window timing. Parses a `<n>s` offset; falls back to the frame
    index (a monotonic proxy) for ISO/other formats — keeping timing deterministic without a clock."""
    if timestamp.endswith("s") and not timestamp.endswith("Z"):
        try:
            return float(timestamp[:-1])
        except ValueError:
            return float(frame_index)
    return float(frame_index)


def snapshot_track(track: Track, frame_index: int) -> TrackSnapshot:
    """Freeze a mutable Track into the immutable view analyzers consume (rec 5)."""
    return TrackSnapshot(
        track_id=track.track_id,
        tenant_id=track.tenant_id,
        camera_id=track.camera_id,
        label=track.label,
        state=track.state.value,
        confidence=track.confidence,
        bbox=track.bbox,
        age=track.age,
        hits=track.hits,
        frame_index=frame_index,
        at=track.last_seen_at,
        session_id=track.session_id,
        centroid=track.centroid,
        tracking_confidence=track.quality.tracking_confidence,
    )


@dataclass(frozen=True)
class BehaviorContext:
    """Immutable, shared per-frame input for ALL analyzers (Architect AI-3 rec 1). Analyzers consume
    ONLY this — never gathering their own data — so they stay isolated and deterministic. The lone
    mutable service exposed is the temporal-window store, which owns cross-frame timing state."""

    tenant_id: str
    camera_id: str
    frame_index: int
    at: str
    t: float  # numeric seconds for window timing
    snapshots: Tuple[TrackSnapshot, ...]
    zones: Tuple[Zone, ...]
    transitions: Tuple[dict, ...]
    counting: Tuple[dict, ...]
    windows: TemporalWindowStore
    zone_engine: ZoneEngine
    session_id: Optional[str] = None

    def zones_containing(self, point: Tuple[float, float]) -> List[str]:
        """Camera-scoped area zones whose polygon contains the point (geometry only — no business meaning)."""
        return self.zone_engine.areas_containing(point, self.zones, self.camera_id)

    def zone(self, zone_id: str) -> Optional[Zone]:
        for z in self.zones:
            if z.id == zone_id:
                return z
        return None

    def confirmed(self) -> List[TrackSnapshot]:
        """Confirmed-track snapshots only — the same discipline counting uses (no flicker double-count)."""
        return [s for s in self.snapshots if s.state == "confirmed"]


@dataclass
class BehaviorObservation:
    """What an analyzer reports for ONE active behavior instance in the current frame — a pure value,
    no lifecycle. The `BehaviorLifecycleStore` turns a stream of these into started/updated/ended
    `BehaviorResult`s. `key` is stable per instance (e.g. `zone:track`); `change_value`, when set, is
    the metric whose change warrants an `updated` emit (else only started + ended are emitted)."""

    key: str
    confidence: float
    subjects: List[str] = field(default_factory=list)
    metrics: Dict[str, float] = field(default_factory=dict)
    zone_id: Optional[str] = None
    window_ms: Optional[float] = None
    change_value: Optional[float] = None
    # Optional per-observation behaviorType override — lets ONE analyzer emit a small related family
    # (e.g. Fire/Smoke) while staying a single detector-independent unit. Defaults to the analyzer's.
    behavior_type: Optional[str] = None


class BehaviorAnalyzer(Protocol):
    """The single seam every behavior implements. Stateless: same inputs → same observations."""

    name: str
    behavior_type: str
    category: BehaviorCategory
    version: str
    config: BehaviorConfig

    def analyze(self, ctx: BehaviorContext) -> List[BehaviorObservation]:
        ...


class _Instance:
    __slots__ = (
        "behavior_id",
        "behavior_type",
        "category",
        "version",
        "producer",
        "correlation_id",
        "first_observed",
        "first_t",
        "last_obs",
        "last_at",
        "last_change",
    )

    def __init__(self, behavior_id: str, analyzer: "BehaviorAnalyzer", obs: BehaviorObservation, at: str, t: float, correlation_id: str) -> None:
        self.behavior_id = behavior_id
        self.behavior_type = obs.behavior_type or analyzer.behavior_type
        self.category = analyzer.category
        self.version = analyzer.version
        self.producer = analyzer.name
        self.correlation_id = correlation_id
        self.first_observed = at
        self.first_t = t
        self.last_obs = obs
        self.last_at = at
        self.last_change = obs.change_value


class BehaviorLifecycleStore:
    """Owns behavior-instance lifecycle across frames (Architect AI-3 rec 2) so analyzers stay stateless.
    Diffs each analyzer's active observations against the previous frame → started / updated / ended
    `BehaviorResult`s, with stable ids, correlation ids (refinement 4), and cooldown suppression."""

    def __init__(self, *, camera_id: str, session_id: Optional[str], tenant_id: str) -> None:
        self._camera_id = camera_id
        self._session_id = session_id or "sess"
        self._tenant_id = tenant_id
        self._instances: Dict[str, Dict[str, _Instance]] = {}
        self._cooldowns: Dict[Tuple[str, str], float] = {}
        self._seq = 0
        self._completed = 0
        self._durations: List[float] = []

    def _allocate(self) -> str:
        self._seq += 1
        return f"bhv_{self._camera_id}_{self._session_id}_{self._seq}"

    def _correlation(self, obs: BehaviorObservation, behavior_id: str) -> str:
        # Group behaviors born of the same track sequence under one id (no workflow logic attached).
        primary = obs.subjects[0] if obs.subjects else behavior_id
        return f"cor_{self._camera_id}_{self._session_id}_{primary}"

    def ingest(self, analyzer: BehaviorAnalyzer, observations: Sequence[BehaviorObservation], *, frame_index: int, at: str, t: float) -> List[BehaviorResult]:
        cfg = analyzer.config
        threshold = cfg.confidence_threshold
        cooldown = cfg.cooldown_seconds
        prev = self._instances.setdefault(analyzer.name, {})
        results: List[BehaviorResult] = []
        active_now: Dict[str, bool] = {}

        for obs in observations:
            if threshold is not None and obs.confidence < threshold:
                continue
            key = obs.key
            inst = prev.get(key)
            if inst is None:
                last_end = self._cooldowns.get((analyzer.name, key))
                if cooldown is not None and last_end is not None and (t - last_end) < cooldown:
                    continue  # suppressed within cooldown of the previous end
                behavior_id = self._allocate()
                inst = _Instance(behavior_id, analyzer, obs, at, t, self._correlation(obs, behavior_id))
                prev[key] = inst
                results.append(self._build(inst, obs, BehaviorState.STARTED, frame_index, at))
            elif obs.change_value is not None and obs.change_value != inst.last_change:
                results.append(self._build(inst, obs, BehaviorState.UPDATED, frame_index, at))
            inst.last_obs = obs
            inst.last_at = at
            inst.last_change = obs.change_value
            active_now[key] = True

        for key in [k for k in prev if k not in active_now]:
            inst = prev.pop(key)
            results.append(self._build(inst, inst.last_obs, BehaviorState.ENDED, frame_index, inst.last_at))
            self._cooldowns[(analyzer.name, key)] = t
            self._completed += 1
            self._durations.append(t - inst.first_t)
        return results

    def sweep(self, *, frame_index: int, at: str, t: float) -> List[BehaviorResult]:
        """Terminal flush at end-of-video: any still-active instance is `expired` (best-effort close)."""
        results: List[BehaviorResult] = []
        for insts in self._instances.values():
            for key in list(insts):
                inst = insts.pop(key)
                results.append(self._build(inst, inst.last_obs, BehaviorState.EXPIRED, frame_index, at))
                self._completed += 1
                self._durations.append(t - inst.first_t)
        self._instances.clear()
        return results

    def _build(self, inst: _Instance, obs: BehaviorObservation, state: BehaviorState, frame_index: int, at: str) -> BehaviorResult:
        return BehaviorResult(
            behavior_id=inst.behavior_id,
            behavior_type=inst.behavior_type,
            category=inst.category,
            tenant_id=self._tenant_id,
            camera_id=self._camera_id,
            state=state,
            confidence=obs.confidence,
            first_observed=inst.first_observed,
            last_observed=at,
            frame_index=frame_index,
            session_id=self._session_id,
            zone_id=obs.zone_id,
            subjects=list(obs.subjects),
            metrics=dict(obs.metrics),
            window_ms=obs.window_ms,
            producer=inst.producer,
            behavior_version=inst.version,
            correlation_id=inst.correlation_id,
        )

    def stats(self) -> dict:
        active = sum(len(insts) for insts in self._instances.values())
        avg_dur = round(sum(self._durations) / len(self._durations), 6) if self._durations else 0.0
        return {
            "startedBehaviors": self._seq,
            "activeBehaviors": active,
            "completedBehaviors": self._completed,
            "averageBehaviorDuration": avg_dur,
        }
