"""Detector plugin verification — RT-DETR and YOLO11 through the same seam as YOLOX (P-10 A2).

⚠️ **numpy is an integration-only dependency, so these SKIP locally and RUN in the deployed image.**
The verification script asserts they were not skipped: a test that quietly skips in the one
environment that matters reports green while checking nothing.

### What this file is for

The decoders were verified end-to-end against **real artifacts** — RT-DETR and YOLOX put their boxes
in the same place to a mean IoU of **0.95** over the same 40 frames, which is a stronger check on the
coordinate transform than any synthetic tensor. What that measurement cannot do is fail *loudly* when
someone edits a decoder, and it cannot run without an 81 MB artifact.

So these tests hold the arithmetic in place, and every one of them is written against a failure that
**returns detections rather than raising** — the only kind that reaches production.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from model_store import InputSpec  # noqa: E402

try:  # pragma: no cover - the import IS the condition
    import numpy as np  # type: ignore

    from adapters import model_formats  # noqa: E402
    from adapters.model_formats import Geometry  # noqa: E402

    HAVE_NUMPY = True
except ImportError:  # pragma: no cover
    HAVE_NUMPY = False

requires_numpy = unittest.skipUnless(HAVE_NUMPY, "numpy/pillow are integration-only dependencies")

RTDETR_SPEC = {
    "width": 640, "height": 640, "layout": "NCHW", "dtype": "float32", "colorOrder": "RGB",
    "resize": "stretch", "padValue": 0, "scale": 0.00392156862745098,
}
YOLO11_SPEC = {
    "width": 640, "height": 640, "layout": "NCHW", "dtype": "float32", "colorOrder": "RGB",
    "resize": "letterbox", "padValue": 114, "scale": 0.00392156862745098,
}


def _logit(p: float) -> float:
    """Inverse sigmoid — RT-DETR emits raw logits, so a test fixture must too."""
    import math

    return math.log(p / (1.0 - p))


@requires_numpy
class RtDetrLayoutTests(unittest.TestCase):
    """The tensor contract: two outputs, identified by shape rather than by position."""

    def setUp(self) -> None:
        self.spec = InputSpec.from_dict(RTDETR_SPEC)
        self.geometry = Geometry("stretch", 1.0, 0.0, 0.0, 640, 640, 1280, 720)

    def _outputs(self, queries=3, classes=80):
        logits = np.full((1, queries, classes), _logit(0.01), dtype=np.float32)
        boxes = np.zeros((1, queries, 4), dtype=np.float32)
        return logits, boxes

    def test_a_centred_box_decodes_to_the_centre_of_the_frame(self):
        logits, boxes = self._outputs()
        logits[0, 0, 0] = _logit(0.9)
        boxes[0, 0] = [0.5, 0.5, 0.25, 0.5]  # cx, cy, w, h — normalized to the input

        detections = model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {})

        x, y, w, h = detections[0].bbox
        self.assertAlmostEqual(x, 0.375, places=4)
        self.assertAlmostEqual(y, 0.25, places=4)
        self.assertAlmostEqual(w, 0.25, places=4)
        self.assertAlmostEqual(h, 0.5, places=4)
        self.assertEqual(detections[0].class_id, 0)

    def test_outputs_are_identified_by_shape_so_export_order_cannot_silently_swap_them(self):
        """⛔ Reading pred_boxes as logits yields 300 fictional detections of the right shape."""
        logits, boxes = self._outputs()
        logits[0, 0, 0] = _logit(0.9)
        boxes[0, 0] = [0.5, 0.5, 0.25, 0.5]

        forward = model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {})
        reversed_order = model_formats.decode_rtdetr([boxes, logits], self.spec, self.geometry, {})

        self.assertEqual(len(forward), len(reversed_order))
        self.assertEqual(forward[0].bbox, reversed_order[0].bbox)

    def test_ambiguous_output_shapes_raise_rather_than_guess(self):
        four = np.zeros((1, 3, 4), dtype=np.float32)
        with self.assertRaises(ValueError):
            model_formats.decode_rtdetr([four, four], self.spec, self.geometry, {})

    def test_a_class_count_that_disagrees_with_the_catalogue_is_an_error(self):
        logits, boxes = self._outputs(classes=80)
        with self.assertRaises(ValueError) as caught:
            model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {"numClasses": 91})
        self.assertIn("class-count", str(caught.exception))

    def test_a_query_count_mismatch_is_an_error(self):
        logits = np.zeros((1, 300, 80), dtype=np.float32)
        boxes = np.zeros((1, 299, 4), dtype=np.float32)
        with self.assertRaises(ValueError):
            model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {})

    def test_one_tensor_is_not_enough(self):
        with self.assertRaises(ValueError):
            model_formats.decode_rtdetr([np.zeros((1, 300, 80), dtype=np.float32)], self.spec, self.geometry, {})


@requires_numpy
class RtDetrScoringTests(unittest.TestCase):
    def setUp(self) -> None:
        self.spec = InputSpec.from_dict(RTDETR_SPEC)
        self.geometry = Geometry("stretch", 1.0, 0.0, 0.0, 640, 640, 1280, 720)

    def _ambiguous_query(self):
        """Query 0 scores two classes highly; the rest are noise.

        ⚠️ Four queries, not one: the result cap defaults to the **query count**, matching the
        official post-process (`topk(scores.flatten(), num_queries)`). A single-query fixture can
        only ever return one row, and would fail these tests for a reason that has nothing to do
        with what they assert.
        """
        logits = np.full((1, 4, 80), _logit(0.001), dtype=np.float32)
        logits[0, 0, 0] = _logit(0.9)
        logits[0, 0, 5] = _logit(0.8)
        boxes = np.zeros((1, 4, 4), dtype=np.float32)
        boxes[:, :, :] = [0.5, 0.5, 0.2, 0.2]
        return logits, boxes

    def test_scores_are_sigmoid_not_softmax(self):
        """⚠️ Softmax would make these sum to 1 and report ~0.5 for a class the model scored 0.9."""
        logits, boxes = self._ambiguous_query()

        detections = model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {})

        self.assertAlmostEqual(detections[0].score, 0.9, places=4)
        self.assertAlmostEqual(detections[1].score, 0.8, places=4)

    def test_one_query_may_be_reported_under_two_classes(self):
        """Independent per-class logits — the official post-process ranks over query × class."""
        logits, boxes = self._ambiguous_query()

        detections = model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {})

        self.assertEqual([d.class_id for d in detections[:2]], [0, 5])
        self.assertEqual(detections[0].bbox, detections[1].bbox)

    def test_the_result_cap_defaults_to_the_query_count_like_the_official_postprocess(self):
        """⚠️ Subtle and load-bearing: k is the number of *queries* (300), not queries × classes.
        A larger k would report every query under several classes; a smaller one truncates real
        detections. Pinned here because nothing else in the system would notice a change."""
        logits = np.full((1, 6, 80), _logit(0.7), dtype=np.float32)
        boxes = np.zeros((1, 6, 4), dtype=np.float32)
        boxes[:, :, 2:] = 0.1

        detections = model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {})

        self.assertEqual(len(detections), 6)

    def test_the_confidence_floor_removes_everything_below_it(self):
        logits = np.full((1, 4, 80), _logit(0.01), dtype=np.float32)
        logits[0, 0, 0] = _logit(0.9)
        logits[0, 1, 0] = _logit(0.2)
        boxes = np.zeros((1, 4, 4), dtype=np.float32)
        boxes[:, :, 2:] = 0.1

        strict = model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {"scoreFloor": 0.5})
        loose = model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {"scoreFloor": 0.1})

        self.assertEqual(len(strict), 1)
        self.assertEqual(len(loose), 2)

    def test_results_arrive_highest_confidence_first(self):
        logits = np.full((1, 3, 80), _logit(0.01), dtype=np.float32)
        for query, score in enumerate((0.4, 0.95, 0.7)):
            logits[0, query, 0] = _logit(score)
        boxes = np.zeros((1, 3, 4), dtype=np.float32)
        boxes[:, :, 2:] = 0.1

        scores = [d.score for d in model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {})]

        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_max_detections_caps_the_result_set(self):
        logits = np.full((1, 10, 80), _logit(0.6), dtype=np.float32)
        boxes = np.zeros((1, 10, 4), dtype=np.float32)
        boxes[:, :, 2:] = 0.1

        detections = model_formats.decode_rtdetr(
            [logits, boxes], self.spec, self.geometry, {"maxDetections": 5}
        )

        self.assertEqual(len(detections), 5)

    def test_no_suppression_is_applied_because_the_head_does_not_need_it(self):
        """⛔ RT-DETR is a set predictor. NMS here would merge two genuinely adjacent people."""
        logits = np.full((1, 2, 80), _logit(0.01), dtype=np.float32)
        logits[0, 0, 0] = _logit(0.9)
        logits[0, 1, 0] = _logit(0.88)
        boxes = np.array([[[0.5, 0.5, 0.3, 0.6], [0.52, 0.5, 0.3, 0.6]]], dtype=np.float32)

        detections = model_formats.decode_rtdetr([logits, boxes], self.spec, self.geometry, {})

        self.assertEqual(len(detections), 2, "heavily overlapping queries must both survive")


@requires_numpy
class Yolo11LayoutTests(unittest.TestCase):
    """The two traps that produce output instead of an error."""

    def setUp(self) -> None:
        self.spec = InputSpec.from_dict(YOLO11_SPEC)
        self.geometry = Geometry("letterbox", 0.5, 0.0, 140.0, 640, 640, 1280, 720)

    def _tensor(self, anchors=6, classes=80):
        """`[1, 4 + classes, anchors]` — channels-first, boxes in input pixels, no objectness."""
        return np.zeros((1, 4 + classes, anchors), dtype=np.float32)

    def test_a_box_decodes_through_the_letterbox_onto_the_original_frame(self):
        tensor = self._tensor()
        tensor[0, 0:4, 0] = [320.0, 320.0, 64.0, 128.0]  # cx, cy, w, h in input pixels
        tensor[0, 4, 0] = 0.9

        detections = model_formats.decode_yolo11([tensor], self.spec, self.geometry, {})

        x, y, w, h = detections[0].bbox
        self.assertAlmostEqual(w, 128.0 / 1280.0, places=4)
        self.assertAlmostEqual(x, (320.0 - 32.0) / 0.5 / 1280.0, places=4)
        self.assertAlmostEqual(y, ((320.0 - 64.0) - 140.0) / 0.5 / 720.0, places=4)

    def test_reading_it_the_yolox_way_is_caught_by_the_declared_class_count(self):
        """⛔ The transposed read returns 84 confident detections and raises nothing on its own."""
        tensor = self._tensor()
        tensor[0, 4, 0] = 0.9

        with self.assertRaises(ValueError) as caught:
            model_formats.decode_yolo11([tensor], self.spec, self.geometry,
                                        {"layout": "channels-last", "numClasses": 80})

        self.assertIn("class-count", str(caught.exception))

    def test_there_is_no_objectness_column_so_the_class_score_is_the_confidence(self):
        """⚠️ Multiplying by column 4 would consume `cx` — a box centre — as a probability."""
        tensor = self._tensor()
        tensor[0, 0:4, 0] = [500.0, 320.0, 40.0, 80.0]
        tensor[0, 4, 0] = 0.75

        detections = model_formats.decode_yolo11([tensor], self.spec, self.geometry, {})

        self.assertAlmostEqual(detections[0].score, 0.75, places=5)

    def test_the_highest_scoring_class_wins_the_anchor(self):
        tensor = self._tensor()
        tensor[0, 0:4, 0] = [320.0, 320.0, 40.0, 40.0]
        tensor[0, 4, 0] = 0.30
        tensor[0, 4 + 7, 0] = 0.81  # class 7 — 'truck' in COCO-80

        detections = model_formats.decode_yolo11([tensor], self.spec, self.geometry, {})

        self.assertEqual(detections[0].class_id, 7)
        self.assertAlmostEqual(detections[0].score, 0.81, places=5)

    def test_duplicates_of_the_same_object_collapse(self):
        tensor = self._tensor()
        for anchor, score in ((0, 0.9), (1, 0.85), (2, 0.8)):
            tensor[0, 0:4, anchor] = [320.0 + anchor, 320.0, 100.0, 200.0]
            tensor[0, 4, anchor] = score

        detections = model_formats.decode_yolo11([tensor], self.spec, self.geometry, {})

        self.assertEqual(len(detections), 1)
        self.assertAlmostEqual(detections[0].score, 0.9, places=5)

    def test_suppression_is_per_class_so_a_person_in_front_of_a_car_survives(self):
        tensor = self._tensor()
        tensor[0, 0:4, 0] = [320.0, 320.0, 100.0, 200.0]
        tensor[0, 4, 0] = 0.9  # person
        tensor[0, 0:4, 1] = [322.0, 320.0, 100.0, 200.0]
        tensor[0, 4 + 2, 1] = 0.88  # car, almost exactly on top

        detections = model_formats.decode_yolo11([tensor], self.spec, self.geometry, {})

        self.assertEqual(sorted(d.class_id for d in detections), [0, 2])

    def test_the_confidence_floor_removes_everything_below_it(self):
        tensor = self._tensor()
        tensor[0, 0:4, 0] = [320.0, 320.0, 40.0, 40.0]
        tensor[0, 4, 0] = 0.9
        tensor[0, 0:4, 1] = [100.0, 100.0, 40.0, 40.0]
        tensor[0, 4, 1] = 0.2

        strict = model_formats.decode_yolo11([tensor], self.spec, self.geometry, {"scoreFloor": 0.5})
        loose = model_formats.decode_yolo11([tensor], self.spec, self.geometry, {"scoreFloor": 0.1})

        self.assertEqual((len(strict), len(loose)), (1, 2))

    def test_an_empty_frame_produces_nothing(self):
        self.assertEqual(
            model_formats.decode_yolo11([self._tensor()], self.spec, self.geometry, {"scoreFloor": 0.05}),
            [],
        )


@requires_numpy
class PreprocessingParityTests(unittest.TestCase):
    """Each detector's declared spec must produce the tensor that detector was trained on."""

    def _jpeg(self, width, height, colour=(120, 90, 60)):
        import io

        from PIL import Image  # type: ignore

        buffer = io.BytesIO()
        Image.new("RGB", (width, height), colour).save(buffer, format="JPEG", quality=95)
        return buffer.getvalue()

    def test_rtdetr_stretches_to_640_without_padding(self):
        """⚠️ `do_pad: false` in the model's own processor config — a letterbox would pad with
        grey the model never saw in training."""
        tensor, geometry = model_formats.preprocess(self._jpeg(1280, 720), InputSpec.from_dict(RTDETR_SPEC))

        self.assertEqual(tensor.shape, (1, 3, 640, 640))
        self.assertEqual(geometry.mode, "stretch")

    def test_rtdetr_rescales_to_zero_one_and_does_not_normalise(self):
        """⛔ The model's config lists ImageNet mean/std but sets `do_normalize: false`. Applying
        them produces a model that still detects, slightly worse, with nothing failing."""
        tensor, _ = model_formats.preprocess(self._jpeg(64, 64, (255, 255, 255)), InputSpec.from_dict(RTDETR_SPEC))

        self.assertAlmostEqual(float(tensor.max()), 1.0, places=3)
        self.assertGreaterEqual(float(tensor.min()), 0.0)

    def test_yolo11_letterboxes_and_preserves_aspect(self):
        tensor, geometry = model_formats.preprocess(self._jpeg(1280, 720), InputSpec.from_dict(YOLO11_SPEC))

        self.assertEqual(tensor.shape, (1, 3, 640, 640))
        self.assertEqual(geometry.mode, "letterbox")
        self.assertAlmostEqual(geometry.ratio, 0.5, places=4)

    def test_yolox_preprocessing_is_untouched_by_this_milestone(self):
        """⭐ The regression that matters: the shipped detector's input must not have moved."""
        spec = InputSpec.from_dict(
            {"width": 416, "height": 416, "layout": "NCHW", "dtype": "float32",
             "colorOrder": "BGR", "resize": "letterbox", "padValue": 114, "scale": 1.0}
        )
        tensor, geometry = model_formats.preprocess(self._jpeg(1280, 720), spec)

        self.assertEqual(tensor.shape, (1, 3, 416, 416))
        self.assertEqual(geometry.mode, "letterbox")
        self.assertGreater(float(tensor.max()), 1.0, "yolox takes raw 0-255 values, scale 1.0")


