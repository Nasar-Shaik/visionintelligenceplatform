"""The **track-history and behaviour read routes**, driven over real HTTP (Phase 2.4 slice 2.8).

⛔ **These exist because of a defect no unit test could have found: a query parameter that was
accepted at every layer and applied at none.**

`streamId` was declared on media's route, forwarded to the runtime, named in the runtime's own
docstring, and honoured by `TrackHistoryStore.records` — which the runtime's handler called without
it. An analysis-scoped read therefore returned the whole tenant's history: **5014 records for a run
that produced two**, all of them plausible, none of them about the run that was asked for. Every
store test passed, every route test passed, and the answer was about the wrong analysis.

⚠️ So these tests drive the **route**, not the store. The store's filter has been correct since
slice 2.2; the wiring is what was missing, and wiring is only visible from outside.
"""

import json
import os
import sys
import threading
import unittest
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server import build_server  # noqa: E402
from track_history import (  # noqa: E402
    HistoryPoint,
    InMemoryTrackHistoryStore,
    TrackHistoryRecord,
    TrackHistoryRecorder,
)

KEY = "internal-key-at-least-16-chars"
TENANT = "tnt_a"


class _Tracks:
    """The pipeline slot `_stage(registry, 'tracks')` selects, holding a real recorder.

    ⚠️ `tracks` is the *distinctive attribute* the route selects by — see `_stage`, which picks a
    stage by a method it owns rather than by position so that reordering the chain cannot silently
    point a read at the wrong stage.
    """

    def __init__(self, recorder):
        self.history = recorder

    def tracks(self, *_args, **_kwargs):
        return []


class _Registry:
    """⚠️ Only what the read routes touch. A fuller double would hide which attribute they use."""

    def __init__(self, tracker):
        self.tracker = tracker
        self.version = "0.1.0"

    def health(self):
        return []


def point(seq, at, x=0.5, y=0.5, track="trk_1"):
    return HistoryPoint(frame_index=seq, at=f"{at}s", bbox=(x, y, 0.05, 0.1), track_id=track)


def record(identity, stream, camera="cam_1", count=40):
    """⚠️ 40 observations at 0.5 s — 19.5 s standing still, which is long enough to establish `idle`
    (3 s) and `linger` (15 s) as well as `observed`. A six-point fixture produced exactly one fact,
    so "the filter narrowed the answer" and "there was only ever one answer" were indistinguishable."""
    return TrackHistoryRecord(
        identity_id=identity,
        tenant_id=TENANT,
        camera_id=camera,
        stream_id=stream,
        label="person",
        points=[point(i, i * 0.5) for i in range(count)],
        track_ids=[identity],
        closed=True,
    )


class TrackHistoryRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store = InMemoryTrackHistoryStore()
        # Two runs of one recording, plus a second camera — the shape ADR-0047 promises to keep apart.
        store.write(record("idn_run_a", "ases_a"))
        store.write(record("idn_run_b", "ases_b"))
        store.write(record("idn_other_cam", "ases_a", camera="cam_2"))
        cls.recorder = TrackHistoryRecorder(store=store)
        cls.registry = _Registry(_Tracks(cls.recorder))
        cls.httpd = build_server("127.0.0.1", 0, cls.registry, KEY, "inference", "0.1.0")
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def get(self, path, tenant=TENANT):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            headers={"x-internal-key": KEY, "x-tenant-id": tenant},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 - localhost test
            return resp.status, json.loads(resp.read())

    def identities(self, path):
        _, body = self.get(path)
        return sorted(r["identityId"] for r in body["data"]["records"])

    def test_a_run_scoped_read_returns_only_that_run(self):
        """⛔ The defect. Without the filter this returned all three records — the whole tenant's
        history, presented as the answer for one analysis."""
        self.assertEqual(self.identities("/tracking/history?streamId=ases_a"), ["idn_other_cam", "idn_run_a"])
        self.assertEqual(self.identities("/tracking/history?streamId=ases_b"), ["idn_run_b"])

    def test_two_runs_of_one_recording_never_share_a_history(self):
        """⚠️ The promise ADR-0047 makes and `bt.collect` has always honoured. A reader that saw
        both runs' paths under one run would report movement that analysis never observed."""
        a = set(self.identities("/tracking/history?streamId=ases_a"))
        b = set(self.identities("/tracking/history?streamId=ases_b"))
        self.assertEqual(a & b, set())

    def test_stream_and_camera_filters_compose(self):
        self.assertEqual(
            self.identities("/tracking/history?streamId=ases_a&cameraId=cam_1"), ["idn_run_a"]
        )

    def test_an_unfiltered_read_still_returns_the_tenant(self):
        """⚠️ The unscoped read is unchanged: narrowing had to be added without taking anything away."""
        self.assertEqual(len(self.identities("/tracking/history")), 3)

    def test_an_unknown_run_is_an_empty_answer_rather_than_an_error(self):
        status, body = self.get("/tracking/history?streamId=ases_nothing")
        self.assertEqual(status, 200)
        self.assertTrue(body["data"]["enabled"])
        self.assertEqual(body["data"]["records"], [])

    def test_another_tenant_sees_none_of_it(self):
        """⛔ A movement path is the most personal thing this runtime holds. The tenant comes from
        the header the internal caller sets, and a different one must see nothing."""
        self.assertEqual(self.identities("/tracking/history?streamId=ases_a", ), ["idn_other_cam", "idn_run_a"])
        _, body = self.get("/tracking/history?streamId=ases_a", tenant="tnt_victim")
        self.assertEqual(body["data"]["records"], [])


