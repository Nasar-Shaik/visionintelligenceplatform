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


class PublishedReadingTests(unittest.TestCase):
    """⭐ **The thresholds every business word was computed at, published with the answer.**

    ⛔ A kind with no reading renders in the console's Primitive Inspector as *"not parameterised"* —
    which is a claim that no threshold decided it. That was true of `proximity` and `gap` for three
    slices, and it is the opposite of the truth for both: "was near" means *within 0.15 of the frame
    for at least 2 s*, and "was not observed" means *2.5× the run's own sampling interval*. Found in a
    browser run against the deployment; this test is why it cannot come back quietly.
    """

    #: ⚠️ The two kinds that genuinely have no parameter of their own, named rather than defaulted.
    #: `observed` is first-to-last observation; `zoneVisit` walks membership an upstream supplied.
    #: A new kind landing here silently is exactly what this test exists to prevent.
    UNPARAMETERISED = {"observed", "zoneVisit"}

    #: The timeline's word → the readings table's word. Mirrors `READING_OF_KIND` in the console.
    READING_OF_KIND = {
        "gap": "gap",
        "proximity": "proximity",
        "idle": "idle",
        "linger": "linger",
        "queue": "queue",
        "follow": "follow",
        "approach": "approach",
        "recede": "recede",
        "groupMerge": "group_merge",
        "groupSplit": "group_split",
        "lineCross": "cross_line",
        "zoneEntry": "enter_zone",
        "zoneExit": "exit_zone",
        "carried": "carry_object",
        "picked": "pick_object",
        "dropped": "drop_object",
        "objectMissing": "object_missing",
        "objectReturned": "object_returned",
        "handover": "handover",
    }

    def test_every_timeline_kind_either_has_a_reading_or_is_declared_unparameterised(self):
        for kind in bt.TIMELINE_KINDS:
            if kind in self.UNPARAMETERISED:
                self.assertNotIn(kind, self.READING_OF_KIND, f"{kind} is both mapped and declared unparameterised")
                continue
            name = self.READING_OF_KIND.get(kind)
            self.assertIsNotNone(name, f"{kind} has no published reading and is not declared unparameterised")
            self.assertIn(name, bt.bp.PRIMITIVE_READINGS, f"{kind} maps to {name!r}, which is not in PRIMITIVE_READINGS")

    def test_every_reading_names_its_mechanism_and_what_it_means(self):
        for name, reading in bt.bp.PRIMITIVE_READINGS.items():
            self.assertTrue(reading.get("mechanism"), f"{name} publishes no mechanism")
            self.assertTrue(reading.get("means"), f"{name} publishes no plain-English meaning")

    def test_the_published_group_threshold_is_the_one_the_code_applies(self):
        """⛔ A published threshold that has drifted from the applied one is worse than none: an
        operator defending a finding quotes a figure nothing measured. Import fails on drift; this
        asserts the guard's subject rather than its mechanism."""
        for name in ("proximity", "group_merge", "group_split", "queue"):
            self.assertEqual(bt.bp.PRIMITIVE_READINGS[name]["thresholdNormalized"], bt.bp.GROUP_THRESHOLD)

    def test_the_gap_reading_publishes_a_factor_rather_than_an_absolute(self):
        """⚠️ A gap is relative to the run's own sampling rate — an analysis at 2 fps and one at 8 fps
        call very different silences a gap, so one absolute figure would be wrong for every run but
        one."""
        gap = bt.bp.PRIMITIVE_READINGS["gap"]
        self.assertEqual(gap["expectedIntervalFactor"], 2.5)
        self.assertNotIn("minSeconds", gap)


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


def stander(identity, x, count, *, at=0.0, step=0.5, y=0.4):
    return record(identity, [point(i, at + i * step, x, y) for i in range(count)])


def strider(identity, x0, dx, count, *, at=0.0, step=0.5, y=0.4):
    return record(identity, [point(i, at + i * step, round(x0 + i * dx, 6), y) for i in range(count)])


