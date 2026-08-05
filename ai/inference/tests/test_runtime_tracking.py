"""P-8 Phase 4 tracking tests — motion, predictive association, re-entry, and the live RuntimeTracker.

Deterministic and stdlib-only: frames are driven by hand with explicit timestamps, so occlusion,
disappearance and two people crossing are exact scenarios rather than timing luck.

⚠️ The assertions here are about **identity**, not about detection. Every test feeds the tracker
detections it has authored, so a failure means the tracking logic is wrong — never that the model had
a bad frame. Whether the model finds the person in the first place is the deployment's job to prove,
and `docs/review/p8/tracking.mjs` proves it against real video.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contracts import Detection, FrameContext  # noqa: E402
from reentry import ReentryResolver  # noqa: E402
from runtime_tracking import RuntimeTracker, TrackingOptions  # noqa: E402
from track_manager import TrackManager  # noqa: E402
from track_motion import (  # noqa: E402
    DWELL_SPEED,
    heading_label,
    heading_of,
    motion_from_history,
    seconds_of,
)
from tracker import IouAssociator, PredictiveIouAssociator, predict_bbox, velocity_of  # noqa: E402
from tracking_contracts import (  # noqa: E402
    Track,
    TrackHistoryPoint,
    TrackQuality,
    TrackState,
)


def det(label="person", conf=0.9, bbox=(0.4, 0.4, 0.1, 0.1), class_id=0):
    return Detection(label=label, confidence=conf, bbox=bbox, class_id=class_id)


def ctx(camera="cam_1", tenant="tnt_a", seq=0, at="2026-08-05T09:00:00.000Z"):
    return FrameContext(
        tenant_id=tenant, camera_id=camera, image=b"", frame_number=seq, timestamp=at
    )


def iso(second: float) -> str:
    """A wall-clock stamp `second` seconds after 09:00:00Z — the live path's format."""
    whole = int(second)
    ms = int(round((second - whole) * 1000))
    return f"2026-08-05T09:{whole // 60:02d}:{whole % 60:02d}.{ms:03d}Z"


def history(points, start=0, step=1.0):
    """`points` is a list of (x, y) centroids; boxes are 0.1 square centred on each."""
    return [
        TrackHistoryPoint(
            frame_index=start + i,
            at=iso(i * step),
            bbox=(x - 0.05, y - 0.05, 0.1, 0.1),
            centroid=(x, y),
        )
        for i, (x, y) in enumerate(points)
    ]


def a_track(track_id="t1", centroid=(0.5, 0.5), last_frame=5, label="person", hist=None):
    x, y = centroid
    return Track(
        track_id=track_id,
        tenant_id="tnt_a",
        camera_id="cam_1",
        label=label,
        state=TrackState.CONFIRMED,
        confidence=0.9,
        bbox=(x - 0.05, y - 0.05, 0.1, 0.1),
        first_seen_frame=0,
        first_seen_at=iso(0),
        last_seen_frame=last_frame,
        last_seen_at=iso(last_frame),
        age=last_frame,
        hits=last_frame + 1,
        centroid=(x, y),
        quality=TrackQuality(tracking_confidence=0.9),
        history=hist or [],
    )


# ── motion ───────────────────────────────────────────────────────────────────────────────────────


