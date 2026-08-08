"""The Behaviour API and the Behaviour Timeline (P-11 slice 2.3) — the read path.

Both are pure functions over the movement paths ADR-0051 made durable, so a test here can author a
history and read back exactly what an investigator would see. Nothing is stored by either.

⛔ **The two claims that matter most, and neither is about a number:**

1. **The read path runs the same modules the live path runs.** If `primitives_for` had its own
   implementation of dwell, Layer 2 would exist twice and drift silently — the failure the whole
   "no Layer 2 in two places" rule exists to prevent.
2. **The timeline explains without accusing.** `kind` is a closed vocabulary and every generated
   sentence is checked against a list of words that name an intent. A timeline that said "concealed"
   would have moved Layer 3 into the runtime, in the one component an investigator reads as neutral.

Deterministic and stdlib-only.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import behaviour_timeline as bt  # noqa: E402
from track_history import (  # noqa: E402
    HistoryPoint,
    InMemoryTrackHistoryStore,
    TrackHistoryRecorder,
    TrackHistoryRecord,
)

TENANT = "tnt_a"
CAMERA = "cam_1"
STREAM = "run_1"

#: ⛔ Words that name a motive rather than a movement. A timeline entry containing one of these has
#: crossed into Layer 3 (ADR-0052) — and it would do so in the component an investigator trusts most.
INTENT_WORDS = (
    "theft",
    "steal",
    "stole",
    "shoplift",
    "conceal",
    "suspicious",
    "intruder",
    "loiter",
    "abandon",
    "attack",
    "fraud",
    "trespass",
)

#: Domain nouns that would tie a primitive to one industry. `dwell` passes the hospital test; `shelf`
#: does not, and neither does `patient`.
DOMAIN_WORDS = ("shelf", "till", "checkout", "patient", "pallet", "merchandise", "customer", "ward")


def point(seq, at, x, y, *, zones=None, track="trk_1", label="person"):
    return HistoryPoint(
        frame_index=seq,
        at=f"{at:g}s",
        bbox=(x, y, 0.08, 0.2),
        track_id=track,
        label=label,
        zone_ids=tuple(zones or ()),
        zones_settled=zones is not None,
    )


def record(identity, points, *, label="person", tracks=None, closed=True, camera=CAMERA):
    return TrackHistoryRecord(
        identity_id=identity,
        tenant_id=TENANT,
        camera_id=camera,
        stream_id=STREAM,
        label=label,
        points=list(points),
        track_ids=list(tracks or ["trk_1"]),
        closed=closed,
    )


def walker(identity="idn_1", *, start=0, count=6, zones_from=None, zones_to=None, x=0.5):
    """One subject standing still, optionally inside a zone for part of the time."""
    points = []
    for index in range(count):
        inside = zones_from is not None and zones_from <= index <= (zones_to if zones_to is not None else count)
        points.append(point(start + index, float(start + index), x, 0.4, zones=["z_a"] if inside else []))
    return record(identity, points)


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.store = InMemoryTrackHistoryStore()
        self.recorder = TrackHistoryRecorder(store=self.store)

    def test_durable_and_live_records_are_returned_with_where_each_came_from(self):
        """⭐ Provenance is returned, not folded in. A finished analysis and one that is 3 % through
        render identically as a record count and mean opposite things about every duration."""
        self.store.write(walker("idn_durable"))
        self.recorder.observe(
            tenant_id=TENANT,
            camera_id=CAMERA,
            stream_id=STREAM,
            identity_id="idn_live",
            track_id="trk_9",
            frame_index=0,
            at="0s",
            bbox=(0.5, 0.4, 0.08, 0.2),
            label="person",
            confidence=0.9,
        )
        records, sources = bt.collect(self.recorder, TENANT, stream_id=STREAM)
        self.assertEqual(sources, {"durable": 1, "live": 1, "records": 2})
        self.assertEqual({r.identity_id for r in records}, {"idn_durable", "idn_live"})

    def test_a_different_analysis_of_the_same_footage_is_not_returned(self):
        """⚠️ ADR-0047 — two runs over one recording are independently queryable, for movement as
        well as for events."""
        other = walker("idn_other")
        other.stream_id = "run_2"
        self.store.write(walker("idn_1"))
        self.store.write(other)
        records, _ = bt.collect(self.recorder, TENANT, stream_id=STREAM)
        self.assertEqual([r.identity_id for r in records], ["idn_1"])

    def test_a_stream_nobody_analysed_returns_nothing_rather_than_everything(self):
        self.store.write(walker("idn_1"))
        records, sources = bt.collect(self.recorder, TENANT, stream_id="run_missing")
        self.assertEqual(records, [])
        self.assertEqual(sources["records"], 0)


class IntervalTests(unittest.TestCase):
    def test_the_frame_interval_is_the_median_so_one_occlusion_cannot_set_it(self):
        """⚠️ The mean would let a single 9-second gap declare a 2 fps stream to be running at
        0.1 fps — which would then hide every other gap in the run."""
        points = [point(i, t, 0.5, 0.4) for i, t in enumerate([0.0, 0.5, 1.0, 1.5, 10.5, 11.0])]
        self.assertAlmostEqual(bt.observed_interval_seconds([record("idn_1", points)]), 0.5, places=4)

    def test_a_single_observation_has_no_measurable_interval(self):
        """⛔ `None`, never a default dressed up as a measurement."""
        self.assertIsNone(bt.observed_interval_seconds([record("idn_1", [point(0, 0.0, 0.5, 0.4)])]))


class PrimitiveReadTests(unittest.TestCase):
    def test_the_read_path_runs_the_same_modules_as_the_live_path(self):
        """⭐ Not a second implementation of Layer 2. The names come from `DEFAULT_MODULES`, and a
        primitive that existed on one path and not the other would be caught here."""
        from behaviour_modules import DEFAULT_MODULES

        out = bt.primitives_for([walker("idn_1")])
        self.assertEqual(out["modules"], [name for name, _ in DEFAULT_MODULES])
        self.assertEqual(out["moduleFailures"], {})
        self.assertIn("motion", out["identities"]["idn_1"])

    def test_dwell_is_recomputed_from_stored_membership(self):
        """⭐ The reason ADR-0053 stores membership at all: a finished analysis can still answer the
        zone question. Before this slice the archive knew where somebody walked and not which zones
        they were in, so every zone primitive was empty for every completed run."""
        out = bt.primitives_for([walker("idn_1", zones_from=1, zones_to=4)])
        zone = out["identities"]["idn_1"]["zone"]["zones"]["z_a"]
        self.assertAlmostEqual(zone["dwellSeconds"], 3.0, places=4)
        self.assertEqual(out["zoneMembership"], "present")

    def test_a_run_with_no_membership_reports_absent_rather_than_zero_dwell(self):
        """The negative control, one level up from the stage's."""
        points = [
            HistoryPoint(frame_index=i, at=f"{i}s", bbox=(0.5, 0.4, 0.08, 0.2), track_id="trk_1")
            for i in range(5)
        ]
        out = bt.primitives_for([record("idn_1", points)])
        self.assertEqual(out["zoneMembership"], "absent")
        self.assertNotIn("zone", out["identities"]["idn_1"])

    def test_an_empty_analysis_produces_nothing_and_does_not_raise(self):
        out = bt.primitives_for([])
        self.assertEqual(out["identities"], {})
        self.assertEqual(out["scene"], [])
        self.assertIsNone(out["observedIntervalSeconds"])

    def test_one_identity_across_two_cameras_is_one_subject(self):
        """⚠️ Grouped by `identityId`, so two records merge. Correct for "what did this person do",
        and the reason each timeline entry names its camera rather than assuming one."""
        first = walker("idn_1", start=0, count=3)
        second = walker("idn_1", start=10, count=3)
        second.camera_id = "cam_2"
        out = bt.primitives_for([first, second])
        self.assertEqual(out["identities"]["idn_1"]["motion"]["samples"], 6)


