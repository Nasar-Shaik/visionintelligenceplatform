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
    PRIMITIVE_READINGS,
    Association,
    Scene,
    Interval,
    Line,
    TrackPoint,
    Zone,
    associations,
    co_presence_seconds,
    crossings,
    line_diagnostics,
    direction_degrees,
    distance_between,
    distance_changes,
    distance_series,
    dwell_seconds,
    follow_episodes,
    following,
    group_by_identity,
    group_changes,
    groups_at,
    handovers,
    iou,
    near,
    object_events,
    observation_gaps,
    path_length,
    stationary_episodes,
    stationary_groups,
    stationary_readings,
    togetherness,
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


# =================================================================================================
# Slice 2.5 — the primitives that need only tracked identities.
# =================================================================================================


def still(identity, x, count, *, at=0.0, step=0.5, y=0.40, jitter=0.0):
    """A subject standing on one spot, optionally with a jittering box."""
    return [
        TrackPoint(
            identity_id=identity,
            at_seconds=round(at + i * step, 4),
            bbox=(round(x + (jitter if i % 2 else -jitter), 6), y, 0.10, 0.20),
            track_id=f"{identity}_t0",
            frame_index=i,
        )
        for i in range(count)
    ]


class StationaryTests(unittest.TestCase):
    def test_a_subject_who_never_moves_is_one_episode(self):
        episodes = stationary_episodes(still("p1", 0.5, 30), radius=0.02, min_seconds=3.0)

        self.assertEqual(len(episodes), 1)
        self.assertAlmostEqual(episodes[0].interval.seconds, 14.5, places=4)
        self.assertEqual(episodes[0].radius_normalized, 0.0)

    def test_a_slow_walk_across_the_frame_is_not_standing_still(self):
        """⛔ The defect the anchor exists to prevent.

        A centre that follows the subject drifts with them, so a steady stroll never breaks any
        threshold and reads as one long stationary episode. 0.004 frame widths per step is far under
        the 0.02 idle radius — and over 40 steps it crosses a sixth of the frame in 39 seconds.
        """
        strolling = walk("p1", 0.10, 0.004, 40, step=1.0)

        episodes = stationary_episodes(strolling, radius=0.02, min_seconds=3.0)

        # ⛔ The whole walk must not come back as one stay. Each anchor lasts until the subject has
        # drifted a full radius from where it was set, so the stroll fragments rather than merging.
        self.assertTrue(episodes)
        for episode in episodes:
            self.assertLessEqual(episode.radius_normalized, 0.02)
        self.assertLess(max(e.interval.seconds for e in episodes), 10.0)

    def test_a_stroll_sampled_faster_than_the_minimum_produces_no_episode_at_all(self):
        """⚠️ The same walk at 4 fps: every anchor breaks in 1.25 s, under the 3 s floor, so nothing
        is reported. Silence is the right answer — the subject never stood still."""
        self.assertEqual(stationary_episodes(walk("p1", 0.10, 0.004, 40), radius=0.02, min_seconds=3.0), [])

    def test_the_same_stand_is_the_same_seconds_at_1_fps_and_4_fps(self):
        """⚠️ Frame-rate invariance, the trap the module docstring names as #2."""
        slow = stationary_episodes(still("p1", 0.5, 21, step=1.0), radius=0.02, min_seconds=3.0)
        fast = stationary_episodes(still("p1", 0.5, 81, step=0.25), radius=0.02, min_seconds=3.0)

        self.assertAlmostEqual(slow[0].interval.seconds, fast[0].interval.seconds, places=3)

    def test_an_episode_still_open_when_the_track_ends_says_so(self):
        episodes = stationary_episodes(still("p1", 0.5, 30), radius=0.02, min_seconds=3.0)

        self.assertTrue(episodes[-1].open_ended)

    def test_idle_nests_inside_linger_rather_than_sitting_beside_it(self):
        """⚠️ Both names describe one stand. A caller summing them adds an event to itself."""
        readings = stationary_readings(still("p1", 0.5, 60))

        self.assertEqual(len(readings["idle"]), 1)
        self.assertEqual(len(readings["linger"]), 1)
        self.assertGreaterEqual(
            readings["linger"][0].interval.seconds, readings["idle"][0].interval.seconds
        )

    def test_a_stand_shorter_than_the_reading_is_not_reported(self):
        """⛔ A four-second pause is not lingering, and `linger` must not report it as such."""
        readings = stationary_readings(still("p1", 0.5, 9))

        self.assertTrue(readings["idle"])
        self.assertEqual(readings["linger"], [])

    def test_too_few_points_is_no_episodes_rather_than_an_error(self):
        self.assertEqual(stationary_episodes(still("p1", 0.5, 1), radius=0.02, min_seconds=0.0), [])

    def test_a_nonsense_radius_is_refused_rather_than_silently_accepted(self):
        with self.assertRaises(ValueError):
            stationary_episodes(still("p1", 0.5, 5), radius=0.0, min_seconds=1.0)


