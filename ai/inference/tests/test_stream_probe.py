"""Stream validation probe tests (P-2).

Deterministic throughout: every probe here runs against a `SimulatedStreamSource` with an injected
clock, so there is no network, no camera and no wall-clock in the suite. The negative control at the
bottom is the one that matters most — a flawless simulated probe must still not be hardware evidence.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from errors import ConfigurationFailure, ConnectionFailure  # noqa: E402
from stream_probe import CHECK_ORDER, probe_stream  # noqa: E402
from stream_source import FaultPlan, SimulatedStreamSource  # noqa: E402

AT = lambda: "2026-08-01T10:00:00.000Z"  # noqa: E731


class FakeClock:
    """Advances a fixed step on every read — turns frame arrivals into predictable timings."""

    def __init__(self, step=0.1):
        self.t = 0.0
        self.step = step

    def __call__(self):
        self.t += self.step
        return self.t


def sim(**kwargs):
    """A build function yielding a deterministic simulated source, ignoring the config."""

    def build(_config):
        return SimulatedStreamSource(uri="sim://camera", **kwargs)

    return build


def statuses(report):
    return {c.name: c.status for c in report.checks}


class Unauthorized:
    """A device that is present and says no."""

    source_type = "rtsp"

    def open(self):
        raise ConnectionFailure("cannot open source: 401 Unauthorized")

    def frames(self):  # pragma: no cover - never reached
        yield None

    def close(self):
        pass


class LeakyError:
    """A device whose error message carries the credentialed URI, as FFmpeg's really do."""

    source_type = "rtsp"

    def open(self):
        raise ConnectionFailure("cannot open source: rtsp://admin:hunter2@cam.local/sub")

    def frames(self):  # pragma: no cover - never reached
        yield None

    def close(self):
        pass


class TestWorkingStream(unittest.TestCase):
    def test_reports_every_check_it_actually_performed(self):
        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local:554/sub"},
            frames=3,
            build=sim(total_frames=10),
            clock=FakeClock(step=0.1),
            now=AT,
        )
        self.assertTrue(report.reachable)
        self.assertEqual(report.frames_read, 3)
        self.assertEqual(report.resolution, "1920x1080")
        checks = statuses(report)
        self.assertEqual(checks["reachability"], "pass")
        self.assertEqual(checks["stream-open"], "pass")
        self.assertEqual(checks["frames-received"], "pass")
        self.assertEqual(checks["resolution"], "pass")

    def test_every_check_in_the_contract_order_is_always_present(self):
        """A missing check and a passing check must never be indistinguishable in the UI."""
        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub"},
            build=sim(total_frames=5),
            clock=FakeClock(),
            now=AT,
        )
        self.assertEqual([c.name for c in report.checks], list(CHECK_ORDER))

    def test_frame_rate_is_measured_from_arrivals_not_declared(self):
        # 100 ms between frames → 10 fps, regardless of what any capability claims.
        report = probe_stream(
            {
                "type": "rtsp",
                "uri": "rtsp://cam.local/sub",
                "capabilities": {"fpsRange": {"min": 25, "max": 25}},
            },
            frames=4,
            build=sim(total_frames=10),
            clock=FakeClock(step=0.1),
            now=AT,
        )
        self.assertAlmostEqual(report.fps, 10.0, delta=0.5)
        self.assertAlmostEqual(report.jitter_ms, 0.0, delta=1.0)

    def test_a_single_frame_does_not_produce_a_frame_rate(self):
        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub"},
            frames=1,
            build=sim(total_frames=5),
            clock=FakeClock(),
            now=AT,
        )
        self.assertEqual(report.frames_read, 1)
        self.assertIsNone(report.fps)
        self.assertEqual(statuses(report)["fps"], "not-executed")

    def test_a_slow_stream_warns_without_failing(self):
        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub"},
            frames=3,
            build=sim(total_frames=10),
            clock=FakeClock(step=2.0),  # one frame every 2s → 0.5 fps
            now=AT,
        )
        self.assertEqual(statuses(report)["fps"], "warn")
        self.assertTrue(report.warnings)
        self.assertIn("fps", report.warnings[0])


