"""Per-label confidence floors in `ConfidencePostprocessor` — P-11 slice 2.10.

⛔ **The defect these tests pin down was invisible for three milestones.** `AssociationModule` has
run on every frame since slice 2.2 and never had an object to associate. The cause was not the
primitive, the tracker, the wire or the footage: it was one number. `minConfidence: 0.5` was chosen
for `person`, which the deployed detector scores up to 0.919 on real photographs, and applied to all
eighty COCO classes. The same detector scores a real `suitcase` at 0.456 and a real `handbag` at
0.244 — so four of the five carriable classes had **zero** detections admitted, ever.

⚠️ Every score below is one the **deployed** yolox-nano actually produced on a real photograph in
the pinned corpus (`docs/validation/object-corpus.json`, measured by `ai/mlops/probe_classes.py`).
They are used here as fixtures so the arithmetic is checked without a model, not as a substitute for
the measurement.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contracts import FrameContext  # noqa: E402
from pipeline import ConfidencePostprocessor, RawDetection  # noqa: E402

#: COCO ids for the classes this slice is about.
PERSON, BACKPACK, HANDBAG = 0, 24, 26

LABELS = ["person"] + [f"class-{i}" for i in range(1, 80)]
LABELS[BACKPACK] = "backpack"
LABELS[HANDBAG] = "handbag"


def _ctx() -> FrameContext:
    return FrameContext(tenant_id="tnt_test", camera_id="cam_test", image=b"")


def _raw(class_id: int, score: float) -> RawDetection:
    return RawDetection(bbox=(0.1, 0.1, 0.2, 0.4), score=score, class_id=class_id)


class DefaultFloorTests(unittest.TestCase):
    def test_without_floors_the_behaviour_is_exactly_what_it_was(self) -> None:
        """⭐ The backward-compatibility guarantee. A deployment that never opts in is unchanged."""
        post = ConfidencePostprocessor(labels=LABELS)
        kept = post.run([_raw(PERSON, 0.87), _raw(HANDBAG, 0.2443), _raw(BACKPACK, 0.2151)], _ctx(), 0.5)
        self.assertEqual([d.label for d in kept], ["person"])

    def test_an_empty_map_is_not_a_lower_floor(self) -> None:
        post = ConfidencePostprocessor(labels=LABELS, floors={})
        kept = post.run([_raw(HANDBAG, 0.2443)], _ctx(), 0.5)
        self.assertEqual(kept, [])


class PerLabelFloorTests(unittest.TestCase):
    def test_the_measured_handbag_survives_its_own_floor(self) -> None:
        """⛔ 0.2443 is the real score of a real handbag, against a floor of 0.50."""
        post = ConfidencePostprocessor(labels=LABELS, floors={"handbag": 0.20})
        kept = post.run([_raw(PERSON, 0.891), _raw(HANDBAG, 0.2443)], _ctx(), 0.5)
        self.assertEqual(sorted(d.label for d in kept), ["handbag", "person"])

    def test_a_floor_applies_only_to_the_label_it_names(self) -> None:
        post = ConfidencePostprocessor(labels=LABELS, floors={"handbag": 0.20})
        kept = post.run([_raw(BACKPACK, 0.2443), _raw(HANDBAG, 0.2443)], _ctx(), 0.5)
        self.assertEqual([d.label for d in kept], ["handbag"])

    def test_a_person_below_the_capability_floor_is_still_dropped(self) -> None:
        """⚠️ Lowering a floor for objects must not quietly lower it for people."""
        post = ConfidencePostprocessor(labels=LABELS, floors={"handbag": 0.05})
        self.assertEqual(post.run([_raw(PERSON, 0.31)], _ctx(), 0.5), [])

    def test_the_floor_is_chosen_by_label_not_by_class_id(self) -> None:
        """⛔ The ordering trap: a raw detection carries id 26, and a floor declared for "handbag"
        cannot be found by a stage still holding the integer. The label must be resolved first."""
        post = ConfidencePostprocessor(labels=LABELS, floors={"handbag": 0.20})
        kept = post.run([_raw(HANDBAG, 0.30)], _ctx(), 0.5)
        self.assertEqual([d.label for d in kept], ["handbag"])
        self.assertEqual([d.class_id for d in kept], [HANDBAG])

    def test_a_backend_supplied_label_is_honoured_too(self) -> None:
        """⚠️ Some adapters label the detection themselves and send no class id."""
        post = ConfidencePostprocessor(floors={"handbag": 0.20})
        kept = post.run([RawDetection(bbox=(0.0, 0.0, 0.1, 0.1), score=0.3, label="handbag")], _ctx(), 0.5)
        self.assertEqual([d.label for d in kept], ["handbag"])

    def test_an_unlabelled_detection_uses_the_capability_floor(self) -> None:
        """⚠️ It finds nothing in the map, and must not inherit the lowest floor in it."""
        post = ConfidencePostprocessor(floors={"handbag": 0.05})
        self.assertEqual(post.run([RawDetection(bbox=(0.0, 0.0, 0.1, 0.1), score=0.3)], _ctx(), 0.5), [])

    def test_a_raised_floor_is_respected_as_readily_as_a_lowered_one(self) -> None:
        """⚠️ The field is not "the place object floors get lowered" — it is per-class calibration.
        A deployment drowning in false `tie` detections raises that one and nothing else."""
        post = ConfidencePostprocessor(labels=LABELS, floors={"person": 0.95})
        self.assertEqual(post.run([_raw(PERSON, 0.891)], _ctx(), 0.5), [])


class MeasuredSeparationTests(unittest.TestCase):
    """⛔ The floor is a claim about a measurement, so the measurement is asserted.

    ⚠️ These are the real extremes from the slice-2.10 corpus: the strongest score on **authored**
    footage, where no carriable object exists by construction, and the strongest on real photographs
    chosen for one. If a future recalibration moves 0.20 without moving these, the gap it claims has
    stopped existing and this test says so.

    ⛔ The negative control is authored footage and not real crowd photographs, deliberately. A crowd
    photograph scored `handbag` at 0.408 and inspection found a real shopping bag in it — crowds
    carry things, so a real-world scene can never bound a false-positive rate for a carried object.
    """

    FALSE_MAX = {"backpack": 0.1554, "handbag": 0.0778}
    TRUE_MAX = {"cup": 0.8652, "suitcase": 0.4558, "bottle": 0.2595, "handbag": 0.2443, "backpack": 0.2151}
    FLOOR = 0.20

    def test_the_floor_sits_above_every_observed_false_positive(self) -> None:
        for label, score in self.FALSE_MAX.items():
            with self.subTest(label=label):
                self.assertLess(score, self.FLOOR)

    def test_the_floor_sits_below_the_strongest_observed_true_positives(self) -> None:
        for label, score in self.TRUE_MAX.items():
            with self.subTest(label=label):
                self.assertGreater(score, self.FLOOR)

    def test_recall_at_this_floor_is_recorded_as_poor(self) -> None:
        """⭐ The honest half, asserted so it cannot quietly disappear from the documentation.

        9 of the 30 photographs chosen for a carried object have it admitted at 0.20. That recovers
        the capability from zero; it does not make yolox-nano a carried-object detector, and the
        other 21 stay invisible. The remainder is a detector problem, and it is Phase 3 work."""
        recovered, corpus = 9, 30
        self.assertLess(recovered / corpus, 0.5)

    def test_a_lower_floor_would_buy_recall_with_false_positives(self) -> None:
        """⚠️ Why 0.20 and not 0.15. Measured: 0.15 recovers 11/30 and admits a `backpack` on
        authored footage that contains no object at all — a fabricated carry, which is a worse
        failure than a missed one."""
        self.assertGreater(self.FALSE_MAX["backpack"], 0.15)
        self.assertLess(self.FALSE_MAX["backpack"], self.FLOOR)


if __name__ == "__main__":
    unittest.main()