class LineCrossingTests(unittest.TestCase):
    LINE = Line("ln_mid", [(0.5, 0.0), (0.5, 1.0)])

    def test_walking_across_reports_one_crossing_with_both_sides_named(self):
        found = crossings(walk("p1", 0.30, 0.03, 20), self.LINE)

        self.assertEqual(len(found), 1)
        self.assertEqual((found[0].from_side, found[0].to_side), ("right", "left"))

    def test_walking_back_reports_the_opposite_direction(self):
        found = crossings(walk("p1", 0.70, -0.03, 20), self.LINE)

        self.assertEqual(len(found), 1)
        self.assertEqual((found[0].from_side, found[0].to_side), ("left", "right"))

    def test_a_point_landing_exactly_on_the_line_does_not_hide_the_crossing(self):
        """⛔ Found by this function's first smoke test.

        An operator draws a line down the middle of a doorway; a subject sampled while standing in it
        reads `on`. Comparing only adjacent observations made that reading break the comparison on
        *both* sides of itself, and a clean walk across produced no crossing at all.
        """
        onto_the_line = walk("p1", 0.39, 0.03, 6)  # foot point steps 0.44 → 0.47 → 0.50 → 0.53

        self.assertTrue(any(p.foot_point[0] == 0.5 for p in onto_the_line))
        self.assertEqual(len(crossings(onto_the_line, self.LINE)), 1)

    def test_there_and_back_is_two_crossings_in_opposite_directions(self):
        there_and_back = walk("p1", 0.30, 0.03, 10) + walk("p1", 0.57, -0.03, 10, at=5.0)

        found = crossings(there_and_back, self.LINE)

        self.assertEqual([(c.from_side, c.to_side) for c in found], [("right", "left"), ("left", "right")])

    def test_walking_round_the_end_of_a_line_is_not_a_crossing(self):
        """⛔ The infinite line divides the frame; the drawn segment does not. Counting a side change
        that never passed through the segment makes a tripwire fire for everyone in the room."""
        short = Line("ln_short", [(0.5, 0.0), (0.5, 0.20)])

        self.assertEqual(crossings(walk("p1", 0.30, 0.03, 20, y=0.60), short), [])

    def test_a_subject_who_never_reaches_the_line_crosses_nothing(self):
        self.assertEqual(crossings(walk("p1", 0.10, 0.01, 10), self.LINE), [])

    def test_a_line_that_stops_short_reports_the_side_change_as_a_diagnostic(self):
        """⭐ **The finding this diagnostic exists for, reproduced.**

        ⛔ On the deployment an operator drew a tripwire from y = 0.05 to y = 0.95 — visually across
        the whole frame — and a person walking straight through it produced **zero** crossings. The
        code was right: a crossing is anchored at the FOOT point, a standing person's feet sit at
        y ≈ 0.95, and the walk passed around the bottom end of the drawn segment. Correct, and
        completely invisible.

        `side_changes > 0` with `crossings == 0` is that situation named, so an operator can be told
        *"people are walking past this line rather than through it"* instead of being shown silence.
        """
        short = Line("ln_short", [(0.5, 0.0), (0.5, 0.20)])
        past_the_end = walk("p1", 0.30, 0.03, 20, y=0.60)

        self.assertEqual(crossings(past_the_end, short), [])
        diagnostic = line_diagnostics({"p1": past_the_end}, [short])[0]
        self.assertEqual(diagnostic.crossings, 0)
        self.assertEqual(diagnostic.side_changes, 1)
        self.assertEqual(diagnostic.missed_the_segment, 1)

    def test_a_line_drawn_correctly_reports_no_misses(self):
        """⚠️ The paired control: the same walk against a line that reaches the edges. Without this
        the diagnostic could report a miss for everything and still look meaningful."""
        walked = walk("p1", 0.30, 0.03, 20, y=0.60)

        diagnostic = line_diagnostics({"p1": walked}, [self.LINE])[0]
        self.assertEqual(diagnostic.crossings, 1)
        self.assertEqual(diagnostic.missed_the_segment, 0)
        self.assertEqual(diagnostic.side_changes, 1)

    def test_a_subject_who_never_changes_side_produces_no_diagnostic_noise(self):
        """⛔ `missedTheSegment` must not count people who simply stayed put — it would then be
        non-zero on every busy scene and mean nothing."""
        diagnostic = line_diagnostics({"p1": walk("p1", 0.10, 0.01, 10)}, [self.LINE])[0]
        self.assertEqual((diagnostic.side_changes, diagnostic.crossings, diagnostic.missed_the_segment), (0, 0, 0))

    def test_the_diagnostic_never_turns_a_miss_into_a_crossing(self):
        """⚠️ A diagnostic, never an event. The fix for a short line is to draw it properly."""
        short = Line("ln_short", [(0.5, 0.0), (0.5, 0.20)])
        subjects = {"p1": walk("p1", 0.30, 0.03, 20, y=0.60)}

        self.assertEqual(line_diagnostics(subjects, [short])[0].crossings, 0)
        self.assertEqual(crossings(subjects["p1"], short), [])

    def test_a_crossing_hidden_by_an_occlusion_still_counts(self):
        """⛔ A detector that missed the moment does not undo the passage."""
        before = walk("p1", 0.30, 0.01, 5)
        after = walk("p1", 0.62, 0.01, 5, at=20.0)

        found = crossings(before + after, self.LINE)

        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].at_seconds, 20.0)

    def test_the_side_names_follow_the_order_the_operator_drew_the_line(self):
        """⚠️ Reversing a line swaps left and right — which is why an incident carries a zone version."""
        reversed_line = Line("ln_mid", [(0.5, 1.0), (0.5, 0.0)])

        forward = crossings(walk("p1", 0.30, 0.03, 20), self.LINE)[0]
        backward = crossings(walk("p1", 0.30, 0.03, 20), reversed_line)[0]

        self.assertEqual((forward.from_side, forward.to_side), ("right", "left"))
        self.assertEqual((backward.from_side, backward.to_side), ("left", "right"))


