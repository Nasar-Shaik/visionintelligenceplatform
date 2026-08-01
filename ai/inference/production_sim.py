"""Production Condition Simulations (AI-5d rec 7) — prove operational logic before real hardware.

AI-5c's `scheduler_sim` proved the scheduler under steady load at 4/8/16/32 cameras. Steady load is
not what production looks like. Production is a warehouse where the Wi-Fi drops at 2am and eighteen
cameras reconnect in the same second; a model upgrade that fails on every retry; a GPU that
disappears mid-shift; a camera that flaps between working and broken for six hours.

This module scripts those conditions and asserts what the runtime must do under each (Architect AI-5d
rec 7). As in AI-5c, the *load* is synthetic and every *decision* is production code — `AutoRecovery`,
`ResourceGovernor`, `InferenceScheduler` and `HealthMonitor` are the real classes. What is faked is
only the world they react to, which is exactly the part that would otherwise need a warehouse.

Every scenario returns a `ScenarioResult` carrying its own **invariants**: the properties that must
hold regardless of how the load happened to land. A scenario "passes" when no invariant was violated,
which is a stronger and more honest claim than "it did not crash".

Deterministic by construction: a seeded generator, an injected clock, no threads, no wall-clock, no
network. Two runs produce byte-identical output.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from compute import ComputeRegistry, ComputeResource, ResourceSnapshot
from errors import ConfigurationFailure, ConnectionFailure, ModelFailure
from health import HealthMonitor, HealthPolicy
from operational_log import SessionIdentity
from recovery import AutoRecovery, RecoveryPolicy
from resources import ResourceAccountant
from scheduler import InferenceScheduler, SchedulerPolicy
from scheduler_sim import SimulatedSession

# The condition set the Architect named across AI-5c and AI-5d, as one suite.
SCENARIOS = (
    "prolonged-operation",
    "intermittent-disconnects",
    "burst-reconnects",
    "varying-frame-rates",
    "heterogeneous-hardware",
    "mixed-priorities",
    "degraded-hardware",
    "repeated-model-failures",
    "simultaneous-recoveries",
    "recovery-storm",
)


class SimClock:
    """A clock the simulation drives by hand. Recovery budgets and cooldowns are time-based, so a
    real clock would make every budget assertion a race — this makes them arithmetic."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = float(start)

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> float:
        self.now += float(seconds)
        return self.now


@dataclass
class ScenarioResult:
    """What one scenario observed, and which of its invariants held."""

    scenario: str
    cameras: int
    ticks: int
    metrics: Dict[str, float] = field(default_factory=dict)
    violations: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.violations

    def check(self, condition: bool, message: str) -> bool:
        """Assert an invariant. A violation is recorded, never raised — a scenario must report every
        problem it found, not only the first."""
        if not condition:
            self.violations.append(message)
        return condition

    def to_dict(self) -> dict:
        return {
            "scenario": self.scenario,
            "cameras": self.cameras,
            "ticks": self.ticks,
            "passed": self.passed,
            "metrics": {k: round(float(v), 3) for k, v in sorted(self.metrics.items())},
            "violations": list(self.violations),
            "notes": list(self.notes),
        }


def _fixed_iso() -> str:
    """A fixed timestamp — simulation output must be byte-identical across runs."""
    return "2026-08-01T00:00:00.000Z"


def _rig(
    cameras: int,
    *,
    policy: Optional[SchedulerPolicy] = None,
    resources: Optional[List[ComputeResource]] = None,
    capacity_per_camera: float = 1.0,
    priorities: Optional[List[str]] = None,
    target_fps: float = 5.0,
    queue_capacity: int = 32,
):
    """Build a real scheduler over synthetic sessions — the shared setup for every scenario."""
    registry = ComputeRegistry(
        resources
        if resources is not None
        else [ComputeResource(id="cpu:0", kind="cpu", capacity_units=cameras * capacity_per_camera)]
    )
    accountant = ResourceAccountant()
    scheduler = InferenceScheduler(
        registry,
        accountant,
        policy=policy or SchedulerPolicy(),
        max_sessions=cameras,
        now_iso=_fixed_iso,
    )
    sessions: Dict[str, SimulatedSession] = {}
    for index in range(cameras):
        identity = SessionIdentity("tnt_sim", f"cam_{index}", f"ses_{index}")
        priority = priorities[index % len(priorities)] if priorities else "normal"
        verdict, _account = scheduler.admit(identity, target_fps=target_fps, priority=priority)
        if verdict.admitted:
            sessions[identity.session_id] = SimulatedSession(
                identity=identity,
                priority=priority,
                target_fps=target_fps,
                arrival_per_tick=1.0,
                queue_capacity=queue_capacity,
            )
    return registry, accountant, scheduler, sessions


