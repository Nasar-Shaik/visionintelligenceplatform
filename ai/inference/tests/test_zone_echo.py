"""The zone membership echo (P-11 slice 2.3, ADR-0053) — the join that closes the zone gap.

Slice 2.2 shipped the zone primitives and measured them never running: membership is resolved
*after* `/infer` answers, so nothing in the runtime ever saw a zone. This file drives the fix through
the real `RuntimeTracker` + `BehaviourStage` chain, one frame at a time, the way media does.

⛔ **Four things here are worth more than the rest**, because each is a wrong answer shaped exactly
like a right one:

1. an echo is matched by the frame it DESCRIBES, not by whichever point is newest;
2. an undecided point is skipped, never read as "outside" — otherwise every frame emits a `left`
   transition that never happened, for as long as the echo runs a frame behind;
3. an empty echo is a decision ("nobody was inside"), not an absence;
4. the frame sequence stored is the CALLER's, not any counter the runtime keeps.

Deterministic and stdlib-only: no clock, no threads, no camera, no model.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import behaviour_primitives as bp  # noqa: E402
from behaviour_modules import ATTR_BEHAVIOUR, ZONE_ATTRIBUTE  # noqa: E402
from behaviour_stage import BehaviourStage  # noqa: E402
from contracts import Detection, FrameContext, ZoneMembership, ZoneObservation  # noqa: E402
from pipeline import StageChain  # noqa: E402
from runtime_tracking import RuntimeTracker, TrackingOptions  # noqa: E402
from track_history import InMemoryTrackHistoryStore, TrackHistoryRecorder  # noqa: E402

TENANT = "tnt_a"
CAMERA = "cam_1"


def detection(bbox, *, label="person", confidence=0.9, zones=None):
    attributes = {} if zones is None else {ZONE_ATTRIBUTE: list(zones)}
    return Detection(label=label, confidence=confidence, bbox=bbox, attributes=attributes)


class EchoHarness:
    """The chain as a deployment runs it, with media's echo arriving one frame late.

    ⚠️ `send()` mirrors `HttpFrameSink`: the membership resolved for the *previous* answered frame
    rides on the next request. The lag is the product's, not the test's, and a harness that delivered
    membership with its own frame would prove nothing about the thing that ships.
    """

    def __init__(self, **stage_kwargs):
        self.store = InMemoryTrackHistoryStore()
        self.recorder = TrackHistoryRecorder(store=self.store)
        self.tracker = RuntimeTracker(
            TrackingOptions(min_hits=1, max_age=8, reentry_gap_seconds=12.0), history=self.recorder
        )
        self.stage = BehaviourStage(recorder=self.recorder, **stage_kwargs)
        self.chain = StageChain(self.tracker, self.stage)
        self._pending = None

    def send(self, detections, *, at, seq, zones=None, stream=None, zone_version=3):
        """One `/infer` round trip. `zones` is identity → zoneIds resolved for THIS frame, applied
        the way media applies it: computed after the answer, carried on the next request."""
        ctx = FrameContext(
            tenant_id=TENANT,
            camera_id=CAMERA,
            image=b"",
            frame_number=seq,
            timestamp=at,
            correlation_id=stream,
            zone_membership=self._pending,
        )
        out = self.chain.run(list(detections), ctx)
        if zones is not None:
            self._pending = ZoneMembership(
                frame_seq=seq,
                zone_version=zone_version,
                subjects=tuple(
                    ZoneObservation(identity_id=i, zone_ids=tuple(z)) for i, z in zones.items()
                ),
            )
        return out

    def identity(self):
        records = self.recorder.live_records(TENANT, CAMERA, None)
        return records[0].identity_id if records else None

    def points(self):
        records = self.recorder.live_records(TENANT, CAMERA, None)
        return records[0].points if records else []


class EchoJoinTests(unittest.TestCase):
    def test_membership_lands_on_the_frame_it_describes(self):
        harness = EchoHarness()
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="0s", seq=100)
        identity = harness.identity()
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="1s", seq=101, zones={identity: ["z_till"]})
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="2s", seq=102)

        by_seq = {p.frame_index: p for p in harness.points()}
        self.assertEqual(by_seq[101].zone_ids, ("z_till",))
        self.assertTrue(by_seq[101].zones_settled)
        # ⛔ The frame before is settled to nothing, not left undecided — the echo decided the whole
        # frame, and 100 carried no membership because nobody was inside anything.
        self.assertEqual(by_seq[100].zone_ids, ())

    def test_an_echo_two_frames_late_still_lands_on_its_own_frame(self):
        """⛔ The reason `frameSeq` is on the wire. With more than one request in flight per camera
        the echo raised for frame N rides on the request for N+2, and "annotate the newest point"
        would give one frame's zones to another."""
        harness = EchoHarness()
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="0s", seq=7)
        identity = harness.identity()
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="1s", seq=8)
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="2s", seq=9)
        # An echo for frame 7 arrives now, long after frames 8 and 9 were recorded.
        harness._pending = ZoneMembership(
            frame_seq=7, subjects=(ZoneObservation(identity_id=identity, zone_ids=("z_till",)),)
        )
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="3s", seq=10)

        by_seq = {p.frame_index: p for p in harness.points()}
        self.assertEqual(by_seq[7].zone_ids, ("z_till",))
        self.assertEqual(by_seq[9].zone_ids, ())

    def test_an_echo_for_a_frame_nobody_holds_is_counted_rather_than_raised(self):
        harness = EchoHarness()
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="0s", seq=1)
        harness._pending = ZoneMembership(
            frame_seq=9999, subjects=(ZoneObservation(identity_id="idn_ghost", zone_ids=("z_till",)),)
        )
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="1s", seq=2)
        stats = harness.stage.stats()
        self.assertEqual(stats["zoneAnnotationsMissed"], 1)
        self.assertEqual(stats["zoneMembership"], "present")

    def test_the_version_that_decided_membership_is_kept_on_the_record(self):
        """⭐ ADR-0053 amending ADR-0051 — membership may be stored *because* the record can name the
        polygon set that produced it."""
        harness = EchoHarness()
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="0s", seq=1)
        identity = harness.identity()
        harness.send(
            [detection((0.5, 0.4, 0.08, 0.2))], at="1s", seq=2, zones={identity: ["z_till"]}, zone_version=12
        )
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="2s", seq=3)
        self.assertEqual(harness.recorder.live_records(TENANT, CAMERA, None)[0].zone_version, 12)