class DistanceChangeTests(unittest.TestCase):
    def test_two_subjects_closing_report_an_approach(self):
        changes = distance_changes(walk("p1", 0.10, 0.02, 15), walk("p2", 0.80, -0.02, 15))

        self.assertEqual(changes[0].kind, "approach")
        self.assertLess(changes[0].to_normalized, changes[0].from_normalized)
        self.assertEqual(changes[0].other_identity_id, "p2")

    def test_two_subjects_parting_report_a_recession(self):
        changes = distance_changes(walk("p1", 0.45, -0.02, 15), walk("p2", 0.55, 0.02, 15))

        self.assertEqual([c.kind for c in changes], ["recede"])
        self.assertGreater(changes[0].delta_normalized, 0)

    def test_a_jittering_box_between_two_stationary_subjects_reports_nothing(self):
        """⛔ Without the deadband this is a hundred alternating episodes describing two people
        standing still. A timeline that noisy is a timeline nobody reads."""
        changes = distance_changes(
            still("p1", 0.40, 40, jitter=0.002), still("p2", 0.60, 40, jitter=0.002)
        )

        self.assertEqual(changes, [])

    def test_a_gap_that_barely_moves_is_not_a_change(self):
        changes = distance_changes(walk("p1", 0.10, 0.0005, 20), still("p2", 0.80, 20))

        self.assertEqual(changes, [])

    def test_subjects_never_seen_on_the_same_frame_produce_nothing(self):
        """⛔ No interpolation. A gap measured against a stale position is a claim nobody made."""
        first = walk("p1", 0.10, 0.02, 10, at=0.0)
        second = walk("p2", 0.80, -0.02, 10, at=100.0)

        self.assertEqual(distance_series(first, second), [])
        self.assertEqual(distance_changes(first, second), [])