class TestDiagnoses(unittest.TestCase):
    """The distinctions that decide whether an installer fixes the right thing."""

    def test_an_unreachable_device_leaves_later_checks_not_executed_rather_than_failed(self):
        def build(_config):
            return SimulatedStreamSource(uri="sim://camera", faults=FaultPlan(fail_opens=1))

        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub"},
            build=build,
            clock=FakeClock(),
            now=AT,
        )
        checks = statuses(report)
        self.assertFalse(report.reachable)
        self.assertEqual(checks["reachability"], "fail")
        # The codec is not wrong — it was never looked at. Reporting it as a failure sends someone
        # to re-encode a stream when the cable is unplugged.
        self.assertEqual(checks["codec"], "not-executed")
        self.assertEqual(checks["frames-received"], "not-executed")
        failures = [c.name for c in report.checks if c.status == "fail"]
        self.assertEqual(failures, ["reachability"])

    def test_a_rejected_credential_is_authentication_not_unreachable(self):
        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub"},
            build=lambda _c: Unauthorized(),
            clock=FakeClock(),
            now=AT,
        )
        checks = statuses(report)
        # The device is there. Sending an installer to check cabling would waste the visit.
        self.assertTrue(report.reachable)
        self.assertEqual(report.authentication, "failed")
        self.assertEqual(checks["reachability"], "pass")
        self.assertEqual(checks["authentication"], "fail")
        self.assertEqual(checks["stream-open"], "not-executed")

    def test_a_stream_that_opens_then_stalls_is_a_frame_failure(self):
        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub"},
            build=sim(total_frames=0),  # opens fine, yields nothing
            clock=FakeClock(),
            now=AT,
        )
        checks = statuses(report)
        self.assertTrue(report.reachable)
        self.assertEqual(report.frames_read, 0)
        self.assertEqual(checks["stream-open"], "pass")
        self.assertEqual(checks["frames-received"], "fail")

    def test_an_unusable_configuration_fails_before_anything_is_dialled(self):
        def build(_config):
            raise ConfigurationFailure("source.uri is required")

        report = probe_stream({"type": "rtsp"}, build=build, clock=FakeClock(), now=AT)
        self.assertFalse(report.reachable)
        self.assertEqual(statuses(report)["reachability"], "fail")
        self.assertIn("uri", report.error or "")

    def test_authentication_is_not_claimed_when_no_credentials_were_offered(self):
        """Opening an unauthenticated stream proves nothing about credentials — say so."""
        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub"},
            build=sim(total_frames=5),
            clock=FakeClock(),
            now=AT,
        )
        self.assertEqual(report.authentication, "unknown")
        self.assertEqual(statuses(report)["authentication"], "not-executed")

    def test_credentialed_success_records_that_the_device_accepted_them(self):
        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub", "_credentialed": True},
            build=sim(total_frames=5),
            clock=FakeClock(),
            now=AT,
        )
        self.assertEqual(report.authentication, "ok")
        self.assertEqual(statuses(report)["authentication"], "pass")

    def test_the_codec_is_reported_as_declared_and_never_invented(self):
        declared = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub", "capabilities": {"codecs": ["h265"]}},
            build=sim(total_frames=5),
            clock=FakeClock(),
            now=AT,
        )
        self.assertEqual(declared.codec, "h265")
        codec_check = next(c for c in declared.checks if c.name == "codec")
        self.assertIn("declared", codec_check.detail or "")

        undeclared = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub"},
            build=sim(total_frames=5),
            clock=FakeClock(),
            now=AT,
        )
        self.assertIsNone(undeclared.codec)
        self.assertEqual(statuses(undeclared)["codec"], "not-executed")

    def test_a_credentialed_uri_never_reaches_the_report(self):
        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub"},
            build=lambda _c: LeakyError(),
            clock=FakeClock(),
            now=AT,
        )
        serialized = str(report.to_dict())
        self.assertNotIn("hunter2", serialized)
        self.assertNotIn("admin", serialized)


class TestEvidenceClass(unittest.TestCase):
    def test_a_flawless_simulated_probe_is_not_hardware_evidence(self):
        """The sibling of `test_a_flawless_simulated_run_is_still_not_certified` (AI-5e).

        Nothing about this probe fails. Every check passes, the frame rate is perfect, the
        resolution is 1080p. It is still `simulated`, and the camera service refuses to call the
        camera `connected` on it. If this test is ever "fixed" by promoting the evidence class, a
        demo environment will report a fully connected estate that does not physically exist.
        """
        report = probe_stream(
            {"type": "simulated", "uri": "sim://camera"},
            frames=5,
            build=sim(total_frames=20),
            clock=FakeClock(step=0.04),
            now=AT,
        )
        self.assertTrue(report.reachable)
        self.assertEqual(report.frames_read, 5)
        self.assertEqual([c.name for c in report.checks if c.status == "fail"], [])
        self.assertEqual(report.evidence_class, "simulated")

    def test_recorded_footage_is_stronger_than_simulation_and_still_not_hardware(self):
        report = probe_stream(
            {"type": "file", "uri": "/footage/lobby.mp4"},
            build=sim(total_frames=10),
            clock=FakeClock(),
            now=AT,
        )
        self.assertEqual(report.evidence_class, "recorded-footage")

    def test_a_real_transport_yields_hardware_evidence(self):
        for source_type in ("rtsp", "onvif", "usb"):
            with self.subTest(source_type=source_type):
                report = probe_stream(
                    {"type": source_type, "uri": "rtsp://cam.local/sub"},
                    build=sim(total_frames=5),
                    clock=FakeClock(),
                    now=AT,
                )
                self.assertEqual(report.evidence_class, "hardware")


class TestWireShape(unittest.TestCase):
    def test_matches_the_contract(self):
        report = probe_stream(
            {"type": "rtsp", "uri": "rtsp://cam.local/sub"},
            build=sim(total_frames=5),
            clock=FakeClock(),
            now=AT,
        )
        payload = report.to_dict()
        for key in (
            "probedAt",
            "evidenceClass",
            "reachable",
            "framesRead",
            "authentication",
            "checks",
        ):
            self.assertIn(key, payload)
        for check in payload["checks"]:
            self.assertTrue({"name", "status"} <= set(check))


if __name__ == "__main__":
    unittest.main()
