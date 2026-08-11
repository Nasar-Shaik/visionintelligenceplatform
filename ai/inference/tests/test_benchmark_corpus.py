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


REAL = {
    "footage_kind": "REAL_FOOTAGE",
    "sha256": "a" * 64,
    "capture": {"device": "phone", "capturedAt": "2026-08-11"},
    "consent": "docs/validation/consent/2026-08-11-colleagues.md",
}


def case(**kw) -> bc.BenchmarkCase:
    """A valid case of whatever kind is asked for.

    ⚠️ `REAL_FOOTAGE` carries the provenance its kind requires unless a test overrides it, so the
    coverage tests stay about coverage. The tests that probe the provenance rules themselves pass
    the fields explicitly — see `ClassificationGuardTests`.
    """
    base = {
        "case_id": "c1",
        "path": "x.mp4",
        "category": "motion",
        "footage_kind": "AUTHORED",
        "scenarios": ("normal-person",),
    }
    base.update(kw)
    # ⚠️ Fill provenance only when the caller mentioned *none* of it. A helper that topped up a
    # missing field would silently satisfy the very rule the guard tests are asserting.
    if base["footage_kind"] == "REAL_FOOTAGE" and not {"sha256", "capture", "consent"} & set(kw):
        base.update(REAL)
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


class ClassificationGuardTests(unittest.TestCase):
    """⛔ **P3.1 stopped authored material being promoted. This stops the opposite mistake**, which is
    now the live one: real footage misfiled as `AUTHORED` is a genuine measurement discarded as a
    rendered rectangle, and a recording of identifiable people held with no consent record.
    """

    def test_real_footage_without_a_checksum_is_refused(self) -> None:
        with self.assertRaises(bc.CorpusError):
            case(footage_kind="REAL_FOOTAGE", capture=REAL["capture"], consent=REAL["consent"])

    def test_real_footage_without_a_lawful_basis_is_refused(self) -> None:
        """⛔ Video of identifiable people is not admitted on a label alone."""
        with self.assertRaises(bc.CorpusError):
            case(footage_kind="REAL_FOOTAGE", sha256=REAL["sha256"], capture=REAL["capture"])

    def test_real_footage_without_capture_metadata_is_refused(self) -> None:
        with self.assertRaises(bc.CorpusError):
            case(footage_kind="REAL_FOOTAGE", sha256=REAL["sha256"], consent=REAL["consent"])

    def test_a_placeholder_checksum_is_refused(self) -> None:
        """⚠️ 64 hex characters — the assertion a path or a `TODO` cannot satisfy."""
        with self.assertRaises(bc.CorpusError):
            case(**{**REAL, "sha256": "sha256-of-the-clip"})

    def test_a_complete_real_case_is_accepted(self) -> None:
        """⚠️ The positive control. A guard that refused everything would be equally useless."""
        self.assertTrue(case(**REAL).conclusive)

    def test_authored_material_may_not_carry_a_consent_record(self) -> None:
        """⛔ **The reverse direction.** A rendered rectangle has nobody who could consent, so these
        fields appearing on an authored case means the kind is wrong — most likely real footage that
        was relabelled, which would silently demote it to PARTIAL."""
        with self.assertRaises(bc.CorpusError):
            case(footage_kind="AUTHORED", consent=REAL["consent"])

    def test_authored_material_may_not_carry_capture_metadata(self) -> None:
        with self.assertRaises(bc.CorpusError):
            case(footage_kind="AUTHORED", capture=REAL["capture"])

    def test_the_error_names_the_likely_mistake(self) -> None:
        """⭐ The message has to say *what to do*: whoever hits this is mid-relabel."""
        with self.assertRaises(bc.CorpusError) as caught:
            case(footage_kind="AUTHORED", sha256=REAL["sha256"])
        self.assertIn("REAL_FOOTAGE", str(caught.exception))

    def test_the_two_kinds_resolve_under_different_roots(self) -> None:
        """⭐ Why the guard is structural: a real clip relabelled `AUTHORED` is looked for among the
        committed fixtures, where recordings of real people are never kept."""
        self.assertEqual(bc.root_for(case(**REAL), "/fixtures", "/real"), "/real")
        self.assertEqual(bc.root_for(case(), "/fixtures", "/real"), "/fixtures")

    def test_real_footage_is_never_sought_inside_the_repository(self) -> None:
        self.assertNotIn(bc.DEFAULT_REAL_ROOT, ("infra/docker/fixtures/media", "ai/inference/benchmarks"))
        self.assertTrue(bc.DEFAULT_REAL_ROOT.startswith("."))