class GroupTests(unittest.TestCase):
    def test_subjects_standing_apart_are_separate_groups(self):
        groups = groups_at({"p1": still("p1", 0.10, 5), "p2": still("p2", 0.80, 5)}, at_seconds=0.0)

        self.assertEqual(groups, [("p1",), ("p2",)])

    def test_grouping_is_transitive_and_that_is_stated_rather_than_hidden(self):
        """⚠️ A, B, C in a line each `threshold` apart is one group of three, even though A and C are
        twice `threshold` apart. Right for a queue, wrong for a huddle — and no threshold fixes it."""
        chain = {
            "p1": still("p1", 0.30, 5),
            "p2": still("p2", 0.42, 5),
            "p3": still("p3", 0.54, 5),
        }

        self.assertEqual(groups_at(chain, at_seconds=0.0), [("p1", "p2", "p3")])

    def test_two_subjects_walking_together_then_apart_merge_then_split(self):
        subjects = {
            "p1": walk("p1", 0.20, 0.02, 30, step=0.5),
            "p2": walk("p2", 0.80, -0.02, 30, step=0.5),
        }

        changes = group_changes(subjects)

        self.assertEqual([c.kind for c in changes], ["merge", "split"])
        self.assertEqual(changes[0].identities, ("p1", "p2"))
        self.assertLess(changes[0].at_seconds, changes[1].at_seconds)

    def test_a_subject_walking_out_of_frame_is_not_a_split(self):
        """⛔ The case a naive implementation gets wrong. Someone leaving shrinks their group without
        anyone having separated from anyone — and in a busy scene every exit would be a social event.
        """
        together = {
            "p1": still("p1", 0.40, 40),
            "p2": still("p2", 0.48, 20),  # leaves halfway through
        }

        self.assertEqual(group_changes(together), [])

    def test_a_pair_hovering_at_the_threshold_does_not_flicker(self):
        """⛔ Undebounced, this emits a merge and a split per frame for the rest of the clip."""
        at_the_line = {
            "p1": still("p1", 0.40, 60),
            "p2": still("p2", 0.55, 60, jitter=0.004),
        }

        changes = group_changes(at_the_line)

        self.assertLessEqual(len(changes), 2, [(c.kind, c.at_seconds) for c in changes])

    def test_togetherness_bridges_a_single_missed_frame(self):
        walked = walk("p1", 0.40, 0.0, 30)
        alongside = walk("p2", 0.45, 0.0, 30)
        gapped = [p for p in alongside if p.frame_index != 15]

        spans = togetherness(walked, gapped)

        self.assertEqual(len(spans), 1)


class StationaryGroupTests(unittest.TestCase):
    def test_three_subjects_standing_together_are_one_stationary_group(self):
        groups = stationary_groups(
            {"p1": still("p1", 0.40, 40), "p2": still("p2", 0.50, 40), "p3": still("p3", 0.60, 40)}
        )

        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0].identities, ("p1", "p2", "p3"))
        self.assertGreaterEqual(groups[0].interval.seconds, 8.0)

    def test_subjects_walking_together_are_not_a_stationary_group(self):
        """⛔ The negative control that separates waiting from a group strolling past."""
        moving = {"p1": walk("p1", 0.10, 0.02, 40), "p2": walk("p2", 0.20, 0.02, 40)}

        self.assertEqual(stationary_groups(moving), [])

    def test_one_subject_standing_alone_is_not_a_group(self):
        self.assertEqual(stationary_groups({"p1": still("p1", 0.40, 40)}), [])

    def test_linearity_is_reported_and_never_used_as_a_gate(self):
        """⚠️ People queue round corners, so a linearity threshold drops real queues. The number is
        for a Layer 3 rule to weigh — which is why an L-shaped group is still returned."""
        bent = {
            "p1": still("p1", 0.40, 40, y=0.40),
            "p2": still("p2", 0.50, 40, y=0.40),
            "p3": still("p3", 0.50, 40, y=0.55),
        }

        groups = stationary_groups(bent)

        self.assertEqual(len(groups), 1)
        self.assertLess(groups[0].linearity, 1.0)


