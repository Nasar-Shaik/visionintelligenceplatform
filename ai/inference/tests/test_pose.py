"""Top-down pose decode — P3.3b.

⛔ The load-bearing tests are the ones that prove the runtime **does not invent a joint**: a
saturated argmax is not a position, a coordinate outside the frame is not clamped into a valid one,
and `visible` never means "not occluded".
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pose  # noqa: E402
from perception import COCO_17, DEFAULT_SKELETON  # noqa: E402

BINS_X, BINS_Y = int(pose.INPUT_W * pose.SPLIT_RATIO), int(pose.INPUT_H * pose.SPLIT_RATIO)


def spike(bins: int, index: int, peak: float = 0.9, floor: float = 0.01):
    """A SimCC row whose argmax is `index` — the shape the model actually emits."""
    row = [floor] * bins
    row[index] = peak
    return row


def maps(positions, peak: float = 0.9):
    """17 joints at `positions` = [(ix, iy), ...]; a single pair is broadcast to all joints."""
    if len(positions) == 1:
        positions = list(positions) * len(COCO_17)
    xs = [spike(BINS_X, ix, peak) for ix, _ in positions]
    ys = [spike(BINS_Y, iy, peak) for _, iy in positions]
    return xs, ys


class CropTests(unittest.TestCase):
    def test_a_centred_box_produces_a_centred_crop(self) -> None:
        crop = pose.crop_for([0.25, 0.25, 0.5, 0.5], 1000, 1000, margin=0.0)
        self.assertEqual((crop.x, crop.y, crop.w, crop.h), (250, 250, 500, 500))

    def test_the_margin_widens_the_crop(self) -> None:
        """⭐ A detector box is tight; wrists sit on its edge, and a joint on the edge decodes to
        the edge."""
        tight = pose.crop_for([0.4, 0.4, 0.2, 0.2], 1000, 1000, margin=0.0)
        wide = pose.crop_for([0.4, 0.4, 0.2, 0.2], 1000, 1000, margin=0.5)
        self.assertGreater(wide.w, tight.w)

    def test_a_crop_at_the_frame_edge_is_clamped_not_padded(self) -> None:
        """⚠️ A person at the edge gets less context — honest — rather than a padded region the
        model would read as body."""
        crop = pose.crop_for([0.0, 0.0, 0.2, 0.2], 1000, 1000, margin=0.5)
        self.assertGreaterEqual(crop.x, 0)
        self.assertGreaterEqual(crop.y, 0)

    def test_a_crop_never_exceeds_the_frame(self) -> None:
        crop = pose.crop_for([0.9, 0.9, 0.2, 0.2], 640, 480, margin=1.0)
        self.assertLessEqual(crop.x + crop.w, 640)
        self.assertLessEqual(crop.y + crop.h, 480)

    def test_a_degenerate_box_is_refused(self) -> None:
        with self.assertRaises(pose.PoseError):
            pose.crop_for([0.5, 0.5, 0.0, 0.0], 640, 480)

    def test_portrait_and_landscape_both_letterbox(self) -> None:
        """⚠️ 1080×1920 portrait is what the verified live camera produces."""
        for fw, fh in ((1080, 1920), (1920, 1080)):
            with self.subTest(frame=f"{fw}x{fh}"):
                crop = pose.crop_for([0.3, 0.2, 0.4, 0.6], fw, fh)
                self.assertGreaterEqual(crop.pad_x, 0.0)
                self.assertGreaterEqual(crop.pad_y, 0.0)


class DecodeTests(unittest.TestCase):
    def _crop(self):
        return pose.crop_for([0.25, 0.25, 0.5, 0.5], 1000, 1000, margin=0.0)

    def test_all_seventeen_joints_are_returned_in_canonical_order(self) -> None:
        """⛔ Never a short list: "joint 9 is missing" and "the list is shorter" are different facts
        and only one survives an index-based consumer."""
        xs, ys = maps([(BINS_X // 2, BINS_Y // 2)])
        kps = pose.decode(xs, ys, self._crop(), 1000, 1000)
        self.assertEqual([k.name for k in kps], list(COCO_17))

    def test_the_centre_bin_decodes_to_the_centre_of_the_crop(self) -> None:
        crop = self._crop()
        xs, ys = maps([(BINS_X // 2, BINS_Y // 2)])
        kp = pose.decode(xs, ys, crop, 1000, 1000)[0]
        self.assertAlmostEqual(kp.x, 0.5, places=2)
        self.assertAlmostEqual(kp.y, 0.5, places=2)

    def test_a_known_pixel_survives_the_round_trip(self) -> None:
        """⭐ **The property the three coordinate spaces exist to satisfy.** Take a pixel inside the
        crop, forward-transform it to a SimCC bin exactly as the model would, decode, and land back
        on the pixel. Any single-space error — a missing letterbox, a wrong split ratio, a swapped
        axis — breaks this and nothing else in the file catches all three."""
        crop = pose.crop_for([0.2, 0.1, 0.5, 0.7], 1080, 1920, margin=0.0)
        for px, py in ((10, 20), (100, 300), (crop.w - 5, crop.h - 5)):
            with self.subTest(pixel=(px, py)):
                ix = round((px * crop.scale + crop.pad_x) * pose.SPLIT_RATIO)
                iy = round((py * crop.scale + crop.pad_y) * pose.SPLIT_RATIO)
                if pose._saturated(ix, BINS_X) or pose._saturated(iy, BINS_Y):
                    continue
                xs, ys = maps([(ix, iy)])
                kp = pose.decode(xs, ys, crop, 1080, 1920)[0]
                self.assertAlmostEqual(kp.x * 1080, crop.x + px, delta=1.0)
                self.assertAlmostEqual(kp.y * 1920, crop.y + py, delta=1.0)

    def test_confidence_is_the_weaker_axis(self) -> None:
        """⚠️ A joint localised sharply in x and vaguely in y is not a confident joint."""
        xs = [spike(BINS_X, 100, peak=0.9) for _ in COCO_17]
        ys = [spike(BINS_Y, 100, peak=0.2) for _ in COCO_17]
        self.assertAlmostEqual(pose.decode(xs, ys, self._crop(), 1000, 1000)[0].confidence, 0.2, places=5)

    def test_a_graph_with_the_wrong_simcc_width_is_refused(self) -> None:
        """⛔ A different split ratio decodes every joint proportionally wrong — a skeleton that
        looks like a skeleton, slightly wrong, everywhere. That reads as a bad model."""
        xs = [spike(256, 10) for _ in COCO_17]
        ys = [spike(256, 10) for _ in COCO_17]
        with self.assertRaises(pose.PoseError) as caught:
            pose.decode(xs, ys, self._crop(), 1000, 1000)
        self.assertIn("split ratio", str(caught.exception))

    def test_a_graph_with_the_wrong_joint_count_is_refused(self) -> None:
        xs, ys = maps([(50, 50)])
        with self.assertRaises(pose.PoseError):
            pose.decode(xs[:12], ys[:12], self._crop(), 1000, 1000)


class ArtifactAnchorTests(unittest.TestCase):
    """⛔ **Literals, measured from the verified artifact — the only tests here that pin the decode.**

    A mutation check exposed the hole they fill: changing `SPLIT_RATIO` from 2.0 to 4.0 left the whole
    suite green, because the round-trip test forward-transforms with the same constant it reverses
    with, so the error cancels exactly. `check_outputs` had the same blindness — it derived its
    expectation from `INPUT_W * SPLIT_RATIO`, so it moved too.

    ⚠️ These numbers are facts about `rtmpose-tiny-aic-coco-1.0.0.onnx`
    (sha256 38b1d472…), read from the traced graph in P3.3a: `image [1,3,256,192]`,
    `simcc_x [1,17,384]`, `simcc_y [1,17,512]`. They do not follow from anything in `pose.py`, which
    is precisely why they can catch it.
    """

    #: From `onnx.checker` on the verified artifact. Change these only when the artifact changes.
    ARTIFACT_INPUT_W, ARTIFACT_INPUT_H = 192, 256
    ARTIFACT_SIMCC_X, ARTIFACT_SIMCC_Y = 384, 512

    def test_the_input_size_matches_the_artifact(self) -> None:
        self.assertEqual((pose.INPUT_W, pose.INPUT_H), (self.ARTIFACT_INPUT_W, self.ARTIFACT_INPUT_H))

    def test_the_decode_expects_exactly_the_artifacts_simcc_widths(self) -> None:
        """⭐ Pins `SPLIT_RATIO` against a measured output width rather than against itself."""
        pose.check_outputs(self.ARTIFACT_SIMCC_X, self.ARTIFACT_SIMCC_Y)  # must not raise
        self.assertEqual(int(pose.INPUT_W * pose.SPLIT_RATIO), self.ARTIFACT_SIMCC_X)
        self.assertEqual(int(pose.INPUT_H * pose.SPLIT_RATIO), self.ARTIFACT_SIMCC_Y)

    def test_a_bin_index_maps_to_the_pixel_the_artifact_implies(self) -> None:
        """The last x bin of 384 is pixel 191.5 of a 192-wide input — arithmetic that only holds at
        split ratio 2.0, stated without reference to the constant."""
        crop = pose.crop_for([0.0, 0.0, 1.0, 1.0], self.ARTIFACT_INPUT_W, self.ARTIFACT_INPUT_H, margin=0.0)
        self.assertAlmostEqual(crop.scale, 1.0, places=6)
        xs = [spike(self.ARTIFACT_SIMCC_X, 200) for _ in COCO_17]
        ys = [spike(self.ARTIFACT_SIMCC_Y, 300) for _ in COCO_17]
        kp = pose.decode(xs, ys, crop, self.ARTIFACT_INPUT_W, self.ARTIFACT_INPUT_H)[0]
        self.assertAlmostEqual(kp.x * self.ARTIFACT_INPUT_W, 100.0, delta=0.5)
        self.assertAlmostEqual(kp.y * self.ARTIFACT_INPUT_H, 150.0, delta=0.5)


class SaturationTests(unittest.TestCase):
    """⛔ The measured failure: a chest-up framing put all eight lower-body joints at exactly the
    crop's bottom edge, confidence 0.05–0.34. RTMPose has no "not found" output."""

    def _crop(self):
        return pose.crop_for([0.25, 0.25, 0.5, 0.5], 1000, 1000, margin=0.0)

    def test_a_joint_at_the_last_bin_is_not_visible(self) -> None:
        xs, ys = maps([(BINS_X // 2, BINS_Y - 1)], peak=0.99)
        kp = pose.decode(xs, ys, self._crop(), 1000, 1000)[0]
        self.assertFalse(kp.visible, "a saturated argmax is not a located joint")

    def test_a_saturated_joint_stays_not_visible_even_at_high_confidence(self) -> None:
        """⚠️ Confidence alone cannot rescue it — the coordinate is an artefact of the argmax having
        nowhere further to go."""
        xs, ys = maps([(0, 0)], peak=1.0)
        self.assertFalse(pose.decode(xs, ys, self._crop(), 1000, 1000)[0].visible)

    def test_an_interior_joint_of_the_same_confidence_is_visible(self) -> None:
        """⭐ The positive control — saturation is what differs, not the confidence."""
        xs, ys = maps([(BINS_X // 2, BINS_Y // 2)], peak=0.99)
        self.assertTrue(pose.decode(xs, ys, self._crop(), 1000, 1000)[0].visible)

    def test_a_coordinate_outside_the_frame_is_reported_not_clamped(self) -> None:
        """⛔ Folding it to 0.0/1.0 would manufacture a keypoint on the border that no consumer
        could tell from a real one."""
        crop = pose.crop_for([0.0, 0.0, 0.3, 0.3], 1000, 1000, margin=0.0)
        xs, ys = maps([(5, 5)], peak=0.99)
        kp = pose.decode(xs, ys, crop, 1000, 1000)[0]
        self.assertFalse(kp.visible)


class VisibilitySemanticsTests(unittest.TestCase):
    """⛔ `visible` is a statement about the MODEL, never about occlusion."""

    def _crop(self):
        return pose.crop_for([0.25, 0.25, 0.5, 0.5], 1000, 1000, margin=0.0)

    def test_a_low_confidence_joint_is_not_visible_but_keeps_its_position(self) -> None:
        """⭐ Position and visibility are separate answers — the coordinate is still reported."""
        xs, ys = maps([(BINS_X // 2, BINS_Y // 2)], peak=0.05)
        kp = pose.decode(xs, ys, self._crop(), 1000, 1000)[0]
        self.assertFalse(kp.visible)
        self.assertAlmostEqual(kp.x, 0.5, places=2)

    def test_confidence_and_visible_are_not_the_same_field(self) -> None:
        xs, ys = maps([(BINS_X // 2, BINS_Y - 1)], peak=0.99)
        kp = pose.decode(xs, ys, self._crop(), 1000, 1000)[0]
        self.assertGreater(kp.confidence, 0.9)
        self.assertFalse(kp.visible)

    def test_the_threshold_is_configurable_and_applied(self) -> None:
        xs, ys = maps([(BINS_X // 2, BINS_Y // 2)], peak=0.4)
        self.assertTrue(pose.decode(xs, ys, self._crop(), 1000, 1000, threshold=0.3)[0].visible)
        self.assertFalse(pose.decode(xs, ys, self._crop(), 1000, 1000, threshold=0.5)[0].visible)

    def test_the_attribute_states_what_visible_means(self) -> None:
        """⛔ The payload says it in words, because a consumer six months from now reads the JSON,
        not this module."""
        xs, ys = maps([(BINS_X // 2, BINS_Y // 2)])
        attr = pose.to_attribute(pose.decode(xs, ys, self._crop(), 1000, 1000),
                                 model_id="rtmpose-tiny", artifact_sha256="ab" * 32)
        self.assertIn("NOT a claim about physical occlusion", attr["visibleMeaning"])
        self.assertEqual(attr["skeleton"], DEFAULT_SKELETON)
        self.assertEqual(attr["artifactSha256"], "ab" * 32)
        self.assertEqual(len(attr["keypoints"]), 17)


class SkeletonTopologyTests(unittest.TestCase):
    def test_every_edge_names_a_canonical_joint(self) -> None:
        """⛔ No `hand` joint — COCO annotates the wrist."""
        for a, b in pose.COCO_17_EDGES:
            with self.subTest(edge=(a, b)):
                self.assertIn(a, COCO_17)
                self.assertIn(b, COCO_17)

    def test_the_wrists_are_connected_to_the_elbows(self) -> None:
        self.assertIn(("left_elbow", "left_wrist"), pose.COCO_17_EDGES)
        self.assertIn(("right_elbow", "right_wrist"), pose.COCO_17_EDGES)

    def test_no_edge_is_declared_twice(self) -> None:
        seen = {frozenset(e) for e in pose.COCO_17_EDGES}
        self.assertEqual(len(seen), len(pose.COCO_17_EDGES))


class SummaryTests(unittest.TestCase):
    def test_the_summary_counts_and_never_scores(self) -> None:
        """⛔ There is no human keypoint ground truth, so no accuracy word may appear."""
        xs, ys = maps([(BINS_X // 2, BINS_Y // 2)])
        crop = pose.crop_for([0.25, 0.25, 0.5, 0.5], 1000, 1000, margin=0.0)
        out = pose.summarise(pose.decode(xs, ys, crop, 1000, 1000))
        self.assertEqual(out["joints"], 17)
        self.assertEqual(out["visible"], 17)
        for banned in ("accuracy", "pck", "precision", "recall", "correct"):
            self.assertNotIn(banned, " ".join(out.keys()).lower())


if __name__ == "__main__":
    unittest.main()