class UndecidedMembershipTests(unittest.TestCase):
    def test_the_newest_frame_being_undecided_does_not_produce_a_departure(self):
        """⛔ The defect this design exists to prevent, and the most plausible one in the slice.

        Membership arrives a frame late, so the newest point is always undecided. Reading it as
        "outside every zone" closes the visit and emits a `left` — on **every frame**, for a subject
        who has not moved. A loitering rule would see a stream of departures and a dwell that never
        grows past one interval.
        """
        harness = EchoHarness()
        out = harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="0s", seq=1)
        identity = harness.identity()
        for index in range(1, 6):
            out = harness.send(
                [detection((0.5, 0.4, 0.08, 0.2))],
                at=f"{index}s",
                seq=index + 1,
                zones={identity: ["z_till"]},
            )
        payload = out[0].attributes[ATTR_BEHAVIOUR]["zone"]
        self.assertEqual([t["transition"] for t in payload["transitions"]], ["entered"])
        self.assertTrue(payload["zones"]["z_till"]["present"])
        # ⚠️ 3.0 s, not 4.0 s: the newest frame's membership has not come back yet, so the dwell is
        # complete up to the last DECIDED point. A lower bound, and it is one frame short by design.
        self.assertAlmostEqual(payload["zones"]["z_till"]["dwellSeconds"], 3.0, places=4)

    def test_a_real_departure_is_reported_once_the_frame_that_shows_it_is_decided(self):
        harness = EchoHarness()
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="0s", seq=1)
        identity = harness.identity()
        script = [["z_till"], ["z_till"], [], []]
        out = None
        for index, zones in enumerate(script):
            out = harness.send(
                [detection((0.5, 0.4, 0.08, 0.2))],
                at=f"{index + 1}s",
                seq=index + 2,
                zones={identity: zones},
            )
        transitions = out[0].attributes[ATTR_BEHAVIOUR]["zone"]["transitions"]
        self.assertEqual([t["transition"] for t in transitions], ["entered", "left"])

    def test_an_empty_echo_is_a_decision_and_not_an_absence(self):
        """⛔ `subjects: []` says the frame was resolved and nobody was inside a zone. Suppressing it
        would make that identical to "the membership never arrived", and every duration computed
        across the gap would be a lower bound nothing labelled as one."""
        harness = EchoHarness()
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="0s", seq=1)
        harness._pending = ZoneMembership(frame_seq=1, subjects=())
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="1s", seq=2)
        first = harness.points()[0]
        self.assertTrue(first.zones_settled)
        self.assertEqual(first.zone_ids, ())
        self.assertEqual(harness.stage.stats()["zoneMembership"], "present")

    def test_the_attribute_path_is_ignored_once_a_stream_speaks_through_the_echo(self):
        """⛔ The defect a test found and reasoning had missed.

        On the echo channel a detection never carries `zoneIds`, so the attribute path read every
        current frame as "inside no zone" — settling it *outside* one frame before the echo arrived to
        say the subject was inside. A person standing still produced an `entered`/`left` pair on every
        single frame. Two upstreams answering one question is something to pick, not merge.
        """
        harness = EchoHarness()
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="0s", seq=1)
        identity = harness.identity()
        # Frames carry NO zoneIds attribute, exactly as they do on the product path.
        for index in range(1, 5):
            harness.send(
                [detection((0.5, 0.4, 0.08, 0.2))],
                at=f"{index}s",
                seq=index + 1,
                zones={identity: ["z_till"]},
            )
        settled = [p for p in harness.points() if p.zones_settled]
        self.assertTrue(settled)
        self.assertTrue(
            all(p.zone_ids == ("z_till",) for p in settled),
            "a settled point read as 'outside' means the attribute path overrode the echo",
        )

    def test_a_deployment_that_never_echoes_reports_absent_rather_than_zero_dwell(self):
        """The negative control. No echo anywhere must read as `absent`, never as "nobody lingered"."""
        harness = EchoHarness()
        for index in range(4):
            out = harness.send([detection((0.5, 0.4, 0.08, 0.2))], at=f"{index}s", seq=index)
        self.assertEqual(harness.stage.stats()["zoneMembership"], "absent")
        self.assertNotIn("zone", out[0].attributes.get(ATTR_BEHAVIOUR, {}))
        self.assertFalse(any(p.zones_settled for p in harness.points()))


