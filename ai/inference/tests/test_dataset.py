"""AI-5e CCTV dataset library tests.

Two properties matter most here and both are about refusing things: footage without a recorded licence
or consent basis must not load, and a case whose category does not exist must not silently disappear
from the suite. A regression test that quietly stops running is indistinguishable from a passing one.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dataset import (  # noqa: E402
    SCENARIO_CATEGORIES,
    DatasetError,
    DatasetLibrary,
    Expectation,
    FootageReference,
    case_from_dict,
    render_coverage,
)

CASE = {
    "id": "loitering/case-a",
    "category": "loitering",
    "title": "A dwells at the door",
    "footage": {"path": "clips/a.mp4", "origin": "internal-capture", "licence": "consented staging"},
    "expectations": [{"kind": "behavior", "type": "loitering", "count": 1, "fromSeconds": 5, "toSeconds": 20}],
}


class FootageReferenceTest(unittest.TestCase):
    def test_it_refuses_footage_with_no_licence(self):
        with self.assertRaises(DatasetError):
            FootageReference(path="a.mp4", origin="customer-pilot", licence="  ")

    def test_it_refuses_an_unknown_origin(self):
        with self.assertRaises(DatasetError):
            FootageReference(path="a.mp4", origin="found-on-a-usb-stick", licence="x")

    def test_absent_footage_is_reported_not_raised(self):
        ref = FootageReference(path="nope/missing.mp4", origin="synthetic", licence="n/a")
        self.assertFalse(ref.available())
        self.assertIsNone(ref.verify())

    def test_a_digest_mismatch_voids_the_footage(self):
        root = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(root, "clips"))
            path = os.path.join(root, "clips", "a.mp4")
            with open(path, "wb") as fh:
                fh.write(b"not really a video")
            ref = FootageReference(
                path="clips/a.mp4", origin="synthetic", licence="n/a", sha256="0" * 64
            )
            self.assertTrue(ref.available(root))
            self.assertIs(ref.verify(root), False)
        finally:
            shutil.rmtree(root)


class ExpectationTest(unittest.TestCase):
    def test_it_refuses_an_expectation_that_is_both_present_and_absent(self):
        with self.assertRaises(DatasetError):
            Expectation(kind="behavior", type="loitering", count=2, absent=True)

    def test_it_refuses_an_inverted_window(self):
        with self.assertRaises(DatasetError):
            Expectation(kind="behavior", type="loitering", from_seconds=30, to_seconds=10)

    def test_the_window_is_inclusive_at_both_ends(self):
        e = Expectation(kind="behavior", type="x", from_seconds=5, to_seconds=10)
        self.assertTrue(e.within(5.0))
        self.assertTrue(e.within(10.0))
        self.assertFalse(e.within(4.9))
        self.assertFalse(e.within(10.1))

    def test_an_untimed_occurrence_is_accepted_into_any_window(self):
        # A missing timestamp is the evaluator's gap, not the runtime's fault. Failing a case over it
        # would produce noise instead of signal.
        self.assertTrue(Expectation(kind="event", type="x", from_seconds=5).within(None))

    def test_tolerance_is_symmetric(self):
        e = Expectation(kind="behavior", type="x", count=4, count_tolerance=1)
        self.assertTrue(e.satisfied_by(3))
        self.assertTrue(e.satisfied_by(5))
        self.assertFalse(e.satisfied_by(2))

    def test_an_expectation_with_no_count_means_at_least_one(self):
        e = Expectation(kind="behavior", type="x")
        self.assertTrue(e.satisfied_by(1))
        self.assertFalse(e.satisfied_by(0))

    def test_a_negative_expectation_is_satisfied_only_by_silence(self):
        e = Expectation(kind="event", type="theft", absent=True)
        self.assertTrue(e.satisfied_by(0))
        self.assertFalse(e.satisfied_by(1))

    def test_the_window_renders_readably(self):
        self.assertEqual(
            Expectation(kind="behavior", type="x", from_seconds=5, to_seconds=20).window, "5.0-20.0s"
        )
        self.assertEqual(Expectation(kind="behavior", type="x", to_seconds=20).window, "start-20.0s")
        self.assertIsNone(Expectation(kind="behavior", type="x").window)


class CaseParsingTest(unittest.TestCase):
    def test_a_case_parses_with_defaults(self):
        case = case_from_dict(CASE)
        self.assertEqual(case.category, "loitering")
        self.assertEqual(case.zones, [])
        self.assertEqual(case.options, {})
        self.assertEqual(len(case.expectations), 1)

    def test_an_unknown_category_is_refused_at_load(self):
        payload = dict(CASE, category="telepathy")
        with self.assertRaises(DatasetError) as ctx:
            case_from_dict(payload)
        self.assertIn("SCENARIO_CATEGORIES", str(ctx.exception))

    def test_a_missing_required_field_names_the_file(self):
        payload = dict(CASE)
        payload.pop("title")
        with self.assertRaises(DatasetError) as ctx:
            case_from_dict(payload, manifest_path="/x/y.json")
        self.assertIn("/x/y.json", str(ctx.exception))

    def test_positive_and_negative_expectations_are_separable(self):
        payload = dict(CASE)
        payload["expectations"] = [
            {"kind": "behavior", "type": "loitering", "count": 1},
            {"kind": "event", "type": "theft", "absent": True},
        ]
        case = case_from_dict(payload)
        self.assertEqual(len(case.positive_expectations), 1)
        self.assertEqual(len(case.negative_expectations), 1)

    def test_a_case_round_trips_through_its_dict(self):
        case = case_from_dict(CASE)
        again = case_from_dict(dict(case.to_dict()))
        self.assertEqual(again.id, case.id)
        self.assertEqual(again.expectations[0].window, case.expectations[0].window)


class LibraryTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self._write("loitering", "a", CASE)

    def tearDown(self):
        shutil.rmtree(self.root)

    def _write(self, category, name, payload):
        d = os.path.join(self.root, category, "cases")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{name}.json"), "w", encoding="utf-8") as fh:
            json.dump(payload, fh)

    def test_it_loads_cases_from_the_category_directories(self):
        library = DatasetLibrary(self.root).load()
        self.assertEqual(len(library), 1)
        self.assertIsNotNone(library.get("loitering/case-a"))

    def test_a_case_in_the_wrong_directory_is_refused(self):
        # The directory is the source of truth. Without this the corpus drifts into a state where
        # `--category queue` silently misses cases that live somewhere else.
        self._write("queue", "misfiled", CASE)
        with self.assertRaises(DatasetError) as ctx:
            DatasetLibrary(self.root).load()
        self.assertIn("directory is the source of truth", str(ctx.exception))

    def test_duplicate_ids_are_refused(self):
        self._write("loitering", "b", CASE)
        with self.assertRaises(DatasetError):
            DatasetLibrary(self.root).load()

    def test_coverage_reports_every_scenario_including_the_empty_ones(self):
        # The empty rows are the most informative part of the table: a scenario with zero cases is
        # not a scenario the platform handles.
        coverage = DatasetLibrary(self.root).load().coverage()
        self.assertEqual(len(coverage), len(SCENARIO_CATEGORIES))
        by_category = {row["category"]: row for row in coverage}
        self.assertEqual(by_category["loitering"]["cases"], 1)
        self.assertEqual(by_category["fire"]["cases"], 0)

    def test_missing_footage_is_listed(self):
        library = DatasetLibrary(self.root).load()
        self.assertEqual([c.id for c in library.missing_footage()], ["loitering/case-a"])

    def test_coverage_renders_with_a_total_row(self):
        text = render_coverage(DatasetLibrary(self.root).load().coverage())
        self.assertIn("loitering", text)
        self.assertIn("total", text)


class ShippedLibraryTest(unittest.TestCase):
    """The corpus that actually ships in the repository."""

    def test_it_loads(self):
        library = DatasetLibrary().load()
        self.assertGreater(len(library), 0)

    def test_every_scenario_directory_exists(self):
        root = DatasetLibrary().root
        for category in SCENARIO_CATEGORIES:
            self.assertTrue(
                os.path.isdir(os.path.join(root, category, "cases")),
                f"scenario '{category}' has no cases/ directory",
            )

    def test_every_shipped_case_records_a_licence(self):
        for case in DatasetLibrary().load():
            self.assertTrue(case.footage.licence.strip(), case.id)

    def test_at_least_one_shipped_case_asserts_an_absence(self):
        # False positives are the failure mode that loses a deployment. The corpus must be able to
        # assert their absence, and must actually do so somewhere.
        library = DatasetLibrary().load()
        self.assertTrue(any(c.negative_expectations for c in library))


if __name__ == "__main__":
    unittest.main()