class Slice25TimelineTests(unittest.TestCase):
    """The primitives that need only tracked identities, as an investigator reads them."""

    def entries(self, records, **kwargs):
        found, _ = bt.timeline_for(records, **kwargs)
        return [e.to_dict() for e in found]

    def kinds(self, records, **kwargs):
        return {e["kind"] for e in self.entries(records, **kwargs)}

    def test_standing_still_appears_as_both_idle_and_linger(self):
        found = self.kinds([stander("idn_1", 0.5, 60)])

        self.assertIn("idle", found)
        self.assertIn("linger", found)

    def test_every_stay_carries_the_definition_that_produced_the_word(self):
        """⭐ An investigator reading 'lingered for 29 s' can see what lingering meant here, without
        reading the source. The same numbers a rule author picks a threshold against."""
        entry = next(e for e in self.entries([stander("idn_1", 0.5, 60)]) if e["kind"] == "linger")

        self.assertEqual(entry["attributes"]["reading"]["mechanism"], "stationary_episodes")
        self.assertIn("radiusNormalized", entry["attributes"]["reading"])

    def test_a_subject_who_walks_straight_through_never_lingers(self):
        """The negative control for the whole presence family."""
        found = self.kinds([strider("idn_1", 0.05, 0.03, 30)])

        self.assertNotIn("idle", found)
        self.assertNotIn("linger", found)

    def test_two_subjects_meeting_and_parting_produce_a_merge_and_a_split(self):
        found = self.kinds([strider("idn_1", 0.20, 0.02, 30), strider("idn_2", 0.80, -0.02, 30)])

        self.assertIn("groupMerge", found)
        self.assertIn("groupSplit", found)
        self.assertIn("approach", found)
        self.assertIn("recede", found)

    def test_a_group_entry_names_every_member_because_it_belongs_to_none_of_them(self):
        """⛔ A reader filtering by one identity must still find the merge they were part of, and one
        merge must not render as three events."""
        entry = next(
            e
            for e in self.entries([strider("idn_1", 0.20, 0.02, 30), strider("idn_2", 0.80, -0.02, 30)])
            if e["kind"] == "groupMerge"
        )

        self.assertEqual(entry["attributes"]["identityIds"], ["idn_1", "idn_2"])
        self.assertEqual(entry["identityId"], "idn_1")

    def test_subjects_waiting_together_appear_as_a_queue_with_its_linearity(self):
        found = self.entries(
            [stander("idn_1", 0.40, 40), stander("idn_2", 0.50, 40), stander("idn_3", 0.60, 40)]
        )
        queue = next(e for e in found if e["kind"] == "queue")

        self.assertEqual(queue["attributes"]["identityIds"], ["idn_1", "idn_2", "idn_3"])
        self.assertIn("linearity", queue["attributes"])
        self.assertGreaterEqual(queue["seconds"], 8.0)

    def test_one_subject_walking_behind_another_appears_as_following(self):
        found = self.entries([strider("idn_lead", 0.30, 0.02, 30), strider("idn_back", 0.20, 0.02, 30)])
        follows = [e for e in found if e["kind"] == "follow"]

        self.assertEqual(len(follows), 1)
        self.assertEqual(follows[0]["identityId"], "idn_back")
        self.assertEqual(follows[0]["attributes"]["leaderIdentityId"], "idn_lead")

    def test_a_line_crossing_appears_only_when_the_line_geometry_was_supplied(self):
        """⛔ No line reached the read, so the answer is silence rather than 'nobody crossed'.

        Track history stores membership, and a polyline has none — so the geometry cannot be
        recovered from it. `lineGeometry` on the primitives read is what says which of the two
        empties a caller is looking at.
        """
        crossing_walk = [strider("idn_1", 0.30, 0.03, 20)]
        line = bt.bp.Line("ln_door", [(0.5, 0.0), (0.5, 1.0)])

        self.assertNotIn("lineCross", self.kinds(crossing_walk))
        self.assertIn("lineCross", self.kinds(crossing_walk, lines=(line,)))

    def test_the_primitives_read_says_whether_any_line_geometry_reached_it(self):
        read = bt.primitives_for([strider("idn_1", 0.30, 0.03, 20)])

        self.assertEqual(read["lineGeometry"], "absent")
        self.assertEqual(
            bt.primitives_for(
                [strider("idn_1", 0.30, 0.03, 20)],
                lines=(bt.bp.Line("ln_door", [(0.5, 0.0), (0.5, 1.0)]),),
            )["lineGeometry"],
            "present",
        )

    def test_the_primitives_read_publishes_the_thresholds_every_word_was_computed_at(self):
        read = bt.primitives_for([stander("idn_1", 0.5, 60)])

        for name in ("idle", "linger", "queue", "follow", "cross_line", "enter_zone"):
            self.assertIn(name, read["readings"])

    def test_every_new_kind_is_in_the_closed_vocabulary(self):
        """⛔ A kind reaching a viewer that the viewer has never heard of is a rendering bug in
        production. The vocabulary is published on the read for exactly this reason."""
        busy = [
            stander("idn_1", 0.40, 40),
            stander("idn_2", 0.50, 40),
            strider("idn_3", 0.20, 0.02, 30),
            strider("idn_4", 0.10, 0.02, 30),
        ]
        line = bt.bp.Line("ln_door", [(0.35, 0.0), (0.35, 1.0)])

        found = self.kinds(busy, lines=(line,))

        self.assertTrue(found)
        self.assertTrue(found <= set(bt.TIMELINE_KINDS), found - set(bt.TIMELINE_KINDS))

    def test_no_new_sentence_names_an_intent(self):
        """⛔ ADR-0052 over the slice-2.5 vocabulary. `follow` states a geometry and a distance;
        the word this must never reach is `tailing`, and `linger` must never become `loiter`."""
        busy = [
            stander("idn_1", 0.40, 40),
            stander("idn_2", 0.50, 40),
            strider("idn_3", 0.20, 0.02, 30),
            strider("idn_4", 0.10, 0.02, 30),
        ]

        for entry in self.entries(busy, lines=(bt.bp.Line("ln_1", [(0.35, 0.0), (0.35, 1.0)]),)):
            text = f"{entry['kind']} {entry['summary']}".lower()
            for word in INTENT_WORDS + ("tailing", "tailgate", "following behind suspiciously"):
                self.assertNotIn(word, text, f"{word!r} names an intent: {entry['summary']}")

    def test_an_empty_scene_still_produces_nothing(self):
        """The negative control, restated for the new primitives: eight modules over no history must
        agree that nothing happened."""
        self.assertEqual(self.entries([]), [])

    def test_the_same_busy_history_twice_produces_the_same_document(self):
        busy = [
            stander("idn_1", 0.40, 40),
            stander("idn_2", 0.50, 40),
            strider("idn_3", 0.20, 0.02, 30),
        ]

        self.assertEqual(self.entries(busy), self.entries(busy))