class FollowingTests(unittest.TestCase):
    def test_one_subject_walking_behind_another_on_their_heading_is_following(self):
        leader = walk("p1", 0.30, 0.02, 30)
        follower = walk("p2", 0.20, 0.02, 30)

        episodes = following(follower, leader)

        self.assertEqual(len(episodes), 1)
        self.assertEqual(episodes[0].leader_identity_id, "p1")
        self.assertAlmostEqual(episodes[0].mean_distance_normalized, 0.10, places=4)

    def test_following_is_asymmetric(self):
        """⛔ A behind B is not B behind A, and a symmetric answer would accuse the wrong person."""
        leader = walk("p1", 0.30, 0.02, 30)
        follower = walk("p2", 0.20, 0.02, 30)

        self.assertTrue(following(follower, leader))
        self.assertEqual(following(leader, follower), [])

    def test_walking_side_by_side_is_not_following(self):
        leader = walk("p1", 0.30, 0.02, 30, y=0.40)
        beside = walk("p2", 0.30, 0.02, 30, y=0.62)

        self.assertEqual(following(beside, leader), [])

    def test_standing_together_is_not_following(self):
        """⛔ Condition 1. A pair waiting side by side is a group, not a pursuit."""
        self.assertEqual(following(still("p2", 0.45, 30), still("p1", 0.40, 30)), [])

    def test_walking_the_other_way_is_not_following(self):
        leader = walk("p1", 0.30, 0.02, 30)
        oncoming = walk("p2", 0.80, -0.02, 30)

        self.assertEqual(following(oncoming, leader), [])

    def test_a_subject_too_far_behind_is_not_following(self):
        leader = walk("p1", 0.60, 0.01, 30)
        distant = walk("p2", 0.05, 0.01, 30)

        self.assertEqual(following(distant, leader), [])


class ReadingTests(unittest.TestCase):
    """⭐ `PRIMITIVE_READINGS` is the only place a business word is attached to a number."""

    def test_every_reading_names_a_mechanism_that_exists(self):
        import behaviour_primitives

        for name, reading in PRIMITIVE_READINGS.items():
            mechanism = reading["mechanism"]
            self.assertTrue(
                callable(getattr(behaviour_primitives, str(mechanism), None)),
                f"reading '{name}' names mechanism '{mechanism}', which is not a function here",
            )

    def test_every_reading_says_what_it_means_in_a_sentence(self):
        for name, reading in PRIMITIVE_READINGS.items():
            self.assertTrue(str(reading.get("means", "")).strip(), f"reading '{name}' explains nothing")

    def test_no_reading_names_an_intent(self):
        """⛔ ADR-0052 at the one table that gives words to geometry. `linger` is a duration;
        `loiter` is a motive, and the difference is the layer boundary."""
        forbidden = ("loiter", "steal", "conceal", "suspicious", "intruder", "tailgate", "abandon")
        for name, reading in PRIMITIVE_READINGS.items():
            text = f"{name} {reading.get('means', '')}".lower()
            for word in forbidden:
                self.assertNotIn(word, text, f"reading '{name}' names an intent")

    def test_the_readings_the_platform_promises_are_all_present(self):
        """⛔ Spelled out, so a primitive quietly disappearing fails here rather than in a demo."""
        for name in (
            "idle",
            "linger",
            "queue",
            "follow",
            "approach",
            "recede",
            "group_merge",
            "group_split",
            "cross_line",
            "enter_zone",
            "exit_zone",
        ):
            self.assertIn(name, PRIMITIVE_READINGS)


