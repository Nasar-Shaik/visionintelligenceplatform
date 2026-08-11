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

    def test_keypoints_are_accepted_and_not_scored(self) -> None:
        """⭐ The format does not have to change when pose validation begins — and accepting the
        field authorises no pose model."""
        a = self._box(keypoints=[{"name": "left_wrist", "x": 0.2, "y": 0.3}])
        self.assertEqual(len(a.frames[0].boxes[0].keypoints), 1)

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