class MotionTests(unittest.TestCase):
    def test_single_point_has_no_motion(self):
        """⚠️ None, not a zero-filled motion. One observation carries no movement information, and
        'speed 0.0' is a claim that the object was standing still."""
        self.assertIsNone(motion_from_history(history([(0.5, 0.5)])))

    def test_straight_walk_right(self):
        m = motion_from_history(history([(0.1, 0.5), (0.2, 0.5), (0.3, 0.5), (0.4, 0.5)]))
        self.assertAlmostEqual(m.duration_seconds, 3.0, places=2)
        self.assertAlmostEqual(m.path_length, 0.3, places=5)
        self.assertAlmostEqual(m.displacement, 0.3, places=5)
        self.assertAlmostEqual(m.average_speed, 0.1, places=5)
        self.assertAlmostEqual(m.straightness, 1.0, places=5)
        self.assertEqual(m.heading_label, "right")
        self.assertEqual(m.samples, 4)

    def test_headings_cover_the_compass_in_image_space(self):
        """⚠️ +y is DOWN in an image, so 90° is 'down' rather than 'up'."""
        self.assertEqual(heading_label(heading_of(1, 0)), "right")
        self.assertEqual(heading_label(heading_of(0, 1)), "down")
        self.assertEqual(heading_label(heading_of(-1, 0)), "left")
        self.assertEqual(heading_label(heading_of(0, -1)), "up")
        self.assertEqual(heading_label(heading_of(1, 1)), "down-right")

    def test_a_barely_moving_track_reports_no_heading(self):
        """⚠️ Omitted rather than 0°, which would read as 'travelling right'."""
        m = motion_from_history(history([(0.5, 0.5), (0.5005, 0.5), (0.501, 0.5)]))
        self.assertIsNone(m.heading_degrees)
        self.assertIsNone(m.heading_label)

    def test_standing_still_accumulates_dwell(self):
        m = motion_from_history(history([(0.5, 0.5)] * 6))
        self.assertAlmostEqual(m.dwell_seconds, 5.0, places=2)
        self.assertAlmostEqual(m.path_length, 0.0, places=6)

    def test_walking_accumulates_no_dwell(self):
        m = motion_from_history(history([(0.1, 0.5), (0.2, 0.5), (0.3, 0.5)]))
        self.assertEqual(m.dwell_seconds, 0.0)

    def test_dwell_threshold_is_the_boundary_it_claims(self):
        step = DWELL_SPEED * 0.9
        m = motion_from_history(history([(0.5, 0.5), (0.5 + step, 0.5)]))
        self.assertGreater(m.dwell_seconds, 0.0)

    def test_straightness_is_none_for_an_unmoved_track(self):
        """⚠️ 0/0 is undefined, and 1.0 ('perfectly straight') is the flattering reading of it."""
        self.assertIsNone(motion_from_history(history([(0.5, 0.5), (0.5, 0.5)])).straightness)

    def test_wandering_scores_lower_straightness_than_walking(self):
        straight = motion_from_history(history([(0.1, 0.5), (0.3, 0.5), (0.5, 0.5)]))
        wandering = motion_from_history(history([(0.1, 0.5), (0.3, 0.5), (0.1, 0.5)]))
        self.assertAlmostEqual(straight.straightness, 1.0, places=5)
        self.assertLess(wandering.straightness, 0.1)

    def test_seconds_of_parses_both_formats_and_refuses_the_rest(self):
        """⚠️ None, never 0 — an unparseable stamp must not become 'this happened at the epoch'."""
        self.assertEqual(seconds_of("12.5s"), 12.5)
        self.assertIsNotNone(seconds_of("2026-08-05T09:00:01.000Z"))
        self.assertIsNone(seconds_of("not a time"))
        self.assertIsNone(seconds_of(""))

    def test_duration_is_wall_clock_and_includes_lost_frames(self):
        """A track lost for two seconds still aged two seconds — duration is not hit count."""
        pts = history([(0.1, 0.5), (0.2, 0.5)])
        pts[1] = TrackHistoryPoint(frame_index=9, at=iso(9), bbox=pts[1].bbox, centroid=pts[1].centroid)
        self.assertAlmostEqual(motion_from_history(pts).duration_seconds, 9.0, places=2)


# ── predictive association ───────────────────────────────────────────────────────────────────────


