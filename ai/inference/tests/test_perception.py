"""Perception contract tests (P-10) — the vocabulary that lets a model say more than "box + class".

⭐ The property under test throughout is **backward compatibility**: the shipped detector's output
must be byte-identical after this contract exists. A foundation that quietly changes what today's
detector emits has broken the platform in order to prepare it.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contracts import Detection  # noqa: E402
from perception import (  # noqa: E402
    ATTR_MASK,
    ATTR_POSE,
    ATTR_TEXT,
    TASK_DETECTION,
    TASK_POSE,
    TASK_REID,
    TASK_VISION_LANGUAGE,
    FrameLabel,
    Keypoint,
    Mask,
    PerceptionOutput,
    RawInstance,
    TextSpan,
    UnknownTask,
    describe_task,
    from_raw_detections,
    known_tasks,
    register_task,
    to_raw_detections,
)
from perception_registry import (  # noqa: E402
    ModuleUnavailable,
    PerceptionRegistry,
    adapt_model_adapter,
    registry_from_engines,
)
from pipeline import RawDetection  # noqa: E402


class _StubAdapter:
    """Stands in for the shipped ONNX adapter — same four-verb `ModelAdapter` seam."""

    execution_provider = "stub"

    def __init__(self) -> None:
        self.loaded = None
        self.unloaded = False

    def load(self, ref):  # noqa: ANN001
        self.loaded = ref

    def preprocess(self, ctx):  # noqa: ANN001
        return ctx

    def infer(self, prepared):  # noqa: ANN001
        return [RawDetection(bbox=(0.25, 0.25, 0.5, 0.5), score=0.9, class_id=0, label="person")]

    def unload(self):
        self.unloaded = True


class TaskVocabularyTests(unittest.TestCase):
    """⚠️ `register_task` mutates module-level state that every other test in the suite shares.

    Snapshotted and restored around each case — deterministic CI is a standing constraint, and a
    task registered by a test that leaks turns "is this task known" into a question about test
    ordering. The private dict is reached into deliberately: the alternative is a reset hook on the
    production module whose only caller is a test.
    """

    def setUp(self) -> None:
        import perception

        self._tasks = dict(perception._KNOWN_TASKS)

    def tearDown(self) -> None:
        import perception

        perception._KNOWN_TASKS.clear()
        perception._KNOWN_TASKS.update(self._tasks)

    def test_the_ten_designed_tasks_are_known(self) -> None:
        for task in (
            "detection",
            "pose",
            "segmentation",
            "tracking",
            "reid",
            "ocr",
            "action",
            "temporal",
            "vision-language",
            "depth",
        ):
            self.assertIn(task, known_tasks())

    def test_an_unregistered_task_fails_closed(self) -> None:
        with self.assertRaises(UnknownTask):
            describe_task("telepathy")

    def test_a_plugin_can_register_a_task_nobody_designed_for(self) -> None:
        """⭐ 'Future Perception Modules' as a registration, not an architectural change."""
        register_task("gaze", "Where a subject is looking")
        self.assertIn("gaze", known_tasks())
        self.assertEqual(describe_task("gaze"), "Where a subject is looking")

    def test_registering_a_task_twice_with_a_different_meaning_is_refused(self) -> None:
        register_task("gaze", "Where a subject is looking")
        with self.assertRaises(ValueError):
            register_task("gaze", "Something else entirely")

    def test_a_perception_output_cannot_carry_an_unknown_task(self) -> None:
        with self.assertRaises(UnknownTask):
            PerceptionOutput(task="not-a-task")


class BackwardCompatibilityTests(unittest.TestCase):
    def test_todays_detector_output_survives_the_round_trip_unchanged(self) -> None:
        raws = [
            RawDetection(bbox=(0.1, 0.2, 0.3, 0.4), score=0.87, class_id=0, label="person"),
            RawDetection(bbox=(0.5, 0.5, 0.2, 0.2), score=0.42, class_id=2, label="car"),
        ]

        narrowed = to_raw_detections(from_raw_detections(raws), RawDetection)

        self.assertEqual(len(narrowed), 2)
        for before, after in zip(raws, narrowed):
            self.assertEqual(before.bbox, after.bbox)
            self.assertEqual(before.score, after.score)
            self.assertEqual(before.class_id, after.class_id)
            self.assertEqual(before.label, after.label)

    def test_a_plain_detection_adds_no_attributes(self) -> None:
        """⛔ The regression that matters: a detector's `Detection` must be what it always was."""
        instance = from_raw_detections(
            [RawDetection(bbox=(0.1, 0.1, 0.2, 0.2), score=0.5, class_id=0, label="person")]
        ).instances[0]

        self.assertEqual(instance.to_attributes(), {})

    def test_an_instance_without_a_box_is_dropped_rather_than_placed_at_the_origin(self) -> None:
        """⚠️ A caption is not a detection. A zero box would read as a real observation."""
        output = PerceptionOutput(
            task=TASK_VISION_LANGUAGE,
            instances=[RawInstance(score=0.9, label="a queue of shoppers")],
        )

        self.assertEqual(to_raw_detections(output, RawDetection), [])