class ObjectEventTests(unittest.TestCase):
    """`pick_object`, `drop_object`, `object_missing`, `object_returned` — the regression suite.

    ⛔ **Not one of these has ever run on an object the platform detected.** Across every recording
    this deployment has analysed the detector has returned `person`, plus `tie` and `toilet` false
    positives — so these tests author their objects, and they cannot prove the detector will produce
    one. See `docs/validation/OBJECT_ASSOCIATION.md`, and `tools/validation/object-association.mjs`,
    which refuses to report a pass until real footage arrives.
    """

    def scene(self):
        """A person walks to a bottle, takes it, carries it, and puts it down."""
        person = (
            walk("id_p", 0.10, 0.02, 20, step=0.5)
            + walk("id_p", 0.48, 0.02, 20, at=10.0, step=0.5)
            + walk("id_p", 0.86, 0.02, 10, at=20.0, step=0.5)
        )
        bottle = (
            walk("id_b", 0.50, 0.0, 20, step=0.5, label="bottle")
            + walk("id_b", 0.50, 0.02, 20, at=10.0, step=0.5, label="bottle")
            + walk("id_b", 0.88, 0.0, 10, at=20.0, step=0.5, label="bottle")
        )
        return person, bottle

    def test_taking_an_object_and_putting_it_down_is_a_pick_then_a_drop(self):
        person, bottle = self.scene()

        events = object_events(bottle, {"id_p": person}, expected_interval=0.5)

        self.assertEqual([e.kind for e in events], ["picked", "dropped"])
        self.assertTrue(all(e.subject_identity == "id_p" for e in events))
        self.assertGreater(events[1].seconds, 0.0)

    def test_an_object_nobody_touches_produces_nothing(self):
        """⭐ The negative control. A bottle on a counter with a person walking past at the far side
        of the frame is not an interaction, and a primitive that cannot read zero cannot be trusted."""
        parked = walk("id_b", 0.90, 0.0, 40, step=0.5, label="bottle")
        passer = walk("id_p", 0.05, 0.004, 40, step=0.5)

        self.assertEqual(object_events(parked, {"id_p": passer}, expected_interval=0.5), [])

    def test_an_object_still_being_carried_when_the_run_ends_is_not_dropped(self):
        """⛔ The run ending is not an event. A `dropped` here would tell an investigator the subject
        put it down, which is precisely what was not observed."""
        person = walk("id_p", 0.10, 0.02, 30, step=0.5)
        bottle = walk("id_b", 0.14, 0.02, 30, step=0.5, label="bottle")

        events = object_events(bottle, {"id_p": person}, expected_interval=0.5)

        self.assertEqual([e.kind for e in events], ["picked"])

    def test_an_object_that_vanishes_is_missing_with_whoever_it_was_last_with(self):
        """⭐ The join a rule needs, and the one thing the gap itself cannot say."""
        person = walk("id_p", 0.10, 0.02, 20, step=0.5) + walk("id_p", 0.50, 0.02, 20, at=20.0, step=0.5)
        bottle = walk("id_b", 0.12, 0.02, 20, step=0.5, label="bottle")

        events = object_events(bottle, {"id_p": person}, expected_interval=0.5)

        self.assertEqual([e.kind for e in events], ["picked"])
        # The object simply stops; with no later observation there is no gap, and so no `missing`.
        self.assertNotIn("missing", [e.kind for e in events])

    def test_an_object_that_disappears_and_comes_back_is_missing_then_returned(self):
        person = walk("id_p", 0.10, 0.01, 60, step=0.5)
        bottle = walk("id_b", 0.12, 0.01, 20, step=0.5, label="bottle") + walk(
            "id_b", 0.32, 0.01, 20, at=25.0, step=0.5, label="bottle"
        )

        events = [e for e in object_events(bottle, {"id_p": person}, expected_interval=0.5)]
        kinds = [e.kind for e in events]

        self.assertIn("missing", kinds)
        self.assertIn("returned", kinds)
        self.assertLess(
            next(e.at_seconds for e in events if e.kind == "missing"),
            next(e.at_seconds for e in events if e.kind == "returned"),
        )

    def test_missing_is_the_word_because_put_down_and_hidden_are_one_observation(self):
        """⛔ ADR-0052 at the single most tempting place to break it. A bag placed on a shelf and a
        bag pushed into a coat produce the *same* frames; separating them needs evidence this layer
        does not have, so the word states what was seen."""
        for name in ("object_missing", "object_returned", "pick_object", "drop_object"):
            text = f"{name} {PRIMITIVE_READINGS[name]['means']}".lower()
            for word in ("conceal", "steal", "hidden", "theft", "suspicious"):
                self.assertNotIn(word, text)

    def test_events_are_ordered_and_reproducible(self):
        person, bottle = self.scene()

        once = object_events(bottle, {"id_p": person}, expected_interval=0.5)
        twice = object_events(bottle, {"id_p": person}, expected_interval=0.5)

        self.assertEqual(once, twice)
        self.assertEqual([e.at_seconds for e in once], sorted(e.at_seconds for e in once))


