"""AI-4 behavior-profile tests — declarative profile validation (fail-fast, rec 3), portability (no
tenant/camera/zone ids, rec 7), cycle rejection (rec 5), profile-driven registry build, the retail
pilot expressed purely as configuration (rec 5/9), and a long-duration behavior (rec 6). Deterministic,
stdlib-only. The point: retail is a configuration, not code — no retail-specific class exists."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from composite_registry import CompositeCycleError  # noqa: E402
from playground import build_adapter  # noqa: E402
from profiles import ProfileError, build_from_profile, load_profile, validate_profile  # noqa: E402
from temporal_window import TemporalWindow  # noqa: E402
from video_analyzer import AnalyzeOptions, VideoAnalyzer  # noqa: E402
from video_decoder import StubFrameDecoder  # noqa: E402

RETAIL_PATH = os.path.join(os.path.dirname(__file__), "..", "profiles", "retail.json")


class ValidationTests(unittest.TestCase):
    def test_unknown_analyzer_rejected(self):
        errs = validate_profile({"profile": "p", "analyzers": {"telepathy": {"enabled": True}}})
        self.assertTrue(any("unknown analyzer 'telepathy'" in e for e in errs))

    def test_unknown_required_type_rejected(self):
        errs = validate_profile({
            "profile": "p",
            "composites": [{"name": "c", "behaviorType": "x", "eventType": "behavior.theft.suspected", "category": "retail", "requiredTypes": ["telekinesis"]}],
        })
        self.assertTrue(any("unknown behavior type 'telekinesis'" in e for e in errs))

    def test_unknown_zone_role_rejected(self):
        errs = validate_profile({
            "profile": "p",
            "composites": [{"name": "c", "behaviorType": "x", "eventType": "behavior.theft.suspected", "category": "retail", "requiredTypes": ["loitering"], "zoneRole": "spaceport"}],
        })
        self.assertTrue(any("unknown zoneRole 'spaceport'" in e for e in errs))

    def test_portability_forbids_embedded_ids(self):
        for bad in ({"tenantId": "t"}, {"cameraId": "c"}, {"composites": [{"zoneId": "z"}]}):
            errs = validate_profile({"profile": "p", **bad})
            self.assertTrue(any("not portable" in e for e in errs), bad)

    def test_valid_profile_has_no_errors(self):
        self.assertEqual(validate_profile(load_profile(RETAIL_PATH)), [])


class BuildTests(unittest.TestCase):
    def test_build_enables_only_listed_analyzers(self):
        reg, creg = build_from_profile({
            "profile": "p",
            "analyzers": {"queue": {"enabled": True}, "loitering": {"enabled": False}},
        })
        enabled = [a.name for a in reg.enabled()]
        self.assertIn("queue", enabled)
        self.assertNotIn("loitering", enabled)  # explicitly disabled
        self.assertNotIn("fire", enabled)  # unlisted → off

    def test_invalid_profile_raises_profile_error(self):
        with self.assertRaises(ProfileError):
            build_from_profile({"profile": "p", "analyzers": {"nope": {"enabled": True}}})

    def test_cyclic_composites_rejected_at_build(self):
        with self.assertRaises(CompositeCycleError):
            build_from_profile({
                "profile": "p",
                "composites": [
                    {"name": "A", "behaviorType": "A", "category": "security", "eventType": "behavior.theft.suspected", "requiredTypes": ["B"]},
                    {"name": "B", "behaviorType": "B", "category": "security", "eventType": "behavior.theft.suspected", "requiredTypes": ["A"]},
                ],
            })


class RetailPilotTests(unittest.TestCase):
    """The retail pilot runs entirely through the profile — no retail-specific code path exists."""

    def _cash_zone(self, camera="cam_cash"):
        return {"id": "cash_1", "cameraId": camera, "name": "cash", "kind": "area",
                "geometry": {"points": [[0, 0], [1, 0], [1, 1], [0, 1]]},
                "attributes": {"loitering": True, "role": "cash"}}

    def test_retail_profile_composes_cash_anomaly(self):
        profile = load_profile(RETAIL_PATH)
        # Lower the dwell so the synthetic clip (short) triggers deterministically — via config, not code.
        profile["analyzers"]["loitering"]["customParameters"]["dwellSeconds"] = 0.05
        profile["composites"][0]["minDwellSeconds"] = 0.05
        opts = AnalyzeOptions(tenant_id="tnt_a", camera_id="cam_cash", session_id="sess_r",
                              labels=("person",), min_confidence=0.3, track_min_hits=2,
                              zones=(self._cash_zone(),), profile=profile)
        res = VideoAnalyzer(build_adapter("stub"), opts).analyze(StubFrameDecoder.synthetic(10))
        self.assertTrue(res.composites, "expected a composite behavior")
        self.assertEqual(res.composites[0]["behaviorType"], "cash_counter_anomaly")
        self.assertIn("behavior.theft.suspected", {e["type"] for e in res.events})
        # composite carries relationships + evidence + composite metadata
        c = res.composites[0]
        self.assertTrue(c["relatedBehaviorIds"])
        self.assertIn("contributingTracks", c["evidence"])
        self.assertEqual(c["composite"]["evaluationStrategy"], "all_of")
        # observability populated
        self.assertGreaterEqual(res.composite_stats["compositeEvaluations"], 1)
        self.assertEqual(res.summary["profile"], "retail")
        # boundary: still only EventEnvelopes, never incidents
        self.assertFalse([e for e in res.events if e["type"].startswith("incident.")])

    def test_no_retail_code_only_generic_analyzers(self):
        # Every analyzer the profile enables is a GENERIC class from the shared set.
        from behaviors import ANALYZER_TYPES
        reg, _ = build_from_profile(load_profile(RETAIL_PATH))
        for a in reg.enabled():
            self.assertIn(a.name, ANALYZER_TYPES)


class LongDurationTests(unittest.TestCase):
    def test_temporal_window_supports_long_windows(self):
        # A 12-hour window keeps samples across a huge span with no architectural change (rec 6).
        w = TemporalWindow(window_seconds=12 * 3600)
        w.record(0.0)
        w.record(11 * 3600)
        self.assertEqual(w.count(), 2)
        self.assertEqual(w.span_seconds(), 11 * 3600)
        # a sample beyond the horizon evicts the oldest
        w.record(13 * 3600)
        self.assertEqual(w.first_t(), 11 * 3600)


if __name__ == "__main__":
    unittest.main()
