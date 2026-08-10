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
import re
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Mapping, Optional, Protocol, Sequence, Tuple

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

#: Decimal places a stored coordinate keeps — **the platform's single precision for a movement path.**
#:
#: ⛔ **Named once because two places used to round independently, and one of them did not.**
#: `to_dict` has always rounded on the way to disk; the in-memory point kept full precision. A live
#: read and a durable read of the *same observation* therefore derived from different coordinates, and
#: across a restart `directionDegrees` moved 309.1818 → 306.8699 on a near-stationary object whose
#: entire displacement is ~1e-5 — where a 1e-6 rounding is a ten-percent perturbation. Nothing was
#: lost: `samples` and `durationSeconds` were identical. The two paths simply disagreed in the seventh
#: decimal, and every derived number inherited the disagreement.
#:
#: ⚠️ 1e-6 of a frame width is ~0.002 px on a 1920-wide image — far below what any detector resolves,
#: so this discards no information. Rounding at the storage boundary is correct; **holding one fact at
#: two precisions is the defect**, and the fix is to round at observation so the live record is
#: bit-identical to the durable one by construction rather than by both sides remembering to.
STORED_PRECISION = 6


@dataclass(frozen=True)
class HistoryPoint:
    """One observation of one identity, in one frame.

    ⚠️ `at` is the frame's own timestamp and `at_seconds` is derived from it, never stored — see the
    module docstring on why a derived value is recomputed rather than persisted. It is `None` when
    the timestamp could not be parsed, which is a fact the reader must handle rather than a zero.
    """

    #: ⛔ **The caller's `frame.seq`**, not any counter this runtime keeps.
    #:
    #: It is the same number `DetectionResult.frame.seq` carries and `EventEnvelope.payload.frameSeq`
    #: publishes, which is what makes a stored movement path joinable to the events that cite it and
    #: to the membership media sends back (ADR-0053). A runtime-private counter here would be
    #: meaningless to every reader outside this process, and the zone join built on one was off by
    #: exactly one frame — producing a dwell short by one interval that looked entirely reasonable.
    frame_index: int
    at: str
    bbox: Box
    track_id: str
    label: str = "person"
    confidence: float = 1.0
    #: Zones an upstream found this observation inside (ADR-0053). Written a second time, after the
    #: box, because membership is resolved downstream of inference.
    zone_ids: Tuple[str, ...] = ()
    #: ⛔ **Whether membership for this observation has been DECIDED**, which is a different question
    #: from whether it found any.
    #:
    #: `False` means nothing has said yet; `True` with an empty `zone_ids` means something said, and
    #: the answer was "inside none". Collapsing the two is not a rounding error — a zone visit walks
    #: consecutive points, and an undecided point read as "outside" ends the visit and emits a `left`
    #: transition that never happened, on every frame, for as long as the echo runs one frame behind.
    zones_settled: bool = False

    def __post_init__(self) -> None:
        # ⭐ Non-empty membership implies settled — the same invariant `bp.TrackPoint` enforces, for
        # the same reason: the contradictory state is unbuildable rather than merely discouraged.
        if self.zone_ids and not self.zones_settled:
            object.__setattr__(self, "zones_settled", True)

    @property
    def at_seconds(self) -> Optional[float]:
        return seconds_of(self.at)

    def to_dict(self) -> dict:
        out = {
            "frameIndex": int(self.frame_index),
            "at": self.at,
            "bbox": [round(float(v), STORED_PRECISION) for v in self.bbox],
            "trackId": self.track_id,
            "label": self.label,
            "confidence": round(float(self.confidence), STORED_PRECISION),
        }
        # ⚠️ Present-when-settled, absent otherwise — including when settled to nothing, which
        # serialises as `[]`. Absence is the only encoding of "undecided" that a reader cannot
        # mistake for "outside every zone". See `zones_settled`, and ADR-0053 on why membership is
        # stored at all now that a record can name the polygon version that produced it.
        if self.zones_settled:
            out["zoneIds"] = list(self.zone_ids)
        return out

    @staticmethod
    def from_dict(raw: dict) -> "HistoryPoint":
        box = [float(v) for v in raw["bbox"]]
        zones = raw.get("zoneIds")
        settled = isinstance(zones, (list, tuple))
        return HistoryPoint(
            frame_index=int(raw["frameIndex"]),
            at=str(raw["at"]),
            bbox=(box[0], box[1], box[2], box[3]),
            track_id=str(raw["trackId"]),
            label=str(raw.get("label", "person")),
            confidence=float(raw.get("confidence", 1.0)),
            zone_ids=tuple(str(z) for z in zones) if settled else (),
            zones_settled=settled,
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
    #: ⭐ **Which polygon set decided this record's zone membership** (ADR-0053).
    #:
    #: The reason membership may be stored at all. ADR-0051 refused to persist it because an archive
    #: that froze "was inside `z_till`" could never be corrected when the polygon turned out to be
    #: drawn two metres off. Naming the version answers that directly: the archive says which geometry
    #: it used, a correction is visible rather than silent, and re-resolving is a deliberate act.
    #: `None` on a record whose membership was never settled.
    zone_version: Optional[int] = None

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
        if self.zone_version is not None:
            out["zoneVersion"] = int(self.zone_version)
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
            zone_version=int(raw["zoneVersion"]) if raw.get("zoneVersion") is not None else None,
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


#: Identities named in `stats()` after a durable write failed. ⚠️ Bounded for the same reason
#: `drain_pending` refuses to build a retry queue: an unbounded list on a permanently unwritable
#: volume is a memory leak arriving through a different door.
LOST_IDENTITIES_MAX = 64


@dataclass(frozen=True)
class IntegrityReport:
    """What a read found that it could not parse.

    ⭐ **Returned by the read, because that is where the parse already happens.** Counting damage on
    the `/metrics` path was measured and rejected — at the 4096-record cap, a line count is 13.8 ms
    and `json.loads` on every line is 251.7 ms, on an endpoint scraped every 15 seconds. See
    `_count`, which exists because exactly that cost shipped once.

    ⚠️ `damaged_lines` is **not** an error to raise. A damaged line is a record that was written and
    can no longer be read, and the whole point of reporting it is that the surviving records stay
    readable — failing the query would lose an investigation to one unlucky shutdown. What it must
    never do is pass silently, because `CORRUPTED` presenting as `ABSENT` turns "we had this and
    destroyed it" into "this never happened".
    """

    damaged_lines: int = 0
    #: 1-indexed line number of the first damage. ⚠️ A line number rather than a byte offset because
    #: it is free — a byte offset costs an encode per line on the read path.
    first_damaged_line: Optional[int] = None

    @property
    def clean(self) -> bool:
        return self.damaged_lines == 0


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
        self,
        tenant_id: str,
        *,
        camera_id: Optional[str] = None,
        identity_id: Optional[str] = None,
        stream_id: Optional[str] = None,
    ) -> List[TrackHistoryRecord]:
        """⚠️ `stream_id` is the most selective filter a caller has — one analysis — so every
        implementation must accept it. A store that ignores it makes an analysis-scoped read cost
        the whole tenant's history, which is the defect the P-11 soak found."""
        ...

    def records_with_integrity(
        self,
        tenant_id: str,
        *,
        camera_id: Optional[str] = None,
        identity_id: Optional[str] = None,
        stream_id: Optional[str] = None,
    ) -> Tuple[List[TrackHistoryRecord], IntegrityReport]:
        """The same read, plus what it could not parse.

        ⭐ **One scan, two answers.** `records()` is the same work with the report discarded, so a
        caller that needs to distinguish `CORRUPTED` from `ABSENT` pays nothing extra for it.
        """
        ...

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
        self,
        tenant_id: str,
        *,
        camera_id: Optional[str] = None,
        identity_id: Optional[str] = None,
        stream_id: Optional[str] = None,
    ) -> List[TrackHistoryRecord]:
        return []

    def records_with_integrity(
        self,
        tenant_id: str,
        *,
        camera_id: Optional[str] = None,
        identity_id: Optional[str] = None,
        stream_id: Optional[str] = None,
    ) -> Tuple[List[TrackHistoryRecord], IntegrityReport]:
        """⚠️ Clean, and that is not the same as *present*. Nothing was parsed because nothing was
        ever stored — which is `ABSENT`, and the caller distinguishes the two by `durable: False`."""
        return [], IntegrityReport()

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
        self,
        tenant_id: str,
        *,
        camera_id: Optional[str] = None,
        identity_id: Optional[str] = None,
        stream_id: Optional[str] = None,
    ) -> List[TrackHistoryRecord]:
        with self._lock:
            return [
                r
                for r in self._by_tenant.get(tenant_id, [])
                if (camera_id is None or r.camera_id == camera_id)
                and (identity_id is None or r.identity_id == identity_id)
                and (stream_id is None or r.stream_id == stream_id)
            ]

    def records_with_integrity(
        self,
        tenant_id: str,
        *,
        camera_id: Optional[str] = None,
        identity_id: Optional[str] = None,
        stream_id: Optional[str] = None,
    ) -> Tuple[List[TrackHistoryRecord], IntegrityReport]:
        """⚠️ Always clean: these records were never serialised, so there is nothing to fail to
        parse. A process-lifetime store loses everything at once or nothing at all."""
        found = self.records(
            tenant_id, camera_id=camera_id, identity_id=identity_id, stream_id=stream_id
        )
        return found, IntegrityReport()

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


