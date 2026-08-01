"""Scheduler Simulation (AI-5c) — deterministic validation at 4 / 8 / 16 / 32 cameras.

Proving a scheduler works needs *load*, and load normally means real cameras, real hardware, and
non-reproducible results. This module gets the proof without any of that (Architect AI-5c rec 7): it
drives the **real** `InferenceScheduler`, `AdmissionController` and `ResourceGovernor` against
synthetic sessions whose arrival rates are scripted, so fairness, starvation-freedom, admission
refusal, and the degradation ladder are all asserted deterministically in CI.

It is a *simulation of load*, not a simulation of the scheduler: every decision here is made by the
same code that runs in production. What is faked is only the work arriving — which is exactly the part
that would otherwise require 32 cameras and a loaded box.

Deterministic by construction: no wall-clock, no threads, no randomness beyond a seeded generator.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from compute import ComputeRegistry, ComputeResource, ResourceSnapshot
from operational_log import SessionIdentity
from resources import ResourceAccountant
from scheduler import InferenceScheduler, SchedulerPolicy

# The camera counts the Architect asked to exercise.
STANDARD_SIMULATION_SIZES = (4, 8, 16, 32)


@dataclass
class SimulatedSession:
    """One synthetic camera: a queue depth that grows when it is not served and shrinks when it is."""

    identity: SessionIdentity
    priority: str = "normal"
    target_fps: float = 5.0
    # Frames arriving per simulation tick — the load knob. A "busy" camera produces more.
    arrival_per_tick: float = 1.0
    queue_capacity: int = 32
    queue_depth: float = 0.0
    served: int = 0
    dropped: int = 0

    @property
    def utilization(self) -> float:
        return min(100.0, 100.0 * self.queue_depth / max(1, self.queue_capacity))

    def arrive(self, *, scale: float = 1.0) -> None:
        self.queue_depth += self.arrival_per_tick * scale
        if self.queue_depth > self.queue_capacity:
            # Overflow is genuine backpressure loss, exactly as the bounded queue would report it.
            self.dropped += int(self.queue_depth - self.queue_capacity)
            self.queue_depth = float(self.queue_capacity)

    def arrive_reduced(self) -> None:
        """Arrivals under a reduced-FPS rung: the runtime samples fewer frames, so fewer enqueue."""
        self.arrive(scale=0.5)

    def serve(self) -> None:
        if self.queue_depth >= 1:
            self.queue_depth -= 1
            self.served += 1


@dataclass
class SimulationResult:
    """What the simulation proved, in numbers a reviewer can check."""

    cameras: int
    ticks: int
    admitted: int
    refused: int
    served: Dict[str, int] = field(default_factory=dict)
    dropped: Dict[str, int] = field(default_factory=dict)
    degradations: List[dict] = field(default_factory=list)
    fairness: dict = field(default_factory=dict)
    scheduler: dict = field(default_factory=dict)
    sla: List[dict] = field(default_factory=list)

    @property
    def starved_sessions(self) -> List[str]:
        """Admitted sessions that were never served — the failure fairness exists to prevent."""
        return sorted(s for s, count in self.served.items() if count == 0)

    def to_dict(self) -> dict:
        return {
            "cameras": self.cameras,
            "ticks": self.ticks,
            "admitted": self.admitted,
            "refused": self.refused,
            "servedTotal": sum(self.served.values()),
            "droppedTotal": sum(self.dropped.values()),
            "starvedSessions": self.starved_sessions,
            "fairness": self.fairness,
            "degradationEvents": len(self.degradations),
            "degradations": self.degradations[:20],
            "scheduler": self.scheduler,
        }


def simulate(
    cameras: int,
    *,
    ticks: int = 200,
    capacity_units: Optional[float] = None,
    policy: Optional[SchedulerPolicy] = None,
    target_fps: float = 5.0,
    queue_capacity: int = 32,
    busy_fraction: float = 0.25,
    busy_arrival: float = 3.0,
    idle_arrival: float = 0.5,
    priorities: Optional[List[str]] = None,
    govern_every: int = 10,
    max_sessions: Optional[int] = None,
) -> SimulationResult:
    """Run `cameras` synthetic sessions through the real scheduler for `ticks` passes.

    A `busy_fraction` of the cameras produce frames faster than the scheduler can serve them — that
    asymmetry is the whole point, because a scheduler only reveals its fairness properties when demand
    exceeds supply. Everything else (capacity, policy, priorities) is injectable so a test can target
    one behavior at a time.
    """
    if cameras < 1:
        raise ValueError("cameras must be >= 1")
    registry = ComputeRegistry(
        [
            ComputeResource(
                id="cpu:0",
                kind="cpu",
                capacity_units=capacity_units if capacity_units is not None else float(cameras),
            )
        ]
    )
    accountant = ResourceAccountant()
    scheduler = InferenceScheduler(
        registry,
        accountant,
        policy=policy or SchedulerPolicy(),
        max_sessions=max_sessions if max_sessions is not None else cameras,
        now_iso=_fixed_iso,
    )

    sessions: Dict[str, SimulatedSession] = {}
    admitted = refused = 0
    busy_count = max(1, int(cameras * busy_fraction)) if busy_fraction > 0 else 0
    for index in range(cameras):
        identity = SessionIdentity("tnt_sim", f"cam_{index}", f"ses_{index}")
        priority = (priorities[index % len(priorities)]) if priorities else "normal"
        verdict, _account = scheduler.admit(
            identity, target_fps=target_fps, priority=priority
        )
        if not verdict.admitted:
            refused += 1
            continue
        admitted += 1
        sessions[identity.session_id] = SimulatedSession(
            identity=identity,
            priority=priority,
            target_fps=target_fps,
            arrival_per_tick=busy_arrival if index < busy_count else idle_arrival,
            queue_capacity=queue_capacity,
        )

    degradations: List[dict] = []
    for tick in range(ticks):
        for session in sessions.values():
            account = accountant.get(session.identity)
            level = account.degradation if account is not None else "none"
            if level == "suspended":
                # A suspended session STOPS CONSUMING its source, so its queue drains rather than
                # growing. Modelling it any other way would make suspension permanent, which is the
                # opposite of the reversible ladder the runtime actually implements.
                session.queue_depth = max(0.0, session.queue_depth - 1.0)
                continue
            if level in ("reduced-fps", "reduced-resolution", "reduced-behaviors"):
                session.arrive_reduced()
            else:
                session.arrive()

        chosen = scheduler.next_session(ready=lambda sid: sessions[sid].queue_depth >= 1 if sid in sessions else False)
        if chosen is not None and chosen in sessions:
            sessions[chosen].serve()
            account = accountant.get(sessions[chosen].identity)
            if account is not None:
                account.frames_processed += 1
                account.inference_ms_total += 1.0
                account.effective_fps = target_fps  # served on time this tick

        # Governor cadence — a slow control loop, not a per-frame reaction.
        if govern_every > 0 and tick % govern_every == 0:
            snapshot = ResourceSnapshot(cpu_percent=None, memory_mb=None)
            for session in sessions.values():
                account = accountant.get(session.identity)
                if account is None:
                    continue
                account.dropped_frames = session.dropped
                decision = scheduler.governor.observe(
                    account, queue_utilization=session.utilization, snapshot=snapshot
                )
                if decision is not None:
                    degradations.append(decision.to_dict())

    return SimulationResult(
        cameras=cameras,
        ticks=ticks,
        admitted=admitted,
        refused=refused,
        served={s: sess.served for s, sess in sessions.items()},
        dropped={s: sess.dropped for s, sess in sessions.items()},
        degradations=degradations,
        fairness=scheduler.fairness(),
        scheduler=scheduler.stats(decisions=5),
        sla=[a.to_sla_dict() for a in accountant.list()],
    )


def standard_suite(**kwargs) -> List[SimulationResult]:
    """Run the 4 / 8 / 16 / 32-camera sweep the Architect asked for (rec 7)."""
    return [simulate(n, **kwargs) for n in STANDARD_SIMULATION_SIZES]


def _fixed_iso() -> str:
    """A fixed timestamp — simulation output must be byte-identical across runs."""
    return "2026-07-31T00:00:00.000Z"
