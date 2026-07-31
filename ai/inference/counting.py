"""Counting Engine (AI-2, Architect rec 3/4) — business-NEUTRAL analytics over the Zone Engine.

It counts **confirmed Tracks only** (never raw detections, so detector flicker can't double-count),
emits `ZoneTransition`s (entered/exited) as tracks cross area-zone boundaries, and maintains per-zone
occupancy. It attaches an **event confidence** derived from track quality (rec 5) but assigns NO
business meaning — that stays in the Rule Engine. Zones are scoped per camera (multi-camera-ready).
Stdlib-only, deterministic.
"""

from __future__ import annotations

from typing import Dict, List, Sequence, Set, Tuple

from tracking_contracts import CountingSnapshot, Track, TrackState, Zone, ZoneTransition
from zones import ZoneEngine


class CountingEngine:
    """Stateful across frames: remembers each track's zone membership to detect transitions."""

    def __init__(self, zone_engine: ZoneEngine | None = None) -> None:
        self._zones = zone_engine or ZoneEngine()
        # trackId → (tenantId, cameraId, {zoneId…}) so a vanished track can still exit its zones.
        self._membership: Dict[str, Tuple[str, str, Set[str]]] = {}
        self._counts: Dict[str, Dict[str, int]] = {}  # zoneId → {entered, exited, occupancy}

    def _counts_for(self, zone_id: str) -> Dict[str, int]:
        return self._counts.setdefault(zone_id, {"entered": 0, "exited": 0, "occupancy": 0})

    def update(
        self,
        zones: Sequence[Zone],
        tracks: Sequence[Track],
        *,
        frame_index: int,
        at: str,
    ) -> Tuple[List[ZoneTransition], List[CountingSnapshot]]:
        transitions: List[ZoneTransition] = []
        touched: Set[str] = set()
        active: Set[str] = set()

        for track in tracks:
            if track.state != TrackState.CONFIRMED:
                continue  # confirmed tracks only (rec 4)
            active.add(track.track_id)
            point = track.centroid or (track.bbox[0] + track.bbox[2] / 2, track.bbox[1] + track.bbox[3] / 2)
            inside = set(self._zones.areas_containing(point, zones, track.camera_id))
            prev = self._membership.get(track.track_id, ("", "", set()))[2]
            confidence = track.quality.tracking_confidence if track.quality.tracking_confidence is not None else track.confidence

            for zone_id in sorted(inside - prev):
                self._counts_for(zone_id)["entered"] += 1
                self._counts_for(zone_id)["occupancy"] += 1
                touched.add(zone_id)
                transitions.append(
                    ZoneTransition(track.tenant_id, track.camera_id, zone_id, track.track_id, "entered", frame_index, at, confidence)
                )
            for zone_id in sorted(prev - inside):
                self._exit(track.tenant_id, track.camera_id, zone_id, track.track_id, frame_index, at, confidence, transitions, touched)
            self._membership[track.track_id] = (track.tenant_id, track.camera_id, inside)

        # Tracks that vanished (removed / no longer confirmed) exit whatever zones they were in.
        for track_id in [t for t in self._membership if t not in active]:
            tenant, camera, zone_ids = self._membership[track_id]
            for zone_id in sorted(zone_ids):
                self._exit(tenant, camera, zone_id, track_id, frame_index, at, None, transitions, touched)
            del self._membership[track_id]

        snapshots = [
            CountingSnapshot(
                tenant_id=next((t.tenant_id for t in tracks), ""),
                camera_id=next((z.camera_id for z in zones if z.id == zid), ""),
                zone_id=zid,
                entered=self._counts[zid]["entered"],
                exited=self._counts[zid]["exited"],
                occupancy=self._counts[zid]["occupancy"],
                at=at,
            )
            for zid in sorted(touched)
        ]
        return transitions, snapshots

    def _exit(self, tenant, camera, zone_id, track_id, frame_index, at, confidence, transitions, touched) -> None:
        counts = self._counts_for(zone_id)
        counts["exited"] += 1
        counts["occupancy"] = max(0, counts["occupancy"] - 1)
        touched.add(zone_id)
        transitions.append(
            ZoneTransition(tenant, camera, zone_id, track_id, "exited", frame_index, at, confidence)
        )