class BehaviourReadRouteTests(TrackHistoryRouteTests):
    """The three behaviour projections over the same runs, through the same routes."""

    def test_the_timeline_is_scoped_to_one_run(self):
        _, body = self.get("/tracking/behaviour/timeline?streamId=ases_a&cameraId=cam_1")
        data = body["data"]
        self.assertTrue(data["enabled"])
        self.assertEqual({e["identityId"] for e in data["entries"]}, {"idn_run_a"})

    def test_the_timeline_publishes_what_the_whole_run_produced(self):
        """⭐ `countsByKind` is counted before the filter and before the cap — the only number that
        can tell a reader what a short list left out."""
        _, body = self.get("/tracking/behaviour/timeline?streamId=ases_a&cameraId=cam_1")
        data = body["data"]
        self.assertGreater(sum(data["countsByKind"].values()), 0)
        self.assertEqual(data["kindsRequested"], [])
        self.assertEqual(data["excludedByKind"], 0)

    def test_the_kind_filter_reaches_the_runtime(self):
        _, body = self.get("/tracking/behaviour/timeline?streamId=ases_a&cameraId=cam_1&kinds=observed")
        data = body["data"]
        self.assertEqual({e["kind"] for e in data["entries"]}, {"observed"})
        self.assertEqual(data["kindsRequested"], ["observed"])
        # ⚠️ The counts still describe the run rather than the filtered answer.
        self.assertGreater(sum(data["countsByKind"].values()), len(data["entries"]))

    def test_a_mistyped_kind_returns_nothing_and_echoes_what_was_asked(self):
        _, body = self.get("/tracking/behaviour/timeline?streamId=ases_a&cameraId=cam_1&kinds=loitering")
        self.assertEqual(body["data"]["entries"], [])
        self.assertEqual(body["data"]["kindsRequested"], ["loitering"])
        self.assertGreater(body["data"]["excludedByKind"], 0)

    def test_the_graph_carries_its_origin_so_no_reader_prints_an_epoch_second(self):
        _, body = self.get("/tracking/behaviour/graph?streamId=ases_a&cameraId=cam_1")
        graph = body["data"]["graph"]
        self.assertIn("originSeconds", graph)
        self.assertIn("truncated", graph)

    def test_the_primitives_publish_the_thresholds_they_used(self):
        _, body = self.get("/tracking/behaviour/primitives?streamId=ases_a&cameraId=cam_1")
        readings = body["data"]["primitives"]["readings"]
        # ⛔ Every reading names its mechanism and what it means, or the console prints a word with
        # no number beside it — which reads as "no threshold decided this".
        for name, reading in readings.items():
            self.assertTrue(reading.get("mechanism"), f"{name} publishes no mechanism")
            self.assertTrue(reading.get("means"), f"{name} publishes no meaning")
        self.assertIn("proximity", readings)
        self.assertIn("gap", readings)


