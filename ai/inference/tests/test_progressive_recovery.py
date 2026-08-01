"""Progressive restoration + anti-oscillation (AI-5d recs 4 and 6).

The claim this file exists to prove: recovery restores capabilities in the **exact reverse order** of
degradation — not merely the same number of rungs. A rung says WHERE a session is; the restoration
stack says WHAT was taken from it, and only the stack can be given back in the right order.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from compute import ComputeRegistry, ComputeResource  # noqa: E402
from health import HealthMonitor, HealthPolicy  # noqa: E402
from operational_log import SessionIdentity  # noqa: E402
from resources import ResourceAccountant, RestoreStep  # noqa: E402
from scheduler import InferenceScheduler, SchedulerPolicy  # noqa: E402

ANALYZERS = ["occupancy", "loitering", "queue", "crowd"]
COSTS = {"occupancy": 1.0, "loitering": 1.5, "queue": 2.0, "crowd": 3.0}


def _identity(index: int = 0) -> SessionIdentity:
    return SessionIdentity("tnt_a", f"cam_{index}", f"ses_{index}")


def _scheduler(policy=None, *, sessions: int = 2):
    registry = ComputeRegistry([ComputeResource(id="cpu:0", kind="cpu", capacity_units=64.0)])
    accountant = ResourceAccountant()
    scheduler = InferenceScheduler(
        registry,
        accountant,
        policy=policy
        or SchedulerPolicy(
            escalate_after_samples=1,
            recover_after_samples=1,
            predictive=False,
            reserved_capacity_percent=0.0,
            stabilization_samples=0,
        ),
        max_sessions=sessions + 2,
        now_iso=lambda: "2026-08-01T00:00:00.000Z",
        analyzer_costs=COSTS,
    )
    for index in range(sessions):
        scheduler.admit(_identity(index), target_fps=5.0)
    return scheduler, accountant


class RestorationStackTest(unittest.TestCase):
    def test_each_degradation_records_exactly_what_it_removed(self):
        scheduler, accountant = _scheduler()
        account = accountant.get(_identity())
        for _ in range(3):
            scheduler.governor.observe(account, queue_utilization=95.0, analyzers=ANALYZERS)
        levels = [step.level for step in account.restore_stack]
        self.assertEqual(levels, ["reduced-fps", "reduced-resolution", "reduced-behaviors"])
        # Only the rungs that actually take something away record it.
        self.assertEqual(account.restore_stack[0].fps_before, 5.0)
        self.assertEqual(account.restore_stack[1].resolution_scale, 0.5)
        self.assertEqual(account.restore_stack[2].disabled_analyzers, ["crowd"])

    def test_the_most_expensive_analyzer_is_disabled_first(self):
        scheduler, accountant = _scheduler()
        account = accountant.get(_identity())
        for _ in range(4):
            scheduler.governor.observe(account, queue_utilization=95.0, analyzers=ANALYZERS)
        # `crowd` (3.0) before `queue` (2.0) — the ladder always spends the cheapest quality first.
        self.assertEqual(account.disabled_analyzers, ["crowd"])

    def test_recovery_restores_in_the_exact_reverse_order(self):
        scheduler, accountant = _scheduler()
        account = accountant.get(_identity())
        for _ in range(3):
            scheduler.governor.observe(account, queue_utilization=95.0, analyzers=ANALYZERS)
        taken = [step.level for step in account.restore_stack]

        given_back = []
        for _ in range(3):
            decision = scheduler.governor.observe(account, queue_utilization=5.0)
            if decision is not None:
                given_back.append(decision.from_level)
        self.assertEqual(given_back, list(reversed(taken)))
        self.assertEqual(account.degradation, "none")
        self.assertTrue(account.fully_restored)

    def test_a_disabled_analyzer_is_re_enabled_by_its_own_step(self):
        scheduler, accountant = _scheduler()
        account = accountant.get(_identity())
        for _ in range(3):
            scheduler.governor.observe(account, queue_utilization=95.0, analyzers=ANALYZERS)
        self.assertEqual(account.disabled_analyzers, ["crowd"])
        scheduler.governor.observe(account, queue_utilization=5.0)  # leaves reduced-behaviors
        self.assertEqual(account.disabled_analyzers, [], "the analyzer was not given back")

    def test_two_analyzers_are_restored_newest_first(self):
        # The case a rung-only reversal gets wrong: restoring `crowd` before `queue` would be the
        # same number of rungs and the wrong order.
        account = ResourceAccountant().open(_identity())
        account.push_restore(RestoreStep(level="reduced-behaviors", sequence=0, disabled_analyzers=["crowd"]))
        account.push_restore(RestoreStep(level="reduced-behaviors", sequence=0, disabled_analyzers=["queue"]))
        self.assertEqual(account.disabled_analyzers, ["crowd", "queue"])
        self.assertEqual(account.pop_restore().disabled_analyzers, ["queue"])
        self.assertEqual(account.disabled_analyzers, ["crowd"])
        self.assertEqual(account.pop_restore().disabled_analyzers, ["crowd"])
        self.assertEqual(account.disabled_analyzers, [])

    def test_the_stack_sequence_is_monotonic(self):
        scheduler, accountant = _scheduler()
        account = accountant.get(_identity())
        for _ in range(3):
            scheduler.governor.observe(account, queue_utilization=95.0, analyzers=ANALYZERS)
        sequences = [step.sequence for step in account.restore_stack]
        self.assertEqual(sequences, sorted(sequences))
        self.assertEqual(len(set(sequences)), len(sequences))

    def test_popping_an_empty_stack_is_safe(self):
        account = ResourceAccountant().open(_identity())
        self.assertIsNone(account.pop_restore())

    def test_a_protected_analyzer_is_never_disabled(self):
        registry = ComputeRegistry([ComputeResource(id="cpu:0", kind="cpu", capacity_units=64.0)])
        accountant = ResourceAccountant()
        scheduler = InferenceScheduler(
            registry,
            accountant,
            policy=SchedulerPolicy(
                escalate_after_samples=1, predictive=False, reserved_capacity_percent=0.0,
                stabilization_samples=0,
            ),
            max_sessions=4,
            now_iso=lambda: "2026-08-01T00:00:00.000Z",
            analyzer_costs={"fire": 9.0, "occupancy": 1.0},
            protected_analyzers=["fire"],
        )
        scheduler.admit(_identity(), target_fps=5.0)
        scheduler.admit(_identity(1), target_fps=5.0)
        account = accountant.get(_identity())
        for _ in range(3):
            scheduler.governor.observe(
                account, queue_utilization=95.0, analyzers=["fire", "occupancy"]
            )
        self.assertNotIn("fire", account.disabled_analyzers)
        self.assertEqual(account.disabled_analyzers, ["occupancy"])

    def test_restore_steps_serialize_to_the_contract_shape(self):
        scheduler, accountant = _scheduler()
        account = accountant.get(_identity())
        scheduler.governor.observe(account, queue_utilization=95.0, analyzers=ANALYZERS)
        out = account.restore_stack[0].to_dict()
        for key in ("level", "sequence", "disabledAnalyzers"):
            self.assertIn(key, out)


class AntiOscillationTest(unittest.TestCase):
    """Rec 6: a direction REVERSAL must wait; sustained pressure must not."""

    def test_a_reversal_waits_out_the_stabilization_window(self):
        scheduler, accountant = _scheduler(
            SchedulerPolicy(
                escalate_after_samples=1, recover_after_samples=1, predictive=False,
                reserved_capacity_percent=0.0, stabilization_samples=3,
            )
        )
        account = accountant.get(_identity())
        scheduler.governor.observe(account, queue_utilization=95.0, analyzers=ANALYZERS)
        self.assertEqual(account.degradation, "reduced-fps")
        # Calm returns immediately — but one calm reading must not undo a degradation.
        for _ in range(2):
            scheduler.governor.observe(account, queue_utilization=5.0)
            self.assertEqual(account.degradation, "reduced-fps")
        scheduler.governor.observe(account, queue_utilization=5.0)
        self.assertEqual(account.degradation, "none")

    def test_sustained_pressure_is_never_slowed_by_the_guard(self):
        # Escalating twice in a row is not oscillation — it is the ladder doing its job. Delaying it
        # would leave a drowning session at a rung that cannot save it.
        scheduler, accountant = _scheduler(
            SchedulerPolicy(
                escalate_after_samples=1, predictive=False, reserved_capacity_percent=0.0,
                stabilization_samples=5,
            )
        )
        account = accountant.get(_identity())
        for _ in range(3):
            scheduler.governor.observe(account, queue_utilization=99.0, analyzers=ANALYZERS)
        self.assertEqual(account.degradation, "reduced-behaviors")

    def test_a_suppressed_transition_is_announced_once_not_every_observation(self):
        scheduler, accountant = _scheduler(
            SchedulerPolicy(
                escalate_after_samples=1, recover_after_samples=1, predictive=False,
                reserved_capacity_percent=0.0, stabilization_samples=10,
            )
        )
        account = accountant.get(_identity())
        scheduler.governor.observe(account, queue_utilization=95.0, analyzers=ANALYZERS)
        decisions = [
            scheduler.governor.observe(account, queue_utilization=5.0) for _ in range(5)
        ]
        announced = [d for d in decisions if d is not None]
        self.assertEqual(len(announced), 1, "the hold flooded the decision log")
        self.assertEqual(announced[0].reason, "stabilizing")
        self.assertEqual(announced[0].action, "throttled")
        self.assertEqual(scheduler.governor.transitions_suppressed, 5)

    def test_suppression_counts_surface_in_scheduler_stats(self):
        scheduler, accountant = _scheduler(
            SchedulerPolicy(
                escalate_after_samples=1, recover_after_samples=1, predictive=False,
                reserved_capacity_percent=0.0, stabilization_samples=10,
            )
        )
        account = accountant.get(_identity())
        scheduler.governor.observe(account, queue_utilization=95.0, analyzers=ANALYZERS)
        for _ in range(3):
            scheduler.governor.observe(account, queue_utilization=5.0)
        self.assertEqual(scheduler.stats()["transitionsSuppressed"], 3)

    def test_governor_state_is_released_with_the_session(self):
        scheduler, accountant = _scheduler()
        account = accountant.get(_identity())
        scheduler.governor.observe(account, queue_utilization=95.0, analyzers=ANALYZERS)
        scheduler.release(_identity())
        self.assertNotIn("ses_0", scheduler.governor._since_transition)
        self.assertNotIn("ses_0", scheduler.governor._last_direction)


class HealthDrivenDegradationTest(unittest.TestCase):
    """Rec 1: health supplies evidence; the governor still owns every decision."""

    def test_a_predicted_health_decline_becomes_a_pressure_reason(self):
        scheduler, accountant = _scheduler(
            SchedulerPolicy(
                escalate_after_samples=1, predictive=True, reserved_capacity_percent=0.0,
                degrade_above_queue_percent=90.0, predicted_pressure_threshold=200.0,
                stabilization_samples=0,
            )
        )
        account = accountant.get(_identity())
        # A session meeting its SLA — so the ONLY thing moving the score is the rising queue, which is
        # what makes this a test of prediction rather than of an already-degraded session.
        account.frames_processed = 100
        account.effective_fps = 5.0
        monitor = HealthMonitor(_identity(), policy=HealthPolicy(degraded_below=95.0))
        decision = None
        for utilization in (0.0, 20.0, 40.0, 60.0):
            health = monitor.observe(
                account=account,
                ingestion={"availabilityPercent": 100.0, "reconnectCount": 0},
                backpressure={
                    "queueUtilization": utilization,
                    "framesProcessed": 100,
                    "framesDropped": 0,
                },
            )
            decision = (
                scheduler.governor.observe(
                    account, queue_utilization=utilization, health=health, analyzers=ANALYZERS
                )
                or decision
            )
        self.assertIsNotNone(decision, "a projected health decline never reached the governor")
        self.assertEqual(decision.reason, "predicted-health-decline")
        self.assertLess(account.queue_utilization, 90.0)

    def test_health_alone_never_degrades_when_prediction_is_off(self):
        scheduler, accountant = _scheduler(
            SchedulerPolicy(
                escalate_after_samples=1, predictive=False, reserved_capacity_percent=0.0,
                stabilization_samples=0,
            )
        )
        account = accountant.get(_identity())
        monitor = HealthMonitor(_identity(), policy=HealthPolicy(degraded_below=95.0))
        for utilization in (0.0, 20.0, 40.0, 60.0):
            health = monitor.observe(backpressure={"queueUtilization": utilization})
            scheduler.governor.observe(account, queue_utilization=utilization, health=health)
        self.assertEqual(account.degradation, "none")

    def test_the_health_score_is_recorded_on_the_account(self):
        scheduler, accountant = _scheduler()
        account = accountant.get(_identity())
        monitor = HealthMonitor(_identity())
        health = monitor.observe(backpressure={"queueUtilization": 10.0})
        scheduler.governor.observe(account, queue_utilization=10.0, health=health)
        self.assertEqual(account.health_score, health.score)
        self.assertIn("healthScore", account.to_usage_dict())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
