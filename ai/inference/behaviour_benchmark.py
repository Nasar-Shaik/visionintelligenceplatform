"""Behaviour read-path benchmark (P-11 slice 2.5) — what one Behaviour API answer costs.

    python3 -B behaviour_benchmark.py
    python3 -B behaviour_benchmark.py --json bench.json

⛔ **This exists because slice 2.5 shipped a 43-second read and nothing failed.** Four pairwise
primitive families arrived — following, distance change, grouping, waiting together — and every one
of them walked every pair while recomputing, inside that walk, work that belongs to one identity.
Every unit test passed throughout: they each author two or three identities, where n² is 4.

⭐ **Two corpora, and the difference between them is the whole point.**

- `crowded` — every identity present in every frame, which is the worst case the cap exists for.
- `arriving` — identities that come and go over the run, which is what a real hour of footage is.
  Most pairs never share an instant, so `Scene.pairs` prunes them for free, and the cost is nothing
  like the crowded case at the same identity count.

Reporting only the first would make the platform look slower than it is; reporting only the second
would hide the case an adversary can construct. ⚠️ Wall-clock on one host — a *comparison* between
builds on the same machine, never a budget. The deterministic guard is in
`tests/test_behaviour_primitives.py`, which counts operations instead of seconds.

Stdlib-only. Deterministic input; only the timings vary.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from typing import Dict, List, Optional

import behaviour_timeline as bt
from track_history import HistoryPoint, TrackHistoryRecord

TENANT = "tnt_bench"
CAMERA = "cam_bench"
STREAM = "run_bench"


def _record(identity: str, points: List[HistoryPoint]) -> TrackHistoryRecord:
    return TrackHistoryRecord(
        identity_id=identity,
        tenant_id=TENANT,
        camera_id=CAMERA,
        stream_id=STREAM,
        label="person",
        points=points,
        track_ids=[f"trk_{identity}"],
        closed=True,
    )


def _walk(identity: str, x0: float, dx: float, count: int, *, first: int = 0, step: float = 0.5):
    return _record(
        identity,
        [
            HistoryPoint(
                frame_index=first + k,
                at=f"{(first + k) * step:g}s",
                bbox=(round(x0 + k * dx, 6), 0.40, 0.08, 0.20),
                track_id=f"trk_{identity}",
                label="person",
            )
            for k in range(count)
        ],
    )


def crowded(identities: int, frames: int) -> List[TrackHistoryRecord]:
    """Everybody in shot for the whole run — the case `MAX_RELATIONAL_IDENTITIES` bounds."""
    return [
        _walk(f"idn_{i:03d}", 0.05 + 0.008 * i, 0.002, frames) for i in range(identities)
    ]


def arriving(identities: int, frames: int, *, dwell: int = 40) -> List[TrackHistoryRecord]:
    """People arriving and leaving across the run — what an hour of real footage looks like.

    ⚠️ Each identity is present for `dwell` frames out of `frames`, staggered evenly. At 98
    identities over 600 frames roughly six are in shot at once, so `Scene.pairs` discards the other
    ~4 700 pairs on the temporal test before touching a point.
    """
    out: List[TrackHistoryRecord] = []
    span = max(1, frames - dwell)
    for i in range(identities):
        first = (i * span) // max(1, identities)
        out.append(_walk(f"idn_{i:03d}", 0.10 + 0.006 * (i % 40), 0.004, dwell, first=first))
    return out


def measure(records: List[TrackHistoryRecord], *, repeats: int = 3) -> Dict[str, object]:
    """⚠️ The **best** of `repeats`, not the mean. A slow run is this host doing something else;
    the fastest is the closest reading of what the code costs."""
    primitives = []
    timeline = []
    entries = 0
    result = None
    for _ in range(repeats):
        started = time.perf_counter()
        bt.primitives_for(records)
        middle = time.perf_counter()
        result = bt.timeline_for(records)
        primitives.append((middle - started) * 1000.0)
        timeline.append((time.perf_counter() - middle) * 1000.0)
        entries = len(result.entries)
    return {
        "identities": len({r.identity_id for r in records}),
        "points": sum(len(r.points) for r in records),
        "primitivesMs": round(min(primitives), 2),
        "timelineMs": round(min(timeline), 2),
        "entries": entries,
        # ⛔ Both truncations, published beside the timings. A fast answer that silently dropped two
        # thirds of the scene is not a fast answer, and `entriesTruncated` alone would hide the one
        # that matters: past `relationalTruncated` the pairwise families never ran at all.
        "entriesTruncated": result.truncated,
        "relationalTruncated": result.relational_truncated,
        "identitiesConsidered": result.identities_considered,
    }


def run(repeats: int = 3) -> Dict[str, object]:
    shapes = ((2, 120), (8, 120), (16, 120), (32, 120), (64, 120), (98, 120), (98, 512))
    return {
        "host": f"{platform.system()} {platform.machine()} · py{platform.python_version()}",
        "crowded": [measure(crowded(n, f), repeats=repeats) for n, f in shapes],
        "arriving": [
            measure(arriving(n, max(f, 240)), repeats=repeats) for n, f in shapes
        ],
    }


def _table(rows: List[Dict[str, object]], title: str) -> str:
    out = [
        f"\n{title}",
        f"{'ids':>4} {'seen':>5} {'points':>7} {'primitives ms':>14} {'timeline ms':>12} "
        f"{'entries':>8} {'cut':>5} {'capped':>7}",
    ]
    for row in rows:
        out.append(
            f"{row['identities']:>4} {row['identitiesConsidered']:>5} {row['points']:>7} "
            f"{row['primitivesMs']:>14.1f} {row['timelineMs']:>12.1f} {row['entries']:>8} "
            f"{str(row['entriesTruncated']):>5} {str(row['relationalTruncated']):>7}"
        )
    return "\n".join(out)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--json", dest="json_path", help="write the measurements here as well")
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args(argv)

    result = run(repeats=args.repeats)
    print(result["host"])
    print(_table(result["crowded"], "crowded — every identity in every frame (the capped worst case)"))
    print(_table(result["arriving"], "arriving — identities coming and going (what real footage is)"))
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2)
        print(f"\nwrote {args.json_path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
