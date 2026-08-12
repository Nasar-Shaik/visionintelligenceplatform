"""Pose accuracy scoring — P3.3c.

⛔ **The negative controls are the point of this file.** A scorer that is structurally wrong reports
a plausible number rather than an error, and a plausible number is the one thing nobody checks. So
these tests assert what must score LOW: a skeleton attached to the wrong person, a mirrored skeleton,
a prediction one pixel past the threshold, and — most importantly — a run with no ground truth at
all, which must refuse to produce a score rather than report zero.
"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import annotations as ann  # noqa: E402
import pose_scoring as ps  # noqa: E402
from perception import COCO_17  # noqa: E402

#: ⚠️ Deliberately NOT square and NOT round. A 1000×1000 fixture would hide the anisotropy bug this
#: scorer exists to avoid, and a round number hides remainder errors — movie101 is 1080×1920.
W, H = 1080, 1920


#: ⛔ **A body, not a constellation.** The first version of these fixtures placed the 17 joints on a
#: tight index-derived grid; every joint sat well inside the tolerance of every other, so a fully
#: MIRRORED skeleton scored 1.0 and the negative control passed while proving nothing. Joint
#: positions must be spread the way a person's are, as a fraction of the person's own box.
BODY = {
    "nose": (0.50, 0.06),
    "left_eye": (0.45, 0.04), "right_eye": (0.55, 0.04),
    "left_ear": (0.40, 0.05), "right_ear": (0.60, 0.05),
    "left_shoulder": (0.35, 0.18), "right_shoulder": (0.65, 0.18),
    "left_elbow": (0.30, 0.34), "right_elbow": (0.70, 0.34),
    "left_wrist": (0.28, 0.50), "right_wrist": (0.72, 0.50),
    "left_hip": (0.42, 0.52), "right_hip": (0.58, 0.52),
    "left_knee": (0.40, 0.74), "right_knee": (0.60, 0.74),
    "left_ankle": (0.39, 0.96), "right_ankle": (0.61, 0.96),
}

#: The four joints `torso` normalization needs. A fixture omitting them is excluded, by design.
TORSO = ("left_shoulder", "right_shoulder", "left_hip", "right_hip")


def _at(name, cx, cy, w, h):
    fx, fy = BODY[name]
    return cx + (fx - 0.5) * w, cy + (fy - 0.5) * h


def gt_keypoints(cx=0.5, cy=0.5, *, w=0.2, h=0.4, visible=True, names=COCO_17):
    out = []
    for name in names:
        x, y = _at(name, cx, cy, w, h)
        out.append(ann.GroundTruthKeypoint(name=name, x=x, y=y, visible=visible))
    return tuple(out)


def pred_keypoints(cx=0.5, cy=0.5, *, w=0.2, h=0.4, dx=0.0, dy=0.0, visible=True,
                   names=COCO_17, positions=None):
    """`names` labels the joints; `positions` says where they are. Passing a permuted `positions`
    is how a mirrored or swapped skeleton is built without moving the labels."""
    places = positions or names
    out = []
    for name, place in zip(names, places):
        x, y = _at(place, cx, cy, w, h)
        out.append(ps.PredictedKeypoint(name=name, x=x + dx, y=y + dy, confidence=0.9,
                                        visible=visible))
    return tuple(out)


def box(cx=0.5, cy=0.5, *, w=0.2, h=0.4, gt_id=1, keypoints=None, visible=True):
    return ann.Box(label="person", bbox=(cx - w / 2, cy - h / 2, w, h), gt_id=gt_id,
                   keypoints=gt_keypoints(cx, cy, w=w, h=h, visible=visible)
                   if keypoints is None else keypoints)


def person(cx=0.5, cy=0.5, *, w=0.2, h=0.4, keypoints=None):
    return ps.PredictedPerson(bbox=(cx - w / 2, cy - h / 2, w, h), confidence=0.9,
                              keypoints=pred_keypoints(cx, cy, w=w, h=h)
                              if keypoints is None else keypoints)


def torso_px(w=0.2, h=0.4):
    """The reference length the scorer will use, in pixels — left_shoulder → right_hip."""
    (sx, sy), (hx, hy) = BODY["left_shoulder"], BODY["right_hip"]
    return math.hypot((sx - hx) * w * W, (sy - hy) * h * H)


def annotations(frames):
    return ann.Annotations(
        schema_version=ann.SCHEMA_VERSION, case_id="c", clip_sha256="a" * 64,
        annotated_fps=1.928609, annotator="tester", frames=tuple(frames),
    )


def frame(index, boxes):
    return ann.AnnotatedFrame(frame_index=index, boxes=tuple(boxes), at_seconds=index / 1.928609)


def run(gt_frames, predictions, **kwargs):
    return ps.score(annotations(gt_frames), predictions, frame_width=W, frame_height=H, **kwargs)


class PerfectPredictionTests(unittest.TestCase):
    """⚠️ First, because a scorer that returns 0 for everything passes every negative control."""

    def test_an_exact_prediction_scores_one(self) -> None:
        report = run([frame(0, [box()])], {0: [person()]})
        self.assertEqual(report.pck, 1.0)
        self.assertEqual(report.total_joints, 17)
        self.assertEqual(report.gt_people_matched, 1)

    def test_every_joint_is_reported_by_name(self) -> None:
        report = run([frame(0, [box()])], {0: [person()]})
        self.assertEqual([j["joint"] for j in report.to_dict()["perJoint"]], list(COCO_17))


class BoundaryTests(unittest.TestCase):
    """⛔ **The threshold itself.** An off-by-one in the comparison shifts every score in every run
    and is invisible without a test that sits exactly on the line."""

    def _length(self) -> float:
        return torso_px()

    def test_a_prediction_just_inside_the_threshold_counts_as_correct(self) -> None:
        """⚠️ 0.999×, not exactly 1.0×. A displacement is applied in normalized units and measured in
        pixels, and that round-trip cannot represent the boundary exactly — a test sitting on it
        would pass or fail on the last bit of a float. The two tests bracket it to 0.2 %."""
        offset_px = ps.DEFAULT_ALPHA * self._length() * 0.999
        report = run([frame(0, [box()])], {0: [person(keypoints=pred_keypoints(dx=offset_px / W))]})
        self.assertEqual(report.pck, 1.0, "the threshold moved inward")

    def test_a_prediction_just_past_the_threshold_counts_as_wrong(self) -> None:
        offset_px = ps.DEFAULT_ALPHA * self._length() * 1.001
        report = run([frame(0, [box()])], {0: [person(keypoints=pred_keypoints(dx=offset_px / W))]})
        self.assertEqual(report.pck, 0.0, "the threshold moved outward")

    def test_the_tolerance_is_a_quarter_of_the_box_width_not_three_quarters(self) -> None:
        """⛔ **Why `torso` is the default.** On a 1080×1920 portrait frame a `bbox-diagonal` PCK@0.2
        tolerance is 74 % of the person's box width — wide enough to accept a wrist placed on the
        opposite side of the body. That metric would report a high, reproducible, defensible-sounding
        number for a model that had learned almost nothing about limbs."""
        box_width_px = 0.2 * W
        self.assertLess(ps.DEFAULT_ALPHA * torso_px(), 0.35 * box_width_px)
        diagonal = math.hypot(0.2 * W, 0.4 * H)
        self.assertGreater(ps.DEFAULT_ALPHA * diagonal, 0.7 * box_width_px)
        self.assertEqual(ps.DEFAULT_NORMALIZER, "torso")

    def test_the_same_physical_error_scores_the_same_horizontally_and_vertically(self) -> None:
        """⛔ **The anisotropy control.** Coordinates are normalized PER AXIS: on a 1080×1920 frame a
        normalized dx of 0.01 is 10.8 px and the same dy is 19.2 px. A scorer that compares in
        normalized space scores a horizontal error as roughly half a vertical one of equal physical
        size — plausible, reproducible, and wrong."""
        px = ps.DEFAULT_ALPHA * self._length() * 0.5
        horizontal = run([frame(0, [box()])], {0: [person(keypoints=pred_keypoints(dx=px / W))]})
        vertical = run([frame(0, [box()])], {0: [person(keypoints=pred_keypoints(dy=px / H))]})
        self.assertEqual(horizontal.pck, vertical.pck)
        self.assertEqual(horizontal.pck, 1.0)

        beyond = ps.DEFAULT_ALPHA * self._length() * 1.5
        h_out = run([frame(0, [box()])], {0: [person(keypoints=pred_keypoints(dx=beyond / W))]})
        v_out = run([frame(0, [box()])], {0: [person(keypoints=pred_keypoints(dy=beyond / H))]})
        self.assertEqual(h_out.pck, v_out.pck)
        self.assertEqual(h_out.pck, 0.0)


class SwappedSubjectTests(unittest.TestCase):
    """⛔ **Person A's skeleton on person B.** The failure a top-down pipeline actually produces,
    and the one a per-frame average hides: both people are 'detected', both have 17 joints."""

    def test_skeletons_attached_to_the_wrong_person_score_near_zero(self) -> None:
        left, right = box(0.15, 0.5, gt_id=1), box(0.85, 0.5, gt_id=2)
        swapped = [
            ps.PredictedPerson(bbox=left.bbox, confidence=0.9, keypoints=pred_keypoints(0.85, 0.5)),
            ps.PredictedPerson(bbox=right.bbox, confidence=0.9, keypoints=pred_keypoints(0.15, 0.5)),
        ]
        report = run([frame(0, [left, right])], {0: swapped})
        self.assertEqual(report.gt_people_matched, 2, "both people must still MATCH by box")
        self.assertEqual(report.pck, 0.0, "a swapped skeleton scored as correct")

    def test_the_same_two_people_score_one_when_not_swapped(self) -> None:
        """⚠️ The control for the control: the geometry above must be scorable at all."""
        left, right = box(0.15, 0.5, gt_id=1), box(0.85, 0.5, gt_id=2)
        report = run([frame(0, [left, right])], {0: [person(0.15, 0.5), person(0.85, 0.5)]})
        self.assertEqual(report.pck, 1.0)


class MirroredJointTests(unittest.TestCase):
    """⛔ **Left/right confusion** — the classic pose failure, produced by a mirrored training set.
    Every joint is in a humanly plausible place, so the skeleton *looks* right on screen."""

    def _mirrored_positions(self):
        """Each label keeps its name and takes its opposite number's PLACE."""
        swap = {"left": "right", "right": "left"}
        out = []
        for name in COCO_17:
            side, _, rest = name.partition("_")
            out.append(f"{swap[side]}_{rest}" if side in swap else name)
        return out

    def _report(self):
        mirrored = pred_keypoints(0.5, 0.5, positions=self._mirrored_positions())
        return run([frame(0, [box(0.5, 0.5)])], {0: [person(keypoints=mirrored)]})

    def test_the_limb_joints_collapse_under_a_mirror(self) -> None:
        report = self._report()
        for joint in ("left_wrist", "right_wrist", "left_elbow", "right_elbow",
                      "left_shoulder", "right_shoulder"):
            with self.subTest(joint=joint):
                self.assertEqual(report.joints[joint].correct, 0, f"a mirrored {joint} scored correct")
        self.assertEqual(report.joints["nose"].correct, 1, "the unpaired joint should be unaffected")

    def test_the_overall_pck_hides_the_mirror_and_the_wrist_rate_exposes_it(self) -> None:
        """⛔ **The reason per-joint and per-wrist reporting is not decoration.**

        A left/right swap moves the joints that sit near the body's midline — eyes, ears, hips,
        knees, ankles — by less than the tolerance, so they still score as correct. The headline PCK
        therefore lands in the middle and reads as "mediocre model". The wrists go to **zero**, and
        that is the number that says *mirrored*, not *mediocre*.
        """
        report = self._report()
        overall = report.pck
        wrists = report.wrists()["overall"]["pck"]
        self.assertIsNotNone(overall)
        self.assertEqual(wrists, 0.0)
        self.assertGreater(overall, 0.3, "the fixture is not exercising the hiding effect")
        self.assertLess(overall, 1.0)
        self.assertGreater(overall, wrists)

    def test_each_wrist_is_reported_separately_so_a_swap_is_visible(self) -> None:
        wrists = self._report().wrists()
        self.assertEqual(wrists["left"]["joint"], "left_wrist")
        self.assertEqual(wrists["right"]["joint"], "right_wrist")
        self.assertEqual((wrists["left"]["pck"], wrists["right"]["pck"]), (0.0, 0.0))


