"""The benchmark runner's reproducibility surface — P3.1.

⚠️ These test the parts that decide whether a result can be *trusted later*: what environment
produced it, which artifact actually ran, and whether the report can be quoted out of context. The
matrix logic itself is `test_detector_benchmark.py` and is unchanged by this milestone.
"""

import hashlib
import json
import os
import re
import sys
import time
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import benchmark_corpus as bc  # noqa: E402
import detector_benchmark as db  # noqa: E402
import detector_benchmark_cli as cli  # noqa: E402


class _Spec:
    width = 416
    height = 416
    resize = "letterbox"
    color_order = "BGR"


class _Model:
    id = "yolox-nano"
    version = "1.0.0"
    family = "yolox"
    artifact = "yolox-nano-1.0.0.onnx"
    size_bytes = 3659407
    license = "Apache-2.0"
    license_holder = "Megvii, Inc. (YOLOX)"
    source = "https://example.invalid/yolox_nano.onnx"
    trained_on = "COCO 2017"
    status = "enabled"
    output_format = "yolox"
    input = _Spec()


class _Store:
    """⛔ Mimics the REAL `ModelStore.verify` contract: it returns the artifact **path** and raises
    on a checksum mismatch.

    The first version of this stub returned a digest, because that is what I assumed `verify` did.
    Every provenance test passed against the assumption, and the first published report carried
    `/opt/vip/mod…` in its sha256 column. ⚠️ A stub that is more convenient than the thing it stands
    for tests the stub.
    """

    def __init__(self, contents=b"benchmark artifact bytes", broken=False):
        self._broken = broken
        handle, self.path = tempfile.mkstemp(suffix=".onnx")
        with os.fdopen(handle, "wb") as fh:
            fh.write(contents)

    def verify(self, model):  # noqa: ANN001
        if self._broken:
            raise ValueError("artifact does not match its registered checksum")
        return self.path

    @property
    def expected(self) -> str:
        with open(self.path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()


class EnvironmentTests(unittest.TestCase):
    def test_the_environment_names_what_produced_the_numbers(self) -> None:
        env = cli.environment()
        for key in ("python", "platform", "cpuCount", "onnxruntime", "warmupFrames", "hostContended"):
            self.assertIn(key, env)

    def test_the_warmup_is_declared_rather_than_implied(self) -> None:
        """⚠️ A warm-up nobody declared is indistinguishable from a faster detector."""
        self.assertEqual(cli.environment()["warmupFrames"], cli.WARMUP_FRAMES)
        self.assertGreater(cli.WARMUP_FRAMES, 0)

    def test_the_caller_can_supply_the_commit_the_image_cannot_read(self) -> None:
        """⚠️ Inside the built image `git rev-parse` has no work tree, so the first report recorded
        `gitSha unknown` — the one field that says which source produced the numbers."""
        self.assertEqual(cli.environment(git_sha="abc1234")["gitSha"], "abc1234")

    def test_host_contention_defaults_to_false_and_is_an_input(self) -> None:
        """⚠️ Only the operator knows whether something else was running; this is not detected."""
        self.assertFalse(cli.environment()["hostContended"])
        self.assertTrue(cli.environment(contended=True)["hostContended"])


class ProvenanceTests(unittest.TestCase):
    """⛔ A benchmark that names a model without naming the artifact it ran is not reproducible."""

    def test_the_checksum_is_verified_rather_than_transcribed(self) -> None:
        """⭐ The digest comes from re-hashing the file on disk, not from the catalogue's claim —
        so the column says *the bytes we ran*, and an artifact swap cannot pass unnoticed."""
        store = _Store()
        row = cli.provenance([_Model()], store)[0]
        self.assertEqual(row["sha256"], store.expected)

    def test_the_checksum_column_is_a_digest_and_not_a_path(self) -> None:
        """⛔ **The regression test for the defect that reached the first report.**

        `ModelStore.verify` returns the artifact path; publishing its return value put
        `/opt/vip/models/yolox-nano-1.0.0.onnx` in the sha256 column of a run that had genuinely
        passed its integrity check. ⚠️ This one assertion — 64 hex characters — is unsatisfiable by
        any filesystem path, and would have failed on the first run.
        """
        row = cli.provenance([_Model()], _Store())[0]
        self.assertRegex(row["sha256"], r"^[0-9a-f]{64}$")
        self.assertNotIn("/", row["sha256"])

    def test_a_failed_verification_is_reported_not_swallowed(self) -> None:
        """⛔ Never `None` and never the registered value: a benchmark run against an artifact that
        failed its checksum must say so in the artifact it publishes."""
        row = cli.provenance([_Model()], _Store(broken=True))[0]
        self.assertIn("UNVERIFIED", row["sha256"])

    def test_licence_and_source_travel_with_every_result(self) -> None:
        row = cli.provenance([_Model()], _Store())[0]
        self.assertEqual(row["license"], "Apache-2.0")
        self.assertEqual(row["source"], "https://example.invalid/yolox_nano.onnx")
        self.assertEqual(row["input"]["width"], 416)


class ReportTests(unittest.TestCase):
    """⛔ The report must be unquotable as a detector verdict while the corpus cannot support one."""

    def setUp(self) -> None:
        self.corpus = bc.Corpus(
            version="test-corpus",
            cases=(
                bc.BenchmarkCase(
                    case_id="c1", path="c1.mp4", category="motion",
                    footage_kind="AUTHORED", scenarios=("normal-person",),
                ),
            ),
        )
        self.rows = bc.coverage(self.corpus)
        matrix = db.BenchmarkMatrix(
            rows=[db.DetectorRun(model_id="yolox-nano", case_id="c1", category="motion", frames=60, detections=30)],
            corpus_version="test-corpus",
            environment=cli.environment(),
            at="2026-08-10T00:00:00Z",
        )
        self.summary = db.summarise(matrix)

    def _report(self, store=None) -> str:  # noqa: ANN001
        store = store or _Store()
        return cli.render_report(self.summary, self.corpus, self.rows, cli.provenance([_Model()], store))

    def test_the_report_refuses_to_name_a_winner(self) -> None:
        self.assertIn("DOES NOT NAME A WINNER", self._report())

    def test_the_report_says_its_metrics_are_observational(self) -> None:
        """⛔ With no ground truth, a detection count is not an accuracy — and the report has to say
        so where a reader cannot miss it, not in a footnote."""
        report = self._report()
        self.assertIn("OBSERVATIONAL", report)
        self.assertIn("precision", report.lower())

    def test_the_report_states_how_many_scenarios_are_really_covered(self) -> None:
        """⚠️ Derived from `SCENARIOS`, not a literal: the count grew 31 → 41 when the required
        capabilities were extended, and a hardcoded total fails for the wrong reason each time."""
        self.assertIn(
            f"0 of {len(bc.SCENARIOS)} required scenarios are covered by real footage", self._report()
        )

    def test_the_report_carries_the_verified_checksum(self) -> None:
        """⚠️ Asserted against the digest of the bytes the stub actually holds — not a literal, which
        is how the path-instead-of-digest defect survived a passing test."""
        store = _Store()
        self.assertIn(store.expected[:12], self._report(store))

    def test_the_provenance_clause_is_computed_from_the_corpus(self) -> None:
        """⛔ **The regression test for a banner that described a corpus it had not read.**

        The clause "every case in this corpus is authored or photographic" was hardcoded beside a
        coverage count that was computed, so the first real-footage run printed the two contradicting
        each other in a single sentence.
        """
        real = bc.Corpus(
            version="real",
            cases=(
                bc.BenchmarkCase(
                    case_id="r1", path="r1.mp4", category="real", footage_kind="REAL_FOOTAGE",
                    scenarios=("normal-person",), sha256="a" * 64, consent="c.md",
                    capture={"device": "phone"},
                ),
            ),
        )
        rows = bc.coverage(real)
        matrix = db.BenchmarkMatrix(
            rows=[db.DetectorRun(model_id="m", case_id="r1", category="real", frames=30)],
            corpus_version="real", environment={}, at="2026-08-11T00:00:00Z",
        )
        text = cli.render_report(db.summarise(matrix), real, rows, cli.provenance([_Model()], _Store()))
        self.assertNotIn("Every case in this corpus is authored", text)
        self.assertIn("1 of 1 case(s) are real footage", text)
        self.assertIn("DOES NOT NAME A WINNER", text)

    def test_an_authored_corpus_still_says_so(self) -> None:
        """⚠️ The other branch — the clause has to be right in both directions, not merely absent."""
        self.assertIn("Every case in this corpus is authored", self._report())

    def test_the_report_carries_the_licence(self) -> None:
        """⚠️ Licensing is a selection criterion here, so it belongs beside the numbers."""
        self.assertIn("Apache-2.0", self._report())


class LatencyInstrumentTests(unittest.TestCase):
    """⛔ **The latency column was empty for all 34 cells of the first matrix** — the runner asked
    `FrameAnalysis` for a `.timings` attribute it has never had, and `getattr(..., None)` turned a
    wrong attribute name into "no samples" rather than an error. These tests assert the instrument
    can *move*, which is the only thing that separates a working meter from a broken one.
    """

    class _Inner:
        def __init__(self) -> None:
            self.calls = 0

        def load(self, ref=None) -> None:  # noqa: ANN001
            pass

        def preprocess(self, ctx):  # noqa: ANN001
            return ctx

        def infer(self, prepared):  # noqa: ANN001
            self.calls += 1
            time.sleep(0.002)  # a measurable floor, so "0.0 ms" cannot pass as a reading
            return {"prepared": prepared}

        def unload(self) -> None:
            pass

    def test_every_inference_leaves_exactly_one_sample(self) -> None:
        adapter = cli.TimedAdapter(self._Inner())
        for _ in range(5):
            adapter.infer(object())
        self.assertEqual(len(adapter.samples), 5)

    def test_the_samples_are_non_zero_durations(self) -> None:
        """⭐ Proves the meter reads something. An instrument that always reports 0.0 is
        indistinguishable from one that is not wired in."""
        adapter = cli.TimedAdapter(self._Inner())
        adapter.infer(object())
        self.assertGreater(adapter.samples[0], 1.0)

    def test_a_failed_inference_is_still_timed(self) -> None:
        """⚠️ Otherwise a detector that throws looks *free* rather than broken."""

        class Exploding(LatencyInstrumentTests._Inner):
            def infer(self, prepared):  # noqa: ANN001
                raise RuntimeError("boom")

        adapter = cli.TimedAdapter(Exploding())
        with self.assertRaises(RuntimeError):
            adapter.infer(object())
        self.assertEqual(len(adapter.samples), 1)

    def test_the_adapter_passes_inference_through_untouched(self) -> None:
        inner = self._Inner()
        adapter = cli.TimedAdapter(inner)
        token = object()
        self.assertEqual(adapter.infer(token)["prepared"], token)
        self.assertEqual(inner.calls, 1)

    def test_a_percentile_needs_a_population_to_be_one(self) -> None:
        """⛔ A p95 over five frames is the maximum wearing a percentile's name."""
        self.assertIsNone(cli._percentile([1.0] * 19, 0.95))
        self.assertIsNotNone(cli._percentile([1.0] * 20, 0.95))

    def test_the_percentile_selects_the_high_tail(self) -> None:
        values = [float(n) for n in range(1, 101)]
        self.assertEqual(cli._percentile(values, 0.95), 95.0)


class UnmeasuredColumnTests(unittest.TestCase):
    def test_reassignments_are_declared_unmeasured_not_reported_as_zero(self) -> None:
        """⛔ The runtime emits no reassignment counter and cannot: a trackId is never reused. The
        column is structurally 0, so the report must forbid reading it as "no ID switches occurred".
        """
        matrix = db.BenchmarkMatrix(
            rows=[db.DetectorRun(model_id="m", case_id="c1", category="motion", frames=60)],
            corpus_version="v", environment={}, at="2026-08-10T00:00:00Z",
        )
        text = db.render_summary(db.summarise(matrix))
        self.assertIn("structurally zero", text)
        self.assertIn("not measured", text)


class AccuracySectionTests(unittest.TestCase):
    """⛔ The accuracy section must be **absent** without annotations and **honest** with them."""

    def _corpus(self):
        return bc.Corpus(
            version="v",
            cases=(bc.BenchmarkCase(case_id="c1", path="c1.mp4", category="motion",
                                    footage_kind="AUTHORED", scenarios=("normal-person",)),),
        )

    def _report(self, scores):
        corpus = self._corpus()
        matrix = db.BenchmarkMatrix(
            rows=[db.DetectorRun(model_id="m", case_id="c1", category="motion", frames=10)],
            corpus_version="v", environment={}, at="2026-08-11T00:00:00Z",
        )
        return cli.render_report(
            db.summarise(matrix), corpus, bc.coverage(corpus),
            cli.provenance([_Model()], _Store()), scores,
        )

    def test_no_accuracy_section_exists_without_annotations(self) -> None:
        """⛔ Absent, not zeroed — no heading that implies a measurement was attempted."""
        text = self._report({})
        self.assertNotIn("Accuracy —", text)
        self.assertNotIn("| Precision |", text)
        self.assertNotIn("Per class", text)
        # ⚠️ The standing disclaimer *does* say "Precision and recall are absent", and should — the
        # assertion is that no accuracy table exists, not that the word never appears.
        self.assertIn("Precision and recall are absent", text)

    def test_a_measured_case_is_rendered_with_its_threshold(self) -> None:
        scores = {
            "m::c1": {
                "modelId": "m", "caseId": "c1", "iouThreshold": 0.5, "framesScored": 10,
                "truePositives": 8, "falsePositives": 1, "falseNegatives": 2,
                "precision": 0.888889, "recall": 0.8, "f1": 0.842105, "meanIou": 0.71,
                "perClass": [{"label": "person", "truePositives": 8, "falsePositives": 1,
                              "falseNegatives": 2, "precision": 0.888889, "recall": 0.8,
                              "meanIou": 0.71}],
            }
        }
        text = self._report(scores)
        self.assertIn("Accuracy — measured against Tier-1 ground truth", text)
        self.assertIn("IoU threshold **0.5**", text)
        self.assertIn("`person`", text)

    def test_a_refusal_is_printed_rather_than_omitted(self) -> None:
        """⛔ "No accuracy number" and "the annotations did not match the pixels" look identical in
        a report that omits both, and only the second is somebody's bug."""
        text = self._report({"m::c1": {"modelId": "m", "caseId": "c1",
                                       "refused": "annotations describe sha256:aaaa… — different pixels"}})
        self.assertIn("could not score a run", text)
        self.assertIn("different pixels", text)
        self.assertNotIn("| Detector | Case | Frames |", text)


class ScoringWiringTests(unittest.TestCase):
    """⭐ End-to-end through `_score_case`: the wiring, not the arithmetic."""

    def setUp(self) -> None:
        import annotations as ann

        self.root = tempfile.mkdtemp()
        self.digest = "d" * 64
        self.gt = {
            "schemaVersion": ann.SCHEMA_VERSION, "caseId": "c1", "clipSha256": self.digest,
            "annotatedFps": 2.0,
            "frames": [
                {"frameIndex": i, "boxes": [{"label": "person", "bbox": [0.1, 0.1, 0.2, 0.4]}]}
                for i in range(4)
            ],
        }
        with open(os.path.join(self.root, "c1.json"), "w", encoding="utf-8") as h:
            json.dump(self.gt, h)
        self.case = bc.BenchmarkCase(
            case_id="c1", path="c1.mp4", category="real", footage_kind="REAL_FOOTAGE",
            scenarios=("normal-person",), ground_truth="c1.json", sha256=self.digest,
            consent="c.md", capture={"device": "phone"},
        )

    def _frames(self, n=4, bbox=(0.1, 0.1, 0.2, 0.4)):
        class Frame:
            def __init__(self) -> None:
                self.detections = [{"label": "person", "bbox": list(bbox), "confidence": 0.9}]

        return [Frame() for _ in range(n)]

    def test_a_matching_run_is_scored(self) -> None:
        scores: dict = {}
        cli._score_case(scores, self.case, "m", self._frames(), 2.0, "/fixtures", self.root)
        self.assertEqual(scores["m::c1"]["precision"], 1.0)
        self.assertEqual(scores["m::c1"]["recall"], 1.0)

    def test_scoring_uses_every_sampled_frame_including_warmup(self) -> None:
        """⛔ **The alignment trap.** Warm-up frames are excluded from latency but still analysed;
        scoring the trimmed list would align annotation 0 against sampled frame 3 and shift every
        box, collapsing precision and recall together in a way that looks like a bad detector."""
        scores: dict = {}
        cli._score_case(scores, self.case, "m", self._frames(4), 2.0, "/fixtures", self.root)
        self.assertEqual(scores["m::c1"]["framesScored"], 4)
        self.assertGreater(cli.WARMUP_FRAMES, 0)

    def test_a_digest_mismatch_refuses_rather_than_scores(self) -> None:
        case = bc.BenchmarkCase(
            case_id="c1", path="c1.mp4", category="real", footage_kind="REAL_FOOTAGE",
            scenarios=("normal-person",), ground_truth="c1.json", sha256="e" * 64,
            consent="c.md", capture={"device": "phone"},
        )
        scores: dict = {}
        cli._score_case(scores, case, "m", self._frames(), 2.0, "/fixtures", self.root)
        self.assertIn("refused", scores["m::c1"])
        self.assertNotIn("precision", scores["m::c1"])

    def test_a_rate_mismatch_refuses(self) -> None:
        scores: dict = {}
        cli._score_case(scores, self.case, "m", self._frames(), 5.0, "/fixtures", self.root)
        self.assertIn("refused", scores["m::c1"])

    def test_unreadable_annotations_are_refused_not_skipped(self) -> None:
        with open(os.path.join(self.root, "c1.json"), "w", encoding="utf-8") as h:
            h.write("{not json")
        scores: dict = {}
        cli._score_case(scores, self.case, "m", self._frames(), 2.0, "/fixtures", self.root)
        self.assertIn("refused", scores["m::c1"])

    def test_identity_problems_travel_with_the_score(self) -> None:
        """⚠️ A clip can score detection perfectly while its identities are unusable."""
        scores: dict = {}
        cli._score_case(scores, self.case, "m", self._frames(), 2.0, "/fixtures", self.root)
        self.assertIn("identityProblems", scores["m::c1"])


class SamplingTests(unittest.TestCase):
    def test_the_benchmark_samples_at_the_production_rate(self) -> None:
        """⭐ Production analyses run at 2 fps, so the benchmark measures what the platform does."""
        self.assertEqual(cli.TARGET_FPS, 2.0)

    def test_a_clip_with_no_declared_rate_falls_back_rather_than_dividing_by_zero(self) -> None:
        self.assertEqual(cli._probe_fps("/nonexistent.mp4", fallback=15.0), 15.0)


if __name__ == "__main__":
    unittest.main()
