"""The offline pose annotator — P3.3c.

⛔ **The load-bearing test is the freshness one.** A browser cannot import a Python tuple, so the
annotator necessarily carries a copy of the joint vocabulary. These tests make that copy *derived*:
if `COCO_17`, the skeleton edges, the schema version or the clip's metadata change and the checked-in
HTML is not regenerated, the suite fails. `"left_wrist"` versus `"leftWrist"` is the disagreement
that surfaces as a plausible, terrible accuracy score rather than as an error.

⛔ The rest assert what the tool must NOT be able to do: reach the network, or show the annotator
what the model thought.
"""

import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

#: tests/ → ai/inference/ → ai/ → the repository root.
REPO = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "tools", "annotator"))

import annotations as ann  # noqa: E402
import pose  # noqa: E402
from perception import COCO_17, DEFAULT_SKELETON  # noqa: E402

import build_annotator as build  # noqa: E402

HTML_PATH = os.path.join(REPO, "tools", "annotator", "pose-annotator.html")


def html() -> str:
    with open(HTML_PATH, "r", encoding="utf-8") as handle:
        return handle.read()


def code() -> str:
    """The generated file with its comments removed.

    ⚠️ Some assertions must be about what the tool *does*, not about what it explains. The page
    documents in prose that it never writes a `confidence` field; a naive substring check on the
    whole file would then fail because the rule is written down. Stripping comments keeps the
    assertion strict about behaviour without punishing the file for describing itself.
    """
    page = re.sub(r"<!--.*?-->", "", html(), flags=re.S)
    page = re.sub(r"/\*.*?\*/", "", page, flags=re.S)
    return re.sub(r"^\s*//.*$", "", page, flags=re.M)


def injected(name: str):
    """Read one injected constant back out of the generated file."""
    match = re.search(r"^const\s+" + name + r"\s*=\s*(.+?);\s*$", html(), re.M)
    if match is None:
        raise AssertionError(f"{name} is not declared in the generated annotator")
    return json.loads(match.group(1))


class FreshnessTests(unittest.TestCase):
    """⛔ The generated file must be what the current Python produces — byte for byte."""

    def test_the_checked_in_annotator_is_current(self) -> None:
        self.assertEqual(
            html(), build.render(),
            "tools/annotator/pose-annotator.html is stale. Run: "
            "python3 tools/annotator/build_annotator.py",
        )

    def test_the_check_flag_agrees(self) -> None:
        self.assertEqual(build.main(["--check"]), 0)


class VocabularyTests(unittest.TestCase):
    """⛔ One vocabulary, owned by Python. Not a second one that happens to match today."""

    def test_the_joint_names_are_exactly_coco_17_in_order(self) -> None:
        self.assertEqual(injected("COCO_17"), list(COCO_17))

    def test_the_skeleton_edges_are_the_runtimes_own(self) -> None:
        self.assertEqual(injected("EDGES"), [list(e) for e in pose.COCO_17_EDGES])

    def test_the_skeleton_name_matches_the_default_topology(self) -> None:
        self.assertEqual(injected("SKELETON"), DEFAULT_SKELETON)

    def test_the_schema_version_matches_the_parser(self) -> None:
        self.assertEqual(injected("SCHEMA_VERSION"), ann.SCHEMA_VERSION)

    def test_the_visibility_enum_matches_the_schema(self) -> None:
        self.assertEqual(injected("VISIBILITY"), list(ann.VISIBILITY))

    def test_there_is_no_hand_joint(self) -> None:
        """⚠️ An earlier draft of the instructions invented `left_hand`/`right_hand`. COCO annotates
        the wrist, and a tool offering a joint the topology lacks produces unscoreable work."""
        self.assertNotIn("left_hand", html())
        self.assertNotIn("right_hand", html())

    def test_the_torso_joints_the_scorer_needs_are_the_ones_warned_about(self) -> None:
        import pose_scoring as ps  # noqa: WPS433

        placed = injected("TORSO")
        self.assertEqual(sorted(placed),
                         sorted(["left_shoulder", "right_shoulder", "left_hip", "right_hip"]))
        # The scorer's torso normalizer reads shoulder + opposite hip; all four must be offered.
        self.assertEqual(ps.DEFAULT_NORMALIZER, "torso")


