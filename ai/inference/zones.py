"""Zone Engine (AI-2, Architect rec 3) — a reusable, business-NEUTRAL geometry engine. It evaluates
pure spatial relationships (is this point inside this area? did this segment cross this line?) and
nothing else: no counting, no analytics, no business meaning. Counting lives in `counting.py`; business
interpretation lives in the Rule Engine. Stdlib-only, deterministic.
"""

from __future__ import annotations

from typing import List, Sequence, Tuple

from tracking_contracts import Zone, ZoneKind

Point = Tuple[float, float]


def point_in_polygon(point: Point, polygon: Sequence[Point]) -> bool:
    """Ray-casting point-in-polygon for a closed area (polygon is an ordered ring)."""
    x, y = point
    inside = False
    n = len(polygon)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _orient(a: Point, b: Point, c: Point) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_intersect(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    """Do segment p1p2 and segment p3p4 cross? (Used for line/tripwire crossing.)"""
    d1 = _orient(p3, p4, p1)
    d2 = _orient(p3, p4, p2)
    d3 = _orient(p1, p2, p3)
    d4 = _orient(p1, p2, p4)
    return (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0)


class ZoneEngine:
    """Pure geometry evaluation over configured zones. No state, no counting."""

    def areas_containing(self, point: Point, zones: Sequence[Zone], camera_id: str) -> List[str]:
        """Ids of `area` zones (on the given camera) whose polygon contains `point`."""
        out: List[str] = []
        for z in zones:
            if z.camera_id == camera_id and z.kind == ZoneKind.AREA and point_in_polygon(point, z.points):
                out.append(z.id)
        return out

    def line_crossed(self, prev: Point, curr: Point, zone: Zone) -> bool:
        """Did the motion prev→curr cross this `line` zone's polyline?"""
        if zone.kind != ZoneKind.LINE:
            return False
        pts = zone.points
        for i in range(len(pts) - 1):
            if segments_intersect(prev, curr, pts[i], pts[i + 1]):
                return True
        return False
