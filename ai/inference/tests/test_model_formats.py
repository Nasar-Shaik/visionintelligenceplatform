"""The model-format seam: spec-driven preprocessing and the decoder registry (P-8 Phase 3).

⚠️ **These tests need numpy, so locally they SKIP and in the deployed image they RUN.** The
verification script (`docs/review/p8/inference.mjs`) executes this suite inside the running
container and asserts that it was **not skipped** — a test that quietly skips in the one environment
that matters is worse than no test, because it reports green.

What is checked here is the arithmetic no deployment can check for you: that a box decoded in tensor
space lands where it belongs on the operator's frame, and that suppression removes duplicates of the
same thing without removing the person standing in front of the car.
"""

import math
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


def _jpeg(width: int, height: int, colour=(200, 30, 30)) -> bytes:
    import io

    from PIL import Image  # type: ignore

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, format="JPEG", quality=95)
    return buffer.getvalue()


@requires_numpy
class PreprocessingTests(unittest.TestCase):
    def test_stretch_produces_the_declared_nhwc_uint8_tensor(self):
        spec = InputSpec.from_dict(
            {"width": 300, "height": 300, "layout": "NHWC", "dtype": "uint8", "resize": "stretch"}
        )
        tensor, geometry = model_formats.preprocess(_jpeg(640, 360), spec)
        self.assertEqual(tensor.shape, (1, 300, 300, 3))
        self.assertEqual(tensor.dtype, np.uint8)
        self.assertEqual(geometry.mode, "stretch")

    def test_letterbox_produces_the_declared_nchw_float_tensor_and_preserves_aspect(self):
        spec = InputSpec.from_dict(
            {"width": 416, "height": 416, "layout": "NCHW", "dtype": "float32", "resize": "letterbox"}
        )
        tensor, geometry = model_formats.preprocess(_jpeg(640, 360), spec)
        self.assertEqual(tensor.shape, (1, 3, 416, 416))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertAlmostEqual(geometry.ratio, 416 / 640, places=6)
        self.assertEqual((geometry.src_w, geometry.src_h), (640, 360))

    def test_letterbox_pads_with_the_declared_value_rather_than_black(self):
        # ⚠️ 114 is not decoration: the model was trained with it, and padding with zeros shifts
        # every score on a non-square frame — which is every CCTV frame.
        spec = InputSpec.from_dict(
            {"width": 64, "height": 64, "layout": "NHWC", "dtype": "uint8", "resize": "letterbox",
             "padValue": 114}
        )
        tensor, _ = model_formats.preprocess(_jpeg(64, 32), spec)
        self.assertTrue(np.all(tensor[0, 63, :, :] == 114), "the bottom row should be padding")

    def test_colour_order_is_applied_from_the_spec(self):
        red = _jpeg(32, 32, colour=(255, 0, 0))
        rgb = InputSpec.from_dict({"width": 8, "height": 8, "layout": "NHWC", "dtype": "uint8",
                                   "resize": "stretch", "colorOrder": "RGB"})
        bgr = InputSpec.from_dict({"width": 8, "height": 8, "layout": "NHWC", "dtype": "uint8",
                                   "resize": "stretch", "colorOrder": "BGR"})
        as_rgb, _ = model_formats.preprocess(red, rgb)
        as_bgr, _ = model_formats.preprocess(red, bgr)
        self.assertGreater(int(as_rgb[0, 4, 4, 0]), int(as_rgb[0, 4, 4, 2]), "red in channel 0")
        self.assertGreater(int(as_bgr[0, 4, 4, 2]), int(as_bgr[0, 4, 4, 0]), "red in channel 2")

    def test_scale_and_normalisation_are_applied_from_the_spec(self):
        spec = InputSpec.from_dict(
            {"width": 8, "height": 8, "layout": "NHWC", "dtype": "float32", "resize": "stretch",
             "scale": 1.0 / 255.0}
        )
        tensor, _ = model_formats.preprocess(_jpeg(16, 16, colour=(255, 255, 255)), spec)
        self.assertLessEqual(float(tensor.max()), 1.0 + 1e-6)