class PredictiveAssociatorTests(unittest.TestCase):
    def test_velocity_is_derived_from_history_not_remembered(self):
        t = a_track(hist=history([(0.1, 0.5), (0.2, 0.5), (0.3, 0.5)]))
        vx, vy = velocity_of(t)
        self.assertAlmostEqual(vx, 0.1, places=5)
        self.assertAlmostEqual(vy, 0.0, places=5)

    def test_a_stationary_track_is_not_coasted(self):
        t = a_track(centroid=(0.5, 0.5), last_frame=5, hist=history([(0.5, 0.5)] * 3))
        self.assertEqual(predict_bbox(t, 10), t.bbox)

    def test_coasting_is_capped(self):
        """⚠️ Without the cap, a stale velocity extrapolated across a long gap lands the box in a
        corner of the frame with total confidence, and it will match whatever is there."""
        t = a_track(centroid=(0.2, 0.5), last_frame=5, hist=history([(0.0, 0.5), (0.1, 0.5), (0.2, 0.5)]))
        far = predict_bbox(t, 1000, max_coast_frames=5)
        self.assertLessEqual(far[0], 0.2 - 0.05 + 0.1 * 5 + 1e-9)

    def test_plain_iou_loses_the_identity_across_an_occlusion(self):
        """The defect this associator exists to fix, asserted so it cannot come back silently."""
        t = a_track(centroid=(0.3, 0.5), last_frame=5, hist=history([(0.1, 0.5), (0.2, 0.5), (0.3, 0.5)]))
        reappeared = det(bbox=(0.55, 0.45, 0.1, 0.1))  # 0.25 further on, after a gap
        plain = IouAssociator(min_iou=0.3).associate([reappeared], [t])
        self.assertEqual(plain.matches, [])
        self.assertEqual(plain.unmatched_tracks, ["t1"])

    def test_prediction_recovers_the_identity_across_the_same_occlusion(self):
        t = a_track(centroid=(0.3, 0.5), last_frame=5, hist=history([(0.1, 0.5), (0.2, 0.5), (0.3, 0.5)]))
        reappeared = det(bbox=(0.55, 0.45, 0.1, 0.1))
        assoc = PredictiveIouAssociator().associate([reappeared], [t], frame_index=8)
        self.assertEqual([m[0] for m in assoc.matches], ["t1"])

    def test_a_visible_track_associates_exactly_as_before(self):
        """⚠️ Prediction may only ever RECOVER a match; it must not change a working one."""
        t = a_track(centroid=(0.3, 0.5), last_frame=5, hist=history([(0.2, 0.5), (0.3, 0.5)]))
        d = det(bbox=(0.26, 0.46, 0.1, 0.1))
        plain = IouAssociator(min_iou=0.3).associate([d], [t])
        pred = PredictiveIouAssociator(min_iou=0.3).associate([d], [t], frame_index=5)
        self.assertEqual([m[0] for m in plain.matches], [m[0] for m in pred.matches])

    def test_reacquisition_refuses_beyond_its_radius(self):
        """⚠️ A coasting track may be reacquired NEAR its prediction, and only near it. Without the
        radius the coasting track would claim whatever happened to be in the frame."""
        assoc = PredictiveIouAssociator(reacquire_radius=1.5)
        t = a_track(centroid=(0.3, 0.5), last_frame=5, hist=history([(0.1, 0.5), (0.2, 0.5), (0.3, 0.5)]))
        # Prediction at frame 8 is x≈0.6. A detection on the far side of the frame is not it.
        self.assertEqual(assoc.associate([det(bbox=(0.05, 0.05, 0.1, 0.1))], [t], 8).matches, [])
        # ...one just past the prediction is.
        self.assertEqual([m[0] for m in assoc.associate([det(bbox=(0.62, 0.45, 0.1, 0.1))], [t], 8).matches], ["t1"])

    def test_reacquisition_refuses_an_implausible_size_change(self):
        assoc = PredictiveIouAssociator()
        t = a_track(centroid=(0.3, 0.5), last_frame=5, hist=history([(0.1, 0.5), (0.2, 0.5), (0.3, 0.5)]))
        tiny = det(bbox=(0.60, 0.49, 0.01, 0.01))
        self.assertEqual(assoc.associate([tiny], [t], 8).matches, [])

    def test_a_reacquisition_never_outranks_a_real_overlap(self):
        """⚠️ The safety property. A distance guess must never take an identity away from a track
        that genuinely overlaps the detection — otherwise reacquisition CAUSES identity switches."""
        assoc = PredictiveIouAssociator()
        coasting = a_track(
            track_id="coasting", centroid=(0.3, 0.5), last_frame=5,
            hist=history([(0.1, 0.5), (0.2, 0.5), (0.3, 0.5)]),
        )
        visible = a_track(track_id="visible", centroid=(0.62, 0.5), last_frame=7, hist=history([(0.60, 0.5), (0.62, 0.5)]))
        contested = det(bbox=(0.58, 0.45, 0.1, 0.1))
        matches = assoc.associate([contested], [coasting, visible], frame_index=8).matches
        self.assertEqual([m[0] for m in matches], ["visible"])

    def test_labels_are_never_crossed(self):
        t = a_track(label="person", hist=history([(0.1, 0.5), (0.2, 0.5)]))
        assoc = PredictiveIouAssociator().associate([det(label="car", bbox=(0.45, 0.45, 0.1, 0.1))], [t], 8)
        self.assertEqual(assoc.matches, [])


