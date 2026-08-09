"""The temporal behaviour graph (Phase 2.4 slice 2.6) — the same facts, shaped for questions.

    track history ──▶ timeline entries ──▶ NODES and EDGES

⭐ **The graph is a reshaping of the timeline, not a second computation.** `graph_for` calls
`timeline_for` and projects its entries; it never touches a primitive directly. That is the whole
design, and it is worth more than any structure below: a graph with its own idea of what a zone visit
is would eventually disagree with the timeline about one, and an investigator shown both would have
no way to say which was right. One place decides what happened; two places render it.

⚠️ **Nothing is stored.** Like the timeline and the primitives, this is a pure function over the
movement paths ADR-0051 made durable, so a corrected formula fixes history rather than being unable
to reach it.

### What is a node and what is an edge

A **node** is a thing that persists: an identity, an object, a zone, a group. An **edge** is
something that happened *between* two of them, over an interval. The test is whether the fact
survives its own endpoints — a person is still a person after they leave the zone, so `identity` and
`zone` are nodes and `visited` is the edge.

⛔ **Facts a subject has entirely to themselves are node attributes, not self-edges.** Standing still
is something one identity did; modelling it as an edge from a node to itself would make every
"who did this person interact with" query answer "themselves". `idle`, `linger`, speed, heading and
duration are therefore attributes of the identity node.

⚠️ **A group is a node because a merge names several identities and belongs to none of them.** The
alternative — an edge per pair — turns one three-person conversation into three edges and makes
"how many groups formed" unanswerable without deduplicating them again.

Stdlib-only, pure, deterministic. No clock, no I/O, no model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import behaviour_primitives as bp
import behaviour_timeline as bt
from track_history import TrackHistoryRecord

#: Entries drawn from the timeline before projection. ⚠️ Deliberately larger than
#: `bt.DEFAULT_MAX_ENTRIES`: the graph's own bounds are on nodes and edges, and taking the timeline's
#: display cap would silently drop the *last* facts of a long run — the ones a summary most needs.
GRAPH_SOURCE_ENTRIES = 20000

#: Bounds on the answer itself, reported whenever they bite. A read API that could return everything
#: is a read API that can be used to exhaust the runtime.
DEFAULT_MAX_NODES = 500
DEFAULT_MAX_EDGES = 4000

#: Timeline kinds that describe one identity alone — folded into that identity's node.
_SELF_KINDS = ("idle", "linger")

#: `kind → (edge kind, which end the entry's identity is)`. ⚠️ Direction is a claim: `followed`
#: points from the follower to the leader, and reversing it would accuse the wrong person.
_PAIR_EDGES: Dict[str, Tuple[str, str]] = {
    "proximity": ("near", "withIdentityId"),
    "follow": ("followed", "leaderIdentityId"),
    "approach": ("approached", "withIdentityId"),
    "recede": ("receded", "withIdentityId"),
}

#: Object-event kinds that become an edge between the object and the subject involved.
_OBJECT_EDGES = {
    "picked": "picked",
    "dropped": "dropped",
    "objectMissing": "wentMissing",
    "objectReturned": "returned",
}


@dataclass(frozen=True)
class GraphNode:
    """A thing that persists across the facts told about it."""

    id: str
    #: `identity` · `object` · `zone` · `group` · `line`
    kind: str
    label: str
    attributes: Mapping[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "label": self.label, "attributes": dict(self.attributes)}


@dataclass(frozen=True)
class GraphEdge:
    """Something that happened between two nodes, over an interval of footage time."""

    id: str
    kind: str
    source: str
    target: str
    at_seconds: float
    end_seconds: Optional[float] = None
    attributes: Mapping[str, object] = field(default_factory=dict)
    #: The frame this came from, carried through from the timeline entry that produced it.
    #: ⛔ Every edge must be seekable. An edge an investigator cannot look at is an assertion.
    evidence: Mapping[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        out: dict = {
            "id": self.id,
            "kind": self.kind,
            "source": self.source,
            "target": self.target,
            "atSeconds": round(self.at_seconds, 4),
            "attributes": dict(self.attributes),
            "evidence": dict(self.evidence),
        }
        if self.end_seconds is not None:
            out["endSeconds"] = round(self.end_seconds, 4)
            out["seconds"] = round(self.end_seconds - self.at_seconds, 4)
        return out


@dataclass(frozen=True)
class BehaviourGraph:
    """Nodes, edges, and everything that was left out of them."""

    nodes: List[GraphNode]
    edges: List[GraphEdge]
    #: ⛔ Three independent ways this answer can be incomplete, reported separately because they mean
    #: different things — the same discipline `TimelineResult` follows.
    nodes_truncated: bool = False
    edges_truncated: bool = False
    relational_truncated: bool = False
    identities_considered: int = 0

    def to_dict(self) -> dict:
        return {
            "nodes": [n.to_dict() for n in self.nodes],
            "edges": [e.to_dict() for e in self.edges],
            "counts": {
                "nodes": len(self.nodes),
                "edges": len(self.edges),
                "byNodeKind": _tally(n.kind for n in self.nodes),
                "byEdgeKind": _tally(e.kind for e in self.edges),
            },
            "truncated": {
                "nodes": self.nodes_truncated,
                "edges": self.edges_truncated,
                # ⛔ The dangerous one: past the cap the pairwise families never ran, so the graph
                # looks whole and simply has no `near`, `followed` or group in it.
                "relational": self.relational_truncated,
                "identitiesConsidered": self.identities_considered,
                "maxIdentities": bp.MAX_RELATIONAL_IDENTITIES,
            },
        }


def graph_for(
    records: Sequence[TrackHistoryRecord],
    *,
    subject_labels: Sequence[str] = bt.DEFAULT_SUBJECT_LABELS,
    lines: Sequence[bp.Line] = (),
    max_nodes: int = DEFAULT_MAX_NODES,
    max_edges: int = DEFAULT_MAX_EDGES,
) -> BehaviourGraph:
    """Every identity, what it visited, what it carried, and who it was with.

    ⭐ Built from `timeline_for`'s entries and nothing else — see the module docstring on why that
    matters more than any of the structure here.
    """
    result = bt.timeline_for(
        records, subject_labels=subject_labels, lines=lines, max_entries=GRAPH_SOURCE_ENTRIES
    )
    label_of = {record.identity_id: record.label for record in records}
    subjects = frozenset(subject_labels)

    nodes: Dict[str, GraphNode] = {}
    edges: List[GraphEdge] = []

    def node(node_id: str, kind: str, label: str, **attributes) -> None:
        existing = nodes.get(node_id)
        if existing is None:
            nodes[node_id] = GraphNode(node_id, kind, label, attributes)
            return
        merged = dict(existing.attributes)
        merged.update({k: v for k, v in attributes.items() if v is not None})
        nodes[node_id] = GraphNode(node_id, existing.kind, existing.label, merged)

    def identity_node(identity: str) -> str:
        label = label_of.get(identity, "person")
        kind = "identity" if label in subjects else "object"
        node(identity, kind, label)
        return identity

    def edge(kind: str, source: str, target: str, entry, **attributes) -> None:
        edges.append(
            GraphEdge(
                id=f"{kind}:{source}:{target}:{round(entry.at_seconds, 3)}",
                kind=kind,
                source=source,
                target=target,
                at_seconds=entry.at_seconds,
                end_seconds=entry.end_seconds,
                attributes=attributes,
                evidence=dict(entry.evidence),
            )
        )

    for entry in result.entries:
        attributes = dict(entry.attributes)
        identity = entry.identity_id

        if entry.kind == "observed":
            identity_node(identity)
            node(
                identity,
                "identity",
                str(attributes.get("label", "person")),
                cameraId=entry.camera_id,
                streamId=entry.stream_id,
                firstSeconds=round(entry.at_seconds, 4),
                lastSeconds=None if entry.end_seconds is None else round(entry.end_seconds, 4),
                durationSeconds=(
                    None if entry.end_seconds is None else round(entry.end_seconds - entry.at_seconds, 4)
                ),
                samples=attributes.get("samples"),
                trackIds=attributes.get("trackIds"),
                pathLengthNormalized=attributes.get("pathLengthNormalized"),
                speedNormalizedPerSecond=attributes.get("speedNormalizedPerSecond"),
                directionDegrees=attributes.get("directionDegrees"),
            )
            continue

        if entry.kind in _SELF_KINDS:
            # ⛔ A node attribute, never a self-edge — see the module docstring.
            identity_node(identity)
            current = dict(nodes[identity].attributes)
            bucket = dict(current.get(entry.kind, {"episodes": 0, "seconds": 0.0}))
            bucket["episodes"] = int(bucket["episodes"]) + 1
            bucket["seconds"] = round(
                float(bucket["seconds"]) + float(attributes.get("seconds", 0.0) or 0.0), 4
            )
            bucket["reading"] = attributes.get("reading")
            node(identity, nodes[identity].kind, nodes[identity].label, **{entry.kind: bucket})
            continue

        if entry.kind == "gap":
            identity_node(identity)
            current = dict(nodes[identity].attributes)
            node(
                identity,
                nodes[identity].kind,
                nodes[identity].label,
                observationGaps=int(current.get("observationGaps", 0) or 0) + 1,
            )
            continue

        if entry.kind == "zoneVisit":
            zone_id = str(attributes.get("zoneId"))
            identity_node(identity)
            node(f"zone:{zone_id}", "zone", zone_id, zoneId=zone_id)
            edge(
                "visited",
                identity,
                f"zone:{zone_id}",
                entry,
                zoneId=zone_id,
                seconds=attributes.get("seconds"),
                open=attributes.get("open"),
            )
            continue

        if entry.kind == "lineCross":
            line_id = str(attributes.get("lineId"))
            identity_node(identity)
            node(f"line:{line_id}", "line", line_id, lineId=line_id)
            edge(
                "crossed",
                identity,
                f"line:{line_id}",
                entry,
                fromSide=attributes.get("fromSide"),
                toSide=attributes.get("toSide"),
            )
            continue

        if entry.kind == "carried":
            holder = str(attributes.get("heldByIdentityId"))
            identity_node(identity)
            identity_node(holder)
            # ⚠️ Object → subject, because the statement is about the object. "What did this person
            # carry" is an incoming-edge query; "who carried this" is outgoing. Both work; only one
            # direction can be the stored one, and this is the one the fact is phrased in.
            edge("carried", identity, holder, entry, seconds=attributes.get("seconds"), open=attributes.get("open"))
            continue

        if entry.kind in _OBJECT_EDGES:
            subject = attributes.get("subjectIdentityId")
            identity_node(identity)
            if isinstance(subject, str):
                identity_node(subject)
                edge(_OBJECT_EDGES[entry.kind], identity, subject, entry, seconds=attributes.get("seconds"))
            else:
                # ⛔ An object that went missing while with nobody still gets the fact, as a
                # self-referential edge to its own node — dropping it would lose the moment entirely.
                edge(_OBJECT_EDGES[entry.kind], identity, identity, entry, seconds=attributes.get("seconds"))
            continue

        if entry.kind == "handover":
            giver, taker = attributes.get("fromIdentityId"), attributes.get("toIdentityId")
            if isinstance(giver, str) and isinstance(taker, str):
                identity_node(identity)
                identity_node(giver)
                identity_node(taker)
                edge("handedOver", giver, taker, entry, objectIdentityId=identity)
            continue

        if entry.kind in _PAIR_EDGES:
            edge_kind, other_key = _PAIR_EDGES[entry.kind]
            other = attributes.get(other_key)
            if not isinstance(other, str):
                continue
            identity_node(identity)
            identity_node(other)
            edge(
                edge_kind,
                identity,
                other,
                entry,
                **{k: v for k, v in attributes.items() if k != other_key},
            )
            continue

        if entry.kind in ("groupMerge", "groupSplit", "queue"):
            members = attributes.get("identityIds")
            if not isinstance(members, list) or not members:
                continue
            group_id = f"group:{entry.kind}:{round(entry.at_seconds, 3)}:{'+'.join(str(m) for m in members)}"
            node(
                group_id,
                "group",
                entry.kind,
                event=entry.kind,
                identityIds=list(members),
                atSeconds=round(entry.at_seconds, 4),
                seconds=attributes.get("seconds"),
                linearity=attributes.get("linearity"),
                reading=attributes.get("reading"),
            )
            for member in members:
                identity_node(str(member))
                edge("member", str(member), group_id, entry, event=entry.kind)
            continue

    ordered_nodes = sorted(nodes.values(), key=lambda n: (_NODE_ORDER.get(n.kind, 9), n.id))
    edges.sort(key=lambda e: (e.at_seconds, e.kind, e.source, e.target))
    return BehaviourGraph(
        nodes=ordered_nodes[:max_nodes],
        edges=edges[:max_edges],
        nodes_truncated=len(ordered_nodes) > max_nodes,
        edges_truncated=len(edges) > max_edges,
        relational_truncated=result.relational_truncated,
        identities_considered=result.identities_considered,
    )


#: Identities first: a viewer that lays out nodes in order should put the subjects of the
#: investigation before the places they went.
_NODE_ORDER = {"identity": 0, "object": 1, "group": 2, "zone": 3, "line": 4}


def _tally(values) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for value in values:
        out[value] = out.get(value, 0) + 1
    return dict(sorted(out.items()))
