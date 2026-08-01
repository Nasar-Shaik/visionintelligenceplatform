"""Staged stream-validation probe tests (P-2, deepened in P-2.1).

Deterministic throughout: the resolver, the connector, the source builder and the clock are all
injected, so the suite opens no socket, resolves no name and never sleeps. A test that wants a DNS or
TCP failure supplies its own stub — which is also how we know those seams exist.

The tests that matter most are the **failure taxonomy** ones. Each failure mode must produce exactly
one code, and the codes must not overlap: the console picks a single remedy from it, and an installer
sent to the wrong end of a building loses an afternoon.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from errors import ConfigurationFailure, ConnectionFailure  # noqa: E402
from stream_probe import CHECK_ORDER, PROBE_VERSION, probe_stream, split_endpoint  # noqa: E402
from stream_source import FaultPlan, SimulatedStreamSource  # noqa: E402

AT = lambda: "2026-08-01T10:00:00.000Z"  # noqa: E731

URI = "rtsp://cam.local:554/sub"


def ok_resolve(_host):
    """A resolver that always succeeds — no DNS in the unit suite."""
    return ["10.0.0.64"]


def ok_connect(_host, _port, _timeout):
    """A connector that always succeeds — no socket in the unit suite."""
    return None


class FakeClock:
    """Advances a fixed step on every read — turns stage timings into predictable numbers."""

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


def probe(config=None, **kwargs):
    """`probe_stream` with every network seam stubbed unless the test overrides it."""
    kwargs.setdefault("resolve", ok_resolve)
    kwargs.setdefault("connect", ok_connect)
    kwargs.setdefault("now", AT)
    kwargs.setdefault("clock", FakeClock())
    kwargs.setdefault("build", sim(total_frames=10))
    return probe_stream(config if config is not None else {"type": "rtsp", "uri": URI}, **kwargs)


def statuses(report):
    return {c.name: c.status for c in report.checks}


class Refusing:
    """A device that opens with a given error."""

    source_type = "rtsp"

    def __init__(self, message):
        self.message = message

    def open(self):
        raise ConnectionFailure(self.message)

    def frames(self):  # pragma: no cover - never reached
        yield None

    def close(self):
        pass


class Interrupted:
    """A device that serves a couple of frames and then drops."""

    source_type = "rtsp"

    def __init__(self, count=2):
        self.count = count

    def open(self):
        return None

    def frames(self):
        inner = SimulatedStreamSource(uri="sim://camera", total_frames=self.count)
        inner.open()
        for frame in inner.frames():
            yield frame
        raise ConnectionFailure("stream read failed after 2 frames")

    def close(self):
        pass


class TestEndpointParsing(unittest.TestCase):
    def test_extracts_scheme_host_and_port(self):
        self.assertEqual(split_endpoint("rtsp://cam.local:554/sub"), ("rtsp", "cam.local", 554))

    def test_applies_the_default_port_per_scheme(self):
        self.assertEqual(split_endpoint("rtsp://cam.local/sub")[2], 554)
        self.assertEqual(split_endpoint("rtmp://cam.local/live")[2], 1935)
        self.assertEqual(split_endpoint("https://cam.local/snap")[2], 443)

    def test_never_returns_userinfo(self):
        # The URI the probe is handed is credentialed. Leaking that into a report or a log is the
        # failure this function exists to prevent.
        scheme, host, port = split_endpoint("rtsp://admin:hunter2@cam.local:554/sub")
        self.assertEqual((scheme, host, port), ("rtsp", "cam.local", 554))

    def test_a_source_with_no_authority_has_no_host(self):
        self.assertEqual(split_endpoint("/footage/lobby.mp4"), ("", None, None))


class TestWorkingStream(unittest.TestCase):
    def test_reports_every_stage_it_performed(self):
        report = probe(frames=3, clock=FakeClock(step=0.1))
        self.assertTrue(report.reachable)
        self.assertEqual(report.frames_read, 3)
        self.assertEqual(report.resolution, "1920x1080")
        checks = statuses(report)
        self.assertEqual(checks["dns"], "pass")
        self.assertEqual(checks["tcp"], "pass")
        self.assertEqual(checks["stream-open"], "pass")
        self.assertEqual(checks["first-frame"], "pass")
        self.assertEqual(checks["frames-received"], "pass")
        self.assertIsNone(report.failure_code)

    def test_every_stage_in_the_contract_order_is_always_present(self):
        """A missing stage and a passing stage must never be indistinguishable in the UI."""
        report = probe()
        self.assertEqual([c.name for c in report.checks], list(CHECK_ORDER))

    def test_each_stage_carries_its_own_duration(self):
        """Total probe time alone cannot tell you WHICH step is slow (Architect P-2.1 rec 1)."""
        report = probe(frames=3, clock=FakeClock(step=0.1))
        timed = {c.name: c.duration_ms for c in report.checks if c.duration_ms is not None}
        for stage in ("dns", "tcp", "stream-open", "first-frame", "frames-received"):
            self.assertIn(stage, timed)
            self.assertGreater(timed[stage], 0)
        self.assertIsNotNone(report.total_ms)

    def test_frame_rate_is_measured_from_arrivals_not_declared(self):
        # 100 ms between frames → 10 fps, regardless of what any capability claims.
        report = probe(
            {"type": "rtsp", "uri": URI, "capabilities": {"fpsRange": {"min": 25, "max": 25}}},
            frames=4,
            clock=FakeClock(step=0.1),
        )
        self.assertAlmostEqual(report.fps, 10.0, delta=0.5)
        self.assertAlmostEqual(report.jitter_ms, 0.0, delta=1.0)

    def test_a_single_frame_does_not_produce_a_frame_rate(self):
        report = probe(frames=1)
        self.assertEqual(report.frames_read, 1)
        self.assertIsNone(report.fps)
        self.assertEqual(statuses(report)["fps"], "not-executed")

    def test_a_slow_stream_warns_without_failing(self):
        report = probe(frames=3, clock=FakeClock(step=2.0))  # one frame every 2s → 0.5 fps
        self.assertEqual(statuses(report)["fps"], "warn")
        self.assertTrue(report.warnings)
        self.assertIsNone(report.failure_code)

    def test_a_requested_profile_the_device_does_not_advertise_warns(self):
        report = probe(
            {
                "type": "rtsp",
                "uri": URI,
                "streamProfile": "sub",
                "capabilities": {"streamProfiles": [{"name": "main"}]},
            }
        )
        self.assertEqual(statuses(report)["stream-profile"], "warn")


class TestFailureTaxonomy(unittest.TestCase):
    """One code per failure, and the codes must not overlap (Architect P-2.1 rec 8)."""

    def test_a_name_that_does_not_resolve_is_a_dns_failure(self):
        def failing_resolve(_host):
            raise OSError("Name or service not known")

        report = probe(resolve=failing_resolve)
        checks = statuses(report)
        self.assertEqual(report.failure_code, "dns-failure")
        self.assertEqual(checks["dns"], "fail")
        # Everything downstream was never attempted — including TCP, which is the point: sending an
        # installer to check cabling for a DNS problem wastes the visit.
        self.assertEqual(checks["tcp"], "not-executed")
        self.assertEqual(checks["stream-open"], "not-executed")

    def test_a_resolved_name_with_nothing_listening_is_a_tcp_failure(self):
        def failing_connect(_host, _port, _timeout):
            raise OSError("Connection refused")

        report = probe(connect=failing_connect)
        checks = statuses(report)
        self.assertEqual(report.failure_code, "tcp-failure")
        self.assertEqual(checks["dns"], "pass")
        self.assertEqual(checks["tcp"], "fail")
        self.assertEqual(checks["authentication"], "not-executed")

    def test_a_rejected_credential_is_an_authentication_failure(self):
        report = probe(build=lambda _c: Refusing("cannot open source: 401 Unauthorized"))
        checks = statuses(report)
        self.assertEqual(report.failure_code, "authentication-failure")
        self.assertEqual(report.authentication, "failed")
        # DNS and TCP both passed, so the device is demonstrably there.
        self.assertEqual(checks["dns"], "pass")
        self.assertEqual(checks["tcp"], "pass")
        self.assertEqual(checks["authentication"], "fail")
        self.assertEqual(checks["stream-open"], "not-executed")

    def test_a_device_that_will_not_serve_this_stream_is_a_negotiation_failure(self):
        report = probe(build=lambda _c: Refusing("DESCRIBE failed: 455 Method Not Valid"))
        checks = statuses(report)
        # Present, authenticated, and refusing this particular stream — usually a wrong path or a
        # profile the camera cannot encode. A different fix from either of its neighbours.
        self.assertEqual(report.failure_code, "rtsp-negotiation-failure")
        self.assertEqual(checks["rtsp-negotiation"], "fail")
        self.assertEqual(checks["stream-open"], "not-executed")

    def test_a_stream_that_opens_and_never_yields_is_a_timeout(self):
        report = probe(build=sim(total_frames=0))
        checks = statuses(report)
        self.assertEqual(report.failure_code, "timeout")
        self.assertEqual(checks["stream-open"], "pass")
        self.assertEqual(checks["first-frame"], "fail")

    def test_a_stream_that_drops_before_the_first_frame_is_no_first_frame(self):
        report = probe(build=lambda _c: Interrupted(count=0))
        self.assertEqual(report.failure_code, "no-first-frame")

    def test_an_unusable_configuration_fails_before_anything_is_dialled(self):
        def build(_config):
            raise ConfigurationFailure("source.uri is required")

        report = probe({"type": "rtsp"}, build=build)
        self.assertEqual(report.failure_code, "configuration-invalid")
        self.assertFalse(report.reachable)

    def test_a_successful_probe_carries_no_failure_code(self):
        self.assertIsNone(probe().failure_code)

    def test_exactly_one_stage_ever_fails(self):
        """Mutually exclusive in practice, not just in the enum."""
        cases = [
            {"resolve": lambda _h: (_ for _ in ()).throw(OSError("no such host"))},
            {"connect": lambda _h, _p, _t: (_ for _ in ()).throw(OSError("refused"))},
            {"build": lambda _c: Refusing("401 Unauthorized")},
            {"build": lambda _c: Refusing("DESCRIBE failed: 455")},
            {"build": sim(total_frames=0)},
        ]
        for kwargs in cases:
            with self.subTest(kwargs=list(kwargs)):
                report = probe(**kwargs)
                failed = [c.name for c in report.checks if c.status == "fail"]
                self.assertEqual(len(failed), 1, failed)
                self.assertIn(report.failure_code, ("dns-failure", "tcp-failure",
                                                    "authentication-failure",
                                                    "rtsp-negotiation-failure", "timeout"))


class TestPartialSuccess(unittest.TestCase):
    def test_a_stream_interrupted_after_some_frames_still_reports_what_it_measured(self):
        report = probe(build=lambda _c: Interrupted(count=2), frames=5)
        # Two frames is proof the camera works. Discarding that because the third never arrived
        # would throw away the only evidence the probe actually obtained.
        self.assertEqual(report.frames_read, 2)
        self.assertEqual(statuses(report)["first-frame"], "pass")
        self.assertEqual(statuses(report)["frames-received"], "warn")
        self.assertIsNone(report.failure_code)
        self.assertTrue(report.warnings)


class TestProtocolNeutrality(unittest.TestCase):
    """Stages are selected per transport (Architect P-2.1 rec 9)."""

    def test_a_non_negotiated_transport_skips_rtsp_negotiation(self):
        report = probe({"type": "http", "uri": "http://cam.local/mjpg"})
        # `skipped` says this transport has no such step — distinct from "the probe gave up on it".
        self.assertEqual(statuses(report)["rtsp-negotiation"], "skipped")
        self.assertEqual(statuses(report)["dns"], "pass")

    def test_a_file_source_skips_every_network_stage(self):
        report = probe({"type": "file", "uri": "/footage/lobby.mp4"})
        checks = statuses(report)
        for stage in ("dns", "tcp", "authentication", "rtsp-negotiation"):
            self.assertEqual(checks[stage], "skipped", stage)
        self.assertEqual(checks["frames-received"], "pass")

    def test_adding_a_transport_does_not_change_the_stage_list(self):
        # The contract the camera lifecycle depends on: every probe answers the same stage names.
        for uri, kind in (
            ("rtsp://cam.local/sub", "rtsp"),
            ("http://cam.local/mjpg", "http"),
            ("/footage/lobby.mp4", "file"),
        ):
            with self.subTest(kind=kind):
                report = probe({"type": kind, "uri": uri})
                self.assertEqual([c.name for c in report.checks], list(CHECK_ORDER))


class TestEvidence(unittest.TestCase):
    """Every probe preserves what produced it (Architect P-2.1 rec 4)."""

    def test_carries_its_own_version_and_provenance(self):
        report = probe(
            {
                "type": "rtsp",
                "uri": URI,
                "configVersion": "cfg-abc123",
                "operator": "usr_7",
                "correlationId": "corr-9",
            },
            runtime_version="0.1.0",
        )
        self.assertEqual(report.probe_version, PROBE_VERSION)
        self.assertEqual(report.runtime_version, "0.1.0")
        self.assertEqual(report.config_version, "cfg-abc123")
        self.assertEqual(report.operator, "usr_7")
        self.assertEqual(report.correlation_id, "corr-9")

    def test_authentication_is_not_claimed_when_no_credentials_were_offered(self):
        """Opening an unauthenticated stream proves nothing about credentials — say so."""
        report = probe()
        self.assertEqual(report.authentication, "unknown")
        self.assertEqual(statuses(report)["authentication"], "not-executed")

    def test_credentialed_success_records_that_the_device_accepted_them(self):
        report = probe({"type": "rtsp", "uri": URI, "_credentialed": True})
        self.assertEqual(report.authentication, "ok")
        self.assertEqual(statuses(report)["authentication"], "pass")

    def test_the_codec_is_reported_as_declared_and_never_invented(self):
        declared = probe({"type": "rtsp", "uri": URI, "capabilities": {"codecs": ["h265"]}})
        self.assertEqual(declared.codec, "h265")
        codec_check = next(c for c in declared.checks if c.name == "codec")
        self.assertIn("declared", codec_check.detail or "")

        undeclared = probe()
        self.assertIsNone(undeclared.codec)
        self.assertEqual(statuses(undeclared)["codec"], "not-executed")

    def test_a_credentialed_uri_never_reaches_the_report(self):
        leaky = "cannot open source: rtsp://admin:hunter2@cam.local/sub"
        report = probe(build=lambda _c: Refusing(leaky))
        serialized = str(report.to_dict())
        self.assertNotIn("hunter2", serialized)
        self.assertNotIn("admin", serialized)


class TestEvidenceClass(unittest.TestCase):
    def test_a_flawless_simulated_probe_is_not_hardware_evidence(self):
        """The sibling of `test_a_flawless_simulated_run_is_still_not_certified` (AI-5e).

        Nothing about this probe fails. Every stage passes, the frame rate is perfect, the resolution
        is 1080p. It is still `simulated`, and the camera service refuses to call the camera
        `connected` on it. If this test is ever "fixed" by promoting the evidence class, a demo
        environment will report a fully connected estate that does not physically exist.
        """
        report = probe(
            {"type": "simulated", "uri": "sim://camera"},
            frames=5,
            build=sim(total_frames=20),
            clock=FakeClock(step=0.04),
        )
        self.assertTrue(report.reachable)
        self.assertEqual(report.frames_read, 5)
        self.assertEqual([c.name for c in report.checks if c.status == "fail"], [])
        self.assertEqual(report.evidence_class, "simulated")

    def test_recorded_footage_is_stronger_than_simulation_and_still_not_hardware(self):
        report = probe({"type": "file", "uri": "/footage/lobby.mp4"})
        self.assertEqual(report.evidence_class, "recorded-footage")

    def test_a_real_transport_yields_hardware_evidence(self):
        for source_type in ("rtsp", "onvif", "usb"):
            with self.subTest(source_type=source_type):
                report = probe({"type": source_type, "uri": URI})
                self.assertEqual(report.evidence_class, "hardware")


class TestWireShape(unittest.TestCase):
    def test_matches_the_contract(self):
        payload = probe().to_dict()
        for key in (
            "probedAt",
            "probeVersion",
            "evidenceClass",
            "reachable",
            "framesRead",
            "authentication",
            "checks",
            "totalMs",
        ):
            self.assertIn(key, payload)
        for check in payload["checks"]:
            self.assertTrue({"name", "status"} <= set(check))

    def test_a_failed_probe_names_its_failure_on_the_wire(self):
        payload = probe(build=sim(total_frames=0)).to_dict()
        # The server names the failure; the console renders it. A UI inferring "probably credentials"
        # from prose is business logic in the wrong tier (Architect P-2.1 rec 10).
        self.assertEqual(payload["failureCode"], "timeout")


if __name__ == "__main__":
    unittest.main()
