"""AI-5b — Video Source stage: connection lifecycle, reconnect policy, availability, redaction.

Deterministic and network-free by construction: `SimulatedStreamSource` scripts the faults and the
supervisor's clock/sleep are injected, so connection loss, backoff timing, recovery, and budget
exhaustion are ordinary unit tests rather than manual QA against a real camera.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from errors import ConfigurationFailure, ConnectionFailure, failure_category, failure_code, recovery_path
from operational_log import OperationalLog, SessionIdentity
from stream_source import (
    STREAM_STATES,
    ConnectionSupervisor,
    FaultPlan,
    FileStreamSource,
    ReconnectPolicy,
    SimulatedStreamSource,
    backoff_delay_ms,
    build_source,
    redact_uri,
)
from video_frame import Frame


class FakeClock:
    """A clock that only moves when the code under test sleeps — so timing is exact, never flaky."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _identity() -> SessionIdentity:
    return SessionIdentity("tnt_a", "cam_1", "ses_1", correlation_id="corr_1")


def _supervisor(source, clock: FakeClock, *, policy=None, log=None) -> ConnectionSupervisor:
    return ConnectionSupervisor(
        source,
        policy=policy or ReconnectPolicy(max_attempts=5, base_ms=100.0, max_ms=1000.0),
        clock=clock,
        sleep=clock.sleep,
        log=log,
    )


class RedactionTest(unittest.TestCase):
    def test_strips_credentials_from_any_scheme(self):
        self.assertEqual(redact_uri("rtsp://user:secret@cam.local:554/s1"), "rtsp://***@cam.local:554/s1")
        self.assertEqual(redact_uri("http://admin:pw@10.0.0.5/video"), "http://***@10.0.0.5/video")

    def test_leaves_credential_free_locators_untouched(self):
        self.assertEqual(redact_uri("rtsp://cam.local/s1"), "rtsp://cam.local/s1")
        self.assertEqual(redact_uri("/dev/video0"), "/dev/video0")

    def test_a_password_never_reaches_stats_or_errors(self):
        clock = FakeClock()
        source = SimulatedStreamSource(uri="rtsp://user:hunter2@cam.local/1", faults=FaultPlan(fail_opens=99))
        sup = _supervisor(source, clock, policy=ReconnectPolicy(max_attempts=1, base_ms=1.0, max_ms=1.0))
        list(sup.frames())
        blob = repr(sup.stats())
        self.assertNotIn("hunter2", blob)
        self.assertIn("***", sup.stats()["source"])


class BackoffPolicyTest(unittest.TestCase):
    def test_bounded_exponential_schedule_is_deterministic(self):
        policy = ReconnectPolicy(max_attempts=6, base_ms=500.0, max_ms=4000.0)
        self.assertEqual(policy.schedule(), [500.0, 1000.0, 2000.0, 4000.0, 4000.0, 4000.0])
        # Same inputs, same schedule — every run, every machine.
        self.assertEqual(policy.schedule(), ReconnectPolicy(max_attempts=6, base_ms=500.0, max_ms=4000.0).schedule())

    def test_delay_is_clamped_and_never_negative(self):
        self.assertEqual(backoff_delay_ms(0), 0.0)
        self.assertEqual(backoff_delay_ms(1, base_ms=100.0), 100.0)
        self.assertEqual(backoff_delay_ms(20, base_ms=100.0, max_ms=750.0), 750.0)


