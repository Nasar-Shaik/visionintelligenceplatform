"""Declaring and verifying real footage — P3.2.

⛔ The load-bearing tests here are the ones that prove the tool **refuses**: it will not invent a
consent record, will not accept a scenario nothing reports, and will not call an unverified corpus
verified. A registration tool that is merely convenient will eventually be used to file a recording
of identifiable people with no lawful basis attached.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import benchmark_corpus as bc  # noqa: E402
import real_footage_cli as rf  # noqa: E402


def clip(contents: bytes = b"not really a video") -> str:
    directory = tempfile.mkdtemp()
    path = os.path.join(directory, "walk-01.mp4")
    with open(path, "wb") as handle:
        handle.write(contents)
    return path


class RegistrationTests(unittest.TestCase):
    def _entry(self, **kw):
        base = {
            "clip_id": "walk-01",
            "path": clip(),
            "file_name": "walk-01.mp4",
            "scenarios": ("normal-person",),
            "consent": "docs/validation/consent/2026-08-12.md",
            "device": "iPhone 13, tripod",
            "captured_at": "2026-08-12",
        }
        base.update(kw)
        return rf.entry_for(**base)

    def test_a_registered_clip_is_real_footage_and_loads_as_one(self) -> None:
        """⭐ The entry is not just a dict — it has to survive the corpus's own provenance guard."""
        entry = self._entry()
        case = bc.BenchmarkCase(
            case_id=entry["caseId"], path=entry["path"], category=entry["category"],
            footage_kind=entry["footageKind"], scenarios=tuple(entry["scenarios"]),
            sha256=entry["sha256"], capture=entry["capture"], consent=entry["consent"],
        )
        self.assertTrue(case.conclusive)

    def test_the_digest_is_of_the_bytes_on_disk(self) -> None:
        entry = self._entry()
        self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")

    def test_two_different_clips_do_not_share_a_digest(self) -> None:
        """⚠️ Proves the hash is of the file rather than of the name or a constant."""
        a = self._entry(path=clip(b"one"))
        b = self._entry(path=clip(b"two"))
        self.assertNotEqual(a["sha256"], b["sha256"])

    def test_an_unknown_scenario_claim_is_refused(self) -> None:
        """⛔ A scenario nothing reports would make the claim silent."""
        with self.assertRaises(bc.CorpusError):
            self._entry(scenarios=("shoplifting",))

    def test_ground_truth_is_never_declared_at_registration(self) -> None:
        """⛔ Annotations do not exist when a clip is filmed. Declaring a path to one would authorise
        precision and recall for a case nothing can score."""
        self.assertIsNone(self._entry()["groundTruth"])

    def test_the_capture_block_records_what_the_sampler_needs(self) -> None:
        """⚠️ The benchmark derives its stride from the clip's own frame rate."""
        self.assertIn("bytes", self._entry()["capture"])


class RefusalTests(unittest.TestCase):
    """⛔ Every required field, asserted one at a time — a tool that fills these in is the risk."""

    def _run(self, **overrides) -> int:
        args = {
            "--register": clip(),
            "--clip-id": "walk-01",
            "--scenarios": "normal-person",
            "--consent": "docs/validation/consent/2026-08-12.md",
            "--device": "iPhone 13",
            "--captured-at": "2026-08-12",
        }
        args.update(overrides)
        argv = []
        for flag, value in args.items():
            if value is not None:
                argv += [flag, value]
        return rf.main(argv)

    def test_registration_without_consent_is_refused(self) -> None:
        """⛔ **The one that matters.** Video of identifiable people is not declared on a label."""
        self.assertEqual(self._run(**{"--consent": None}), 2)

    def test_registration_without_a_clip_id_is_refused(self) -> None:
        self.assertEqual(self._run(**{"--clip-id": None}), 2)

    def test_registration_without_a_capture_date_is_refused(self) -> None:
        self.assertEqual(self._run(**{"--captured-at": None}), 2)

    def test_registration_without_a_device_is_refused(self) -> None:
        self.assertEqual(self._run(**{"--device": None}), 2)

    def test_registration_of_a_missing_file_is_refused(self) -> None:
        self.assertEqual(self._run(**{"--register": "/nonexistent.mp4"}), 2)

    def test_a_complete_registration_succeeds(self) -> None:
        """⚠️ The positive control. A tool that refused everything would pass every test above."""
        self.assertEqual(self._run(), 0)

    def test_nothing_is_written_without_an_explicit_write(self) -> None:
        """⭐ Registration prints the entry; committing it to the manifest is a separate decision."""
        directory = tempfile.mkdtemp()
        manifest = os.path.join(directory, "corpus.json")
        with open(manifest, "w", encoding="utf-8") as handle:
            json.dump({"version": "v", "cases": []}, handle)
        self._run(**{"--corpus": manifest})
        with open(manifest, "r", encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["cases"], [])