class EmptyGroundTruthTests(unittest.TestCase):
    """⛔ **The one that must refuse rather than report.** Zero annotations is not zero accuracy."""

    def test_no_annotated_keypoints_yields_no_score_at_all(self) -> None:
        report = run([frame(0, [ann.Box(label="person", bbox=(0.4, 0.3, 0.2, 0.4), gt_id=1)])],
                     {0: [person()]})
        self.assertIsNone(report.pck, "a PCK was produced from no ground truth")
        self.assertEqual(report.total_joints, 0)

    def test_the_verdict_refuses_publication_and_says_why(self) -> None:
        report = run([frame(0, [])], {0: []})
        cover = ps.coverage(report)
        self.assertEqual(cover.verdict, "no-ground-truth")
        self.assertFalse(cover.publishable)
        self.assertTrue(any("NO HUMAN KEYPOINT GROUND TRUTH" in c for c in cover.caveats))

    def test_the_refusal_warns_against_scoring_the_model_against_itself(self) -> None:
        cover = ps.coverage(run([frame(0, [])], {0: []}))
        self.assertTrue(any("not a substitute" in c for c in cover.caveats))


class CoverageGateTests(unittest.TestCase):
    """⛔ Gated on the UNSAFE state, never on the empty one — a banner conditioned on `n == 0`
    deletes itself the moment the first frame is annotated, which is when it matters most."""

    def _frames(self, count):
        return [frame(i, [box(gt_id=i + 1)]) for i in range(count)]

    def _preds(self, count):
        return {i: [person()] for i in range(count)}

    def test_a_tiny_sample_refuses_a_headline(self) -> None:
        cover = ps.coverage(run(self._frames(2), self._preds(2)))
        self.assertEqual(cover.verdict, "insufficient")
        self.assertFalse(cover.publishable)
        self.assertIn("INSUFFICIENT COVERAGE", cover.caveats[0])

    def test_a_small_sample_publishes_only_with_the_sample_size_attached(self) -> None:
        cover = ps.coverage(run(self._frames(6), self._preds(6)))
        self.assertEqual(cover.verdict, "indicative")
        self.assertTrue(cover.publishable)
        self.assertIn("INDICATIVE ONLY", cover.caveats[0])

    def test_a_single_subject_is_always_flagged_however_many_frames(self) -> None:
        """⛔ 500 frames of one person is one person. The count of FRAMES must never be allowed to
        stand in for the count of SUBJECTS."""
        frames = [frame(i, [box(gt_id=1)]) for i in range(40)]
        cover = ps.coverage(run(frames, {i: [person()] for i in range(40)}))
        self.assertNotEqual(cover.verdict, "measured")
        self.assertTrue(any("distinct subject" in c for c in cover.caveats))

    def test_the_caveat_never_disappears_between_empty_and_small(self) -> None:
        """⚠️ The regression that motivated the gate: a warning that vanishes as data arrives."""
        for count in range(0, 8):
            frames = self._frames(count) if count else [frame(0, [])]
            cover = ps.coverage(run(frames, self._preds(count)))
            with self.subTest(frames=count):
                self.assertTrue(cover.caveats, "a sample with no caveat at all")
                self.assertNotEqual(cover.verdict, "measured")