class SettledPointTests(unittest.TestCase):
    def test_an_undecided_point_is_skipped_and_joins_the_observations_either_side(self):
        """⚠️ Skipped, not excluded. The subject did not leave and come back — we simply were not
        told about the moment in between, so the visit spans it."""
        zone = bp.MembershipZone("z_till")
        points = [
            bp.TrackPoint("idn_1", 0.0, (0.5, 0.4, 0.08, 0.2), zone_ids=("z_till",)),
            bp.TrackPoint("idn_1", 1.0, (0.5, 0.4, 0.08, 0.2), zones_settled=False),
            bp.TrackPoint("idn_1", 2.0, (0.5, 0.4, 0.08, 0.2), zone_ids=("z_till",)),
        ]
        visits = bp.zone_visits(points, zone)
        self.assertEqual(len(visits), 1)
        self.assertAlmostEqual(visits[0].interval.seconds, 2.0, places=4)

    def test_a_geometric_zone_answers_for_every_point_because_it_holds_the_polygon(self):
        """⚠️ `requires_membership` is a property of how a zone knows things, not of the caller. A
        `PolygonZone` never needs an upstream and must not be filtered by one."""
        polygon = bp.PolygonZone("z_poly", [(0.4, 0.4), (0.8, 0.4), (0.8, 0.9), (0.4, 0.9)])
        points = [bp.TrackPoint("idn_1", float(t), (0.5, 0.5, 0.08, 0.2)) for t in range(3)]
        self.assertFalse(any(p.zones_settled for p in points))
        self.assertEqual(len(bp.observed_points(points, polygon)), 3)
        self.assertAlmostEqual(bp.dwell_seconds(points, polygon), 2.0, places=4)

    def test_membership_and_undecided_cannot_both_be_true_of_one_point(self):
        point = bp.TrackPoint("idn_1", 0.0, (0, 0, 1, 1), zone_ids=("z_till",), zones_settled=False)
        self.assertTrue(point.zones_settled)