class VerificationTests(unittest.TestCase):
    def _corpus(self, manifest_cases, real_files=()) -> tuple:
        directory = tempfile.mkdtemp()
        real_root = tempfile.mkdtemp()
        manifest = os.path.join(directory, "corpus.json")
        with open(manifest, "w", encoding="utf-8") as handle:
            json.dump({"version": "v", "cases": manifest_cases}, handle)
        for name, contents in real_files:
            with open(os.path.join(real_root, name), "wb") as handle:
                handle.write(contents)
        return manifest, real_root

    def _declared(self, digest: str) -> dict:
        return {
            "caseId": "walk-01", "path": "walk-01.mp4", "category": "real",
            "footageKind": "REAL_FOOTAGE", "scenarios": ["normal-person"],
            "sha256": digest, "consent": "consent.md",
            "capture": {"device": "phone", "capturedAt": "2026-08-12"},
        }

    def test_an_empty_declaration_reports_that_nothing_was_checked(self) -> None:
        """⛔ **"Nothing failed" and "nothing was checked" are different claims.** Exit 0, but the
        message says no footage is declared — a green tick here would be the absence reading as
        health, which is how a corpus stays empty for a milestone."""
        manifest, real_root = self._corpus([{"caseId": "a", "path": "a.mp4", "footageKind": "AUTHORED"}])
        self.assertEqual(rf.main(["--corpus", manifest, "--real-root", real_root, "--verify"]), 0)

    def test_a_declared_clip_that_is_absent_fails(self) -> None:
        manifest, real_root = self._corpus([self._declared("a" * 64)])
        self.assertEqual(rf.main(["--corpus", manifest, "--real-root", real_root, "--verify"]), 1)

    def test_a_clip_whose_bytes_changed_fails(self) -> None:
        """⛔ Never repaired by re-declaring the digest: a measurement re-run against different
        pixels produces a plausible number that describes nothing."""
        manifest, real_root = self._corpus([self._declared("a" * 64)], [("walk-01.mp4", b"other")])
        self.assertEqual(rf.main(["--corpus", manifest, "--real-root", real_root, "--verify"]), 1)

    def test_a_matching_clip_verifies(self) -> None:
        """⚠️ The positive control — the check has to be able to pass."""
        import hashlib

        payload = b"the declared pixels"
        manifest, real_root = self._corpus(
            [self._declared(hashlib.sha256(payload).hexdigest())], [("walk-01.mp4", payload)]
        )
        self.assertEqual(rf.main(["--corpus", manifest, "--real-root", real_root, "--verify"]), 0)


