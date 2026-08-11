"""Detection accuracy against ground truth — P3.2c.

⚠️ These are arithmetic tests with hand-checkable numbers. That is deliberate: a scorer whose only
evidence is its own output on real footage cannot be audited, and precision is the number this
platform will eventually be judged on.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import annotations as ann  # noqa: E402
import detection_scoring as ds  # noqa: E402

DIGEST = "c" * 64


def truth(frames) -> ann.Annotations:
    return ann.parse(
        {
            "schemaVersion": ann.SCHEMA_VERSION,
            "caseId": "walk-01",
            "clipSha256": DIGEST,
            "annotatedFps": 2.0,
            "frames": frames,
        }
    )


def box(label="person", bbox=(0.1, 0.1, 0.2, 0.4), **kw) -> dict:
    return {"label": label, "bbox": list(bbox), **kw}


class IouTests(unittest.TestCase):
    def test_identical_boxes_are_one(self) -> None:
        self.assertEqual(ds.iou((0.1, 0.1, 0.2, 0.2), (0.1, 0.1, 0.2, 0.2)), 1.0)

    def test_disjoint_boxes_are_zero(self) -> None:
        self.assertEqual(ds.iou((0.0, 0.0, 0.1, 0.1), (0.5, 0.5, 0.1, 0.1)), 0.0)

    def test_touching_edges_do_not_overlap(self) -> None:
        """⚠️ Zero area of intersection, not a sliver — the boundary case that decides a match."""
        self.assertEqual(ds.iou((0.0, 0.0, 0.1, 0.1), (0.1, 0.0, 0.1, 0.1)), 0.0)

    def test_a_half_overlap_is_a_third(self) -> None:
        """⭐ Hand-checkable: two unit boxes overlapping by half give 0.5 / 1.5 = 1/3."""
        self.assertAlmostEqual(ds.iou((0.0, 0.0, 1.0, 1.0), (0.5, 0.0, 1.0, 1.0)), 1 / 3, places=6)

    def test_a_contained_box_is_the_ratio_of_areas(self) -> None:
        self.assertAlmostEqual(ds.iou((0.0, 0.0, 1.0, 1.0), (0.0, 0.0, 0.5, 1.0)), 0.5, places=6)


class MatchingTests(unittest.TestCase):
    def test_a_class_mismatch_never_matches_however_well_it_overlaps(self) -> None:
        """⛔ A detector that finds the right rectangle with the wrong name has not found it."""
        t = [ann.Box(label="person", bbox=(0.1, 0.1, 0.2, 0.4))]
        p = [ds.Prediction(label="backpack", bbox=(0.1, 0.1, 0.2, 0.4))]
        matches, fp, fn = ds.match_frame(t, p)
        self.assertEqual((len(matches), len(fp), len(fn)), (0, 1, 1))

    def test_one_ground_truth_box_cannot_be_claimed_twice(self) -> None:
        """⛔ Otherwise a detector that fires ten boxes at one person scores ten true positives."""
        t = [ann.Box(label="person", bbox=(0.1, 0.1, 0.2, 0.4))]
        p = [
            ds.Prediction(label="person", bbox=(0.1, 0.1, 0.2, 0.4), confidence=0.9),
            ds.Prediction(label="person", bbox=(0.1, 0.1, 0.2, 0.4), confidence=0.8),
        ]
        matches, fp, _ = ds.match_frame(t, p)
        self.assertEqual((len(matches), len(fp)), (1, 1))

    def test_the_most_confident_prediction_claims_first(self) -> None:
        """⚠️ The COCO convention, and the reason it is named in the report: a different rule scores
        the same detector differently."""
        t = [ann.Box(label="person", bbox=(0.0, 0.0, 1.0, 1.0))]
        p = [
            ds.Prediction(label="person", bbox=(0.0, 0.0, 0.9, 0.9), confidence=0.4),
            ds.Prediction(label="person", bbox=(0.0, 0.0, 1.0, 1.0), confidence=0.99),
        ]
        matches, _, _ = ds.match_frame(t, p)
        self.assertEqual(matches[0][0], 1)

    def test_an_overlap_below_the_threshold_is_not_a_match(self) -> None:
        t = [ann.Box(label="person", bbox=(0.0, 0.0, 1.0, 1.0))]
        p = [ds.Prediction(label="person", bbox=(0.8, 0.8, 1.0, 1.0))]
        matches, fp, fn = ds.match_frame(t, p, iou_threshold=0.5)
        self.assertEqual((len(matches), len(fp), len(fn)), (0, 1, 1))

    def test_indices_identify_which_box_was_missed(self) -> None:
        """⭐ The difference between "recall 0.6" and "it missed the person behind the shelf"."""
        t = [ann.Box(label="person", bbox=(0.0, 0.0, 0.1, 0.1)),
             ann.Box(label="person", bbox=(0.5, 0.5, 0.1, 0.1))]
        p = [ds.Prediction(label="person", bbox=(0.5, 0.5, 0.1, 0.1))]
        _, _, missed = ds.match_frame(t, p)
        self.assertEqual(missed, [0])


class ScoreTests(unittest.TestCase):
    def test_a_perfect_detector_scores_one(self) -> None:
        t = truth([{"frameIndex": 0, "boxes": [box()]}])
        s = ds.score(t, {0: [ds.Prediction("person", (0.1, 0.1, 0.2, 0.4))]})
        self.assertEqual((s.precision, s.recall, s.f1), (1.0, 1.0, 1.0))

    def test_a_missed_object_lowers_recall_not_precision(self) -> None:
        """⭐ Hand-checkable: two real, one found, none wrong → recall 0.5, precision 1.0."""
        t = truth([{"frameIndex": 0, "boxes": [box(), box(bbox=(0.6, 0.1, 0.2, 0.4))]}])
        s = ds.score(t, {0: [ds.Prediction("person", (0.1, 0.1, 0.2, 0.4))]})
        self.assertEqual((s.precision, s.recall), (1.0, 0.5))

    def test_a_hallucinated_object_lowers_precision_not_recall(self) -> None:
        t = truth([{"frameIndex": 0, "boxes": [box()]}])
        s = ds.score(
            t,
            {0: [ds.Prediction("person", (0.1, 0.1, 0.2, 0.4)),
                 ds.Prediction("person", (0.7, 0.7, 0.2, 0.2))]},
        )
        self.assertEqual((s.precision, s.recall), (0.5, 1.0))

    def test_an_empty_annotated_frame_makes_false_positives_measurable(self) -> None:
        """⭐ The reason empty frames are recorded rather than omitted."""
        t = truth([{"frameIndex": 0, "boxes": []}])
        s = ds.score(t, {0: [ds.Prediction("person", (0.1, 0.1, 0.2, 0.4))]})
        self.assertEqual(s.precision, 0.0)
        self.assertIsNone(s.recall)

    def test_unannotated_frames_are_excluded_not_treated_as_empty(self) -> None:
        """⛔ **The subtle one.** Treating an unlabelled frame as zero ground truth would count
        every correct detection in it as a false positive, and a partially annotated clip would read
        as a catastrophic detector."""
        t = truth([{"frameIndex": 0, "boxes": [box()]}])
        s = ds.score(
            t,
            {0: [ds.Prediction("person", (0.1, 0.1, 0.2, 0.4))],
             1: [ds.Prediction("person", (0.1, 0.1, 0.2, 0.4))]},
        )
        self.assertEqual(s.precision, 1.0)
        self.assertEqual(s.frames_scored, 1)
        self.assertEqual(s.frames_unannotated, 1)

    def test_per_class_results_separate_a_blind_spot_from_a_good_average(self) -> None:
        """⛔ The Phase 2 defect, in metric form: excellent on `person`, blind to `backpack`."""
        t = truth([{"frameIndex": 0, "boxes": [box(), box("backpack", (0.6, 0.6, 0.1, 0.1))]}])
        s = ds.score(t, {0: [ds.Prediction("person", (0.1, 0.1, 0.2, 0.4))]})
        by_label = {c.label: c for c in s.classes}
        self.assertEqual(by_label["person"].recall, 1.0)
        self.assertEqual(by_label["backpack"].recall, 0.0)

    def test_precision_is_none_rather_than_zero_when_nothing_was_predicted(self) -> None:
        """⚠️ "Predicted nothing" and "predicted only wrong things" are different failures, and
        averaging them together hides the first."""
        t = truth([{"frameIndex": 0, "boxes": [box()]}])
        s = ds.score(t, {0: []})
        self.assertIsNone(s.precision)
        self.assertEqual(s.recall, 0.0)

    def test_recall_is_none_for_a_class_nobody_annotated(self) -> None:
        t = truth([{"frameIndex": 0, "boxes": [box()]}])
        s = ds.score(t, {0: [ds.Prediction("person", (0.1, 0.1, 0.2, 0.4))]}, labels=["suitcase"])
        by_label = {c.label: c for c in s.classes}
        self.assertIsNone(by_label["suitcase"].recall)

    def test_mean_iou_describes_the_hits_not_the_misses(self) -> None:
        t = truth([{"frameIndex": 0, "boxes": [box(bbox=(0.0, 0.0, 1.0, 1.0))]}])
        s = ds.score(t, {0: [ds.Prediction("person", (0.0, 0.0, 0.5, 1.0))]}, iou_threshold=0.4)
        self.assertAlmostEqual(s.mean_iou, 0.5, places=3)

    def test_the_threshold_travels_with_the_score(self) -> None:
        """⚠️ Precision at 0.5 and at 0.75 are different numbers, and a bare rate says neither."""
        t = truth([{"frameIndex": 0, "boxes": [box()]}])
        self.assertEqual(ds.score(t, {}, iou_threshold=0.75).to_dict()["iouThreshold"], 0.75)


class RenderTests(unittest.TestCase):
    def test_nothing_is_rendered_when_nothing_is_annotated(self) -> None:
        """⛔ The accuracy section is absent, not empty — no headings implying a measurement."""
        self.assertEqual(ds.render([]), "")

    def test_the_report_names_the_threshold_and_the_matching_rule(self) -> None:
        t = truth([{"frameIndex": 0, "boxes": [box()]}])
        text = ds.render([("yolox-nano", ds.score(t, {0: [ds.Prediction("person", (0.1, 0.1, 0.2, 0.4))]}))])
        self.assertIn("IoU threshold", text)
        self.assertIn("greedy by descending", text)

    def test_unscored_frames_are_disclosed(self) -> None:
        t = truth([{"frameIndex": 0, "boxes": [box()]}])
        s = ds.score(t, {0: [ds.Prediction("person", (0.1, 0.1, 0.2, 0.4))], 5: []})
        self.assertIn("carry no annotation", ds.render([("m", s)]))


if __name__ == "__main__":
    unittest.main()
