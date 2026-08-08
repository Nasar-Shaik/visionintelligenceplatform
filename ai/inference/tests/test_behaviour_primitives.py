"""Behaviour primitive tests (P-11 slice 2.1).

Every test here is written against a failure that **returns a number** rather than raising, because
that is the only kind that reaches production. The two that matter most are the scripted occlusion
(one person, one occlusion, one identity — not two) and frame-rate invariance (the same clip at 1 fps
and 4 fps must give the same answer in seconds).
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from behaviour_primitives import (  # noqa: E402
    Association,
    Interval,
    TrackPoint,
    Zone,
    associations,
    co_presence_seconds,
    direction_degrees,
    distance_between,
    dwell_seconds,
    group_by_identity,
    handovers,
    iou,
    near,
    observation_gaps,
    path_length,
    trajectory,
    velocity_frames_per_second,
    zone_transitions,
    zone_visits,
)

BOX = (0.40, 0.40, 0.10, 0.20)


def walk(identity, start_x, per_step, count, *, at=0.0, step=0.25, y=0.40, label="person"):
    """A subject moving along x, one point per `step` seconds of footage time."""
    return [
        TrackPoint(
            identity_id=identity,
            at_seconds=round(at + i * step, 4),
            bbox=(round(start_x + i * per_step, 6), y, 0.10, 0.20),
            label=label,
            track_id=f"{identity}_t0",
            frame_index=i,
        )
        for i in range(count)
    ]


class GroupingTests(unittest.TestCase):
    def test_points_are_sorted_by_footage_time(self):
        """⚠️ Out-of-order arrival is real — the runtime counts `outOfOrderFrames`."""
        points = [
            TrackPoint("p1", 3.0, BOX),
            TrackPoint("p1", 1.0, BOX),
            TrackPoint("p1", 2.0, BOX),
        ]

        grouped = group_by_identity(points)

        self.assertEqual([p.at_seconds for p in grouped["p1"]], [1.0, 2.0, 3.0])

    def test_identities_are_kept_apart(self):
        grouped = group_by_identity(walk("p1", 0.1, 0.01, 3) + walk("p2", 0.5, 0.01, 2))

        self.assertEqual(sorted(grouped), ["p1", "p2"])
        self.assertEqual(len(grouped["p1"]), 3)


class MotionTests(unittest.TestCase):
    def test_a_stationary_subject_and_an_empty_history_are_different_answers(self):
        """⛔ The defect class this project keeps finding: 0.0 reads as 'stood still'."""
        stationary = [TrackPoint("p1", t, BOX) for t in (0.0, 1.0, 2.0)]

        self.assertEqual(velocity_frames_per_second(stationary), 0.0)
        self.assertIsNone(velocity_frames_per_second([]))
        self.assertIsNone(velocity_frames_per_second([TrackPoint("p1", 0.0, BOX)]))

    def test_velocity_is_frame_widths_per_second(self):
        points = walk("p1", 0.10, 0.05, 5, step=0.25)  # 0.20 across 1.0 s

        self.assertAlmostEqual(velocity_frames_per_second(points), 0.20, places=4)

    def test_path_length_follows_the_path_not_the_endpoints(self):
        """A subject who walks out and back has travelled twice the displacement."""
        out = walk("p1", 0.10, 0.05, 3, step=0.25)
        back = walk("p1", 0.20, -0.05, 3, at=0.75, step=0.25)

        self.assertAlmostEqual(path_length(out + back), 0.20, places=4)

    def test_direction_is_measured_with_north_up_the_screen(self):
        """⚠️ Screen y grows downward; a subject walking up the frame heads north, not south."""
        upward = [
            TrackPoint("p1", 0.0, (0.40, 0.60, 0.10, 0.20)),
            TrackPoint("p1", 1.0, (0.40, 0.20, 0.10, 0.20)),
        ]

        self.assertAlmostEqual(direction_degrees(upward), 90.0, places=3)
        self.assertAlmostEqual(direction_degrees(walk("p1", 0.10, 0.05, 3)), 0.0, places=3)

    def test_a_subject_that_never_moved_has_no_direction(self):
        self.assertIsNone(direction_degrees([TrackPoint("p1", t, BOX) for t in (0.0, 1.0)]))

    def test_trajectory_is_centroids_in_time_order(self):
        self.assertEqual(len(trajectory(walk("p1", 0.10, 0.05, 4))), 4)


class ZoneTests(unittest.TestCase):
    def setUp(self):
        self.zone = Zone("z_shelf", (0.30, 0.00, 0.30, 1.00))

    def test_zone_membership_uses_the_foot_point_not_the_centroid(self):
        """⚠️ A centroid floats at chest height and can sit outside a floor region the subject is
        plainly standing in."""
        subject = TrackPoint("p1", 0.0, (0.32, 0.10, 0.10, 0.60))  # centroid y 0.40, feet y 0.70
        low_zone = Zone("z_floor", (0.30, 0.60, 0.30, 0.40))

        self.assertTrue(low_zone.contains(subject.foot_point))
        self.assertFalse(low_zone.contains(subject.centroid))

    def test_a_subject_who_leaves_and_returns_has_two_visits_and_one_dwell(self):
        """⭐ 'Was this person in the zone' cannot express the pattern that matters."""
        inside_a = walk("p1", 0.35, 0.0, 3, at=0.0, step=1.0)
        outside = walk("p1", 0.80, 0.0, 2, at=3.0, step=1.0)
        inside_b = walk("p1", 0.35, 0.0, 3, at=5.0, step=1.0)

        visits = zone_visits(inside_a + outside + inside_b, self.zone)

        self.assertEqual(len(visits), 2)
        self.assertAlmostEqual(dwell_seconds(inside_a + outside + inside_b, self.zone), 4.0, places=3)

    def test_a_visit_still_open_when_the_track_ends_is_marked(self):
        """⚠️ A truncated stay reported as completed understates exactly the longest dwells."""
        visits = zone_visits(walk("p1", 0.35, 0.0, 4, step=1.0), self.zone)

        self.assertEqual(len(visits), 1)
        self.assertTrue(visits[0].open_ended)

    def test_transitions_are_entered_and_left_in_time_order(self):
        points = walk("p1", 0.35, 0.0, 2, at=0.0, step=1.0) + walk("p1", 0.80, 0.0, 2, at=2.0, step=1.0)

        events = zone_transitions(points, [self.zone])

        self.assertEqual([(e[1], e[2]) for e in events], [("entered", "z_shelf"), ("left", "z_shelf")])

    def test_a_subject_who_never_enters_produces_nothing(self):
        """⭐ The negative control. A primitive that cannot read zero cannot be trusted to read one."""
        self.assertEqual(zone_visits(walk("p1", 0.80, 0.0, 5), self.zone), [])
        self.assertEqual(dwell_seconds(walk("p1", 0.80, 0.0, 5), self.zone), 0.0)


class OcclusionTests(unittest.TestCase):
    def test_one_person_one_occlusion_is_one_identity_not_two(self):
        """⛔ The single most likely defect in the phase.

        The tracker issues a NEW track id after the occlusion (ADR-0038 forbids reuse) while the
        identity is bridged. Grouping by track id would report two visits of 1 s; grouping by
        identity reports one subject present for 5 s.
        """
        before = [TrackPoint("id_1", t, BOX, track_id="t_1") for t in (0.0, 0.5, 1.0)]
        after = [TrackPoint("id_1", t, BOX, track_id="t_2") for t in (4.0, 4.5, 5.0)]

        grouped = group_by_identity(before + after)

        self.assertEqual(list(grouped), ["id_1"], "one identity, despite two track ids")
        self.assertEqual(len({p.track_id for p in grouped["id_1"]}), 2)
        zone = Zone("z_all", (0.0, 0.0, 1.0, 1.0))
        self.assertAlmostEqual(dwell_seconds(grouped["id_1"], zone), 5.0, places=3)

    def test_the_gap_itself_is_reported_without_being_explained(self):
        """⚠️ A shopper behind a display, an object in a bag and three missed frames look identical."""
        points = [TrackPoint("id_1", t, BOX) for t in (0.0, 0.25, 0.50, 3.0, 3.25)]

        gaps = observation_gaps(points, expected_interval=0.25)

        self.assertEqual(len(gaps), 1)
        self.assertAlmostEqual(gaps[0].seconds, 2.5, places=3)

    def test_ordinary_jitter_is_not_a_gap(self):
        points = [TrackPoint("id_1", t, BOX) for t in (0.0, 0.25, 0.52, 0.75)]

        self.assertEqual(observation_gaps(points, expected_interval=0.25), [])

    def test_an_impossible_sampling_interval_is_refused(self):
        with self.assertRaises(ValueError):
            observation_gaps([TrackPoint("id_1", 0.0, BOX)], expected_interval=0.0)


class FrameRateInvarianceTests(unittest.TestCase):
    """⛔ The same footage at two rates must give the same answer in seconds.

    Track age advances per *frame* in the runtime and `CAMERA_IDLE_SECONDS = 300`, so any primitive
    that counted frames instead of reading footage time would give two different answers here — and
    both would look reasonable in isolation.
    """

    def test_dwell_is_identical_at_one_and_four_frames_per_second(self):
        zone = Zone("z", (0.0, 0.0, 1.0, 1.0))
        at_4fps = walk("p1", 0.4, 0.0, 17, step=0.25)   # 0.00 → 4.00 s
        at_1fps = walk("p1", 0.4, 0.0, 5, step=1.0)     # 0.00 → 4.00 s

        self.assertAlmostEqual(dwell_seconds(at_4fps, zone), dwell_seconds(at_1fps, zone), places=3)

    def test_velocity_is_identical_at_one_and_four_frames_per_second(self):
        at_4fps = walk("p1", 0.10, 0.0125, 17, step=0.25)  # 0.20 over 4 s
        at_1fps = walk("p1", 0.10, 0.05, 5, step=1.0)      # 0.20 over 4 s

        self.assertAlmostEqual(
            velocity_frames_per_second(at_4fps), velocity_frames_per_second(at_1fps), places=4
        )


class RelationalTests(unittest.TestCase):
    def test_near_catches_both_close_and_overlapping(self):
        """⚠️ A hand reaching behind an object is centre-distant and overlapping."""
        hand = TrackPoint("p1", 0.0, (0.40, 0.40, 0.05, 0.05))
        beside = TrackPoint("obj", 0.0, (0.44, 0.40, 0.05, 0.05))  # centres 0.04 apart
        far = TrackPoint("obj", 0.0, (0.90, 0.90, 0.05, 0.05))
        behind = TrackPoint("obj", 0.0, (0.30, 0.30, 0.40, 0.40))

        self.assertTrue(near(hand, beside))
        self.assertTrue(near(hand, behind), "overlapping counts even when centres are far")
        self.assertFalse(near(hand, far))

    def test_distance_and_iou_are_independent_measures(self):
        a = TrackPoint("a", 0.0, (0.0, 0.0, 0.2, 0.2))
        b = TrackPoint("b", 0.0, (0.1, 0.0, 0.2, 0.2))

        self.assertAlmostEqual(distance_between(a, b), 0.1, places=4)
        self.assertGreater(iou(a.bbox, b.bbox), 0.0)
        self.assertEqual(iou((0.0, 0.0, 0.1, 0.1), (0.5, 0.5, 0.1, 0.1)), 0.0)

    def test_co_presence_measures_time_not_frames(self):
        a = walk("p1", 0.40, 0.0, 5, step=0.5)
        b = walk("p2", 0.42, 0.0, 5, step=0.5)

        self.assertAlmostEqual(co_presence_seconds(a, b), 2.0, places=3)

    def test_two_strangers_are_never_co_present(self):
        """⭐ The negative control for the relational family."""
        a = walk("p1", 0.05, 0.0, 5, step=0.5)
        b = walk("p2", 0.85, 0.0, 5, step=0.5)

        self.assertEqual(co_presence_seconds(a, b), 0.0)


class ObjectAssociationTests(unittest.TestCase):
    """⭐ What makes picked/returned/handover geometry instead of guesswork."""

    def test_an_object_travelling_with_one_person_yields_one_association(self):
        person = walk("p1", 0.20, 0.05, 5, step=0.5)
        bottle = walk("obj_1", 0.21, 0.05, 5, step=0.5, label="bottle")

        spans = associations(bottle, {"p1": person})

        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].subject_identity, "p1")

    def test_an_object_nobody_is_near_has_no_owner(self):
        """⭐ The negative control: a bottle on a shelf belongs to nobody."""
        person = walk("p1", 0.05, 0.0, 5, step=0.5)
        bottle = walk("obj_1", 0.85, 0.0, 5, step=0.5, label="bottle")

        self.assertEqual(associations(bottle, {"p1": person}), [])

    def test_an_object_passing_between_two_people_is_a_handover(self):
        """⭐ Retail collusion, a hospital instrument pass and a factory tool transfer — one
        primitive, three business meanings, which is why it is not a retail feature."""
        giver = [TrackPoint("p1", t, (0.30, 0.40, 0.10, 0.20)) for t in (0.0, 0.5, 1.0, 1.5, 2.0)]
        taker = [TrackPoint("p2", t, (0.60, 0.40, 0.10, 0.20)) for t in (0.0, 0.5, 1.0, 1.5, 2.0)]
        bottle = (
            [TrackPoint("obj_1", t, (0.34, 0.48, 0.03, 0.03), label="bottle") for t in (0.0, 0.5)]
            + [TrackPoint("obj_1", t, (0.64, 0.48, 0.03, 0.03), label="bottle") for t in (1.5, 2.0)]
        )

        spans = associations(bottle, {"p1": giver, "p2": taker}, threshold=0.02)
        events = handovers(spans)

        self.assertEqual([(e[1], e[2]) for e in events], [("p1", "p2")])

    def test_an_object_held_by_one_person_throughout_is_not_a_handover(self):
        """⭐ The negative control that stops `handovers` firing on everything."""
        person = walk("p1", 0.20, 0.05, 6, step=0.5)
        bottle = walk("obj_1", 0.21, 0.05, 6, step=0.5, label="bottle")

        self.assertEqual(handovers(associations(bottle, {"p1": person})), [])

    def test_a_long_pause_between_owners_is_not_a_handover(self):
        """⚠️ An object put down and picked up an hour later by someone else is not a handover."""
        spans = [
            Association("obj_1", "p1", Interval(0.0, 5.0)),
            Association("obj_1", "p2", Interval(3600.0, 3605.0)),
        ]

        self.assertEqual(handovers(spans, max_gap_seconds=2.0), [])


class DomainNeutralityTests(unittest.TestCase):
    """⛔ The executable form of the layer boundary (ADR-0052)."""

    def test_no_primitive_names_a_domain_concept(self):
        import behaviour_primitives

        forbidden = ("shelf", "theft", "steal", "conceal", "patient", "pallet", "checkout", "shoplif")
        exported = [n for n in dir(behaviour_primitives) if not n.startswith("_")]

        for name in exported:
            for word in forbidden:
                self.assertNotIn(word, name.lower(), f"'{name}' names a domain concept — it belongs in a rule")


if __name__ == "__main__":
    unittest.main()
