"""The detector gate — P3.3b.

⛔ The load-bearing tests prove pose **does not run** where it must not. RTMPose is top-down: given
any crop it returns 17 confident-looking joints, so "is a person here" must never be its answer.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pose  # noqa: E402
import pose_estimator as pe  # noqa: E402
from contracts import Detection  # noqa: E402
from perception import ATTR_POSE, COCO_17  # noqa: E402

BINS_X, BINS_Y = int(pose.INPUT_W * pose.SPLIT_RATIO), int(pose.INPUT_H * pose.SPLIT_RATIO)


class _Frame:
    """A frame stand-in. ⭐ Stdlib only, so the detector gate is testable outside the built image."""

    def __init__(self, w: int = 640, h: int = 480) -> None:
        self.shape = (h, w, 3)

    def __getitem__(self, _key):
        return _Sub()


class _Sub:
    size = 1


class _FakeSession:
    """Stands in for onnxruntime. ⚠️ Shaped from the REAL artifact's outputs — (1,17,384) and
    (1,17,512), read off the traced graph in P3.3a. A double built from a guess is how four
    benchmark columns shipped wrong in this project."""

    def __init__(self) -> None:
        self.calls = 0
        self.peak_x = BINS_X // 2
        self.peak_y = BINS_Y // 2

    def run(self, _outputs, _feeds):
        self.calls += 1
        row_x = [0.01] * BINS_X
        row_x[self.peak_x] = 0.9
        row_y = [0.01] * BINS_Y
        row_y[self.peak_y] = 0.9
        return [[[list(row_x) for _ in COCO_17]], [[list(row_y) for _ in COCO_17]]]

    def get_inputs(self):
        return [type("I", (), {"name": "image"})()]

    def get_providers(self):
        return ["CPUExecutionProvider"]


class _Estimator(pe.PoseEstimator):
    """Production gating and payload logic; the pixel path substituted."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.decodes = 0

    def _decode(self, image):
        self.decodes += 1
        return _Frame()

    def _preprocess(self, sub, crop):
        return "blob"


def _estimator() -> _Estimator:
    est = _Estimator()
    est._session = _FakeSession()
    est._input_name = "image"
    est._sha256 = "38b1d472" + "0" * 56
    est.execution_provider = "CPUExecutionProvider"
    return est


def _jpeg(width: int = 640, height: int = 480) -> bytes:
    """⚠️ Never decoded — `_Estimator._decode` substitutes the frame."""
    return b"not-a-real-jpeg"


def det(label: str = "person", bbox=(0.3, 0.2, 0.3, 0.6)) -> Detection:
    return Detection(label=label, confidence=0.9, bbox=bbox, class_id=0)


class DetectorGateTests(unittest.TestCase):
    """⛔ **The safety property, and it is structural rather than thresholded.**"""

    def test_a_person_detection_gets_a_pose(self) -> None:
        """⚠️ First: a gate that blocks everything passes every negative test below."""
        out = _estimator().estimate(_jpeg(), [det()])
        self.assertIn(ATTR_POSE, out[0].attributes)
        self.assertEqual(len(out[0].attributes[ATTR_POSE]["keypoints"]), 17)

    def test_no_detections_means_no_pose_inference(self) -> None:
        """⛔ **The empty room.** No detection, no crop, no inference — no threshold involved."""
        est = _estimator()
        self.assertEqual(est.estimate(_jpeg(), []), [])
        self.assertEqual(est._session.calls, 0)

    def test_non_person_labels_are_never_posed(self) -> None:
        """⛔ A body-keypoint model over a bottle returns 17 confident joints on a bottle."""
        est = _estimator()
        objects = [det(label=l) for l in ("bottle", "backpack", "tie", "handbag", "chair")]
        out = est.estimate(_jpeg(), objects)
        for d in out:
            with self.subTest(label=d.label):
                self.assertNotIn(ATTR_POSE, d.attributes)
        self.assertEqual(est._session.calls, 0, "the model ran on a non-person")

    def test_a_mixed_frame_poses_only_the_people(self) -> None:
        est = _estimator()
        out = est.estimate(_jpeg(), [det(label="bottle"), det(), det(label="tie"), det()])
        posed = [d for d in out if ATTR_POSE in d.attributes]
        self.assertEqual(len(posed), 2)
        self.assertEqual(est._session.calls, 2, "one inference per person, no more and no fewer")

    def test_a_non_person_is_returned_untouched_not_annotated_empty(self) -> None:
        """⚠️ An empty pose would be a claim that the model looked and found nothing."""
        out = _estimator().estimate(_jpeg(), [det(label="bottle")])
        self.assertEqual(out[0].attributes, {})

    def test_a_frame_with_no_person_is_never_even_decoded(self) -> None:
        """⛔ **Measured, not assumed.** Before this gate moved ahead of the decode, a `tie`-only
        frame cost 25 ms more with pose enabled than without — a full 1080×1920 decode done purely
        so that every detection on it could then be skipped."""
        est = _estimator()
        est.estimate(_jpeg(), [det(label="tie"), det(label="bottle")])
        self.assertEqual(est.decodes, 0, "the frame was decoded for a stage that could not run")
        self.assertEqual(est._skipped_not_person, 2)

    def test_a_frame_with_one_person_among_objects_is_decoded_once(self) -> None:
        est = _estimator()
        est.estimate(_jpeg(), [det(label="tie"), det(), det(label="bottle")])
        self.assertEqual(est.decodes, 1)
        self.assertEqual(est._session.calls, 1)

    def test_an_unloaded_estimator_changes_nothing(self) -> None:
        """⭐ Pose is additive: a runtime without the model behaves exactly as before."""
        out = pe.PoseEstimator().estimate(_jpeg(), [det()])
        self.assertNotIn(ATTR_POSE, out[0].attributes)


