"""The registered-model catalogue (P-8 Phase 3).

⚠️ These tests run against **the catalogue this platform actually ships**, not a fixture copy. A
typo in `models/registry.json` — a label list off by one, a malformed checksum, two models claiming
the same id — is a production defect that no amount of testing a hand-built dict would find.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from model_store import (  # noqa: E402
    DEFAULT_CATALOGUE,
    InputSpec,
    LocalModelResolver,
    ModelStore,
    ModelStoreError,
    RegisteredModel,
    sha256_file,
)
from selector import ModelSelector, SelectorUnresolved  # noqa: E402

_SELECTOR = ModelSelector(task="object-detection", family="*", version_range="", accelerators=("cpu",))


def _entry(**over):
    base = {
        "id": "m1",
        "name": "m1",
        "version": "1.0.0",
        "task": "object-detection",
        "family": "test",
        "engine": "onnx",
        "accelerators": ["cpu"],
        "capabilities": ["perception.person-detection"],
        "status": "enabled",
        "default": False,
        "artifact": "m1.onnx",
        "sha256": "0" * 64,
        "outputFormat": "yolox",
        "labels": ["person"],
        "input": {"width": 8, "height": 8},
    }
    base.update(over)
    return base


class ShippedCatalogueTests(unittest.TestCase):
    """The real file, loaded the real way."""

    def setUp(self):
        self.store = ModelStore.load(DEFAULT_CATALOGUE)

    def test_the_shipped_catalogue_parses_and_ids_are_unique(self):
        # ⚠️ ONE model is registered, deliberately (Architect direction: one production-quality path
        # before breadth). The *mechanism* for many is what is tested — see SelectionTests, which
        # drive multi-entry catalogues — so "supports many, deploys one" is a checked claim rather
        # than an aspiration.
        self.assertGreaterEqual(len(self.store), 1)
        ids = [m.id for m in self.store.all()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_registered_model_declares_a_licence_and_a_provenance(self):
        # ⚠️ Licence is a selection criterion, not documentation: the obvious detector (Ultralytics
        # YOLO) is AGPL-3.0 and unusable in a commercial product. An artifact with no recorded
        # licence is one nobody checked.
        #
        # ⭐ Provenance is "where did this byte sequence come from", and there are two honest
        # answers, not one. A downloaded artifact names an https source. An artifact VIP **exported
        # itself** — because the only official weights were PyTorch and the ready-made ONNX
        # conversion declared no licence — names the script that produced it and the upstream model
        # it was produced from. The second is the stronger claim, so the test accepts it while
        # requiring that the script actually exists: a reproduction recipe pointing at a deleted
        # file is a provenance nobody can follow.
        import json
        import os

        with open(DEFAULT_CATALOGUE, encoding="utf-8") as handle:
            raw = {entry["id"]: entry for entry in json.load(handle)["models"]}
        repo_root = os.path.join(os.path.dirname(os.path.abspath(DEFAULT_CATALOGUE)), "..", "..", "..")

        for model in self.store.all():
            self.assertTrue(model.license, f"{model.id} has no licence")
            self.assertGreater(model.size_bytes, 0, f"{model.id} declares no size")
            entry = raw[model.id]
            if model.source.startswith("https://"):
                continue
            exported_by = entry.get("exportedBy")
            self.assertTrue(
                exported_by and entry.get("sourceModel"),
                f"{model.id} has neither an https source nor an exportedBy + sourceModel provenance",
            )
            self.assertTrue(
                os.path.isfile(os.path.join(repo_root, exported_by)),
                f"{model.id} names an export script that does not exist: {exported_by}",
            )

    def test_label_lists_are_indexed_by_the_class_id_the_model_emits(self):
        """The one label convention.

        ⚠️ The catalogue's `labels` list is indexed by whatever id the model emits — YOLOX is
        0-based, so `person` is index 0. A 1-based map (the TF label space, measured during this
        phase) carries an empty placeholder at index 0 instead, and no code rebases anything. The
        first draft of the decoder tried to normalise ids and produced an expression that was wrong
        for every input; the fix was to delete the idea.
        """
        yolox = self.store.get("yolox-nano")
        assert yolox is not None
        self.assertEqual(yolox.labels[0], "person")
        self.assertEqual(yolox.labels[2], "car")
        self.assertEqual(len(yolox.labels), 80)

    def test_exactly_one_model_is_the_default(self):
        defaults = [m.id for m in self.store.all() if m.default and m.enabled]
        self.assertEqual(len(defaults), 1, f"expected one default, got {defaults}")

    def test_every_declared_output_format_matches_a_decoder_name(self):
        # The decoders themselves need numpy, so this checks the *names* — the catalogue may not
        # reference a format the runtime has never heard of. Kept in step with
        # `model_formats.available_decoders()`, which asserts the same set from the other side.
        known = {"yolox", "rtdetr", "yolo11"}
        for model in self.store.all():
            self.assertIn(model.output_format, known, f"{model.id} declares an unknown outputFormat")

    def test_the_capability_manifest_can_be_served(self):
        # The shipped manifest's selector must actually resolve against the shipped catalogue —
        # otherwise the runtime starts, fails to load, and reports FAILED in production.
        model = self.store.select(_SELECTOR, capability_id="perception.person-detection")
        self.assertEqual(model.id, "yolox-nano")


class SelectionTests(unittest.TestCase):
    def store(self, *entries):
        return ModelStore([RegisteredModel.from_dict(e) for e in entries], artifact_dir="/nonexistent")

    def test_the_default_wins_over_a_higher_version(self):
        store = self.store(
            _entry(id="chosen", version="1.0.0", default=True),
            _entry(id="newer", version="9.0.0", artifact="m2.onnx"),
        )
        self.assertEqual(store.select(_SELECTOR).id, "chosen")

    def test_an_explicit_preference_wins_over_the_default(self):
        store = self.store(
            _entry(id="chosen", default=True),
            _entry(id="override", artifact="m2.onnx"),
        )
        self.assertEqual(store.select(_SELECTOR, preferred_id="override").id, "override")

    def test_a_preference_that_serves_no_such_capability_is_refused_not_ignored(self):
        # ⚠️ Fail loudly. Falling back to the default when an operator names a model would run
        # something nobody chose and report success.
        store = self.store(_entry(id="chosen", default=True))
        with self.assertRaises(SelectorUnresolved) as caught:
            store.select(_SELECTOR, preferred_id="not-registered")
        self.assertIn("not-registered", str(caught.exception))

    def test_highest_version_only_when_nothing_is_marked_default(self):
        store = self.store(
            _entry(id="old", version="1.2.0"),
            _entry(id="new", version="1.10.0", artifact="m2.onnx"),
        )
        self.assertEqual(store.select(_SELECTOR).id, "new", "1.10 > 1.2 — not a string compare")

    def test_a_disabled_model_is_never_selected(self):
        store = self.store(_entry(id="off", status="disabled", default=True))
        with self.assertRaises(SelectorUnresolved):
            store.select(_SELECTOR)

    def test_a_model_that_does_not_serve_the_capability_is_never_selected(self):
        store = self.store(_entry(id="other", capabilities=["perception.fire"], default=True))
        with self.assertRaises(SelectorUnresolved) as caught:
            store.select(_SELECTOR, capability_id="perception.person-detection")
        self.assertIn("perception.person-detection", str(caught.exception))

    def test_the_refusal_names_what_is_in_the_catalogue(self):
        # An operator reading "no model found" learns nothing; reading which models exist is the
        # difference between a five-minute fix and a support ticket.
        store = self.store(_entry(id="only-this-one"))
        with self.assertRaises(SelectorUnresolved) as caught:
            store.select(ModelSelector(task="segmentation"))
        self.assertIn("only-this-one", str(caught.exception))

    def test_two_models_may_not_share_an_id(self):
        with self.assertRaises(ModelStoreError):
            self.store(_entry(id="dup"), _entry(id="dup", artifact="m2.onnx"))


class IntegrityTests(unittest.TestCase):
    def test_a_missing_artifact_names_the_path_and_the_remedy(self):
        store = ModelStore([RegisteredModel.from_dict(_entry())], artifact_dir="/nonexistent")
        with self.assertRaises(ModelStoreError) as caught:
            store.verify(store.all()[0])
        self.assertIn("/nonexistent/m1.onnx", str(caught.exception))
        self.assertIn("fetch_models", str(caught.exception))

    def test_an_artifact_that_is_present_but_not_the_registered_one_is_refused(self):
        """⚠️ The whole point of the checksum. 'A file is there' and 'the file we registered is
        there' are different questions, and a truncated download answers the first one."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "m1.onnx")
            with open(path, "wb") as handle:
                handle.write(b"not a model")
            store = ModelStore([RegisteredModel.from_dict(_entry())], artifact_dir=tmp)
            with self.assertRaises(ModelStoreError) as caught:
                store.verify(store.all()[0])
            self.assertIn("checksum mismatch", str(caught.exception))

    def test_a_matching_artifact_verifies_and_returns_its_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "m1.onnx")
            with open(path, "wb") as handle:
                handle.write(b"pretend model bytes")
            digest = sha256_file(path)
            store = ModelStore([RegisteredModel.from_dict(_entry(sha256=digest))], artifact_dir=tmp)
            self.assertEqual(store.verify(store.all()[0]), path)


