"""The temporal behaviour graph (slice 2.6) — the third projection of one computation.

⛔ **The claim under test is that there is no second computation.** `graph_for` reads
`timeline_for`'s entries and reshapes them; a graph with its own idea of a zone visit would
eventually disagree with the timeline about one, and an investigator shown both would have no way to
say which was right. The test that matters most here is
`test_every_edge_traces_back_to_a_timeline_entry`.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import behaviour_graph as bg  # noqa: E402
import behaviour_primitives as bp  # noqa: E402
import behaviour_timeline as bt  # noqa: E402
from track_history import HistoryPoint, TrackHistoryRecord  # noqa: E402

TENANT = "tnt_a"
CAMERA = "cam_1"
STREAM = "run_1"


def points(x0, dx, count, *, at=0.0, step=0.5, y=0.4, label="person", zones=None):
    return [
        HistoryPoint(
            frame_index=k,
            at=f"{at + k * step:g}s",
            bbox=(round(x0 + k * dx, 6), y, 0.08, 0.2),
            track_id="trk_1",
            label=label,
            zone_ids=tuple(zones or ()),
            zones_settled=zones is not None,
        )
        for k in range(count)
    ]


def record(identity, pts, *, label="person"):
    return TrackHistoryRecord(
        identity_id=identity,
        tenant_id=TENANT,
        camera_id=CAMERA,
        stream_id=STREAM,
        label=label,
        points=list(pts),
        track_ids=["trk_1"],
        closed=True,
    )


def scene():
    """A person crosses a zone, takes a bottle, carries it and hands it to somebody else."""
    person = points(0.10, 0.02, 20, zones=["z_a"]) + points(0.48, 0.02, 20, at=10.0, zones=["z_a"])
    bottle = points(0.50, 0.0, 20, label="bottle") + points(0.50, 0.02, 20, at=10.0, label="bottle")
    other = points(0.14, 0.02, 40)
    return [record("idn_p", person), record("idn_b", bottle, label="bottle"), record("idn_q", other)]


class GraphShapeTests(unittest.TestCase):
    def setUp(self):
        self.graph = bg.graph_for(scene())
        self.nodes = {n.id: n for n in self.graph.nodes}

    def test_a_person_and_an_object_are_different_kinds_of_node(self):
        self.assertEqual(self.nodes["idn_p"].kind, "identity")
        self.assertEqual(self.nodes["idn_b"].kind, "object")

    def test_a_zone_becomes_a_node_and_the_visit_becomes_an_edge(self):
        """⚠️ The test for what is a node: a person is still a person after they leave the zone."""
        self.assertIn("zone:z_a", self.nodes)
        visits = [e for e in self.graph.edges if e.kind == "visited"]
        self.assertTrue(visits)
        self.assertEqual(visits[0].source, "idn_p")
        self.assertEqual(visits[0].target, "zone:z_a")
        self.assertIsNotNone(visits[0].end_seconds)

    def test_an_identity_node_carries_its_own_trajectory_summary(self):
        attributes = self.nodes["idn_p"].attributes
        for key in ("samples", "durationSeconds", "pathLengthNormalized", "directionDegrees", "cameraId"):
            self.assertIn(key, attributes)

    def test_standing_still_is_a_node_attribute_and_never_a_self_edge(self):
        """⛔ Modelling it as an edge would make 'who did this person interact with' answer
        'themselves' for everybody who ever paused."""
        still = [record("idn_s", points(0.5, 0.0, 60))]

        graph = bg.graph_for(still)
        node = next(n for n in graph.nodes if n.id == "idn_s")

        self.assertIn("linger", node.attributes)
        self.assertGreater(node.attributes["linger"]["seconds"], 0.0)
        self.assertEqual([e for e in graph.edges if e.source == e.target], [])

    def test_a_group_is_a_node_because_it_belongs_to_none_of_its_members(self):
        """⚠️ An edge per pair would turn one three-person conversation into three edges."""
        together = [
            record("idn_1", points(0.20, 0.02, 30)),
            record("idn_2", points(0.80, -0.02, 30)),
        ]

        graph = bg.graph_for(together)
        groups = [n for n in graph.nodes if n.kind == "group"]

        self.assertTrue(groups)
        self.assertEqual(sorted(groups[0].attributes["identityIds"]), ["idn_1", "idn_2"])
        members = [e for e in graph.edges if e.kind == "member" and e.target == groups[0].id]
        self.assertEqual(len(members), 2)

    def test_following_points_from_the_follower_to_the_leader(self):
        """⛔ Direction is a claim. Reversing it accuses the wrong person."""
        chase = [
            record("idn_lead", points(0.30, 0.02, 30)),
            record("idn_back", points(0.20, 0.02, 30)),
        ]

        graph = bg.graph_for(chase)
        follows = [e for e in graph.edges if e.kind == "followed"]

        self.assertEqual(len(follows), 1)
        self.assertEqual((follows[0].source, follows[0].target), ("idn_back", "idn_lead"))

    def test_carrying_points_from_the_object_to_the_person(self):
        carried = [e for e in self.graph.edges if e.kind == "carried"]

        self.assertTrue(carried)
        self.assertEqual(carried[0].source, "idn_b")
        self.assertIn(carried[0].target, ("idn_p", "idn_q"))

    def test_picking_up_and_putting_down_become_edges(self):
        kinds = {e.kind for e in self.graph.edges}

        self.assertIn("picked", kinds)
        self.assertIn("dropped", kinds)


class GraphProvenanceTests(unittest.TestCase):
    def test_every_edge_traces_back_to_a_timeline_entry(self):
        """⭐ **The claim the whole design rests on.** Every edge must be explainable by a fact the
        timeline already stated at the same instant — otherwise the graph knows something the
        timeline does not, and the two can disagree about one investigation."""
        records = scene()
        graph = bg.graph_for(records)
        entries = bt.timeline_for(records, max_entries=bg.GRAPH_SOURCE_ENTRIES).entries
        instants = {round(e.at_seconds, 3) for e in entries}

        self.assertTrue(graph.edges)
        for edge in graph.edges:
            self.assertIn(round(edge.at_seconds, 3), instants, f"{edge.kind} edge invented an instant")

    def test_every_edge_cites_a_frame_an_investigator_can_seek_to(self):
        """⛔ An edge nobody can look at is an assertion."""
        graph = bg.graph_for(scene())

        for edge in graph.edges:
            self.assertIn("frameIndex", edge.evidence, f"{edge.kind} edge cites no frame")

    def test_the_same_history_twice_produces_the_same_graph(self):
        records = scene()

        self.assertEqual(bg.graph_for(records).to_dict(), bg.graph_for(records).to_dict())

    def test_an_empty_history_is_an_empty_graph_rather_than_an_error(self):
        """The negative control. Nothing happening reads as nothing."""
        graph = bg.graph_for([])

        self.assertEqual(graph.nodes, [])
        self.assertEqual(graph.edges, [])
        self.assertFalse(graph.to_dict()["truncated"]["relational"])


class GraphBoundsTests(unittest.TestCase):
    def test_the_node_and_edge_caps_are_reported_rather_than_applied_silently(self):
        records = [record(f"idn_{i:03d}", points(0.05 + 0.01 * i, 0.01, 20)) for i in range(20)]

        graph = bg.graph_for(records, max_nodes=3, max_edges=2)

        self.assertEqual(len(graph.nodes), 3)
        self.assertEqual(len(graph.edges), 2)
        self.assertTrue(graph.nodes_truncated)
        self.assertTrue(graph.edges_truncated)

    def test_a_capped_scene_is_reported_because_the_graph_looks_whole_without_it(self):
        """⛔ The dangerous truncation: past the cap the pairwise families never ran, so the graph
        renders completely and simply has no `near`, `followed` or group in it."""
        crowd = [record(f"idn_{i:03d}", points(0.05 + 0.005 * i, 0.005, 20)) for i in range(40)]

        graph = bg.graph_for(crowd)

        self.assertTrue(graph.relational_truncated)
        self.assertEqual(graph.identities_considered, bp.MAX_RELATIONAL_IDENTITIES)
        self.assertEqual(graph.to_dict()["truncated"]["maxIdentities"], bp.MAX_RELATIONAL_IDENTITIES)

    def test_the_dictionary_form_counts_what_it_contains(self):
        graph = bg.graph_for(scene())
        counts = graph.to_dict()["counts"]

        self.assertEqual(counts["nodes"], len(graph.nodes))
        self.assertEqual(counts["edges"], len(graph.edges))
        self.assertEqual(sum(counts["byNodeKind"].values()), len(graph.nodes))


class GraphNeutralityTests(unittest.TestCase):
    def test_no_node_or_edge_kind_names_an_intent(self):
        """⛔ ADR-0052 at the surface an investigator will click on."""
        graph = bg.graph_for(scene())
        forbidden = ("theft", "steal", "conceal", "suspicious", "loiter", "intruder", "shoplift")

        for kind in {n.kind for n in graph.nodes} | {e.kind for e in graph.edges}:
            for word in forbidden:
                self.assertNotIn(word, kind.lower())

    def test_no_kind_is_tied_to_one_industry(self):
        graph = bg.graph_for(scene())

        for kind in {n.kind for n in graph.nodes} | {e.kind for e in graph.edges}:
            for word in ("shelf", "till", "checkout", "patient", "pallet", "customer", "ward"):
                self.assertNotIn(word, kind.lower())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