def _pump(scheduler, accountant, sessions, *, ticks: int, govern_every: int = 10, rng=None) -> dict:
    """Run the standard arrive → schedule → govern loop. Returns aggregate counters."""
    degradations = 0
    for tick in range(ticks):
        for session in sessions.values():
            account = accountant.get(session.identity)
            level = account.degradation if account is not None else "none"
            if level == "suspended":
                session.queue_depth = max(0.0, session.queue_depth - 1.0)
                continue
            if level in ("reduced-fps", "reduced-resolution", "reduced-behaviors"):
                session.arrive_reduced()
            else:
                session.arrive()
        chosen = scheduler.next_session(
            ready=lambda sid: sid in sessions and sessions[sid].queue_depth >= 1
        )
        if chosen is not None and chosen in sessions:
            sessions[chosen].serve()
            account = accountant.get(sessions[chosen].identity)
            if account is not None:
                account.frames_processed += 1
                account.inference_ms_total += 1.0
                account.effective_fps = account.target_fps
        if govern_every > 0 and tick % govern_every == 0:
            snapshot = ResourceSnapshot()
            for session in sessions.values():
                account = accountant.get(session.identity)
                if account is None:
                    continue
                account.dropped_frames = session.dropped
                if scheduler.governor.observe(
                    account, queue_utilization=session.utilization, snapshot=snapshot
                ):
                    degradations += 1
    return {
        "served": sum(s.served for s in sessions.values()),
        "dropped": sum(s.dropped for s in sessions.values()),
        "degradations": degradations,
    }


# --- the scenarios --------------------------------------------------------------------------------


def prolonged_operation(*, cameras: int = 8, ticks: int = 2000) -> ScenarioResult:
    """A session that runs for days must cost what a session that runs for a minute costs.

    The failure this catches is the one that never appears in a short test: an unbounded buffer that
    is invisible at 200 ticks and fatal at 200,000.
    """
    result = ScenarioResult(scenario="prolonged-operation", cameras=cameras, ticks=ticks)
    _reg, accountant, scheduler, sessions = _rig(cameras)
    totals = _pump(scheduler, accountant, sessions, ticks=ticks)

    decision_log = len(scheduler.decisions)
    trend_samples = max(
        (len(a.queue_trend.samples) for a in accountant.list()), default=0
    )
    result.metrics.update(
        {
            "served": totals["served"],
            "decisionLogEntries": decision_log,
            "maxTrendSamples": trend_samples,
            "sharesTracked": len(scheduler.fairness()["shares"]),
        }
    )
    result.check(decision_log <= 200, f"decision log grew unbounded ({decision_log} entries)")
    result.check(
        trend_samples <= scheduler.policy.trend_window_samples,
        f"trend window grew unbounded ({trend_samples} samples)",
    )
    result.check(totals["served"] > 0, "no frames were served over a prolonged run")
    result.check(
        len(scheduler.fairness()["shares"]) == len(sessions),
        "share bookkeeping grew beyond the session count",
    )
    result.notes.append(
        f"{ticks} ticks; every per-session store stayed bounded at its configured window"
    )
    return result