class LineGeometryParsingTests(unittest.TestCase):
    """⛔ **Four states, and the fourth is the one that matters.**

    `absent` · `none` · `present` · `invalid`. Three of them render identically downstream — no
    crossings — and only one of them means the platform is working correctly. Folding `invalid` into
    `absent` is how a line an operator drew wrong stays wrong for months, because every screen agrees
    that nobody crossed it.
    """

    def parse(self, raw):
        from server import _lines_from_query  # noqa: WPS433 - the function under test

        return _lines_from_query(raw)

    def test_a_missing_parameter_says_nothing_about_crossings(self):
        for raw in (None, ""):
            lines, state = self.parse(raw)
            self.assertEqual(lines, ())
            self.assertEqual(state, "absent")

    def test_an_empty_list_is_a_real_answer_rather_than_silence(self):
        """⭐ "This camera has no line zones" — so "nobody crossed a line" IS the complete answer,
        which is a different claim from "nothing was evaluated"."""
        lines, state = self.parse("[]")
        self.assertEqual(lines, ())
        self.assertEqual(state, "none")

    def test_geometry_parses_into_lines(self):
        lines, state = self.parse('[{"lineId":"z_door","name":"Door","points":[[0.5,0.0],[0.5,1.0]]}]')
        self.assertEqual(state, "present")
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0].line_id, "z_door")
        self.assertEqual(lines[0].name, "Door")
        self.assertEqual(lines[0].points, [(0.5, 0.0), (0.5, 1.0)])

    def test_malformed_geometry_is_invalid_and_never_absent(self):
        for raw in (
            "not json",
            '{"lineId":"a"}',                                  # an object, not a list
            '[{"points":[[0,0],[1,1]]}]',                      # no lineId
            '[{"lineId":"a","points":[[0,0]]}]',               # one point is not a line
            '[{"lineId":"a","points":[[0,0],[1]]}]',           # a point that is not a pair
            '[{"lineId":"a","points":[[0,0],["x","y"]]}]',     # a point that is not numeric
            '[{"lineId":"","points":[[0,0],[1,1]]}]',          # an empty id
            '["not an object"]',
        ):
            lines, state = self.parse(raw)
            self.assertEqual(state, "invalid", f"{raw!r} should be invalid")
            self.assertEqual(lines, ())

    def test_a_line_with_too_many_points_is_refused_rather_than_shortened(self):
        """⛔ Truncating would evaluate crossings against geometry nobody drew."""
        points = [[i / 40, 0.5] for i in range(40)]
        _, state = self.parse(json.dumps([{"lineId": "a", "points": points}]))
        self.assertEqual(state, "invalid")

    def test_more_lines_than_the_cap_are_bounded_at_the_trust_boundary(self):
        """⚠️ Media bounds this too, but media is a caller rather than an authority."""
        from server import MAX_READ_LINES  # noqa: WPS433

        payload = [
            {"lineId": f"z_{i}", "points": [[0.1 * i, 0.0], [0.1 * i, 1.0]]} for i in range(MAX_READ_LINES + 4)
        ]
        lines, state = self.parse(json.dumps(payload))
        self.assertEqual(state, "present")
        self.assertEqual(len(lines), MAX_READ_LINES)