class GapTests(unittest.TestCase):
    def test_the_gap_list_is_every_scenario_without_real_footage(self) -> None:
        corpus = bc.Corpus(version="v", cases=(bc.BenchmarkCase(
            case_id="a", path="a.mp4", category="motion", footage_kind="AUTHORED",
            scenarios=("normal-person",),
        ),))
        self.assertEqual(len(rf.gaps(corpus)), len(bc.SCENARIOS))

    def test_a_real_clip_removes_its_scenarios_from_the_gap(self) -> None:
        corpus = bc.Corpus(version="v", cases=(bc.BenchmarkCase(
            case_id="a", path="a.mp4", category="real", footage_kind="REAL_FOOTAGE",
            scenarios=("normal-person",), sha256="a" * 64, consent="c.md",
            capture={"device": "phone"},
        ),))
        self.assertNotIn("normal-person", rf.gaps(corpus))

    def test_the_gap_report_says_plainly_when_nothing_is_declared(self) -> None:
        corpus = bc.Corpus(version="v", cases=(bc.BenchmarkCase(
            case_id="a", path="a.mp4", category="motion", footage_kind="AUTHORED",
        ),))
        self.assertIn("No real footage is declared", rf.render_gap(corpus))


if __name__ == "__main__":
    unittest.main()


class FrameExtractionTests(unittest.TestCase):
    """⭐ The tool that makes annotation possible — and the rate it reports.

    ⛔ These do not need a video: `extract_frames` is exercised end to end by the container check in
    the slice report, while the arithmetic that decides WHICH frames get annotated is asserted here,
    because it is the arithmetic that silently misaligns every box when it is wrong.
    """

    def test_the_skeleton_carries_the_effective_rate_not_the_requested_one(self) -> None:
        """⛔ 15 fps asked for 2.0 is sampled at 1.875. An annotator who writes 2.0 is describing
        different instants, and `align()` will refuse the file they spent two hours on."""
        summary = {"effectiveFps": 1.875, "frames": [{"frameIndex": 0, "atSeconds": 0.0}]}
        doc = rf.annotation_skeleton(summary, case_id="take-01", clip_sha256=None)
        self.assertEqual(doc["annotatedFps"], 1.875)

    def test_every_sampled_frame_appears_in_the_skeleton(self) -> None:
        summary = {"effectiveFps": 2.0,
                   "frames": [{"frameIndex": i, "atSeconds": i / 2} for i in range(5)]}
        doc = rf.annotation_skeleton(summary, case_id="take-01", clip_sha256=None)
        self.assertEqual([f["frameIndex"] for f in doc["frames"]], [0, 1, 2, 3, 4])

    def test_the_skeleton_says_its_empty_frames_are_unconfirmed(self) -> None:
        """⛔ An empty frame is a CLAIM that nothing was there — it is what makes false positives
        measurable. A skeleton that passed off "not yet annotated" as "nothing here" would score
        every detection in those frames as a false positive."""
        doc = rf.annotation_skeleton({"effectiveFps": 2.0, "frames": []}, case_id="t", clip_sha256=None)
        self.assertIn("UNFILLED SKELETON", doc["note"])
        self.assertEqual(doc["annotator"], "")

    def test_the_skeleton_parses_as_a_valid_annotation_file(self) -> None:
        """⭐ It must be loadable the moment a human starts filling it in, not after a fix-up step."""
        import annotations as ann

        summary = {"effectiveFps": 1.875,
                   "frames": [{"frameIndex": i, "atSeconds": i * 0.533} for i in range(3)]}
        doc = rf.annotation_skeleton(summary, case_id="take-01", clip_sha256=None)
        parsed = ann.parse(doc)
        self.assertEqual(parsed.case_id, "take-01")
        self.assertIsNone(parsed.clip_sha256)
        self.assertEqual(parsed.box_count, 0)

    def test_a_digest_bound_skeleton_keeps_its_binding(self) -> None:
        doc = rf.annotation_skeleton(
            {"effectiveFps": 2.0, "frames": [{"frameIndex": 0, "atSeconds": 0.0}]},
            case_id="take-01", clip_sha256="a" * 64,
        )
        import annotations as ann

        self.assertEqual(ann.parse(doc).clip_sha256, "a" * 64)