class MalformedEntryTests(unittest.TestCase):
    def assert_rejected(self, **over):
        with self.assertRaises(ModelStoreError):
            RegisteredModel.from_dict(_entry(**over))

    def test_a_malformed_checksum_is_rejected_at_load_not_at_first_frame(self):
        self.assert_rejected(sha256="deadbeef")
        self.assert_rejected(sha256="z" * 64)

    def test_missing_required_fields_are_rejected(self):
        for field in ("id", "version", "task", "artifact", "outputFormat"):
            with self.subTest(field=field):
                self.assert_rejected(**{field: ""})

    def test_an_entry_without_an_input_spec_or_labels_is_rejected(self):
        self.assert_rejected(input=None)
        self.assert_rejected(labels=[])

    def test_unsupported_input_specs_are_rejected_by_name(self):
        for bad in (
            {"width": 8, "height": 8, "layout": "NHW"},
            {"width": 8, "height": 8, "dtype": "float16"},
            {"width": 8, "height": 8, "colorOrder": "YUV"},
            {"width": 8, "height": 8, "resize": "crop"},
            {"width": 0, "height": 8},
            {"width": 8, "height": 8, "std": [1, 0, 1]},
        ):
            with self.subTest(spec=bad):
                self.assert_rejected(input=bad)

    def test_a_catalogue_that_declares_no_models_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "registry.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"models": []}, handle)
            with self.assertRaises(ModelStoreError):
                ModelStore.load(path)

    def test_a_missing_or_unparseable_catalogue_is_rejected_with_its_path(self):
        with self.assertRaises(ModelStoreError) as caught:
            ModelStore.load("/nonexistent/registry.json")
        self.assertIn("/nonexistent/registry.json", str(caught.exception))