@requires_numpy
class BoxMappingTests(unittest.TestCase):
    def test_a_letterboxed_box_maps_back_onto_the_original_frame(self):
        # 640x360 fitted into 416x416 → ratio 0.65, so a box at (65,65)-(130,130) in tensor pixels
        # is (100,100)-(200,200) in the source, i.e. x=100/640, y=100/360.
        geometry = Geometry("letterbox", 0.65, 0.0, 0.0, 416, 416, 640, 360)
        x, y, w, h = model_formats.to_source_bbox(65.0, 65.0, 130.0, 130.0, geometry)
        self.assertAlmostEqual(x, 100 / 640, places=4)
        self.assertAlmostEqual(y, 100 / 360, places=4)
        self.assertAlmostEqual(w, 100 / 640, places=4)
        self.assertAlmostEqual(h, 100 / 360, places=4)

    def test_a_stretched_box_normalises_against_the_tensor_itself(self):
        geometry = Geometry("stretch", 1.0, 0.0, 0.0, 300, 300, 1920, 1080)
        x, y, w, h = model_formats.to_source_bbox(75.0, 150.0, 225.0, 300.0, geometry)
        self.assertAlmostEqual(x, 0.25, places=6)
        self.assertAlmostEqual(y, 0.5, places=6)
        self.assertAlmostEqual(w, 0.5, places=6)
        self.assertAlmostEqual(h, 0.5, places=6)

    def test_boxes_are_clamped_into_the_frame(self):
        # A model may predict a box that runs off the edge; a bbox outside [0,1] breaks every
        # consumer downstream (zones, tracking, the operator's overlay).
        geometry = Geometry("stretch", 1.0, 0.0, 0.0, 100, 100, 100, 100)
        x, y, w, h = model_formats.to_source_bbox(-50.0, -50.0, 500.0, 500.0, geometry)
        self.assertEqual((x, y), (0.0, 0.0))
        self.assertEqual((w, h), (1.0, 1.0))


@requires_numpy
class SuppressionTests(unittest.TestCase):
    def test_overlapping_boxes_collapse_to_the_highest_scoring_one(self):
        boxes = [[0, 0, 10, 10], [1, 1, 11, 11], [50, 50, 60, 60]]
        keep = model_formats.nms(boxes, [0.9, 0.8, 0.7], 0.45)
        self.assertEqual(keep, [0, 2])

    def test_nothing_is_suppressed_when_nothing_overlaps(self):
        boxes = [[0, 0, 10, 10], [20, 20, 30, 30], [40, 40, 50, 50]]
        self.assertEqual(sorted(model_formats.nms(boxes, [0.5, 0.9, 0.7], 0.45)), [0, 1, 2])

    def test_empty_input_is_not_an_error(self):
        self.assertEqual(model_formats.nms([], [], 0.45), [])