class DetectorSeparationTests(unittest.TestCase):
    """⛔ Requirement 12: a detector's recall must never be reported as a pose model's accuracy."""

    def test_a_person_the_detector_missed_is_excluded_and_counted(self) -> None:
        report = run([frame(0, [box(0.15, 0.5, gt_id=1), box(0.85, 0.5, gt_id=2)])],
                     {0: [person(0.15, 0.5)]})
        self.assertEqual(report.gt_people_matched, 1)
        self.assertEqual(report.gt_people_unmatched, 1)
        self.assertEqual(report.total_joints, 17, "the missed person leaked into the PCK denominator")
        self.assertEqual(report.pck, 1.0)

    def test_the_missed_person_forces_a_caveat(self) -> None:
        report = run([frame(0, [box(0.15, 0.5, gt_id=1), box(0.85, 0.5, gt_id=2)])],
                     {0: [person(0.15, 0.5)]})
        self.assertTrue(any("never matched to a detection" in c for c in ps.coverage(report).caveats))

    def test_a_matched_person_with_no_pose_counts_as_missed_joints(self) -> None:
        """⛔ Not skipped. Dropping them computes PCK over the successes only."""
        report = run([frame(0, [box()])],
                     {0: [ps.PredictedPerson(bbox=box().bbox, keypoints=())]})
        self.assertEqual(report.matched_without_pose, 1)
        self.assertEqual(report.total_joints, 17)
        self.assertEqual(report.pck, 0.0)

    def test_a_detection_with_no_annotation_is_counted_but_never_scored(self) -> None:
        report = run([frame(0, [box(0.15, 0.5)])], {0: [person(0.15, 0.5), person(0.85, 0.5)]})
        self.assertEqual(report.predicted_people_unmatched, 1)
        self.assertEqual(report.total_joints, 17)


