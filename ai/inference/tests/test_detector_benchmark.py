"""Benchmark matrix tests (P-10 Workstream B).

⭐ The framework is tested **without a model, a video or onnxruntime** — `run_cell` is injected. A
benchmark harness that could only be tested by running a benchmark would never be tested.

The properties under test are the ones that decide whether a comparison is honest: that a detector
cannot win by failing, that aggregates cover the same cases, and that a contended host is reported
above the numbers rather than beneath them.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from detector_benchmark import (  # noqa: E402
    BenchmarkMatrix,
    DetectorRun,
    UnevenMatrix,
    model_ref,
    render_summary,
    run_matrix,
    summarise,
)


def _row(model_id, case_id, **over):
    base = dict(
        model_id=model_id,
        case_id=case_id,
        category="person_detection",
        frames=100,
        detections=120,
        tracks_created=4,
        track_reassignments=1,
        events=3,
        inference_ms_avg=40.0,
        inference_ms_p95=55.0,
        wall_seconds=5.0,
        peak_rss_mib=80.0,
    )
    base.update(over)
    return DetectorRun(**base)


class RowTests(unittest.TestCase):
    def test_derived_rates_are_none_rather_than_zero_when_nothing_ran(self):
        """⚠️ 0.0 detections/frame reads as 'found nothing'; None reads as 'did not run'."""
        row = DetectorRun(model_id="m", case_id="c", category="crowd", status="skipped")

        self.assertIsNone(row.detections_per_frame)
        self.assertIsNone(row.fps)

    def test_detections_per_frame_and_fps_are_derived_consistently(self):
        row = _row("m", "c", frames=50, detections=100, wall_seconds=2.0)

        self.assertEqual(row.detections_per_frame, 2.0)
        self.assertEqual(row.fps, 25.0)

    def test_incidents_are_none_at_the_runtime_tier_by_design(self):
        """The runtime emits events and creates no incidents — a standing guarantee, not a gap."""
        self.assertIsNone(_row("m", "c").incidents)

    def test_an_unknown_status_is_refused(self):
        with self.assertRaises(ValueError):
            DetectorRun(model_id="m", case_id="c", category="crowd", status="probably-fine")


class MatrixTests(unittest.TestCase):
    def test_every_model_meets_every_case(self):
        calls = []

        def run_cell(model_id, case_id):
            calls.append((model_id, case_id))
            return _row(model_id, case_id)

        matrix = run_matrix(model_ids=["a", "b"], case_ids=["c1", "c2", "c3"], run_cell=run_cell)

        self.assertEqual(len(matrix.rows), 6)
        self.assertEqual(calls[:3], [("a", "c1"), ("a", "c2"), ("a", "c3")], "model-major order")
        self.assertEqual(matrix.models(), ["a", "b"])
        self.assertEqual(matrix.cases(), ["c1", "c2", "c3"])

    def test_a_runner_returning_the_wrong_cell_is_an_error(self):
        """⛔ A mislabelled row silently attributes one detector's result to another."""
        with self.assertRaises(ValueError):
            run_matrix(model_ids=["a"], case_ids=["c1"], run_cell=lambda m, c: _row("b", c))

    def test_a_failed_case_is_recorded_not_dropped(self):
        matrix = run_matrix(
            model_ids=["a"],
            case_ids=["c1", "c2"],
            run_cell=lambda m, c: _row(m, c) if c == "c1" else _row(m, c, status="error", detail="bad clip"),
        )

        self.assertEqual(len(matrix.rows), 2)
        self.assertEqual([r.status for r in matrix.rows], ["ok", "error"])


class SummaryTests(unittest.TestCase):
    def test_aggregates_cover_only_the_cases_every_detector_completed(self):
        matrix = BenchmarkMatrix(
            rows=[
                _row("fast", "c1"),
                _row("fast", "c2"),
                _row("slow", "c1"),
                _row("slow", "c2", status="timeout"),
            ]
        )

        with self.assertRaises(UnevenMatrix) as caught:
            summarise(matrix)

        self.assertIn("fast", str(caught.exception))
        self.assertIn("c2", str(caught.exception))

    def test_a_detector_cannot_win_by_failing_the_hard_cases(self):
        """⛔ The failure this guard exists for.

        `flaky` crashes on the expensive clip and would otherwise post a better average than the
        detector that completed it — the hard case simply vanishes from its column.
        """
        matrix = BenchmarkMatrix(
            rows=[
                _row("solid", "easy", inference_ms_avg=40.0),
                _row("solid", "hard", inference_ms_avg=400.0),
                _row("flaky", "easy", inference_ms_avg=45.0),
                _row("flaky", "hard", status="error", inference_ms_avg=None),
            ]
        )

        summary = summarise(matrix, require_even=False)

        self.assertEqual(summary["comparableCases"], ["easy"])
        self.assertEqual(summary["perModel"]["solid"]["inferenceMsAvg"], 40.0)
        self.assertEqual(summary["perModel"]["flaky"]["inferenceMsAvg"], 45.0)
        self.assertEqual(summary["perModel"]["solid"]["casesCompared"], 1)

    def test_status_counts_survive_into_the_summary(self):
        matrix = BenchmarkMatrix(rows=[_row("a", "c1"), _row("a", "c2", status="skipped")])

        summary = summarise(matrix, require_even=False)

        self.assertEqual(summary["perModel"]["a"]["statuses"], {"ok": 1, "skipped": 1})

    def test_one_detector_alone_still_summarises(self):
        summary = summarise(BenchmarkMatrix(rows=[_row("only", "c1")]))

        self.assertEqual(summary["perModel"]["only"]["casesCompared"], 1)


