"""AI-5e accuracy-evaluation tests.

The evaluator's job is to be honest in both directions and about its own limits. So the tests here
concentrate on: a false positive costs precision exactly as a miss costs recall; a behaviour spanning
400 frames is one occurrence; an expectation the AI runtime cannot produce is deferred rather than
scored; and `footage-missing` never, ever passes.

The pipeline itself is exercised end-to-end through the real `VideoAnalyzer` over stub frames, so
`evaluate()` is proved against the actual output shape rather than against a fixture of it.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dataset import DatasetCase, Expectation, FootageReference  # noqa: E402
from evaluation import (  # noqa: E402
    EvaluationReport,
    Finding,
    Occurrence,
    evaluate,
    judge,
    matches,
    occurrences,
    render_summary,
    run_case,
    skipped_report,
    summarize,
)
from playground import build_adapter  # noqa: E402
from video_analyzer import AnalyzeOptions, VideoAnalyzer  # noqa: E402
from video_decoder import StubFrameDecoder  # noqa: E402

AT = lambda: "2026-08-01T00:00:00.000Z"  # noqa: E731


def _case(*expectations, category="loitering", case_id="loitering/c1", **kw) -> DatasetCase:
    return DatasetCase(
        id=case_id,
        category=category,
        title="test",
        footage=FootageReference(path="nope/missing.mp4", origin="synthetic", licence="n/a", **kw),
        expectations=list(expectations),
    )


class _FrameStub:
    def __init__(self, index, seconds, **kw):
        self.frame = {"frameIndex": index, "timestamp": f"{seconds}s"}
        self.detections = kw.get("detections", [])
        self.tracks = kw.get("tracks", [])
        self.behaviors = kw.get("behaviors", [])
        self.composites = kw.get("composites", [])
        self.events = kw.get("events", [])


class _ResultStub:
    def __init__(self, frames, summary=None):
        self.frames = frames
        self.summary = summary or {"framesSampled": len(frames)}


class OccurrenceTest(unittest.TestCase):
    def test_a_behavior_spanning_many_frames_is_one_occurrence(self):
        """A 19-second loiter emits a BehaviorResult on every frame it is active. Counting those as
        190 loiterings would make every temporal expectation meaningless."""
        frames = [
            _FrameStub(i, i / 5.0, behaviors=[{"behaviorId": "bh_1", "behaviorType": "loitering"}])
            for i in range(95)
        ]
        found = [o for o in occurrences(_ResultStub(frames)) if o.kind == "behavior"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].seconds, 0.0)

    def test_two_distinct_behaviors_are_two_occurrences(self):
        frames = [
            _FrameStub(0, 0.0, behaviors=[{"behaviorId": "bh_1", "behaviorType": "loitering"}]),
            _FrameStub(5, 1.0, behaviors=[{"behaviorId": "bh_2", "behaviorType": "loitering"}]),
        ]
        self.assertEqual(len([o for o in occurrences(_ResultStub(frames)) if o.kind == "behavior"]), 2)

    def test_detections_are_counted_per_frame_but_tracks_are_not(self):
        frames = [
            _FrameStub(i, i / 5.0, detections=[{"label": "person"}], tracks=[{"trackId": "tr_1"}])
            for i in range(10)
        ]
        found = occurrences(_ResultStub(frames))
        self.assertEqual(len([o for o in found if o.kind == "detection"]), 10)
        self.assertEqual(len([o for o in found if o.kind == "track"]), 1)

    def test_seconds_fall_back_to_index_over_fps_when_no_timestamp(self):
        frame = _FrameStub(20, 0.0)
        frame.frame = {"frameIndex": 20}
        found = occurrences(_ResultStub([_FrameStub(20, 4.0)]), effective_fps=5.0)
        self.assertEqual(found, [])  # no output on that frame — nothing to time
        frame.detections = [{"label": "person"}]
        found = occurrences(_ResultStub([frame]), effective_fps=5.0)
        self.assertEqual(found[0].seconds, 4.0)


class MatchingTest(unittest.TestCase):
    def setUp(self):
        self.found = [
            Occurrence("behavior", "loitering", 12.0, 0.9, "zone_a"),
            Occurrence("behavior", "loitering", 45.0, 0.4, "zone_b"),
            Occurrence("event", "security.intrusion.detected", 12.0, None, None),
        ]

    def test_the_window_filters(self):
        e = Expectation(kind="behavior", type="loitering", from_seconds=0, to_seconds=20)
        self.assertEqual(len(matches(e, self.found)), 1)

    def test_the_zone_filters(self):
        e = Expectation(kind="behavior", type="loitering", zone_id="zone_b")
        self.assertEqual(len(matches(e, self.found)), 1)

    def test_the_confidence_floor_filters(self):
        e = Expectation(kind="behavior", type="loitering", min_confidence=0.8)
        self.assertEqual(len(matches(e, self.found)), 1)

    def test_the_kind_must_match_not_just_the_type(self):
        e = Expectation(kind="event", type="loitering")
        self.assertEqual(matches(e, self.found), [])


class JudgingTest(unittest.TestCase):
    def test_a_missing_positive_is_a_false_negative(self):
        findings = judge(_case(Expectation(kind="behavior", type="loitering", count=1)), [])
        self.assertEqual(findings[0].outcome, "missing")

    def test_an_unexpected_negative_is_a_false_positive(self):
        found = [Occurrence("event", "behavior.theft.suspected", 3.0, None, None)]
        findings = judge(
            _case(Expectation(kind="event", type="behavior.theft.suspected", absent=True)), found
        )
        self.assertEqual(findings[0].outcome, "unexpected")
        self.assertEqual(findings[0].observed_count, 1)

    def test_a_count_outside_tolerance_is_distinguished_from_a_miss(self):
        # "produced three when we wanted one" is a different bug from "produced nothing", and a
        # suite that reports both as a failure teaches nobody anything.
        found = [Occurrence("behavior", "loitering", float(i), None, None) for i in range(3)]
        findings = judge(_case(Expectation(kind="behavior", type="loitering", count=1)), found)
        self.assertEqual(findings[0].outcome, "out-of-tolerance")
        self.assertIn("produced 3", findings[0].detail)

    def test_an_incident_expectation_is_deferred_not_scored(self):
        """The corpus describes what the WHOLE PLATFORM should make of a clip, including the incident
        a rule would raise. Scoring the AI runtime against an output it does not own would be
        meaningless in both directions."""
        findings = judge(_case(Expectation(kind="incident", type="retail.theft")), [])
        self.assertEqual(findings[0].outcome, "deferred")
        self.assertIn("rules service", findings[0].detail)

    def test_a_deferred_finding_affects_neither_precision_nor_recall(self):
        report = evaluate(
            _case(Expectation(kind="incident", type="retail.theft")), _ResultStub([]), now_iso=AT
        )
        self.assertEqual(report.true_positives, 0)
        self.assertEqual(report.false_negatives, 0)
        self.assertEqual(report.false_positives, 0)
        self.assertEqual(report.status, "pass")
        self.assertIn("deferred", report.notes)


class ScoringTest(unittest.TestCase):
    def _report(self, *expectations, found_frames=()):
        return evaluate(_case(*expectations), _ResultStub(list(found_frames)), now_iso=AT)

    def test_a_clean_case_passes_with_full_recall(self):
        frames = [_FrameStub(0, 0.0, behaviors=[{"behaviorId": "b", "behaviorType": "loitering"}])]
        report = self._report(
            Expectation(kind="behavior", type="loitering", count=1), found_frames=frames
        )
        self.assertEqual(report.status, "pass")
        self.assertEqual(report.recall, 1.0)
        self.assertEqual(report.precision, 1.0)

    def test_a_false_positive_lowers_precision_not_recall(self):
        frames = [_FrameStub(0, 0.0, events=[{"type": "behavior.theft.suspected"}])]
        report = self._report(
            Expectation(kind="behavior", type="loitering", count=1),
            Expectation(kind="event", type="behavior.theft.suspected", absent=True),
            found_frames=frames,
        )
        self.assertEqual(report.false_positives, 1)
        self.assertEqual(report.false_negatives, 1)
        self.assertEqual(report.status, "fail")

    def test_accuracy_is_null_rather_than_zero_when_nothing_was_expected(self):
        report = self._report()
        self.assertIsNone(report.precision)
        self.assertIsNone(report.recall)
        self.assertIsNone(report.f1)

    def test_a_skipped_report_is_never_a_pass(self):
        report = skipped_report(_case(), now_iso=AT)
        self.assertEqual(report.status, "footage-missing")
        self.assertNotEqual(report.status, "pass")
        self.assertIsNone(report.precision)

    def test_run_case_skips_absent_footage_without_touching_opencv(self):
        report = run_case(_case())
        self.assertEqual(report.status, "footage-missing")


class SummaryTest(unittest.TestCase):
    def _r(self, case_id, status, tp=0, fn=0, fp=0, category="loitering"):
        report = EvaluationReport(
            id=f"eval_{case_id}", case_id=case_id, category=category, status=status, recorded_at=AT()
        )
        report.findings = (
            [Finding(kind="behavior", type="x", outcome="match", expected_count=1)] * tp
            + [Finding(kind="behavior", type="x", outcome="missing", expected_count=1)] * fn
            + [Finding(kind="event", type="y", outcome="unexpected", expected_count=0)] * fp
        )
        return report

    def test_a_run_of_only_skips_is_not_accepted(self):
        """The most important property of the whole gate. A machine with no footage must not produce
        a green summary — that is the exact false assurance the corpus exists to prevent."""
        summary = summarize([self._r("a", "footage-missing"), self._r("b", "footage-missing")], now_iso=AT)
        self.assertEqual(summary["skipped"], 2)
        self.assertEqual(summary["passed"], 0)
        self.assertFalse(summary["accepted"])

    def test_a_clean_run_is_accepted(self):
        summary = summarize([self._r("a", "pass", tp=2)], now_iso=AT)
        self.assertTrue(summary["accepted"])
        self.assertEqual(summary["precision"], 1.0)

    def test_a_failure_is_not_accepted(self):
        summary = summarize([self._r("a", "pass", tp=1), self._r("b", "fail", tp=1, fn=1)], now_iso=AT)
        self.assertFalse(summary["accepted"])
        self.assertEqual(summary["failed"], 1)

    def test_a_regression_against_the_baseline_blocks_acceptance(self):
        # F1 falls from 1.0 to 0.667. Nothing errored and no case "failed" in isolation — the run is
        # only worse relative to what was accepted before, which is exactly what a baseline is for.
        baseline = [self._r("a", "pass", tp=2)]
        current = [self._r("a", "pass", tp=1, fn=1)]
        summary = summarize(current, baseline=baseline, now_iso=AT)
        self.assertEqual(summary["regressed"], ["a"])
        self.assertFalse(summary["accepted"])

    def test_an_improvement_is_reported(self):
        baseline = [self._r("a", "pass", tp=1, fn=1)]
        current = [self._r("a", "pass", tp=2)]
        summary = summarize(current, baseline=baseline, now_iso=AT)
        self.assertEqual(summary["improved"], ["a"])
        self.assertEqual(summary["regressed"], [])

    def test_a_case_the_baseline_skipped_is_not_a_regression(self):
        baseline = [self._r("a", "footage-missing")]
        current = [self._r("a", "fail", fn=1)]
        summary = summarize(current, baseline=baseline, now_iso=AT)
        self.assertEqual(summary["regressed"], [])

    def test_per_category_rollup(self):
        summary = summarize(
            [self._r("a", "pass", tp=1), self._r("b", "fail", fn=1, category="queue")], now_iso=AT
        )
        self.assertEqual(summary["byCategory"]["loitering"]["passed"], 1)
        self.assertEqual(summary["byCategory"]["queue"]["failed"], 1)

    def test_the_rendered_summary_names_the_skips(self):
        text = render_summary(summarize([self._r("a", "footage-missing")], now_iso=AT))
        self.assertIn("NOT", text)
        self.assertIn("accepted   : NO", text)


class RealPipelineTest(unittest.TestCase):
    """`evaluate()` against the actual analyzer output, not a fixture of it."""

    def _analyze(self, frames=12):
        analyzer = VideoAnalyzer(
            build_adapter("stub"),
            AnalyzeOptions(tenant_id="tnt_eval", camera_id="cam_1", session_id="sess_eval"),
        )
        return analyzer.analyze(StubFrameDecoder.synthetic(frames))

    def test_person_detections_are_found_in_the_real_output_shape(self):
        result = self._analyze()
        report = evaluate(
            _case(Expectation(kind="detection", type="person", count=1, count_tolerance=1000)),
            result,
            now_iso=AT,
        )
        self.assertEqual(report.status, "pass")
        self.assertGreater(report.findings[0].observed_count, 0)

    def test_an_expectation_the_pipeline_cannot_meet_is_a_clean_miss(self):
        result = self._analyze()
        report = evaluate(
            _case(Expectation(kind="behavior", type="volcano_eruption", count=1)), result, now_iso=AT
        )
        self.assertEqual(report.status, "fail")
        self.assertEqual(report.findings[0].outcome, "missing")
        self.assertEqual(report.recall, 0.0)

    def test_the_report_records_the_model_and_engine_it_ran_under(self):
        # An accuracy claim with no model attached is not a claim about anything.
        report = evaluate(_case(), self._analyze(), now_iso=AT).to_dict()
        self.assertTrue(report.get("engine"))
        self.assertTrue(report.get("model"))


if __name__ == "__main__":
    unittest.main()
