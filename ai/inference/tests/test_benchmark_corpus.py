"""The declared benchmark corpus and its coverage rules — P3.1.

⛔ **The load-bearing test in this file is `test_authored_footage_can_never_reach_available`.**

Audited 2026-08-10: 31 of 38 fixture clips are authored, and there is no video of real people
anywhere in this repository. The risk is not that somebody writes "AVAILABLE" in a document — it is
that a benchmark runs, produces a clean table, and the table is quoted six months later as evidence
that a detector works on people. These tests make the promotion **unreachable** rather than
discouraged.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import benchmark_corpus as bc  # noqa: E402

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
FIXTURES = os.path.join(REPO, "infra", "docker", "fixtures", "media")
CORPUS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "benchmarks", "detector-corpus.json")


def case(**kw) -> bc.BenchmarkCase:
    base = {
        "case_id": "c1",
        "path": "x.mp4",
        "category": "motion",
        "footage_kind": "AUTHORED",
        "scenarios": ("normal-person",),
    }
    base.update(kw)
    return bc.BenchmarkCase(**base)


class CoverageRuleTests(unittest.TestCase):
    def test_authored_footage_can_never_reach_available(self) -> None:
        """⛔ **The rule the whole milestone rests on.** No manifest, no flag, no argument promotes a
        rendered rectangle to evidence about people."""
        corpus = bc.Corpus(version="v", cases=(case(footage_kind="AUTHORED"),))
        row = next(r for r in bc.coverage(corpus) if r.scenario == "normal-person")
        self.assertEqual(row.state, "PARTIAL")

    def test_synthetic_footage_can_never_reach_available(self) -> None:
        corpus = bc.Corpus(version="v", cases=(case(footage_kind="SYNTHETIC"),))
        row = next(r for r in bc.coverage(corpus) if r.scenario == "normal-person")
        self.assertEqual(row.state, "PARTIAL")

    def test_a_photograph_can_never_reach_available(self) -> None:
        """⚠️ Real imagery, and still capped: a still cannot answer a question about motion,
        tracking or occlusion over time."""
        corpus = bc.Corpus(version="v", cases=(case(footage_kind="PHOTOGRAPH"),))
        row = next(r for r in bc.coverage(corpus) if r.scenario == "normal-person")
        self.assertEqual(row.state, "PARTIAL")

    def test_real_footage_is_the_only_thing_that_promotes(self) -> None:
        """⚠️ The positive control. A cap that never lifts would make the state word meaningless."""
        corpus = bc.Corpus(version="v", cases=(case(footage_kind="REAL_FOOTAGE"),))
        row = next(r for r in bc.coverage(corpus) if r.scenario == "normal-person")
        self.assertEqual(row.state, "AVAILABLE")

    def test_many_authored_cases_still_do_not_promote(self) -> None:
        """⛔ Volume is not evidence. Twenty rendered clips are twenty rendered clips."""
        cases = tuple(case(case_id=f"c{i}", footage_kind="AUTHORED") for i in range(20))
        corpus = bc.Corpus(version="v", cases=cases)
        row = next(r for r in bc.coverage(corpus) if r.scenario == "normal-person")
        self.assertEqual(row.state, "PARTIAL")

    def test_one_real_case_alongside_authored_ones_promotes(self) -> None:
        cases = (case(case_id="a"), case(case_id="b", footage_kind="REAL_FOOTAGE"))
        corpus = bc.Corpus(version="v", cases=cases)
        row = next(r for r in bc.coverage(corpus) if r.scenario == "normal-person")
        self.assertEqual(row.state, "AVAILABLE")

    def test_a_scenario_with_no_case_is_missing(self) -> None:
        corpus = bc.Corpus(version="v", cases=(case(),))
        row = next(r for r in bc.coverage(corpus) if r.scenario == "handover")
        self.assertEqual(row.state, "MISSING")
        self.assertEqual(row.cases, ())

    def test_every_required_scenario_is_reported(self) -> None:
        """⚠️ A scenario that is simply absent from the report reads as covered."""
        corpus = bc.Corpus(version="v", cases=(case(),))
        self.assertEqual([r.scenario for r in bc.coverage(corpus)], list(bc.SCENARIOS))


class AccuracyGateTests(unittest.TestCase):
    """⛔ Precision and recall are permitted **only** where annotations exist."""

    def test_a_scenario_without_ground_truth_cannot_be_scored(self) -> None:
        corpus = bc.Corpus(version="v", cases=(case(footage_kind="REAL_FOOTAGE"),))
        row = next(r for r in bc.coverage(corpus) if r.scenario == "normal-person")
        self.assertEqual(row.state, "AVAILABLE")
        self.assertFalse(row.accuracy_measurable)

    def test_ground_truth_is_what_authorises_accuracy(self) -> None:
        corpus = bc.Corpus(
            version="v", cases=(case(footage_kind="REAL_FOOTAGE", ground_truth="a.json"),)
        )
        row = next(r for r in bc.coverage(corpus) if r.scenario == "normal-person")
        self.assertTrue(row.accuracy_measurable)


class ManifestValidationTests(unittest.TestCase):
    def _write(self, doc) -> str:
        directory = tempfile.mkdtemp()
        path = os.path.join(directory, "corpus.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(doc, handle)
        return path

    def test_an_unversioned_corpus_is_refused(self) -> None:
        """⛔ A result that cannot name its corpus is not reproducible."""
        path = self._write({"cases": [{"caseId": "a", "footageKind": "AUTHORED"}]})
        with self.assertRaises(bc.CorpusError):
            bc.load(path, require_files=False)

    def test_an_unknown_footage_kind_is_refused(self) -> None:
        path = self._write({"version": "v", "cases": [{"caseId": "a", "footageKind": "REALISH"}]})
        with self.assertRaises(bc.CorpusError):
            bc.load(path, require_files=False)

    def test_an_unknown_scenario_claim_is_refused(self) -> None:
        """⛔ A claim on a scenario nothing reports would be a silent one."""
        path = self._write(
            {"version": "v", "cases": [{"caseId": "a", "footageKind": "AUTHORED", "scenarios": ["shoplifting"]}]}
        )
        with self.assertRaises(bc.CorpusError):
            bc.load(path, require_files=False)

    def test_a_duplicate_case_id_is_refused(self) -> None:
        path = self._write(
            {
                "version": "v",
                "cases": [
                    {"caseId": "a", "footageKind": "AUTHORED"},
                    {"caseId": "a", "footageKind": "AUTHORED"},
                ],
            }
        )
        with self.assertRaises(bc.CorpusError):
            bc.load(path, require_files=False)

    def test_a_missing_clip_is_refused_rather_than_dropped(self) -> None:
        """⛔ Dropping it would aggregate over the easy subset — the failure `summarise()` guards
        one layer later, arriving earlier and quieter."""
        path = self._write(
            {"version": "v", "cases": [{"caseId": "a", "path": "nope.mp4", "footageKind": "AUTHORED"}]}
        )
        with self.assertRaises(bc.CorpusError):
            bc.load(path, root=tempfile.mkdtemp(), require_files=True)

    def test_an_empty_corpus_is_refused(self) -> None:
        with self.assertRaises(bc.CorpusError):
            bc.load(self._write({"version": "v", "cases": []}), require_files=False)


class DeclaredCorpusTests(unittest.TestCase):
    """The corpus this repository actually ships — asserted, so it cannot drift silently."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = bc.load(CORPUS, root=FIXTURES)
        cls.rows = bc.coverage(cls.corpus)

    def test_every_declared_clip_exists(self) -> None:
        self.assertGreater(len(self.corpus.cases), 0)

    def test_no_case_is_real_footage_today(self) -> None:
        """⛔ The standing fact of 2026-08-10, asserted so its change is a deliberate act.

        ⚠️ When real footage lands, this test fails — and that failure is the signal to re-run the
        benchmark and revisit every conclusion drawn from the authored corpus.
        """
        self.assertNotIn("REAL_FOOTAGE", self.corpus.kinds())

    def test_no_scenario_is_available(self) -> None:
        self.assertEqual(bc.coverage_counts(self.rows)["AVAILABLE"], 0)

    def test_no_case_carries_ground_truth(self) -> None:
        """⛔ So no accuracy metric may be emitted by anything reading this corpus."""
        self.assertFalse(self.corpus.has_any_ground_truth)

    def test_the_coverage_report_says_no_winner_may_be_declared(self) -> None:
        text = bc.render_coverage(self.corpus, self.rows)
        self.assertIn("No scenario is covered by real footage", text)
        self.assertIn("no winner may be declared", text.lower())

    def test_the_coverage_report_names_every_missing_scenario(self) -> None:
        text = bc.render_coverage(self.corpus, self.rows)
        for row in self.rows:
            if row.state == "MISSING":
                self.assertIn(row.scenario, text)


if __name__ == "__main__":
    unittest.main()
