"""AI-5e capability-maturity promotion tests.

`CAPABILITY_MATURITY.md` is a markdown table anyone can edit. This module makes promotion a function
that asks "on the strength of what?", and these tests are the record of what it will and will not
accept. The important ones are refusals: a promotion that succeeds when it should not is invisible
until a customer relies on it.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from maturity import (  # noqa: E402
    MATURITY_LEVELS,
    MaturityEvidence,
    MaturityRegister,
    promote,
    render_promotion,
)

AT = lambda: "2026-08-01T00:00:00.000Z"  # noqa: E731


def _footage_evidence(**kw) -> MaturityEvidence:
    defaults = dict(
        evidence_class="recorded-footage",
        evaluation_report_ids=["eval_1"],
        evaluation_accepted=True,
    )
    defaults.update(kw)
    return MaturityEvidence(**defaults)


def _hardware_evidence(**kw) -> MaturityEvidence:
    defaults = dict(
        evidence_class="hardware",
        evaluation_report_ids=["eval_1"],
        evaluation_accepted=True,
        compatibility_report_id="compat_1",
        certification_summary_id="cert_1",
        certification_status="certified",
        soak_report_id="soak_1",
        soak_passed=True,
        benchmark_report_id="bench_1",
        benchmark_accepted=True,
    )
    defaults.update(kw)
    return MaturityEvidence(**defaults)


class LadderTest(unittest.TestCase):
    def test_the_ladder_matches_the_register(self):
        self.assertEqual(MATURITY_LEVELS, ("experimental", "beta", "production", "deprecated"))

    def test_a_level_cannot_be_skipped(self):
        d = promote("x", current="experimental", target="production", evidence=_hardware_evidence(), now_iso=AT)
        self.assertFalse(d.granted)
        self.assertTrue(any("cannot skip a level" in b for b in d.blockers))

    def test_an_unknown_level_is_refused(self):
        d = promote("x", current="experimental", target="amazing", evidence=_hardware_evidence(), now_iso=AT)
        self.assertFalse(d.granted)

    def test_demotion_needs_no_evidence(self):
        """Discovering that something is worse than believed must never be harder than claiming it is
        better. A gate that makes demotion expensive is a gate that keeps bad capabilities promoted."""
        d = promote("x", current="production", target="beta", evidence=MaturityEvidence(), now_iso=AT)
        self.assertTrue(d.granted)
        self.assertEqual(d.blockers, [])

    def test_no_change_is_granted_trivially(self):
        d = promote("x", current="beta", target="beta", evidence=MaturityEvidence(), now_iso=AT)
        self.assertTrue(d.granted)
        self.assertEqual(d.notes, "no change")


class BetaTest(unittest.TestCase):
    def test_simulation_never_reaches_beta(self):
        d = promote(
            "x", current="experimental", target="beta",
            evidence=MaturityEvidence(evidence_class="simulated", evaluation_report_ids=["eval_1"]),
            now_iso=AT,
        )
        self.assertFalse(d.granted)
        self.assertTrue(any("'simulated'" in b for b in d.blockers))

    def test_beta_needs_a_dataset_evaluation(self):
        d = promote(
            "x", current="experimental", target="beta",
            evidence=MaturityEvidence(evidence_class="recorded-footage"), now_iso=AT,
        )
        self.assertFalse(d.granted)
        self.assertTrue(any("dataset evaluation" in b for b in d.blockers))

    def test_a_cited_evaluation_that_failed_does_not_count(self):
        # An id proves a run happened, not that it succeeded.
        d = promote(
            "x", current="experimental", target="beta",
            evidence=_footage_evidence(evaluation_accepted=False), now_iso=AT,
        )
        self.assertFalse(d.granted)

    def test_recorded_footage_with_a_passing_evaluation_reaches_beta(self):
        d = promote("x", current="experimental", target="beta", evidence=_footage_evidence(), now_iso=AT)
        self.assertTrue(d.granted, d.blockers)


class ProductionTest(unittest.TestCase):
    def test_recorded_footage_alone_does_not_reach_production(self):
        """Footage proves perception. Production also requires that the thing survives a real device
        for a real night, which no clip can establish."""
        d = promote("x", current="beta", target="production", evidence=_footage_evidence(), now_iso=AT)
        self.assertFalse(d.granted)
        self.assertTrue(any("hardware evidence" in b for b in d.blockers))

    def test_full_hardware_evidence_reaches_production(self):
        d = promote("x", current="beta", target="production", evidence=_hardware_evidence(), now_iso=AT)
        self.assertTrue(d.granted, d.blockers)
        self.assertEqual(d.blockers, [])

    def test_every_missing_artifact_is_reported_at_once(self):
        """An engineer who has to run the gate five times to discover five blockers stops running
        the gate."""
        d = promote(
            "x", current="beta", target="production",
            evidence=MaturityEvidence(
                evidence_class="hardware", evaluation_report_ids=["eval_1"], evaluation_accepted=True
            ),
            now_iso=AT,
        )
        self.assertFalse(d.granted)
        joined = " ".join(d.blockers)
        for required in ("compatibility report", "certification summary", "soak report", "benchmark"):
            self.assertIn(required, joined)

    def test_a_certification_that_did_not_certify_blocks(self):
        d = promote(
            "x", current="beta", target="production",
            evidence=_hardware_evidence(certification_status="pending-validation"), now_iso=AT,
        )
        self.assertFalse(d.granted)
        self.assertTrue(any("not 'certified'" in b for b in d.blockers))

    def test_a_soak_that_did_not_pass_blocks(self):
        d = promote(
            "x", current="beta", target="production",
            evidence=_hardware_evidence(soak_passed=False), now_iso=AT,
        )
        self.assertFalse(d.granted)
        self.assertTrue(any("soak report did not pass" in b for b in d.blockers))

    def test_a_regressed_benchmark_blocks(self):
        d = promote(
            "x", current="beta", target="production",
            evidence=_hardware_evidence(benchmark_accepted=False), now_iso=AT,
        )
        self.assertFalse(d.granted)
        self.assertTrue(any("regressed against the accepted baseline" in b for b in d.blockers))


class DeprecationTest(unittest.TestCase):
    def test_deprecation_requires_a_successor(self):
        # Deprecating with nowhere to go strands whoever is using it.
        d = promote("x", current="production", target="deprecated", evidence=MaturityEvidence(), now_iso=AT)
        self.assertFalse(d.granted)
        self.assertTrue(any("named successor" in b for b in d.blockers))

    def test_deprecation_with_a_successor_is_granted(self):
        d = promote(
            "x", current="production", target="deprecated",
            evidence=MaturityEvidence(), successor="x-v2", now_iso=AT,
        )
        self.assertTrue(d.granted)
        self.assertIn("x-v2", d.notes)

    def test_a_deprecated_capability_cannot_be_promoted_back(self):
        d = promote("x", current="deprecated", target="beta", evidence=_hardware_evidence(), now_iso=AT)
        self.assertFalse(d.granted)
        self.assertTrue(any("introduce a successor" in b for b in d.blockers))


class RegisterTest(unittest.TestCase):
    def test_a_refused_request_leaves_the_level_untouched(self):
        register = MaturityRegister({"fire": "experimental"})
        register.request("fire", "beta", MaturityEvidence(evidence_class="simulated"), now_iso=AT)
        self.assertEqual(register.level("fire"), "experimental")

    def test_a_refusal_is_still_recorded_in_the_history(self):
        """The record you want when someone asks in six months why Fire Detection is still
        Experimental."""
        register = MaturityRegister({"fire": "experimental"})
        register.request("fire", "beta", MaturityEvidence(evidence_class="simulated"), now_iso=AT)
        self.assertEqual(len(register.history), 1)
        self.assertEqual(len(register.refused()), 1)

    def test_a_granted_request_moves_the_level(self):
        register = MaturityRegister({"loitering": "experimental"})
        register.request("loitering", "beta", _footage_evidence(), now_iso=AT)
        self.assertEqual(register.level("loitering"), "beta")

    def test_an_unknown_capability_starts_experimental(self):
        self.assertEqual(MaturityRegister().level("brand-new"), "experimental")

    def test_the_register_reports_its_weakest_evidence(self):
        register = MaturityRegister()
        register.request("a", "beta", _footage_evidence(), now_iso=AT)
        register.request("b", "beta", MaturityEvidence(evidence_class="simulated"), now_iso=AT)
        self.assertEqual(register.evidence_class(), "simulated")

    def test_it_renders(self):
        register = MaturityRegister({"loitering": "beta", "fire": "experimental"})
        text = register.render()
        self.assertIn("loitering", text)
        self.assertIn("experimental", text)

    def test_a_promotion_renders_with_its_blockers(self):
        d = promote("x", current="beta", target="production", evidence=_footage_evidence(), now_iso=AT)
        text = render_promotion(d)
        self.assertIn("REFUSED", text)
        self.assertIn("hardware evidence", text)


if __name__ == "__main__":
    unittest.main()
