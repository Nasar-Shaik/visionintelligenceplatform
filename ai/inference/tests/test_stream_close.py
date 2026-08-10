"""Closing a stream when the run that produced it ends — Evidence Integrity, EI-3b.

⛔ **The measured defect, and it is the root cause the shutdown flush only papered over.**

Nothing tells the runtime that an analysis has finished. The worker delivers its last frame and
stops; the identities still in shot at that moment stay in `TrackHistoryRecorder._live`, an in-memory
dict, and the only things that ever close them are the 300-second camera sweep — which runs on the
*frame* path, so a quiet deployment never runs it — and, since EI-3, shutdown.

Measured on the deployed stack, idle for 26 minutes after a batch of analyses:

    BEFORE  live_identities=28  live_streams=12  records=5259  write_failures=0
    ⏻ docker kill -s KILL          (an OOM kill, a crash, a grace period that ran out)
    AFTER   live_identities=0   live_streams=0   records=5259  write_failures=0
                                                 ▲▲▲▲▲▲▲▲▲▲▲▲ unchanged

28 identities across **12 finished analyses** destroyed, and `write_failures` stayed at zero because
nothing was ever attempted. ⚠️ Twelve streams, not one: this is not an edge case that needs an
unlucky moment, it is the steady state of a runtime that has been used.

### ⭐ Why this and not a bigger hammer

The EI-3 shutdown flush closes the *graceful* path. It cannot close SIGKILL, an OOM kill, a host
that loses power, or a `stop_grace_period` that expires mid-flush — and no shutdown handler can,
because the process is not consulted. The window between "the run finished" and "something eventually
retires the stream" is where every one of those does its damage.

So the fix is not a better shutdown. It is **to stop holding finished evidence in memory at all**:
the party that knows the run ended says so, and the window closes to nothing. ⚠️ No new store, no
second pipeline, no background synchroniser, no recovery daemon — this drives `retire_stream` and
`drain_pending`, which the camera sweep has called since track history became durable.

⚠️ **Tracker state is deliberately left alone.** Closing history is the evidence concern; releasing
`_CameraState` is a memory concern the sweep already handles on its own schedule. Retiring identities
is not the same act as forgetting how to track them, and conflating the two would change tracking
behaviour to fix a storage bug.
"""

import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server import build_server  # noqa: E402
from track_history import InMemoryTrackHistoryStore, TrackHistoryRecorder  # noqa: E402

KEY = "internal-key-at-least-16-chars"
TENANT = "tnt_close"


class _Tracks:
    """The `tracks` stage the route selects by, holding a real recorder."""

    def __init__(self, recorder):
        self.history = recorder

    def tracks(self, *_args, **_kwargs):
        return []


class _Registry:
    def __init__(self, tracker):
        self.tracker = tracker
        self.version = "0.1.0"

    def health(self):
        return []


def _observe(recorder, identity, *, camera="cam_1", stream="ases_1", n=6):
    for i in range(n):
        recorder.observe(
            tenant_id=TENANT,
            camera_id=camera,
            stream_id=stream,
            identity_id=identity,
            track_id=f"{identity}_t",
            frame_index=i,
            at=f"2026-08-10T10:00:{i:02d}.000Z",
            bbox=(0.1, 0.1, 0.1, 0.2),
        )


class StreamCloseRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.recorder = TrackHistoryRecorder(store=InMemoryTrackHistoryStore())
        self.registry = _Registry(_Tracks(self.recorder))
        self.httpd = build_server("127.0.0.1", 0, self.registry, KEY, "inference", "0.1.0")
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.httpd.shutdown)

    def post(self, path, body, tenant=TENANT, key=KEY):
        payload = json.dumps(body).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=payload,
            headers={
                "x-internal-key": key,
                "x-tenant-id": tenant,
                "content-type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 - localhost test
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    def test_closing_a_stream_makes_its_open_identities_durable(self) -> None:
        """⭐ The requirement, stated plainly: when the run ends, nothing of it is left in memory."""
        _observe(self.recorder, "id_person")
        _observe(self.recorder, "id_bag")
        self.assertEqual(len(self.recorder.store.records(TENANT)), 0)

        status, body = self.post(
            "/tracking/streams/close", {"cameraId": "cam_1", "streamId": "ases_1"}
        )

        self.assertEqual(status, 200)
        self.assertEqual(body["data"]["closed"], 2)
        stored = {r.identity_id for r in self.recorder.store.records(TENANT)}
        self.assertEqual(stored, {"id_person", "id_bag"})
        self.assertEqual(self.recorder.stats()["liveIdentities"], 0)

    def test_a_closed_record_is_marked_closed(self) -> None:
        """⚠️ A record written at the end of a run is complete. One still reading `closed: False`
        would present a finished analysis as one still in progress, and every duration on it as a
        lower bound."""
        _observe(self.recorder, "id_person")
        self.post("/tracking/streams/close", {"cameraId": "cam_1", "streamId": "ases_1"})
        self.assertTrue(all(r.closed for r in self.recorder.store.records(TENANT)))

    def test_closing_drains_rather_than_queueing(self) -> None:
        """⛔ `retire_stream` only moves records to `_pending`. A close that retired without draining
        would be the same loss with an extra step — which is the mistake `retire_all` documents."""
        _observe(self.recorder, "id_person")
        self.post("/tracking/streams/close", {"cameraId": "cam_1", "streamId": "ases_1"})
        self.assertEqual(self.recorder.stats()["pendingWrites"], 0)

    def test_closing_one_stream_leaves_another_alone(self) -> None:
        """⛔ The isolation that makes this safe to call. Two analyses run concurrently on one camera,
        and closing the one that finished must not retire the one still going — that would truncate a
        live run's identities and split every path in it."""
        _observe(self.recorder, "id_done", stream="ases_done")
        _observe(self.recorder, "id_running", stream="ases_running")

        self.post("/tracking/streams/close", {"cameraId": "cam_1", "streamId": "ases_done"})

        stored = {r.identity_id for r in self.recorder.store.records(TENANT)}
        self.assertEqual(stored, {"id_done"})
        still_live = {r.identity_id for r in self.recorder.find_live(TENANT)}
        self.assertEqual(still_live, {"id_running"})

    def test_closing_is_idempotent(self) -> None:
        """⚠️ The worker may call this more than once — a retried terminal write, a redelivery. The
        second call must report zero rather than duplicating the evidence, because a duplicated
        record doubles every duration derived from it."""
        _observe(self.recorder, "id_person")
        first = self.post("/tracking/streams/close", {"cameraId": "cam_1", "streamId": "ases_1"})[1]
        second = self.post("/tracking/streams/close", {"cameraId": "cam_1", "streamId": "ases_1"})[1]
        self.assertEqual(first["data"]["closed"], 1)
        self.assertEqual(second["data"]["closed"], 0)
        self.assertEqual(len(self.recorder.store.records(TENANT)), 1)

    def test_closing_an_unknown_stream_is_not_an_error(self) -> None:
        """⚠️ A run that produced no detections has nothing open, and that is an ordinary outcome.
        Answering 404 would make the worker log an error on every empty analysis and teach everyone
        to ignore the log."""
        status, body = self.post(
            "/tracking/streams/close", {"cameraId": "cam_1", "streamId": "ases_never"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["data"]["closed"], 0)

    def test_another_tenants_stream_cannot_be_closed(self) -> None:
        """⛔ Tenant scoping is structural here as everywhere. A close that ignored the tenant would
        let one customer retire another's live identities — a denial of evidence, cross-tenant."""
        _observe(self.recorder, "id_person")
        status, body = self.post(
            "/tracking/streams/close", {"cameraId": "cam_1", "streamId": "ases_1"}, tenant="tnt_other"
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["data"]["closed"], 0)
        self.assertEqual(self.recorder.stats()["liveIdentities"], 1)

    def test_a_close_requires_a_tenant(self) -> None:
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/tracking/streams/close",
            data=json.dumps({"cameraId": "cam_1", "streamId": "ases_1"}).encode(),
            headers={"x-internal-key": KEY, "content-type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=5)  # noqa: S310 - localhost test
        self.assertEqual(caught.exception.code, 400)

    def test_a_close_requires_the_internal_key(self) -> None:
        status, _ = self.post(
            "/tracking/streams/close", {"cameraId": "cam_1", "streamId": "ases_1"}, key="wrong-key"
        )
        self.assertEqual(status, 401)

    def test_a_close_requires_a_camera_and_a_stream(self) -> None:
        """⛔ Never defaulted. A close with a missing `streamId` that fell back to `None` would
        retire the **live camera's** identities — `stream_id=None` is exactly the live path's key."""
        self.assertEqual(self.post("/tracking/streams/close", {"cameraId": "cam_1"})[0], 400)
        self.assertEqual(self.post("/tracking/streams/close", {"streamId": "ases_1"})[0], 400)


if __name__ == "__main__":
    unittest.main()
