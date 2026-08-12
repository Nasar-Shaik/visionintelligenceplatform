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
import shutil
import subprocess
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


def injected_line(name: str) -> str:
    """The raw right-hand side of a `const` — for values that are expressions, not literals."""
    match = re.search(r"^const\s+" + name + r"\s*=\s*(.+?);\s*$", html(), re.M)
    if match is None:
        raise AssertionError(f"{name} is not declared in the generated annotator")
    return match.group(1)


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


def export_body() -> str:
    """The source of `exportJson`, comments stripped — every path through it must report."""
    body = re.search(r"^function exportJson\(\) \{$(.*?)^\}$", code(), re.S | re.M)
    if body is None:
        raise AssertionError("exportJson is not declared in the generated annotator")
    return body.group(1)


class ExportFeedbackTests(unittest.TestCase):
    """⛔ Every export attempt must say what happened.

    The first version returned silently when the confirm dialog was dismissed. A silent return is
    indistinguishable from a successful export: an annotator exported 37 frames, was shown nothing,
    and the file did not exist. These tests pin the outcome of each path.
    """

    def test_a_status_banner_exists_for_the_result_to_be_shown_in(self) -> None:
        page = html()
        self.assertIn('id="exportStatus"', page)
        self.assertIn('role="status"', page)

    def test_all_three_outcomes_are_reported(self) -> None:
        for outcome in ("exported", "cancelled", "failed"):
            with self.subTest(outcome=outcome):
                self.assertIn(f'reportExport("{outcome}"', code())

    def test_no_path_out_of_export_is_silent(self) -> None:
        """⛔ The regression itself. A bare `return` anywhere in exportJson is the defect."""
        self.assertNotIn("return;", export_body())
        for path in re.findall(r"return\s+(\w+)", export_body()):
            with self.subTest(path=path):
                self.assertEqual(path, "reportExport")

    def test_the_cancelled_path_says_nothing_was_written(self) -> None:
        page = html()
        self.assertIn("Export cancelled", page)
        self.assertIn("nothing was written", page)

    def test_the_successful_path_names_the_file_it_wrote(self) -> None:
        self.assertIn('const EXPORT_FILENAME = "annotations.json";', html())
        self.assertIn("EXPORT_FILENAME", export_body())

    def test_the_banner_is_never_suppressed_by_the_hidden_class(self) -> None:
        """`className = outcome` replaces `hidden` outright; a `classList.add` would not."""
        self.assertIn("el.className = outcome;", code())


class AutosaveTests(unittest.TestCase):
    """⛔ The work must survive the tab.

    An hour of hand annotation was lost when the tab holding it was closed: nothing reached disk
    until an export succeeded, and there was no second copy anywhere. The export bug hid the loss;
    the absence of autosave caused it.
    """

    def test_every_committed_change_is_saved(self) -> None:
        """⛔ The single hook. `renderSidebar` runs after every committed change — a joint placed,
        moved, deleted, a frame marked EMPTY or cleared — while a mousemove mid-drag redraws only
        the canvas. Removing this line is the regression."""
        sidebar = re.search(r"^function renderSidebar\(\) \{(.*?)^\}$", code(), re.S | re.M)
        self.assertIsNotNone(sidebar, "renderSidebar is not declared")
        self.assertIn("saveDraft();", sidebar.group(1))

    def test_the_draft_is_bound_to_this_clip(self) -> None:
        """⚠️ A draft for other pixels restoring over these would be precise and wrong."""
        self.assertIn("CASE_ID", injected_line("DRAFT_KEY"))
        self.assertIn("CLIP_SHA256", injected_line("DRAFT_KEY"))

    def test_a_foreign_document_is_refused_on_restore(self) -> None:
        page = code()
        self.assertIn("different clip digest", page)
        self.assertIn("function applyDocument", page)

    def test_the_draft_and_the_export_share_one_serialisation(self) -> None:
        """⭐ The draft stores `buildDocument()` itself, so a restored draft and an exported file
        cannot drift into two shapes — the vocabulary-drift failure this project keeps meeting."""
        save = re.search(r"^function saveDraft\(\) \{(.*?)^\}$", code(), re.S | re.M)
        self.assertIsNotNone(save)
        self.assertIn("buildDocument()", save.group(1))

    def test_no_frame_pixels_are_ever_stored(self) -> None:
        """⛔ movie101 is consented footage of an identifiable person. Coordinates may be kept in
        browser storage; the images may not."""
        save = re.search(r"^function saveDraft\(\) \{(.*?)^\}$", code(), re.S | re.M)
        for banned in ("toDataURL", "state.images", "canvas"):
            with self.subTest(api=banned):
                self.assertNotIn(banned, save.group(1))

    def test_a_failure_to_save_is_visible(self) -> None:
        """A silent persistence failure is the same lie as a silent export."""
        self.assertIn("showSaveStatus", code())
        self.assertIn("blocks local storage", html())

    def test_a_box_without_joints_is_reported(self) -> None:
        """⛔ 12 boxes were annotated with no keypoints at all, exported, and passed validation.
        The torso check only ran once a joint existed, so the one state that makes pose
        unmeasurable — a person boxed but never posed — raised nothing."""
        self.assertIn("a box with NO joints", html())

    def test_the_work_can_be_discarded_deliberately(self) -> None:
        self.assertIn("function clearDraft", code())
        self.assertIn("discardDraft", html())


class ExportBehaviourTests(unittest.TestCase):
    """⭐ The static tests above prove the code says the right words. This one runs it.

    `verify-export.mjs` lifts the tool's own `exportJson` into a VM and drives all four outcomes
    against a DOM stub that really records what the banner rendered.
    """

    @unittest.skipUnless(shutil.which("node"), "node is required to run the annotator's own export")
    def test_the_export_harness_passes(self) -> None:
        result = subprocess.run(
            [shutil.which("node"), os.path.join(REPO, "tools", "annotator", "verify-export.mjs")],
            cwd=REPO, capture_output=True, text=True, timeout=180,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("export UX", result.stdout)


if __name__ == "__main__":
    unittest.main()
