"""Auto-recovery (AI-5d) — budgets, the never-retry rule, backoff, and anti-oscillation.

The most important tests here assert what recovery REFUSES to do. A runtime that restarts eagerly is
easy to write and impossible to operate: it hides configuration errors, hammers a flapping link, and
buries the one log line that would have told someone what to fix.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from errors import (  # noqa: E402
    ConfigurationFailure,
    ConnectionFailure,
    InferenceError,
    ModelFailure,
    PipelineFailure,
)
from operational_log import OperationalLog, SessionIdentity  # noqa: E402
from recovery import (  # noqa: E402
    NEVER_AUTO_RECOVER,
    AutoRecovery,
    RecoveryPolicy,
    bank_policy,
    factory_policy,
    healthcare_policy,
    retail_policy,
)


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> float:
        self.now += seconds
        return self.now


def _identity(index: int = 0) -> SessionIdentity:
    return SessionIdentity("tnt_a", f"cam_{index}", f"ses_{index}", correlation_id="corr_1")


def _recovery(policy=None, clock=None) -> AutoRecovery:
    return AutoRecovery(
        policy=policy or RecoveryPolicy(stabilization_seconds=0.0),
        clock=clock or _Clock(),
        now_iso=lambda: "2026-08-01T00:00:00.000Z",
    )


class TaxonomyTest(unittest.TestCase):
    """Recovery executes the frozen AI-5b taxonomy — it never invents a judgement."""

    def test_each_category_maps_to_its_declared_action(self):
        recovery = _recovery()
        cases = {
            ConnectionFailure("lost"): "restart-session",
            ModelFailure("bad artifact"): "rebind-model",
            InferenceError("bad frame"): "skip-frame",
            PipelineFailure("queue broke"): "skip-frame",
            ConfigurationFailure("bad uri"): "operator-intervention",
        }
        for exc, expected in cases.items():
            reason = recovery.reason_for(exc, identity=_identity())
            self.assertEqual(recovery.action_for(reason), expected, f"for {type(exc).__name__}")

    def test_the_reason_carries_the_full_structured_why(self):
        # Rec 1: trigger, subsystem, severity, retry count, correlation id — all of it.
        recovery = _recovery()
        reason = recovery.reason_for(ConnectionFailure("link down"), identity=_identity(), retry_count=2)
        out = reason.to_dict()
        self.assertEqual(out["trigger"], "connection-lost")
        self.assertEqual(out["subsystem"], "stream-source")
        self.assertEqual(out["severity"], "warning")
        self.assertEqual(out["retryCount"], 2)
        self.assertEqual(out["correlationId"], "corr_1")
        self.assertEqual(out["failureCategory"], "connection")
        self.assertEqual(out["failureCode"], "AI-CONN")

    def test_a_failure_originates_in_the_tier_that_owns_it(self):
        recovery = _recovery()
        self.assertEqual(
            recovery.reason_for(PipelineFailure("x"), identity=_identity()).subsystem, "stream-pipeline"
        )
        self.assertEqual(
            recovery.reason_for(InferenceError("x"), identity=_identity()).subsystem, "video-analyzer"
        )

    def test_health_decline_degrades_and_never_restarts(self):
        # Health produces evidence; it must never be able to restart a session by itself.
        recovery = _recovery()
        reason = recovery.health_reason(_identity(), score=62.0)
        self.assertEqual(reason.trigger, "health-decline")
        self.assertEqual(recovery.action_for(reason), "degrade")


class ConfigurationIsNeverRetriedTest(unittest.TestCase):
    """The AI-5b rule, now enforced in code rather than merely described."""

    def test_a_configuration_failure_is_handed_to_an_operator(self):
        recovery = _recovery()
        restarts = []
        reason = recovery.reason_for(ConfigurationFailure("rtsp://typo"), identity=_identity())
        attempt = recovery.attempt(_identity(), reason, restart=lambda: restarts.append(1))
        self.assertEqual(attempt.outcome, "operator-required")
        self.assertEqual(attempt.action, "operator-intervention")
        self.assertEqual(restarts, [], "a configuration error must never trigger a restart")

    def test_no_policy_can_arm_configuration_recovery(self):
        # A misconfigured profile must not be able to create a restart loop against an operator error.
        with self.assertRaises(ConfigurationFailure):
            RecoveryPolicy(auto_recover_categories=("connection", "configuration"))
        self.assertIn("configuration", NEVER_AUTO_RECOVER)

    def test_repeated_configuration_failures_never_consume_budget(self):
        recovery = _recovery(RecoveryPolicy(max_restarts=1, stabilization_seconds=0.0))
        for _ in range(10):
            reason = recovery.reason_for(ConfigurationFailure("bad"), identity=_identity())
            recovery.attempt(_identity(), reason, restart=lambda: None)
        self.assertEqual(recovery.budget_remaining(_identity()), 1)


class BudgetTest(unittest.TestCase):
    """Rec 4: budgets are configuration, and they are actually enforced."""

    def _fail(self, recovery, times: int, clock=None):
        """Fail repeatedly inside ONE budget window, so the budget is what is under test.

        The advance is deliberately tiny: stepping the clock far enough to roll the window would
        silently test the window instead, and every failure would "succeed" forever.
        """
        outcomes = []
        for _ in range(times):
            if clock is not None:
                clock.advance(1.0)
            reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity())
            outcomes.append(recovery.attempt(_identity(), reason, restart=lambda: None).outcome)
        return outcomes

    def test_retail_stops_after_three(self):
        clock = _Clock()
        recovery = AutoRecovery(
            policy=RecoveryPolicy(max_restarts=3, stabilization_seconds=0.0), clock=clock
        )
        outcomes = self._fail(recovery, 6, clock)
        self.assertEqual(outcomes.count("succeeded"), 3)
        self.assertEqual(outcomes.count("budget-exhausted"), 3)

    def test_factory_gets_ten(self):
        clock = _Clock()
        policy = factory_policy()
        policy.stabilization_seconds = 0.0
        recovery = AutoRecovery(policy=policy, clock=clock)
        self.assertEqual(self._fail(recovery, 12, clock).count("succeeded"), 10)

    def test_a_bank_never_gives_up(self):
        clock = _Clock()
        policy = bank_policy()
        policy.stabilization_seconds = 0.0
        recovery = AutoRecovery(policy=policy, clock=clock)
        outcomes = self._fail(recovery, 50, clock)
        self.assertEqual(outcomes.count("budget-exhausted"), 0)
        self.assertIsNone(recovery.budget_remaining(_identity()))

    def test_healthcare_never_restarts_without_a_human(self):
        recovery = AutoRecovery(policy=healthcare_policy(), clock=_Clock())
        restarts = []
        reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity())
        attempt = recovery.attempt(_identity(), reason, restart=lambda: restarts.append(1))
        self.assertEqual(attempt.outcome, "operator-required")
        self.assertEqual(restarts, [])

    def test_the_budget_window_rolls(self):
        clock = _Clock()
        recovery = AutoRecovery(
            policy=RecoveryPolicy(max_restarts=2, restart_window_seconds=100.0, stabilization_seconds=0.0),
            clock=clock,
        )
        self._fail(recovery, 2)
        self.assertEqual(recovery.budget_remaining(_identity()), 0)
        clock.advance(101.0)  # the window rolls past both attempts
        self.assertEqual(recovery.budget_remaining(_identity()), 2)

    def test_budgets_are_per_session_never_fleet_wide(self):
        recovery = _recovery(RecoveryPolicy(max_restarts=1, stabilization_seconds=0.0))
        for index in range(5):
            reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity(index))
            attempt = recovery.attempt(_identity(index), reason, restart=lambda: None)
            self.assertTrue(attempt.recovered, f"session {index} was denied another session's budget")

    def test_a_category_outside_policy_is_blocked(self):
        recovery = _recovery(
            RecoveryPolicy(auto_recover_categories=("connection",), stabilization_seconds=0.0)
        )
        reason = recovery.reason_for(ModelFailure("bad"), identity=_identity())
        attempt = recovery.attempt(_identity(), reason, restart=lambda: None)
        self.assertEqual(attempt.outcome, "blocked-by-policy")

    def test_skip_frame_actions_never_consume_budget(self):
        # Skipping one frame is not a recovery event; counting it would exhaust a budget in seconds.
        recovery = _recovery(RecoveryPolicy(max_restarts=1, stabilization_seconds=0.0))
        for _ in range(100):
            reason = recovery.reason_for(InferenceError("bad frame"), identity=_identity())
            self.assertTrue(recovery.attempt(_identity(), reason).recovered)
        self.assertEqual(recovery.budget_remaining(_identity()), 1)


class BackoffTest(unittest.TestCase):
    def test_cooldown_grows_exponentially_and_is_capped(self):
        policy = RecoveryPolicy(base_cooldown_ms=1000.0, max_cooldown_ms=8000.0)
        self.assertEqual(
            [policy.cooldown_for(n) for n in range(1, 7)],
            [1000.0, 2000.0, 4000.0, 8000.0, 8000.0, 8000.0],
        )

    def test_max_cooldown_below_base_is_rejected(self):
        with self.assertRaises(ConfigurationFailure):
            RecoveryPolicy(base_cooldown_ms=10000.0, max_cooldown_ms=1000.0)


class AntiOscillationTest(unittest.TestCase):
    """Rec 6: a session that just recovered has not proven anything yet."""

    def test_a_second_recovery_inside_the_window_is_deferred(self):
        clock = _Clock()
        recovery = AutoRecovery(
            policy=RecoveryPolicy(max_restarts=10, stabilization_seconds=60.0), clock=clock
        )
        reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity())
        self.assertTrue(recovery.attempt(_identity(), reason, restart=lambda: None).recovered)
        clock.advance(5.0)
        second = recovery.attempt(_identity(), reason, restart=lambda: None)
        self.assertEqual(second.outcome, "cooldown")
        self.assertGreater(second.cooldown_ms, 0)

    def test_recovery_resumes_once_the_window_has_passed(self):
        clock = _Clock()
        recovery = AutoRecovery(
            policy=RecoveryPolicy(max_restarts=10, stabilization_seconds=60.0), clock=clock
        )
        reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity())
        recovery.attempt(_identity(), reason, restart=lambda: None)
        clock.advance(61.0)
        self.assertTrue(recovery.attempt(_identity(), reason, restart=lambda: None).recovered)

    def test_stabilized_reports_the_window(self):
        clock = _Clock()
        recovery = AutoRecovery(
            policy=RecoveryPolicy(stabilization_seconds=30.0), clock=clock
        )
        self.assertTrue(recovery.stabilized(_identity()), "a never-recovered session is stable")
        reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity())
        recovery.attempt(_identity(), reason, restart=lambda: None)
        self.assertFalse(recovery.stabilized(_identity()))
        clock.advance(30.0)
        self.assertTrue(recovery.stabilized(_identity()))


class OutcomeRecordingTest(unittest.TestCase):
    """Every refusal is recorded — a recovery that did NOT happen is as interesting as one that did."""

    def test_a_failed_executor_is_an_outcome_not_a_crash(self):
        recovery = _recovery()

        def boom() -> None:
            raise RuntimeError("restart blew up")

        reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity())
        attempt = recovery.attempt(_identity(), reason, restart=boom)
        self.assertEqual(attempt.outcome, "failed")
        self.assertIn("blew up", attempt.detail)

    def test_a_missing_executor_defers_rather_than_pretending(self):
        recovery = _recovery()
        reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity())
        self.assertEqual(recovery.attempt(_identity(), reason).outcome, "deferred")

    def test_history_is_newest_first_and_bounded(self):
        recovery = _recovery(RecoveryPolicy(max_restarts=1000, stabilization_seconds=0.0))
        for _ in range(150):
            reason = recovery.reason_for(InferenceError("x"), identity=_identity())
            recovery.attempt(_identity(), reason)
        self.assertEqual(len(recovery.history(_identity(), limit=1000)), 100)  # bounded ledger

    def test_forget_releases_a_session_entirely(self):
        recovery = _recovery()
        reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity())
        recovery.attempt(_identity(), reason, restart=lambda: None)
        recovery.forget(_identity())
        self.assertEqual(recovery.history(_identity()), [])
        self.assertEqual(recovery.ledger.total(_identity()), 0)

    def test_attempts_serialize_to_the_contract_shape(self):
        recovery = _recovery()
        reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity())
        out = recovery.attempt(_identity(), reason, restart=lambda: None).to_dict()
        for key in ("identity", "reason", "action", "outcome", "attempt"):
            self.assertIn(key, out)
        self.assertEqual(out["reason"]["failureCode"], "AI-CONN")

    def test_recoveries_are_logged_with_the_session_identity(self):
        records = []
        recovery = AutoRecovery(
            policy=RecoveryPolicy(stabilization_seconds=0.0),
            clock=_Clock(),
            log=OperationalLog(_identity(), sink=records.append),
        )
        reason = recovery.reason_for(ConnectionFailure("down"), identity=_identity())
        recovery.attempt(_identity(), reason, restart=lambda: None)
        self.assertEqual(records[0]["event"], "recovery.succeeded")
        self.assertEqual(records[0]["sessionId"], "ses_0")
        self.assertEqual(records[0]["code"], "AI-CONN")


class TenantIsolationTest(unittest.TestCase):
    def test_one_tenant_never_spends_or_sees_anothers_budget(self):
        # Same camera id and same session id in two tenants — the collision a session-only key leaks.
        recovery = _recovery(RecoveryPolicy(max_restarts=1, stabilization_seconds=0.0))
        a = SessionIdentity("tnt_a", "cam_1", "ses_1")
        b = SessionIdentity("tnt_b", "cam_1", "ses_1")
        reason_a = recovery.reason_for(ConnectionFailure("down"), identity=a)
        recovery.attempt(a, reason_a, restart=lambda: None)
        self.assertEqual(recovery.budget_remaining(a), 0)
        self.assertEqual(recovery.budget_remaining(b), 1)
        self.assertEqual(recovery.history(b), [])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