class ModalityTests(unittest.TestCase):
    def test_pose_travels_inside_the_frozen_attributes_field(self) -> None:
        """⭐ No new top-level field, so the five frozen contracts do not change."""
        instance = RawInstance(
            score=0.8,
            bbox=(0.1, 0.1, 0.2, 0.4),
            keypoints=[
                Keypoint(name="nose", x=0.15, y=0.12, confidence=0.95),
                Keypoint(name="left_wrist", x=0.11, y=0.30, confidence=0.40, visible=False),
            ],
            skeleton="coco-17",
        )

        attributes = instance.to_attributes()

        self.assertEqual(attributes[ATTR_POSE]["skeleton"], "coco-17")
        self.assertEqual(len(attributes[ATTR_POSE]["keypoints"]), 2)
        detection = Detection(label="person", confidence=0.8, bbox=(0.1, 0.1, 0.2, 0.4), attributes=attributes)
        self.assertEqual(detection.to_dict()["attributes"][ATTR_POSE]["skeleton"], "coco-17")

    def test_an_occluded_joint_is_confident_and_invisible_at_once(self) -> None:
        """⚠️ Collapsing confidence into visibility loses what occlusion reasoning is built on."""
        hidden = Keypoint(name="left_wrist", x=0.5, y=0.5, confidence=0.97, visible=False)
        guessed = Keypoint(name="left_wrist", x=0.5, y=0.5, confidence=0.11, visible=True)

        self.assertNotEqual(hidden.to_dict()["visible"], guessed.to_dict()["visible"])
        self.assertGreater(hidden.to_dict()["confidence"], guessed.to_dict()["confidence"])

    def test_a_mask_carries_its_own_grid_because_it_is_not_the_frames(self) -> None:
        instance = RawInstance(score=0.7, bbox=(0, 0, 1, 1), mask=Mask("rle", "12,4,9", 160, 160))

        self.assertEqual(instance.to_attributes()[ATTR_MASK], {"encoding": "rle", "data": "12,4,9", "width": 160, "height": 160})

    def test_ocr_fills_only_text_and_reid_fills_only_an_embedding(self) -> None:
        """No module knows which field another module filled."""
        ocr = RawInstance(score=0.9, bbox=(0.4, 0.4, 0.1, 0.05), text=[TextSpan("EXIT", 0.99)])
        reid = RawInstance(score=0.9, bbox=(0.4, 0.4, 0.1, 0.05), embedding=[0.1, 0.2, 0.3])

        self.assertEqual(ocr.to_attributes()[ATTR_TEXT][0]["text"], "EXIT")
        self.assertNotIn(ATTR_TEXT, reid.to_attributes())
        self.assertEqual(list(reid.embedding), [0.1, 0.2, 0.3])

    def test_a_frame_label_needs_no_box_and_can_span_frames(self) -> None:
        """⛔ 'A person fell' is not a rectangle — the reason output is not just a list of instances."""
        output = PerceptionOutput(
            task=TASK_POSE,
            frame_labels=[FrameLabel(label="fall", confidence=0.82, span=(120, 147))],
        )

        self.assertEqual(output.to_dict()["frameLabels"][0]["span"], [120, 147])
        self.assertEqual(output.to_dict()["instances"], [])

    def test_coordinates_are_serialised_at_the_same_precision_as_a_detection(self) -> None:
        """Two rounding conventions in one document is a defect nobody notices until they diff."""
        output = PerceptionOutput(
            task=TASK_DETECTION,
            instances=[RawInstance(score=0.123456789, bbox=(0.123456789, 0.2, 0.3, 0.4))],
        )

        self.assertEqual(output.to_dict()["instances"][0]["score"], 0.123457)
        self.assertEqual(output.to_dict()["instances"][0]["bbox"][0], 0.123457)


class RegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = PerceptionRegistry()

    def test_the_shipped_detector_plugs_in_without_being_modified(self) -> None:
        """⭐ The whole backward-compatibility claim, executed."""
        adapter = _StubAdapter()
        self.registry.register(TASK_DETECTION, "yolox-nano", lambda: adapt_model_adapter(adapter))

        module = self.registry.create(TASK_DETECTION, "yolox-nano")
        module.load({"uri": "s3://models/yolox"})
        output = module.analyse(module.preprocess(object()))

        self.assertEqual(module.task, TASK_DETECTION)
        self.assertEqual(module.execution_provider, "stub")
        self.assertEqual(adapter.loaded, {"uri": "s3://models/yolox"})
        self.assertEqual(output.task, TASK_DETECTION)
        self.assertEqual(output.instances[0].label, "person")
        self.assertEqual(output.instances[0].bbox, (0.25, 0.25, 0.5, 0.5))

    def test_two_detectors_are_interchangeable_behind_one_name_space(self) -> None:
        self.registry.register(TASK_DETECTION, "yolox-nano", lambda: adapt_model_adapter(_StubAdapter()))
        self.registry.register(TASK_DETECTION, "rt-detr", lambda: adapt_model_adapter(_StubAdapter()))

        self.assertEqual(self.registry.available(TASK_DETECTION), ["rt-detr", "yolox-nano"])
        self.assertTrue(self.registry.supports(TASK_DETECTION, "rt-detr"))

    def test_registering_a_name_twice_raises_instead_of_silently_winning(self) -> None:
        """⛔ Whichever plugin imported last winning is invisible in every benchmark that follows."""
        self.registry.register(TASK_DETECTION, "yolo11", lambda: adapt_model_adapter(_StubAdapter()))

        with self.assertRaises(ValueError):
            self.registry.register(TASK_DETECTION, "yolo11", lambda: adapt_model_adapter(_StubAdapter()))

        self.registry.register(
            TASK_DETECTION, "yolo11", lambda: adapt_model_adapter(_StubAdapter()), replace=True
        )

    def test_an_unregistered_module_names_what_is_available(self) -> None:
        self.registry.register(TASK_DETECTION, "yolox-nano", lambda: adapt_model_adapter(_StubAdapter()))

        with self.assertRaises(ModuleUnavailable) as caught:
            self.registry.create(TASK_DETECTION, "yolo11")

        self.assertIn("yolox-nano", str(caught.exception))

    def test_a_module_cannot_be_registered_for_a_task_nobody_declared(self) -> None:
        with self.assertRaises(UnknownTask):
            self.registry.register("telepathy", "mind-reader", lambda: adapt_model_adapter(_StubAdapter()))

    def test_tasks_reports_what_can_be_executed_not_what_can_be_expressed(self) -> None:
        """⚠️ Advertising a capability the deployment cannot execute is worse than not having it."""
        self.registry.register(TASK_DETECTION, "yolox-nano", lambda: adapt_model_adapter(_StubAdapter()))

        self.assertEqual(self.registry.tasks(), [TASK_DETECTION])
        self.assertIn(TASK_POSE, known_tasks())
        self.assertNotIn(TASK_POSE, self.registry.tasks())

    def test_describe_states_what_this_deployment_can_perceive(self) -> None:
        self.registry.register(TASK_DETECTION, "yolox-nano", lambda: adapt_model_adapter(_StubAdapter()))
        self.registry.register(TASK_REID, "osnet", lambda: adapt_model_adapter(_StubAdapter()))

        described = self.registry.describe()["tasks"]

        self.assertEqual([t["task"] for t in described], [TASK_DETECTION, TASK_REID])
        self.assertEqual(described[0]["modules"], ["yolox-nano"])
        self.assertTrue(described[1]["description"])

    def test_every_engine_the_runtime_has_becomes_a_detection_module(self) -> None:
        from engines import default_registry

        engines = default_registry(lambda: _StubAdapter())

        registry = registry_from_engines(engines)

        self.assertEqual(registry.available(TASK_DETECTION), sorted(engines.available()))
        module = registry.create(TASK_DETECTION, "onnx")
        self.assertEqual(module.analyse(module.preprocess(object())).task, TASK_DETECTION)