class LineCrossingRouteTests(unittest.TestCase):
    """A real walk across a real line, through the real read routes.

    ⛔ **Not simulated.** The path below is a subject moving left to right across x = 0.5 at 0.5 s
    intervals; the crossing is derived from the stored trajectory by the same `crossings()` the unit
    tests cover. Nothing stamps a crossing onto the fixture.
    """

    LINE = json.dumps([{"lineId": "z_door", "name": "Doorway", "points": [[0.5, 0.0], [0.5, 1.0]]}])

    @classmethod
    def setUpClass(cls):
        store = InMemoryTrackHistoryStore()
        # ⚠️ Steps of 0.1 from x=0.2 to x=0.8 — the subject passes through x=0.5 exactly, which is
        # the case that produced zero crossings before `crossings()` anchored on the last NAMED side.
        walk = [
            HistoryPoint(frame_index=i, at=f"{i * 0.5}s", bbox=(0.2 + i * 0.1, 0.4, 0.02, 0.1), track_id="trk_1")
            for i in range(7)
        ]
        store.write(
            TrackHistoryRecord(
                identity_id="idn_walker",
                tenant_id=TENANT,
                camera_id="cam_1",
                stream_id="ases_walk",
                label="person",
                points=walk,
                track_ids=["idn_walker"],
                closed=True,
            )
        )
        cls.recorder = TrackHistoryRecorder(store=store)
        cls.httpd = build_server("127.0.0.1", 0, _Registry(_Tracks(cls.recorder)), KEY, "inference", "0.1.0")
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def get(self, path):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            headers={"x-internal-key": KEY, "x-tenant-id": TENANT},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 - localhost test
            return json.loads(resp.read())

    def timeline(self, lines=None):
        query = "/tracking/behaviour/timeline?streamId=ases_walk&cameraId=cam_1"
        if lines is not None:
            query += "&lines=" + urllib.parse.quote(lines)
        return self.get(query)["data"]

    def test_without_geometry_there_is_no_crossing_and_the_read_says_why(self):
        """⛔ The negative control, and the reason `absent` exists. The subject walked across the
        line either way; with no geometry the platform cannot say so, and it must not imply it did."""
        data = self.timeline()
        self.assertEqual(data["lineGeometry"], "absent")
        self.assertEqual([e for e in data["entries"] if e["kind"] == "lineCross"], [])

    def test_with_geometry_the_crossing_appears_with_its_direction(self):
        data = self.timeline(self.LINE)
        self.assertEqual(data["lineGeometry"], "present")
        crossings = [e for e in data["entries"] if e["kind"] == "lineCross"]
        self.assertEqual(len(crossings), 1, "one walk across one line is one crossing")
        crossing = crossings[0]
        self.assertEqual(crossing["identityId"], "idn_walker")
        self.assertEqual(crossing["attributes"]["lineId"], "z_door")
        # ⚠️ Screen y grows downward, so a subject walking left-to-right along the top of the frame
        # goes from the line's `right` side to its `left`. The convention is the operator's drawing
        # order and nothing else — see `side_of_line`.
        self.assertIn(crossing["attributes"]["fromSide"], ("left", "right"))
        self.assertNotEqual(crossing["attributes"]["fromSide"], crossing["attributes"]["toSide"])
        # ⛔ Seekable. A crossing an investigator cannot look at is an assertion.
        self.assertIn("frameIndex", crossing["evidence"])

    def test_a_camera_with_no_line_zones_is_a_different_answer_from_no_geometry(self):
        data = self.timeline("[]")
        self.assertEqual(data["lineGeometry"], "none")
        self.assertEqual([e for e in data["entries"] if e["kind"] == "lineCross"], [])

    def test_malformed_geometry_is_reported_rather_than_swallowed(self):
        data = self.timeline("[{\"lineId\":\"a\"}]")
        self.assertEqual(data["lineGeometry"], "invalid")

    def test_the_crossing_reaches_the_graph_as_a_line_node_and_an_edge(self):
        graph = self.get(
            "/tracking/behaviour/graph?streamId=ases_walk&cameraId=cam_1&lines=" + urllib.parse.quote(self.LINE)
        )["data"]["graph"]
        self.assertIn("line", graph["counts"]["byNodeKind"])
        self.assertEqual(graph["counts"]["byEdgeKind"].get("crossed"), 1)
        crossed = [e for e in graph["edges"] if e["kind"] == "crossed"][0]
        self.assertEqual(crossed["source"], "idn_walker")
        self.assertEqual(crossed["target"], "line:z_door")
        self.assertIn(crossed["attributes"]["toSide"], ("left", "right"))

    def test_the_same_crossing_appears_once_in_each_projection(self):
        """⛔ **One event, never duplicated.** The graph is a reshaping of the timeline, so a
        crossing counted twice anywhere means two computations exist where there must be one."""
        entries = [e for e in self.timeline(self.LINE)["entries"] if e["kind"] == "lineCross"]
        graph = self.get(
            "/tracking/behaviour/graph?streamId=ases_walk&cameraId=cam_1&lines=" + urllib.parse.quote(self.LINE)
        )["data"]["graph"]
        crossed = [e for e in graph["edges"] if e["kind"] == "crossed"]
        self.assertEqual(len(entries), len(crossed))
        self.assertEqual(entries[0]["evidence"]["frameIndex"], crossed[0]["evidence"]["frameIndex"])

    def test_the_primitives_report_the_same_geometry_state_as_the_route(self):
        """⚠️ Two fields named `lineGeometry` at two levels of one payload must not disagree."""
        for lines, expected in ((None, "absent"), ("[]", "none"), (self.LINE, "present")):
            query = "/tracking/behaviour/primitives?streamId=ases_walk&cameraId=cam_1"
            if lines is not None:
                query += "&lines=" + urllib.parse.quote(lines)
            data = self.get(query)["data"]
            self.assertEqual(data["lineGeometry"], expected)
            self.assertEqual(data["primitives"]["lineGeometry"], expected)

    def test_walking_back_produces_a_second_crossing_in_the_other_direction(self):
        """⭐ Repeated crossing and wrong direction are the SAME primitive, twice — not two
        primitives. A rule names the direction it cares about; the platform reports both passages."""
        there_and_back = [
            HistoryPoint(frame_index=i, at=f"{i * 0.5}s", bbox=(x, 0.4, 0.02, 0.1), track_id="trk_2")
            for i, x in enumerate([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2])
        ]
        self.recorder.store.write(
            TrackHistoryRecord(
                identity_id="idn_return",
                tenant_id=TENANT,
                camera_id="cam_1",
                stream_id="ases_return",
                label="person",
                points=there_and_back,
                track_ids=["idn_return"],
                closed=True,
            )
        )
        data = self.get(
            "/tracking/behaviour/timeline?streamId=ases_return&cameraId=cam_1&lines="
            + urllib.parse.quote(self.LINE)
        )["data"]
        crossings = [e for e in data["entries"] if e["kind"] == "lineCross"]
        self.assertEqual(len(crossings), 2)
        first, second = crossings[0]["attributes"], crossings[1]["attributes"]
        self.assertEqual(first["fromSide"], second["toSide"])
        self.assertEqual(first["toSide"], second["fromSide"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