class TimelineTests(unittest.TestCase):
    def entries(self, records, **kwargs):
        entries, truncated = bt.timeline_for(records, **kwargs)
        self.assertFalse(truncated)
        return [e.to_dict() for e in entries]

    def test_every_kind_emitted_is_in_the_declared_vocabulary(self):
        """⛔ The vocabulary is closed on purpose: a new kind is a decision, and this is what stops
        one arriving unreviewed."""
        subject = walker("idn_1", zones_from=1, zones_to=3)
        other = walker("idn_2", x=0.52)
        obj = record(
            "idn_obj",
            [point(i, float(i), 0.5, 0.4, label="bottle", track="trk_obj") for i in range(6)],
            label="bottle",
            tracks=["trk_obj"],
        )
        kinds = {e["kind"] for e in self.entries([subject, other, obj])}
        self.assertTrue(kinds)
        self.assertTrue(kinds <= set(bt.TIMELINE_KINDS), kinds - set(bt.TIMELINE_KINDS))

    def test_no_kind_and_no_sentence_names_an_intent(self):
        """⛔ ADR-0052 at the surface an investigator reads. Every entry states a geometry or a
        duration; naming a motive is Layer 3's job and nothing here may borrow it."""
        subject = walker("idn_1", zones_from=1, zones_to=3)
        other = walker("idn_2", x=0.52)
        obj = record(
            "idn_obj",
            [point(i, float(i), 0.5, 0.4, label="bottle", track="trk_obj") for i in range(6)],
            label="bottle",
            tracks=["trk_obj"],
        )
        for entry in self.entries([subject, other, obj]):
            text = f"{entry['kind']} {entry['summary']}".lower()
            for word in INTENT_WORDS:
                self.assertNotIn(word, text, f"{word!r} names an intent: {entry['summary']}")

    def test_no_kind_is_tied_to_an_industry(self):
        """⛔ The hospital test, executable. `zoneVisit` passes because a hospital calls it waiting;
        `shelfInteraction` would fail, and its absence is what keeps this layer reusable."""
        for kind in bt.TIMELINE_KINDS:
            for word in DOMAIN_WORDS:
                self.assertNotIn(word, kind.lower())

    def test_a_zone_visit_carries_its_interval_and_says_whether_it_had_ended(self):
        entries = self.entries([walker("idn_1", zones_from=1, zones_to=3)])
        visit = next(e for e in entries if e["kind"] == "zoneVisit")
        self.assertEqual(visit["attributes"]["zoneId"], "z_a")
        self.assertAlmostEqual(visit["atSeconds"], 1.0, places=4)
        self.assertAlmostEqual(visit["endSeconds"], 3.0, places=4)
        self.assertFalse(visit["attributes"]["open"])

    def test_an_open_visit_is_marked_because_its_duration_is_a_lower_bound(self):
        entries = self.entries([walker("idn_1", zones_from=2)])
        visit = next(e for e in entries if e["kind"] == "zoneVisit")
        self.assertTrue(visit["attributes"]["open"])

    def test_entry_and_exit_are_separate_instantaneous_entries(self):
        entries = self.entries([walker("idn_1", zones_from=1, zones_to=3)])
        kinds = [e["kind"] for e in entries if e["kind"] in ("zoneEntry", "zoneExit")]
        self.assertEqual(kinds, ["zoneEntry", "zoneExit"])

    def test_every_entry_points_at_the_frame_that_established_it(self):
        """⚠️ The frame that ESTABLISHED the fact, not the nearest in either direction — a viewer
        sent forwards would be shown the consequence instead of the cause. And `frameIndex` is the
        caller's `frame.seq`, so it joins to the events and the recording."""
        entries = self.entries([walker("idn_1", zones_from=2, zones_to=4)])
        visit = next(e for e in entries if e["kind"] == "zoneVisit")
        self.assertEqual(visit["evidence"]["frameIndex"], 2)
        self.assertEqual(visit["evidence"]["trackId"], "trk_1")

    def test_an_occlusion_is_one_identity_with_a_gap_and_not_two_visitors(self):
        """⛔ The defect ADR-0051 called the most likely in the phase. Two track ids, one identity —
        the timeline must show one subject who was briefly unobserved."""
        points = [point(i, float(i), 0.5, 0.4) for i in range(3)]
        points += [point(i, float(i), 0.5, 0.4, track="trk_2") for i in range(9, 12)]
        entries = self.entries([record("idn_1", points, tracks=["trk_1", "trk_2"])])
        observed = [e for e in entries if e["kind"] == "observed"]
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0]["attributes"]["trackIds"], ["trk_1", "trk_2"])
        gap = next(e for e in entries if e["kind"] == "gap")
        self.assertAlmostEqual(gap["seconds"], 7.0, places=4)

    def test_an_object_travelling_with_a_subject_is_reported_on_the_object(self):
        subject = walker("idn_1", count=6)
        obj = record(
            "idn_obj",
            [point(i, float(i), 0.5, 0.4, label="bottle", track="trk_obj") for i in range(6)],
            label="bottle",
            tracks=["trk_obj"],
        )
        carried = next(e for e in self.entries([subject, obj]) if e["kind"] == "carried")
        self.assertEqual(carried["identityId"], "idn_obj")
        self.assertEqual(carried["attributes"]["heldByIdentityId"], "idn_1")

    def test_proximity_names_the_threshold_it_used(self):
        """⚠️ A proximity fact whose threshold a reader has to guess is a fact they cannot check —
        and normalized units are not metres."""
        import behaviour_primitives as bp

        entries = self.entries([walker("idn_1"), walker("idn_2", x=0.51)])
        near = next(e for e in entries if e["kind"] == "proximity")
        self.assertEqual(near["attributes"]["thresholdNormalized"], bp.NEAR_THRESHOLD)
        self.assertIn("frame widths", near["summary"])

    def test_instants_are_offsets_into_the_run_and_the_footage_clock_is_kept_beside_them(self):
        """⛔ Found on a deployment, not reasoned out. A recording stamped with wall-clock capture
        times gives footage seconds around 1.77e9, and the first timeline said a subject "was
        observed from 1.77109e+09 s to 1.77109e+09 s" — true, useless, and hiding the fifteen seconds
        between. The absolute number stays, because that is what a viewer seeks to."""
        base = 1_771_000_000.0
        points = [
            HistoryPoint(
                frame_index=i,
                at=f"{base + i:.3f}s",
                bbox=(0.5, 0.4, 0.08, 0.2),
                track_id="trk_1",
                zone_ids=("z_a",),
            )
            for i in range(4)
        ]
        entry = next(e for e in self.entries([record("idn_1", points)]) if e["kind"] == "observed")
        self.assertAlmostEqual(entry["atSeconds"], 0.0, places=3)
        self.assertAlmostEqual(entry["endSeconds"], 3.0, places=3)
        self.assertAlmostEqual(entry["footageSeconds"], base, places=3)
        self.assertIn("from 0 s to 3 s", entry["summary"])
        self.assertNotIn("e+", entry["summary"])

    def test_an_empty_run_produces_an_empty_timeline_rather_than_a_placeholder(self):
        """The negative control. Nothing happening reads as nothing."""
        self.assertEqual(self.entries([]), [])

    def test_the_same_history_twice_produces_the_same_document(self):
        """⚠️ A projection used for investigation must be reproducible — an ordering that depended on
        dict iteration would produce two different reports of one event."""
        records = [walker("idn_1", zones_from=1, zones_to=3), walker("idn_2", x=0.52)]
        self.assertEqual(self.entries(records), self.entries(records))

    def test_the_entry_cap_is_reported_rather_than_applied_silently(self):
        """⛔ A read API that could return everything is a read API that can exhaust the runtime —
        and a truncated answer that did not say so would be read as a complete one."""
        records = [walker(f"idn_{i}", count=3, x=0.1 + 0.02 * i) for i in range(12)]
        entries, truncated = bt.timeline_for(records, max_entries=5)
        self.assertEqual(len(entries), 5)
        self.assertTrue(truncated)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
