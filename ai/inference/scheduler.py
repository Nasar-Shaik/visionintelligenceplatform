"""Inference Scheduler & Resource Governor (AI-5c) — stage 4 of AI_EXECUTION_ARCHITECTURE.

AI-5b gave each session its own bounded queue, which protects a session from its own camera. It does
NOT protect sessions from *each other*: eight cameras on one box still compete for one CPU, and
nothing decided who wins. This module decides — and, crucially, decides **before** the box is
saturated rather than after.

Three cooperating pieces, none of which is a new architectural layer (stage 4 was always in the
reference architecture, behind the unchanged `/infer` + `ModelAdapter` seam):

  - **`AdmissionController`** — refuses work the runtime cannot serve safely (rec 5). Accepting a
    ninth session that makes all nine miss their SLA is worse than refusing one.
  - **`InferenceScheduler`** — picks whose frame runs next, using weighted-fair rotation so a busy
    camera cannot starve seven quiet ones (rec 2/fairness), with optional batching.
  - **`ResourceGovernor`** — walks the ordered degradation ladder up under pressure and back down on
    relief (rec 3), preferring predicted pressure over observed (refinement 2) so it acts while there
    is still headroom to act.

**Machine-local independence** (rec 8): the scheduler talks only to `ComputeRegistry` (abstract units,
node-qualified ids) and `ResourceAccountant` (logical session identities). It never reads a core count,
a device handle, or a hostname. A distributed scheduler adds remote resources to the registry; nothing
here changes.

Every decision is recorded with a structured reason (rec 4) — "why did THIS camera get throttled at
3am?" is the question production asks, and free-text logs answer it badly.

Deterministic + stdlib-only: clock injected, no threads, no sleeps.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, List, Optional, Tuple

from compute import ComputeRegistry, ResourceSnapshot
from errors import ConfigurationFailure
from operational_log import OperationalLog, SessionIdentity
from resources import (
    DEGRADATION_LADDER,
    PRIORITIES,
    PRIORITY_WEIGHTS,
    ResourceAccountant,
    SessionAccount,
    ladder_index,
)

_DECISION_LOG_MAX = 200


@dataclass
class SchedulerPolicy:
    """Scheduler configuration — policy, not code. Mirrors the `SchedulerPolicy` contract."""

    strategy: str = "weighted-fair"
    max_batch_size: int = 1
    max_consecutive_per_session: int = 4
    degrade_above_queue_percent: float = 80.0
    recover_below_queue_percent: float = 50.0
    cpu_ceiling_percent: Optional[float] = None
    memory_ceiling_mb: Optional[float] = None
    min_degraded_fps: float = 1.0
    max_degradation: str = "suspended"
    reduced_resolution_scale: float = 0.5
    escalate_after_samples: int = 2
    recover_after_samples: int = 3
    admission_control: bool = True
    reserved_capacity_percent: float = 10.0
    reserve_for: Tuple[str, ...] = ("critical",)
    predictive: bool = True
    trend_window_samples: int = 5
    predicted_pressure_threshold: float = 95.0
    prediction_horizon_samples: int = 3

    def __post_init__(self) -> None:
        if self.strategy not in ("round-robin", "weighted-fair", "strict-priority"):
            raise ConfigurationFailure(f"unknown scheduling strategy '{self.strategy}'")
        if self.max_batch_size < 1:
            raise ConfigurationFailure("max_batch_size must be >= 1")
        if self.recover_below_queue_percent >= self.degrade_above_queue_percent:
            # Without a gap the governor would oscillate between rungs on every observation.
            raise ConfigurationFailure(
                "recover_below_queue_percent must be < degrade_above_queue_percent (hysteresis)"
            )
        if self.max_degradation not in DEGRADATION_LADDER:
            raise ConfigurationFailure(f"unknown degradation level '{self.max_degradation}'")


@dataclass
class SchedulerDecision:
    """One recorded decision — action, reason, and the measurement that triggered it (rec 4)."""

    identity: SessionIdentity
    action: str
    reason: str
    from_level: Optional[str] = None
    to_level: Optional[str] = None
    measurement: Dict[str, float] = field(default_factory=dict)
    detail: Optional[str] = None
    at: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {
            "identity": self.identity.to_dict(),
            "action": self.action,
            "reason": self.reason,
            "measurement": {k: round(float(v), 3) for k, v in self.measurement.items()},
        }
        for key, value in (
            ("fromLevel", self.from_level),
            ("toLevel", self.to_level),
            ("detail", self.detail),
            ("at", self.at),
        ):
            if value is not None:
                out[key] = value
        return out


@dataclass
class AdmissionVerdict:
    """The outcome of admission control. A refusal always carries an operator-readable `detail`."""

    admitted: bool
    detail: str
    resource_id: Optional[str] = None
    reason: Optional[str] = None
    estimate: Optional[dict] = None
    remaining_units: Optional[float] = None

    def to_dict(self) -> dict:
        out: dict = {"admitted": self.admitted, "detail": self.detail}
        for key, value in (
            ("resourceId", self.resource_id),
            ("reason", self.reason),
            ("estimate", self.estimate),
        ):
            if value is not None:
                out[key] = value
        if self.remaining_units is not None:
            out["remainingUnits"] = round(self.remaining_units, 6)
        return out


class DecisionLog:
    """A bounded, newest-first record of scheduler decisions (rec 4)."""

    def __init__(self, maxlen: int = _DECISION_LOG_MAX) -> None:
        self._entries: Deque[SchedulerDecision] = deque(maxlen=maxlen)

    def record(self, decision: SchedulerDecision) -> SchedulerDecision:
        self._entries.appendleft(decision)
        return decision

    def recent(self, limit: int = 20) -> List[dict]:
        return [d.to_dict() for d in list(self._entries)[: max(0, limit)]]

    def all(self) -> List[SchedulerDecision]:
        return list(self._entries)

    def __len__(self) -> int:
        return len(self._entries)


class AdmissionController:
    """Decides whether a new session can be served **safely** (rec 5).

    Estimates the session's cost from its target FPS and the placement resource's kind, then checks it
    against free capacity — honouring the reserve, which only privileged priorities may draw on
    (refinement 1). Refusing one session is how the other N keep their SLA.
    """

    def __init__(
        self,
        registry: ComputeRegistry,
        accountant: ResourceAccountant,
        policy: SchedulerPolicy,
        *,
        max_sessions: int = 8,
    ) -> None:
        self._registry = registry
        self._accountant = accountant
        self._policy = policy
        self._max_sessions = max_sessions

    def estimate(self, *, target_fps: float, kind: Optional[str] = None) -> dict:
        """Estimated cost of a session — the input to the decision, surfaced so operators can see it."""
        resource_kind = kind or ("cpu" if not self._registry.list() else self._registry.list()[0].kind)
        units = self._registry.unit_cost(resource_kind, target_fps=target_fps)
        return {
            "computeUnits": round(units, 6),
            "targetFps": round(float(target_fps), 3),
            "memoryMb": 0.0,
            "estimatedInferenceMs": 0.0,
        }

    def evaluate(
        self,
        identity: SessionIdentity,
        *,
        target_fps: float,
        priority: str = "normal",
        kinds: Optional[List[str]] = None,
    ) -> AdmissionVerdict:
        estimate = self.estimate(target_fps=target_fps, kind=(kinds or [None])[0])
        units = float(estimate["computeUnits"])

        if not self._policy.admission_control:
            resource = self._registry.place(units, kinds=kinds, privileged=True)
            return AdmissionVerdict(
                admitted=True,
                detail="admission control disabled",
                resource_id=resource.id if resource else None,
                estimate=estimate,
            )

        if self._accountant.count >= self._max_sessions:
            return AdmissionVerdict(
                admitted=False,
                reason="session-capacity",
                detail=(
                    f"session capacity reached ({self._accountant.count}/{self._max_sessions}); "
                    "stop a session before starting another"
                ),
                estimate=estimate,
            )

        privileged = priority in self._policy.reserve_for
        resource = self._registry.place(units, kinds=kinds, privileged=privileged)
        if resource is None:
            # Distinguish "nothing could ever serve this" from "the reserve is protecting the box".
            if self._registry.place(units, kinds=kinds, privileged=True) is not None:
                return AdmissionVerdict(
                    admitted=False,
                    reason="reserve-protected",
                    detail=(
                        f"only reserved capacity remains ({self._registry.reserved_percent:.0f}% held for "
                        f"{', '.join(self._policy.reserve_for)}); priority '{priority}' may not use it"
                    ),
                    estimate=estimate,
                    remaining_units=self._registry.unreserved_free_capacity,
                )
            if not self._registry.list(kind=(kinds or [None])[0]) and kinds:
                return AdmissionVerdict(
                    admitted=False,
                    reason="no-compatible-resource",
                    detail=f"no compute resource of kind {kinds} is registered",
                    estimate=estimate,
                )
            return AdmissionVerdict(
                admitted=False,
                reason="compute-capacity",
                detail=(
                    f"insufficient compute: need {units:.3f} units, "
                    f"{self._registry.free_capacity:.3f} free of {self._registry.total_capacity:.3f}"
                ),
                estimate=estimate,
                remaining_units=self._registry.free_capacity,
            )

        return AdmissionVerdict(
            admitted=True,
            detail=f"admitted to {resource.id} ({units:.3f} units)",
            resource_id=resource.id,
            estimate=estimate,
            remaining_units=max(0.0, resource.free_units - units),
        )


class ResourceGovernor:
    """Walks the degradation ladder up under pressure and back down on relief (rec 3).

    Two properties make this safe in production:
      - **Hysteresis.** Escalation needs `escalate_after_samples` consecutive pressure observations and
        recovery needs `recover_after_samples` — so a single spike does not throttle a camera, and a
        single dip does not un-throttle one. Without it the governor oscillates and the operator sees
        a camera flapping between rungs forever.
      - **Prediction.** With `predictive` on, the trigger is the queue utilization PROJECTED a few
        observations ahead (refinement 2). By the time utilization actually hits 100% frames are
        already being lost; a rising trend is actionable while there is still headroom.

    Degradation is always reversible: `suspended` is a rung, not a failure, and recovery walks the same
    ladder back down one step at a time.
    """

    def __init__(
        self,
        policy: SchedulerPolicy,
        accountant: ResourceAccountant,
        decisions: DecisionLog,
        *,
        analyzer_costs: Optional[dict] = None,
        protected_analyzers: Optional[List[str]] = None,
        now_iso: Optional[Callable[[], str]] = None,
        log: Optional[OperationalLog] = None,
    ) -> None:
        self._policy = policy
        self._accountant = accountant
        self._decisions = decisions
        self._analyzer_costs = dict(analyzer_costs or {})
        self._protected = set(protected_analyzers or [])
        self._now_iso = now_iso or _now_iso
        self._log = log
        self._pressure_streak: Dict[str, int] = {}
        self._relief_streak: Dict[str, int] = {}

    # --- the expensive-analyzer ordering (refinement 4) ---------------------------

    def most_expensive_analyzers(self, analyzers: List[str], *, count: int = 1) -> List[str]:
        """The `count` costliest analyzers that are not protected. Unlisted analyzers cost 1.0, so an
        un-modelled analyzer is neither favoured nor unfairly targeted."""
        candidates = [a for a in analyzers if a not in self._protected]
        ordered = sorted(candidates, key=lambda a: (-self._analyzer_costs.get(a, 1.0), a))
        return ordered[: max(0, count)]

    # --- the ladder ---------------------------------------------------------------

    def observe(
        self,
        account: SessionAccount,
        *,
        queue_utilization: float,
        event_latency_ms: float = 0.0,
        snapshot: Optional[ResourceSnapshot] = None,
    ) -> Optional[SchedulerDecision]:
        """Record one observation and escalate/recover at most ONE rung. Returns the decision taken,
        or None when nothing changed."""
        account.observe(queue_utilization=queue_utilization, event_latency_ms=event_latency_ms)
        key = account.identity.session_id

        pressure_reason = self._pressure_reason(account, snapshot)
        if pressure_reason is not None:
            self._relief_streak[key] = 0
            streak = self._pressure_streak.get(key, 0) + 1
            self._pressure_streak[key] = streak
            if streak >= self._policy.escalate_after_samples:
                self._pressure_streak[key] = 0
                return self._escalate(account, pressure_reason)
            return None

        # No pressure — count toward recovery.
        self._pressure_streak[key] = 0
        if account.degradation == "none":
            return None
        if queue_utilization > self._policy.recover_below_queue_percent:
            return None  # in the hysteresis band: neither degrade nor recover
        streak = self._relief_streak.get(key, 0) + 1
        self._relief_streak[key] = streak
        if streak >= self._policy.recover_after_samples:
            self._relief_streak[key] = 0
            return self._recover(account)
        return None

    def _pressure_reason(
        self, account: SessionAccount, snapshot: Optional[ResourceSnapshot]
    ) -> Optional[str]:
        """Which pressure (if any) justifies degrading — the reason recorded on the decision."""
        policy = self._policy
        if account.queue_utilization >= policy.degrade_above_queue_percent:
            return "queue-pressure"
        if policy.predictive:
            projected = account.queue_trend.project(policy.prediction_horizon_samples)
            if projected >= policy.predicted_pressure_threshold and account.queue_trend.slope > 0:
                return "predicted-pressure"
        if snapshot is not None:
            if (
                policy.cpu_ceiling_percent is not None
                and snapshot.cpu_percent is not None
                and snapshot.cpu_percent >= policy.cpu_ceiling_percent
            ):
                return "cpu-pressure"
            if (
                policy.memory_ceiling_mb is not None
                and snapshot.memory_mb is not None
                and snapshot.memory_mb >= policy.memory_ceiling_mb
            ):
                return "memory-pressure"
        return None

    def _escalate(self, account: SessionAccount, reason: str) -> Optional[SchedulerDecision]:
        current = ladder_index(account.degradation)
        ceiling = ladder_index(self._policy.max_degradation)
        if current >= ceiling:
            return None  # already at the configured ceiling — never escalate past policy
        nxt = DEGRADATION_LADDER[current + 1]
        if nxt == "suspended" and not self._may_suspend(account):
            # SAFETY: suspending the last running session means the runtime analyzes nothing at all,
            # which is strictly worse than every session running degraded. Discovered by the 32-camera
            # simulation, where unchecked escalation collapsed fleet throughput to zero.
            return None
        previous = account.degradation
        account.degradation = nxt
        decision = SchedulerDecision(
            identity=account.identity,
            action="suspended" if nxt == "suspended" else "degraded",
            reason=reason,
            from_level=previous,
            to_level=nxt,
            measurement={
                "queueUtilization": account.queue_utilization,
                "queueTrendSlope": account.queue_trend.slope,
                "projectedUtilization": account.queue_trend.project(
                    self._policy.prediction_horizon_samples
                ),
                "effectiveFps": account.effective_fps,
            },
            detail=f"{previous} → {nxt} ({reason})",
            at=self._now_iso(),
        )
        self._emit(decision)
        return self._decisions.record(decision)

    def _recover(self, account: SessionAccount) -> Optional[SchedulerDecision]:
        current = ladder_index(account.degradation)
        if current <= 0:
            return None
        nxt = DEGRADATION_LADDER[current - 1]
        previous = account.degradation
        account.degradation = nxt
        decision = SchedulerDecision(
            identity=account.identity,
            action="resumed" if previous == "suspended" else "recovered",
            reason="pressure-relieved",
            from_level=previous,
            to_level=nxt,
            measurement={"queueUtilization": account.queue_utilization},
            detail=f"{previous} → {nxt} (pressure relieved)",
            at=self._now_iso(),
        )
        self._emit(decision)
        return self._decisions.record(decision)

    def _may_suspend(self, account: SessionAccount) -> bool:
        """Whether suspending this session would leave the fleet with nothing running.

        This is a READ of the other accounts, never a write — sessions still share no mutable state
        (AI-5c refinement 7). The highest-priority session is also protected from suspension so the
        most important camera is the last thing standing, not an arbitrary survivor.
        """
        others = [a for a in self._accountant.list() if a.identity.session_id != account.identity.session_id]
        if not others:
            return False  # the only session — never suspend it
        running = [a for a in others if a.degradation != "suspended"]
        if not running:
            return False  # everyone else is already suspended; keep this one alive
        # Protect the fleet's highest priority: it should be the last to go.
        best = max(
            (a for a in self._accountant.list()),
            key=lambda a: PRIORITY_WEIGHTS.get(a.priority, 2),
        )
        return not (
            best.identity.session_id == account.identity.session_id
            and PRIORITY_WEIGHTS.get(account.priority, 2)
            > max((PRIORITY_WEIGHTS.get(a.priority, 2) for a in others), default=0)
        )

    def effective_fps_for(self, account: SessionAccount) -> float:
        """The analysis rate a session should run at, given its rung. Halves per FPS rung, floored at
        `min_degraded_fps` — a suspended session is 0."""
        if account.degradation == "suspended":
            return 0.0
        if ladder_index(account.degradation) >= ladder_index("reduced-fps"):
            return max(self._policy.min_degraded_fps, account.target_fps / 2.0)
        return account.target_fps

    def _emit(self, decision: SchedulerDecision) -> None:
        if self._log is None:
            return
        self._log.emit(
            f"scheduler.{decision.action}",
            level="warn" if decision.action in ("degraded", "suspended") else "info",
            reason=decision.reason,
            fromLevel=decision.from_level,
            toLevel=decision.to_level,
            **{k: round(v, 3) for k, v in decision.measurement.items()},
        )


class InferenceScheduler:
    """Decides which session's frame runs next across all sessions (stage 4).

    Weighted-fair rotation is the default because the failure it prevents — one busy camera starving
    seven quiet ones — is the common one in practice. `max_consecutive_per_session` bounds any single
    session's run even at `strict-priority`, so starvation is structurally impossible.

    The scheduler owns NO frames and NO queues; it answers "whose turn is it?" and the caller pulls.
    That keeps it usable by a future distributed scheduler (rec 8), which will ask the same question
    about sessions living on other nodes.
    """

    def __init__(
        self,
        registry: ComputeRegistry,
        accountant: ResourceAccountant,
        *,
        policy: Optional[SchedulerPolicy] = None,
        max_sessions: int = 8,
        now_iso: Optional[Callable[[], str]] = None,
        log: Optional[OperationalLog] = None,
        analyzer_costs: Optional[dict] = None,
        protected_analyzers: Optional[List[str]] = None,
    ) -> None:
        self._registry = registry
        self._accountant = accountant
        self._policy = policy or SchedulerPolicy()
        self._registry.reserved_percent = self._policy.reserved_capacity_percent
        self.decisions = DecisionLog()
        self.admission = AdmissionController(
            registry, accountant, self._policy, max_sessions=max_sessions
        )
        self.governor = ResourceGovernor(
            self._policy,
            accountant,
            self.decisions,
            analyzer_costs=analyzer_costs,
            protected_analyzers=protected_analyzers,
            now_iso=now_iso,
            log=log,
        )
        self._now_iso = now_iso or _now_iso
        self._log = log
        self._order: List[str] = []  # session ids in rotation order
        self._cursor = 0
        self._consecutive = 0
        self.passes = 0
        self.frames_scheduled = 0
        self.batches_dispatched = 0
        self.rotations = 0
        self.admissions_refused = 0
        self._shares: Dict[str, int] = {}
        self._credits: Dict[str, float] = {}

    @property
    def policy(self) -> SchedulerPolicy:
        return self._policy

    # --- registration -------------------------------------------------------------

    def admit(
        self,
        identity: SessionIdentity,
        *,
        target_fps: float = 5.0,
        priority: str = "normal",
        target_latency_ms: Optional[float] = None,
        kinds: Optional[List[str]] = None,
    ) -> Tuple[AdmissionVerdict, Optional[SessionAccount]]:
        """Run admission control and, on success, register the session with the scheduler."""
        if priority not in PRIORITIES:
            raise ConfigurationFailure(f"unknown priority '{priority}' (expected one of {PRIORITIES})")
        verdict = self.admission.evaluate(
            identity, target_fps=target_fps, priority=priority, kinds=kinds
        )
        if not verdict.admitted:
            self.admissions_refused += 1
            self.decisions.record(
                SchedulerDecision(
                    identity=identity,
                    action="refused",
                    reason=verdict.reason or "compute-exhausted",
                    measurement={"targetFps": target_fps},
                    detail=verdict.detail,
                    at=self._now_iso(),
                )
            )
            return verdict, None

        units = float((verdict.estimate or {}).get("computeUnits", 0.0))
        resource = self._registry.get(verdict.resource_id) if verdict.resource_id else None
        if resource is not None:
            resource.allocate(units)
        account = self._accountant.open(
            identity,
            priority=priority,
            target_fps=target_fps,
            target_latency_ms=target_latency_ms,
            compute_units=units,
            resource_id=verdict.resource_id,
            trend_window=self._policy.trend_window_samples,
        )
        self._order.append(identity.session_id)
        self._credits[identity.session_id] = float(PRIORITY_WEIGHTS.get(priority, 2))
        self._shares.setdefault(identity.session_id, 0)
        self.decisions.record(
            SchedulerDecision(
                identity=identity,
                action="admitted",
                reason="fair-share",
                measurement={"computeUnits": units, "targetFps": target_fps},
                detail=verdict.detail,
                at=self._now_iso(),
            )
        )
        return verdict, account

    def release(self, identity: SessionIdentity) -> None:
        """Deregister a session and hand its compute back. Idempotent — a double release must not
        manufacture capacity (AI-5b rec 8: nothing leaks)."""
        account = self._accountant.get(identity)
        if account is None:
            return
        if account.resource_id:
            resource = self._registry.get(account.resource_id)
            if resource is not None:
                resource.release(account.compute_units)
        self._accountant.close(identity)
        self._order = [s for s in self._order if s != identity.session_id]
        self._credits.pop(identity.session_id, None)
        if self._cursor >= len(self._order):
            self._cursor = 0
        self.decisions.record(
            SchedulerDecision(
                identity=identity,
                action="released",
                reason="operator-request",
                measurement={"computeUnits": account.compute_units},
                at=self._now_iso(),
            )
        )

    # --- scheduling ---------------------------------------------------------------

    def next_session(self, *, ready: Optional[Callable[[str], bool]] = None) -> Optional[str]:
        """The session id whose frame should run next, or None when nothing is runnable.

        `ready(session_id)` lets the caller report which sessions actually have a queued frame — the
        scheduler never inspects a queue, so it stays independent of where the queue lives (rec 8).
        """
        if not self._order:
            return None
        self.passes += 1
        candidates = [
            s
            for s in self._order
            if (ready is None or ready(s)) and not self._suspended(s)
        ]
        if not candidates:
            return None

        if self._policy.strategy == "strict-priority":
            chosen = max(candidates, key=lambda s: (self._weight(s), -self._shares.get(s, 0)))
        elif self._policy.strategy == "round-robin":
            chosen = self._rotate(candidates)
        else:  # weighted-fair
            # Serve the session furthest behind its weighted share — the deficit-round-robin idea,
            # which gives priority influence WITHOUT ever letting a low-priority session starve.
            chosen = min(candidates, key=lambda s: (self._shares.get(s, 0) / self._weight(s), s))

        # Anti-starvation: bound any one session's consecutive run, whatever the strategy.
        if chosen == self._current() and self._consecutive >= self._policy.max_consecutive_per_session:
            self.rotations += 1
            self._consecutive = 0
            others = [s for s in candidates if s != chosen]
            if others:
                chosen = self._rotate(others)
        self._consecutive = self._consecutive + 1 if chosen == self._current() else 1
        self._set_current(chosen)
        self._shares[chosen] = self._shares.get(chosen, 0) + 1
        self.frames_scheduled += 1
        return chosen

    def next_batch(self, *, ready: Optional[Callable[[str], bool]] = None) -> List[str]:
        """Up to `max_batch_size` session ids to run in one dispatch. Batching amortizes per-call model
        overhead; with `max_batch_size == 1` this is exactly `next_session`."""
        batch: List[str] = []
        for _ in range(self._policy.max_batch_size):
            chosen = self.next_session(ready=ready)
            if chosen is None:
                break
            batch.append(chosen)
        if batch:
            self.batches_dispatched += 1
        return batch

    def _rotate(self, candidates: List[str]) -> str:
        self._cursor = (self._cursor + 1) % len(candidates)
        return candidates[self._cursor]

    def _current(self) -> Optional[str]:
        return getattr(self, "_current_session", None)

    def _set_current(self, session_id: str) -> None:
        self._current_session = session_id

    def _weight(self, session_id: str) -> float:
        return max(1.0, self._credits.get(session_id, 2.0))

    def _suspended(self, session_id: str) -> bool:
        for account in self._accountant.list():
            if account.identity.session_id == session_id:
                return account.degradation == "suspended"
        return False

    # --- observability -------------------------------------------------------------

    def stats(self, *, snapshot: Optional[ResourceSnapshot] = None, decisions: int = 10) -> dict:
        """A `SchedulerStats`-shaped snapshot (camelCase; mirrors @vip/contracts)."""
        degraded: Dict[str, int] = {}
        for account in self._accountant.list():
            if account.degradation != "none":
                degraded[account.degradation] = degraded.get(account.degradation, 0) + 1
        out = {
            "strategy": self._policy.strategy,
            "registeredSessions": len(self._order),
            "passes": self.passes,
            "framesScheduled": self.frames_scheduled,
            "batchesDispatched": self.batches_dispatched,
            "averageBatchSize": round(
                self.frames_scheduled / self.batches_dispatched, 3
            )
            if self.batches_dispatched
            else 0.0,
            "rotations": self.rotations,
            "sharesBySession": dict(self._shares),
            "degradedSessions": degraded,
            "computeResources": self._registry.to_dict(),
            "recentDecisions": self.decisions.recent(decisions),
            "admissionsRefused": self.admissions_refused,
        }
        if snapshot is not None:
            out["resources"] = snapshot.to_dict()
        return out

    def fairness(self) -> dict:
        """How evenly work was distributed — the proof that fairness actually held.

        `spread` is max/min share across sessions; 1.0 is perfectly even. For weighted-fair it should
        approach the ratio of the priority weights, not 1.0, which is the whole point of weighting.
        """
        shares = [v for v in self._shares.values() if v > 0]
        if not shares:
            return {"sessions": 0, "spread": 1.0, "shares": {}}
        return {
            "sessions": len(shares),
            "spread": round(max(shares) / max(1, min(shares)), 4),
            "shares": dict(self._shares),
        }


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