def intermittent_disconnects(*, cameras: int = 8, ticks: int = 400, seed: int = 7) -> ScenarioResult:
    """Cameras drop and return at random. Availability must be accounted, not merely survived."""
    result = ScenarioResult(scenario="intermittent-disconnects", cameras=cameras, ticks=ticks)
    rng = random.Random(seed)
    _reg, accountant, scheduler, sessions = _rig(cameras)
    clock = SimClock()
    recovery = AutoRecovery(
        policy=RecoveryPolicy(max_restarts=20, stabilization_seconds=0.0),
        clock=clock,
        now_iso=_fixed_iso,
    )
    disconnects = recovered = 0
    for tick in range(ticks):
        clock.advance(1.0)
        for session in sessions.values():
            if rng.random() < 0.02:  # ~2% chance per camera per tick
                disconnects += 1
                reason = recovery.reason_for(
                    ConnectionFailure("stream lost"), identity=session.identity
                )
                attempt = recovery.attempt(session.identity, reason, restart=lambda: None)
                if attempt.recovered:
                    recovered += 1
            else:
                session.arrive()
        chosen = scheduler.next_session(
            ready=lambda sid: sid in sessions and sessions[sid].queue_depth >= 1
        )
        if chosen is not None:
            sessions[chosen].serve()

    result.metrics.update(
        {"disconnects": disconnects, "recovered": recovered, "served": sum(s.served for s in sessions.values())}
    )
    result.check(disconnects > 0, "the scenario produced no disconnects to recover from")
    result.check(recovered > 0, "no disconnect was ever recovered")
    result.check(
        sum(s.served for s in sessions.values()) > 0,
        "the fleet served nothing despite intermittent (not total) loss",
    )
    result.notes.append(f"{disconnects} disconnects, {recovered} recovered within budget")
    return result


def burst_reconnects(*, cameras: int = 16, seed: int = 11) -> ScenarioResult:
    """The thundering herd: every camera returns in the same second.

    This is the scenario a reserve exists for. If the whole fleet can re-admit simultaneously and
    consume every last unit, nothing is left for the `critical` camera that returns one tick later.
    """
    result = ScenarioResult(scenario="burst-reconnects", cameras=cameras, ticks=1)
    policy = SchedulerPolicy(reserved_capacity_percent=20.0, reserve_for=("critical",))
    registry = ComputeRegistry([ComputeResource(id="cpu:0", kind="cpu", capacity_units=float(cameras))])
    accountant = ResourceAccountant()
    scheduler = InferenceScheduler(
        registry, accountant, policy=policy, max_sessions=cameras + 4, now_iso=_fixed_iso
    )

    admitted = refused = 0
    for index in range(cameras):
        identity = SessionIdentity("tnt_sim", f"cam_{index}", f"ses_{index}")
        verdict, _ = scheduler.admit(identity, target_fps=5.0, priority="normal")
        admitted += 1 if verdict.admitted else 0
        refused += 0 if verdict.admitted else 1

    # The whole point: a critical camera arriving after the herd must still get in.
    critical = SessionIdentity("tnt_sim", "cam_critical", "ses_critical")
    critical_verdict, _ = scheduler.admit(critical, target_fps=5.0, priority="critical")

    result.cameras = cameras + 1
    result.metrics.update(
        {
            "admitted": admitted,
            "refused": refused,
            "reservedUnits": registry.reserved_units,
            "freeAfterBurst": registry.free_capacity,
        }
    )
    result.check(
        critical_verdict.admitted,
        "a critical camera was refused after a reconnect burst — the reserve did not protect it",
    )
    result.check(refused > 0, "the burst was absorbed entirely; the reserve was never exercised")
    result.check(registry.free_capacity >= 0, "capacity accounting went negative under a burst")
    result.notes.append(
        f"{admitted} of {cameras} normal-priority sessions admitted; the reserve kept "
        f"{registry.reserved_units:.1f} units for the critical camera that followed"
    )
    return result