# ── re-entry ─────────────────────────────────────────────────────────────────────────────────────


class ReentryTests(unittest.TestCase):
    def resolver(self, **kw):
        return ReentryResolver(**kw)

    def returning(self, track_id="t9", centroid=(0.52, 0.5), at=6.0, label="person"):
        t = a_track(track_id=track_id, centroid=centroid, label=label)
        t.first_seen_at = iso(at)
        return t

    def test_links_a_plausible_return(self):
        r = self.resolver()
        r.retire(a_track(track_id="t1", centroid=(0.5, 0.5)))
        link = r.resolve(self.returning())
        self.assertIsNotNone(link)
        self.assertEqual(link.identity_id, "t1")
        self.assertEqual(link.preceded_by, "t1")
        self.assertEqual(link.recoveries, 1)

    def test_refuses_across_too_long_a_gap(self):
        r = self.resolver(max_gap_seconds=3.0)
        r.retire(a_track(track_id="t1", centroid=(0.5, 0.5)))
        self.assertIsNone(r.resolve(self.returning(at=60.0)))

    def test_refuses_across_too_great_a_distance(self):
        """Someone who left by the north door is not someone entering by the south."""
        r = self.resolver(max_distance=0.1)
        r.retire(a_track(track_id="t1", centroid=(0.1, 0.1)))
        self.assertIsNone(r.resolve(self.returning(centroid=(0.9, 0.9))))

    def test_refuses_a_different_label(self):
        r = self.resolver()
        r.retire(a_track(track_id="t1", label="car"))
        self.assertIsNone(r.resolve(self.returning(label="person")))

    def test_refuses_an_implausible_size_change(self):
        """A child at the back does not inherit an adult's identity at the front."""
        r = self.resolver()
        big = a_track(track_id="t1", centroid=(0.5, 0.5))
        big.bbox = (0.4, 0.4, 0.4, 0.4)
        r.retire(big)
        small = self.returning()
        small.bbox = (0.5, 0.5, 0.02, 0.02)
        self.assertIsNone(r.resolve(small))

    def test_one_departure_can_only_be_one_return(self):
        """⚠️ Consumed on use. Otherwise a single removed track adopts every new person in the scene."""
        r = self.resolver()
        r.retire(a_track(track_id="t1", centroid=(0.5, 0.5)))
        self.assertIsNotNone(r.resolve(self.returning(track_id="t9")))
        self.assertIsNone(r.resolve(self.returning(track_id="t10")))

    def test_the_candidate_pool_is_bounded(self):
        r = self.resolver(capacity=4)
        for i in range(20):
            r.retire(a_track(track_id=f"t{i}", centroid=(0.5, 0.5)))
        self.assertEqual(r.pending(), 4)

    def test_an_unparseable_timestamp_refuses_rather_than_guesses(self):
        r = self.resolver()
        r.retire(a_track(track_id="t1", centroid=(0.5, 0.5)))
        broken = self.returning()
        broken.first_seen_at = "whenever"
        self.assertIsNone(r.resolve(broken))

    def test_recoveries_accumulate_along_a_chain(self):
        r = self.resolver()
        first = a_track(track_id="t1", centroid=(0.5, 0.5))
        r.retire(first)
        second = self.returning(track_id="t2")
        link = r.resolve(second)
        second.identity_id, second.preceded_by, second.recoveries = (
            link.identity_id,
            link.preceded_by,
            link.recoveries,
        )
        r.retire(second)
        third = self.returning(track_id="t3", at=12.0)
        link2 = r.resolve(third)
        self.assertEqual(link2.identity_id, "t1")
        self.assertEqual(link2.preceded_by, "t2")
        self.assertEqual(link2.recoveries, 2)


# ── the live tracker ─────────────────────────────────────────────────────────────────────────────