@requires_numpy
class YoloxDecoderTests(unittest.TestCase):
    def setUp(self):
        self.spec = InputSpec.from_dict(
            {"width": 416, "height": 416, "layout": "NCHW", "dtype": "float32", "resize": "letterbox"}
        )
        self.geometry = Geometry("letterbox", 1.0, 0.0, 0.0, 416, 416, 416, 416)
        self.params = {"strides": [8, 16, 32], "nmsIouThreshold": 0.45, "scoreFloor": 0.05}

    def predictions(self):
        return np.zeros((1, 3549, 85), dtype=np.float32)

    def place(self, tensor, anchor, cx_cells, cy_cells, size_cells, obj, class_id, class_score):
        tensor[0, anchor, 0] = cx_cells
        tensor[0, anchor, 1] = cy_cells
        tensor[0, anchor, 2] = math.log(size_cells)
        tensor[0, anchor, 3] = math.log(size_cells)
        tensor[0, anchor, 4] = obj
        tensor[0, anchor, 5 + class_id] = class_score

    def test_grid_decoding_places_the_box_where_the_stride_says_it_is(self):
        tensor = self.predictions()
        # Anchor 0 is stride 8, grid cell (0,0): centre = 10*8 = 80, size = 10*8 = 80.
        self.place(tensor, 0, 10, 10, 10, 0.9, 0, 0.8)
        detections = model_formats.decode_yolox([tensor], self.spec, self.geometry, self.params)
        self.assertEqual(len(detections), 1)
        x, y, w, h = detections[0].bbox
        self.assertAlmostEqual(x, 40 / 416, places=4)
        self.assertAlmostEqual(y, 40 / 416, places=4)
        self.assertAlmostEqual(w, 80 / 416, places=4)
        self.assertAlmostEqual(h, 80 / 416, places=4)
        self.assertAlmostEqual(detections[0].score, 0.72, places=5, msg="objectness × class score")
        self.assertEqual(detections[0].class_id, 0)

    def test_duplicates_of_the_same_object_collapse(self):
        tensor = self.predictions()
        self.place(tensor, 0, 10, 10, 10, 0.9, 0, 0.8)
        self.place(tensor, 1, 10.05, 10, 10, 0.9, 0, 0.7)  # the neighbouring cell, same person
        detections = model_formats.decode_yolox([tensor], self.spec, self.geometry, self.params)
        self.assertEqual(len(detections), 1)
        self.assertAlmostEqual(detections[0].score, 0.72, places=5)

    def test_suppression_is_per_class_so_a_person_in_front_of_a_car_survives(self):
        # ⚠️ The reason NMS is per class. Class-agnostic suppression is a one-line simplification
        # that silently deletes exactly the detections a CCTV product exists to make.
        tensor = self.predictions()
        self.place(tensor, 0, 10, 10, 10, 0.9, 0, 0.8)  # person
        self.place(tensor, 1, 10.05, 10, 10, 0.9, 2, 0.9)  # car, almost the same box
        detections = model_formats.decode_yolox([tensor], self.spec, self.geometry, self.params)
        self.assertEqual(sorted(d.class_id for d in detections), [0, 2])

    def test_results_arrive_highest_confidence_first(self):
        tensor = self.predictions()
        self.place(tensor, 0, 10, 10, 10, 0.5, 0, 0.5)
        self.place(tensor, 3000, 2, 2, 4, 0.99, 2, 0.99)
        detections = model_formats.decode_yolox([tensor], self.spec, self.geometry, self.params)
        self.assertEqual([d.class_id for d in detections], [2, 0])

    def test_a_frame_with_nothing_in_it_produces_no_detections(self):
        # The single most important difference between this and the stub backend, which returns a
        # detection for any bytes at all.
        detections = model_formats.decode_yolox([self.predictions()], self.spec, self.geometry, self.params)
        self.assertEqual(detections, [])

    def test_a_grid_that_does_not_match_the_input_size_is_an_error(self):
        # ⚠️ Loud, because the silent version is worse: mismatched strides decode every box to the
        # wrong place and the product looks like a bad model rather than a bad config.
        with self.assertRaises(ValueError) as caught:
            model_formats.decode_yolox([self.predictions()], self.spec, self.geometry, {"strides": [8]})
        self.assertIn("anchors", str(caught.exception))


@requires_numpy
class DecoderRegistryTests(unittest.TestCase):
    def test_both_shipped_formats_are_registered(self):
        self.assertEqual(model_formats.available_decoders(), ["yolox"])

    def test_an_unknown_format_names_what_is_registered(self):
        with self.assertRaises(model_formats.UnknownModelFormat) as caught:
            model_formats.get_decoder("rt-detr")
        self.assertIn("yolox", str(caught.exception))

    def test_a_new_family_is_one_registration_and_no_change_above_this_module(self):
        try:
            model_formats.register_decoder("test-only-format", lambda *_: [])
            self.assertIn("test-only-format", model_formats.available_decoders())
            self.assertEqual(model_formats.get_decoder("test-only-format")([], None, None, {}), [])
        finally:
            model_formats._DECODERS.pop("test-only-format", None)


if __name__ == "__main__":
    unittest.main()