class AnnotationValidatorTests(unittest.TestCase):
    """⛔ **The command a human runs before two hours of work is scored.**

    It computes no accuracy, changes nothing and repairs nothing. Every rule it applies is the one
    the scorer already applies — called, not restated, because a second implementation eventually
    disagrees with the first and the disagreement is discovered as an unexplained score.
    """

    DIGEST = "e" * 64

    def setUp(self) -> None:
        import annotations as ann

        self.dir = tempfile.mkdtemp()
        self.doc = {
            "schemaVersion": ann.SCHEMA_VERSION,
            "caseId": "take-01",
            "clipSha256": None,
            "annotatedFps": 2.0,
            "annotator": "nasar",
            "frames": [
                {"frameIndex": 0, "atSeconds": 0.0, "boxes": [
                    {"label": "person", "bbox": [0.1, 0.1, 0.2, 0.5], "gtId": 1,
                     "visibility": "fully-visible"}]},
                {"frameIndex": 1, "atSeconds": 0.5, "boxes": []},
            ],
        }

    def _write(self, doc=None) -> str:
        path = os.path.join(self.dir, "a.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(doc if doc is not None else self.doc, handle)
        return path

    def _corpus(self, **case) -> bc.Corpus:
        base = {"case_id": "take-01", "path": "take-01.mp4", "category": "motion",
                "footage_kind": "AUTHORED", "scenarios": ("normal-person",)}
        base.update(case)
        return bc.Corpus(version="v", cases=(bc.BenchmarkCase(**base),))

    # --- positive controls ---

    @staticmethod
    def _errors(problems):
        """⚠️ A "NOT CHECKED" line is a disclosure, not a defect — the CLI separates them the same
        way, and a positive control that counted notes as failures would test the wrong thing."""
        return [p for p in problems if not p.startswith("⚠️ NOT CHECKED")]

    def test_a_valid_file_passes(self) -> None:
        """⚠️ First, because a validator that refuses everything passes every negative test."""
        self.assertEqual(self._errors(rf.validate_annotations(self._write(), corpus=self._corpus())), [])

    def test_a_valid_file_with_keypoints_passes(self) -> None:
        self.doc["frames"][0]["boxes"][0]["keypoints"] = [
            {"name": "left_wrist", "x": 0.2, "y": 0.3, "visible": True},
            {"name": "right_wrist", "x": 0.3, "y": 0.3, "visible": False},
        ]
        self.assertEqual(self._errors(rf.validate_annotations(self._write(), corpus=self._corpus())), [])

    def test_the_cli_reports_pass_and_exits_zero(self) -> None:
        """⭐ The integration test: through `main`, as a human would run it."""
        corpus_path = os.path.join(self.dir, "corpus.json")
        with open(corpus_path, "w", encoding="utf-8") as handle:
            json.dump({"version": "v", "cases": [
                {"caseId": "take-01", "path": "take-01.mp4", "footageKind": "AUTHORED",
                 "scenarios": ["normal-person"]}]}, handle)
        code = rf.main([
            "--validate-annotations", self._write(), "--corpus", corpus_path, "--case", "take-01",
        ])
        self.assertEqual(code, 0)

    # --- refusals ---

    def test_a_missing_file_is_a_usage_error(self) -> None:
        self.assertEqual(rf.main(["--validate-annotations", "/nonexistent.json"]), 2)

    def test_a_malformed_file_fails(self) -> None:
        path = os.path.join(self.dir, "bad.json")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        self.assertEqual(rf.main(["--validate-annotations", path]), 1)

    def test_a_schema_failure_is_terminal_and_not_padded(self) -> None:
        """⚠️ One problem, not a list of speculative extras: nothing downstream can be checked
        against a file that did not parse."""
        self.doc["annotatedFps"] = 0
        problems = rf.validate_annotations(self._write(), corpus=self._corpus())
        self.assertEqual(len(problems), 1)

    def test_a_bad_bounding_box_fails(self) -> None:
        self.doc["frames"][0]["boxes"][0]["bbox"] = [100, 200, 50, 300]
        self.assertTrue(rf.validate_annotations(self._write(), corpus=self._corpus()))

    def test_a_bad_keypoint_fails(self) -> None:
        self.doc["frames"][0]["boxes"][0]["keypoints"] = [{"name": "left_hand", "x": 0.2, "y": 0.3, "visible": True}]
        self.assertTrue(rf.validate_annotations(self._write(), corpus=self._corpus()))

    def test_an_inconsistent_identity_fails(self) -> None:
        """⛔ One subject cannot be in two places in one frame."""
        self.doc["frames"][0]["boxes"].append(
            {"label": "person", "bbox": [0.5, 0.1, 0.2, 0.5], "gtId": 1})
        self.assertTrue(rf.validate_annotations(self._write(), corpus=self._corpus()))

    def test_a_digest_mismatch_fails(self) -> None:
        """⛔ The check that catches boxes drawn on different pixels."""
        self.doc["clipSha256"] = self.DIGEST
        problems = rf.validate_annotations(
            self._write(),
            corpus=self._corpus(footage_kind="REAL_FOOTAGE", sha256="f" * 64,
                                consent="c.md", capture={"device": "phone"}),
        )
        self.assertTrue(any("different pixels" in p for p in problems))

    def test_an_unknown_case_fails(self) -> None:
        self.doc["caseId"] = "not-a-case"
        self.assertTrue(rf.validate_annotations(self._write(), corpus=self._corpus()))

    def test_a_wrong_schema_version_fails(self) -> None:
        self.doc["schemaVersion"] = "tier1-2020-01-01"
        problems = rf.validate_annotations(self._write(), corpus=self._corpus())
        self.assertTrue(any("schemaVersion" in p for p in problems))

    # --- disclosure ---

    def test_unbound_validation_discloses_what_it_did_not_check(self) -> None:
        """⛔ A PASS that quietly skipped alignment is a weaker claim wearing the same word."""
        problems = rf.validate_annotations(self._write())
        self.assertTrue(any(p.startswith("⚠️ NOT CHECKED") for p in problems))

    def test_a_not_checked_note_does_not_fail_the_file(self) -> None:
        """⚠️ A disclosure is not a defect — it must be visible without turning PASS into FAIL."""
        self.assertEqual(rf.main(["--validate-annotations", self._write(), "--corpus", "/nonexistent"]), 0)

    def test_the_validator_never_modifies_the_file(self) -> None:
        """⛔ It must not silently repair anything."""
        path = self._write()
        with open(path, "rb") as handle:
            before = handle.read()
        rf.validate_annotations(path, corpus=self._corpus())
        with open(path, "rb") as handle:
            self.assertEqual(handle.read(), before)

    def test_the_validator_computes_no_accuracy(self) -> None:
        """⛔ Its entire output is problems. There is no path by which it emits a score."""
        problems = rf.validate_annotations(self._write(), corpus=self._corpus())
        self.assertTrue(all(isinstance(p, str) for p in problems))
        for word in ("precision", "recall", "f1", "iou"):
            self.assertFalse(any(word in p.lower() for p in problems))


class EntrypointTests(unittest.TestCase):
    """⛔ **The defect unit tests structurally cannot catch.**

    `_validate` was appended below `if __name__ == "__main__": raise SystemExit(main())`. Importing
    the module defines everything before anything runs, so every test here passed — while running
    the file as a script raised `NameError` on the first use. Found by executing the CLI in the
    built image, which is the only place the distinction exists.
    """

    def test_the_entrypoint_is_the_last_statement_in_the_file(self) -> None:
        import re

        source = open(os.path.join(os.path.dirname(__file__), "..", "real_footage_cli.py"),
                      encoding="utf-8").read().rstrip()
        guard = source.index('if __name__ == "__main__":')
        after = source[guard:]
        self.assertNotIn("\ndef ", after, "a function is defined after the __main__ guard")
        self.assertNotIn("\nclass ", after, "a class is defined after the __main__ guard")
        self.assertTrue(re.search(r"raise SystemExit\(main\(\)\)\s*$", source))
