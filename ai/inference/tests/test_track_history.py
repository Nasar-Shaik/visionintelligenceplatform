"""Durable track history tests (P-11 slice 2.2, ADR-0051).

Every test here is written against a failure that **succeeds quietly**: a retention pass that deletes
an archive the day it is written, an erasure that clears the disk and leaves the memory, a history
keyed by track id that halves everyone's dwell. None of them raise, and all of them produce a number
a report would print without complaint.

Deterministic: injected clock, a temporary directory, no threads.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from track_history import (  # noqa: E402
    HistoryPoint,
    InMemoryTrackHistoryStore,
    JsonlTrackHistoryStore,
    NullTrackHistoryStore,
    RetentionPolicy,
    TrackHistoryRecord,
    TrackHistoryRecorder,
    TrackHistoryUnavailable,
    points_of,
)

HOUR = 3600.0


def record(identity="idn_1", tenant="tnt_a", camera="cam_1", *, points=3, start=0.0, written_at=None):
    return TrackHistoryRecord(
        identity_id=identity,
        tenant_id=tenant,
        camera_id=camera,
        label="person",
        points=[
            HistoryPoint(frame_index=i, at=f"{start + i:g}s", bbox=(0.1, 0.1, 0.1, 0.1), track_id="trk_1")
            for i in range(points)
        ],
        track_ids=["trk_1"],
        written_at=written_at,
    )


class RecordShapeTests(unittest.TestCase):
    def test_a_record_round_trips_through_its_dict_form(self):
        original = record(points=4, written_at="2026-08-08T10:00:00Z")
        restored = TrackHistoryRecord.from_dict(json.loads(json.dumps(original.to_dict())))
        self.assertEqual(restored.identity_id, original.identity_id)
        self.assertEqual(len(restored.points), 4)
        self.assertEqual(restored.points[2].at, "2s")
        self.assertEqual(restored.written_at, "2026-08-08T10:00:00Z")

    def test_settled_zone_membership_survives_a_round_trip_with_the_version_that_decided_it(self):
        """⭐ ADR-0053, amending ADR-0051. Membership is stored **because** the record names the
        polygon version that produced it: a polygon later found to be drawn two metres off does not
        silently invalidate history, and re-resolving becomes a visible act rather than a rewrite."""
        original = record(points=1)
        original.zone_version = 7
        original.points[0] = HistoryPoint(
            frame_index=0, at="0s", bbox=(0.1, 0.1, 0.1, 0.1), track_id="trk_1", zone_ids=("z_till",)
        )
        restored = TrackHistoryRecord.from_dict(original.to_dict())
        self.assertEqual(restored.points[0].zone_ids, ("z_till",))
        self.assertTrue(restored.points[0].zones_settled)
        self.assertEqual(restored.zone_version, 7)

    def test_undecided_membership_is_absent_from_the_document_and_settled_emptiness_is_not(self):
        """⛔ The distinction the whole zone join rests on. `zoneIds: []` says somebody decided this
        observation was inside no zone; **no key at all** says nobody has decided yet. Collapsing them
        turns an un-echoed frame into a `left` transition that never happened."""
        undecided = HistoryPoint(frame_index=0, at="0s", bbox=(0, 0, 1, 1), track_id="trk_1")
        outside = HistoryPoint(
            frame_index=1, at="1s", bbox=(0, 0, 1, 1), track_id="trk_1", zones_settled=True
        )
        self.assertNotIn("zoneIds", undecided.to_dict())
        self.assertEqual(outside.to_dict()["zoneIds"], [])
        self.assertFalse(HistoryPoint.from_dict(undecided.to_dict()).zones_settled)
        self.assertTrue(HistoryPoint.from_dict(outside.to_dict()).zones_settled)

    def test_a_point_carrying_zones_cannot_claim_to_be_undecided(self):
        """⚠️ The contradictory state is unbuildable, not merely discouraged — two readers would
        reasonably disagree about which half of it to believe."""
        point = HistoryPoint(
            frame_index=0, at="0s", bbox=(0, 0, 1, 1), track_id="trk_1", zone_ids=("z_till",), zones_settled=False
        )
        self.assertTrue(point.zones_settled)

    def test_an_unparseable_timestamp_reads_as_none_and_not_as_the_epoch(self):
        point = HistoryPoint(frame_index=0, at="not-a-time", bbox=(0, 0, 1, 1), track_id="trk_1")
        self.assertIsNone(point.at_seconds)

    def test_points_of_orders_across_records_and_drops_the_undatable(self):
        first = record(identity="idn_1", points=2, start=10.0)
        second = record(identity="idn_2", points=2, start=0.0)
        second.points.append(HistoryPoint(frame_index=9, at="??", bbox=(0, 0, 1, 1), track_id="trk_2"))
        ordered = points_of([first, second])
        self.assertEqual([p.at for p in ordered], ["0s", "1s", "10s", "11s"])


class RetentionTests(unittest.TestCase):
    def test_retention_counts_wall_clock_receipt_time_not_footage_time(self):
        """⛔ The defect this exists to prevent: purging by footage time erases a 2019 archive the
        instant it is analysed, and keeps tomorrow's live footage for ever."""
        policy = RetentionPolicy(max_age_hours=24.0)
        # Footage from 2019; written a minute ago.
        old_footage = record(points=2, start=0.0, written_at="2026-08-08T10:00:00Z")
        now = 1786298460.0  # 2026-08-09T10:01:00Z
        self.assertTrue(policy.expired(old_footage, now=now))
        fresh = record(points=2, start=0.0, written_at="2026-08-09T09:59:00Z")
        self.assertFalse(policy.expired(fresh, now=now))

    def test_a_record_with_no_receipt_time_is_not_expired(self):
        """⚠️ Missing metadata is a bug in the writer. Deleting data because of it fails in the
        direction that cannot be undone."""
        self.assertFalse(RetentionPolicy(max_age_hours=0.001).expired(record(), now=1e12))

    def test_points_are_trimmed_from_the_oldest_end(self):
        store = InMemoryTrackHistoryStore(RetentionPolicy(max_points=3))
        store.write(record(points=10))
        kept = store.records("tnt_a")[0]
        self.assertEqual([p.at for p in kept.points], ["7s", "8s", "9s"])