class RuntimeTrackerTests(unittest.TestCase):
    def tracker(self, **kw):
        return RuntimeTracker(TrackingOptions(**kw))

    def walk(self, rt, xs, camera="cam_1", tenant="tnt_a", start=0.0, step=0.5, label="person"):
        """Feed a single object walking along `xs`, one frame per step. Returns stamped detections."""
        out = []
        for i, x in enumerate(xs):
            second = start + i * step
            frame = [det(label=label, bbox=(x - 0.05, 0.45, 0.1, 0.1))] if x is not None else []
            out.append(rt.run(frame, ctx(camera=camera, tenant=tenant, seq=i, at=iso(second))))
        return out

    def ids(self, frames):
        return [f[0].tracking_id for f in frames if f]

    # -- the five identity properties -------------------------------------------

    def test_track_ids_remain_stable_while_visible(self):
        rt = self.tracker()
        frames = self.walk(rt, [0.10, 0.14, 0.18, 0.22, 0.26, 0.30])
        ids = self.ids(frames)
        self.assertEqual(len(set(ids)), 1, f"identity changed while continuously visible: {ids}")

    def test_ids_survive_occlusion(self):
        """Hidden for three frames mid-walk, moving the whole time — the pillar case."""
        rt = self.tracker()
        frames = self.walk(rt, [0.10, 0.14, 0.18, None, None, None, 0.34, 0.38])
        ids = self.ids(frames)
        self.assertEqual(len(set(ids)), 1, f"occlusion split the identity: {ids}")

    def test_ids_survive_a_temporary_disappearance_within_max_age(self):
        rt = self.tracker(max_age=8)
        frames = self.walk(rt, [0.20, 0.24, 0.28] + [None] * 5 + [0.48, 0.52])
        ids = self.ids(frames)
        self.assertEqual(len(set(ids)), 1, f"a short absence split the identity: {ids}")

    def test_ids_terminate_correctly(self):
        rt = self.tracker(max_age=3)
        self.walk(rt, [0.20, 0.23, 0.26])
        stats_before = rt.stats("tnt_a")
        self.assertEqual(stats_before["activeTracks"], 1)
        self.walk(rt, [None] * 8, start=10.0)
        after = rt.stats("tnt_a")
        self.assertEqual(after["activeTracks"], 0, "a departed track was never removed")
        self.assertGreaterEqual(after["removedTracks"], 1)

    def test_multiple_people_crossing_do_not_swap_identities(self):
        """⚠️ The failure this asserts against is silent: both people keep an id, they are just the
        wrong way round, and every downstream count still looks correct."""
        rt = self.tracker()
        # ⚠️ Steps are small relative to the box width on purpose. A person who moves further than
        # their own width between frames has ZERO overlap with themselves, and no IoU tracker can
        # follow that — the scenario would be testing the frame rate, not the association logic.
        left = [0.30, 0.34, 0.38, 0.42, 0.46, 0.50, 0.54]
        right = [0.54, 0.50, 0.46, 0.42, 0.38, 0.34, 0.30]
        seen_left, seen_right = [], []
        for i, (lx, rx) in enumerate(zip(left, right)):
            stamped = rt.run(
                [
                    det(bbox=(lx - 0.05, 0.42, 0.10, 0.16)),
                    det(bbox=(rx - 0.05, 0.50, 0.10, 0.16)),
                ],
                ctx(seq=i, at=iso(i * 0.5)),
            )
            seen_left.append(stamped[0].tracking_id)
            seen_right.append(stamped[1].tracking_id)
        self.assertEqual(len(set(seen_left)), 1, f"the left-hand person changed identity: {seen_left}")
        self.assertEqual(len(set(seen_right)), 1, f"the right-hand person changed identity: {seen_right}")
        self.assertNotEqual(seen_left[0], seen_right[0], "the two people share one identity")

    # -- re-entry keeps the contract's id policy --------------------------------

    def test_re_entry_gets_a_new_track_id_and_the_same_identity(self):
        """⚠️ The frozen contract says ids are never reused. Re-entry is a LINK, not a reassignment."""
        rt = self.tracker(max_age=2)
        first = self.walk(rt, [0.45, 0.48, 0.51])
        first_id = self.ids(first)[0]
        self.walk(rt, [None] * 5, start=2.0)  # gone long enough to be removed
        again = self.walk(rt, [0.55, 0.58], start=6.0)
        again_id = self.ids(again)[0]

        self.assertNotEqual(again_id, first_id, "a removed trackId was reused")
        detail = rt.detail("tnt_a", again_id)
        self.assertIsNotNone(detail)
        self.assertEqual(detail["track"]["identityId"], first_id)
        self.assertEqual(detail["track"]["precededBy"], first_id)
        self.assertEqual(detail["track"]["recoveries"], 1)
        self.assertEqual(rt.stats("tnt_a")["recoveredTracks"], 1)

    def test_a_first_appearance_is_its_own_identity(self):
        """Set explicitly, so a consumer grouping by identityId never special-cases 'the ones with none'."""
        rt = self.tracker()
        frames = self.walk(rt, [0.40, 0.43])
        detail = rt.detail("tnt_a", self.ids(frames)[0])
        self.assertEqual(detail["track"]["identityId"], detail["track"]["trackId"])
        self.assertNotIn("precededBy", detail["track"])

    # -- the pipeline contract --------------------------------------------------

    def test_detections_come_back_stamped_and_the_originals_are_untouched(self):
        rt = self.tracker()
        original = det(bbox=(0.4, 0.45, 0.1, 0.1))
        stamped = rt.run([original], ctx())
        self.assertIsNotNone(stamped[0].tracking_id)
        self.assertIsNone(original.tracking_id, "the frozen source detection was mutated")

    def test_tracking_can_be_switched_off_and_changes_nothing(self):
        rt = RuntimeTracker(TrackingOptions(enabled=False))
        stamped = rt.run([det()], ctx())
        self.assertIsNone(stamped[0].tracking_id)
        self.assertEqual(rt.stats()["activeTracks"], 0)

    def test_an_empty_frame_is_a_tracking_step_not_a_no_op(self):
        """A frame with nothing in it is how a track learns it was not seen — ageing depends on it."""
        rt = self.tracker(max_age=2)
        self.walk(rt, [0.40, 0.43, 0.46])
        before = rt.stats("tnt_a")["activeTracks"]
        self.walk(rt, [None] * 6, start=5.0)
        self.assertEqual(before, 1)
        self.assertEqual(rt.stats("tnt_a")["activeTracks"], 0)

    # -- isolation, ordering, bounds --------------------------------------------

    def test_tenants_are_isolated(self):
        rt = self.tracker()
        self.walk(rt, [0.30, 0.33], tenant="tnt_a")
        self.walk(rt, [0.70, 0.73], tenant="tnt_b")
        a = rt.tracks("tnt_a")
        b = rt.tracks("tnt_b")
        self.assertEqual(len(a), 1)
        self.assertEqual(len(b), 1)
        self.assertNotEqual(a[0].track_id, b[0].track_id)
        self.assertIsNone(rt.detail("tnt_b", a[0].track_id), "a tenant read across the boundary")

    def test_a_read_without_a_tenant_returns_nothing(self):
        """Fail-closed: an empty tenant is not a wildcard."""
        rt = self.tracker()
        self.walk(rt, [0.30, 0.33])
        self.assertEqual(rt.tracks(""), [])
        self.assertIsNone(rt.detail("", "anything"))

    def test_cameras_are_isolated_within_a_tenant(self):
        rt = self.tracker()
        self.walk(rt, [0.30, 0.33], camera="cam_1")
        self.walk(rt, [0.30, 0.33], camera="cam_2")
        self.assertEqual(len(rt.tracks("tnt_a")), 2)
        self.assertEqual(len(rt.tracks("tnt_a", camera_id="cam_1")), 1)
        self.assertEqual(rt.stats("tnt_a")["camerasTracked"], 2)

    def test_camera_state_appears_only_when_a_frame_arrives(self):
        """⚠️ The property Camera Processing Assignment will depend on: no camera list, no enrolment."""
        rt = self.tracker()
        self.assertEqual(rt.stats()["camerasTracked"], 0)
        rt.run([det()], ctx(camera="cam_new"))
        self.assertEqual(rt.stats()["camerasTracked"], 1)

    def test_an_out_of_order_frame_is_counted_and_skipped(self):
        """⚠️ Media runs four requests in flight, so this happens for real on a busy camera."""
        rt = self.tracker()
        rt.run([det(bbox=(0.4, 0.45, 0.1, 0.1))], ctx(seq=0, at=iso(10)))
        rt.run([det(bbox=(0.9, 0.45, 0.1, 0.1))], ctx(seq=1, at=iso(2)))
        stats = rt.stats("tnt_a")
        self.assertEqual(stats["outOfOrderFrames"], 1)
        self.assertEqual(stats["framesTracked"], 1)

    def test_camera_state_is_bounded(self):
        rt = self.tracker()
        for i in range(80):
            rt.run([det()], ctx(camera=f"cam_{i}"))
        self.assertLessEqual(rt.stats()["camerasTracked"], 64)
        self.assertGreater(rt.stats()["camerasEvicted"], 0)

    # -- what the operator pages read -------------------------------------------

    def test_stats_report_null_rather_than_zero_when_nothing_was_tracked(self):
        """⚠️ '0.0 s average lifetime' and 'nothing has been tracked' mean opposite things."""
        stats = self.tracker().stats("tnt_a")
        self.assertIsNone(stats["averageTrackLifetimeSeconds"])
        self.assertIsNone(stats["averageTrackHits"])
        self.assertIsNone(stats["fragmentation"])
        self.assertIsNone(stats["averageTrackingMs"])

    def test_a_tracked_track_carries_motion(self):
        rt = self.tracker()
        frames = self.walk(rt, [0.10, 0.14, 0.18, 0.22])
        track = rt.detail("tnt_a", self.ids(frames)[0])["track"]
        self.assertIn("motion", track)
        self.assertEqual(track["motion"]["headingLabel"], "right")
        self.assertGreater(track["motion"]["pathLengthNormalized"], 0.0)

    def test_the_timeline_keeps_the_states_nobody_wants_to_see(self):
        """A recovered track still shows that it was lost — smoothing it would answer 'was this the
        same person throughout?' wrongly, and with total confidence."""
        rt = self.tracker(max_age=8)
        frames = self.walk(rt, [0.10, 0.14, 0.18, None, None, 0.30, 0.34])
        detail = rt.detail("tnt_a", self.ids(frames)[0])
        states = [e["to"] for e in detail["timeline"]]
        self.assertIn("lost", states)
        self.assertEqual(states[-1], "confirmed")

    def test_a_track_carries_its_schema_version(self):
        rt = self.tracker()
        frames = self.walk(rt, [0.30, 0.33])
        self.assertEqual(rt.detail("tnt_a", self.ids(frames)[0])["track"]["schemaVersion"], "1.1")

    def test_describe_reports_the_engine_without_tenant_data(self):
        described = self.tracker().describe()
        self.assertEqual(described["associator"], "predictive-iou")
        self.assertTrue(described["enabled"])