class VisibilityTests(unittest.TestCase):
    """⛔ Human visibility splits the score. Model visibility never does."""

    def test_visible_and_occluded_joints_are_tallied_apart(self) -> None:
        visible = box(0.3, 0.5, gt_id=1, keypoints=gt_keypoints(0.3, 0.5, visible=True))
        hidden = box(0.7, 0.5, gt_id=2, keypoints=gt_keypoints(0.7, 0.5, visible=False))
        report = run([frame(0, [visible, hidden])], {0: [person(0.3, 0.5), person(0.7, 0.5)]})
        nose = report.joints["nose"]
        self.assertEqual((nose.total_visible, nose.total_occluded), (1, 1))
        self.assertEqual(report.to_dict()["perJoint"][0]["visible"]["total"], 1)

    def test_the_model_declining_to_see_a_joint_does_not_change_its_pck(self) -> None:
        """⛔ **Requirement: do not convert model visibility into human visibility.** If the model's
        flag were consulted, a model could raise its own score by declining to answer."""
        seen = run([frame(0, [box()])], {0: [person(keypoints=pred_keypoints(visible=True))]})
        unseen = run([frame(0, [box()])], {0: [person(keypoints=pred_keypoints(visible=False))]})
        self.assertEqual(seen.pck, unseen.pck)
        self.assertEqual(seen.total_joints, unseen.total_joints)

    def test_visibility_agreement_is_reported_but_kept_out_of_pck(self) -> None:
        report = run([frame(0, [box()])], {0: [person(keypoints=pred_keypoints(visible=False))]})
        self.assertEqual(report.visibility_agreement["humanSaidVisibleModelDidNot"], 17)
        self.assertEqual(report.visibility_agreement["agree"], 0)
        self.assertEqual(report.pck, 1.0, "visibility disagreement leaked into the localization score")

    def test_a_joint_the_human_omitted_is_never_counted(self) -> None:
        """⛔ Missing annotations are not failures. Only what a human stated is scored."""
        partial = box(keypoints=gt_keypoints(names=TORSO + ("nose",)))
        report = run([frame(0, [partial])], {0: [person()]})
        self.assertEqual(report.total_joints, 5, "only the five stated joints may be scored")
        self.assertEqual(report.joints["left_ankle"].total, 0)
        self.assertEqual(report.joints["nose"].total, 1)
        self.assertEqual(report.excluded_no_normalizer, 0, "a torso was annotated; nothing to exclude")


