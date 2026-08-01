"""AI-5c — Deployment profiles + camera-capability reconciliation.

Two Architect recommendations meet here: operational defaults as configuration rather than code
(AI-5b rec 4 / AI-5c refinement 5), and consuming declared camera capabilities instead of probing
devices (AI-5b rec 1). Both are validated fail-fast, because a profile is edited by an operator and a
bad value must fail at load, not at 3am.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from deployment import (
    available_profiles,
    load_all,
    load_profile,
    parse_profile,
    resolve_stream_settings,
)
from errors import ConfigurationFailure


class ShippedProfilesTest(unittest.TestCase):
    def test_all_seven_verticals_ship_and_validate(self):
        names = available_profiles()
        self.assertEqual(
            set(names),
            {"retail", "warehouse", "office", "school", "hospital", "factory", "parking"},
        )
        profiles = load_all()
        self.assertEqual(len(profiles), 7)

    def test_profiles_express_genuinely_different_operational_envelopes(self):
        profiles = load_all()
        # A parking lot and a hospital should not be configured the same way.
        self.assertLess(profiles["parking"].target_fps, profiles["hospital"].target_fps)
        self.assertGreater(profiles["parking"].max_sessions, profiles["hospital"].max_sessions)
        self.assertEqual(profiles["hospital"].default_priority, "critical")
        self.assertEqual(profiles["office"].default_priority, "low")

    def test_hospital_never_suspends_a_camera(self):
        # A suspended camera in a care setting is unacceptable — the ladder is capped below it.
        hospital = load_profile("hospital")
        self.assertEqual(hospital.scheduler.max_degradation, "shedding-frames")
        self.assertGreater(hospital.scheduler.reserved_capacity_percent, 10.0)

    def test_safety_analyzers_are_protected_from_degradation(self):
        for name in ("warehouse", "factory", "hospital", "school", "parking", "office"):
            profile = load_profile(name)
            self.assertTrue(
                profile.protected_analyzers,
                f"{name} should protect at least one safety analyzer from degradation",
            )

    def test_profiles_are_portable_no_customer_identifiers(self):
        for name, profile in load_all().items():
            blob = repr(profile.to_dict())
            for forbidden in ("tenantId", "cameraId", "siteId", "tnt_", "cam_"):
                self.assertNotIn(forbidden, blob, f"{name} must be portable")

    def test_unknown_profile_lists_what_is_available(self):
        with self.assertRaises(ConfigurationFailure) as ctx:
            load_profile("submarine")
        self.assertIn("available:", str(ctx.exception))


class ProfileValidationTest(unittest.TestCase):
    def _base(self, **overrides) -> dict:
        doc = {"profile": "test", "targetFps": 5, "queueCapacity": 16, "maxSessions": 4}
        doc.update(overrides)
        return doc

    def test_requires_a_name(self):
        with self.assertRaises(ConfigurationFailure):
            parse_profile({"targetFps": 5})

    def test_rejects_impossible_limits_with_an_actionable_message(self):
        for overrides in (
            {"targetFps": 0},
            {"targetFps": 500},
            {"queueCapacity": 0},
            {"maxSessions": -1},
            {"dropPolicy": "drop-everything"},
            {"defaultPriority": "urgent"},
        ):
            with self.assertRaises(ConfigurationFailure, msg=f"expected rejection for {overrides}"):
                parse_profile(self._base(**overrides))

    def test_rejects_embedded_customer_identifiers(self):
        with self.assertRaises(ConfigurationFailure) as ctx:
            parse_profile(self._base(tenantId="tnt_a"))
        self.assertIn("portable", str(ctx.exception))

    def test_rejects_protecting_an_analyzer_that_is_not_enabled(self):
        # Silently ignoring this would leave an operator believing a safety behavior is protected.
        with self.assertRaises(ConfigurationFailure) as ctx:
            parse_profile(
                self._base(
                    enabledBehaviors=["loitering"],
                    analyzerCosts={"costs": {}, "protectedAnalyzers": ["fire"]},
                )
            )
        self.assertIn("not in enabledBehaviors", str(ctx.exception))

    def test_rejects_a_scheduler_policy_without_hysteresis(self):
        with self.assertRaises(ConfigurationFailure):
            parse_profile(
                self._base(scheduler={"degradeAboveQueuePercent": 50, "recoverBelowQueuePercent": 60})
            )

    def test_rejects_a_negative_analyzer_cost(self):
        with self.assertRaises(ConfigurationFailure):
            parse_profile(self._base(analyzerCosts={"costs": {"crowd": -1.0}}))

    def test_defaults_are_applied_when_unspecified(self):
        profile = parse_profile({"profile": "minimal"})
        self.assertEqual(profile.target_fps, 5.0)
        self.assertEqual(profile.drop_policy, "drop-oldest")
        self.assertEqual(profile.default_priority, "normal")
        self.assertEqual(profile.scheduler.strategy, "weighted-fair")


class CapabilityReconciliationTest(unittest.TestCase):
    """AI-5b rec 1: READ declared capabilities; never probe the device."""

    CAPS = {
        "fpsRange": {"min": 1, "max": 10},
        "streamProfiles": [
            {"name": "main", "resolution": "1920x1080", "fps": 25},
            {"name": "sub", "resolution": "640x360", "fps": 10, "preferredForAnalysis": True},
        ],
        "onvif": True,
    }

    def test_never_probes_the_device(self):
        result = resolve_stream_settings(requested_fps=5, capabilities=self.CAPS)
        self.assertFalse(result["probed"])

    def test_clamps_a_request_above_the_camera_maximum(self):
        result = resolve_stream_settings(requested_fps=30, capabilities=self.CAPS)
        self.assertEqual(result["targetFps"], 10.0)
        self.assertTrue(any("camera maximum" in a for a in result["adjustments"]))

    def test_raises_a_request_below_the_camera_minimum(self):
        caps = {"fpsRange": {"min": 4, "max": 30}}
        result = resolve_stream_settings(requested_fps=1, capabilities=caps)
        self.assertEqual(result["targetFps"], 4.0)

    def test_selects_the_preferred_analysis_profile_by_default(self):
        result = resolve_stream_settings(requested_fps=5, capabilities=self.CAPS)
        self.assertEqual(result["streamProfile"], "sub")
        self.assertEqual(result["resolution"], "640x360")

    def test_honours_an_explicit_profile_request(self):
        result = resolve_stream_settings(
            requested_fps=5, capabilities=self.CAPS, preferred_profile="main"
        )
        self.assertEqual(result["streamProfile"], "main")
        self.assertEqual(result["resolution"], "1920x1080")

    def test_explains_when_a_requested_profile_is_not_offered(self):
        result = resolve_stream_settings(
            requested_fps=5, capabilities=self.CAPS, preferred_profile="ultra"
        )
        self.assertTrue(any("not offered" in a for a in result["adjustments"]))
        self.assertEqual(result["streamProfile"], "sub")  # falls back to the preferred one

    def test_a_stream_profile_fps_cap_also_applies(self):
        caps = {"streamProfiles": [{"name": "sub", "fps": 3, "preferredForAnalysis": True}]}
        result = resolve_stream_settings(requested_fps=10, capabilities=caps)
        self.assertEqual(result["targetFps"], 3.0)

    def test_no_capabilities_means_the_request_is_used_unchanged(self):
        result = resolve_stream_settings(requested_fps=7, capabilities=None)
        self.assertEqual(result["targetFps"], 7.0)
        self.assertEqual(result["adjustments"], [])


if __name__ == "__main__":
    unittest.main()
