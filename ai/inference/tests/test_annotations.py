"""Tier-1 ground truth and its gates — P3.2c.

⛔ **The load-bearing test here is `test_a_reexported_clip_cannot_be_scored`.** Every other defect in
this file produces an error a human sees. That one produces a *precision score* — precise,
reproducible, and about pixels nobody annotated.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import annotations as ann  # noqa: E402

DIGEST = "e6f1448f54821fae4d5a197e464a08fc6c5a85453309f98fffc407aa99396107"
OTHER = "b" * 64


def doc(**kw) -> dict:
    base = {
        "schemaVersion": ann.SCHEMA_VERSION,
        "caseId": "walk-01",
        "clipSha256": DIGEST,
        "annotatedFps": 2.0,
        "annotator": "nasar",
        "frames": [
            {"frameIndex": 0, "atSeconds": 0.0,
             "boxes": [{"label": "person", "bbox": [0.1, 0.1, 0.2, 0.5], "gtId": 1}]},
            {"frameIndex": 1, "atSeconds": 0.5,
             "boxes": [{"label": "person", "bbox": [0.12, 0.1, 0.2, 0.5], "gtId": 1}]},
        ],
    }
    base.update(kw)
    return base


class SchemaTests(unittest.TestCase):
    def test_a_valid_file_parses(self) -> None:
        """⚠️ The positive control, first: a validator that rejects everything passes every test
        below it."""
        a = ann.parse(doc())
        self.assertEqual(a.box_count, 2)
        self.assertEqual(a.labels, ("person",))

    def test_an_unversioned_file_is_refused(self) -> None:
        """⛔ A scorer cannot tell a file that predates a rule from one that disagrees with it."""
        with self.assertRaises(ann.AnnotationError):
            ann.parse(doc(schemaVersion=""))

    def test_an_explicitly_unbound_file_parses(self) -> None:
        """⭐ **One rule at both layers.** The corpus *forbids* constructed fixtures a `sha256` — git
        binds them — so requiring one here made authored ground truth unparseable and the exemption
        in `align()` unreachable. Found by running the first end-to-end scoring job, not by review.
        """
        self.assertIsNone(ann.parse(doc(clipSha256=None)).clip_sha256)

    def test_a_malformed_digest_is_still_refused(self) -> None:
        """⚠️ Explicit `null` is a decision; a broken string is somebody who meant to bind."""
        with self.assertRaises(ann.AnnotationError):
            ann.parse(doc(clipSha256=""))
        with self.assertRaises(ann.AnnotationError):
            ann.parse(doc(clipSha256="not-a-digest"))

    def test_a_truncated_digest_is_refused(self) -> None:
        """⚠️ 64 hex characters. A prefix would look right in a diff and bind to nothing."""
        with self.assertRaises(ann.AnnotationError):
            ann.parse(doc(clipSha256=DIGEST[:12]))

    def test_a_file_without_an_annotation_rate_is_refused(self) -> None:
        """⛔ Without the rate, a frame index cannot be matched to an instant."""
        with self.assertRaises(ann.AnnotationError):
            ann.parse(doc(annotatedFps=0))

    def test_a_file_with_no_frames_is_refused(self) -> None:
        with self.assertRaises(ann.AnnotationError):
            ann.parse(doc(frames=[]))

    def test_a_duplicated_frame_is_refused(self) -> None:
        """⛔ Which record is the truth is unknowable; picking either silently halves or doubles
        that frame's recall."""
        with self.assertRaises(ann.AnnotationError):
            ann.parse(doc(frames=[{"frameIndex": 0, "boxes": []}, {"frameIndex": 0, "boxes": []}]))

    def test_frames_are_sorted_however_they_were_written(self) -> None:
        a = ann.parse(doc(frames=[{"frameIndex": 5, "boxes": []}, {"frameIndex": 2, "boxes": []}]))
        self.assertEqual(a.frame_indices, (2, 5))

    def test_an_empty_frame_is_a_statement_not_an_omission(self) -> None:
        """⭐ An annotated frame with no boxes is what makes false positives measurable."""
        a = ann.parse(doc(frames=[{"frameIndex": 0, "boxes": []}]))
        self.assertEqual(len(a.frames), 1)
        self.assertEqual(a.box_count, 0)

    def test_the_file_is_read_from_disk(self) -> None:
        path = os.path.join(tempfile.mkdtemp(), "a.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(doc(), handle)
        self.assertEqual(ann.load(path).case_id, "walk-01")

    def test_an_unreadable_file_is_refused(self) -> None:
        with self.assertRaises(ann.AnnotationError):
            ann.load("/nonexistent/a.json")


class BoxTests(unittest.TestCase):
    def _box(self, **kw):
        return ann.parse(doc(frames=[{"frameIndex": 0, "boxes": [{"label": "person", "bbox": [0.1, 0.1, 0.2, 0.5], **kw}]}]))

    def test_a_pixel_coordinate_box_is_refused(self) -> None:
        """⛔ Annotations are normalized like the runtime's boxes. Pixel coordinates would score
        every frame as a total miss — a plausible catastrophic result from a formatting mistake."""
        with self.assertRaises(ann.AnnotationError):
            self._box(bbox=[100, 200, 50, 300])

    def test_a_zero_area_box_is_refused(self) -> None:
        """⛔ It matches nothing at any threshold and would be a permanent miss."""
        with self.assertRaises(ann.AnnotationError):
            self._box(bbox=[0.1, 0.1, 0.0, 0.5])

    def test_a_box_with_no_label_is_refused(self) -> None:
        with self.assertRaises(ann.AnnotationError):
            self._box(label="")

    def test_an_unknown_visibility_state_is_refused(self) -> None:
        with self.assertRaises(ann.AnnotationError):
            self._box(visibility="a-bit-hidden")

    def test_visibility_is_recorded_separately_from_confidence(self) -> None:
        """⭐ Recall on occluded subjects is a different question from recall."""
        a = self._box(visibility="partially-occluded")
        self.assertEqual(a.frames[0].boxes[0].visibility, "partially-occluded")

    def test_keypoints_are_validated_and_not_scored(self) -> None:
        """⭐ The format does not have to change when pose validation begins — and accepting the
        field authorises no pose model. ⚠️ `visible` is required, so this differs from the earlier
        permissive form, which let an unusable joint through."""
        a = self._box(keypoints=[{"name": "left_wrist", "x": 0.2, "y": 0.3, "visible": True}])
        kp = a.frames[0].boxes[0].keypoints
        self.assertEqual(len(kp), 1)
        self.assertEqual(kp[0].name, "left_wrist")
        self.assertTrue(kp[0].visible)

    def test_a_non_integer_identity_is_refused(self) -> None:
        with self.assertRaises(ann.AnnotationError):
            self._box(gtId="person-a")


class AlignmentTests(unittest.TestCase):
    """⛔ The gate: ground truth scores a run only when it describes the same pixels and instants."""

    def setUp(self) -> None:
        self.a = ann.parse(doc())

    def test_a_matching_clip_aligns(self) -> None:
        report = ann.align(self.a, case_id="walk-01", clip_sha256=DIGEST, sampled_fps=2.0)
        self.assertTrue(report.aligned)

    def test_a_reexported_clip_cannot_be_scored(self) -> None:
        """⛔ **The one that matters.** Filenames get reused; re-export from a phone and every box
        describes different pixels. Without this the precision score is precise and about nothing."""
        report = ann.align(self.a, case_id="walk-01", clip_sha256=OTHER, sampled_fps=2.0)
        self.assertFalse(report.aligned)
        self.assertIn("different pixels", report.problems[0])

    def test_a_rate_mismatch_is_refused(self) -> None:
        """⛔ Annotate at 2 fps, sample at 5, and every frame is both a miss and a false positive."""
        report = ann.align(self.a, case_id="walk-01", clip_sha256=DIGEST, sampled_fps=5.0)
        self.assertFalse(report.aligned)

    def test_annotations_beyond_the_run_are_refused(self) -> None:
        """⛔ Frames nobody analysed are not misses; counting them reports recall against footage
        that was never processed."""
        report = ann.align(self.a, case_id="walk-01", clip_sha256=DIGEST, analysed_frames=1)
        self.assertFalse(report.aligned)
        self.assertIn("nobody analysed", report.problems[0])

    def test_an_empty_digest_is_not_the_same_as_no_digest(self) -> None:
        """⛔ A case that *should* have carried one is refused; only an explicit `None` skips."""
        report = ann.align(self.a, case_id="walk-01", clip_sha256="", sampled_fps=2.0)
        self.assertFalse(report.aligned)

    def test_digest_bound_footage_may_not_be_scored_by_unbound_annotations(self) -> None:
        """⛔ **The direction that matters.** Real footage carries a digest; annotations that carry
        none would silently drop the only check tying these boxes to those pixels."""
        unbound = ann.parse(doc(clipSha256=None))
        report = ann.align(unbound, case_id="walk-01", clip_sha256=DIGEST, sampled_fps=2.0)
        self.assertFalse(report.aligned)
        self.assertIn("must be digest-bound", report.problems[0])

    def test_unbound_footage_may_not_be_scored_by_digest_bound_annotations(self) -> None:
        """⚠️ The other direction is a pairing mistake too, and is reported rather than ignored."""
        report = ann.align(self.a, case_id="walk-01", clip_sha256=None, sampled_fps=2.0)
        self.assertFalse(report.aligned)

    def test_an_unbound_pairing_aligns(self) -> None:
        """⚠️ The positive control for constructed fixtures: both unbound is the authored case."""
        unbound = ann.parse(doc(clipSha256=None))
        self.assertTrue(ann.align(unbound, case_id="walk-01", clip_sha256=None, sampled_fps=2.0).aligned)

    def test_a_different_case_is_refused(self) -> None:
        report = ann.align(self.a, case_id="other-clip", clip_sha256=DIGEST)
        self.assertFalse(report.aligned)

    def test_every_problem_is_reported_not_only_the_first(self) -> None:
        report = ann.align(self.a, case_id="other", clip_sha256=OTHER, sampled_fps=9.0)
        self.assertEqual(len(report.problems), 3)


class IdentityConsistencyTests(unittest.TestCase):
    def test_a_consistent_clip_has_no_problems(self) -> None:
        self.assertEqual(ann.identity_problems(ann.parse(doc())), ())

    def test_one_subject_cannot_be_in_two_places_in_one_frame(self) -> None:
        """⛔ Unchecked, this inflates every identity metric computed from the file."""
        bad = doc(frames=[{"frameIndex": 0, "boxes": [
            {"label": "person", "bbox": [0.1, 0.1, 0.2, 0.5], "gtId": 1},
            {"label": "person", "bbox": [0.5, 0.1, 0.2, 0.5], "gtId": 1},
        ]}])
        self.assertTrue(ann.identity_problems(ann.parse(bad)))

    def test_an_identity_may_not_change_class(self) -> None:
        """⚠️ A gtId that is a person in one frame and a backpack in the next is a typo, and it
        would otherwise be scored as a tracking failure the detector caused."""
        bad = doc(frames=[
            {"frameIndex": 0, "boxes": [{"label": "person", "bbox": [0.1, 0.1, 0.2, 0.5], "gtId": 1}]},
            {"frameIndex": 1, "boxes": [{"label": "backpack", "bbox": [0.1, 0.1, 0.2, 0.5], "gtId": 1}]},
        ])
        problems = ann.identity_problems(ann.parse(bad))
        self.assertTrue(any("changes label" in p for p in problems))

    def test_identity_counts_are_per_clip(self) -> None:
        """⚠️ `gtId` 1 in two clips is two different people — Tier-1 makes no cross-clip claim, and
        one would be a re-identification claim that ADR-0055 governs."""
        self.assertEqual(ann.parse(doc()).identities(), {1: 2})

    def test_boxes_without_an_identity_are_allowed(self) -> None:
        """⚠️ Detection ground truth is useful before anyone tracks identities by hand."""
        a = ann.parse(doc(frames=[{"frameIndex": 0, "boxes": [
            {"label": "bottle", "bbox": [0.4, 0.4, 0.05, 0.1]}]}]))
        self.assertEqual(a.identities(), {})


if __name__ == "__main__":
    unittest.main()


class KeypointValidationTests(unittest.TestCase):
    """⛔ **Keypoints were opaque dictionaries until P3.2g.**

    Nothing checked a joint name, a coordinate range, or whether `visible` was even present. A typo,
    a pixel coordinate or a missing field parsed silently and surfaced much later as a garbage PCK —
    after the annotation cost was already sunk. Every rule below has both directions.
    """

    def _kp(self, *keypoints, skeleton=None):
        box = {"label": "person", "bbox": [0.1, 0.1, 0.2, 0.5], "keypoints": list(keypoints)}
        if skeleton is not None:
            box["skeleton"] = skeleton
        return ann.parse(doc(frames=[{"frameIndex": 0, "boxes": [box]}]))

    def _valid(self, **kw):
        base = {"name": "left_wrist", "x": 0.2, "y": 0.3, "visible": True}
        base.update(kw)
        return base

    # --- the positive controls, first: a validator that refuses everything passes every negative ---

    def test_a_well_formed_keypoint_is_accepted(self) -> None:
        self.assertEqual(len(self._kp(self._valid()).frames[0].boxes[0].keypoints), 1)

    def test_a_hidden_joint_is_accepted_and_keeps_its_position(self) -> None:
        """⭐ The case pose is bought for: a wrist that is *there but hidden* still has a location,
        and "did the model put the hidden wrist in the right place" is the question."""
        kp = self._kp(self._valid(visible=False)).frames[0].boxes[0].keypoints[0]
        self.assertFalse(kp.visible)
        self.assertEqual((kp.x, kp.y), (0.2, 0.3))

    def test_every_coco_joint_is_accepted(self) -> None:
        from perception import COCO_17

        kps = [{"name": n, "x": 0.5, "y": 0.5, "visible": True} for n in COCO_17]
        self.assertEqual(len(self._kp(*kps).frames[0].boxes[0].keypoints), len(COCO_17))

    def test_a_box_with_no_keypoints_is_still_valid(self) -> None:
        """⚠️ Boxes come first and pose later; detector scoring must not wait on joints."""
        self.assertEqual(self._kp().frames[0].boxes[0].keypoints, ())

    # --- and the refusals ---

    def test_an_unknown_joint_is_refused(self) -> None:
        """⛔ `left_hand` is not a COCO joint — COCO annotates the wrist. A vocabulary the model
        never learned cannot be scored against it."""
        with self.assertRaises(ann.AnnotationError) as caught:
            self._kp(self._valid(name="left_hand"))
        self.assertIn("wrist", str(caught.exception))

    def test_a_misspelled_joint_is_refused(self) -> None:
        """⚠️ `leftWrist` vs `left_wrist` is the disagreement that surfaces as a terrible score
        rather than as an error."""
        with self.assertRaises(ann.AnnotationError):
            self._kp(self._valid(name="leftWrist"))

    def test_a_keypoint_without_visible_is_refused(self) -> None:
        """⛔ A joint whose visibility nobody stated cannot answer the occlusion question."""
        kp = self._valid()
        del kp["visible"]
        with self.assertRaises(ann.AnnotationError):
            self._kp(kp)

    def test_a_non_boolean_visible_is_refused(self) -> None:
        for bad in ("true", 1, None, "yes"):
            with self.assertRaises(ann.AnnotationError):
                self._kp(self._valid(visible=bad))

    def test_a_pixel_coordinate_keypoint_is_refused(self) -> None:
        """⛔ Normalized like every other coordinate; pixels score as a total miss everywhere."""
        with self.assertRaises(ann.AnnotationError):
            self._kp(self._valid(x=412, y=508))

    def test_a_negative_coordinate_is_refused(self) -> None:
        with self.assertRaises(ann.AnnotationError):
            self._kp(self._valid(y=-0.01))

    def test_a_keypoint_with_no_coordinates_is_refused(self) -> None:
        kp = {"name": "left_wrist", "visible": True}
        with self.assertRaises(ann.AnnotationError):
            self._kp(kp)

    def test_a_malformed_keypoint_is_refused(self) -> None:
        """⚠️ A bare string where an object belongs — the shape mistake a hand-written file makes."""
        with self.assertRaises(ann.AnnotationError):
            self._kp("left_wrist")

    def test_a_keypoints_field_that_is_not_a_list_is_refused(self) -> None:
        box = {"label": "person", "bbox": [0.1, 0.1, 0.2, 0.5], "keypoints": {"name": "left_wrist"}}
        with self.assertRaises(ann.AnnotationError):
            ann.parse(doc(frames=[{"frameIndex": 0, "boxes": [box]}]))

    def test_a_duplicate_joint_is_refused(self) -> None:
        """⛔ One subject has one left wrist. Which record is the truth is unknowable, and either
        choice silently halves or doubles that joint's score."""
        with self.assertRaises(ann.AnnotationError):
            self._kp(self._valid(), self._valid(x=0.9))

    def test_a_human_confidence_is_refused(self) -> None:
        """⛔ **The one that protects the measurement.** `confidence` is how sure a MODEL was; a
        human number there would be compared against it at scoring time and mean something else
        entirely. `visible` carries the human's fact; an unsure joint is omitted."""
        with self.assertRaises(ann.AnnotationError) as caught:
            self._kp(self._valid(confidence=0.8))
        self.assertIn("MODEL", str(caught.exception))

    def test_an_unknown_skeleton_is_refused(self) -> None:
        with self.assertRaises(ann.AnnotationError):
            self._kp(self._valid(), skeleton="halpe-26")

    def test_the_default_skeleton_is_the_pose_seam_s_own(self) -> None:
        """⭐ One vocabulary, declared in `perception` where `skeleton` already lived — not a second
        keypoint representation invented alongside it."""
        from perception import DEFAULT_SKELETON

        self.assertEqual(self._kp().frames[0].boxes[0].skeleton, DEFAULT_SKELETON)
