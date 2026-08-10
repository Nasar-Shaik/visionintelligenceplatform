"""Evidence durability — the Evidence Integrity milestone, EI-2.

⛔ **These tests were written to FAIL against the implementation that shipped Phase 2**, and the
failure they describe was measured on the deployed stack before a line of them was written:

    BEFORE restart   live_identities=3   records=5214   write_failures=0
    ⏻ docker restart vip-prod-inference-1
    AFTER  restart   live_identities=0   records=5214   write_failures=0
                                         ▲▲▲▲▲▲▲▲▲▲▲▲ unchanged

Three identities were destroyed and **not one write was attempted** — `write_failures` stayed at
zero because nothing ever tried. The behaviour read collapsed from
`{carried: 3, picked: 3, observed: 5}` to `{observed: 2}`, and nothing anywhere said evidence had
been lost.

### ⛔ The root cause, proven rather than assumed

The runtime **does** handle SIGTERM gracefully — `app.py` stops the heartbeat, drains sessions and
shuts down the HTTP server, inside a 20-second `stop_grace_period` it never needs. What it has never
done is flush track history. Every identity still open at that moment lives only in
`TrackHistoryRecorder._live`, an in-memory dict, and the process exits without writing it.

⚠️ **The earlier hypothesis — "retirement runs on the frame path, so a stream that stops sending
frames is never retired" — was measured and DISCARDED.** Retirement is driven perfectly well:
`retired` rose 101 → 151 and `records` rose 5164 → 5214 at the moment a run ended, and every one of
those 50 retirements was written. The lingering identities are real, but they are only the *window*.
The loss is the shutdown.

`retire_stream` and `drain_pending` have both existed since track history became durable. Nothing
called them when the process was asked to stop.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from track_history import (  # noqa: E402
    JsonlTrackHistoryStore,
    TrackHistoryRecorder,
)

TENANT = "tnt_evidence"


def _observe(recorder: TrackHistoryRecorder, identity: str, *, stream: str, n: int = 4, label: str = "person") -> None:
    for i in range(n):
        recorder.observe(
            tenant_id=TENANT,
            camera_id="cam_1",
            stream_id=stream,
            identity_id=identity,
            track_id=f"{identity}_t",
            frame_index=i,
            at=f"2026-02-14T18:30:{i:02d}.000Z",
            bbox=(0.1, 0.1, 0.1, 0.2),
            label=label,
        )


class ShutdownFlushTests(unittest.TestCase):
    """⛔ The measured defect: a process that is asked to stop discards open evidence."""

    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.store = JsonlTrackHistoryStore(self._dir.name)
        self.recorder = TrackHistoryRecorder(store=self.store)

    def test_open_identities_are_not_in_the_store_before_any_flush(self) -> None:
        """⚠️ The precondition, asserted so the test below cannot pass vacuously."""
        _observe(self.recorder, "id_person", stream="ases_1")
        self.assertEqual(len(self.store.records(TENANT)), 0)
        self.assertEqual(self.recorder.stats()["liveIdentities"], 1)

    def test_retire_all_writes_every_open_identity_on_every_stream(self) -> None:
        """⭐ The fix, stated as a requirement: **nothing open may be discarded unwritten.**"""
        _observe(self.recorder, "id_person", stream="ases_1")
        _observe(self.recorder, "id_bag", stream="ases_1", label="handbag")
        _observe(self.recorder, "id_other", stream="ases_2")

        retired = self.recorder.retire_all()

        self.assertEqual(retired, 3)
        stored = {r.identity_id for r in self.store.records(TENANT)}
        self.assertEqual(stored, {"id_person", "id_bag", "id_other"})
        # ⛔ Every stored record must be marked closed: a record written at shutdown is complete,
        # and one that still reads `closed: False` would look like a run still in progress.
        self.assertTrue(all(r.closed for r in self.store.records(TENANT)))
        self.assertEqual(self.recorder.stats()["liveIdentities"], 0)
        self.assertEqual(self.recorder.stats()["pendingWrites"], 0)

    def test_retire_all_drains_rather_than_leaving_records_queued(self) -> None:
        """⛔ Retiring without draining is the same loss with an extra step.

        `retire_stream` moves records to `_pending`; only `drain_pending` writes them. A shutdown
        path that retired and did not drain would exit with the evidence in a list nobody reads.
        """
        _observe(self.recorder, "id_person", stream="ases_1")
        self.recorder.retire_all()
        self.assertEqual(self.recorder.stats()["pendingWrites"], 0)
        self.assertEqual(len(self.store.records(TENANT)), 1)

    def test_retire_all_is_safe_when_there_is_nothing_open(self) -> None:
        """⚠️ Shutdown runs on every stop, including the ones with an idle runtime."""
        self.assertEqual(self.recorder.retire_all(), 0)

    def test_retire_all_is_idempotent(self) -> None:
        """⚠️ A signal handler can run twice — SIGTERM followed by SIGINT is an ordinary Ctrl-C
        after a `docker stop`. The second call must not double-write or raise."""
        _observe(self.recorder, "id_person", stream="ases_1")
        self.assertEqual(self.recorder.retire_all(), 1)
        self.assertEqual(self.recorder.retire_all(), 0)
        self.assertEqual(len(self.store.records(TENANT)), 1)

    def test_a_flushed_record_keeps_every_observation(self) -> None:
        """⛔ Durable-but-truncated is a subtler loss than durable-but-absent, and it would make a
        read taken after a restart *disagree* with one taken before it while both looked complete."""
        _observe(self.recorder, "id_person", stream="ases_1", n=9)
        live = self.recorder.live_records(TENANT, "cam_1", "ases_1")
        before = len(list(live)[0].points)
        self.recorder.retire_all()
        after = len(self.store.records(TENANT)[0].points)
        self.assertEqual(after, before)
        self.assertEqual(after, 9)

    def test_a_write_failure_at_shutdown_is_counted_rather_than_swallowed(self) -> None:
        """⛔ The one thing worse than losing evidence is losing it silently.

        ⚠️ `drain_pending` already contains the failure exactly so a storage fault cannot take down
        perception. At shutdown there is no perception left to protect, so the requirement is only
        that the count moves — a run that lost evidence to a full disk must be distinguishable from
        one that had nothing to write.
        """

        class _Refuses:
            def write(self, record):  # noqa: ANN001, ANN202
                raise OSError("no space left on device")

            def records(self, *args, **kwargs):  # noqa: ANN002, ANN003, ANN202
                return []

            def stats(self):  # noqa: ANN202
                return {"durable": True, "records": 0}

        recorder = TrackHistoryRecorder(store=_Refuses())
        _observe(recorder, "id_person", stream="ases_1")
        recorder.retire_all()
        self.assertEqual(recorder.stats()["writeFailures"], 1)
        self.assertIsNotNone(recorder.stats()["lastWriteError"])


class SinglePrecisionTests(unittest.TestCase):
    """⛔ **The second half of the durability defect, and the subtler one.**

    Flushing evidence at shutdown made it *survive* a restart. It did not make it *identical*.
    Measured on the deployed stack after the flush landed, comparing every leaf field of every
    graph node across a restart — only two moved, on exactly the three identities that were live
    before and durable after:

        node person   directionDegrees      93.1173  → 93.1216
        node car      directionDegrees     100.3144  → 100.3131
                      pathLengthNormalized   0.026627 → 0.026626
        node backpack directionDegrees     309.1818  → 306.8699
                      pathLengthNormalized   0.000006 → 0.000009

    ⚠️ `samples` and `durationSeconds` were **identical**, so no point was lost, gained or
    reordered. Every thresholded fact — idle, linger, dwell, association — was identical too,
    because a perturbation this small never crosses a threshold.

    ⭐ The cause: `HistoryPoint.to_dict()` rounds `bbox` to six decimals **on serialisation**, and
    the in-memory record keeps full precision. The live read therefore derives direction and path
    length from one set of coordinates and the durable read from another. On a near-stationary
    object whose whole displacement is ~1e-5, a 1e-6 rounding is a ten-percent perturbation — which
    is the 2.3° swing above.

    ⛔ **Two precisions for one fact is the defect; rounding is not.** Rounding at the storage
    boundary is right — full binary float repr in JSONL would be larger and platform-sensitive. The
    fix is to round **once, at observation**, so the record a live read sees is bit-identical to the
    record a durable read will see.
    """

    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.recorder = TrackHistoryRecorder(store=JsonlTrackHistoryStore(self._dir.name))

    #: More precision than the store keeps, in every component.
    RAW_BBOX = (0.1234567891, 0.2345678912, 0.1000000049, 0.2000000051)

    def _observe_raw(self, identity: str = "id_p") -> None:
        self.recorder.observe(
            tenant_id=TENANT, camera_id="cam_1", stream_id="ases_1", identity_id=identity,
            track_id="t", frame_index=0, at="2026-02-14T18:30:00.000Z", bbox=self.RAW_BBOX,
        )

    def test_the_live_record_holds_the_value_the_store_will_hold(self) -> None:
        """⭐ The invariant, stated directly: one fact, one representation."""
        self._observe_raw()
        live = list(self.recorder.live_records(TENANT, "cam_1", "ases_1"))[0]
        self.assertEqual(
            tuple(live.points[0].bbox),
            tuple(round(v, 6) for v in self.RAW_BBOX),
        )

    def test_a_live_point_and_its_durable_twin_are_byte_identical(self) -> None:
        """⛔ The assertion that would have caught the drift: serialise the live point, flush, read
        the durable point back, and compare the wire form of each."""
        self._observe_raw()
        live = list(self.recorder.live_records(TENANT, "cam_1", "ases_1"))[0]
        before = live.points[0].to_dict()
        self.recorder.retire_all()
        after = self.recorder.store.records(TENANT)[0].points[0].to_dict()
        self.assertEqual(after, before)

    def test_confidence_is_held_to_the_same_single_precision(self) -> None:
        """⚠️ `to_dict` rounds confidence too, so it has the identical two-precision problem."""
        self.recorder.observe(
            tenant_id=TENANT, camera_id="cam_1", stream_id="ases_1", identity_id="id_c",
            track_id="t", frame_index=0, at="2026-02-14T18:30:00.000Z",
            bbox=(0.1, 0.1, 0.1, 0.2), confidence=0.8765432198,
        )
        live = list(self.recorder.live_records(TENANT, "cam_1", "ases_1"))[0]
        self.assertEqual(live.points[0].confidence, round(0.8765432198, 6))

    def test_a_value_needing_no_rounding_is_untouched(self) -> None:
        """⚠️ The control: rounding must not perturb a coordinate that was already exact."""
        exact = (0.25, 0.5, 0.125, 0.0625)
        self.recorder.observe(
            tenant_id=TENANT, camera_id="cam_1", stream_id="ases_1", identity_id="id_e",
            track_id="t", frame_index=0, at="2026-02-14T18:30:00.000Z", bbox=exact,
        )
        live = list(self.recorder.live_records(TENANT, "cam_1", "ases_1"))[0]
        self.assertEqual(tuple(live.points[0].bbox), exact)


class RestartEquivalenceTests(unittest.TestCase):
    """⭐ The milestone's acceptance criterion, in one assertion.

    A completed run must read the same immediately and after a restart. The only difference a
    restart makes is that the live buckets are gone — so the test is: *what the store holds after a
    flush must equal what the live buckets held before it.*
    """

    def test_the_store_after_shutdown_equals_the_live_view_before_it(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        store = JsonlTrackHistoryStore(directory.name)
        recorder = TrackHistoryRecorder(store=store)

        _observe(recorder, "id_person", stream="ases_1", n=6)
        _observe(recorder, "id_bag", stream="ases_1", n=6, label="handbag")

        before = {
            r.identity_id: (r.label, len(r.points), [p.bbox for p in r.points])
            for r in recorder.live_records(TENANT, "cam_1", "ases_1")
        }
        recorder.retire_all()

        # ⚠️ A *new* recorder over the same directory — which is what a restart actually is.
        restarted = TrackHistoryRecorder(store=JsonlTrackHistoryStore(directory.name))
        after = {
            r.identity_id: (r.label, len(r.points), [p.bbox for p in r.points])
            for r in restarted.store.records(TENANT)
        }
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