class RenderTests(unittest.TestCase):
    def _summary(self, **env):
        matrix = BenchmarkMatrix(
            rows=[_row("a", "c1"), _row("b", "c1")],
            corpus_version="corpus-1",
            environment=env,
            at="2026-08-08T19:00:00Z",
        )
        return summarise(matrix)

    def test_the_table_names_every_detector(self):
        text = render_summary(self._summary(host="laptop"))

        self.assertIn("`a`", text)
        self.assertIn("`b`", text)
        self.assertIn("corpus-1", text)

    def test_a_contended_host_is_declared_above_the_numbers(self):
        """⚠️ A reader who quotes a row must not be able to miss this."""
        text = render_summary(self._summary(hostContended=True))

        self.assertIn("⛔ **The host was contended", text)
        self.assertLess(text.index("host was contended"), text.index("| Detector |"))

    def test_the_absent_measurements_are_stated_every_time(self):
        text = render_summary(self._summary())

        self.assertIn("Precision and recall are absent", text)
        # ⚠️ Corrected at P3.1: the column was described as counting trackingId changes within an
        # identityId. The runtime publishes no such counter and cannot — see `render_summary`.
        self.assertIn("structurally zero", text)
        self.assertIn("Incidents are absent by architecture", text)

    def test_failed_cases_get_their_own_section(self):
        matrix = BenchmarkMatrix(rows=[_row("a", "c1"), _row("a", "c2", status="error")])
        text = render_summary(summarise(matrix, require_even=False))

        self.assertIn("Cases that did not complete", text)
        self.assertIn("1 error", text)


class ModelRefTests(unittest.TestCase):
    def test_the_ref_selects_a_named_catalogue_entry_without_touching_the_runtime(self):
        """⭐ The entire model-selection mechanism: `load()` already took a resolved entry."""

        class _Entry:
            id = "rtdetr-r18vd"
            artifact = "rtdetr-r18vd-1.0.0.onnx"
            output_format = "rtdetr"
            output_params = {"numClasses": 80}
            input = object()

        ref = model_ref(_Entry(), "/opt/vip/models", ["person"])

        self.assertEqual(ref["modelId"], "rtdetr-r18vd")
        self.assertEqual(ref["outputFormat"], "rtdetr")
        self.assertEqual(ref["onnx_path"], "/opt/vip/models/rtdetr-r18vd-1.0.0.onnx")
        self.assertEqual(ref["outputParams"], {"numClasses": 80})
        self.assertEqual(ref["labels"], ["person"])

    def test_adding_a_detector_needs_no_change_to_this_module(self):
        """The regression guard for requirement 5: a future family is a catalogue entry."""

        class _Future:
            id = "florence-2"
            artifact = "florence-2.onnx"
            output_format = "florence"
            output_params = {}
            input = object()

        self.assertEqual(model_ref(_Future(), "/m", ["person"])["outputFormat"], "florence")


class _RecordingAdapter:
    execution_provider = "stub"

    def __init__(self) -> None:
        self.loads = []
        self.unloaded = 0

    def load(self, ref):  # noqa: ANN001
        self.loads.append(ref)

    def preprocess(self, ctx):  # noqa: ANN001
        return ("pre", ctx)

    def infer(self, prepared):  # noqa: ANN001
        return ("inf", prepared)

    def unload(self):
        self.unloaded += 1


class PinnedAdapterTests(unittest.TestCase):
    """⛔ The wrapper that keeps the benchmark out of the runtime."""

    def setUp(self):
        from detector_benchmark import PinnedModelAdapter

        self.inner = _RecordingAdapter()
        self.pinned = PinnedModelAdapter(self.inner, {"modelId": "rtdetr-r18vd", "onnx_path": "/m/rt.onnx"})

    def test_the_analyzers_bare_load_still_loads_the_pinned_model(self):
        """`VideoAnalyzer` calls `load({"labels": [...]})`; the pin must survive it."""
        self.pinned.load({"labels": ["person"]})

        self.assertEqual(len(self.inner.loads), 1)
        self.assertEqual(self.inner.loads[0]["modelId"], "rtdetr-r18vd")
        self.assertEqual(self.inner.loads[0]["onnx_path"], "/m/rt.onnx")
        self.assertEqual(self.inner.loads[0]["labels"], ["person"])

    def test_a_second_load_does_not_rebuild_the_session_mid_run(self):
        """⚠️ A reload would put a model-load cost inside a measured frame."""
        self.pinned.load({"labels": ["person"]})
        self.pinned.load({"labels": ["person", "car"]})

        self.assertEqual(len(self.inner.loads), 1)

    def test_it_is_transparent_for_every_other_verb(self):
        self.assertEqual(self.pinned.preprocess("ctx"), ("pre", "ctx"))
        self.assertEqual(self.pinned.infer("prep"), ("inf", "prep"))
        self.assertEqual(self.pinned.execution_provider, "stub")
        self.pinned.unload()
        self.assertEqual(self.inner.unloaded, 1)

    def test_unloading_permits_a_deliberate_reload(self):
        self.pinned.load({"labels": ["person"]})
        self.pinned.unload()
        self.pinned.load({"labels": ["person"]})

        self.assertEqual(len(self.inner.loads), 2)


if __name__ == "__main__":
    unittest.main()