class ClipBindingTests(unittest.TestCase):
    """⛔ The file it writes must describe THESE pixels, at the rate they were sampled."""

    def test_the_case_and_digest_come_from_the_corpus(self) -> None:
        case = build._case()
        self.assertEqual(injected("CASE_ID"), case.case_id)
        self.assertEqual(injected("CLIP_SHA256"), case.sha256)

    def test_the_frame_size_comes_from_the_declared_capture(self) -> None:
        capture = dict(build._case().capture or {})
        self.assertEqual(injected("FRAME_W"), capture["width"])
        self.assertEqual(injected("FRAME_H"), capture["height"])

    def test_the_rate_is_the_measured_one_not_the_manifests_rounded_one(self) -> None:
        """⛔ The manifest stores fps rounded to 3dp; dividing that by the stride gives 1.928643
        where the frames were actually sampled at 1.928609. The annotator's file is what `align()`
        checks against the real pixels — round for reading, never for deciding."""
        self.assertEqual(injected("ANNOTATED_FPS"), 1.928609)

    def test_the_rate_matches_the_extraction_that_produced_the_frames(self) -> None:
        skeleton = os.path.join(REPO, ".data", "real", "movie101-frames",
                                "annotations.skeleton.json")
        if not os.path.isfile(skeleton):
            self.skipTest("the extraction artifact is not on this machine")
        with open(skeleton, "r", encoding="utf-8") as handle:
            self.assertEqual(injected("ANNOTATED_FPS"), json.load(handle)["annotatedFps"])


class NoNetworkTests(unittest.TestCase):
    """⛔ movie101 is consented footage of an identifiable person. The tool must be structurally
    incapable of sending it anywhere, not merely uninterested in doing so."""

    def test_no_request_issuing_api_appears_anywhere(self) -> None:
        for banned in ("fetch(", "XMLHttpRequest", "WebSocket", "navigator.sendBeacon",
                       "EventSource", "importScripts"):
            with self.subTest(api=banned):
                self.assertNotIn(banned, code())

    def test_no_absolute_url_appears_anywhere(self) -> None:
        self.assertNotIn("http://", html())
        self.assertNotIn("https://", html())

    def test_a_content_security_policy_forbids_outbound_connections(self) -> None:
        page = html()
        self.assertIn("Content-Security-Policy", page)
        self.assertIn("connect-src 'none'", page)
        self.assertIn("default-src 'none'", page)
        self.assertIn("form-action 'none'", page)

    def test_the_build_refuses_to_write_a_networked_file(self) -> None:
        """⚠️ The guard is on the generated artifact, not on the author's intent."""
        with open(build.__file__, "r", encoding="utf-8") as handle:
            self.assertIn("refusing to write it", handle.read())


class NoPredictionTests(unittest.TestCase):
    """⛔ Ground truth influenced by the thing it scores is not ground truth."""

    def test_the_annotator_never_mentions_the_model_output_file(self) -> None:
        page = html().lower()
        for banned in ("predictions.json", "rtmpose", "poseartifactsha256", "yolox"):
            with self.subTest(token=banned):
                self.assertNotIn(banned, page)

    def test_the_build_refuses_to_embed_predictions(self) -> None:
        with open(build.__file__, "r", encoding="utf-8") as handle:
            self.assertIn("predictions", handle.read(),
                          "the build should name 'predictions' only in its banned-token guard")


class ExportShapeTests(unittest.TestCase):
    """The document the tool writes must be the one the parser and scorer already read."""

    def test_the_exported_keys_are_the_schemas_own(self) -> None:
        page = html()
        for key in ("schemaVersion", "caseId", "clipSha256", "annotatedFps", "annotator",
                    "frameIndex", "atSeconds", "boxes", "label", "gtId", "bbox",
                    "visibility", "skeleton", "keypoints", "reviewStatus"):
            with self.subTest(key=key):
                self.assertIn(key, page)

    def test_no_confidence_field_is_ever_written(self) -> None:
        """⛔ Ground truth carries no confidence — the parser refuses the field outright, and a
        human number there would be compared against model confidence at scoring time."""
        self.assertNotIn("confidence", code())

    def test_gt_id_is_locked_to_one_subject(self) -> None:
        self.assertIn("const GT_ID = 1;", html())

    def test_the_three_review_states_are_declared(self) -> None:
        for status in ("UNREVIEWED", "EMPTY", "ANNOTATED"):
            with self.subTest(status=status):
                self.assertIn(status, html())

    def test_review_status_survives_the_parser_as_an_ignored_field(self) -> None:
        """⭐ `reviewStatus` is additive: the existing parser reads frameIndex/boxes/atSeconds and
        ignores the rest, so recording the human's decision costs the schema nothing."""
        parsed = ann.parse({
            "schemaVersion": ann.SCHEMA_VERSION, "caseId": "movie101",
            "clipSha256": "e" * 64, "annotatedFps": 1.928609,
            "frames": [{"frameIndex": 0, "atSeconds": 0.0, "reviewStatus": "EMPTY", "boxes": []}],
        })
        self.assertEqual(len(parsed.frames), 1)
        self.assertEqual(parsed.frames[0].boxes, ())


if __name__ == "__main__":
    unittest.main()