#: Ids safe to look for as a raw substring of a serialised record.
#:
#: ⚠️ The pre-filter below is only ever allowed to *narrow*, never to decide. It skips lines that
#: cannot possibly match, and every surviving line is still checked against the parsed dict. So a
#: false positive costs one wasted parse and a false negative would lose data — which is why the
#: needle is the exact serialised pair (`"streamId":"ana_x"`, from `json.dumps(sort_keys=True,
#: separators=(",", ":"))`) and is refused for any id that JSON might escape.
_UNESCAPED_ID = re.compile(r"[A-Za-z0-9_.:@-]+")


def _needle(field: str, value: Optional[str]) -> Optional[str]:
    if value is None or _UNESCAPED_ID.fullmatch(value) is None:
        return None
    return f'"{field}":"{value}"'


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
        #: Damaged lines this process's reads have met. See `records_with_integrity` on why this is
        #: a counter and not a gauge.
        self._damaged_seen = 0
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
        """Append one record as one line.

        ### ⛔ Why this is not `open(path, "a").write(line)` any more

        A buffered text writer flushes every `io.DEFAULT_BUFFER_SIZE` — 8192 bytes — and a real
        record is bigger than that. Measured, on the real serialiser:

              1 point  →     421 bytes    one buffer
             10 points →   2 383 bytes    one buffer
            100 points →  22 093 bytes    ⛔ three flushes
            512 points → 112 733 bytes    ⛔ fourteen flushes  (`DEFAULT_MAX_POINTS`)

        So a process killed between flushes leaves a **partial line with no terminating newline** —
        ordinary rather than exotic, since 100 points is a subject tracked for under a minute at
        2 fps. ⚠️ And the danger got *larger* with the EI-3 shutdown flush, which writes every open
        identity in one burst at precisely the moment the process is being torn down, inside a
        20-second `stop_grace_period`.

        ⛔ **The damage used to spread.** The next append landed on the same unterminated line, so
        the pair parsed as neither and one interruption destroyed **two** records — the second
        written afterwards, in full, by a healthy process:

            wrote id_a, id_b, id_c   ⏻ killed mid-id_c   then wrote id_after
            records() → ['id_a', 'id_b']        stats()['records'] → 3

        Two changes, and they answer different halves. **One `write` syscall per record** makes
        tearing rare rather than routine — the kernel is not asked to split the record into
        fourteen pieces. **A boundary repair** makes it survivable when it happens anyway: a file
        that does not end in a newline gets one before the next record, so the damage stays the one
        record it started as. ⚠️ Neither pretends to be power-loss durability, which needs `fsync`
        and is a separate decision with its own cost — see `EVIDENCE_INTEGRITY_REPORT.md`.
        """
        if record.written_at is None:
            record.written_at = _iso(self._clock())
        _trim_points(record, self._policy.max_points)
        line = json.dumps(record.to_dict(), separators=(",", ":"), sort_keys=True)
        payload = (line + "\n").encode("utf-8")
        with self._lock:
            # ⚠️ `O_APPEND`, so every write lands at the end regardless of the offset — two writers
            # cannot interleave a record into the middle of another's.
            # ⚠️ `O_RDWR`, not `O_WRONLY`: the boundary check `pread`s the last byte, and a
            # write-only descriptor refuses that with `EBADF` — which `drain_pending` would have
            # contained as a storage failure, losing every record while reporting a disk fault.
            handle = os.open(self._path(record.tenant_id), os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o644)
            try:
                if _unterminated(handle):
                    # ⭐ Close the wound rather than write into it. The partial record stays damaged
                    # and is reported by the next read; this one is intact.
                    payload = b"\n" + payload
                _write_all(handle, payload)
            finally:
                os.close(handle)

    # --- reads -------------------------------------------------------------------

    def records(
        self,
        tenant_id: str,
        *,
        camera_id: Optional[str] = None,
        identity_id: Optional[str] = None,
        stream_id: Optional[str] = None,
    ) -> List[TrackHistoryRecord]:
        """Stored records for one tenant, narrowed **while scanning** by camera, identity and stream.

        ⛔ **The filter used to run after `_read` had built everything.** A query for one camera still
        materialised every record in the tenant's file, with every `HistoryPoint` inside it, and threw
        almost all of them away. Found by the P-11 soak: the two Behaviour API endpoints were the only
        operations whose latency grew, and they grew in step with the store —

            behaviour-primitives   330 → 417 → 521 → 608 ms   (store 10 → 39.7 MB)
            behaviour-timeline     323 → 414 → 506 → 589 ms
            everything else        flat to within 2 ms

        — at roughly 273k short-lived objects per call, a hundred calls an hour. That churn was a
        third of the runtime's residual memory climb, and the latency is a customer-facing defect in
        its own right: the Behaviour API is what an investigation polls.

        ⭐ Same class as the `stats()` defect above, which is why both are fixed the same way: **ask
        the file only for what was asked of it.** A record is one line, so the filter is decided on
        the parsed dict — cheap, and no `HistoryPoint` is constructed for a record nobody wants.
        """
        with self._lock:
            return self._read(
                tenant_id, camera_id=camera_id, identity_id=identity_id, stream_id=stream_id
            )[0]

    def records_with_integrity(
        self,
        tenant_id: str,
        *,
        camera_id: Optional[str] = None,
        identity_id: Optional[str] = None,
        stream_id: Optional[str] = None,
    ) -> Tuple[List[TrackHistoryRecord], IntegrityReport]:
        """The same scan as `records`, keeping what it could not parse instead of discarding it.

        ⭐ **Free.** The parse happens either way; only the report is retained. That is the whole
        reason damage is counted here and not on the `/metrics` path, where it would cost 251.7 ms
        per scrape at the retention cap against a 13.8 ms line count.
        """
        with self._lock:
            found, integrity = self._read(
                tenant_id, camera_id=camera_id, identity_id=identity_id, stream_id=stream_id
            )
            # ⚠️ Cumulative and monotonic, so a deployment can alarm on corruption without anyone
            # having to run a query first. A *gauge* here would be a lie — this store never scans
            # the file except when asked, so it cannot know the current damage, only what it has met.
            self._damaged_seen += integrity.damaged_lines
            return found, integrity

    def _count(self, tenant_id: str) -> int:
        """How many complete records one tenant's file holds, **without deserialising any of them**.

        ⛔ **`stats()` used to answer this with `len(self._read(tenant_id))`.** That is correct and it
        is what the `inference_track_history_records` gauge is built from, so every `/metrics` scrape
        rebuilt the entire durable history as Python objects. Found by the P-11 soak, whose inference
        container climbed 33 MB/h at R²=0.787 — measured on the running deployment at 713 records:

            /metrics          148 ms      (a 404 on the same server: 0.6 ms)
            full parse         65 ms      35,889 HistoryPoints constructed
            newline count     9.3 ms      nothing allocated

        Two defects in one line. The cost grows linearly with retained history — around 0.85 s per
        scrape at the 4096-record cap, on an endpoint a customer's Prometheus hits every 15 s — and
        the ~36k short-lived objects per scrape inflate the allocator, so resident size climbs and
        never comes back. ⭐ The soak's memory measurement was substantially an artefact of the soak's
        own scraping: the instrument was causing what it reported.

        The class docstring justifies whole-file reads with "queries are rare (an investigation, a
        report)". That is true of `records()`, which is the branch it was written about. It was never
        true of the metrics path.

        ⚠️ Counts `b"\\n"`, so a truncated final line — the documented cost of an append-only file
        whose writer was killed — is not counted, which is exactly how `_read` treats it. The one
        divergence is a blank line, which `_read` skips and this counts; `write` never produces one.
        """
        path = self._path(tenant_id)
        if not os.path.exists(path):
            return 0
        total = 0
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(1 << 20)
                if not chunk:
                    break
                total += chunk.count(b"\n")
        return total

    def _read(
        self,
        tenant_id: str,
        *,
        camera_id: Optional[str] = None,
        identity_id: Optional[str] = None,
        stream_id: Optional[str] = None,
    ) -> Tuple[List[TrackHistoryRecord], IntegrityReport]:
        """Parse one tenant's file, constructing **only** the records the caller asked for.

        ⚠️ The filter is applied to the parsed dict, before `from_dict`. That ordering is the whole
        point: `from_dict` builds a `HistoryPoint` for every observation in the record — up to 512 of
        them — so deciding afterwards costs the full price of an answer that is then discarded.

        ⛔ **Damage is counted, not swallowed.** The line that cannot be parsed is still skipped —
        failing the whole query would lose an investigation to one unlucky shutdown — but the count
        comes back with the answer. A read that quietly returned four records where five were written
        is the `CORRUPTED`-as-`ABSENT` collapse, and it is the one that reads as reassuring.
        """
        path = self._path(tenant_id)
        if not os.path.exists(path):
            return [], IntegrityReport()
        out: List[TrackHistoryRecord] = []
        damaged = 0
        first_damaged: Optional[int] = None
        needles = [
            needle
            for needle in (
                _needle("streamId", stream_id),
                _needle("identityId", identity_id),
                _needle("cameraId", camera_id),
            )
            if needle is not None
        ]
        with open(path, "r", encoding="utf-8") as handle:
            for number, line in enumerate(handle, start=1):
                text = line.strip()
                if not text:
                    continue
                # ⭐ **Shape-checked before the needle filter, so damage is never filtered away.**
                #
                # ⛔ The pre-filter narrows by substring, and a truncated line usually contains none
                # of the needles — so a stream-scoped read would have skipped it and reported clean
                # while the file was damaged, which is the collapse this whole method exists to
                # prevent. A complete record always ends in `}` (`json.dumps` of a dict), so this
                # costs one character comparison and catches truncation, which is the damage an
                # interrupted write actually produces.
                #
                # ⚠️ **A damaged line cannot be attributed to a stream**, because attributing it
                # would need the parse that just failed. So a filtered read reports *that this
                # tenant's history is damaged*, never *that this analysis lost a record* — and the
                # honest way to say it is the count, with no claim about whose it was.
                if not text.endswith("}"):
                    damaged += 1
                    first_damaged = number if first_damaged is None else first_damaged
                    continue
                if needles and not all(needle in text for needle in needles):
                    continue
                try:
                    raw = json.loads(text)
                    if camera_id is not None and raw.get("cameraId") != camera_id:
                        continue
                    if identity_id is not None and raw.get("identityId") != identity_id:
                        continue
                    if stream_id is not None and raw.get("streamId") != stream_id:
                        continue
                    out.append(TrackHistoryRecord.from_dict(raw))
                except (ValueError, KeyError, TypeError):
                    # ⚠️ Still skipped — failing the whole query would lose an investigation to one
                    # unlucky shutdown — but no longer silent. The count travels back with the answer
                    # so the caller can say `CORRUPTED` rather than nothing at all.
                    damaged += 1
                    first_damaged = number if first_damaged is None else first_damaged
                    continue
        return out, IntegrityReport(damaged_lines=damaged, first_damaged_line=first_damaged)

    # --- lifecycle ---------------------------------------------------------------

    def erase_tenant(self, tenant_id: str) -> int:
        with self._lock:
            path = self._path(tenant_id)
            if not os.path.exists(path):
                return 0
            count = len(self._read(tenant_id)[0])
            os.remove(path)
            return count

    def purge(self, *, now: Optional[float] = None) -> int:
        moment = self._clock() if now is None else now
        removed = 0
        with self._lock:
            for tenant in self._tenants():
                records = self._read(tenant)[0]
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
                # ⛔ `_count`, never `_read`. See `_count` — this gauge is on the /metrics path.
                #
                # ⚠️ **This is a count of candidate lines, not of readable records**, and the two can
                # differ when the file is damaged. Making it authoritative would mean parsing on
                # every scrape: 251.7 ms against 13.8 ms at the retention cap, on an endpoint hit
                # every 15 s. The parse-verified number is what a read returns, and the difference
                # between them is `damagedRecordsSeen` — published rather than left as an
                # unexplained discrepancy between a dashboard and an investigation.
                "records": sum(self._count(t) for t in tenants),
                "damagedRecordsSeen": self._damaged_seen,
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
        #: Identities whose durable write failed. ⛔ Named, not just counted — see `drain_pending`.
        self._lost_identities: List[str] = []

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
                    # ⛔ **Rounded here, once, to exactly what the store will hold.**
                    #
                    # `to_dict` has always rounded to `STORED_PRECISION` on the way out, and the
                    # in-memory point kept full precision — so a live read and a durable read of the
                    # *same observation* derived from different coordinates. Measured across a
                    # restart: `directionDegrees` moved 309.1818 → 306.8699 and
                    # `pathLengthNormalized` 0.000006 → 0.000009 on a near-stationary object, where
                    # the whole displacement is ~1e-5 and a 1e-6 rounding is a ten-percent
                    # perturbation. `samples` and `durationSeconds` were identical, so nothing was
                    # lost — the two paths simply disagreed in the seventh decimal.
                    #
                    # ⚠️ Rounding at the storage boundary is right; **two precisions for one fact**
                    # is the defect. Doing it at observation makes the live record bit-identical to
                    # the durable one by construction, rather than by both sides remembering to.
                    bbox=(
                        round(float(bbox[0]), STORED_PRECISION),
                        round(float(bbox[1]), STORED_PRECISION),
                        round(float(bbox[2]), STORED_PRECISION),
                        round(float(bbox[3]), STORED_PRECISION),
                    ),
                    track_id=track_id,
                    label=label,
                    confidence=round(float(confidence), STORED_PRECISION),
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
        frame_index: Optional[int] = None,
    ) -> bool:
        """Attach zone membership to one of an identity's observations.

        ⚠️ The single-subject form, for a caller that resolves membership **with** the frame rather
        than after it — the batch analyzer holding its own geometry, and the tests. Anything echoing
        membership back from a previous frame must use `settle_zones` instead, because only that can
        say what the *other* subjects on that frame were doing.

        Returns `False` when there is no such point.
        """
        from dataclasses import replace  # noqa: WPS433 - local, one call site

        with self._lock:
            bucket = self._live.get((tenant_id, camera_id, stream_id))
            record = None if bucket is None else bucket.get(identity_id)
            if record is None or not record.points:
                return False
            zones = tuple(str(z) for z in zone_ids)
            if frame_index is None:
                record.points[-1] = replace(record.points[-1], zone_ids=zones, zones_settled=True)
                return True
            # Newest first: an echo is normally one or two frames behind, so this scan ends
            # immediately. Bounded by `max_points` in the worst case.
            for offset in range(len(record.points) - 1, -1, -1):
                if record.points[offset].frame_index == frame_index:
                    record.points[offset] = replace(
                        record.points[offset], zone_ids=zones, zones_settled=True
                    )
                    return True
            return False

    def settle_zones(
        self,
        *,
        tenant_id: str,
        camera_id: str,
        stream_id: Optional[str],
        frame_index: int,
        memberships: Mapping[str, Sequence[str]],
        zone_version: Optional[int] = None,
    ) -> Tuple[int, int]:
        """⭐ **Decide zone membership for one whole frame** (ADR-0053).

        Every observation recorded at `frame_index` on this stream is marked settled: the identities
        named in `memberships` get the zones they were found inside, and **every other identity on
        that frame gets an explicitly empty set**.

        ⛔ That last clause is the point of this method existing at all. Membership is resolved after
        inference answers, so it arrives a frame late; an unsettled point read as "outside every zone"
        would close a zone visit and emit a `left` transition — every frame, for as long as the echo
        lags. Deciding the frame rather than the subject is what makes "inside nothing" a statement
        somebody made rather than something inferred from silence.

        Returns `(points settled, memberships with no matching observation)`. ⚠️ A miss is a real and
        expected outcome — the frame may have been trimmed by `max_points`, or the identity retired
        between the frame and its echo — so it is counted rather than raised.
        """
        from dataclasses import replace  # noqa: WPS433 - local, one call site

        wanted = {identity: tuple(str(z) for z in zones) for identity, zones in memberships.items()}
        settled = 0
        matched: set = set()
        with self._lock:
            bucket = self._live.get((tenant_id, camera_id, stream_id))
            if bucket is None:
                return 0, len(wanted)
            for identity, record in bucket.items():
                zones = wanted.get(identity, ())
                for offset in range(len(record.points) - 1, -1, -1):
                    point = record.points[offset]
                    if point.frame_index != frame_index:
                        # Points are appended in frame order, so anything older than the target
                        # cannot become it. Stops the scan at the first point that is too old.
                        if point.frame_index < frame_index:
                            break
                        continue
                    record.points[offset] = replace(point, zone_ids=zones, zones_settled=True)
                    settled += 1
                    if identity in wanted:
                        matched.add(identity)
                    if zone_version is not None:
                        record.zone_version = int(zone_version)
                    break
        return settled, len(wanted) - len(matched)

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

    def retire_all(self) -> int:
        """Close every open identity on **every** stream and write them. Returns how many.

        ⛔ **The Evidence Integrity fix, and the loss it repairs was measured before it was written.**
        On the deployed stack, `docker restart` of the runtime destroyed three live identities and
        the durable record count did not move by one:

            BEFORE   live_identities=3  records=5214  write_failures=0
            AFTER    live_identities=0  records=5214  write_failures=0

        `write_failures` stayed at zero because **nothing was ever attempted**. The behaviour read
        collapsed from `{carried: 3, picked: 3, observed: 5}` to `{observed: 2}`, and no field
        anywhere said evidence had been lost.

        ⚠️ The runtime already shuts down gracefully — `app.py` stops the heartbeat, drains sessions
        and closes the HTTP server inside a 20-second grace period it never needed. It simply never
        flushed history. `retire_stream` and `drain_pending` have both existed since track history
        became durable; nothing called them when the process was asked to stop.

        ⭐ **Retiring without draining would be the same loss with an extra step**, because
        `retire_stream` only moves records to `_pending`. The drain is part of the operation, not a
        courtesy the caller has to remember, and it happens **outside** the lock for the reason
        `drain_pending` documents.
        """
        with self._lock:
            keys = list(self._live)
        retired = 0
        for key in keys:
            retired += self.retire_stream(tenant_id=key[0], camera_id=key[1], stream_id=key[2])
        # ⚠️ Drained even when nothing was retired here: a record queued by an earlier `retire_stale`
        # and not yet drained is exactly as lost as one still live, and shutdown is the last chance.
        self.drain_pending()
        return retired

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
                    # ⛔ **Which identity, not just how many.** A count says evidence was destroyed;
                    # it does not say whose. A read for that identity returns `[]`, which is byte for
                    # byte what a read for somebody who was never in the footage returns — `LOST`
                    # presenting as `ABSENT`, the collapse that turns "we had this and destroyed it"
                    # into "this never happened". Only one of those two is comfortable, and it is
                    # the wrong one.
                    if len(self._lost_identities) < LOST_IDENTITIES_MAX:
                        self._lost_identities.append(record.identity_id)
        return written

    # --- reads -------------------------------------------------------------------

    def live_records(
        self, tenant_id: str, camera_id: str, stream_id: Optional[str] = None
    ) -> List[TrackHistoryRecord]:
        """Open records for one stream, oldest identity first."""
        with self._lock:
            bucket = self._live.get((tenant_id, camera_id, stream_id), {})
            return list(bucket.values())

    def find_live(
        self,
        tenant_id: str,
        *,
        camera_id: Optional[str] = None,
        stream_id: Optional[str] = None,
        identity_id: Optional[str] = None,
    ) -> List[TrackHistoryRecord]:
        """Open records matching a query, across cameras and streams.

        ⚠️ The query form of `live_records`, which needs a camera and a stream. An investigation asks
        "what happened in this analysis" without knowing which cameras it touched, and a caller forced
        to enumerate cameras would quietly answer for the ones it happened to know about.

        ⚠️ **Open records are not finished ones.** Every interval they carry is still running, so any
        duration derived from them is a lower bound. The caller reports how many were live for exactly
        that reason.
        """
        with self._lock:
            out: List[TrackHistoryRecord] = []
            for (tenant, camera, stream), bucket in self._live.items():
                if tenant != tenant_id:
                    continue
                if camera_id is not None and camera != camera_id:
                    continue
                if stream_id is not None and stream != stream_id:
                    continue
                for identity, record in bucket.items():
                    if identity_id is None or identity == identity_id:
                        out.append(record)
            return out

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
                # ⛔ Bounded at `LOST_IDENTITIES_MAX`, so `writeFailures` can exceed this length —
                # which is itself the honest reading: "at least these, and this many in total".
                "lostIdentities": list(self._lost_identities),
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


def _unterminated(fd: int) -> bool:
    """Whether the file's last byte is something other than a newline.

    ⚠️ True only for a file left mid-record by a killed writer — `write` always ends with `\\n`, so a
    healthy file never answers yes. An empty file answers no: there is no wound to close.
    """
    size = os.fstat(fd).st_size
    if size == 0:
        return False
    return os.pread(fd, 1, size - 1) != b"\n"


def _write_all(fd: int, payload: bytes) -> None:
    """Write every byte, looping over short writes.

    ⚠️ `os.write` may return having written fewer bytes than it was given, and a caller that ignored
    the return value would silently truncate exactly the large records this exists to protect.
    """
    view = memoryview(payload)
    while view:
        view = view[os.write(fd, view) :]


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
