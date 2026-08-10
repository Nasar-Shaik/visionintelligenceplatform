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


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
