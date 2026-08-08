"""Durable track history (P-11 slice 2.2, [ADR-0051]) — the path a subject took, kept past the
moment the tracker forgets them.

    TrackManager  ──retires a track──▶  TrackHistoryRecorder  ──on retirement──▶  TrackHistoryStore
       (in memory, evicted)                (in memory, bounded)                    (durable, tenant-scoped)
                                                   │
                                                   └──▶ behaviour primitives read from HERE

### ⭐ What is stored, and what deliberately is not

**Stored:** the trajectory — one point per tracked frame, each carrying the box, the footage time and
which `track_id` produced it. **Not stored:** velocity, dwell, direction, path length or any other
derived value ([ADR-0051] decision 3). Storing a derived number freezes its *definition* at the
moment it was written, so a corrected formula can never fix history; every one of them is a pure
function over the points and is recomputed on read.

⚠️ **Zone membership is not stored either**, for the same reason one level up: a polygon is versioned
deployment configuration, and an archive that froze "was inside `z_till`" can never be corrected when
an operator discovers the polygon was drawn two metres off. Membership travels on the live point (see
`behaviour_primitives.MembershipZone`) and is recomputed from geometry when history is re-read.

### ⛔ Keyed by `identity_id`, never `track_id`

A person briefly occluded returns with a **new** `track_id` — [ADR-0038] forbids reuse — so a history
keyed by track id records two short visits where one long one happened. The failure is silent and the
number is plausible. `track_ids` on the record keeps the chain that was bridged, because an
investigator needs to see the joins that were made on their behalf.

### ⚠️ Two clocks, and conflating them deletes an archive

- **Footage time** (`at`) stamps every point. It is the frame's own time, and it does not move on
  replay — a recording from 2019 analysed today produces 2019 timestamps.
- **Wall-clock receipt time** (`written_at`) is what retention counts against, because retention is a
  data-protection promise about how long *we have held* the data. ⛔ Purging by footage time would
  erase an archive analysis the instant it was written, and would keep tomorrow's live footage for
  ever.

### ⚠️ Written on retirement, not per frame

[ADR-0051]'s volume mitigation: 285 detections per 33-second clip is ~8.6/s per camera, and a
16-hour day on 10 cameras is ~5 M points. One durable write per *track* rather than per *frame* keeps
the hot path a stream, and the recorder's in-memory buffer is bounded exactly like the tracker's own
`historyMax` so a subject who never leaves cannot grow without limit.

Stdlib-only. Deterministic given its inputs. The store is the only thing here that touches a disk.

[ADR-0051]: ../../docs/adr/ADR-0051-track-history-becomes-durable.md
[ADR-0038]: ../../docs/adr/ADR-0038-track-identity-across-gaps.md
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Protocol, Sequence, Tuple

from track_motion import seconds_of

Box = Tuple[float, float, float, float]

#: Points retained per identity in the recorder's live buffer, and per record on disk.
#:
#: ⚠️ Bounded for the reason everything in this runtime is bounded: a subject standing in view of a
#: camera for eight hours is not a hypothetical in retail, and an unbounded path is an outage waiting
#: for the quietest shift. 512 points is ~4 minutes at 2 fps and ~2 minutes at 4 fps.
DEFAULT_MAX_POINTS = 512

#: Records held per tenant by the in-memory store before the oldest is dropped.
DEFAULT_MAX_RECORDS = 4096

#: How long a record is kept, in hours of wall-clock time since it was written. Short by default
#: ([ADR-0051] decision 5): a movement path is personal data in a way a detection count is not.
DEFAULT_RETENTION_HOURS = 72.0

#: The record shape's own version, so an archive read three years from now can be interpreted.
TRACK_HISTORY_SCHEMA_VERSION = "1.0"


@dataclass(frozen=True)
class HistoryPoint:
    """One observation of one identity, in one frame.

    ⚠️ `at` is the frame's own timestamp and `at_seconds` is derived from it, never stored — see the
    module docstring on why a derived value is recomputed rather than persisted. It is `None` when
    the timestamp could not be parsed, which is a fact the reader must handle rather than a zero.
    """

    frame_index: int
    at: str
    bbox: Box
    track_id: str
    label: str = "person"
    confidence: float = 1.0
    #: Zones an upstream said this observation was inside. ⛔ **Held in memory, never persisted** —
    #: see the module docstring: a polygon is versioned configuration, and an archive that froze
    #: membership can never be corrected when the polygon turns out to have been drawn wrong.
    #: Mutable by exception (`annotate_zones`), because membership is resolved after the box is.
    zone_ids: Tuple[str, ...] = ()

    @property
    def at_seconds(self) -> Optional[float]:
        return seconds_of(self.at)

    def to_dict(self) -> dict:
        return {
            "frameIndex": int(self.frame_index),
            "at": self.at,
            "bbox": [round(float(v), 6) for v in self.bbox],
            "trackId": self.track_id,
            "label": self.label,
            "confidence": round(float(self.confidence), 6),
        }

    @staticmethod
    def from_dict(raw: dict) -> "HistoryPoint":
        box = [float(v) for v in raw["bbox"]]
        return HistoryPoint(
            frame_index=int(raw["frameIndex"]),
            at=str(raw["at"]),
            bbox=(box[0], box[1], box[2], box[3]),
            track_id=str(raw["trackId"]),
            label=str(raw.get("label", "person")),
            confidence=float(raw.get("confidence", 1.0)),
        )


@dataclass
class TrackHistoryRecord:
    """Everything one identity did on one camera, in one analysis.

    ⚠️ `stream_id` is part of the key, not decoration. Two analyses of one recording must not share a
    history, or [ADR-0047]'s promise that runs are independently queryable would hold for events and
    quietly fail for movement — the same defect `RuntimeTracker._state_for` documents at four layers.
    """

    identity_id: str
    tenant_id: str
    camera_id: str
    stream_id: Optional[str] = None
    label: str = "person"
    points: List[HistoryPoint] = field(default_factory=list)
    #: Every track id this identity was assembled from, in order. One entry is an unbroken track;
    #: more than one means a gap was bridged and an investigator can see exactly where.
    track_ids: List[str] = field(default_factory=list)
    #: Set when the tracker retired the identity. An open record is a subject still in view.
    closed: bool = False
    #: Wall-clock ISO-8601, stamped when the record was first written durably. Retention counts
    #: against this and never against footage time — see the module docstring.
    written_at: Optional[str] = None

    @property
    def first_seconds(self) -> Optional[float]:
        return self.points[0].at_seconds if self.points else None

    @property
    def last_seconds(self) -> Optional[float]:
        return self.points[-1].at_seconds if self.points else None

    def to_dict(self) -> dict:
        out: dict = {
            "schemaVersion": TRACK_HISTORY_SCHEMA_VERSION,
            "identityId": self.identity_id,
            "tenantId": self.tenant_id,
            "cameraId": self.camera_id,
            "label": self.label,
            "points": [p.to_dict() for p in self.points],
            "trackIds": list(self.track_ids),
            "closed": bool(self.closed),
        }
        if self.stream_id is not None:
            out["streamId"] = self.stream_id
        if self.written_at is not None:
            out["writtenAt"] = self.written_at
        return out

    @staticmethod
    def from_dict(raw: dict) -> "TrackHistoryRecord":
        return TrackHistoryRecord(
            identity_id=str(raw["identityId"]),
            tenant_id=str(raw["tenantId"]),
            camera_id=str(raw["cameraId"]),
            stream_id=raw.get("streamId"),
            label=str(raw.get("label", "person")),
            points=[HistoryPoint.from_dict(p) for p in raw.get("points", [])],
            track_ids=[str(t) for t in raw.get("trackIds", [])],
            closed=bool(raw.get("closed", False)),
            written_at=raw.get("writtenAt"),
        )


@dataclass(frozen=True)
class RetentionPolicy:
    """How long history is kept, and how much of it.

    ⚠️ Three independent bounds because they fail differently: `max_age_hours` is the promise made to
    a data subject, `max_records_per_tenant` is the promise made to the disk, and `max_points` is the
    promise made to the reader that one long-staying subject cannot make a query unbounded.
    """

    max_age_hours: float = DEFAULT_RETENTION_HOURS
    max_records_per_tenant: int = DEFAULT_MAX_RECORDS
    max_points: int = DEFAULT_MAX_POINTS

    def expired(self, record: TrackHistoryRecord, *, now: float) -> bool:
        """⚠️ A record with no `written_at` is **not** expired. Absence of a receipt time is a bug in
        whoever wrote it, and deleting data because its metadata is missing is the wrong direction to
        fail."""
        if record.written_at is None:
            return False
        stamped = seconds_of(record.written_at)
        if stamped is None:
            return False
        return (now - stamped) > self.max_age_hours * 3600.0


class TrackHistoryUnavailable(RuntimeError):
    """The configured history location cannot be written to.

    ⛔ **Raised at construction, so the runtime refuses to start.** Found by deploying, not by any
    test: a named Docker volume is created **root-owned**, the runtime runs as uid 999, and the first
    write failed with `EPERM` — after the container had reported healthy. An operator who configured
    `INFERENCE_TRACK_HISTORY_DIR` asked for movement paths to be kept; starting anyway and keeping
    none of them is the silent half-failure ADR-0051 decision 5 exists to prevent.
    """


class TrackHistoryStore(Protocol):
    """Durable, tenant-scoped storage for retired identities."""

    def write(self, record: TrackHistoryRecord) -> None: ...

    def records(
        self, tenant_id: str, *, camera_id: Optional[str] = None, identity_id: Optional[str] = None
    ) -> List[TrackHistoryRecord]: ...

    def erase_tenant(self, tenant_id: str) -> int:
        """Remove everything held for one tenant. Returns how many records went."""
        ...

    def purge(self, *, now: Optional[float] = None) -> int:
        """Drop records past their retention. Returns how many went."""
        ...

    def stats(self) -> dict: ...


class NullTrackHistoryStore:
    """The default: history is recorded in memory for the behaviour stage and never persisted.

    ⭐ **The default is deliberate and it is not laziness.** A movement path is personal data; a
    deployment gets one when an operator configures a location for it, not because a library was
    imported. `stats()` reports `durable: False` so an operator can never mistake "nothing was kept"
    for "nothing happened".
    """

    def write(self, record: TrackHistoryRecord) -> None:
        return None

    def records(
        self, tenant_id: str, *, camera_id: Optional[str] = None, identity_id: Optional[str] = None
    ) -> List[TrackHistoryRecord]:
        return []

    def erase_tenant(self, tenant_id: str) -> int:
        return 0

    def purge(self, *, now: Optional[float] = None) -> int:
        return 0

    def stats(self) -> dict:
        return {"durable": False, "backend": "null", "records": 0, "tenants": 0}


class InMemoryTrackHistoryStore:
    """Bounded, process-lifetime storage. ⚠️ Loses everything on restart, and says so in `stats()`."""

    def __init__(self, policy: Optional[RetentionPolicy] = None, *, clock=time.time) -> None:
        self._policy = policy or RetentionPolicy()
        self._clock = clock
        self._lock = threading.RLock()
        self._by_tenant: Dict[str, List[TrackHistoryRecord]] = {}

    def write(self, record: TrackHistoryRecord) -> None:
        with self._lock:
            if record.written_at is None:
                record.written_at = _iso(self._clock())
            _trim_points(record, self._policy.max_points)
            bucket = self._by_tenant.setdefault(record.tenant_id, [])
            bucket.append(record)
            while len(bucket) > self._policy.max_records_per_tenant:
                bucket.pop(0)

    def records(
        self, tenant_id: str, *, camera_id: Optional[str] = None, identity_id: Optional[str] = None
    ) -> List[TrackHistoryRecord]:
        with self._lock:
            return [
                r
                for r in self._by_tenant.get(tenant_id, [])
                if (camera_id is None or r.camera_id == camera_id)
                and (identity_id is None or r.identity_id == identity_id)
            ]

    def erase_tenant(self, tenant_id: str) -> int:
        with self._lock:
            return len(self._by_tenant.pop(tenant_id, []))

    def purge(self, *, now: Optional[float] = None) -> int:
        moment = self._clock() if now is None else now
        removed = 0
        with self._lock:
            for tenant, bucket in list(self._by_tenant.items()):
                kept = [r for r in bucket if not self._policy.expired(r, now=moment)]
                removed += len(bucket) - len(kept)
                if kept:
                    self._by_tenant[tenant] = kept
                else:
                    del self._by_tenant[tenant]
        return removed

    def stats(self) -> dict:
        with self._lock:
            return {
                "durable": False,
                "backend": "memory",
                "records": sum(len(b) for b in self._by_tenant.values()),
                "tenants": len(self._by_tenant),
            }


class JsonlTrackHistoryStore:
    """One append-only JSON-lines file per tenant, under a configured directory.

    ⭐ **Resume after restart is the whole reason this exists**, and it is a property of the format
    rather than of any code here: the file *is* the state, so a runtime that comes back up reads what
    the one before it wrote. There is no index to rebuild and nothing to replay.

    ⚠️ **Tenant erasure is a file deletion, and that is a design choice.** One tenant per file means
    erasure cannot leave a fragment behind in a shared structure, which is exactly the failure mode
    that makes a "delete my data" promise quietly false. The cost is a file handle per tenant, which
    is cheaper than the alternative by every measure that matters here.

    ⚠️ Reads parse the whole tenant file. Bounded by retention rather than by cleverness: queries are
    rare (an investigation, a report), writes are one per retired identity, and an index would be a
    second thing to keep true.
    """

    def __init__(self, directory: str, policy: Optional[RetentionPolicy] = None, *, clock=time.time) -> None:
        self._dir = directory
        self._policy = policy or RetentionPolicy()
        self._clock = clock
        self._lock = threading.RLock()
        try:
            os.makedirs(self._dir, exist_ok=True)
        except OSError as exc:
            raise TrackHistoryUnavailable(f"cannot create track history directory '{directory}': {exc}") from exc
        self._probe()

    def _probe(self) -> None:
        """Write and delete a file, at construction, before anything depends on it.

        ⛔ **`os.access` is not enough and was not used.** It answers about the *permission bits*,
        which is a different question from "can this process write here" the moment a read-only
        mount, a full disk, SELinux or a root-owned volume is involved — and every one of those is a
        deployment reality rather than a hypothetical. The only honest probe is to write.
        """
        handle = None
        try:
            handle, path = tempfile.mkstemp(dir=self._dir, prefix=".probe-")
            os.close(handle)
            os.remove(path)
        except OSError as exc:
            if handle is not None:
                try:
                    os.close(handle)
                except OSError:
                    pass
            raise TrackHistoryUnavailable(
                f"track history directory '{self._dir}' is not writable by this process "
                f"(uid {os.getuid()}): {exc}"
            ) from exc

    # --- writes ------------------------------------------------------------------

    def write(self, record: TrackHistoryRecord) -> None:
        if record.written_at is None:
            record.written_at = _iso(self._clock())
        _trim_points(record, self._policy.max_points)
        line = json.dumps(record.to_dict(), separators=(",", ":"), sort_keys=True)
        with self._lock:
            with open(self._path(record.tenant_id), "a", encoding="utf-8") as handle:
                handle.write(line + "\n")

    # --- reads -------------------------------------------------------------------

    def records(
        self, tenant_id: str, *, camera_id: Optional[str] = None, identity_id: Optional[str] = None
    ) -> List[TrackHistoryRecord]:
        with self._lock:
            return [
                r
                for r in self._read(tenant_id)
                if (camera_id is None or r.camera_id == camera_id)
                and (identity_id is None or r.identity_id == identity_id)
            ]

    def _read(self, tenant_id: str) -> List[TrackHistoryRecord]:
        path = self._path(tenant_id)
        if not os.path.exists(path):
            return []
        out: List[TrackHistoryRecord] = []
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                text = line.strip()
                if not text:
                    continue
                try:
                    out.append(TrackHistoryRecord.from_dict(json.loads(text)))
                except (ValueError, KeyError, TypeError):
                    # ⚠️ A truncated final line is the normal cost of an append-only file whose writer
                    # was killed. Skipping it keeps every complete record readable; failing the whole
                    # query would lose an investigation to one unlucky shutdown.
                    continue
        return out

    # --- lifecycle ---------------------------------------------------------------

    def erase_tenant(self, tenant_id: str) -> int:
        with self._lock:
            path = self._path(tenant_id)
            if not os.path.exists(path):
                return 0
            count = len(self._read(tenant_id))
            os.remove(path)
            return count

    def purge(self, *, now: Optional[float] = None) -> int:
        moment = self._clock() if now is None else now
        removed = 0
        with self._lock:
            for tenant in self._tenants():
                records = self._read(tenant)
                kept = [r for r in records if not self._policy.expired(r, now=moment)]
                if len(kept) == len(records):
                    continue
                removed += len(records) - len(kept)
                self._rewrite(tenant, kept)
        return removed

    def _rewrite(self, tenant_id: str, records: Sequence[TrackHistoryRecord]) -> None:
        """⚠️ Write-to-temp-then-rename. A retention pass interrupted halfway through a truncate would
        take the archive with it, and a crash during a purge is exactly when the data matters."""
        path = self._path(tenant_id)
        if not records:
            if os.path.exists(path):
                os.remove(path)
            return
        handle, temp = tempfile.mkstemp(dir=self._dir, suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                for record in records:
                    out.write(json.dumps(record.to_dict(), separators=(",", ":"), sort_keys=True) + "\n")
            os.replace(temp, path)
        except BaseException:
            if os.path.exists(temp):
                os.remove(temp)
            raise

    def stats(self) -> dict:
        with self._lock:
            tenants = self._tenants()
            return {
                "durable": True,
                "backend": "jsonl",
                "directory": self._dir,
                "records": sum(len(self._read(t)) for t in tenants),
                "tenants": len(tenants),
                "retentionHours": self._policy.max_age_hours,
            }

    # --- paths -------------------------------------------------------------------

    def _tenants(self) -> List[str]:
        if not os.path.isdir(self._dir):
            return []
        return sorted(
            _unsafe_decode(name[:-6]) for name in os.listdir(self._dir) if name.endswith(".jsonl")
        )

    def _path(self, tenant_id: str) -> str:
        return os.path.join(self._dir, f"{_safe_name(tenant_id)}.jsonl")


class TrackHistoryRecorder:
    """The live, in-memory accumulator: what the tracker writes and the behaviour stage reads.

    ⭐ **One writer, one reader, no coupling between them.** `RuntimeTracker` appends observations;
    the behaviour stage asks for an identity's points. Neither knows the other exists, which is what
    keeps ADR-0052's layer boundary structural rather than a convention.

    ⚠️ **Retired records are queued, not written here.** The tracker appends under its own update
    lock, and a disk write inside that lock would put file I/O on the path that association runs on.
    `drain_pending()` is called by the caller *after* the lock is released.
    """

    def __init__(
        self,
        *,
        store: Optional[TrackHistoryStore] = None,
        max_points: int = DEFAULT_MAX_POINTS,
        max_identities: int = 512,
    ) -> None:
        self._store: TrackHistoryStore = store or NullTrackHistoryStore()
        self._max_points = max(1, int(max_points))
        self._max_identities = max(1, int(max_identities))
        self._lock = threading.RLock()
        #: (tenant, camera, stream) → identity → record
        self._live: Dict[Tuple[str, str, Optional[str]], Dict[str, TrackHistoryRecord]] = {}
        self._pending: List[TrackHistoryRecord] = []
        self._observed = 0
        self._retired = 0
        self._dropped_undated = 0
        self._write_failures = 0
        self._last_write_error: Optional[str] = None

    @property
    def store(self) -> TrackHistoryStore:
        return self._store

    # --- writes ------------------------------------------------------------------

    def observe(
        self,
        *,
        tenant_id: str,
        camera_id: str,
        stream_id: Optional[str],
        identity_id: str,
        track_id: str,
        frame_index: int,
        at: str,
        bbox: Box,
        label: str = "person",
        confidence: float = 1.0,
    ) -> None:
        """Append one observation. ⚠️ An unparseable timestamp is **dropped and counted**, not stored
        with a substituted time — every duration derived from a fabricated instant would be wrong and
        would look right."""
        if seconds_of(at) is None:
            with self._lock:
                self._dropped_undated += 1
            return
        key = (tenant_id, camera_id, stream_id)
        with self._lock:
            bucket = self._live.setdefault(key, {})
            record = bucket.get(identity_id)
            if record is None:
                if len(bucket) >= self._max_identities:
                    self._retire_oldest(key, bucket)
                record = TrackHistoryRecord(
                    identity_id=identity_id,
                    tenant_id=tenant_id,
                    camera_id=camera_id,
                    stream_id=stream_id,
                    label=label,
                )
                bucket[identity_id] = record
            if track_id not in record.track_ids:
                record.track_ids.append(track_id)
            record.points.append(
                HistoryPoint(
                    frame_index=frame_index,
                    at=at,
                    bbox=(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])),
                    track_id=track_id,
                    label=label,
                    confidence=float(confidence),
                )
            )
            _trim_points(record, self._max_points)
            self._observed += 1

    def retire(self, *, tenant_id: str, camera_id: str, stream_id: Optional[str], identity_id: str) -> None:
        """Close an identity and queue it for durable storage. Unknown identities are a no-op."""
        key = (tenant_id, camera_id, stream_id)
        with self._lock:
            bucket = self._live.get(key)
            if bucket is None:
                return
            record = bucket.pop(identity_id, None)
            if record is None:
                return
            record.closed = True
            self._pending.append(record)
            self._retired += 1
            if not bucket:
                del self._live[key]

    def annotate_zones(
        self,
        *,
        tenant_id: str,
        camera_id: str,
        stream_id: Optional[str],
        identity_id: str,
        zone_ids: Sequence[str],
    ) -> bool:
        """Attach zone membership to an identity's **most recent** observation.

        ⭐ **A second write, deliberately, because membership is resolved after the box is.** The
        tracker records where a subject was; only later does something with the polygons say which
        zones that was inside. Without this back-fill every point but the current one would carry no
        membership, and a dwell that can only ever be one frame long reads as "nobody lingered" —
        plausible, wrong, and silent.
        """
        from dataclasses import replace  # noqa: WPS433 - local, one call site

        with self._lock:
            bucket = self._live.get((tenant_id, camera_id, stream_id))
            record = None if bucket is None else bucket.get(identity_id)
            if record is None or not record.points:
                return False
            record.points[-1] = replace(record.points[-1], zone_ids=tuple(str(z) for z in zone_ids))
            return True

    def retire_stale(
        self,
        *,
        tenant_id: str,
        camera_id: str,
        stream_id: Optional[str],
        now_seconds: float,
        older_than_seconds: float,
    ) -> int:
        """Close identities not observed for `older_than_seconds` of **footage** time.

        ⭐ **Not on track removal**, and the difference is the whole of [ADR-0038]. A removed track
        can have its identity adopted by a new one for `reentryGapSeconds` afterwards; closing the
        record when the *track* died would split one subject's path in two at exactly the moment the
        platform went to the trouble of keeping it whole.

        ⚠️ Footage time, so a stream that stops sending frames stops ageing its identities. Releasing
        those is the camera sweep's job, not this one's — two clocks, two mechanisms, neither
        pretending to be the other.
        """
        key = (tenant_id, camera_id, stream_id)
        closed = 0
        with self._lock:
            bucket = self._live.get(key)
            if not bucket:
                return 0
            for identity, record in list(bucket.items()):
                last = record.last_seconds
                if last is None or (now_seconds - last) <= older_than_seconds:
                    continue
                record.closed = True
                self._pending.append(bucket.pop(identity))
                self._retired += 1
                closed += 1
            if not bucket:
                del self._live[key]
        return closed

    def retire_stream(self, *, tenant_id: str, camera_id: str, stream_id: Optional[str]) -> int:
        """Close every open identity on one stream — what a camera sweep calls when state is released."""
        key = (tenant_id, camera_id, stream_id)
        with self._lock:
            bucket = self._live.pop(key, {})
            for record in bucket.values():
                record.closed = True
                self._pending.append(record)
            self._retired += len(bucket)
            return len(bucket)

    def drain_pending(self) -> int:
        """Flush queued records to the store. ⚠️ Call this **outside** the tracker's update lock.

        ⛔ **A storage failure must not take down perception, and must not be silent either.** Found
        by deploying: an unwritable volume made this raise, the exception propagated up through
        `RuntimeTracker.run` → `CapabilityRuntime.process`, and **every frame after the first retired
        identity answered HTTP 500**. Keeping movement paths is a secondary duty; seeing people is
        the primary one, and a secondary duty that can stop the primary one is a defect in the
        wiring rather than in the storage.

        So the write is contained here: the record is dropped, the failure is **counted**, the last
        message is kept, and `stats()` publishes both. ⚠️ Dropped rather than re-queued — an
        unbounded retry queue on a permanently unwritable volume is a memory leak that ends the same
        outage a different way.
        """
        with self._lock:
            pending, self._pending = self._pending, []
        written = 0
        for record in pending:
            try:
                self._store.write(record)
                written += 1
            except Exception as exc:  # noqa: BLE001 - any storage failure, contained deliberately
                with self._lock:
                    self._write_failures += 1
                    self._last_write_error = f"{type(exc).__name__}: {exc}"[:200]
        return written

    # --- reads -------------------------------------------------------------------

    def live_records(
        self, tenant_id: str, camera_id: str, stream_id: Optional[str] = None
    ) -> List[TrackHistoryRecord]:
        """Open records for one stream, oldest identity first."""
        with self._lock:
            bucket = self._live.get((tenant_id, camera_id, stream_id), {})
            return list(bucket.values())

    def forget_tenant(self, tenant_id: str) -> int:
        """⛔ Erasure covers the live buffer too. A tenant deletion that cleared the archive and left
        the in-flight paths in memory would answer 'deleted' while still holding them."""
        with self._lock:
            keys = [k for k in self._live if k[0] == tenant_id]
            dropped = sum(len(self._live[k]) for k in keys)
            for key in keys:
                del self._live[key]
            before = len(self._pending)
            self._pending = [r for r in self._pending if r.tenant_id != tenant_id]
            dropped += before - len(self._pending)
        return dropped + self._store.erase_tenant(tenant_id)

    def stats(self) -> dict:
        with self._lock:
            live = sum(len(b) for b in self._live.values())
            return {
                "schemaVersion": TRACK_HISTORY_SCHEMA_VERSION,
                "liveIdentities": live,
                "liveStreams": len(self._live),
                "pointsObserved": self._observed,
                "identitiesRetired": self._retired,
                # ⚠️ Reported, never hidden. A timestamp the runtime could not parse means a stream
                # whose history is silently empty, and a zero here is the only way to know it is not.
                "undatedObservationsDropped": self._dropped_undated,
                "pendingWrites": len(self._pending),
                # ⛔ The pair that tells "nothing was kept because nothing happened" apart from
                # "nothing was kept because the disk refused". A deployment reporting
                # `identitiesRetired: 6, records: 0` and nothing else is exactly what shipped here
                # once, and it read as a quiet camera.
                "writeFailures": self._write_failures,
                "lastWriteError": self._last_write_error,
                "store": self._store.stats(),
            }

    def _retire_oldest(self, key: Tuple[str, str, Optional[str]], bucket: Dict[str, TrackHistoryRecord]) -> None:
        oldest = min(bucket.values(), key=lambda r: (r.first_seconds is None, r.first_seconds or 0.0))
        record = bucket.pop(oldest.identity_id)
        record.closed = True
        self._pending.append(record)
        self._retired += 1


# --- helpers ---------------------------------------------------------------------------------------


def _trim_points(record: TrackHistoryRecord, limit: int) -> None:
    """Keep the newest `limit` points. ⚠️ The *newest*: a subject's recent movement is what a rule
    asks about, and dropping the tail would make a long dwell look like it had just started."""
    if len(record.points) > limit:
        del record.points[: len(record.points) - limit]


def _safe_name(tenant_id: str) -> str:
    """A tenant id as a filename. ⚠️ Anything outside the allowed set is percent-escaped rather than
    stripped: two tenants whose ids differed only in a stripped character would share a file, and
    erasure for one would take the other's history with it."""
    out = []
    for char in tenant_id:
        if char.isalnum() or char in "-_":
            out.append(char)
        else:
            out.append(f"%{ord(char):02x}")
    return "".join(out) or "%00"


def _unsafe_decode(name: str) -> str:
    out: List[str] = []
    index = 0
    while index < len(name):
        if name[index] == "%" and index + 2 < len(name) + 1:
            try:
                out.append(chr(int(name[index + 1 : index + 3], 16)))
                index += 3
                continue
            except ValueError:
                pass
        out.append(name[index])
        index += 1
    return "".join(out)


def _iso(now: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(now, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def points_of(records: Iterable[TrackHistoryRecord]) -> List[HistoryPoint]:
    """Every point across several records, in footage-time order. Undated points cannot be ordered
    and are excluded — they were never recorded, so this is a belt-and-braces read."""
    out = [p for record in records for p in record.points if p.at_seconds is not None]
    out.sort(key=lambda p: p.at_seconds or 0.0)
    return out