class Slice28KindFilterTests(unittest.TestCase):
    """⛔ **Narrowing before the cap, because a reader cannot filter its way back to a dropped fact.**

    Measured on a live camera: 1207 of the 2000 entries the cap allowed were `gap`, so every merge,
    queue and crossing later in the run had been cut to make room for facts about nobody being there
    — and the list looked complete. These tests hold the two properties that fix it: the count is
    taken over everything, and the filter runs before the slice.
    """

    def busy(self):
        return [stander("idn_1", 0.40, 40), stander("idn_2", 0.50, 40), strider("idn_3", 0.20, 0.02, 30)]

    def test_counts_by_kind_covers_the_whole_run(self):
        result = bt.timeline_for(self.busy())

        self.assertGreater(len(result.counts_by_kind), 1)
        self.assertEqual(sum(result.counts_by_kind.values()), len(result.entries))
        self.assertIn("observed", result.counts_by_kind)

    def test_the_filter_narrows_the_entries_and_leaves_the_counts_alone(self):
        everything = bt.timeline_for(self.busy())
        only_idle = bt.timeline_for(self.busy(), kinds=["idle"])

        self.assertTrue(only_idle.entries)
        self.assertEqual({e.kind for e in only_idle.entries}, {"idle"})
        # ⭐ The counts still describe the run, not the filtered answer — that is what makes the
        # excluded facts visible rather than merely absent.
        self.assertEqual(only_idle.counts_by_kind, everything.counts_by_kind)
        self.assertEqual(only_idle.kinds_requested, ("idle",))
        self.assertEqual(
            only_idle.excluded_by_kind, len(everything.entries) - len(only_idle.entries)
        )

    def test_the_filter_runs_before_the_cap(self):
        """⛔ The whole point. With a cap of 2 and the noisy kind first in time, an unfiltered read
        returns two `observed` entries and nothing else; a filtered read returns the two `idle`
        facts that an unfiltered read would have displaced."""
        records = self.busy()

        unfiltered = bt.timeline_for(records, max_entries=2)
        self.assertTrue(unfiltered.truncated)
        self.assertNotIn("idle", {e.kind for e in unfiltered.entries})

        filtered = bt.timeline_for(records, max_entries=2, kinds=["idle"])
        self.assertEqual({e.kind for e in filtered.entries}, {"idle"})

    def test_an_unknown_kind_returns_nothing_and_says_what_was_asked(self):
        # ⚠️ Echoed rather than silently ignored: a caller who mistyped a kind sees an empty list
        # either way, and only this tells them which of the two empties they are looking at.
        result = bt.timeline_for(self.busy(), kinds=["loitering"])

        self.assertEqual(result.entries, [])
        self.assertEqual(result.kinds_requested, ("loitering",))
        self.assertGreater(result.excluded_by_kind, 0)

    def test_no_filter_is_not_an_empty_filter(self):
        """⚠️ `kinds=[]` and `kinds=None` must both mean "everything". An empty list read as an
        empty filter would return nothing for a caller who cleared their selection."""
        for empty in (None, [], ()):
            result = bt.timeline_for(self.busy(), kinds=empty)
            self.assertTrue(result.entries, f"{empty!r} returned nothing")
            self.assertEqual(result.kinds_requested, ())
            self.assertEqual(result.excluded_by_kind, 0)

    def test_the_old_tuple_unpacking_still_works(self):
        entries, truncated = bt.timeline_for(self.busy())
        self.assertTrue(entries)
        self.assertFalse(truncated)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