def varying_frame_rates(*, cameras: int = 12, ticks: int = 600) -> ScenarioResult:
    """Cameras producing at wildly different rates must not starve one another."""
    result = ScenarioResult(scenario="varying-frame-rates", cameras=cameras, ticks=ticks)
    _reg, accountant, scheduler, sessions = _rig(cameras)
    # 1, 2, 4 and 8 frames per tick across the fleet — a 8x spread in demand.
    for index, session in enumerate(sessions.values()):
        session.arrival_per_tick = float(2 ** (index % 4))
    _pump(scheduler, accountant, sessions, ticks=ticks)

    served = {sid: s.served for sid, s in sessions.items()}
    starved = sorted(sid for sid, count in served.items() if count == 0)
    result.metrics.update(
        {
            "served": sum(served.values()),
            "minServed": min(served.values()) if served else 0,
            "maxServed": max(served.values()) if served else 0,
            "spread": scheduler.fairness()["spread"],
        }
    )
    result.check(not starved, f"sessions starved under a varying frame-rate mix: {starved}")
    result.check(
        scheduler.fairness()["spread"] <= 2.0,
        f"share spread {scheduler.fairness()['spread']} exceeded the equal-priority bound",
    )
    result.notes.append("an 8x demand spread produced no starvation at equal priority")
    return result


def heterogeneous_hardware(*, cameras: int = 12) -> ScenarioResult:
    """CPU + CUDA + NPU in one box. Placement must use all of it without knowing what any of it is."""
    result = ScenarioResult(scenario="heterogeneous-hardware", cameras=cameras, ticks=0)
    resources = [
        ComputeResource(id="cpu:0", kind="cpu", capacity_units=4.0),
        ComputeResource(id="node-a/cuda:0", kind="cuda", capacity_units=8.0),
        ComputeResource(id="npu:0", kind="npu", capacity_units=4.0),
    ]
    _reg, _acct, scheduler, sessions = _rig(cameras, resources=resources)

    placements: Dict[str, int] = {}
    for account in _accounts(scheduler):
        placements[account.resource_id or "unplaced"] = (
            placements.get(account.resource_id or "unplaced", 0) + 1
        )
    result.metrics.update({f"placed:{k}": v for k, v in sorted(placements.items())})
    result.metrics["admitted"] = len(sessions)
    result.check(len(sessions) > 0, "nothing was admitted onto a mixed-accelerator box")
    result.check(
        len([k for k in placements if k != "unplaced"]) >= 2,
        f"work landed on only one resource kind: {sorted(placements)}",
    )
    result.check(
        "unplaced" not in placements, "an admitted session was never placed on a resource"
    )
    result.notes.append(
        "placement spread across kinds using abstract capacity only — no CUDA-specific branch exists"
    )
    return result


def mixed_priorities(*, cameras: int = 16, ticks: int = 800) -> ScenarioResult:
    """Priority must shape the share WITHOUT ever producing starvation."""
    result = ScenarioResult(scenario="mixed-priorities", cameras=cameras, ticks=ticks)
    priorities = ["low", "normal", "high", "critical"]
    _reg, accountant, scheduler, sessions = _rig(
        cameras, priorities=priorities, capacity_per_camera=2.0
    )
    _pump(scheduler, accountant, sessions, ticks=ticks)

    by_priority: Dict[str, int] = {}
    for session in sessions.values():
        by_priority[session.priority] = by_priority.get(session.priority, 0) + session.served
    starved = sorted(sid for sid, s in sessions.items() if s.served == 0)
    result.metrics.update({f"served:{k}": v for k, v in sorted(by_priority.items())})
    result.check(not starved, f"sessions starved under mixed priorities: {starved}")
    result.check(
        by_priority.get("critical", 0) >= by_priority.get("low", 0),
        "critical sessions were served no more than low ones — priority had no effect",
    )
    result.notes.append(
        "weighted-fair gave priority influence over the share while every session still ran"
    )
    return result