@requires_numpy
class ClassMappingTests(unittest.TestCase):
    """⛔ The portability defect this milestone found."""

    def _catalogue(self):
        import json

        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "registry.json")
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    def test_person_is_class_zero_for_every_registered_detector(self):
        """The shipped capability is person detection; class 0 is the load-bearing fact."""
        for model in self._catalogue()["models"]:
            self.assertEqual(model["labels"][0], "person", model["id"])

    def test_every_detector_shares_one_label_space(self):
        """RT-DETR's own config says `motorbike`, `aeroplane`, `sofa`, `pottedplant`,
        `diningtable`, `tvmonitor` — VOC spellings at identical COCO indices. A rule written
        `label == "couch"` would work under YOLOX and silently never fire under RT-DETR, so the
        catalogue normalises the strings and never rebases the ids."""
        catalogue = self._catalogue()["models"]
        reference = catalogue[0]["labels"]

        for model in catalogue[1:]:
            self.assertEqual(model["labels"], reference, f"{model['id']} diverges from the label space")

    def test_the_declared_class_count_matches_the_label_list(self):
        for model in self._catalogue()["models"]:
            declared = model.get("outputParams", {}).get("numClasses")
            if declared is not None:
                self.assertEqual(declared, len(model["labels"]), model["id"])


@requires_numpy
class RegistryTests(unittest.TestCase):
    def test_all_three_families_are_registered(self):
        self.assertEqual(model_formats.available_decoders(), ["rtdetr", "yolo11", "yolox"])

    def test_every_catalogue_entry_has_a_decoder(self):
        """⛔ A catalogue entry whose outputFormat has no decoder fails at the first frame, in
        production, rather than here."""
        import json

        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "registry.json")
        with open(path, encoding="utf-8") as handle:
            for model in json.load(handle)["models"]:
                model_formats.get_decoder(model["outputFormat"])


if __name__ == "__main__":
    unittest.main()