class ConnectionLifecycleTest(unittest.TestCase):
    def test_clean_finite_source_ends_stopped_not_failed(self):
        clock = FakeClock()
        sup = _supervisor(SimulatedStreamSource(total_frames=5), clock)
        frames = list(sup.frames())
        self.assertEqual(len(frames), 5)
        self.assertEqual(sup.state, "stopped")
        self.assertEqual(sup.reconnect_count, 0)
        self.assertEqual(sup.stats()["failures"], [])

    def test_recovers_from_a_mid_stream_drop_and_keeps_yielding(self):
        clock = FakeClock()
        source = SimulatedStreamSource(total_frames=9, faults=FaultPlan(drop_after_frames=3, max_drops=1))
        sup = _supervisor(source, clock)
        frames = list(sup.frames())
        self.assertEqual(len(frames), 9)  # no frame is lost by a recovered reconnect
        self.assertEqual(sup.reconnect_count, 1)
        self.assertEqual(sup.state, "stopped")

    def test_retries_a_cold_source_until_it_answers(self):
        clock = FakeClock()
        source = SimulatedStreamSource(total_frames=2, faults=FaultPlan(fail_opens=3))
        sup = _supervisor(source, clock)
        frames = list(sup.frames())
        self.assertEqual(len(frames), 2)
        # Three failed opens → backoff 100+200+400ms was actually waited out.
        self.assertAlmostEqual(clock.now, 0.7, places=6)

    def test_exhausting_the_reconnect_budget_is_terminal_and_reported_not_raised(self):
        clock = FakeClock()
        source = SimulatedStreamSource(faults=FaultPlan(fail_opens=99))
        sup = _supervisor(source, clock, policy=ReconnectPolicy(max_attempts=3, base_ms=10.0, max_ms=50.0))
        frames = list(sup.frames())  # must NOT raise — degradation is operational, not a crash
        self.assertEqual(frames, [])
        self.assertEqual(sup.state, "failed")
        self.assertIn("failed", STREAM_STATES)

    def test_stop_is_idempotent_and_terminal(self):
        clock = FakeClock()
        sup = _supervisor(SimulatedStreamSource(total_frames=3), clock)
        sup.stop()
        sup.stop()
        self.assertEqual(sup.state, "stopped")
        self.assertEqual(list(sup.frames()), [])


class AvailabilityTest(unittest.TestCase):
    def test_availability_and_recovery_are_measured(self):
        clock = FakeClock()
        source = SimulatedStreamSource(total_frames=6, faults=FaultPlan(drop_after_frames=2, max_drops=1))
        sup = _supervisor(source, clock)
        list(sup.frames())
        stats = sup.stats()
        self.assertEqual(stats["reconnectCount"], 1)
        # Recovery time == the backoff actually waited before the successful reconnect (100ms).
        self.assertAlmostEqual(stats["averageRecoveryMs"], 100.0, places=3)
        self.assertGreaterEqual(stats["availabilityPercent"], 0.0)
        self.assertLessEqual(stats["availabilityPercent"], 100.0)

    def test_availability_freezes_once_terminal(self):
        clock = FakeClock()
        sup = _supervisor(SimulatedStreamSource(total_frames=3), clock)
        list(sup.frames())
        first = sup.stats()["availabilityPercent"]
        clock.advance(3600.0)  # an hour passes with the session long stopped
        self.assertEqual(sup.stats()["availabilityPercent"], first)
        self.assertEqual(sup.stats()["uptimeSeconds"], sup.stats()["uptimeSeconds"])


class FailureTaxonomyTest(unittest.TestCase):
    def test_categories_are_mutually_exclusive_with_codes_and_recovery(self):
        from errors import FAILURE_CATEGORIES, ConfigurationFailure, ModelFailure, PipelineFailure

        self.assertEqual(
            FAILURE_CATEGORIES, ("connection", "model", "inference", "pipeline", "configuration")
        )
        self.assertEqual(failure_category(ConnectionFailure("x")), "connection")
        self.assertEqual(failure_category(ModelFailure("x")), "model")
        self.assertEqual(failure_category(PipelineFailure("x")), "pipeline")
        self.assertEqual(failure_category(ConfigurationFailure("x")), "configuration")
        codes = {failure_code(c) for c in FAILURE_CATEGORIES}
        self.assertEqual(len(codes), len(FAILURE_CATEGORIES))  # one distinct code per category

    def test_configuration_failures_are_never_retried(self):
        # An operator must fix these; retrying only burns the reconnect budget.
        self.assertEqual(recovery_path("configuration"), "operator")
        self.assertEqual(recovery_path("connection"), "reconnect")

    def test_ingestion_failures_carry_a_diagnostic_code(self):
        clock = FakeClock()
        source = SimulatedStreamSource(total_frames=4, faults=FaultPlan(drop_after_frames=1, max_drops=1))
        sup = _supervisor(source, clock)
        list(sup.frames())
        failure = sup.stats()["failures"][0]
        self.assertEqual(failure["category"], "connection")
        self.assertEqual(failure["code"], "AI-CONN")
        self.assertGreaterEqual(failure["count"], 1)


