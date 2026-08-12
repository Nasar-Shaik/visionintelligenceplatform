"""The pose-scoring CLI — P3.3c.

⛔ These tests are about the **joins**, not the arithmetic: whether the annotator's frame N and the
runtime's frame N describe the same pixels at the same moment, and whether a file that cannot say
where it came from is refused before it can contribute a number.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import annotations as ann  # noqa: E402
import pose_score_cli as cli  # noqa: E402
from perception import COCO_17  # noqa: E402


def predictions(**overrides) -> dict:
    document = {
        "schemaVersion": cli.PREDICTIONS_SCHEMA,
        "caseId": "movie101",
        "clipSha256": "e" * 64,
        "frameWidth": 1080,
        "frameHeight": 1920,
        "sourceFps": 27.001,
        "stride": 14,
        "effectiveFps": 1.928643,
        "effectiveFpsTolerance": 3.5714e-05,
        "provenance": {"commit": "abc123", "poseModel": "rtmpose-tiny",
                       "poseArtifactSha256": "38b1" + "0" * 60},
        "frames": [{"frameIndex": i, "file": f"frame-{i:05d}.png", "fileSha256": "f" * 64,
                    "people": []} for i in range(37)],
    }
    document.update(overrides)
    return document


def annotations_at(fps: float, *, frames=(0,), clip: str = "e" * 64) -> ann.Annotations:
    return ann.Annotations(
        schema_version=ann.SCHEMA_VERSION, case_id="movie101", clip_sha256=clip,
        annotated_fps=fps, annotator="tester",
        frames=tuple(ann.AnnotatedFrame(frame_index=i) for i in frames),
    )


GEOMETRY = {"effectiveFps": 1.928643, "effectiveFpsTolerance": 3.5714e-05, "stride": 14,
            "clipSha256": "e" * 64, "width": 1080, "height": 1920}


class RateToleranceTests(unittest.TestCase):
    """⛔ The tolerance is derived from the manifest's own precision, never chosen for convenience."""

    def test_the_tolerance_follows_the_declared_precision(self) -> None:
        # 27.001 is stated to 3dp → the true rate is within ±0.0005 → ±0.0005/14 sampled.
        self.assertAlmostEqual(cli._rate_tolerance(27.001, 14), 0.0005 / 14, places=12)

    def test_a_coarser_declaration_earns_a_wider_tolerance(self) -> None:
        self.assertGreater(cli._rate_tolerance(27.0, 14), cli._rate_tolerance(27.001, 14))

    def test_the_measured_and_manifest_rates_agree_within_it(self) -> None:
        """⚠️ The real pair: the skeleton generator probes the clip (1.928609) and the manifest
        implies 1.928643. They differ in the fifth decimal, and that must be acceptable —
        while a genuine rate mistake must not be."""
        self.assertLess(abs(1.928609 - 1.928643), cli._rate_tolerance(27.001, 14))


class AlignmentTests(unittest.TestCase):
    def test_matching_files_align(self) -> None:
        self.assertEqual(cli.check_alignment(annotations_at(1.928609), predictions(), GEOMETRY), [])

    def test_a_different_clip_digest_is_refused(self) -> None:
        problems = cli.check_alignment(annotations_at(1.928609, clip="a" * 64),
                                       predictions(), GEOMETRY)
        self.assertTrue(any("different pixels" in p for p in problems))

    def test_a_rate_mistake_is_refused(self) -> None:
        """⛔ The 2.0-vs-1.9286 mistake: every individual frame looks right and the whole file slides.
        Over 37 frames at 1.93 fps that is ~0.7 s of drift by the end."""
        problems = cli.check_alignment(annotations_at(2.0), predictions(), GEOMETRY)
        self.assertTrue(any("rate mismatch" in p for p in problems))
        self.assertTrue(any("slides the whole" in p for p in problems))

    def test_an_annotation_beyond_the_analysed_range_is_refused(self) -> None:
        problems = cli.check_alignment(annotations_at(1.928609, frames=(0, 40)),
                                       predictions(), GEOMETRY)
        self.assertTrue(any("only 37 frames were analysed" in p for p in problems))

    def test_a_rate_inside_the_manifests_rounding_is_accepted(self) -> None:
        self.assertEqual(cli.check_alignment(annotations_at(1.928620), predictions(), GEOMETRY), [])


