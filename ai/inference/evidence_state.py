"""What state the evidence for one query is in — Evidence Integrity, EI-4.

⛔ **Every one of these used to be the empty list.** Measured, before this module existed:

    a stream that never existed        →  []
    a run still three seconds in       →  []
    a run whose write failed           →  []
    a file with a truncated record     →  []
    a run past its retention           →  []

Five different facts, one answer, and the answer is the reassuring one. An investigator reading an
empty timeline concludes *nothing happened* — which is right in exactly one of those five cases and
catastrophically wrong in three of them.

### ⭐ The six states, and the rule that orders them

    PRESENT              the evidence is here and complete
    NOT_YET_AVAILABLE    the run is still producing it; what you see is a lower bound
    ABSENT               there is none, and none was lost — nothing happened
    LOST                 it existed and the platform failed to keep it
    CORRUPTED            it is on disk and cannot be read
    EXPIRED              retention removed it, as promised

⚠️ **The precedence is not arbitrary.** `CORRUPTED` outranks `PRESENT` because a partial answer that
*looks* complete is more dangerous than no answer at all — four readable records out of five render
exactly like four out of four. `LOST` outranks `ABSENT` for the reason the whole module exists.

### ⛔ Why `EXPIRED` is not decided here

This layer holds records; it does not hold *runs*. Asked about a stream it has no records for, it
cannot tell "this analysis never existed" from "this analysis is older than retention" — both are
silence, and inventing a distinction from a tenant-wide purge counter would be a guess dressed as a
fact. The one party that can decide it holds the session's `finishedAt`, and a session that finished
before the retention horizon **cannot** have surviving records — a proof, not an inference.

So this returns `retention_horizon_at` as a fact alongside `absent`, and the caller that knows when
the run finished resolves the two. ⚠️ One decision, made once, in the only place both facts exist —
not the same decision made twice in two layers.

Stdlib-only, pure, deterministic. No clock beyond the one passed in, no I/O.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional, Sequence, Tuple

#: ⛔ The closed vocabulary. A seventh state is a decision, not an implementation detail — and a
#: contract test asserts this tuple is exactly what the boundary accepts, so one cannot arrive
#: unreviewed.
EVIDENCE_STATES: Tuple[str, ...] = (
    "present",
    "notYetAvailable",
    "absent",
    "lost",
    "corrupted",
    "expired",
)


@dataclass(frozen=True)
class EvidenceState:
    """The state of the evidence for one query, with the facts that decided it.

    ⚠️ The facts travel with the verdict deliberately. A state word alone is something to trust or
    disbelieve; a state word with `damagedRecords: 1` beside it is something to *check*.
    """

    state: str
    #: An operator-facing sentence. ⚠️ Says what it means for the answer, not what the code did.
    detail: str
    durable: int = 0
    live: int = 0
    damaged_records: int = 0
    lost_identities: Sequence[str] = ()
    #: ISO-8601 instant before which nothing can have survived retention. `None` when this store
    #: keeps nothing durably, so there is no horizon to speak of.
    retention_horizon_at: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {
            "state": self.state,
            "detail": self.detail,
            "durable": int(self.durable),
            "live": int(self.live),
            "records": int(self.durable) + int(self.live),
            "damagedRecords": int(self.damaged_records),
        }
        # ⚠️ Present only when non-empty, and never truncated to a count. *Which* identity was lost
        # is the fact an investigator needs; "3 identities were lost" is a status line.
        if self.lost_identities:
            out["lostIdentities"] = list(self.lost_identities)
        if self.retention_horizon_at is not None:
            out["retentionHorizonAt"] = self.retention_horizon_at
        return out


def horizon(now: float, retention_hours: float) -> str:
    """The instant before which retention guarantees nothing survives."""
    moment = datetime.fromtimestamp(now - retention_hours * 3600.0, tz=timezone.utc)
    return moment.isoformat().replace("+00:00", "Z")


def assess(
    *,
    durable: int,
    live: int,
    damaged_records: int,
    lost_identities: Sequence[str],
    retention_horizon_at: Optional[str] = None,
) -> EvidenceState:
    """Decide the state of one read from what it found and what it could not read.

    ⚠️ The order below **is** the specification. Each branch is reachable, each is tested, and the
    three rules the milestone set are structural rather than remembered:

        Corrupted must never appear as Missing  →  damage is checked before emptiness
        Lost must never be reported as Absent   →  loss is checked before emptiness
        Expired must never be reported as Lost  →  expiry is resolved by the caller, from a
                                                   `finishedAt` this layer does not have
    """
    lost = list(lost_identities)
    records = durable + live

    if damaged_records > 0:
        # ⛔ Before `present`, deliberately. Four readable records out of five render exactly like
        # four out of four, and the reader has no way to notice the fifth is gone.
        return EvidenceState(
            state="corrupted",
            detail=(
                f"{damaged_records} stored record(s) for this query could not be read. "
                f"{records} were readable and are shown. ⛔ This answer is incomplete — the "
                f"unreadable records were written by this platform and are not recoverable."
            ),
            durable=durable,
            live=live,
            damaged_records=damaged_records,
            lost_identities=lost,
            retention_horizon_at=retention_horizon_at,
        )

    if lost:
        return EvidenceState(
            state="lost",
            detail=(
                f"{len(lost)} identity(ies) were retired but could not be written to durable "
                f"storage: {', '.join(lost[:8])}. ⛔ This is evidence the platform produced and "
                f"failed to keep — not evidence that nobody was there."
            ),
            durable=durable,
            live=live,
            lost_identities=lost,
            retention_horizon_at=retention_horizon_at,
        )

    if live > 0:
        # ⚠️ Open records are still running. Every interval they carry is a lower bound, so a dwell
        # read now and read again in a minute will legitimately differ — which is a completely
        # different thing from evidence changing after a run has finished.
        return EvidenceState(
            state="notYetAvailable",
            detail=(
                f"{live} identity(ies) are still being observed, so this answer is incomplete and "
                f"every duration in it is a lower bound. ⚠️ Not a final result."
            ),
            durable=durable,
            live=live,
            retention_horizon_at=retention_horizon_at,
        )

    if records > 0:
        return EvidenceState(
            state="present",
            detail=f"{records} stored movement path(s) answered this query, complete and closed.",
            durable=durable,
            live=live,
            retention_horizon_at=retention_horizon_at,
        )

    return EvidenceState(
        state="absent",
        detail=(
            "no stored movement path matches this query. ⚠️ Nothing was found to have been lost or "
            "damaged — but this layer holds records, not runs, so it cannot tell a query about "
            "something that never happened from one about a run older than retention."
        ),
        retention_horizon_at=retention_horizon_at,
    )


def resolve_expiry(state: EvidenceState, *, finished_at: Optional[str]) -> EvidenceState:
    """Turn `absent` into `expired` when the run provably finished before the retention horizon.

    ⭐ **A proof, not an inference.** Retention removes every record written before the horizon, so a
    run that finished before it cannot have surviving records — whatever it once produced. That makes
    the empty answer explicable rather than merely empty.

    ⚠️ Only `absent` is ever upgraded. A `corrupted` or `lost` read past the horizon is still
    corrupted or lost, and calling it `expired` would excuse a defect as a policy.
    """
    if state.state != "absent" or finished_at is None or state.retention_horizon_at is None:
        return state
    finished = _seconds(finished_at)
    horizon_at = _seconds(state.retention_horizon_at)
    if finished is None or horizon_at is None or finished >= horizon_at:
        return state
    return EvidenceState(
        state="expired",
        detail=(
            f"this run finished at {finished_at}, before the retention horizon of "
            f"{state.retention_horizon_at}. ⚠️ Its movement paths were removed as the retention "
            f"policy promises — they were not lost, and this is not a claim that nothing happened."
        ),
        retention_horizon_at=state.retention_horizon_at,
    )


def _seconds(value: str) -> Optional[float]:
    try:
        text = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def lost_in_scope(
    lost: Sequence[Tuple[str, str, Optional[str], str]],
    *,
    tenant_id: str,
    camera_id: Optional[str] = None,
    stream_id: Optional[str] = None,
) -> List[str]:
    """Identities whose durable write failed, narrowed to one query's scope.

    ⚠️ Scoped, because an unrelated camera's failure must not make this analysis read `lost`. A
    state word that is wrong in the alarming direction gets ignored just as fast as one that is wrong
    in the reassuring direction.
    """
    return [
        identity
        for (tenant, camera, stream, identity) in lost
        if tenant == tenant_id
        and (camera_id is None or camera == camera_id)
        and (stream_id is None or stream == stream_id)
    ]