class NullStoreTests(unittest.TestCase):
    def test_the_default_store_persists_nothing_and_says_so(self):
        store = NullTrackHistoryStore()
        store.write(record())
        self.assertEqual(store.records("tnt_a"), [])
        self.assertIs(store.stats()["durable"], False)


class JsonlStoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vip-history-")
        self.now = [1786298400.0]
        self.store = JsonlTrackHistoryStore(self.dir, clock=lambda: self.now[0])

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_a_record_survives_a_restart(self):
        """⭐ Resume is a property of the format: the file IS the state."""
        self.store.write(record(identity="idn_survivor", points=5))
        reopened = JsonlTrackHistoryStore(self.dir)
        records = reopened.records("tnt_a")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].identity_id, "idn_survivor")
        self.assertEqual(len(records[0].points), 5)

    def test_stats_counts_records_without_deserialising_any_of_them(self):
        """⛔ The P-11 soak defect, encoded as a property rather than as a timing.

        `stats()` backs the `inference_track_history_records` gauge, so it runs on every `/metrics`
        scrape. It used to compute the count as `len(self._read(t))`, rebuilding the entire durable
        history as `TrackHistoryRecord`/`HistoryPoint` objects each time — 148 ms and ~36k objects
        per scrape at 713 records on the deployed container, growing linearly with retained data.

        ⭐ Making `_read` explode is what makes this test fail on the old implementation and pass on
        the new one. A timing assertion would be flaky on a loaded host and would not say *why*.
        """
        for i in range(5):
            self.store.write(record(identity=f"idn_{i}", points=40))

        def explode(_tenant_id):
            raise AssertionError("stats() must not deserialise records — it is on the /metrics path")

        self.store._read = explode  # noqa: SLF001 - asserting the private call is the point
        self.assertEqual(self.store.stats()["records"], 5)

    def test_stats_does_not_count_a_truncated_final_record(self):
        """⚠️ An append-only file whose writer was killed mid-line: `_read` skips the fragment, so
        the gauge must not count it either. A metric that disagrees with the data it describes sends
        somebody looking for a record that cannot be read."""
        self.store.write(record(identity="idn_whole"))
        with open(os.path.join(self.dir, "tnt_a.jsonl"), "a", encoding="utf-8") as handle:
            handle.write('{"identityId": "idn_trunc", "poi')
        self.assertEqual(len(self.store.records("tnt_a")), 1)
        self.assertEqual(self.store.stats()["records"], 1)

    def test_stats_counts_every_tenant(self):
        self.store.write(record(tenant="tnt_a"))
        self.store.write(record(tenant="tnt_b"))
        self.store.write(record(tenant="tnt_b"))
        stats = self.store.stats()
        self.assertEqual(stats["records"], 3)
        self.assertEqual(stats["tenants"], 2)

    def test_records_are_filtered_by_camera_and_identity(self):
        self.store.write(record(identity="idn_1", camera="cam_1"))
        self.store.write(record(identity="idn_2", camera="cam_2"))
        self.assertEqual([r.identity_id for r in self.store.records("tnt_a", camera_id="cam_2")], ["idn_2"])
        self.assertEqual([r.camera_id for r in self.store.records("tnt_a", identity_id="idn_1")], ["cam_1"])

    def test_one_tenant_never_reads_another(self):
        self.store.write(record(tenant="tnt_a"))
        self.store.write(record(tenant="tnt_b"))
        self.assertEqual(len(self.store.records("tnt_a")), 1)
        self.assertEqual(len(self.store.records("tnt_b")), 1)

    def test_erasure_removes_one_tenant_and_leaves_the_other_intact(self):
        self.store.write(record(tenant="tnt_a"))
        self.store.write(record(tenant="tnt_b"))
        self.assertEqual(self.store.erase_tenant("tnt_a"), 1)
        self.assertEqual(self.store.records("tnt_a"), [])
        self.assertEqual(len(self.store.records("tnt_b")), 1)

    def test_erasing_a_tenant_with_nothing_stored_is_zero_and_not_an_error(self):
        self.assertEqual(self.store.erase_tenant("tnt_never_seen"), 0)

    def test_erasure_leaves_no_file_behind(self):
        self.store.write(record(tenant="tnt_a"))
        self.store.erase_tenant("tnt_a")
        self.assertEqual([n for n in os.listdir(self.dir) if n.endswith(".jsonl")], [])

    def test_purge_drops_only_what_is_past_retention(self):
        store = JsonlTrackHistoryStore(self.dir, RetentionPolicy(max_age_hours=1.0), clock=lambda: self.now[0])
        store.write(record(identity="idn_old"))
        self.now[0] += 2 * HOUR
        store.write(record(identity="idn_new"))
        self.assertEqual(store.purge(), 1)
        self.assertEqual([r.identity_id for r in store.records("tnt_a")], ["idn_new"])

    def test_a_truncated_final_line_does_not_lose_the_whole_archive(self):
        """⚠️ The normal cost of an append-only file whose writer was killed."""
        self.store.write(record(identity="idn_1"))
        path = os.path.join(self.dir, "tnt_a.jsonl")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write('{"identityId": "idn_broken", "tenan')
        self.assertEqual([r.identity_id for r in self.store.records("tnt_a")], ["idn_1"])

    def test_a_tenant_id_with_a_path_separator_cannot_escape_the_directory(self):
        self.store.write(record(tenant="../../etc/passwd"))
        written = [n for n in os.listdir(self.dir) if n.endswith(".jsonl")]
        self.assertEqual(len(written), 1)
        self.assertNotIn("/", written[0])
        self.assertEqual(len(self.store.records("../../etc/passwd")), 1)

    def test_two_tenant_ids_differing_only_in_an_unsafe_character_do_not_share_a_file(self):
        """⛔ If unsafe characters were stripped rather than escaped, erasing one would take the
        other's history with it."""
        self.store.write(record(tenant="tnt:a"))
        self.store.write(record(tenant="tnt.a"))
        self.assertEqual(len({n for n in os.listdir(self.dir) if n.endswith(".jsonl")}), 2)
        self.assertEqual(self.store.erase_tenant("tnt:a"), 1)
        self.assertEqual(len(self.store.records("tnt.a")), 1)