class DescriptorTests(unittest.TestCase):
    def test_a_descriptor_never_leaks_the_filesystem_or_the_source_url(self):
        # ⚠️ The runtime dashboard renders this. A status page is not a place to publish where the
        # artifacts live or which third-party URL the build reached out to.
        model = RegisteredModel.from_dict(_entry(source="https://example.test/secret/path.onnx"))
        rendered = json.dumps(model.descriptor(artifact_dir="/opt/vip/models"))
        self.assertNotIn("/opt/vip/models", rendered)
        self.assertNotIn("example.test", rendered)
        self.assertIn("sha256:", rendered)

    def test_a_descriptor_reports_whether_the_artifact_is_actually_there(self):
        model = RegisteredModel.from_dict(_entry())
        self.assertFalse(model.descriptor(artifact_dir="/nonexistent")["artifactPresent"])


class LocalResolverTests(unittest.TestCase):
    def test_the_ref_carries_everything_the_adapter_needs_and_nothing_it_must_infer(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "m1.onnx")
            with open(path, "wb") as handle:
                handle.write(b"pretend model bytes")
            store = ModelStore(
                [RegisteredModel.from_dict(_entry(sha256=sha256_file(path), default=True))],
                artifact_dir=tmp,
            )
            binding, ref = LocalModelResolver(
                store, capability_id="perception.person-detection"
            ).resolve(_SELECTOR)

            self.assertEqual(binding.id, "m1")
            self.assertEqual(binding.family, "test")
            self.assertEqual(binding.to_dict()["id"], "m1")
            self.assertEqual(ref["onnx_path"], path)
            self.assertEqual(ref["outputFormat"], "yolox")
            self.assertIsInstance(ref["input"], InputSpec)
            self.assertEqual(ref["labels"], ["person"])

    def test_resolution_fails_closed_when_the_artifact_is_absent(self):
        # A capability that cannot verify its model must reach FAILED, not READY-with-no-model.
        store = ModelStore([RegisteredModel.from_dict(_entry())], artifact_dir="/nonexistent")
        with self.assertRaises(ModelStoreError):
            LocalModelResolver(store).resolve(_SELECTOR)


if __name__ == "__main__":
    unittest.main()
