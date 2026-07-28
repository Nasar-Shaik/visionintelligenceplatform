"""Capability runtime tests (stdlib-only, fake backend): manifest-driven init binds a model by
selector, the staged pipeline produces a version-stamped DetectionResult, lifecycle states are
correct, and a frame without context is dropped fail-closed."""

import base64
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from adapters.fake_adapter import FakeModelAdapter  # noqa: E402
from capability import Capability  # noqa: E402
from contracts import CapabilityState, FrameContext  # noqa: E402
from errors import CapabilityLoadError, ContextRequired, InferenceError  # noqa: E402
from manifest import CapabilityManifest  # noqa: E402
from resolver import FakeModelResolver  # noqa: E402

IMG = base64.b64encode(b"a-fake-jpeg-frame").decode("ascii")


def manifest(enabled=True, min_conf=0.5):
    return CapabilityManifest.from_dict(
        {
            "capabilityId": "perception.person-detection",
            "version": "0.1.0",
            "requiredModel": {"task": "object-detection", "family": "*", "accelerator": "cpu"},
            "minConfidence": min_conf,
            "generatedEvents": ["perception.person.detected"],
            "enabled": enabled,
        }
    )


def ready_cap(m=None, resolver=None, adapter=None):
    cap = Capability(
        m or manifest(),
        resolver or FakeModelResolver(),
        adapter or FakeModelAdapter(),
        runtime_version="0.1.0",
        clock=lambda: 1000.0,
    )
    cap.init()
    return cap


def ctx(context=None, image=IMG, cam="cam_1", seq=3):
    body = {
        "frame": {"cameraId": cam, "seq": seq, "capturedAt": "2026-07-28T00:00:00.000Z", "correlationId": "corr_1"},
        "imageBase64": image,
    }
    if context is not None:
        body["context"] = context
    return FrameContext.from_request(body)


VALID_CTX = {"tenantId": "tnt_a", "principalId": "u1"}


class LifecycleTests(unittest.TestCase):
    def test_init_binds_model_and_becomes_ready(self) -> None:
        cap = ready_cap()
        self.assertEqual(cap.state, CapabilityState.READY)
        self.assertTrue(cap.ready)
        self.assertEqual(cap.health()["model"]["task"], "object-detection")
        self.assertEqual(cap.health()["executionProvider"], "stub")

    def test_disabled_manifest_stays_disabled(self) -> None:
        cap = Capability(manifest(enabled=False), FakeModelResolver(), FakeModelAdapter(), "0.1.0")
        self.assertEqual(cap.state, CapabilityState.DISABLED)
        cap.init()
        self.assertEqual(cap.state, CapabilityState.DISABLED)

    def test_unresolved_model_fails_load(self) -> None:
        cap = Capability(manifest(), FakeModelResolver(catalog=[]), FakeModelAdapter(), "0.1.0")
        with self.assertRaises(CapabilityLoadError):
            cap.init()
        self.assertEqual(cap.state, CapabilityState.FAILED)

    def test_process_before_init_refuses(self) -> None:
        cap = Capability(manifest(), FakeModelResolver(), FakeModelAdapter(), "0.1.0")
        with self.assertRaises(InferenceError):
            cap.process(ctx(context=VALID_CTX))


class ProcessTests(unittest.TestCase):
    def test_produces_version_stamped_detection_result(self) -> None:
        cap = ready_cap()
        out = cap.process(ctx(context=VALID_CTX))
        self.assertEqual(out["tenantId"], "tnt_a")
        self.assertEqual(out["cameraId"], "cam_1")
        self.assertEqual(out["capabilityId"], "perception.person-detection")
        self.assertEqual(out["capabilityVersion"], "0.1.0")
        self.assertEqual(out["runtimeVersion"], "0.1.0")
        self.assertEqual(out["executionProvider"], "stub")
        self.assertEqual(out["correlationId"], "corr_1")
        self.assertEqual(out["frame"], {"seq": 3, "capturedAt": "2026-07-28T00:00:00.000Z"})
        self.assertGreaterEqual(len(out["detections"]), 1)
        det = out["detections"][0]
        self.assertEqual(det["label"], "person")  # mapped from the resolved model's label space
        self.assertTrue(0.0 <= det["confidence"] <= 1.0)
        self.assertEqual(len(det["bbox"]), 4)
        self.assertIn("attributes", det)
        self.assertEqual(cap.metrics.frames_processed, 1)

    def test_is_deterministic(self) -> None:
        cap = ready_cap()
        a = cap.process(ctx(context=VALID_CTX))
        b = cap.process(ctx(context=VALID_CTX))
        self.assertEqual(a["detections"], b["detections"])

    def test_min_confidence_filters_detections(self) -> None:
        cap = ready_cap(m=manifest(min_conf=0.999))
        out = cap.process(ctx(context=VALID_CTX))
        self.assertEqual(out["detections"], [])

    def test_frame_without_context_dropped_fail_closed(self) -> None:
        with self.assertRaises(ContextRequired):
            ctx(context=None)
        with self.assertRaises(ContextRequired):
            ctx(context={"principalId": "u1"})  # no tenantId

    def test_invalid_image_raises_inference_error(self) -> None:
        with self.assertRaises(InferenceError):
            ctx(context=VALID_CTX, image="not!base64!")


class DescribeTests(unittest.TestCase):
    def test_descriptor_from_manifest(self) -> None:
        d = ready_cap().descriptor()
        self.assertEqual(d["id"], "perception.person-detection")
        self.assertEqual(d["kind"], "perception")
        self.assertEqual(d["models"]["selector"]["task"], "object-detection")
        self.assertIn("perception.person.detected", d["generatedEvents"])
        self.assertEqual(d["parameters"]["minConfidence"], 0.5)


if __name__ == "__main__":
    unittest.main()