class NormalizerTests(unittest.TestCase):
    def test_the_normalizer_comes_from_the_human_annotation_not_the_models_box(self) -> None:
        """⛔ A detector drawing generous boxes must not widen its own tolerance."""
        truth = box(0.5, 0.5, w=0.1, h=0.2)
        joints = pred_keypoints(0.5, 0.5, w=0.1, h=0.2, dx=0.01)
        generous = ps.PredictedPerson(bbox=(0.2, 0.1, 0.6, 0.8), keypoints=joints)
        tight = ps.PredictedPerson(bbox=truth.bbox, keypoints=joints)
        wide = run([frame(0, [truth])], {0: [generous]}, match_iou=0.02)
        narrow = run([frame(0, [truth])], {0: [tight]})
        self.assertEqual(wide.gt_people_matched, 1, "the generous box failed to match at all")
        self.assertEqual(wide.pck, narrow.pck)
        self.assertEqual(wide.pck, 1.0)

    def test_torso_refuses_rather_than_falling_back(self) -> None:
        """⛔ A silently substituted normalizer changes every threshold while the report keeps
        printing the name of the one that did not run."""
        only_head = gt_keypoints(names=("nose", "left_eye"))
        report = run([frame(0, [box(keypoints=only_head)])], {0: [person()]}, normalizer="torso")
        self.assertEqual(report.total_joints, 0)
        self.assertEqual(report.excluded_no_normalizer, 1)
        self.assertTrue(any("not computable" in n for n in report.notes))

    def test_an_excluded_person_forces_a_caveat_rather_than_a_quiet_note(self) -> None:
        """⛔ Excluded people are disproportionately the incompletely annotated ones, so a silent
        exclusion raises the score by dropping the hardest subjects."""
        only_head = gt_keypoints(names=("nose", "left_eye"))
        report = run([frame(0, [box(keypoints=only_head)])], {0: [person()]})
        self.assertTrue(any("EXCLUDED from PCK" in c for c in ps.coverage(report).caveats))

    def test_an_unknown_normalizer_is_refused(self) -> None:
        with self.assertRaises(ps.PoseScoringError):
            run([frame(0, [box()])], {0: [person()]}, normalizer="elbow-to-nose")

    def test_scoring_without_frame_dimensions_is_refused(self) -> None:
        with self.assertRaises(ps.PoseScoringError):
            ps.score(annotations([frame(0, [box()])]), {0: [person()]},
                     frame_width=0, frame_height=H)