class MultiPersonTests(unittest.TestCase):
    def test_each_person_gets_their_own_inference(self) -> None:
        est = _estimator()
        people = [det(bbox=(0.05, 0.2, 0.2, 0.6)), det(bbox=(0.40, 0.2, 0.2, 0.6)),
                  det(bbox=(0.75, 0.2, 0.2, 0.6))]
        out = est.estimate(_jpeg(), people)
        self.assertEqual(est._session.calls, 3)
        self.assertEqual(sum(1 for d in out if ATTR_POSE in d.attributes), 3)

    def test_keypoints_land_inside_their_own_persons_box(self) -> None:
        """⛔ Skeleton A must not attach to person B. The fake peaks at the crop centre, so each
        person's joints must fall near their own box centre — a swap moves them across the frame."""
        est = _estimator()
        left, right = det(bbox=(0.05, 0.2, 0.2, 0.6)), det(bbox=(0.75, 0.2, 0.2, 0.6))
        out = est.estimate(_jpeg(), [left, right])
        lx = out[0].attributes[ATTR_POSE]["keypoints"][0]["x"]
        rx = out[1].attributes[ATTR_POSE]["keypoints"][0]["x"]
        self.assertLess(lx, 0.35)
        self.assertGreater(rx, 0.65)
        self.assertGreater(rx - lx, 0.3)


class PayloadTests(unittest.TestCase):
    def test_the_payload_names_the_artifact_that_produced_it(self) -> None:
        """⚠️ A keypoint is only interpretable against the weights that produced it."""
        attrs = _estimator().estimate(_jpeg(), [det()])[0].attributes[ATTR_POSE]
        self.assertTrue(attrs["artifactSha256"].startswith("38b1d472"))
        self.assertEqual(attrs["model"], "rtmpose-tiny")
        self.assertEqual(attrs["skeleton"], "coco-17")

    def test_the_payload_states_what_visible_means(self) -> None:
        attrs = _estimator().estimate(_jpeg(), [det()])[0].attributes[ATTR_POSE]
        self.assertIn("NOT a claim about physical occlusion", attrs["visibleMeaning"])

    def test_existing_attributes_are_preserved(self) -> None:
        d = Detection(label="person", confidence=0.9, bbox=(0.3, 0.2, 0.3, 0.6),
                      class_id=0, attributes={"zoneIds": ["z1"]})
        out = _estimator().estimate(_jpeg(), [d])[0]
        self.assertEqual(out.attributes["zoneIds"], ["z1"])
        self.assertIn(ATTR_POSE, out.attributes)

    def test_identity_fields_survive_the_rebuild(self) -> None:
        """⚠️ `estimate` rebuilds the frozen Detection; a dropped field here would be silent."""
        d = Detection(label="person", confidence=0.9, bbox=(0.3, 0.2, 0.3, 0.6), class_id=0,
                      tracking_id="trk_1", identity_id="trk_1", detection_id="d1", preceded_by="trk_0")
        out = _estimator().estimate(_jpeg(), [d])[0]
        self.assertEqual((out.tracking_id, out.identity_id, out.detection_id, out.preceded_by),
                         ("trk_1", "trk_1", "d1", "trk_0"))


class StatsTests(unittest.TestCase):
    def test_stats_count_inferences_and_skips_and_never_score(self) -> None:
        est = _estimator()
        est.estimate(_jpeg(), [det(), det(label="bottle")])
        s = est.stats()
        self.assertEqual(s["poseInferences"], 1)
        self.assertEqual(s["skippedNotPerson"], 1)
        for banned in ("accuracy", "pck", "precision", "correct"):
            self.assertNotIn(banned, " ".join(str(k) for k in s).lower())


if __name__ == "__main__":
    unittest.main()
