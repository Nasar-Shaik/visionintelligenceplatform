"""AI-5e end-to-end: the certification procedure driving the REAL runtime.

The unit tests prove each piece. This file proves the pieces are actually wired — that the harness
observes a session started through the real `SessionSupervisor`, that the evidence class follows the
source the session was given, and that a runtime configured with none of AI-5e behaves exactly as it
did at AI-5d.

Determinism comes from the simulated source and the synchronous executor, not from freezing the clock:
a frozen clock makes the connection supervisor's backoff wait on a delta that never arrives.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from camera_registry import CameraRegistry, CameraRegistryEntry  # noqa: E402
from certification import (  # noqa: E402
    CapabilityAccumulator,
    CertificationBudget,
    CertificationHarness,
    CertificationTarget,
    Check,
    build_bundle,
    capability_report,
    evidence_for_source,
)
from compute import ComputeRegistry, ComputeResource  # noqa: E402
from maturity import MaturityEvidence, MaturityRegister  # noqa: E402
from resources import ResourceAccountant  # noqa: E402
from scheduler import InferenceScheduler, SchedulerPolicy  # noqa: E402
from session_runner import LiveSessionConfig, SessionSupervisor  # noqa: E402
from sessions import SessionManager  # noqa: E402
from soak import SoakPolicy, SoakRun  # noqa: E402
from stream_pipeline import PipelineOptions  # noqa: E402
from stream_source import FileStreamSource, ReconnectPolicy, SimulatedStreamSource  # noqa: E402
from video_analyzer import AnalyzeOptions, VideoAnalyzer  # noqa: E402
from video_decoder import StubFrameDecoder  # noqa: E402

AT = lambda: "2026-08-01T00:00:00.000Z"  # noqa: E731


class _Adapter:
    execution_provider = "stub"

    def load(self, ref: dict) -> None:
        return None

    def preprocess(self, ctx):  # noqa: ANN001
        return ctx

    def infer(self, prepared):  # noqa: ANN001
        return []

    def unload(self) -> None:
        return None


def _analyzer() -> VideoAnalyzer:
    return VideoAnalyzer(
        _Adapter(),
        AnalyzeOptions(tenant_id="tnt_cert", camera_id="cam_1", enable_behaviors=False),
        now_iso=AT,
    )


def _supervisor() -> SessionSupervisor:
    return SessionSupervisor(
        SessionManager(),
        max_sessions=4,
        scheduler=InferenceScheduler(
            ComputeRegistry([ComputeResource(id="cpu:0", kind="cpu", capacity_units=64.0)]),
            ResourceAccountant(),
            policy=SchedulerPolicy(reserved_capacity_percent=0.0, stabilization_samples=0),
            now_iso=AT,
        ),
    )


def _config(frames: int, source_type: str) -> LiveSessionConfig:
    return LiveSessionConfig(
        source={"type": source_type, "uri": "sim://cert", "options": {"totalFrames": frames}},
        analyze=AnalyzeOptions(tenant_id="tnt_cert", camera_id="cam_1", enable_behaviors=False),
        pipeline=PipelineOptions(queue_capacity=16, target_fps=5.0, source_fps=30.0),
        reconnect=ReconnectPolicy(max_attempts=2, base_ms=1.0, max_ms=5.0),
    )


def _run(source, source_type: str, frames: int = 20):
    """Start one real session and return (diagnostics, capability accumulator)."""
    supervisor = _supervisor()
    accumulator = CapabilityAccumulator(evidence_for_source(source_type))
    runner = supervisor.start(
        "tnt_cert",
        camera_id="cam_1",
        capability_id="playground.detect",
        config=_config(frames, source_type),
        analyzer=_analyzer(),
        source=source,
        on_result=accumulator,
        log_sink=lambda _r: None,
    )
    diagnostics = runner.diagnostics()
    supervisor.stop("tnt_cert", runner.identity.session_id)
    return diagnostics, accumulator


def _target(**kw) -> CertificationTarget:
    defaults = dict(id="generic-rtsp", label="Generic RTSP camera", manufacturer="Generic", model="RTSP")
    defaults.update(kw)
    return CertificationTarget(**defaults)


class HarnessWiringTest(unittest.TestCase):
    def test_the_harness_reads_a_real_sessions_diagnostics(self):
        diagnostics, _ = _run(SimulatedStreamSource(uri="sim://cert", total_frames=20), "simulated")
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(diagnostics)
        by_name = {c.name: c for c in harness.checks}
        self.assertEqual(by_name["connect"].status, "pass")
        self.assertEqual(by_name["stream-acquisition"].status, "pass")
        self.assertEqual(by_name["frame-accounting"].status, "pass")

    def test_a_real_run_over_a_simulated_source_is_never_certified(self):
        """The end-to-end form of the milestone's central rule. Everything works; nothing is proved."""
        diagnostics, _ = _run(SimulatedStreamSource(uri="sim://cert", total_frames=20), "simulated")
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(diagnostics)
        harness.record(Check(name="reconnect-recovery", status="pass", evidence_class="simulated"))
        harness.record(Check(name="clean-shutdown", status="pass", evidence_class="simulated"))
        summary = harness.summary()
        self.assertEqual(summary["status"], "pending-validation")
        self.assertTrue(any("physical hardware" in b for b in summary["blockers"]))

    def test_a_recorded_clip_is_stronger_evidence_than_a_simulation_but_still_not_hardware(self):
        frames = list(StubFrameDecoder.synthetic(20).decode())
        diagnostics, _ = _run(FileStreamSource(frames, uri="file://clip.mp4"), "file")
        harness = CertificationHarness(_target(id="recorded-mp4", label="Recorded MP4"), now_iso=AT)
        harness.observe_session(diagnostics, source_type="file")
        report = harness.compatibility_report()
        self.assertEqual(report["evidenceClass"], "recorded-footage")
        self.assertEqual(report["status"], "pending-validation")

    def test_a_budgeted_run_measures_against_the_budget(self):
        diagnostics, _ = _run(SimulatedStreamSource(uri="sim://cert", total_frames=20), "simulated")
        harness = CertificationHarness(
            _target(), budget=CertificationBudget(max_frame_loss_percent=1.0), now_iso=AT
        )
        harness.observe_session(diagnostics)
        check = {c.name: c for c in harness.checks}["frame-loss"]
        self.assertEqual(check.status, "pass")
        self.assertEqual(check.measured, 0.0)

    def test_the_capability_report_reflects_what_the_session_produced(self):
        _, accumulator = _run(SimulatedStreamSource(uri="sim://cert", total_frames=20), "simulated")
        report = capability_report("generic-rtsp", accumulator.observations(), now_iso=AT)
        self.assertEqual(report["evidenceClass"], "simulated")
        self.assertTrue(report["observations"])

    def test_no_credential_reaches_the_diagnostics_of_a_credentialed_source(self):
        source = SimulatedStreamSource(uri="rtsp://admin:hunter2@cam.local/s", total_frames=10)
        diagnostics, _ = _run(source, "simulated")
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(diagnostics, secret="hunter2")
        self.assertEqual(
            {c.name: c.status for c in harness.checks}["credential-redaction"], "pass"
        )