def degraded_hardware(*, cameras: int = 8, ticks: int = 400) -> ScenarioResult:
    """An accelerator disappears mid-shift. The fleet must degrade, not collapse."""
    result = ScenarioResult(scenario="degraded-hardware", cameras=cameras, ticks=ticks)
    resources = [
        ComputeResource(id="cpu:0", kind="cpu", capacity_units=4.0),
        ComputeResource(id="cuda:0", kind="cuda", capacity_units=8.0),
    ]
    registry, accountant, scheduler, sessions = _rig(cameras, resources=resources)
    _pump(scheduler, accountant, sessions, ticks=ticks // 2)
    served_before = sum(s.served for s in sessions.values())

    # The GPU goes away. Capacity halves; nothing is told to stop.
    gpu = registry.get("cuda:0")
    gpu.available = False
    for session in sessions.values():
        session.arrival_per_tick = 2.0  # the same work now has less to run on
    _pump(scheduler, accountant, sessions, ticks=ticks // 2)
    served_after = sum(s.served for s in sessions.values()) - served_before

    suspended = [a.identity.session_id for a in accountant.list() if a.degradation == "suspended"]
    result.metrics.update(
        {
            "servedBefore": served_before,
            "servedAfter": served_after,
            "capacityAfter": registry.total_capacity,
            "suspended": len(suspended),
        }
    )
    result.check(served_after > 0, "the fleet stopped serving entirely when an accelerator was lost")
    result.check(
        len(suspended) < len(sessions),
        "every session was suspended after capacity loss — that is collapse, not degradation",
    )
    result.notes.append(
        f"capacity fell to {registry.total_capacity:g} units; the fleet kept serving {served_after} frames"
    )
    return result


def repeated_model_failures(*, attempts: int = 20) -> ScenarioResult:
    """A model that fails every time must exhaust its budget and hand over to an operator.

    The failure this prevents is the runtime that retries a broken model four thousand times
    overnight, burying the one log line that says which artifact is wrong.
    """
    result = ScenarioResult(scenario="repeated-model-failures", cameras=1, ticks=attempts)
    clock = SimClock()
    policy = RecoveryPolicy(max_restarts=3, restart_window_seconds=3600.0, stabilization_seconds=0.0)
    recovery = AutoRecovery(policy=policy, clock=clock, now_iso=_fixed_iso)
    identity = SessionIdentity("tnt_sim", "cam_0", "ses_0")

    outcomes: Dict[str, int] = {}
    restarts = 0

    def failing_restart() -> None:
        nonlocal restarts
        restarts += 1
        raise ModelFailure("artifact is corrupt")

    for _ in range(attempts):
        clock.advance(10.0)
        reason = recovery.reason_for(ModelFailure("artifact is corrupt"), identity=identity)
        attempt = recovery.attempt(identity, reason, restart=failing_restart)
        outcomes[attempt.outcome] = outcomes.get(attempt.outcome, 0) + 1

    result.metrics.update({f"outcome:{k}": v for k, v in sorted(outcomes.items())})
    result.metrics["restartsExecuted"] = restarts
    result.check(
        restarts <= policy.max_restarts,
        f"executed {restarts} restarts against a budget of {policy.max_restarts}",
    )
    result.check(
        outcomes.get("budget-exhausted", 0) > 0,
        "the budget never ran out over 20 consecutive failures",
    )
    result.notes.append(
        f"{attempts} consecutive model failures produced exactly {restarts} restarts, "
        "then deferred to an operator"
    )
    return result


def simultaneous_recoveries(*, cameras: int = 16) -> ScenarioResult:
    """Every camera fails in the same tick. Recovery must be budgeted per session, not fleet-wide."""
    result = ScenarioResult(scenario="simultaneous-recoveries", cameras=cameras, ticks=1)
    clock = SimClock()
    recovery = AutoRecovery(
        policy=RecoveryPolicy(max_restarts=2, stabilization_seconds=60.0),
        clock=clock,
        now_iso=_fixed_iso,
    )
    identities = [SessionIdentity("tnt_sim", f"cam_{i}", f"ses_{i}") for i in range(cameras)]
    restarted = 0
    for identity in identities:
        reason = recovery.reason_for(ConnectionFailure("link down"), identity=identity)
        attempt = recovery.attempt(identity, reason, restart=lambda: None)
        restarted += 1 if attempt.recovered else 0

    # Each session must own its budget: one camera's failures must never spend another's.
    budgets = {i.session_id: recovery.budget_remaining(i) for i in identities}
    result.metrics.update({"restarted": restarted, "distinctBudgets": len(set(budgets.values()))})
    result.check(
        restarted == cameras,
        f"only {restarted} of {cameras} simultaneous failures recovered — budgets leaked across sessions",
    )
    result.check(
        all(v == 1 for v in budgets.values()),
        f"budgets diverged across identically-failing sessions: {sorted(set(budgets.values()))}",
    )
    result.notes.append(
        f"{cameras} simultaneous failures each spent exactly one of their own restarts"
    )
    return result


def recovery_storm(*, flaps: int = 30) -> ScenarioResult:
    """A camera that works for two seconds and breaks for two, for hours.

    Without a stabilization window this produces a restart per flap forever. With one, the storm is
    bounded — which is the whole of Architect AI-5d rec 6.
    """
    result = ScenarioResult(scenario="recovery-storm", cameras=1, ticks=flaps)
    clock = SimClock()
    policy = RecoveryPolicy(
        max_restarts=100,  # deliberately generous: the WINDOW must be what bounds this, not the budget
        restart_window_seconds=86400.0,
        stabilization_seconds=60.0,
    )
    recovery = AutoRecovery(policy=policy, clock=clock, now_iso=_fixed_iso)
    identity = SessionIdentity("tnt_sim", "cam_flap", "ses_flap")

    restarts = deferred = 0
    for _ in range(flaps):
        clock.advance(2.0)  # it flaps far faster than the stabilization window
        reason = recovery.reason_for(ConnectionFailure("link flapping"), identity=identity)
        attempt = recovery.attempt(identity, reason, restart=lambda: None)
        if attempt.recovered:
            restarts += 1
        elif attempt.outcome == "cooldown":
            deferred += 1

    result.metrics.update({"restarts": restarts, "deferred": deferred, "flaps": flaps})
    result.check(
        restarts < flaps,
        f"a flapping camera restarted on every one of {flaps} flaps — the storm was unbounded",
    )
    result.check(deferred > 0, "the stabilization window never deferred a restart")
    result.check(restarts >= 1, "a flapping camera was never recovered at all")
    result.notes.append(
        f"{flaps} flaps in {flaps * 2}s produced {restarts} restart(s); "
        f"{deferred} were held by the {policy.stabilization_seconds:g}s stabilization window"
    )
    return result


# --- the suite ------------------------------------------------------------------------------------

_SCENARIOS: Dict[str, Callable[[], ScenarioResult]] = {
    "prolonged-operation": prolonged_operation,
    "intermittent-disconnects": intermittent_disconnects,
    "burst-reconnects": burst_reconnects,
    "varying-frame-rates": varying_frame_rates,
    "heterogeneous-hardware": heterogeneous_hardware,
    "mixed-priorities": mixed_priorities,
    "degraded-hardware": degraded_hardware,
    "repeated-model-failures": repeated_model_failures,
    "simultaneous-recoveries": simultaneous_recoveries,
    "recovery-storm": recovery_storm,
}


def run_scenario(name: str) -> ScenarioResult:
    scenario = _SCENARIOS.get(name)
    if scenario is None:
        raise ConfigurationFailure(
            f"unknown production scenario '{name}' (available: {', '.join(sorted(_SCENARIOS))})"
        )
    return scenario()


def production_suite() -> List[ScenarioResult]:
    """Every production condition the Architect named, in a fixed order (rec 7)."""
    return [_SCENARIOS[name]() for name in SCENARIOS]


def summarize(results: List[ScenarioResult]) -> dict:
    """A pass/fail rollup — what a CI gate reads."""
    return {
        "scenarios": len(results),
        "passed": sum(1 for r in results if r.passed),
        "failed": sorted(r.scenario for r in results if not r.passed),
        "violations": [v for r in results for v in r.violations],
        "results": [r.to_dict() for r in results],
    }


def _accounts(scheduler) -> List:  # noqa: ANN001, ANN202 - InferenceScheduler
    return scheduler._accountant.list()  # noqa: SLF001 - same-module collaborator


def main(argv: Optional[List[str]] = None) -> int:
    """`python production_sim.py` — run every scenario and exit non-zero on any violation."""
    import json
    import sys

    names = list(argv or sys.argv[1:]) or list(SCENARIOS)
    results = [run_scenario(name) for name in names]
    summary = summarize(results)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if not summary["failed"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