if __name__ == "__main__":
    unittest.main()


class PoseSeamTests(unittest.TestCase):
    """⭐ P3.2c — the seam pose will arrive through, asserted rather than assumed.

    ⛔ No pose model is authorised and none is implemented. These tests pin the *contract* so the
    design in `docs/validation/POSE_SEAM.md` is checkable: if any of them starts failing, the seam
    described there has moved and the plan built on it is wrong.
    """

    class _Raw:
        """Stands in for `pipeline.RawDetection` — injected, never imported (see `to_raw_detections`)."""

        def __init__(self, bbox, score, class_id=None, label=None):
            self.bbox, self.score, self.class_id, self.label = bbox, score, class_id, label

    def _posed(self) -> RawInstance:
        return RawInstance(
            score=0.9,
            bbox=(0.1, 0.1, 0.2, 0.5),
            class_id=0,
            label="person",
            skeleton="coco-17",
            keypoints=[
                Keypoint(name="left_wrist", x=0.15, y=0.30, confidence=0.81, visible=True),
                Keypoint(name="right_wrist", x=0.24, y=0.31, confidence=0.44, visible=False),
            ],
        )

    def test_a_posed_instance_narrows_to_an_ordinary_detection(self) -> None:
        """⭐ The box reaches the existing post-processing stage unchanged, so tracking, identity and
        every behaviour primitive keep working on a pose model's output with no change."""
        out = PerceptionOutput(task=TASK_DETECTION, instances=[self._posed()])
        narrowed = to_raw_detections(out, self._Raw)
        self.assertEqual(len(narrowed), 1)
        self.assertEqual(narrowed[0].label, "person")
        self.assertEqual(narrowed[0].bbox, (0.1, 0.1, 0.2, 0.5))

    def test_the_keypoints_survive_the_narrowing_in_attributes(self) -> None:
        """⛔ `RawDetection` has four slots and must not grow a fifth. Pose rides in the frozen
        `attributes` map, which the TS contract declares as an open record."""
        attributes = self._posed().to_attributes()
        self.assertEqual(len(attributes[ATTR_POSE]["keypoints"]), 2)
        self.assertEqual(attributes[ATTR_POSE]["skeleton"], "coco-17")

    def test_visibility_and_confidence_remain_separate_facts(self) -> None:
        """⚠️ A joint the model is sure is *hidden* is high-confidence and not visible; a joint it
        guessed at is low-confidence. Collapsing them loses the distinction occlusion reasoning is
        built on — and occlusion is the retail case."""
        keypoints = self._posed().to_attributes()[ATTR_POSE]["keypoints"]
        hidden = next(k for k in keypoints if k["name"] == "right_wrist")
        self.assertFalse(hidden["visible"])
        self.assertEqual(hidden["confidence"], 0.44)

    def test_a_plain_detection_is_byte_identical_without_pose(self) -> None:
        """⛔ The regression guarantee: adding the vocabulary changed nothing for the shipped
        detector. An empty attributes map, not a `{"pose": null}`."""
        plain = RawInstance(score=0.9, bbox=(0.1, 0.1, 0.2, 0.5), label="person")
        self.assertEqual(plain.to_attributes(), {})

    def test_an_instance_with_no_box_is_dropped_rather_than_placed_at_the_origin(self) -> None:
        """⛔ A pose with no bounding box is not a detection; a zero box would read as a real
        observation of something at the top-left corner."""
        out = PerceptionOutput(
            task=TASK_DETECTION,
            instances=[RawInstance(score=0.5, keypoints=[Keypoint(name="nose", x=0.5, y=0.5)])],
        )
        self.assertEqual(to_raw_detections(out, self._Raw), [])