class MatchingTests(unittest.TestCase):
    def test_a_poorly_overlapping_detection_is_not_called_the_same_person(self) -> None:
        truth = box(0.2, 0.5, w=0.1, h=0.2)
        far = ps.PredictedPerson(bbox=(0.8, 0.5, 0.1, 0.2), keypoints=pred_keypoints(0.8, 0.5))
        report = run([frame(0, [truth])], {0: [far]})
        self.assertEqual(report.gt_people_matched, 0)
        self.assertEqual(report.gt_people_unmatched, 1)

    def test_each_prediction_is_used_at_most_once(self) -> None:
        a, b = box(0.5, 0.5, gt_id=1), box(0.52, 0.5, gt_id=2)
        report = run([frame(0, [a, b])], {0: [person(0.5, 0.5)]})
        self.assertEqual(report.gt_people_matched, 1)
        self.assertEqual(report.gt_people_unmatched, 1)

    def test_iou_is_symmetric_and_bounded(self) -> None:
        self.assertEqual(ps.iou((0, 0, 0.2, 0.2), (0, 0, 0.2, 0.2)), 1.0)
        self.assertEqual(ps.iou((0, 0, 0.2, 0.2), (0.5, 0.5, 0.2, 0.2)), 0.0)
        self.assertAlmostEqual(ps.iou((0, 0, 0.2, 0.2), (0.1, 0, 0.2, 0.2)),
                               ps.iou((0.1, 0, 0.2, 0.2), (0, 0, 0.2, 0.2)))


class UnannotatedFrameTests(unittest.TestCase):
    def test_a_frame_the_human_did_not_annotate_is_not_a_failure(self) -> None:
        """⛔ 'Not yet annotated' and 'nothing there' are different facts."""
        report = run([frame(0, [box()])], {0: [person()], 1: [person()], 2: [person()]})
        self.assertEqual(report.frames_annotated, 1)
        self.assertEqual(report.frames_scored, 1)
        self.assertEqual(report.pck, 1.0)

    def test_an_annotated_frame_with_no_prediction_scores_its_joints_as_missed(self) -> None:
        report = run([frame(0, [box()])], {})
        self.assertEqual(report.gt_people_unmatched, 1)
        self.assertEqual(report.total_joints, 0, "a person with no detection is a DETECTOR miss")


if __name__ == "__main__":
    unittest.main()