class ChecksumBindingTests(unittest.TestCase):
    """⛔ The digest binds the manifest to the bytes; without it a swapped clip re-measures silently."""

    def setUp(self) -> None:
        self.corpus = bc.Corpus(version="v", cases=(case(path="c.mp4", **REAL),))

    def test_a_missing_clip_is_reported_with_where_it_was_sought(self) -> None:
        findings = bc.verify_real_footage(self.corpus, "/nonexistent")
        self.assertEqual(len(findings), 1)
        self.assertIn("absent", findings[0][1])

    def test_a_clip_whose_bytes_changed_is_reported_not_re_declared(self) -> None:
        directory = tempfile.mkdtemp()
        with open(os.path.join(directory, "c.mp4"), "wb") as handle:
            handle.write(b"different pixels")
        findings = bc.verify_real_footage(self.corpus, directory)
        self.assertEqual(len(findings), 1)
        self.assertIn("found sha256:", findings[0][1])

    def test_matching_bytes_produce_no_finding(self) -> None:
        """⚠️ The positive control — proving the check can pass, not only fail."""
        directory = tempfile.mkdtemp()
        with open(os.path.join(directory, "c.mp4"), "wb") as handle:
            handle.write(b"the declared pixels")
        findings = bc.verify_real_footage(self.corpus, directory, hasher=lambda p: "a" * 64)
        self.assertEqual(findings, [])

    def test_every_bad_clip_is_reported_in_one_pass(self) -> None:
        """⚠️ Stopping at the first would hide the rest behind one fix-and-rerun cycle each."""
        corpus = bc.Corpus(
            version="v",
            cases=tuple(case(case_id=f"c{i}", path=f"c{i}.mp4", **REAL) for i in range(3)),
        )
        self.assertEqual(len(bc.verify_real_footage(corpus, "/nonexistent")), 3)


class RequiredScenarioTests(unittest.TestCase):
    def test_every_capability_the_architect_required_is_reportable(self) -> None:
        """⛔ A scenario absent from `SCENARIOS` is not reported at all, so a gap in it reads as
        covered. These are the 2026-08-11 required initial controlled footage capabilities."""
        required = (
            "front-facing-person", "side-facing-person", "rear-facing-person",
            "normal-person", "person-standing", "person-sitting", "person-bending",
            "hands-raised", "person-entering-frame", "person-leaving-frame",
            "partially-occluded-person", "backpack", "bottle", "cup",
            "object-pickup", "object-putdown", "person-carrying-object",
            "two-person-interaction", "handover", "approach-recede",
            "zone-crossing", "line-crossing",
        )
        missing = [s for s in required if s not in bc.SCENARIOS]
        self.assertEqual(missing, [], f"unreportable required scenarios: {missing}")

    def test_no_scenario_is_declared_twice(self) -> None:
        self.assertEqual(len(bc.SCENARIOS), len(set(bc.SCENARIOS)))


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

    def test_no_real_footage_case_carries_ground_truth(self) -> None:
        """⛔ **The standing fact, narrowed on 2026-08-11 and deliberately.**

        This asserted that *nothing* carried ground truth. One authored case now does —
        `walk-tracking`, whose boxes are derived from the ffmpeg expression that drew the sprite —
        so the scoring path is exercised on every run instead of never.

        ⚠️ The claim that matters is unchanged and is now stated precisely: **no real footage has
        ground truth**, so no accuracy number about real people can be produced. Widening the old
        assertion would have been the easy edit; narrowing it keeps the tripwire pointed at the thing
        that actually needs guarding.
        """
        scored_real = [
            c for c in self.corpus.cases if c.footage_kind == "REAL_FOOTAGE" and c.has_ground_truth
        ]
        self.assertEqual(scored_real, [])

    def test_the_only_ground_truth_is_authored_and_says_so(self) -> None:
        """⚠️ A reader must not mistake the accuracy table for evidence about people."""
        scored = [c for c in self.corpus.cases if c.has_ground_truth]
        self.assertEqual([c.case_id for c in scored], ["walk-tracking"])
        self.assertEqual(scored[0].footage_kind, "AUTHORED")

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