class UnwritableStoreTests(unittest.TestCase):
    """⛔ The two defects the DEPLOYMENT found on 2026-08-08, neither reachable from a unit test that
    had not been written against them.

    A named Docker volume is seeded root-owned when the image has no directory at that path. The
    runtime runs as uid 999, every history write raised `EPERM`, and the exception propagated out of
    `RuntimeTracker.run` into `CapabilityRuntime.process` — so **every frame after the first retired
    identity answered HTTP 500** while the container went on reporting healthy.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vip-history-ro-")
        os.chmod(self.dir, 0o500)  # r-x: listable, not writable

    def tearDown(self):
        os.chmod(self.dir, 0o700)
        shutil.rmtree(self.dir, ignore_errors=True)

    @unittest.skipIf(os.getuid() == 0, "root ignores the permission bits this test depends on")
    def test_an_unwritable_directory_is_refused_at_construction(self):
        """⛔ Fail fast. An operator who configured a history location asked for paths to be kept;
        starting anyway and keeping none of them is the silent half-failure ADR-0051 §5 forbids."""
        with self.assertRaises(TrackHistoryUnavailable) as caught:
            JsonlTrackHistoryStore(self.dir)
        self.assertIn("not writable", str(caught.exception))

    def test_a_write_failure_is_contained_counted_and_reported(self):
        """⛔ Keeping movement paths is a secondary duty. A secondary duty that can stop the primary
        one — seeing people — is a defect in the wiring, not in the storage."""

        class Refusing:
            def write(self, record):
                raise PermissionError(13, "Permission denied")

            def records(self, tenant_id, *, camera_id=None, identity_id=None):
                return []

            def erase_tenant(self, tenant_id):
                return 0

            def purge(self, *, now=None):
                return 0

            def stats(self):
                return {"durable": True, "backend": "refusing", "records": 0, "tenants": 0}

        recorder = TrackHistoryRecorder(store=Refusing())
        recorder.observe(
            tenant_id="tnt_a",
            camera_id="cam_1",
            stream_id=None,
            identity_id="idn_1",
            track_id="trk_1",
            frame_index=0,
            at="0s",
            bbox=(0.1, 0.1, 0.1, 0.1),
        )
        recorder.retire(tenant_id="tnt_a", camera_id="cam_1", stream_id=None, identity_id="idn_1")

        self.assertEqual(recorder.drain_pending(), 0, "nothing was written")
        stats = recorder.stats()
        self.assertEqual(stats["writeFailures"], 1)
        self.assertIn("PermissionError", stats["lastWriteError"])
        # ⛔ And the pair that made the original failure look like a quiet camera.
        self.assertEqual(stats["identitiesRetired"], 1)
        self.assertEqual(stats["store"]["records"], 0)

    def test_a_write_failure_does_not_requeue_and_grow_without_bound(self):
        """⚠️ Dropped rather than retried. An unbounded retry queue on a permanently unwritable
        volume ends the same outage a slower way."""

        class Refusing:
            def write(self, record):
                raise OSError("nope")

            def stats(self):
                return {"durable": True, "backend": "refusing", "records": 0, "tenants": 0}

        recorder = TrackHistoryRecorder(store=Refusing())
        for index in range(5):
            recorder.observe(
                tenant_id="tnt_a",
                camera_id="cam_1",
                stream_id=None,
                identity_id=f"idn_{index}",
                track_id=f"trk_{index}",
                frame_index=index,
                at=f"{index}s",
                bbox=(0.1, 0.1, 0.1, 0.1),
            )
            recorder.retire(
                tenant_id="tnt_a", camera_id="cam_1", stream_id=None, identity_id=f"idn_{index}"
            )
            recorder.drain_pending()
        self.assertEqual(recorder.stats()["pendingWrites"], 0)
        self.assertEqual(recorder.stats()["writeFailures"], 5)


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.store = InMemoryTrackHistoryStore()
        self.recorder = TrackHistoryRecorder(store=self.store, max_points=8)

    def observe(self, identity, track, at, *, bbox=(0.1, 0.1, 0.1, 0.1), label="person"):
        self.recorder.observe(
            tenant_id="tnt_a",
            camera_id="cam_1",
            stream_id=None,
            identity_id=identity,
            track_id=track,
            frame_index=int(float(at.rstrip("s")) * 2),
            at=at,
            bbox=bbox,
            label=label,
        )

    def test_one_identity_across_two_track_ids_is_one_record(self):
        """⛔ The single most likely defect in the phase. A briefly occluded person returns with a
        NEW track id; a history keyed by track id would show two short visits, not one long one."""
        self.observe("idn_1", "trk_1", "0s")
        self.observe("idn_1", "trk_1", "1s")
        self.observe("idn_1", "trk_7", "5s")  # re-entry: same identity, new track
        records = self.recorder.live_records("tnt_a", "cam_1")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].track_ids, ["trk_1", "trk_7"])
        self.assertEqual(records[0].last_seconds - records[0].first_seconds, 5.0)

    def test_an_undated_observation_is_dropped_and_counted(self):
        self.observe("idn_1", "trk_1", "0s")
        self.recorder.observe(
            tenant_id="tnt_a",
            camera_id="cam_1",
            stream_id=None,
            identity_id="idn_1",
            track_id="trk_1",
            frame_index=1,
            at="not-a-time",
            bbox=(0.1, 0.1, 0.1, 0.1),
        )
        self.assertEqual(len(self.recorder.live_records("tnt_a", "cam_1")[0].points), 1)
        self.assertEqual(self.recorder.stats()["undatedObservationsDropped"], 1)

    def test_retire_stale_closes_only_identities_past_the_reentry_window(self):
        self.observe("idn_stale", "trk_1", "0s")
        self.observe("idn_fresh", "trk_2", "20s")
        closed = self.recorder.retire_stale(
            tenant_id="tnt_a", camera_id="cam_1", stream_id=None, now_seconds=20.0, older_than_seconds=12.0
        )
        self.assertEqual(closed, 1)
        self.assertEqual([r.identity_id for r in self.recorder.live_records("tnt_a", "cam_1")], ["idn_fresh"])

    def test_a_retired_identity_is_not_written_until_it_is_drained(self):
        """⚠️ Draining happens outside the tracker's update lock, so a disk write never lands on the
        path every frame of every camera shares."""
        self.observe("idn_1", "trk_1", "0s")
        self.recorder.retire(tenant_id="tnt_a", camera_id="cam_1", stream_id=None, identity_id="idn_1")
        self.assertEqual(self.store.records("tnt_a"), [])
        self.assertEqual(self.recorder.drain_pending(), 1)
        self.assertEqual(len(self.store.records("tnt_a")), 1)
        self.assertTrue(self.store.records("tnt_a")[0].closed)

    def test_retiring_a_stream_closes_every_open_identity_on_it(self):
        self.observe("idn_1", "trk_1", "0s")
        self.observe("idn_2", "trk_2", "0s")
        self.assertEqual(
            self.recorder.retire_stream(tenant_id="tnt_a", camera_id="cam_1", stream_id=None), 2
        )
        self.recorder.drain_pending()
        self.assertEqual(len(self.store.records("tnt_a")), 2)

    def test_two_analyses_of_one_recording_do_not_share_a_history(self):
        """⚠️ ADR-0047: runs are independently queryable. Keyed by stream, not only by camera."""
        for stream in ("run_a", "run_b"):
            self.recorder.observe(
                tenant_id="tnt_a",
                camera_id="cam_1",
                stream_id=stream,
                identity_id="idn_1",
                track_id="trk_1",
                frame_index=0,
                at="0s",
                bbox=(0.1, 0.1, 0.1, 0.1),
            )
        self.assertEqual(len(self.recorder.live_records("tnt_a", "cam_1", "run_a")), 1)
        self.assertEqual(len(self.recorder.live_records("tnt_a", "cam_1", "run_b")), 1)
        self.assertEqual(self.recorder.live_records("tnt_a", "cam_1"), [])

    def test_erasure_clears_the_live_buffer_the_queue_and_the_store_together(self):
        """⛔ An erasure that cleared the archive and left the in-flight paths in memory would answer
        'deleted' while the next frame published them."""
        self.observe("idn_live", "trk_1", "0s")
        self.observe("idn_gone", "trk_2", "0s")
        self.recorder.retire(tenant_id="tnt_a", camera_id="cam_1", stream_id=None, identity_id="idn_gone")
        self.recorder.drain_pending()
        self.observe("idn_pending", "trk_3", "0s")
        self.recorder.retire(tenant_id="tnt_a", camera_id="cam_1", stream_id=None, identity_id="idn_pending")

        removed = self.recorder.forget_tenant("tnt_a")

        self.assertEqual(removed, 3)  # one live, one pending, one stored
        self.assertEqual(self.recorder.live_records("tnt_a", "cam_1"), [])
        self.assertEqual(self.store.records("tnt_a"), [])
        self.assertEqual(self.recorder.drain_pending(), 0)

    def test_annotating_zones_lands_on_the_most_recent_point_only(self):
        self.observe("idn_1", "trk_1", "0s")
        self.observe("idn_1", "trk_1", "1s")
        self.assertTrue(
            self.recorder.annotate_zones(
                tenant_id="tnt_a", camera_id="cam_1", stream_id=None, identity_id="idn_1", zone_ids=["z_1"]
            )
        )
        points = self.recorder.live_records("tnt_a", "cam_1")[0].points
        self.assertEqual(points[0].zone_ids, ())
        self.assertEqual(points[1].zone_ids, ("z_1",))

    def test_annotating_an_unknown_identity_is_false_not_an_exception(self):
        self.assertFalse(
            self.recorder.annotate_zones(
                tenant_id="tnt_a", camera_id="cam_1", stream_id=None, identity_id="idn_nobody", zone_ids=["z"]
            )
        )

    def test_the_identity_buffer_is_bounded_and_the_overflow_is_kept_not_dropped(self):
        recorder = TrackHistoryRecorder(store=self.store, max_identities=2)
        for index in range(4):
            recorder.observe(
                tenant_id="tnt_a",
                camera_id="cam_1",
                stream_id=None,
                identity_id=f"idn_{index}",
                track_id=f"trk_{index}",
                frame_index=index,
                at=f"{index}s",
                bbox=(0.1, 0.1, 0.1, 0.1),
            )
        self.assertEqual(len(recorder.live_records("tnt_a", "cam_1")), 2)
        recorder.drain_pending()
        self.assertEqual(len(self.store.records("tnt_a")), 2)

    def test_stats_report_the_store_so_an_operator_can_see_whether_anything_is_durable(self):
        stats = TrackHistoryRecorder().stats()
        self.assertIs(stats["store"]["durable"], False)
        self.assertEqual(stats["liveIdentities"], 0)


if __name__ == "__main__":
    unittest.main()