class MalformedEchoTests(unittest.TestCase):
    """⚠️ The echo crossed a service boundary. A `zoneId` accepted here becomes a dwell interval, then
    a rule's scope, then an incident's evidence."""

    def parse(self, raw):
        body = {
            "context": {"tenantId": TENANT},
            "frame": {"cameraId": CAMERA, "seq": 1, "zoneMembership": raw},
            "imageBase64": "AA==",
        }
        return FrameContext.from_request(body).zone_membership

    def test_a_missing_echo_is_none_rather_than_an_empty_decision(self):
        self.assertIsNone(self.parse(None))
        self.assertIsNone(self.parse("nonsense"))
        self.assertIsNone(self.parse({"subjects": []}))

    def test_an_echo_with_no_subjects_parses_to_a_decision_with_none(self):
        parsed = self.parse({"frameSeq": 4, "subjects": []})
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.frame_seq, 4)
        self.assertEqual(parsed.subjects, ())

    def test_unusable_subjects_are_dropped_and_the_frame_is_still_decided(self):
        parsed = self.parse(
            {
                "frameSeq": 4,
                "subjects": [
                    {"identityId": "idn_1", "zoneIds": ["z_till", 7, ""]},
                    {"identityId": "", "zoneIds": ["z_a"]},
                    {"zoneIds": ["z_b"]},
                    "not-an-object",
                ],
            }
        )
        self.assertEqual(len(parsed.subjects), 1)
        self.assertEqual(parsed.subjects[0].zone_ids, ("z_till",))

    def test_a_negative_or_absent_frame_sequence_is_refused(self):
        self.assertIsNone(self.parse({"frameSeq": -1, "subjects": []}))
        self.assertIsNone(self.parse({"frameSeq": True, "subjects": []}))

    def test_the_subject_cap_is_applied_at_the_boundary(self):
        subjects = [{"identityId": f"idn_{i}", "zoneIds": ["z"]} for i in range(200)]
        parsed = self.parse({"frameSeq": 1, "subjects": subjects})
        self.assertEqual(len(parsed.subjects), 64)


class FrameSequenceTests(unittest.TestCase):
    def test_the_stored_frame_index_is_the_callers_sequence(self):
        """⛔ The defect found while building this slice. The runtime stored its own per-camera
        counter, so the echo joined one frame early on every frame — a dwell short by exactly one
        interval, on a graph that looked entirely reasonable. A stored path must be joinable to the
        events that cite it, and those carry `frame.seq`."""
        harness = EchoHarness()
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="0s", seq=500)
        harness.send([detection((0.5, 0.4, 0.08, 0.2))], at="1s", seq=501)
        self.assertEqual([p.frame_index for p in harness.points()], [500, 501])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
