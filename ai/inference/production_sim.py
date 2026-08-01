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
    # AI-5d follow-up rec 7 — the second wave. Every operational improvement should exist as a
    # deterministic simulation before it reaches production.
    "partial-gpu-failure",
    "mixed-hardware-cluster",
    "network-partition",
    "rtsp-credential-failure",
    "gradual-resource-exhaustion",
    "overnight-continuous",
    "rolling-model-deployment",
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


# --- second wave (AI-5d follow-up rec 7) -----------------------------------------------------------


def partial_gpu_failure(*, cameras: int = 12, ticks: int = 400) -> ScenarioResult:
    """One GPU of two degrades to a fraction of its capacity — it does not vanish, it gets slow.

    Harder than total loss: capacity accounting must shrink an in-use resource without stranding the
    sessions already placed on it, and without manufacturing capacity when they are released.
    """
    result = ScenarioResult(scenario="partial-gpu-failure", cameras=cameras, ticks=ticks)
    resources = [
        ComputeResource(id="cuda:0", kind="cuda", capacity_units=8.0),
        ComputeResource(id="cuda:1", kind="cuda", capacity_units=8.0),
    ]
    registry, accountant, scheduler, sessions = _rig(cameras, resources=resources)
    _pump(scheduler, accountant, sessions, ticks=ticks // 2)

    # cuda:1 degrades to a quarter of its capacity while sessions are running on it.
    degraded = registry.get("cuda:1")
    stranded_before = degraded.allocated_units
    degraded.capacity_units = 2.0
    served_before = sum(s.served for s in sessions.values())
    _pump(scheduler, accountant, sessions, ticks=ticks // 2)
    served_after = sum(s.served for s in sessions.values()) - served_before

    result.metrics.update(
        {
            "servedAfter": served_after,
            "freeCapacity": registry.free_capacity,
            "overCommittedUnits": max(0.0, degraded.allocated_units - degraded.capacity_units),
            "stranded": stranded_before,
        }
    )
    result.check(served_after > 0, "a partial GPU degradation stopped the fleet entirely")
    result.check(
        registry.free_capacity >= 0.0,
        "free capacity went negative after a resource shrank beneath its allocations",
    )
    # Over-commitment is expected and must be visible rather than hidden — admission simply refuses
    # new work until the existing sessions release.
    verdict = scheduler.admission.evaluate(
        SessionIdentity("tnt_sim", "cam_new", "ses_new"), target_fps=5.0
    )
    result.check(
        not verdict.admitted or registry.free_capacity > 0,
        "new work was admitted onto a resource with no free capacity",
    )
    result.notes.append(
        f"cuda:1 shrank 8.0 → 2.0 units with {stranded_before:.1f} units already placed; "
        "existing sessions kept running and admission refused new work"
    )
    return result


def mixed_hardware_cluster(*, cameras: int = 24) -> ScenarioResult:
    """Resources spread across nodes — the shape a distributed scheduler will present.

    Nothing here is distributed; the point is that the scheduler already cannot tell, because it only
    ever sees node-qualified ids and abstract units.
    """
    result = ScenarioResult(scenario="mixed-hardware-cluster", cameras=cameras, ticks=0)
    resources = [
        ComputeResource(id="node-a/cpu:0", kind="cpu", capacity_units=8.0),
        ComputeResource(id="node-a/cuda:0", kind="cuda", capacity_units=8.0),
        ComputeResource(id="node-b/cpu:0", kind="cpu", capacity_units=4.0),
        ComputeResource(id="node-b/npu:0", kind="npu", capacity_units=6.0),
        ComputeResource(id="node-c/metal:0", kind="metal", capacity_units=4.0),
    ]
    registry, _acct, scheduler, sessions = _rig(cameras, resources=resources)
    nodes: Dict[str, int] = {}
    for account in _accounts(scheduler):
        node = (account.resource_id or "unplaced").split("/")[0]
        nodes[node] = nodes.get(node, 0) + 1

    result.metrics.update({f"node:{k}": v for k, v in sorted(nodes.items())})
    result.metrics["admitted"] = len(sessions)
    result.check(len(sessions) > 0, "nothing was admitted onto a mixed cluster")
    result.check(
        len(nodes) >= 3, f"work concentrated on too few nodes: {sorted(nodes)}"
    )
    result.check("unplaced" not in nodes, "an admitted session was never placed")
    result.notes.append(
        "placement spanned nodes using node-qualified ids and abstract units only — the scheduler "
        "contains no notion of locality, which is what leaves distribution open"
    )
    return result


def network_partition(*, cameras: int = 12, ticks: int = 300, outage: int = 80) -> ScenarioResult:
    """Every camera becomes unreachable at once, then all of them return.

    A partition is not N independent disconnects: the fleet fails together and recovers together, so
    both the recovery budget and the admission reserve are stressed in the same instant.
    """
    result = ScenarioResult(scenario="network-partition", cameras=cameras, ticks=ticks)
    _reg, accountant, scheduler, sessions = _rig(cameras)
    clock = SimClock()
    recovery = AutoRecovery(
        policy=RecoveryPolicy(max_restarts=5, stabilization_seconds=10.0),
        clock=clock,
        now_iso=_fixed_iso,
    )

    served_during = 0
    for tick in range(ticks):
        clock.advance(1.0)
        partitioned = outage <= tick < outage * 2
        if not partitioned:
            for session in sessions.values():
                session.arrive()
            chosen = scheduler.next_session(
                ready=lambda sid: sid in sessions and sessions[sid].queue_depth >= 1
            )
            if chosen is not None:
                sessions[chosen].serve()
                served_during += 1
        elif tick == outage:
            for session in sessions.values():
                reason = recovery.reason_for(
                    ConnectionFailure("network partition"), identity=session.identity
                )
                recovery.attempt(session.identity, reason, restart=lambda: None)

    analytics = recovery.analytics()
    result.metrics.update(
        {
            "served": sum(s.served for s in sessions.values()),
            "recoveries": analytics["recoveries"],
            "successPercent": analytics["successPercent"],
        }
    )
    # Against the ADMITTED count, not the requested one: the reserve legitimately refuses some
    # cameras at admission, and asserting on `cameras` would be testing the reserve, not the partition.
    result.check(
        analytics["recoveries"] == len(sessions),
        f"only {analytics['recoveries']} of {len(sessions)} partitioned cameras attempted recovery",
    )
    result.check(
        analytics["successPercent"] == 100.0,
        "a simultaneous partition exhausted budgets that are supposed to be per-session",
    )
    result.check(
        sum(s.served for s in sessions.values()) > 0, "the fleet never resumed after the partition"
    )
    result.notes.append(
        f"{cameras} cameras lost and restored together; each spent its own budget and the fleet resumed"
    )
    return result


def rtsp_credential_failure(*, attempts: int = 15) -> ScenarioResult:
    """Wrong credentials on a camera. This is a CONFIGURATION failure, and must never be retried.

    The most important negative scenario in the suite: retrying a credential error looks like a
    connection problem, burns the reconnect budget, and buries the one log line naming the real fault.
    """
    result = ScenarioResult(scenario="rtsp-credential-failure", cameras=1, ticks=attempts)
    clock = SimClock()
    recovery = AutoRecovery(
        policy=RecoveryPolicy(max_restarts=10, stabilization_seconds=0.0),
        clock=clock,
        now_iso=_fixed_iso,
    )
    identity = SessionIdentity("tnt_sim", "cam_0", "ses_0")
    restarts = 0

    def restart() -> None:
        nonlocal restarts
        restarts += 1

    outcomes: Dict[str, int] = {}
    for _ in range(attempts):
        clock.advance(5.0)
        reason = recovery.reason_for(
            ConfigurationFailure("401 Unauthorized from rtsp://***@cam.local/stream"),
            identity=identity,
        )
        attempt = recovery.attempt(identity, reason, restart=restart)
        outcomes[attempt.outcome] = outcomes.get(attempt.outcome, 0) + 1

    result.metrics.update({f"outcome:{k}": v for k, v in sorted(outcomes.items())})
    result.metrics["restarts"] = restarts
    result.metrics["budgetRemaining"] = float(recovery.budget_remaining(identity) or 0)
    result.check(restarts == 0, f"a credential error triggered {restarts} restart(s)")
    result.check(
        outcomes.get("operator-required", 0) == attempts,
        "a credential error was not consistently escalated to an operator",
    )
    result.check(
        recovery.budget_remaining(identity) == 10,
        "a configuration failure consumed the reconnect budget meant for real outages",
    )
    result.notes.append(
        f"{attempts} credential failures produced 0 restarts, 0 budget spent, and {attempts} "
        "operator escalations"
    )
    return result


def gradual_resource_exhaustion(*, cameras: int = 8, ticks: int = 600) -> ScenarioResult:
    """Load creeps up over hours rather than spiking — the case reactive degradation handles worst.

    The governor should act on the TREND, well before utilization reaches its threshold, which is the
    entire justification for predictive degradation.
    """
    result = ScenarioResult(scenario="gradual-resource-exhaustion", cameras=cameras, ticks=ticks)
    policy = SchedulerPolicy(
        predictive=True,
        escalate_after_samples=2,
        degrade_above_queue_percent=90.0,
        predicted_pressure_threshold=85.0,
        reserved_capacity_percent=0.0,
        stabilization_samples=2,
    )
    _reg, accountant, scheduler, sessions = _rig(cameras, policy=policy)

    first_degrade_at: Optional[int] = None
    first_saturation_at: Optional[int] = None
    for tick in range(ticks):
        # Demand grows slowly and monotonically — no spikes for a reactive rule to catch.
        creep = 0.5 + 2.0 * (tick / ticks)
        for session in sessions.values():
            account = accountant.get(session.identity)
            level = account.degradation if account is not None else "none"
            session.arrive(scale=0.5 if level != "none" else 1.0 * creep)
            if session.utilization >= 100.0 and first_saturation_at is None:
                first_saturation_at = tick
        chosen = scheduler.next_session(
            ready=lambda sid: sid in sessions and sessions[sid].queue_depth >= 1
        )
        if chosen is not None:
            sessions[chosen].serve()
        if tick % 10 == 0:
            for session in sessions.values():
                account = accountant.get(session.identity)
                if account is None:
                    continue
                decision = scheduler.governor.observe(
                    account, queue_utilization=session.utilization
                )
                if decision is not None and first_degrade_at is None:
                    first_degrade_at = tick

    result.metrics.update(
        {
            "firstDegradeTick": float(first_degrade_at if first_degrade_at is not None else -1),
            "firstSaturationTick": float(
                first_saturation_at if first_saturation_at is not None else -1
            ),
            "predictedDegradations": sum(
                1 for d in scheduler.decisions.all() if d.reason == "predicted-pressure"
            ),
        }
    )
    result.check(first_degrade_at is not None, "gradual exhaustion never triggered any degradation")
    if first_degrade_at is not None and first_saturation_at is not None:
        result.check(
            first_degrade_at <= first_saturation_at,
            "the governor degraded only AFTER the queue saturated — prediction bought nothing",
        )
    result.notes.append(
        f"degraded at tick {first_degrade_at} against saturation at {first_saturation_at} — "
        "the trend, not the threshold, is what triggered it"
    )
    return result


def overnight_continuous(*, cameras: int = 8, ticks: int = 10000) -> ScenarioResult:
    """The long night. Everything bounded must still be bounded ten thousand ticks later.

    A separate scenario from `prolonged-operation` because the failure mode is different: that one
    checks the stores, this one checks that behavior does not DRIFT — fairness, degradation and
    scheduling must look the same at the end of the run as at the start.
    """
    result = ScenarioResult(scenario="overnight-continuous", cameras=cameras, ticks=ticks)
    _reg, accountant, scheduler, sessions = _rig(cameras)

    _pump(scheduler, accountant, sessions, ticks=ticks // 2)
    mid_spread = scheduler.fairness()["spread"]
    mid_served = sum(s.served for s in sessions.values())
    _pump(scheduler, accountant, sessions, ticks=ticks // 2)
    end_spread = scheduler.fairness()["spread"]
    second_half = sum(s.served for s in sessions.values()) - mid_served

    result.metrics.update(
        {
            "firstHalfServed": mid_served,
            "secondHalfServed": second_half,
            "midSpread": mid_spread,
            "endSpread": end_spread,
            "decisionLogEntries": len(scheduler.decisions),
        }
    )
    result.check(second_half > 0, "the fleet stopped serving during the second half of the night")
    # Throughput must not decay: a slow leak shows up here as a second half quieter than the first.
    result.check(
        second_half >= mid_served * 0.9,
        f"throughput decayed overnight ({mid_served} → {second_half})",
    )
    result.check(
        end_spread <= max(1.5, mid_spread * 1.5),
        f"fairness drifted overnight (spread {mid_spread} → {end_spread})",
    )
    result.check(len(scheduler.decisions) <= 200, "the decision log grew unbounded overnight")
    result.notes.append(
        f"{ticks} ticks: throughput and fairness held steady between halves; every store stayed bounded"
    )
    return result


def rolling_model_deployment(*, cameras: int = 8) -> ScenarioResult:
    """A model rolled out across a fleet, with one rollout failing validation.

    The property under test is that a **failed** rollout leaves its sessions exactly where they were:
    a partial deployment must not produce a fleet running two versions by accident.
    """
    from contracts import FrameContext, ModelBinding
    from model_lifecycle import ModelLifecycleManager, ModelLifecyclePolicy, ModelSlot

    result = ScenarioResult(scenario="rolling-model-deployment", cameras=cameras, ticks=0)

    class _Adapter:
        execution_provider = "stub"

        def __init__(self, detections: int = 2) -> None:
            self.detections = detections

        def load(self, ref: dict) -> None:
            return None

        def preprocess(self, ctx):  # noqa: ANN001
            return ctx

        def infer(self, prepared):  # noqa: ANN001
            return [{"label": "person", "confidence": 0.9}] * self.detections

        def unload(self) -> None:
            return None

    stamps = iter([f"2026-08-01T00:{n // 60:02d}:{n % 60:02d}.000Z" for n in range(600)])
    manager = ModelLifecycleManager(
        policy=ModelLifecyclePolicy(validation_frames=4), now_iso=lambda: next(stamps)
    )
    frames = [
        FrameContext(tenant_id="tnt_sim", camera_id=f"cam_{i}", image=b"x", frame_number=i)
        for i in range(4)
    ]
    slots = [ModelSlot(_Adapter(), ModelBinding(name="det", version="v1", task="detection"))
             for _ in range(cameras)]

    good = manager.transition(
        "tnt_sim", "mdl_1", "v2", loader=lambda: _Adapter(2), frames=frames,
        incumbent=_Adapter(2), slots=slots,
    )
    on_v2 = sum(1 for s in slots if s.binding.version == "v2")

    bad = manager.transition(
        "tnt_sim", "mdl_1", "v3", loader=lambda: _Adapter(0), frames=frames,
        incumbent=_Adapter(2), slots=slots,
    )
    still_v2 = sum(1 for s in slots if s.binding.version == "v2")

    history = manager.history("tnt_sim", "mdl_1")
    result.metrics.update(
        {
            "sessionsOnV2": on_v2,
            "sessionsStillOnV2": still_v2,
            "transitions": len(history["transitions"]),
        }
    )
    result.check(good.succeeded, "a valid rolling deployment did not complete")
    result.check(on_v2 == cameras, f"only {on_v2}/{cameras} sessions received the new version")
    result.check(bad.state == "rolled-back", "a failing candidate was not rolled back")
    result.check(
        still_v2 == cameras,
        f"a failed rollout left the fleet split across versions ({still_v2}/{cameras} on v2)",
    )
    result.check(
        history["versionPath"] == ["v2", "v2"],
        f"the version path did not record the rollback: {history['versionPath']}",
    )
    result.notes.append(
        f"{cameras} sessions moved to v2 with no restart; a failing v3 rolled back leaving all "
        f"{cameras} on v2 — never a split fleet"
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
    "partial-gpu-failure": partial_gpu_failure,
    "mixed-hardware-cluster": mixed_hardware_cluster,
    "network-partition": network_partition,
    "rtsp-credential-failure": rtsp_credential_failure,
    "gradual-resource-exhaustion": gradual_resource_exhaustion,
    "overnight-continuous": overnight_continuous,
    "rolling-model-deployment": rolling_model_deployment,
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
