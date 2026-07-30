"""Event generation tests (P2-2 G-3) — DetectionResult → EventEnvelope mapping, label→type table,
operational system events, and the hard invariant: the runtime NEVER emits incident/notification/
workflow events. Deterministic, stdlib-only."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from events import (  # noqa: E402
    SYSTEM_EVENT_TYPES,
    deterministic_id_gen,
    detections_to_events,
    event_type_for_label,
    model_failed_event,
    system_event,
)


def _result(detections):
    return {
        "tenantId": "tnt_a",
        "cameraId": "cam_1",
        "capabilityId": "perception.person-detection",
        "capabilityVersion": "1.0.0",
        "model": {"name": "yolo", "version": "1.0.0"},
        "frame": {"seq": 3, "capturedAt": "2026-07-30T00:00:00.000Z"},
        "at": "2026-07-30T00:00:01.000Z",
        "correlationId": "corr_1",
        "detections": detections,
    }


class LabelMappingTests(unittest.TestCase):
    def test_maps_known_labels(self) -> None:
        self.assertEqual(event_type_for_label("person"), "perception.person.detected")
        self.assertEqual(event_type_for_label("Fire"), "perception.fire.detected")
        self.assertEqual(event_type_for_label("knife"), "perception.weapon.detected")

    def test_unknown_label_falls_back_to_generic(self) -> None:
        self.assertEqual(event_type_for_label("giraffe"), "perception.object.detected")


class EventGenerationTests(unittest.TestCase):
    def test_detections_to_events_shape(self) -> None:
        result = _result(
            [
                {"label": "person", "confidence": 0.92, "bbox": [0.1, 0.1, 0.2, 0.3]},
                {"label": "fire", "confidence": 0.81, "bbox": [0.5, 0.5, 0.1, 0.1]},
            ]
        )
        events = detections_to_events(result, id_gen=deterministic_id_gen())
        self.assertEqual(len(events), 2)
        person, fire = events
        self.assertEqual(person["type"], "perception.person.detected")
        self.assertEqual(person["category"], "perception")
        self.assertEqual(person["priority"], "info")
        self.assertEqual(person["tenantId"], "tnt_a")
        self.assertEqual(person["cameraId"], "cam_1")
        self.assertEqual(person["correlationId"], "corr_1")
        self.assertEqual(person["producer"]["modelVersion"], "1.0.0")
        self.assertEqual(person["subjects"][0]["class"], "person")
        # fire is safety-critical
        self.assertEqual(fire["type"], "perception.fire.detected")
        self.assertEqual(fire["category"], "safety")
        self.assertEqual(fire["priority"], "critical")

    def test_no_detections_no_events(self) -> None:
        self.assertEqual(detections_to_events(_result([])), [])

    def test_model_failed_event(self) -> None:
        ev = model_failed_event(
            "tnt_a", "perception.person-detection", "load failed", at="2026-07-30T00:00:00.000Z"
        )
        self.assertEqual(ev["type"], "system.model.failed")
        self.assertEqual(ev["category"], "system")
        self.assertEqual(ev["priority"], "high")
        self.assertEqual(ev["payload"]["error"], "load failed")

    def test_system_events(self) -> None:
        for t in ("system.camera.disconnected", "system.stream.started", "system.pipeline.stopped"):
            ev = system_event(t, "tnt_a", at="2026-07-30T00:00:00.000Z", camera_id="cam_1")
            self.assertEqual(ev["type"], t)
            self.assertEqual(ev["category"], "system")
            self.assertEqual(ev["cameraId"], "cam_1")
        self.assertEqual(system_event("system.camera.disconnected", "tnt_a", at="x")["priority"], "high")
        with self.assertRaises(ValueError):
            system_event("system.made.up", "tnt_a", at="x")

    def test_runtime_never_emits_incidents_or_workflow_events(self) -> None:
        # Every generated type is perception/behavior/analytics/system — never incident/notification.
        result = _result([{"label": l, "confidence": 0.9, "bbox": [0, 0, 1, 1]} for l in ("person", "car", "smoke", "giraffe")])
        events = detections_to_events(result)
        for ev in events:
            self.assertFalse(ev["type"].startswith("incident."))
            self.assertFalse(ev["type"].startswith("notification."))
            self.assertRegex(ev["type"], r"^(perception|behavior|analytics|system)\.")
        # system + failed events also never incidents
        self.assertTrue(all(not t.startswith("incident.") for t in SYSTEM_EVENT_TYPES))


if __name__ == "__main__":
    unittest.main()
