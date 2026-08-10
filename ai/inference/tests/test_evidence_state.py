"""The six evidence states — Evidence Integrity, EI-4.

⛔ **Measured before this suite was written: every one of these was the empty list.**

    a stream that never existed        →  []
    a run still three seconds in       →  []
    a run whose durable write failed   →  []
    a file with a truncated record     →  []
    a run past its retention           →  []

Five facts, one answer, and the answer is the reassuring one.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import evidence_state as es  # noqa: E402


class StateTests(unittest.TestCase):
    def test_records_that_are_closed_are_present(self) -> None:
        state = es.assess(durable=4, live=0, damaged_records=0, lost_identities=[])
        self.assertEqual(state.state, "present")

    def test_an_empty_answer_with_nothing_wrong_is_absent(self) -> None:
        state = es.assess(durable=0, live=0, damaged_records=0, lost_identities=[])
        self.assertEqual(state.state, "absent")

    def test_open_records_are_not_yet_available(self) -> None:
        """⚠️ A run in progress is a lower bound, not a result — and reading it as a result is how a
        dwell that is still growing gets reported as a finished one."""
        state = es.assess(durable=2, live=3, damaged_records=0, lost_identities=[])
        self.assertEqual(state.state, "notYetAvailable")
        self.assertEqual(state.live, 3)

    def test_a_failed_write_is_lost_and_never_absent(self) -> None:
        """⛔ The milestone's rule: **Lost must never be reported as Absent.**"""
        state = es.assess(durable=0, live=0, damaged_records=0, lost_identities=["idn_a"])
        self.assertEqual(state.state, "lost")
        self.assertIn("idn_a", state.detail)

    def test_damage_is_corrupted_and_never_missing(self) -> None:
        """⛔ The milestone's rule: **Corrupted must never appear as Missing.**"""
        state = es.assess(durable=0, live=0, damaged_records=1, lost_identities=[])
        self.assertEqual(state.state, "corrupted")

    def test_damage_outranks_a_partial_present(self) -> None:
        """⛔ The precedence that matters most. Four readable records out of five render exactly
        like four out of four, and nothing on screen distinguishes them."""
        state = es.assess(durable=4, live=0, damaged_records=1, lost_identities=[])
        self.assertEqual(state.state, "corrupted")
        self.assertIn("incomplete", state.detail)

    def test_loss_outranks_a_partial_present(self) -> None:
        state = es.assess(durable=4, live=0, damaged_records=0, lost_identities=["idn_a"])
        self.assertEqual(state.state, "lost")

    def test_every_state_word_is_in_the_closed_vocabulary(self) -> None:
        """⚠️ So a new state cannot arrive without the contract and the console learning it."""
        produced = {
            es.assess(durable=1, live=0, damaged_records=0, lost_identities=[]).state,
            es.assess(durable=0, live=0, damaged_records=0, lost_identities=[]).state,
            es.assess(durable=0, live=1, damaged_records=0, lost_identities=[]).state,
            es.assess(durable=0, live=0, damaged_records=0, lost_identities=["a"]).state,
            es.assess(durable=0, live=0, damaged_records=1, lost_identities=[]).state,
            es.resolve_expiry(
                es.assess(
                    durable=0,
                    live=0,
                    damaged_records=0,
                    lost_identities=[],
                    retention_horizon_at="2026-08-10T00:00:00Z",
                ),
                finished_at="2026-08-01T00:00:00Z",
            ).state,
        }
        self.assertEqual(produced, set(es.EVIDENCE_STATES))


class ExpiryTests(unittest.TestCase):
    """⭐ A proof, not an inference: retention removes everything written before the horizon, so a
    run that finished before it *cannot* have surviving records."""

    HORIZON = "2026-08-10T00:00:00Z"

    def _absent(self) -> es.EvidenceState:
        return es.assess(
            durable=0,
            live=0,
            damaged_records=0,
            lost_identities=[],
            retention_horizon_at=self.HORIZON,
        )

    def test_a_run_older_than_the_horizon_is_expired(self) -> None:
        state = es.resolve_expiry(self._absent(), finished_at="2026-08-01T12:00:00Z")
        self.assertEqual(state.state, "expired")
        self.assertIn("retention", state.detail)

    def test_a_run_inside_the_horizon_stays_absent(self) -> None:
        """⚠️ The negative control. An expiry that always fires explains every empty answer away."""
        state = es.resolve_expiry(self._absent(), finished_at="2026-08-10T12:00:00Z")
        self.assertEqual(state.state, "absent")

    def test_a_run_with_no_finish_time_stays_absent(self) -> None:
        self.assertEqual(es.resolve_expiry(self._absent(), finished_at=None).state, "absent")

    def test_an_unparseable_finish_time_stays_absent(self) -> None:
        """⚠️ Fails towards the honest answer: an unreadable timestamp must not manufacture an
        explanation for missing evidence."""
        self.assertEqual(es.resolve_expiry(self._absent(), finished_at="whenever").state, "absent")

    def test_expired_must_never_be_reported_as_lost(self) -> None:
        """⛔ The milestone's third rule, in both directions.

        A `lost` read past the horizon is still `lost` — calling it `expired` would excuse a defect
        as a policy, which is the most comfortable lie available here.
        """
        lost = es.assess(
            durable=0,
            live=0,
            damaged_records=0,
            lost_identities=["idn_a"],
            retention_horizon_at=self.HORIZON,
        )
        self.assertEqual(es.resolve_expiry(lost, finished_at="2026-08-01T00:00:00Z").state, "lost")

    def test_corrupted_is_not_excused_by_age_either(self) -> None:
        damaged = es.assess(
            durable=0,
            live=0,
            damaged_records=2,
            lost_identities=[],
            retention_horizon_at=self.HORIZON,
        )
        self.assertEqual(
            es.resolve_expiry(damaged, finished_at="2026-08-01T00:00:00Z").state, "corrupted"
        )

    def test_the_horizon_is_computed_from_the_retention_policy(self) -> None:
        moment = 1786_000_000.0
        self.assertEqual(es.horizon(moment, 72.0), es.horizon(moment, 72.0))
        self.assertLess(es.horizon(moment, 72.0), es.horizon(moment, 1.0))


class ScopeTests(unittest.TestCase):
    """⚠️ A loss on an unrelated camera must not make this analysis read `lost`. A state word that
    is wrong in the alarming direction is ignored exactly as fast as one wrong the other way."""

    LOST = [
        ("tnt_a", "cam_1", "ases_1", "idn_mine"),
        ("tnt_a", "cam_2", "ases_2", "idn_other_camera"),
        ("tnt_b", "cam_1", "ases_1", "idn_other_tenant"),
    ]

    def test_scoping_to_a_stream_names_only_that_stream(self) -> None:
        found = es.lost_in_scope(self.LOST, tenant_id="tnt_a", camera_id="cam_1", stream_id="ases_1")
        self.assertEqual(found, ["idn_mine"])

    def test_another_tenants_loss_is_never_reported(self) -> None:
        found = es.lost_in_scope(self.LOST, tenant_id="tnt_b")
        self.assertEqual(found, ["idn_other_tenant"])

    def test_an_unscoped_query_sees_the_whole_tenant(self) -> None:
        found = es.lost_in_scope(self.LOST, tenant_id="tnt_a")
        self.assertEqual(found, ["idn_mine", "idn_other_camera"])


if __name__ == "__main__":
    unittest.main()
