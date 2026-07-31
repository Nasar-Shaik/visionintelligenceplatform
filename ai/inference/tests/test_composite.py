"""AI-4 composite-behavior tests — the generic RuleCompositeAnalyzer (config, not code), confidence
strategies, the composite registry with cycle protection + match/miss metrics, behavior relationships
+ evidence + composite metadata, composite independence (consumes BehaviorResults only), and end-to-end
integration through the analyzer. Deterministic, stdlib-only. The point is composite-independence:
nothing here is retail-specific — retail is a configuration, proven in test_profiles.py."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from behavior import BehaviorLifecycleStore  # noqa: E402
from behavior_contracts import BehaviorCategory, BehaviorResult, BehaviorState  # noqa: E402
from composite import (  # noqa: E402
    CompositeContext,
    CompositeRule,
    RuleCompositeAnalyzer,
    _confidence,
)
from composite_registry import CompositeCycleError, CompositeRegistry  # noqa: E402


def behavior(behavior_type, *, behavior_id="bhv_1", subjects=("trk_1",), zone_id="z1", conf=0.8, metrics=None):
    return BehaviorResult(
        behavior_id=behavior_id, behavior_type=behavior_type, category=BehaviorCategory.SECURITY,
        tenant_id="tnt_a", camera_id="cam_1", state=BehaviorState.ONGOING, confidence=conf,
        first_observed="0s", last_observed="1s", frame_index=1, session_id="sess_1",
        zone_id=zone_id, subjects=list(subjects), metrics=metrics or {},
    )


def cctx(behaviors, *, zone_roles=None, frame=1):
    return CompositeContext(
        tenant_id="tnt_a", camera_id="cam_1", frame_index=frame, at=f"{frame}s", t=float(frame),
        behaviors=tuple(behaviors), zone_roles=zone_roles or {}, session_id="sess_1",
    )


def rule(**kw):
    base = dict(name="c1", behavior_type="composite_x", category=BehaviorCategory.OPERATIONAL,
               event_type="behavior.theft.suspected", required_types=["loitering", "intrusion"])
    base.update(kw)
    return CompositeRule(**base)


class ConfidenceStrategyTests(unittest.TestCase):
    def test_strategies(self):
        vals = [0.4, 0.8]
        self.assertEqual(_confidence(vals, "min"), 0.4)
        self.assertEqual(_confidence(vals, "max"), 0.8)
        self.assertAlmostEqual(_confidence(vals, "mean"), 0.6)
        # weighted (confidence-weighted mean) leans above the arithmetic mean
        self.assertGreater(_confidence(vals, "weighted"), 0.6)
        self.assertEqual(_confidence([], "min"), 0.0)


class RuleCompositeAnalyzerTests(unittest.TestCase):
    def test_all_of_co_occurrence_on_same_subject(self):
        a = RuleCompositeAnalyzer(rule())
        out = a.analyze(cctx([behavior("loitering", behavior_id="b1"), behavior("intrusion", behavior_id="b2")]))
        self.assertEqual(len(out), 1)
        obs = out[0]
        self.assertEqual(sorted(obs.related_behavior_ids), ["b1", "b2"])
        self.assertEqual(obs.composite_meta["contributingBehaviorCount"], 2)
        self.assertEqual(obs.evidence["contributingTracks"], ["trk_1"])
        self.assertEqual(obs.attributes["eventType"], "behavior.theft.suspected")
        self.assertTrue(obs.attributes["compositeTrace"])

    def test_missing_required_type_does_not_compose(self):
        a = RuleCompositeAnalyzer(rule())
        out = a.analyze(cctx([behavior("loitering")]))  # intrusion absent
        self.assertEqual(out, [])

    def test_zone_role_filter(self):
        a = RuleCompositeAnalyzer(rule(required_types=["loitering"], zone_role="cash"))
        # loitering in a non-cash zone → no match
        self.assertEqual(a.analyze(cctx([behavior("loitering", zone_id="z1")], zone_roles={"z1": "queue"})), [])
        # loitering in a cash-role zone → match
        out = a.analyze(cctx([behavior("loitering", zone_id="z2")], zone_roles={"z2": "cash"}))
        self.assertEqual(len(out), 1)

    def test_min_dwell_gate(self):
        a = RuleCompositeAnalyzer(rule(required_types=["loitering"], min_dwell_seconds=5.0))
        self.assertEqual(a.analyze(cctx([behavior("loitering", metrics={"dwellSeconds": 2.0})])), [])
        out = a.analyze(cctx([behavior("loitering", metrics={"dwellSeconds": 9.0})]))
        self.assertEqual(len(out), 1)

    def test_confidence_strategy_applied(self):
        a = RuleCompositeAnalyzer(rule(required_types=["loitering", "intrusion"], confidence_strategy="max"))
        out = a.analyze(cctx([behavior("loitering", behavior_id="b1", conf=0.3), behavior("intrusion", behavior_id="b2", conf=0.9)]))
        self.assertEqual(out[0].confidence, 0.9)


class CompositeIndependenceTests(unittest.TestCase):
    def test_composite_consumes_only_behavior_results(self):
        # The CompositeContext exposes ONLY BehaviorResults + a plain role map — no Track/Detection/zones.
        ctx = cctx([behavior("loitering")])
        self.assertTrue(all(isinstance(b, BehaviorResult) for b in ctx.behaviors))
        self.assertFalse(hasattr(ctx, "snapshots"))
        self.assertFalse(hasattr(ctx, "zone_engine"))


class CompositeRegistryTests(unittest.TestCase):
    def test_cycle_detection_rejects_circular_graph(self):
        reg = CompositeRegistry()
        reg.register(RuleCompositeAnalyzer(rule(name="A", behavior_type="A", required_types=["B"])))
        reg.register(RuleCompositeAnalyzer(rule(name="B", behavior_type="B", required_types=["A"])))
        with self.assertRaises(CompositeCycleError):
            reg.validate_acyclic()

    def test_acyclic_graph_passes(self):
        reg = CompositeRegistry()
        reg.register(RuleCompositeAnalyzer(rule(name="A", behavior_type="A", required_types=["loitering"])))
        reg.register(RuleCompositeAnalyzer(rule(name="B", behavior_type="B", required_types=["A"])))
        reg.validate_acyclic()  # A depends on a primitive + B depends on A — no cycle

    def test_match_miss_metrics(self):
        reg = CompositeRegistry().register(RuleCompositeAnalyzer(rule(required_types=["loitering"])))
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        reg.run(cctx([behavior("loitering")]), store)  # match
        reg.run(cctx([behavior("queue")]), store)  # miss
        m = reg.aggregate_metrics()
        self.assertEqual(m["compositeEvaluations"], 2)
        self.assertEqual(m["compositeMatches"], 1)
        self.assertEqual(m["compositeMisses"], 1)

    def test_lifecycle_started_then_ended(self):
        reg = CompositeRegistry().register(RuleCompositeAnalyzer(rule(required_types=["loitering"])))
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        e0 = reg.run(cctx([behavior("loitering")], frame=0), store)
        e1 = reg.run(cctx([], frame=1), store)  # contributor gone
        self.assertEqual(e0[0].state, BehaviorState.STARTED)
        self.assertEqual(e1[0].state, BehaviorState.ENDED)
        self.assertIsNotNone(e0[0].composite)
        self.assertEqual(e0[0].category, BehaviorCategory.OPERATIONAL)


if __name__ == "__main__":
    unittest.main()
