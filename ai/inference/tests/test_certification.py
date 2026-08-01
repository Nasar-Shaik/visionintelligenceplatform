"""AI-5e certification harness tests.

The harness exists to stop the platform claiming what it has not measured, so most of these tests
assert what it REFUSES. The load-bearing one is `EvidenceClassTest.test_a_flawless_simulated_run_is_
still_not_certified` — a negative control on the single rule the whole milestone rests on. If that
test can be deleted without anything else failing, the framework can certify itself from its own
simulations, and every certification the platform ever issues becomes worthless.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from certification import (  # noqa: E402
    CapabilityAccumulator,
    CertificationBudget,
    CertificationHarness,
    CertificationTarget,
    Check,
    build_bundle,
    capability_report,
    evidence_for_source,
    is_hardware,
    redact_config,
    weakest,
)

AT = lambda: "2026-08-01T00:00:00.000Z"  # noqa: E731 - a fixed stamp keeps reports byte-comparable


def _target(**kw) -> CertificationTarget:
    defaults = dict(id="test-cam", label="Test camera", manufacturer="Acme", model="X1")
    defaults.update(kw)
    return CertificationTarget(**defaults)


def _diagnostics(*, source_type="rtsp", frames=100, dropped=0, skipped=20, uri="rtsp://cam.local/s"):
    return {
        "identity": {"tenantId": "tnt_a", "cameraId": "cam_1", "sessionId": "sess_1"},
        "state": "running",
        "ingestion": {
            "state": "connected",
            "sourceType": source_type,
            "source": uri,
            "framesRead": frames,
            "reconnectCount": 0,
            "availabilityPercent": 100.0,
            "connectedAt": AT(),
            "failures": [],
        },
        "backpressure": {
            "framesSkipped": skipped,
            "framesDropped": dropped,
            "framesProcessed": frames,
            "queueCapacity": 32,
            "queueDepth": 0,
        },
        "restartCount": 0,
    }


def _complete(harness: CertificationHarness, evidence: str) -> None:
    """Supply the two checks only a human standing at the device can make."""
    harness.record(Check(name="reconnect-recovery", status="pass", evidence_class=evidence, measured=4.2, unit="s"))
    harness.record(Check(name="clean-shutdown", status="pass", evidence_class=evidence))


class EvidenceClassTest(unittest.TestCase):
    def test_source_types_map_to_evidence(self):
        self.assertEqual(evidence_for_source("simulated"), "simulated")
        self.assertEqual(evidence_for_source("file"), "recorded-footage")
        for live in ("rtsp", "onvif", "usb", "http"):
            self.assertEqual(evidence_for_source(live), "hardware")

    def test_an_unknown_source_is_treated_as_simulated(self):
        # The conservative direction. Guessing upward here is the one mistake that invalidates
        # everything downstream.
        self.assertEqual(evidence_for_source("teleporter"), "simulated")

    def test_weakest_wins(self):
        self.assertEqual(weakest(["hardware", "simulated"]), "simulated")
        self.assertEqual(weakest(["hardware", "recorded-footage"]), "recorded-footage")
        self.assertEqual(weakest(["hardware"]), "hardware")
        self.assertEqual(weakest([]), "simulated")

    def test_a_flawless_simulated_run_is_still_not_certified(self):
        """The negative control for the entire milestone.

        Every check passes. The report is complete. The status is still `pending-validation`, because
        no hardware was involved. If this ever returns `certified`, the framework can certify itself
        from its own simulations."""
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(source_type="simulated", uri="sim://cam"))
        _complete(harness, "simulated")
        report = harness.compatibility_report()
        self.assertTrue(all(c["status"] in ("pass", "skipped") for c in report["checks"]))
        self.assertEqual(report["evidenceClass"], "simulated")
        self.assertEqual(report["status"], "pending-validation")

    def test_the_same_checks_on_hardware_do_certify(self):
        # The positive control: the rule refuses simulation, it does not refuse everything.
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(source_type="rtsp"))
        _complete(harness, "hardware")
        report = harness.compatibility_report()
        self.assertEqual(report["evidenceClass"], "hardware")
        self.assertEqual(report["status"], "certified")

    def test_one_simulated_check_downgrades_a_hardware_report(self):
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(source_type="rtsp"))
        _complete(harness, "hardware")
        harness.record(Check(name="thermal", status="pass", evidence_class="simulated"))
        report = harness.compatibility_report()
        self.assertEqual(report["evidenceClass"], "simulated")
        self.assertEqual(report["status"], "pending-validation")


class ChecksTest(unittest.TestCase):
    def test_a_check_rejects_an_unknown_status(self):
        with self.assertRaises(ValueError):
            Check(name="x", status="probably-fine", evidence_class="hardware")

    def test_a_check_rejects_an_unknown_evidence_class(self):
        with self.assertRaises(ValueError):
            Check(name="x", status="pass", evidence_class="vibes")

    def test_not_executed_blocks_but_warn_does_not(self):
        self.assertTrue(Check(name="a", status="not-executed", evidence_class="hardware").blocking)
        self.assertTrue(Check(name="b", status="skipped", evidence_class="hardware").blocking)
        self.assertFalse(Check(name="c", status="warn", evidence_class="hardware").blocking)
        self.assertFalse(
            Check(name="d", status="fail", evidence_class="hardware", mandatory=False).blocking
        )

    def test_recording_the_same_check_replaces_it(self):
        # An operator supplying a real measurement must overwrite the placeholder, not sit beside it.
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.not_executed("reconnect-recovery", "needs a cable pull")
        harness.record(
            Check(name="reconnect-recovery", status="pass", evidence_class="hardware", measured=3.0)
        )
        names = [c.name for c in harness.checks]
        self.assertEqual(names.count("reconnect-recovery"), 1)
        self.assertEqual(harness.checks[0].status, "pass")


class ObservationTest(unittest.TestCase):
    def test_a_source_that_connects_but_delivers_nothing_fails_acquisition_only(self):
        """The most common real-world failure — wrong profile path, a codec the decoder refuses —
        and the two checks have to disagree about it. `connect` passing while `stream-acquisition`
        fails is precisely the diagnosis an installer needs: the network is fine, the stream is not."""
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(frames=0))
        by_name = {c.name: c for c in harness.checks}
        self.assertEqual(by_name["connect"].status, "pass")
        self.assertEqual(by_name["stream-acquisition"].status, "fail")

    def test_a_source_that_never_opened_fails_connect(self):
        diagnostics = _diagnostics(frames=0)
        diagnostics["ingestion"].pop("connectedAt")
        diagnostics["ingestion"]["state"] = "failed"
        diagnostics["ingestion"]["lastError"] = "cannot open source: rtsp://cam.local/s"
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(diagnostics)
        self.assertEqual({c.name: c.status for c in harness.checks}["connect"], "fail")

    def test_a_session_that_connected_then_dropped_still_passes_connect(self):
        diagnostics = _diagnostics()
        diagnostics["ingestion"]["state"] = "reconnecting"
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(diagnostics)
        self.assertEqual({c.name: c.status for c in harness.checks}["connect"], "pass")

    def test_an_inline_credential_in_the_uri_fails_redaction(self):
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(uri="rtsp://admin:hunter2@cam.local/s"))
        check = {c.name: c for c in harness.checks}["credential-redaction"]
        self.assertEqual(check.status, "fail")

    def test_a_redacted_uri_passes_redaction(self):
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(uri="rtsp://***@cam.local/s"))
        self.assertEqual({c.name: c.status for c in harness.checks}["credential-redaction"], "pass")

    def test_a_secret_hiding_in_a_nested_error_is_caught(self):
        diagnostics = _diagnostics()
        diagnostics["ingestion"]["failures"] = [
            {"category": "connection", "lastError": "auth failed for hunter2"}
        ]
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(diagnostics, secret="hunter2")
        self.assertEqual({c.name: c.status for c in harness.checks}["credential-redaction"], "fail")

    def test_frame_accounting_requires_sampling_and_loss_to_stay_separate(self):
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics())
        self.assertEqual({c.name: c.status for c in harness.checks}["frame-accounting"], "pass")

        conflated = _diagnostics()
        conflated["backpressure"].pop("framesSkipped")
        other = CertificationHarness(_target(), now_iso=AT)
        other.observe_session(conflated)
        check = {c.name: c for c in other.checks}["frame-accounting"]
        self.assertEqual(check.status, "fail")
        self.assertIn("framesSkipped", check.detail)

    def test_a_multi_profile_device_with_no_preference_warns_but_does_not_block(self):
        caps = {
            "streamProfiles": [
                {"name": "main", "resolution": "1920x1080"},
                {"name": "sub", "resolution": "640x360"},
            ]
        }
        harness = CertificationHarness(_target(capabilities=caps), now_iso=AT)
        harness.observe_session(_diagnostics(), capabilities=caps)
        check = {c.name: c for c in harness.checks}["stream-profile-selection"]
        self.assertEqual(check.status, "warn")
        self.assertFalse(check.blocking)

    def test_a_declared_sub_stream_is_selected_and_reported(self):
        caps = {
            "streamProfiles": [
                {"name": "main", "resolution": "1920x1080"},
                {"name": "sub", "resolution": "640x360", "preferredForAnalysis": True},
            ]
        }
        harness = CertificationHarness(_target(capabilities=caps), now_iso=AT)
        harness.observe_session(_diagnostics(), capabilities=caps)
        _complete(harness, "hardware")
        report = harness.compatibility_report()
        self.assertEqual(report["selectedProfile"], "sub")

    def test_fps_outside_the_declared_range_is_reported(self):
        caps = {"fpsRange": {"min": 1, "max": 10}}
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(), capabilities=caps, requested_fps=25.0)
        check = {c.name: c for c in harness.checks}["fps-within-declared-range"]
        self.assertEqual(check.status, "fail")

    def test_budget_checks_run_only_when_a_budget_constrains_them(self):
        bare = CertificationHarness(_target(), now_iso=AT)
        bare.observe_session(_diagnostics(), kpis={"fps": 4.0})
        self.assertNotIn("sustained-fps", {c.name for c in bare.checks})

        budgeted = CertificationHarness(
            _target(), budget=CertificationBudget(min_sustained_fps=5.0), now_iso=AT
        )
        budgeted.observe_session(_diagnostics(), kpis={"fps": 4.0})
        check = {c.name: c for c in budgeted.checks}["sustained-fps"]
        self.assertEqual(check.status, "fail")
        self.assertEqual(check.measured, 4.0)

    def test_frame_loss_excludes_sampling_from_the_denominator(self):
        # 5 dropped of 105 offered = 4.76%. If the 20 skipped frames were folded in the answer would
        # be 4.0% — which would quietly re-create the conflation the accounting check forbids.
        harness = CertificationHarness(
            _target(), budget=CertificationBudget(max_frame_loss_percent=10.0), now_iso=AT
        )
        harness.observe_session(_diagnostics(frames=100, dropped=5, skipped=20))
        check = {c.name: c for c in harness.checks}["frame-loss"]
        self.assertAlmostEqual(check.measured, 4.7619, places=3)


class BlockersTest(unittest.TestCase):
    def test_blockers_name_the_missing_physical_checks(self):
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(source_type="rtsp"))
        harness.seed_manual_checks()
        blockers = harness.blockers()
        self.assertTrue(any("reconnect-recovery" in b for b in blockers))
        self.assertTrue(any("clean-shutdown" in b for b in blockers))

    def test_a_certified_summary_has_no_blockers(self):
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(source_type="rtsp"))
        _complete(harness, "hardware")
        summary = harness.summary()
        self.assertEqual(summary["status"], "certified")
        self.assertEqual(summary["blockers"], [])

    def test_an_external_blocker_prevents_certification(self):
        # A failed soak arrives as an extra blocker; the compatibility checks know nothing about it,
        # so the summary has to be the thing that refuses.
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(source_type="rtsp"))
        _complete(harness, "hardware")
        summary = harness.summary(extra_blockers=["soak: memoryMb drifted +38%"])
        self.assertNotEqual(summary["status"], "certified")
        self.assertIn("soak: memoryMb drifted +38%", summary["blockers"])

    def test_check_counts_are_reported(self):
        harness = CertificationHarness(_target(), now_iso=AT)
        harness.observe_session(_diagnostics(source_type="rtsp"))
        _complete(harness, "hardware")
        summary = harness.summary()
        self.assertEqual(summary["checksTotal"], len(harness.checks))
        self.assertEqual(summary["checksFailed"], 0)


class _Frame:
    def __init__(self, detections=(), tracks=(), behaviors=(), composites=(), events=()):
        self.detections = list(detections)
        self.tracks = list(tracks)
        self.behaviors = list(behaviors)
        self.composites = list(composites)
        self.events = list(events)


class CapabilityAccumulatorTest(unittest.TestCase):
    def test_a_behavior_spanning_many_frames_counts_once(self):
        acc = CapabilityAccumulator("recorded-footage")
        for _ in range(50):
            acc(_Frame(behaviors=[{"behaviorId": "bh_1", "behaviorType": "loitering"}]))
        observation = {o.capability_id: o for o in acc.observations()}["loitering"]
        self.assertEqual(observation.behaviors, 1)

    def test_detections_are_counted_per_label(self):
        acc = CapabilityAccumulator("hardware")
        acc(_Frame(detections=[{"label": "person"}, {"label": "person"}, {"label": "vehicle"}]))
        by_id = {o.capability_id: o for o in acc.observations()}
        self.assertEqual(by_id["detection.person"].detections, 2)
        self.assertEqual(by_id["detection.vehicle"].detections, 1)
        self.assertEqual(by_id["detection.person"].event_type, "perception.person.detected")

    def test_tracks_are_counted_by_identity_not_by_frame(self):
        acc = CapabilityAccumulator()
        for _ in range(20):
            acc(_Frame(tracks=[{"trackId": "tr_1"}, {"trackId": "tr_2"}]))
        self.assertEqual(acc.tracks, 2)

    def test_a_session_where_nothing_fired_reports_that_as_a_finding(self):
        # Silence is a result. An empty observation list would be quietly discarded by every consumer.
        acc = CapabilityAccumulator()
        for _ in range(10):
            acc(_Frame())
        observations = acc.observations()
        self.assertEqual(observations[0].capability_id, "none-exercised")
        self.assertEqual(observations[0].checks[0].status, "fail")

    def test_capability_report_takes_the_weakest_evidence(self):
        acc = CapabilityAccumulator("recorded-footage")
        acc(_Frame(detections=[{"label": "person"}]))
        report = capability_report("cam", acc.observations(), now_iso=AT)
        self.assertEqual(report["evidenceClass"], "recorded-footage")
        self.assertEqual(report["targetId"], "cam")


class BundleTest(unittest.TestCase):
    def test_configuration_is_redacted_on_the_way_into_a_bundle(self):
        # A validation bundle travels by email between organisations. This is the single worst place
        # for a camera password to end up.
        summary = {"id": "cert_1", "status": "pending-validation", "evidenceClass": "simulated"}
        bundle = build_bundle(
            summary,
            configuration={
                "source": {"uri": "rtsp://admin:hunter2@cam.local/s", "credentialRef": "vault://x"},
                "rtspPassword": "hunter2",
                "nested": [{"authToken": "abc"}],
            },
            now_iso=AT,
        )
        blob = repr(bundle["configuration"])
        self.assertNotIn("hunter2", blob)
        self.assertNotIn("abc", blob)
        self.assertIn("rtsp://***@cam.local/s", blob)

    def test_redaction_catches_secretish_keys_case_insensitively(self):
        out = redact_config({"RTSP_PASSWORD": "x", "X-Auth-Token": "y", "apiKey": "z", "fps": 5})
        self.assertEqual(out["RTSP_PASSWORD"], "***")
        self.assertEqual(out["X-Auth-Token"], "***")
        self.assertEqual(out["apiKey"], "***")
        self.assertEqual(out["fps"], 5)

    def test_a_bundle_carries_only_what_it_was_given(self):
        bundle = build_bundle({"id": "cert_1"}, now_iso=AT)
        self.assertEqual(bundle["benchmarks"], [])
        self.assertEqual(bundle["logs"], [])
        self.assertNotIn("soak", bundle)
        self.assertEqual(bundle["bundleVersion"], "1.0.0")


class HelpersTest(unittest.TestCase):
    def test_is_hardware(self):
        self.assertTrue(is_hardware("hardware"))
        self.assertFalse(is_hardware("recorded-footage"))
        self.assertFalse(is_hardware("simulated"))


if __name__ == "__main__":
    unittest.main()
