"""Behaviour stage + module tests (P-11 slice 2.2).

Two kinds of test live here and the split is deliberate:

- **Module tests** drive one primitive module with an authored `BehaviourContext`, so a failure means
  the primitive is wrong.
- **Stage tests** drive the real `RuntimeTracker` and the real `BehaviourStage` chained together
  through `StageChain`, feeding hand-authored detections frame by frame — so a failure means the
  *wiring* is wrong. ⭐ That distinction matters: every primitive passed its unit tests in slice 2.1,
  and the defects this slice was most likely to ship were all in the join.

⛔ The four checks the plan named before any code was written, each here by name:
identity survives occlusion · frame-rate invariance · zone transitions · object association.

Deterministic and stdlib-only: no clock, no threads, no camera, no model.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import behaviour_primitives as bp  # noqa: E402
from behaviour_modules import (  # noqa: E402
    ATTR_BEHAVIOUR,
    TASK_BEHAVIOUR,
    ZONE_ATTRIBUTE,
    AssociationModule,
    BehaviourContext,
    MotionModule,
    RelationalModule,
    ZoneModule,
    default_behaviour_registry,
    register_behaviour_modules,
)
from behaviour_stage import BehaviourStage  # noqa: E402
from contracts import Detection, FrameContext  # noqa: E402
from perception import PerceptionOutput, describe_task, known_tasks  # noqa: E402
from perception_registry import ModuleUnavailable, PerceptionRegistry  # noqa: E402
from pipeline import StageChain  # noqa: E402
from runtime_tracking import RuntimeTracker, TrackingOptions  # noqa: E402
from track_history import InMemoryTrackHistoryStore, TrackHistoryRecorder  # noqa: E402


def point(identity, at, x, y, *, w=0.08, h=0.2, label="person", zones=()):
    return bp.TrackPoint(
        identity_id=identity, at_seconds=at, bbox=(x, y, w, h), label=label, zone_ids=tuple(zones)
    )


def ctx(**kwargs):
    return BehaviourContext(tenant_id="tnt_a", camera_id="cam_1", **kwargs)


# ---------------------------------------------------------------------------------------------------
# The registry — P-10's open task set, exercised by the first task nobody designed for
# ---------------------------------------------------------------------------------------------------


class RegistryTests(unittest.TestCase):
    def test_behaviour_is_a_registered_task_that_perception_py_never_declared(self):
        """⭐ The P-10 claim under test: a plugin can bring a task without editing the contract."""
        self.assertIn(TASK_BEHAVIOUR, known_tasks())
        self.assertIn("never an intent", describe_task(TASK_BEHAVIOUR))

    def test_every_default_module_registers_and_creates(self):
        registry = default_behaviour_registry()
        self.assertEqual(registry.available(TASK_BEHAVIOUR), ["association", "motion", "relational", "zone"])
        for name in registry.available(TASK_BEHAVIOUR):
            module = registry.create(TASK_BEHAVIOUR, name)
            self.assertEqual(module.task, TASK_BEHAVIOUR)
            module.load({})
            self.assertIsInstance(module.analyse(module.preprocess(ctx())), PerceptionOutput)
            module.unload()

    def test_registering_twice_raises_rather_than_silently_overwriting(self):
        registry = default_behaviour_registry()
        with self.assertRaises(ValueError):
            register_behaviour_modules(registry)
        register_behaviour_modules(registry, replace=True)  # explicit is fine

    def test_an_unregistered_module_name_raises_and_does_not_return_a_no_op(self):
        with self.assertRaises(ModuleUnavailable):
            PerceptionRegistry().create(TASK_BEHAVIOUR, "nope")

    def test_the_deployment_advertises_behaviour_only_when_something_can_execute_it(self):
        self.assertEqual(PerceptionRegistry().tasks(), [])
        self.assertIn(TASK_BEHAVIOUR, default_behaviour_registry().tasks())


# ---------------------------------------------------------------------------------------------------
# Modules, positive and negative
# ---------------------------------------------------------------------------------------------------


class MotionModuleTests(unittest.TestCase):
    def setUp(self):
        self.module = MotionModule()
        self.module.load({})

    def analyse(self, **kwargs):
        return self.module.analyse(self.module.preprocess(ctx(**kwargs)))

    def test_a_moving_subject_reports_a_path_a_speed_and_a_heading(self):
        points = [point("idn_1", t, 0.10 + 0.10 * t, 0.5) for t in range(4)]
        payload = self.analyse(subjects={"idn_1": points}).instances[0].attributes["motion"]
        self.assertAlmostEqual(payload["pathLengthNormalized"], 0.3, places=6)
        self.assertAlmostEqual(payload["speedNormalizedPerSecond"], 0.1, places=6)
        self.assertAlmostEqual(payload["directionDegrees"], 0.0, places=3)  # 0° = east
        self.assertEqual(payload["samples"], 4)

    def test_a_stationary_subject_reports_zero_speed_and_no_heading(self):
        """⛔ 0.0 speed and `None` heading are different claims. A track that has not moved has a
        measured speed and has made no claim about direction."""
        points = [point("idn_1", t, 0.5, 0.5) for t in range(4)]
        payload = self.analyse(subjects={"idn_1": points}).instances[0].attributes["motion"]
        self.assertEqual(payload["speedNormalizedPerSecond"], 0.0)
        self.assertIsNone(payload["directionDegrees"])

    def test_a_single_observation_reports_none_for_speed_and_never_zero(self):
        """⛔ The failure this project has caught eight times: an empty measurement rendered as 0.0
        reads as 'the subject stood still' instead of 'nothing was measurable'."""
        payload = self.analyse(subjects={"idn_1": [point("idn_1", 0.0, 0.5, 0.5)]}).instances[0]
        self.assertIsNone(payload.attributes["motion"]["speedNormalizedPerSecond"])

    def test_an_empty_scene_produces_no_instances(self):
        """The negative control. Nothing happening must read as nothing, not as a subject at 0,0."""
        self.assertEqual(list(self.analyse().instances), [])

    def test_an_observation_gap_is_reported_when_it_exceeds_the_sampling_interval(self):
        points = [point("idn_1", t, 0.5, 0.5) for t in (0.0, 0.5, 1.0, 6.0, 6.5)]
        payload = self.analyse(subjects={"idn_1": points}, expected_interval_seconds=0.5)
        gaps = payload.instances[0].attributes["motion"]["observationGaps"]
        self.assertEqual(len(gaps), 1)
        self.assertAlmostEqual(gaps[0]["seconds"], 5.0, places=4)

    def test_no_gap_is_reported_when_sampling_is_regular(self):
        points = [point("idn_1", t * 0.5, 0.5, 0.5) for t in range(8)]
        payload = self.analyse(subjects={"idn_1": points}, expected_interval_seconds=0.5)
        self.assertEqual(payload.instances[0].attributes["motion"]["observationGaps"], [])

    def test_objects_are_measured_too_because_a_carried_thing_also_moves(self):
        points = [point("idn_obj", t, 0.1 + 0.1 * t, 0.5, label="bottle") for t in range(3)]
        output = self.analyse(objects={"idn_obj": points})
        self.assertEqual(output.instances[0].label, "bottle")


class ZoneModuleTests(unittest.TestCase):
    def setUp(self):
        self.module = ZoneModule()
        self.module.load({})

    def analyse(self, **kwargs):
        return self.module.analyse(self.module.preprocess(ctx(**kwargs)))

    def test_dwell_accumulates_over_a_membership_supplied_upstream(self):
        points = [point("idn_1", t, 0.5, 0.5, zones=("z_till",)) for t in range(5)]
        output = self.analyse(
            subjects={"idn_1": points},
            zones=(bp.MembershipZone("z_till"),),
            zone_membership_present=True,
            at_seconds=4.0,
        )
        payload = output.instances[0].attributes["zone"]
        self.assertAlmostEqual(payload["zones"]["z_till"]["dwellSeconds"], 4.0, places=4)
        self.assertEqual(payload["zones"]["z_till"]["visits"], 1)
        self.assertTrue(payload["zones"]["z_till"]["present"])

    def test_entering_and_leaving_produce_two_transitions_in_time_order(self):
        points = [
            point("idn_1", 0.0, 0.1, 0.5),
            point("idn_1", 1.0, 0.5, 0.5, zones=("z_till",)),
            point("idn_1", 2.0, 0.5, 0.5, zones=("z_till",)),
            point("idn_1", 3.0, 0.9, 0.5),
        ]
        output = self.analyse(
            subjects={"idn_1": points},
            zones=(bp.MembershipZone("z_till"),),
            zone_membership_present=True,
            at_seconds=3.0,
        )
        transitions = output.instances[0].attributes["zone"]["transitions"]
        self.assertEqual(
            [(t["transition"], t["atSeconds"]) for t in transitions], [("entered", 1.0), ("left", 2.0)]
        )

    def test_leaving_and_returning_is_one_identity_with_two_visits(self):
        """⛔ Summed across visits, so a shopper who steps out of a zone and comes back has ONE
        dwell. Grouping by track id would instead produce two people who each lingered briefly."""
        script = [("z_till",), ("z_till",), (), ("z_till",), ("z_till",)]
        points = [point("idn_1", float(t), 0.5, 0.5, zones=z) for t, z in enumerate(script)]
        output = self.analyse(
            subjects={"idn_1": points},
            zones=(bp.MembershipZone("z_till"),),
            zone_membership_present=True,
            at_seconds=4.0,
        )
        payload = output.instances[0].attributes["zone"]["zones"]["z_till"]
        self.assertEqual(payload["visits"], 2)
        self.assertAlmostEqual(payload["dwellSeconds"], 2.0, places=4)

    def test_no_membership_anywhere_emits_nothing_rather_than_zero_dwell_for_everyone(self):
        """⛔ The whole reason `zone_membership_present` exists. An unconfigured deployment and an
        empty shop both produce 0.0 s of dwell, and publishing the first as the second is the exact
        class of defect this project has been burned by."""
        points = [point("idn_1", t, 0.5, 0.5) for t in range(5)]
        output = self.analyse(
            subjects={"idn_1": points}, zones=(bp.MembershipZone("z_till"),), zone_membership_present=False
        )
        self.assertEqual(list(output.instances), [])
        self.assertEqual(list(output.frame_labels), [])

    def test_a_subject_who_never_entered_produces_no_zone_payload(self):
        points = [point("idn_1", t, 0.1, 0.1) for t in range(4)]
        output = self.analyse(
            subjects={"idn_1": points},
            zones=(bp.MembershipZone("z_till"),),
            zone_membership_present=True,
            at_seconds=3.0,
        )
        self.assertEqual(list(output.instances), [])

    def test_occupancy_counts_identities_present_in_the_zone_at_this_instant(self):
        subjects = {
            "idn_1": [point("idn_1", 2.0, 0.5, 0.5, zones=("z_till",))],
            "idn_2": [point("idn_2", 2.0, 0.6, 0.5, zones=("z_till",))],
            "idn_3": [point("idn_3", 2.0, 0.9, 0.5)],
        }
        output = self.analyse(
            subjects=subjects,
            zones=(bp.MembershipZone("z_till"),),
            zone_membership_present=True,
            at_seconds=2.0,
        )
        self.assertEqual(output.frame_labels[0].attributes, {"zoneId": "z_till", "count": 2})

    def test_a_polygon_zone_agrees_with_the_runtime_zone_engine(self):
        """⚠️ Delegated, not reimplemented. Two ray-casts that must agree is a defect waiting for a
        boundary case."""
        from zones import point_in_polygon

        polygon = [(0.4, 0.4), (0.8, 0.4), (0.8, 0.9), (0.4, 0.9)]
        zone = bp.PolygonZone("z_poly", polygon)
        inside = point("idn_1", 0.0, 0.55, 0.5, w=0.1, h=0.2)
        self.assertEqual(zone.holds(inside), point_in_polygon(inside.foot_point, polygon))
        self.assertTrue(zone.holds(inside))
        self.assertFalse(zone.holds(point("idn_1", 0.0, 0.05, 0.05)))


class RelationalModuleTests(unittest.TestCase):
    def setUp(self):
        self.module = RelationalModule()
        self.module.load({})

    def analyse(self, **kwargs):
        return self.module.analyse(self.module.preprocess(ctx(**kwargs)))

    def test_two_subjects_standing_together_report_co_presence(self):
        near_a = [point("idn_1", t, 0.50, 0.5) for t in range(5)]
        near_b = [point("idn_2", t, 0.52, 0.5) for t in range(5)]
        output = self.analyse(subjects={"idn_1": near_a, "idn_2": near_b}, at_seconds=4.0)
        payload = output.instances[0].attributes["relational"]["near"][0]
        self.assertEqual(payload["identityId"], "idn_2")
        self.assertAlmostEqual(payload["coPresenceSeconds"], 4.0, places=4)

    def test_two_subjects_at_opposite_ends_report_no_co_presence(self):
        far_a = [point("idn_1", t, 0.05, 0.5) for t in range(5)]
        far_b = [point("idn_2", t, 0.85, 0.5) for t in range(5)]
        output = self.analyse(subjects={"idn_1": far_a, "idn_2": far_b}, at_seconds=4.0)
        self.assertEqual(output.instances[0].attributes["relational"]["near"][0]["coPresenceSeconds"], 0.0)

    def test_a_distance_is_absent_when_the_two_were_not_observed_on_the_same_frame(self):
        """⛔ `None` rather than the distance to a stale position — that would be a proximity claim
        nobody made. Two subjects one frame apart can be anywhere relative to each other."""
        a = [point("idn_1", float(t), 0.50, 0.5) for t in range(4)]
        b = [point("idn_2", float(t), 0.52, 0.5) for t in range(2)]  # leaves after t=1
        output = self.analyse(subjects={"idn_1": a, "idn_2": b}, at_seconds=3.0)
        entry = output.instances[0].attributes["relational"]["near"][0]
        self.assertEqual(entry["identityId"], "idn_2")
        self.assertGreater(entry["coPresenceSeconds"], 0.0)
        self.assertNotIn("distanceNormalized", entry)

    def test_occupancy_is_a_frame_label_because_it_is_not_about_any_one_subject(self):
        subjects = {f"idn_{i}": [point(f"idn_{i}", 1.0, 0.1 * i, 0.5)] for i in range(6)}
        output = self.analyse(subjects=subjects, at_seconds=1.0)
        self.assertEqual(output.frame_labels[0].label, "occupancy")
        self.assertEqual(output.frame_labels[0].attributes["count"], 6)

    def test_an_empty_scene_reports_an_occupancy_of_zero_and_no_instances(self):
        output = self.analyse(at_seconds=1.0)
        self.assertEqual(list(output.instances), [])
        self.assertEqual(output.frame_labels[0].attributes["count"], 0)

    def test_the_pairwise_scan_is_capped_and_says_so(self):
        """⚠️ A truncated scan that said nothing about being truncated would show a crowded scene as
        a quiet one."""
        subjects = {f"idn_{i:03d}": [point(f"idn_{i:03d}", 1.0, 0.5, 0.5)] for i in range(40)}
        output = self.analyse(subjects=subjects, at_seconds=1.0)
        self.assertIs(output.attributes["truncated"], True)
        self.assertEqual(output.attributes["identitiesConsidered"], 32)


class AssociationModuleTests(unittest.TestCase):
    def setUp(self):
        self.module = AssociationModule()
        self.module.load({})

    def analyse(self, **kwargs):
        return self.module.analyse(self.module.preprocess(ctx(**kwargs)))

    def test_an_object_travelling_with_one_subject_is_associated_to_them(self):
        subject = [point("idn_p", t, 0.30 + 0.05 * t, 0.5) for t in range(5)]
        bottle = [point("idn_b", t, 0.32 + 0.05 * t, 0.55, w=0.03, h=0.06, label="bottle") for t in range(5)]
        output = self.analyse(subjects={"idn_p": subject}, objects={"idn_b": bottle})
        held = output.instances[0].attributes["association"]["heldBy"]
        self.assertEqual(held[0]["identityId"], "idn_p")
        self.assertTrue(held[0]["current"])

    def test_an_object_nobody_is_near_is_associated_to_nobody(self):
        subject = [point("idn_p", t, 0.05, 0.5) for t in range(5)]
        bottle = [point("idn_b", t, 0.90, 0.5, w=0.03, h=0.06, label="bottle") for t in range(5)]
        self.assertEqual(list(self.analyse(subjects={"idn_p": subject}, objects={"idn_b": bottle}).instances), [])

    def test_an_object_passed_between_two_subjects_produces_a_handover(self):
        giver = [point("idn_give", t, 0.30, 0.5) for t in range(6)]
        taker = [point("idn_take", t, 0.60, 0.5) for t in range(6)]
        bottle = [
            point("idn_b", t, 0.32 if t < 3 else 0.62, 0.55, w=0.03, h=0.06, label="bottle")
            for t in range(6)
        ]
        output = self.analyse(
            subjects={"idn_give": giver, "idn_take": taker}, objects={"idn_b": bottle}
        )
        handovers = [label for label in output.frame_labels if label.label == "handover"]
        self.assertEqual(len(handovers), 1)
        self.assertEqual(handovers[0].attributes["fromIdentityId"], "idn_give")
        self.assertEqual(handovers[0].attributes["toIdentityId"], "idn_take")

    def test_no_objects_means_no_output_rather_than_an_empty_association_for_everyone(self):
        subject = [point("idn_p", t, 0.3, 0.5) for t in range(4)]
        self.assertEqual(list(self.analyse(subjects={"idn_p": subject}).instances), [])


# ---------------------------------------------------------------------------------------------------
# The stage — the real tracker and the real stage, chained
# ---------------------------------------------------------------------------------------------------


def detection(bbox, *, label="person", conf=0.9, class_id=0, zones=None):
    attributes = {} if zones is None else {ZONE_ATTRIBUTE: list(zones)}
    return Detection(label=label, confidence=conf, bbox=bbox, class_id=class_id, attributes=attributes)


class StageHarness:
    """One `RuntimeTracker` and one `BehaviourStage` sharing a recorder, in the one pipeline slot."""

    def __init__(self, **stage_kwargs):
        self.store = InMemoryTrackHistoryStore()
        self.recorder = TrackHistoryRecorder(store=self.store)
        self.tracker = RuntimeTracker(
            TrackingOptions(min_hits=1, max_age=8, reentry_gap_seconds=12.0), history=self.recorder
        )
        self.stage = BehaviourStage(recorder=self.recorder, **stage_kwargs)
        self.chain = StageChain(self.tracker, self.stage)

    def frame(self, detections, *, at, seq, tenant="tnt_a", camera="cam_1", stream=None):
        return self.chain.run(
            list(detections),
            FrameContext(
                tenant_id=tenant,
                camera_id=camera,
                image=b"",
                frame_number=seq,
                timestamp=at,
                correlation_id=stream,
            ),
        )


class StageWiringTests(unittest.TestCase):
    def test_the_chain_is_tracker_shaped_so_the_pipeline_still_sees_one_stage(self):
        """⭐ The guardrail held literally: no new pipeline stage, because `Tracker` is structural."""
        harness = StageHarness()
        self.assertTrue(callable(harness.chain.run))
        self.assertEqual(len(harness.chain.stages), 2)
        self.assertIs(harness.chain.find("tracks"), harness.tracker)
        self.assertIs(harness.chain.find("scene_labels"), harness.stage)
        self.assertIsNone(harness.chain.find("no_such_method"))

    def test_a_stage_that_raises_fails_the_frame_rather_than_being_skipped(self):
        class Exploding:
            def run(self, detections, ctx):
                raise RuntimeError("boom")

        with self.assertRaises(RuntimeError):
            StageChain(Exploding()).run([], FrameContext(tenant_id="t", camera_id="c", image=b""))

    def test_a_detection_with_no_identity_passes_through_untouched(self):
        """⚠️ Behaviour is a statement about a tracked identity. A detection the tracker did not
        associate has none, and stamping an empty `behaviour` key on it would be indistinguishable
        from a subject about whom there is genuinely nothing to report."""
        stage = BehaviourStage(recorder=TrackHistoryRecorder())
        out = stage.run(
            [detection((0.4, 0.4, 0.08, 0.2))],
            FrameContext(tenant_id="tnt_a", camera_id="cam_1", image=b"", timestamp="0s"),
        )
        self.assertNotIn(ATTR_BEHAVIOUR, out[0].attributes)

    def test_the_first_frame_reports_one_sample_and_an_unmeasurable_speed(self):
        """⛔ `None`, not 0.0. One observation is not 'the subject stood still'."""
        harness = StageHarness()
        out = harness.frame([detection((0.4, 0.4, 0.08, 0.2))], at="0s", seq=1)
        motion = out[0].attributes[ATTR_BEHAVIOUR]["motion"]
        self.assertEqual(motion["samples"], 1)
        self.assertIsNone(motion["speedNormalizedPerSecond"])

    def test_behaviour_rides_in_the_frozen_contracts_attributes_map_and_adds_no_field(self):
        harness = StageHarness()
        for index in range(4):
            out = harness.frame([detection((0.30 + 0.05 * index, 0.4, 0.08, 0.2))], at=f"{index}s", seq=index)
        payload = out[0].to_dict()
        self.assertIn(ATTR_BEHAVIOUR, payload["attributes"])
        self.assertIn("motion", payload["attributes"][ATTR_BEHAVIOUR])
        # Nothing new at the top level of the frozen Detection shape.
        self.assertEqual(
            set(payload) - {"label", "confidence", "bbox", "attributes", "metadata"},
            {"classId", "trackingId", "identityId"},
        )

    def test_the_stage_is_inert_when_disabled(self):
        harness = StageHarness(enabled=False)
        for index in range(4):
            out = harness.frame([detection((0.30 + 0.05 * index, 0.4, 0.08, 0.2))], at=f"{index}s", seq=index)
        self.assertNotIn(ATTR_BEHAVIOUR, out[0].attributes)
        self.assertEqual(harness.stage.stats()["frames"], 0)

    def test_a_module_that_raises_is_counted_and_the_frame_still_completes(self):
        class Broken:
            task = TASK_BEHAVIOUR
            execution_provider = "cpu"

            def load(self, ref=None):
                return None

            def preprocess(self, prepared):
                return prepared

            def analyse(self, prepared):
                raise ValueError("bad primitive")

            def unload(self):
                return None

        registry = PerceptionRegistry()
        registry.register(TASK_BEHAVIOUR, "broken", Broken)
        registry.register(TASK_BEHAVIOUR, "motion", MotionModule)
        harness = StageHarness(registry=registry, modules=["broken", "motion"])
        for index in range(3):
            out = harness.frame([detection((0.30 + 0.05 * index, 0.4, 0.08, 0.2))], at=f"{index}s", seq=index)
        self.assertIn(ATTR_BEHAVIOUR, out[0].attributes)
        self.assertEqual(harness.stage.stats()["moduleFailures"]["broken"], 3)


class StageIdentityTests(unittest.TestCase):
    def test_one_person_one_occlusion_is_one_identity_with_the_full_dwell(self):
        """⛔ The defect the whole phase was most likely to ship, driven through the real tracker.

        A person walks, disappears for four frames, and comes back. ADR-0038 forbids track id reuse,
        so the returning subject gets a NEW `trackingId`. If anything accumulated by track id the
        reported span would be two short visits; it must be one identity spanning the whole clip.
        """
        harness = StageHarness()
        for index in range(4):  # seen
            harness.frame([detection((0.30 + 0.01 * index, 0.4, 0.08, 0.2))], at=f"{index}s", seq=index)
        for index in range(4, 13):  # occluded past maxAgeFrames — the track is REMOVED
            harness.frame([], at=f"{index}s", seq=index)
        out = harness.frame([detection((0.33, 0.4, 0.08, 0.2))], at="13s", seq=13)

        records = harness.recorder.live_records("tnt_a", "cam_1")
        self.assertEqual(len(records), 1, "one person must be one history record")
        self.assertEqual(
            len(records[0].track_ids), 2, "the tracker did mint a second track id — the premise"
        )
        motion = out[0].attributes[ATTR_BEHAVIOUR]["motion"]
        self.assertAlmostEqual(motion["durationSeconds"], 13.0, places=4)
        self.assertEqual(len(motion["observationGaps"]), 1)

    def test_the_same_walk_at_one_and_four_frames_per_second_agrees_in_seconds(self):
        """⛔ Track age advances per FRAME. A primitive that counted frames would give two different
        answers for the same ten seconds of footage."""

        def walk(fps):
            harness = StageHarness()
            steps = int(10 * fps) + 1
            for index in range(steps):
                at = index / fps
                harness.frame(
                    [detection((0.20 + 0.04 * at, 0.4, 0.08, 0.2))], at=f"{at:g}s", seq=index
                )
            out = harness.frame([detection((0.60, 0.4, 0.08, 0.2))], at="10s", seq=steps)
            return out[0].attributes[ATTR_BEHAVIOUR]["motion"]

        slow, fast = walk(1.0), walk(4.0)
        self.assertAlmostEqual(slow["durationSeconds"], fast["durationSeconds"], places=4)
        self.assertAlmostEqual(
            slow["speedNormalizedPerSecond"], fast["speedNormalizedPerSecond"], places=3
        )

    def test_two_analyses_of_one_recording_keep_separate_behaviour(self):
        """⚠️ ADR-0047 — offline replay never moves footage time, so runs must be keyed by stream."""
        harness = StageHarness()
        for stream in ("run_a", "run_b"):
            for index in range(3):
                harness.frame(
                    [detection((0.30 + 0.01 * index, 0.4, 0.08, 0.2))],
                    at=f"{index}s",
                    seq=index,
                    stream=stream,
                )
        self.assertEqual(len(harness.recorder.live_records("tnt_a", "cam_1", "run_a")), 1)
        self.assertEqual(len(harness.recorder.live_records("tnt_a", "cam_1", "run_b")), 1)


class StageZoneTests(unittest.TestCase):
    def test_membership_stamped_upstream_accumulates_into_a_dwell(self):
        harness = StageHarness()
        for index in range(5):
            out = harness.frame(
                [detection((0.5, 0.4, 0.08, 0.2), zones=["z_till"])], at=f"{index}s", seq=index
            )
        payload = out[0].attributes[ATTR_BEHAVIOUR]["zone"]["zones"]["z_till"]
        self.assertAlmostEqual(payload["dwellSeconds"], 4.0, places=4)
        self.assertEqual(harness.stage.stats()["zoneMembership"], "present")

    def test_entering_and_leaving_produces_transitions_on_the_live_path(self):
        harness = StageHarness()
        script = [None, ["z_till"], ["z_till"], None]
        for index, zones in enumerate(script):
            out = harness.frame([detection((0.5, 0.4, 0.08, 0.2), zones=zones)], at=f"{index}s", seq=index)
        transitions = out[0].attributes[ATTR_BEHAVIOUR]["zone"]["transitions"]
        self.assertEqual([t["transition"] for t in transitions], ["entered", "left"])

    def test_no_membership_reports_absent_rather_than_a_confident_zero(self):
        """⛔ The finding this slice exists to make visible: on the `/infer` path media resolves zones
        AFTER the runtime answers, so membership never arrives and every zone primitive is inert.
        `absent` is what an operator needs to read — not a dwell of 0.0 s for everyone."""
        harness = StageHarness()
        for index in range(5):
            out = harness.frame([detection((0.5, 0.4, 0.08, 0.2))], at=f"{index}s", seq=index)
        self.assertNotIn("zone", out[0].attributes[ATTR_BEHAVIOUR])
        self.assertEqual(harness.stage.stats()["zoneMembership"], "absent")

    def test_a_stage_that_has_seen_no_frames_says_unobserved_not_absent(self):
        self.assertEqual(StageHarness().stage.stats()["zoneMembership"], "unobserved")


class StageAssociationTests(unittest.TestCase):
    def test_a_bottle_carried_by_a_person_is_associated_through_the_real_tracker(self):
        """⭐ Person 0 and bottle 39 are both COCO-80 classes, so this chain is buildable today."""
        harness = StageHarness()
        for index in range(6):
            x = 0.30 + 0.03 * index
            out = harness.frame(
                [
                    detection((x, 0.40, 0.08, 0.20), label="person", class_id=0),
                    detection((x + 0.01, 0.45, 0.03, 0.06), label="bottle", class_id=39),
                ],
                at=f"{index}s",
                seq=index,
            )
        bottle = next(d for d in out if d.label == "bottle")
        held = bottle.attributes[ATTR_BEHAVIOUR]["association"]["heldBy"]
        self.assertEqual(len(held), 1)
        self.assertTrue(held[0]["current"])
        person = next(d for d in out if d.label == "person")
        self.assertEqual(held[0]["identityId"], person.identity_id)

    def test_a_bottle_on_a_shelf_nobody_is_near_is_held_by_nobody(self):
        harness = StageHarness()
        for index in range(6):
            out = harness.frame(
                [
                    detection((0.05, 0.40, 0.08, 0.20), label="person", class_id=0),
                    detection((0.90, 0.45, 0.03, 0.06), label="bottle", class_id=39),
                ],
                at=f"{index}s",
                seq=index,
            )
        bottle = next(d for d in out if d.label == "bottle")
        self.assertNotIn("association", bottle.attributes.get(ATTR_BEHAVIOUR, {}))


class StageIsolationTests(unittest.TestCase):
    def test_one_tenant_never_sees_another_tenants_behaviour(self):
        harness = StageHarness()
        for index in range(4):
            harness.frame([detection((0.3, 0.4, 0.08, 0.2))], at=f"{index}s", seq=index, tenant="tnt_a")
            harness.frame([detection((0.7, 0.4, 0.08, 0.2))], at=f"{index}s", seq=index, tenant="tnt_b")
        self.assertEqual(len(harness.recorder.live_records("tnt_a", "cam_1")), 1)
        self.assertEqual(len(harness.recorder.live_records("tnt_b", "cam_1")), 1)

    def test_erasure_removes_one_tenants_history_and_scene_labels_only(self):
        harness = StageHarness()
        for index in range(4):
            for tenant in ("tnt_a", "tnt_b"):
                harness.frame(
                    [detection((0.5, 0.4, 0.08, 0.2), zones=["z_till"])],
                    at=f"{index}s",
                    seq=index,
                    tenant=tenant,
                )
        self.assertTrue(harness.stage.scene_labels("tnt_a", "cam_1"))

        removed = harness.tracker.forget_tenant("tnt_a")
        harness.stage.forget_tenant("tnt_a")

        self.assertGreaterEqual(removed["historyRecordsRemoved"], 1)
        self.assertEqual(harness.recorder.live_records("tnt_a", "cam_1"), [])
        self.assertEqual(harness.stage.scene_labels("tnt_a", "cam_1"), [])
        self.assertEqual(len(harness.recorder.live_records("tnt_b", "cam_1")), 1)
        self.assertTrue(harness.stage.scene_labels("tnt_b", "cam_1"))


class DomainNeutralityTests(unittest.TestCase):
    def test_no_module_names_a_domain_concept(self):
        """⛔ ADR-0052's boundary, made executable. Crude, and it catches the exact regression that
        matters — a retail concept leaking into a layer five industries share."""
        import behaviour_modules

        forbidden = ("shelf", "theft", "steal", "conceal", "patient", "pallet", "checkout", "shoplif")
        leaked = [
            name
            for name in dir(behaviour_modules)
            if not name.startswith("_") and any(word in name.lower() for word in forbidden)
        ]
        self.assertEqual(leaked, [], f"domain vocabulary leaked into Layer 2: {leaked}")

    def test_the_registered_task_description_forbids_intent(self):
        self.assertIn("never an intent", describe_task(TASK_BEHAVIOUR))


if __name__ == "__main__":
    unittest.main()