class BundleWiringTest(unittest.TestCase):
    def test_a_full_bundle_is_produced_from_one_run(self):
        diagnostics, accumulator = _run(
            SimulatedStreamSource(uri="sim://cert", total_frames=20), "simulated"
        )
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(diagnostics)
        harness.seed_manual_checks()
        compatibility = harness.compatibility_report()
        capability = capability_report("generic-rtsp", accumulator.observations(), now_iso=AT)
        soak = SoakRun("generic-rtsp", policy=SoakPolicy(planned_hours=0.0), now_iso=AT).report()
        summary = harness.summary(
            compatibility_id=compatibility["id"], capability_id=capability["id"], soak_id=soak["id"]
        )
        bundle = build_bundle(
            summary,
            compatibility=compatibility,
            capability=capability,
            soak=soak,
            configuration={"source": {"uri": "rtsp://admin:hunter2@cam.local/s"}},
            now_iso=AT,
        )
        self.assertEqual(bundle["summary"]["status"], "pending-validation")
        self.assertNotIn("hunter2", repr(bundle["configuration"]))
        for key in ("compatibility", "capability", "soak"):
            self.assertIn(key, bundle)


class PromotionWiringTest(unittest.TestCase):
    def test_a_simulated_run_promotes_nothing(self):
        """The whole chain, end to end: run → reports → promotion request → refusal."""
        diagnostics, accumulator = _run(
            SimulatedStreamSource(uri="sim://cert", total_frames=20), "simulated"
        )
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(diagnostics)
        harness.seed_manual_checks()
        summary = harness.summary(compatibility_id="compat_1")

        register = MaturityRegister({"person-detection": "beta"})
        decision = register.request(
            "person-detection",
            "production",
            MaturityEvidence(
                evidence_class=summary["evidenceClass"],
                compatibility_report_id="compat_1",
                certification_summary_id=summary["id"],
                certification_status=summary["status"],
            ),
            now_iso=AT,
        )
        self.assertFalse(decision.granted)
        self.assertEqual(register.level("person-detection"), "beta")
        self.assertTrue(any("hardware evidence" in b for b in decision.blockers))
        self.assertTrue(any("not 'certified'" in b for b in decision.blockers))

    def test_the_registry_stays_pending_after_a_simulated_certification(self):
        registry = CameraRegistry(tempfile.mkdtemp())
        registry.add(CameraRegistryEntry(id="generic-rtsp", manufacturer="Generic", model="RTSP"))
        diagnostics, _ = _run(SimulatedStreamSource(uri="sim://cert", total_frames=20), "simulated")
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(diagnostics)
        harness.seed_manual_checks()
        entry = registry.certify("generic-rtsp", harness.summary())
        self.assertEqual(entry.status, "pending-validation")
        self.assertEqual(entry.evidence, [])


class AdditivityTest(unittest.TestCase):
    def test_a_runtime_with_no_certification_attached_is_unchanged(self):
        """AI-5e must be entirely additive: nothing here changes how a session runs. The harness is
        an OBSERVER — a session started without one behaves exactly as it did at AI-5d."""
        with_observer, _ = _run(SimulatedStreamSource(uri="sim://cert", total_frames=20), "simulated")
        supervisor = _supervisor()
        runner = supervisor.start(
            "tnt_cert",
            camera_id="cam_1",
            capability_id="playground.detect",
            config=_config(20, "simulated"),
            analyzer=_analyzer(),
            source=SimulatedStreamSource(uri="sim://cert", total_frames=20),
            log_sink=lambda _r: None,
        )
        without = runner.diagnostics()
        supervisor.stop("tnt_cert", runner.identity.session_id)
        self.assertEqual(
            with_observer["backpressure"]["framesProcessed"],
            without["backpressure"]["framesProcessed"],
        )
        self.assertEqual(
            with_observer["ingestion"]["framesRead"], without["ingestion"]["framesRead"]
        )


if __name__ == "__main__":
    unittest.main()
