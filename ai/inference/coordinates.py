"""Coordinate transformation seam (AI-2, Architect rec 5/6) — a stable, broadly-scoped abstraction so
future spatial reasoning (speed, dwell, path analytics, heatmaps, multi-camera fusion) plugs in
WITHOUT architectural change. AI-2 ships only the identity transform (pixel space); homography /
camera-calibration / stereo / depth implementations slot behind the same Protocol later.
"""

from __future__ import annotations

from typing import Protocol, Tuple

Point = Tuple[float, float]


class CoordinateTransform(Protocol):
    """Map a normalized image-space point to a world/plane coordinate. Kept intentionally broad."""

    name: str

    def to_world(self, point: Point) -> Point: ...


class IdentityTransform:
    """No-op: world == image (normalized). The AI-2 default; keeps everything in pixel space."""

    name = "identity"

    def to_world(self, point: Point) -> Point:
        return point