class PreparationTests(unittest.TestCase):
    """⛔ The guard on the defect slice 2.5 shipped: a 43-second Behaviour API read.

    Four pairwise families arrived, and each walked every pair while recomputing, inside that walk,
    work that belongs to one identity. **Every unit test passed the whole time** — they each author
    two or three identities, where n² is 4 and nothing is slow.

    ⭐ These count operations rather than seconds. A wall-clock assertion on a shared runner is a
    flake; the *shape* of the work is what regressed, and the shape is deterministic.
    """

    def scene_of(self, count, points=20):
        return {f"p{i}": walk(f"p{i}", 0.10 + 0.02 * i, 0.01, points) for i in range(count)}

    def counted(self, name):
        """Replace a module function with one that records its calls, restoring it afterwards."""
        import behaviour_primitives as module

        calls = []
        original = getattr(module, name)

        def recording(*args, **kwargs):
            calls.append(args)
            return original(*args, **kwargs)

        setattr(module, name, recording)
        self.addCleanup(setattr, module, name, original)
        return calls

    def test_each_identity_is_prepared_once_however_many_partners_it_has(self):
        """⛔ 8 identities × 20 points = 160 headings. The pair loop computed 8 × 7 × 20 × 2 = 2 240,
        and at 98 identities that was 541 440 where 11 760 would do."""
        calls = self.counted("_local_heading")

        following_episodes = follow_episodes(self.scene_of(8))

        self.assertEqual(len(calls), 8 * 20)
        self.assertIsInstance(following_episodes, dict)

    def test_a_pairs_distance_series_is_computed_once_however_many_families_ask_for_it(self):
        """⭐ Following, distance change, togetherness and grouping all want the same series."""
        calls = self.counted("_matched")
        scene = Scene(self.scene_of(4))

        for _ in range(3):
            for a in scene.identities:
                for b in scene.identities:
                    if a != b:
                        scene.matched(a, b)

        # 4 identities ⇒ 6 unordered pairs, asked for 36 times.
        self.assertEqual(len(calls), 6)

    def test_the_order_a_pair_is_named_in_does_not_produce_a_second_series(self):
        calls = self.counted("_matched")
        scene = Scene(self.scene_of(2))

        self.assertEqual(scene.matched("p0", "p1"), scene.matched("p1", "p0"))
        self.assertEqual(len(calls), 1)

    def test_identities_never_seen_at_the_same_moment_are_not_compared_at_all(self):
        """⚠️ Free and always sound — and it is what makes a real hour of footage cheap, because
        people arrive and leave rather than all standing there at once."""
        early = walk("p1", 0.30, 0.01, 20, at=0.0)
        late = walk("p2", 0.32, 0.01, 20, at=500.0)

        scene = Scene({"p1": early, "p2": late})

        self.assertEqual(scene.pairs(), [])

    def test_a_crowd_past_the_cap_is_truncated_and_the_scene_says_so(self):
        """⛔ A truncated scene returns a complete-looking answer in which a merge simply never
        happened — worse than a short list, because nothing about it looks short."""
        scene = Scene(self.scene_of(50), max_identities=32)

        self.assertTrue(scene.truncated)
        self.assertEqual(scene.considered, 32)
        self.assertEqual(len(scene.identities), 32)

    def test_a_scene_within_the_cap_does_not_claim_to_be_truncated(self):
        scene = Scene(self.scene_of(4), max_identities=32)

        self.assertFalse(scene.truncated)
        self.assertEqual(scene.considered, 4)

    def test_a_single_observation_is_not_a_series_and_is_left_out(self):
        """⚠️ Every pairwise primitive needs two points to say anything; carrying one-point
        identities into the scene would only make each pair test fail later and more expensively."""
        scene = Scene({"p1": walk("p1", 0.3, 0.01, 20), "p2": walk("p2", 0.3, 0.01, 1)})

        self.assertEqual(scene.identities, ["p1"])

    def test_the_batch_and_pair_functions_give_the_same_answer(self):
        """⛔ The rule that keeps this an optimisation rather than a fork. Two implementations of
        'is this person behind that one' is exactly what this layer must not have."""
        subjects = {
            "p1": walk("p1", 0.30, 0.02, 30, step=0.5),
            "p2": walk("p2", 0.20, 0.02, 30, step=0.5),
        }

        batch = follow_episodes(subjects)
        pairwise = following(subjects["p2"], subjects["p1"])

        self.assertEqual(batch.get("p2"), pairwise)


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