class ManagerAdditionsTests(unittest.TestCase):
    """The additive changes to the AI-2 TrackManager, which batch analysis still depends on."""

    def test_motion_is_off_by_default_so_batch_output_is_unchanged(self):
        m = TrackManager(IouAssociator(min_iou=0.1), session_id="s")
        m.update([det()], tenant_id="t", camera_id="c", frame_index=0, at="0s")
        m.update([det()], tenant_id="t", camera_id="c", frame_index=1, at="1s")
        self.assertIsNone(m.active()[0].motion)

    def test_motion_is_computed_when_asked_for(self):
        m = TrackManager(IouAssociator(min_iou=0.1), session_id="s", compute_motion=True)
        m.update([det(bbox=(0.10, 0.4, 0.1, 0.1))], tenant_id="t", camera_id="c", frame_index=0, at="0s")
        m.update([det(bbox=(0.13, 0.4, 0.1, 0.1))], tenant_id="t", camera_id="c", frame_index=1, at="1s")
        self.assertIsNotNone(m.active()[0].motion)

    def test_removed_tracks_are_drained_once(self):
        m = TrackManager(IouAssociator(min_iou=0.1), session_id="s", max_age=1)
        m.update([det()], tenant_id="t", camera_id="c", frame_index=0, at="0s")
        drained = []
        # ⚠️ Drained every update, which is the contract: the list is what was removed by THIS
        # update, so a caller that waits until the end has already lost the earlier ones.
        for f in range(1, 5):
            m.update([], tenant_id="t", camera_id="c", frame_index=f, at=f"{f}s")
            drained.extend(m.drain_removed())
        self.assertEqual(len(drained), 1)
        self.assertEqual(m.drain_removed(), [])

    def test_the_assignment_maps_every_detection_to_its_track(self):
        m = TrackManager(IouAssociator(min_iou=0.1), session_id="s")
        m.update(
            [det(bbox=(0.1, 0.1, 0.1, 0.1)), det(bbox=(0.8, 0.8, 0.1, 0.1))],
            tenant_id="t",
            camera_id="c",
            frame_index=0,
            at="0s",
        )
        assignment = m.assignment()
        self.assertEqual(len(assignment), 2)
        self.assertEqual(len(set(assignment.values())), 2)


if __name__ == "__main__":
    unittest.main()