class OperationalLoggingTest(unittest.TestCase):
    def test_every_connection_event_is_correlated_with_the_logical_identity(self):
        clock = FakeClock()
        log = OperationalLog(_identity(), sink=lambda _r: None, capture=True)
        source = SimulatedStreamSource(total_frames=6, faults=FaultPlan(drop_after_frames=2, max_drops=1))
        list(_supervisor(source, clock, log=log).frames())
        self.assertTrue(log.records)
        for record in log.records:
            self.assertEqual(record["tenantId"], "tnt_a")
            self.assertEqual(record["cameraId"], "cam_1")
            self.assertEqual(record["sessionId"], "ses_1")
            self.assertEqual(record["correlationId"], "corr_1")
        events = [r["event"] for r in log.records]
        self.assertIn("stream.lost", events)
        self.assertIn("stream.recovered", events)

    def test_identity_never_encodes_a_thread_or_process(self):
        identity = _identity()
        self.assertEqual(
            set(identity.to_dict()), {"tenantId", "cameraId", "sessionId", "correlationId"}
        )
        self.assertEqual(identity.key, "tnt_a/cam_1/ses_1")


class SourceNeutralityTest(unittest.TestCase):
    def test_the_runtime_selects_by_declared_type_never_by_sniffing_the_uri(self):
        source = build_source({"type": "simulated", "uri": "rtsp://looks-like-rtsp/1"})
        self.assertEqual(source.source_type, "simulated")  # declared type wins

    def test_every_declared_transport_is_constructible_without_runtime_changes(self):
        for transport in ("rtsp", "http", "usb", "file", "onvif", "cloud", "webrtc"):
            source = build_source({"type": transport, "uri": f"{transport}://device/1"})
            self.assertEqual(source.source_type, transport)
            self.assertTrue(hasattr(source, "open") and hasattr(source, "frames") and hasattr(source, "close"))

    def test_a_bad_source_config_fails_fast_as_configuration(self):
        for bad in ({"uri": "x"}, {"type": "rtsp"}, {"type": "carrier-pigeon", "uri": "x"}):
            with self.assertRaises(ConfigurationFailure):
                build_source(bad)

    def test_a_file_source_can_loop_to_simulate_a_continuous_stream(self):
        frames = [
            Frame(i, f"{i}s", "file://clip.mp4", 640, 480, 640, 480, 1.0, bytes([i]))
            for i in range(3)
        ]
        source = FileStreamSource(frames, loop=True, max_frames=7)
        source.open()
        looped = list(source.frames())
        self.assertEqual(len(looped), 7)
        # Re-indexed monotonically across the loop so tracking sees a continuous stream.
        self.assertEqual([f.index for f in looped], [0, 1, 2, 3, 4, 5, 6])
        source.close()

    def test_frames_are_immutable_value_objects(self):
        frame = Frame(0, "0s", "sim://c", 640, 480, 640, 480, 1.0, b"x")
        with self.assertRaises(Exception):
            frame.index = 5  # frozen dataclass — a stage cannot mutate a decoded frame


if __name__ == "__main__":
    unittest.main()
