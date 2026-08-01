"""AI-5c — Scheduler, admission control, and the degradation governor.

Everything here is deterministic: no threads, no sleeps, no wall-clock. Load is expressed by telling
the scheduler which sessions are `ready`, and pressure by feeding the governor utilization numbers —
so fairness, starvation-freedom, hysteresis and prediction are asserted exactly rather than observed
flakily under real load.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from compute import ComputeRegistry, ComputeResource, ResourceSnapshot
from errors import ConfigurationFailure
from operational_log import OperationalLog, SessionIdentity
from resources import DEGRADATION_LADDER, ResourceAccountant, Trend, ladder_index
from scheduler import DecisionLog, InferenceScheduler, SchedulerPolicy


def _registry(units: float = 32.0) -> ComputeRegistry:
    return ComputeRegistry([ComputeResource(id="cpu:0", kind="cpu", capacity_units=units)])


def _scheduler(*, units: float = 32.0, policy=None, max_sessions: int = 16, **kwargs):
    registry = _registry(units)
    accountant = ResourceAccountant()
    scheduler = InferenceScheduler(
        registry,
        accountant,
        policy=policy or SchedulerPolicy(reserved_capacity_percent=0.0),
        max_sessions=max_sessions,
        now_iso=lambda: "2026-07-31T00:00:00.000Z",
        **kwargs,
    )
    return scheduler, accountant, registry


def _identity(index: int, tenant: str = "tnt_a") -> SessionIdentity:
    return SessionIdentity(tenant, f"cam_{index}", f"ses_{index}")


class PolicyValidationTest(unittest.TestCase):
    def test_rejects_a_policy_without_hysteresis(self):
        # Without a gap between degrade and recover thresholds the governor would oscillate forever.
        with self.assertRaises(ConfigurationFailure):
            SchedulerPolicy(degrade_above_queue_percent=60, recover_below_queue_percent=60)

    def test_rejects_unknown_strategy_and_ladder_rung(self):
        with self.assertRaises(ConfigurationFailure):
            SchedulerPolicy(strategy="whoever-shouts-loudest")
        with self.assertRaises(ConfigurationFailure):
            SchedulerPolicy(max_degradation="deleted")


class AdmissionControlTest(unittest.TestCase):
    def test_admits_while_capacity_allows_and_refuses_with_a_reason(self):
        scheduler, _acc, _reg = _scheduler(units=2.0)
        first, _ = scheduler.admit(_identity(0), target_fps=5.0)
        self.assertTrue(first.admitted)
        second, _ = scheduler.admit(_identity(1), target_fps=5.0)
        self.assertTrue(second.admitted)
        third, account = scheduler.admit(_identity(2), target_fps=5.0)
        self.assertFalse(third.admitted)
        self.assertIsNone(account)
        self.assertEqual(third.reason, "compute-capacity")
        self.assertIn("insufficient compute", third.detail)

    def test_refusal_is_never_silent(self):
        scheduler, _acc, _reg = _scheduler(units=1.0)
        scheduler.admit(_identity(0), target_fps=5.0)
        verdict, _ = scheduler.admit(_identity(1), target_fps=5.0)
        self.assertTrue(verdict.detail)  # always carries an operator-readable explanation
        self.assertEqual(scheduler.admissions_refused, 1)
        recent = scheduler.decisions.recent(1)[0]
        self.assertEqual(recent["action"], "refused")

    def test_session_capacity_is_distinct_from_compute_capacity(self):
        scheduler, _acc, _reg = _scheduler(units=100.0, max_sessions=1)
        scheduler.admit(_identity(0), target_fps=5.0)
        verdict, _ = scheduler.admit(_identity(1), target_fps=5.0)
        self.assertEqual(verdict.reason, "session-capacity")

    def test_reserve_protects_capacity_for_critical_sessions(self):
        policy = SchedulerPolicy(reserved_capacity_percent=25.0, reserve_for=("critical",))
        scheduler, _acc, _reg = _scheduler(units=4.0, policy=policy)
        for i in range(3):
            self.assertTrue(scheduler.admit(_identity(i), target_fps=5.0)[0].admitted)
        blocked, _ = scheduler.admit(_identity(3), target_fps=5.0, priority="normal")
        self.assertFalse(blocked.admitted)
        self.assertEqual(blocked.reason, "reserve-protected")
        # …but a critical session may use the reserve.
        allowed, _ = scheduler.admit(_identity(4), target_fps=5.0, priority="critical")
        self.assertTrue(allowed.admitted)

    def test_higher_fps_costs_more_and_can_be_refused(self):
        scheduler, _acc, _reg = _scheduler(units=2.0)
        verdict, _ = scheduler.admit(_identity(0), target_fps=30.0)
        self.assertFalse(verdict.admitted)  # 30 fps costs 6 units on CPU; only 2 available

    def test_release_returns_capacity_and_is_idempotent(self):
        scheduler, _acc, registry = _scheduler(units=2.0)
        scheduler.admit(_identity(0), target_fps=5.0)
        scheduler.admit(_identity(1), target_fps=5.0)
        self.assertAlmostEqual(registry.free_capacity, 0.0)
        scheduler.release(_identity(0))
        scheduler.release(_identity(0))  # double release must not manufacture capacity
        self.assertAlmostEqual(registry.free_capacity, 1.0)

    def test_admission_control_can_be_disabled(self):
        policy = SchedulerPolicy(admission_control=False, reserved_capacity_percent=0.0)
        scheduler, _acc, _reg = _scheduler(units=0.5, policy=policy)
        verdict, _ = scheduler.admit(_identity(0), target_fps=30.0)
        self.assertTrue(verdict.admitted)


class FairnessTest(unittest.TestCase):
    def test_no_session_is_ever_starved(self):
        scheduler, _acc, _reg = _scheduler()
        for i in range(8):
            scheduler.admit(_identity(i), target_fps=5.0)
        for _ in range(400):
            scheduler.next_session()
        shares = scheduler.fairness()["shares"]
        self.assertEqual(len(shares), 8)
        self.assertTrue(all(count > 0 for count in shares.values()), shares)

    def test_weighted_fair_gives_priority_proportional_share(self):
        scheduler, _acc, _reg = _scheduler()
        scheduler.admit(_identity(0), target_fps=5.0, priority="high")     # weight 4
        scheduler.admit(_identity(1), target_fps=5.0, priority="normal")   # weight 2
        for _ in range(600):
            scheduler.next_session()
        shares = scheduler.fairness()["shares"]
        ratio = shares["ses_0"] / shares["ses_1"]
        self.assertAlmostEqual(ratio, 2.0, delta=0.2)  # 4:2 weights → 2:1 share

    def test_round_robin_ignores_priority(self):
        policy = SchedulerPolicy(strategy="round-robin", reserved_capacity_percent=0.0)
        scheduler, _acc, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0, priority="critical")
        scheduler.admit(_identity(1), target_fps=5.0, priority="low")
        for _ in range(200):
            scheduler.next_session()
        shares = scheduler.fairness()["shares"]
        self.assertAlmostEqual(shares["ses_0"] / shares["ses_1"], 1.0, delta=0.2)

    def test_strict_priority_still_cannot_starve_forever(self):
        policy = SchedulerPolicy(
            strategy="strict-priority", max_consecutive_per_session=3, reserved_capacity_percent=0.0
        )
        scheduler, _acc, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0, priority="critical")
        scheduler.admit(_identity(1), target_fps=5.0, priority="low")
        for _ in range(200):
            scheduler.next_session()
        shares = scheduler.fairness()["shares"]
        self.assertGreater(shares.get("ses_1", 0), 0)  # the bound makes starvation impossible
        self.assertGreater(shares["ses_0"], shares["ses_1"])

    def test_only_ready_sessions_are_scheduled(self):
        scheduler, _acc, _reg = _scheduler()
        for i in range(3):
            scheduler.admit(_identity(i), target_fps=5.0)
        for _ in range(50):
            scheduler.next_session(ready=lambda sid: sid == "ses_1")
        self.assertEqual(set(scheduler.fairness()["shares"]) - {"ses_0", "ses_2"}, {"ses_1"})
        self.assertEqual(scheduler.fairness()["shares"].get("ses_0", 0), 0)

    def test_nothing_runnable_returns_none(self):
        scheduler, _acc, _reg = _scheduler()
        self.assertIsNone(scheduler.next_session())
        scheduler.admit(_identity(0), target_fps=5.0)
        self.assertIsNone(scheduler.next_session(ready=lambda _s: False))

    def test_batching_dispatches_up_to_max_batch_size(self):
        policy = SchedulerPolicy(max_batch_size=4, reserved_capacity_percent=0.0)
        scheduler, _acc, _reg = _scheduler(policy=policy)
        for i in range(4):
            scheduler.admit(_identity(i), target_fps=5.0)
        batch = scheduler.next_batch()
        self.assertEqual(len(batch), 4)
        self.assertEqual(scheduler.batches_dispatched, 1)
        self.assertEqual(scheduler.stats()["averageBatchSize"], 4.0)


class TrendTest(unittest.TestCase):
    def test_slope_detects_a_rising_queue(self):
        trend = Trend(window=5)
        for value in (10, 20, 30, 40, 50):
            trend.observe(value)
        self.assertAlmostEqual(trend.slope, 10.0, places=6)
        self.assertAlmostEqual(trend.project(3), 80.0, places=6)

    def test_flat_and_single_sample_have_no_slope(self):
        trend = Trend()
        trend.observe(42)
        self.assertEqual(trend.slope, 0.0)
        for _ in range(4):
            trend.observe(42)
        self.assertAlmostEqual(trend.slope, 0.0, places=6)

    def test_projection_never_goes_negative(self):
        trend = Trend()
        for value in (50, 40, 30, 20, 10):
            trend.observe(value)
        self.assertGreaterEqual(trend.project(10), 0.0)


class DegradationLadderTest(unittest.TestCase):
    """Refinement 3: graceful, ordered, reversible degradation instead of hard failure."""

    def test_ladder_is_ordered_cheapest_quality_loss_first(self):
        self.assertEqual(
            DEGRADATION_LADDER,
            ("none", "reduced-fps", "reduced-resolution", "reduced-behaviors", "shedding-frames", "suspended"),
        )
        self.assertLess(ladder_index("reduced-fps"), ladder_index("suspended"))

    def test_escalates_one_rung_at_a_time_under_sustained_pressure(self):
        policy = SchedulerPolicy(escalate_after_samples=2, predictive=False, reserved_capacity_percent=0.0)
        scheduler, accountant, _reg = _scheduler(policy=policy)
        # Two sessions so the fleet-collapse guard never blocks escalation.
        scheduler.admit(_identity(0), target_fps=5.0)
        scheduler.admit(_identity(1), target_fps=5.0)
        account = accountant.get(_identity(0))
        levels = []
        for _ in range(10):
            scheduler.governor.observe(account, queue_utilization=95.0)
            levels.append(account.degradation)
        # One rung per two observations, in order.
        self.assertEqual(levels[1], "reduced-fps")
        self.assertEqual(levels[3], "reduced-resolution")
        self.assertEqual(levels[5], "reduced-behaviors")

    def test_hysteresis_prevents_flapping_on_a_single_spike(self):
        policy = SchedulerPolicy(escalate_after_samples=3, predictive=False, reserved_capacity_percent=0.0)
        scheduler, accountant, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0)
        account = accountant.get(_identity(0))
        scheduler.governor.observe(account, queue_utilization=95.0)  # one spike
        scheduler.governor.observe(account, queue_utilization=10.0)  # back to calm
        self.assertEqual(account.degradation, "none")  # a spike alone must not throttle a camera

    def test_recovery_walks_back_down_the_ladder(self):
        policy = SchedulerPolicy(
            escalate_after_samples=1, recover_after_samples=1, predictive=False, reserved_capacity_percent=0.0
        )
        scheduler, accountant, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0)
        scheduler.admit(_identity(1), target_fps=5.0)
        account = accountant.get(_identity(0))
        for _ in range(3):
            scheduler.governor.observe(account, queue_utilization=95.0)
        self.assertEqual(account.degradation, "reduced-behaviors")
        for _ in range(3):
            scheduler.governor.observe(account, queue_utilization=5.0)
        self.assertEqual(account.degradation, "none")  # fully reversible

    def test_max_degradation_policy_caps_the_ladder(self):
        # A hospital must never suspend a camera.
        policy = SchedulerPolicy(
            escalate_after_samples=1, max_degradation="reduced-fps", predictive=False,
            reserved_capacity_percent=0.0,
        )
        scheduler, accountant, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0)
        scheduler.admit(_identity(1), target_fps=5.0)
        account = accountant.get(_identity(0))
        for _ in range(10):
            scheduler.governor.observe(account, queue_utilization=99.0)
        self.assertEqual(account.degradation, "reduced-fps")  # never climbs past the ceiling

    def test_never_suspends_the_last_running_session(self):
        # Suspending everything means the runtime analyzes nothing — worse than degrading everything.
        policy = SchedulerPolicy(escalate_after_samples=1, predictive=False, reserved_capacity_percent=0.0)
        scheduler, accountant, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0)
        account = accountant.get(_identity(0))
        for _ in range(20):
            scheduler.governor.observe(account, queue_utilization=100.0)
        self.assertNotEqual(account.degradation, "suspended")

    def test_effective_fps_halves_under_degradation_and_is_floored(self):
        policy = SchedulerPolicy(min_degraded_fps=2.0, reserved_capacity_percent=0.0)
        scheduler, accountant, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=10.0)
        account = accountant.get(_identity(0))
        self.assertEqual(scheduler.governor.effective_fps_for(account), 10.0)
        account.degradation = "reduced-fps"
        self.assertEqual(scheduler.governor.effective_fps_for(account), 5.0)
        account.degradation = "suspended"
        self.assertEqual(scheduler.governor.effective_fps_for(account), 0.0)


class PredictiveDegradationTest(unittest.TestCase):
    """Refinement 2: act on a projected overload, while there is still headroom to act."""

    def test_degrades_before_the_queue_is_actually_full(self):
        policy = SchedulerPolicy(
            predictive=True,
            escalate_after_samples=1,
            degrade_above_queue_percent=90.0,
            predicted_pressure_threshold=90.0,
            prediction_horizon_samples=3,
            reserved_capacity_percent=0.0,
        )
        scheduler, accountant, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0)
        scheduler.admit(_identity(1), target_fps=5.0)
        account = accountant.get(_identity(0))
        decision = None
        for utilization in (20.0, 40.0, 60.0):  # rising, but never above 90
            decision = scheduler.governor.observe(account, queue_utilization=utilization) or decision
        self.assertIsNotNone(decision)
        self.assertEqual(decision.reason, "predicted-pressure")
        self.assertLess(account.queue_utilization, policy.degrade_above_queue_percent)

    def test_a_flat_queue_never_triggers_prediction(self):
        policy = SchedulerPolicy(predictive=True, escalate_after_samples=1, reserved_capacity_percent=0.0)
        scheduler, accountant, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0)
        account = accountant.get(_identity(0))
        for _ in range(6):
            scheduler.governor.observe(account, queue_utilization=30.0)
        self.assertEqual(account.degradation, "none")

    def test_reactive_mode_waits_for_real_pressure(self):
        policy = SchedulerPolicy(predictive=False, escalate_after_samples=1, reserved_capacity_percent=0.0)
        scheduler, accountant, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0)
        account = accountant.get(_identity(0))
        for utilization in (20.0, 40.0, 60.0, 70.0):
            scheduler.governor.observe(account, queue_utilization=utilization)
        self.assertEqual(account.degradation, "none")


class ResourcePressureTest(unittest.TestCase):
    def test_cpu_and_memory_ceilings_trigger_degradation(self):
        policy = SchedulerPolicy(
            cpu_ceiling_percent=80.0, memory_ceiling_mb=1000.0, escalate_after_samples=1,
            predictive=False, reserved_capacity_percent=0.0,
        )
        scheduler, accountant, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0)
        scheduler.admit(_identity(1), target_fps=5.0)
        account = accountant.get(_identity(0))
        decision = scheduler.governor.observe(
            account, queue_utilization=5.0, snapshot=ResourceSnapshot(cpu_percent=95.0)
        )
        self.assertIsNotNone(decision)
        self.assertEqual(decision.reason, "cpu-pressure")

        account2 = accountant.get(_identity(1))
        decision2 = scheduler.governor.observe(
            account2, queue_utilization=5.0, snapshot=ResourceSnapshot(memory_mb=2000.0)
        )
        self.assertEqual(decision2.reason, "memory-pressure")


class AnalyzerCostModelTest(unittest.TestCase):
    """Refinement 4: disable the MOST EXPENSIVE analyzers first, not arbitrary ones."""

    def test_orders_analyzers_by_cost_and_respects_protection(self):
        scheduler, _acc, _reg = _scheduler(
            analyzer_costs={"crowd": 3.0, "loitering": 1.5, "occupancy": 1.0, "fire": 3.5},
            protected_analyzers=["fire"],
        )
        governor = scheduler.governor
        costliest = governor.most_expensive_analyzers(
            ["crowd", "loitering", "occupancy", "fire"], count=2
        )
        self.assertEqual(costliest, ["crowd", "loitering"])  # fire is protected despite costing most

    def test_unmodelled_analyzers_default_to_neutral_cost(self):
        scheduler, _acc, _reg = _scheduler(analyzer_costs={"crowd": 3.0})
        costliest = scheduler.governor.most_expensive_analyzers(["crowd", "mystery"], count=1)
        self.assertEqual(costliest, ["crowd"])


class DecisionRecordTest(unittest.TestCase):
    """Refinement 3/rec 4: every decision carries a structured, queryable reason."""

    def test_decisions_record_identity_action_reason_and_measurement(self):
        policy = SchedulerPolicy(escalate_after_samples=1, predictive=False, reserved_capacity_percent=0.0)
        scheduler, accountant, _reg = _scheduler(policy=policy)
        scheduler.admit(_identity(0), target_fps=5.0)
        scheduler.admit(_identity(1), target_fps=5.0)
        account = accountant.get(_identity(0))
        scheduler.governor.observe(account, queue_utilization=95.0)
        decision = scheduler.decisions.recent(1)[0]
        self.assertEqual(decision["identity"]["sessionId"], "ses_0")
        self.assertEqual(decision["action"], "degraded")
        self.assertEqual(decision["reason"], "queue-pressure")
        self.assertEqual(decision["fromLevel"], "none")
        self.assertEqual(decision["toLevel"], "reduced-fps")
        self.assertIn("queueUtilization", decision["measurement"])

    def test_decision_log_is_bounded_and_newest_first(self):
        log = DecisionLog(maxlen=3)
        from scheduler import SchedulerDecision

        for i in range(5):
            log.record(
                SchedulerDecision(identity=_identity(i), action="scheduled", reason="fair-share")
            )
        self.assertEqual(len(log), 3)
        self.assertEqual(log.recent(1)[0]["identity"]["sessionId"], "ses_4")

    def test_decisions_are_correlated_with_the_operational_log(self):
        records = []
        log = OperationalLog(_identity(0), sink=records.append)
        policy = SchedulerPolicy(escalate_after_samples=1, predictive=False, reserved_capacity_percent=0.0)
        scheduler, accountant, _reg = _scheduler(policy=policy, log=log)
        scheduler.admit(_identity(0), target_fps=5.0)
        scheduler.admit(_identity(1), target_fps=5.0)
        scheduler.governor.observe(accountant.get(_identity(0)), queue_utilization=95.0)
        self.assertTrue(records)
        self.assertEqual(records[-1]["event"], "scheduler.degraded")
        self.assertEqual(records[-1]["reason"], "queue-pressure")


class SchedulerStatsTest(unittest.TestCase):
    def test_stats_expose_shares_resources_and_decisions(self):
        scheduler, _acc, _reg = _scheduler()
        scheduler.admit(_identity(0), target_fps=5.0)
        scheduler.next_session()
        stats = scheduler.stats()
        self.assertEqual(stats["strategy"], "weighted-fair")
        self.assertEqual(stats["registeredSessions"], 1)
        self.assertIn("sharesBySession", stats)
        self.assertTrue(stats["computeResources"])
        self.assertTrue(stats["recentDecisions"])

    def test_suspended_sessions_are_not_scheduled(self):
        scheduler, accountant, _reg = _scheduler()
        scheduler.admit(_identity(0), target_fps=5.0)
        scheduler.admit(_identity(1), target_fps=5.0)
        accountant.get(_identity(0)).degradation = "suspended"
        for _ in range(20):
            scheduler.next_session()
        self.assertEqual(scheduler.fairness()["shares"].get("ses_0", 0), 0)
        self.assertGreater(scheduler.fairness()["shares"]["ses_1"], 0)


if __name__ == "__main__":
    unittest.main()