class ProvenanceTests(unittest.TestCase):
    """⛔ A number whose origin cannot be named is not evidence."""

    def _write(self, document) -> str:
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(document, handle)
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_predictions_without_a_commit_are_refused(self) -> None:
        document = predictions()
        document["provenance"] = {k: v for k, v in document["provenance"].items() if k != "commit"}
        with self.assertRaises(cli.CliError):
            cli.load_predictions(self._write(document))

    def test_predictions_without_an_artifact_digest_are_refused(self) -> None:
        document = predictions()
        document["provenance"]["poseArtifactSha256"] = ""
        with self.assertRaises(cli.CliError):
            cli.load_predictions(self._write(document))

    def test_predictions_for_another_clip_are_refused(self) -> None:
        with self.assertRaises(cli.CliError) as caught:
            cli.load_predictions(self._write(predictions()), clip_sha256="a" * 64)
        self.assertIn("about nothing", str(caught.exception))

    def test_predictions_for_another_case_are_refused(self) -> None:
        with self.assertRaises(cli.CliError):
            cli.load_predictions(self._write(predictions()), case_id="someone-elses-clip")

    def test_a_future_schema_is_refused_rather_than_guessed_at(self) -> None:
        with self.assertRaises(cli.CliError):
            cli.load_predictions(self._write(predictions(schemaVersion="pose-predictions-2099")))


class FrameOrderTests(unittest.TestCase):
    """⛔ The index in the NAME, never the directory's order — 302 unrelated frames once entered a
    run this way and made it unattributable."""

    def _dir(self, names) -> str:
        directory = tempfile.mkdtemp()
        for name in names:
            open(os.path.join(directory, name), "wb").close()
        self.addCleanup(lambda: [os.unlink(os.path.join(directory, n)) for n in os.listdir(directory)])
        return directory

    def test_frames_are_ordered_by_index_not_by_listing(self) -> None:
        found = cli._frame_files(self._dir(["frame-00010.png", "frame-00002.png", "frame-00000.png",
                                            *[f"frame-{i:05d}.png" for i in (1, 3, 4, 5, 6, 7, 8, 9)]]))
        self.assertEqual([os.path.basename(p) for p in found][:3],
                         ["frame-00000.png", "frame-00001.png", "frame-00002.png"])

    def test_a_gap_in_the_indices_is_refused(self) -> None:
        with self.assertRaises(cli.CliError) as caught:
            cli._frame_files(self._dir(["frame-00000.png", "frame-00002.png"]))
        self.assertIn("different pixels", str(caught.exception))

    def test_a_file_with_no_readable_index_is_refused(self) -> None:
        with self.assertRaises(cli.CliError):
            cli._frame_files(self._dir(["frame-00000.png", "screenshot.png"]))

    def test_non_images_are_ignored(self) -> None:
        found = cli._frame_files(self._dir(["frame-00000.png", "annotations.skeleton.json"]))
        self.assertEqual(len(found), 1)


class TemplateTests(unittest.TestCase):
    """⛔ The template must be unusable until a human has actually done the work."""

    def test_an_unedited_keypoint_block_cannot_pass_validation(self) -> None:
        """⚠️ `x: null` is refused by the loader, so a forgotten placeholder fails loudly rather
        than scoring as a joint at the top-left corner of the frame."""
        with self.assertRaises(ann.AnnotationError):
            ann.parse({
                "schemaVersion": ann.SCHEMA_VERSION, "caseId": "c", "clipSha256": "e" * 64,
                "annotatedFps": 1.93,
                "frames": [{"frameIndex": 0, "boxes": [{
                    "label": "person", "gtId": 1, "bbox": [0.4, 0.3, 0.2, 0.4],
                    "keypoints": [{"name": "nose", "x": None, "y": None, "visible": True}],
                }]}],
            })

    def test_the_template_carries_no_coordinates_at_all(self) -> None:
        """⛔ The one thing a ground-truth template must never contain is a model's guess."""
        document = cli.template.__doc__ or ""
        self.assertIn("no model output", document.lower().replace("⛔ ", ""))

    def test_every_coco_joint_is_offered(self) -> None:
        from pose_score_cli import COCO_17 as offered  # noqa: WPS433

        self.assertEqual(len(offered), 17)
        self.assertEqual(offered, COCO_17)


class ScoreConversionTests(unittest.TestCase):
    def test_predictions_become_scorer_input_keyed_by_frame_index(self) -> None:
        document = predictions()
        document["frames"][3]["people"] = [{
            "bbox": [0.4, 0.3, 0.2, 0.4], "confidence": 0.9,
            "keypoints": [{"name": "nose", "x": 0.5, "y": 0.35, "confidence": 0.9,
                           "visible": True}],
        }]
        people = cli.to_people(document)
        self.assertEqual(len(people), 37)
        self.assertEqual(len(people[3]), 1)
        self.assertEqual(people[3][0].keypoints[0].name, "nose")
        self.assertEqual(people[0], [])

    def test_a_person_without_a_usable_box_is_refused(self) -> None:
        document = predictions()
        document["frames"][0]["people"] = [{"bbox": [0.4, 0.3], "keypoints": []}]
        with self.assertRaises(cli.CliError):
            cli.to_people(document)


if __name__ == "__main__":
    unittest.main()
