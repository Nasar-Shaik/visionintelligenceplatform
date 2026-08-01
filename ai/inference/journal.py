"""Operational Diagnostics Journal + Timeline (AI-5d) — one correlated record per session.

Everything the runtime does operationally is already logged: admission and scheduling decisions in
the scheduler's `DecisionLog`, connection and lifecycle events through `OperationalLog`, recoveries
in the `RecoveryLedger`, model transitions in the lifecycle manager. What was missing is that they
are four places. Diagnosing "why did camera 17 stop producing events at 03:12?" meant correlating
four stores by hand, at 3am, under pressure.

This module merges them into **one bounded, tenant-scoped, per-session stream** (Architect AI-5d
rec 5), and renders it two ways:

  - **`journal()`** — structured entries, newest first: the machine-queryable record.
  - **`timeline()`** — oldest first, one short sentence per line: what a human reads first.

        10:02:14  Connected
        10:10:31  Queue increasing (78% full)
        10:11:02  Governor reduced FPS (queue-pressure)
        10:13:44  Health stabilized (score 86)
        10:22:07  Model upgrade started (v1.2.0 → v1.3.0)
        10:23:11  Validation passed
        10:24:00  Switch complete — 4 sessions kept running

**No new emitters.** The journal is a *sink*: it attaches to the `OperationalLog` a session already
writes to, and adapts records the scheduler and lifecycle manager already produce. Adding a second
place that generates events would recreate the exact problem this solves.

Bounded by construction — a session running for a month holds the same memory as one running for a
minute, because an unbounded diagnostic buffer is an outage waiting for a long-lived deployment.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, List, Optional

from operational_log import SessionIdentity

_JOURNAL_MAX = 200

# Mirrors @vip/contracts `DiagnosticKind`. Event-name prefix → kind, longest prefix wins.
_KIND_PREFIXES = (
    ("stream.", "connection"),
    ("scheduler.admitted", "scheduling"),
    ("scheduler.refused", "scheduling"),
    ("scheduler.released", "scheduling"),
    ("scheduler.degraded", "degradation"),
    ("scheduler.suspended", "degradation"),
    ("scheduler.recovered", "degradation"),
    ("scheduler.resumed", "degradation"),
    ("scheduler.throttled", "degradation"),
    ("scheduler.", "scheduling"),
    ("recovery.", "recovery"),
    ("model.", "model"),
    ("health.", "health"),
    ("pipeline.", "failure"),
    ("session.degradation", "degradation"),
    ("session.", "lifecycle"),
)

# Human phrasing for the timeline. Anything unlisted falls back to the event name, which keeps an
# unmapped event visible rather than silently dropping it from the operator's view.
_TIMELINE_LABELS = {
    "stream.connecting": "Connecting to source",
    "stream.connected": "Connected",
    "stream.lost": "Connection lost",
    "stream.reconnecting": "Reconnecting",
    "stream.recovered": "Stream recovered",
    "session.started": "Session started",
    "session.paused": "Session paused",
    "session.resumed": "Session resumed",
    "session.restarting": "Session restarting",
    "session.completed": "Session completed",
    "session.drained": "Source exhausted",
    "session.failed": "Session failed",
    "session.torn_down": "Session torn down",
    "session.degradation_applied": "Degradation applied",
    "scheduler.admitted": "Admitted by scheduler",
    "scheduler.refused": "Refused by scheduler",
    "scheduler.degraded": "Governor degraded the session",
    "scheduler.suspended": "Governor suspended the session",
    "scheduler.recovered": "Governor restored a capability",
    "scheduler.resumed": "Governor resumed the session",
    "scheduler.throttled": "Transition held (stabilizing)",
    "scheduler.released": "Compute released",
    "recovery.succeeded": "Recovery succeeded",
    "recovery.failed": "Recovery failed",
    "recovery.budget-exhausted": "Recovery budget exhausted",
    "recovery.operator-required": "Operator intervention required",
    "recovery.cooldown": "Recovery deferred (stabilization window)",
    "recovery.blocked-by-policy": "Recovery blocked by policy",
    "recovery.deferred": "Recovery deferred",
    "model.transition_started": "Model upgrade started",
    "model.transition_completed": "Switch complete",
    "model.transition_rolled_back": "Model rolled back",
    "model.transition_failed": "Model transition failed",
    "health.stabilized": "Health stabilized",
    "health.declining": "Health declining",
    "runtime.failure": "Runtime failure",
}

# Fields worth surfacing in a timeline sentence, in priority order. A timeline line is read at a
# glance, so it carries at most one number — the one that explains the event.
_HEADLINE_FIELDS = (
    "reason",
    "degradation",
    "toLevel",
    "trigger",
    "queueUtilization",
    "score",
    "toVersion",
    "attempt",
    "recoveryMs",
    "framesProcessed",
)


def classify(event: str) -> str:
    """Map a structured event name onto a `DiagnosticKind`."""
    for prefix, kind in _KIND_PREFIXES:
        if event.startswith(prefix):
            return kind
    return "lifecycle"


@dataclass
class DiagnosticEntry:
    """One journal entry — mirrors the `DiagnosticEntry` contract."""

    at: str
    kind: str
    event: str
    identity: SessionIdentity
    level: str = "info"
    detail: Optional[str] = None
    measurement: Dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        out: dict = {
            "at": self.at,
            "kind": self.kind,
            "event": self.event,
            "level": self.level,
            "identity": self.identity.to_dict(),
            "measurement": {k: round(float(v), 3) for k, v in sorted(self.measurement.items())},
        }
        if self.detail is not None:
            out["detail"] = self.detail
        return out


@dataclass
class TimelineEntry:
    """One rendered timeline line — mirrors the `TimelineEntry` contract."""

    at: str
    time: str
    kind: str
    label: str
    level: str = "info"

    def to_dict(self) -> dict:
        return {
            "at": self.at,
            "time": self.time,
            "kind": self.kind,
            "label": self.label,
            "level": self.level,
        }

    def render(self) -> str:
        return f"{self.time}  {self.label}"


class DiagnosticsJournal:
    """A bounded, tenant-scoped operational journal across every session.

    Keys are tenant-qualified (Law 5): one tenant can never read another's operational history, even
    when both use the same camera id — the cross-tenant case that a session-id-only key would leak.
    """

    def __init__(self, *, maxlen: int = _JOURNAL_MAX) -> None:
        self._entries: Dict[str, Deque[DiagnosticEntry]] = {}
        self._maxlen = maxlen

    @staticmethod
    def _key(identity: SessionIdentity) -> str:
        return f"{identity.tenant_id}::{identity.session_id}"

    def sink_for(self, identity: SessionIdentity) -> Callable[[dict], None]:
        """An `OperationalLog` sink that files every record into this journal.

        This is the whole integration: `OperationalLog(identity, sink=journal.sink_for(identity))`.
        The journal creates no events of its own, so there is exactly one place events are born.
        """

        def sink(record: dict) -> None:
            self.record_log(record, identity)

        return sink

    def tee(self, identity: SessionIdentity, other: Callable[[dict], None]) -> Callable[[dict], None]:
        """A sink that journals AND forwards — so capturing diagnostics never costs you your logs."""

        def sink(record: dict) -> None:
            self.record_log(record, identity)
            other(record)

        return sink

    def record_log(self, record: dict, identity: Optional[SessionIdentity] = None) -> DiagnosticEntry:
        """File one structured `OperationalLog` record."""
        event = str(record.get("event", "unknown"))
        who = identity or SessionIdentity(
            tenant_id=str(record.get("tenantId", "")),
            camera_id=str(record.get("cameraId", "")),
            session_id=str(record.get("sessionId", "")),
            correlation_id=record.get("correlationId"),
        )
        measurement = {
            key: float(value)
            for key, value in record.items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        }
        detail = _detail_from(record)
        return self._append(
            DiagnosticEntry(
                at=str(record.get("at", "")),
                kind=classify(event),
                event=event,
                identity=who,
                level=str(record.get("level", "info")),
                detail=detail,
                measurement=measurement,
            )
        )

    def record_decision(self, decision: dict) -> DiagnosticEntry:
        """File a `SchedulerDecision` dict — the scheduler already produces these; nothing new here."""
        identity = decision.get("identity") or {}
        who = SessionIdentity(
            tenant_id=str(identity.get("tenantId", "")),
            camera_id=str(identity.get("cameraId", "")),
            session_id=str(identity.get("sessionId", "")),
            correlation_id=identity.get("correlationId"),
        )
        action = str(decision.get("action", "scheduled"))
        event = f"scheduler.{action}"
        return self._append(
            DiagnosticEntry(
                at=str(decision.get("at", "")),
                kind=classify(event),
                event=event,
                identity=who,
                level="warn" if action in ("degraded", "suspended", "refused", "throttled") else "info",
                detail=decision.get("detail") or str(decision.get("reason", "")),
                measurement={
                    k: float(v) for k, v in (decision.get("measurement") or {}).items()
                },
            )
        )

    def record_recovery(self, attempt: dict) -> DiagnosticEntry:
        """File a `RecoveryAttempt` dict from the recovery ledger."""
        identity = attempt.get("identity") or {}
        who = SessionIdentity(
            tenant_id=str(identity.get("tenantId", "")),
            camera_id=str(identity.get("cameraId", "")),
            session_id=str(identity.get("sessionId", "")),
            correlation_id=identity.get("correlationId"),
        )
        outcome = str(attempt.get("outcome", "deferred"))
        event = f"recovery.{outcome}"
        return self._append(
            DiagnosticEntry(
                at=str(attempt.get("at", "")),
                kind="recovery",
                event=event,
                identity=who,
                level="error" if outcome in ("failed", "budget-exhausted") else "warn",
                detail=attempt.get("detail"),
                measurement={"attempt": float(attempt.get("attempt", 1))},
            )
        )

    def record_transition(self, transition: dict, identity: SessionIdentity) -> DiagnosticEntry:
        """File a `ModelTransition` against a session, so a model change shows on its timeline."""
        state = str(transition.get("state", "pending"))
        event = {
            "active": "model.transition_completed",
            "rolled-back": "model.transition_rolled_back",
            "failed": "model.transition_failed",
        }.get(state, "model.transition_started")
        return self._append(
            DiagnosticEntry(
                at=str(transition.get("updatedAt", "")),
                kind="model",
                event=event,
                identity=identity,
                level="warn" if state in ("rolled-back", "failed") else "info",
                detail=(
                    f"{transition.get('fromVersion') or 'none'} → {transition.get('toVersion')}"
                    + (f" ({transition['rollbackReason']})" if transition.get("rollbackReason") else "")
                ),
                measurement={"sessionsAffected": float(transition.get("sessionsAffected", 0))},
            )
        )

    def _append(self, entry: DiagnosticEntry) -> DiagnosticEntry:
        key = self._key(entry.identity)
        self._entries.setdefault(key, deque(maxlen=self._maxlen)).appendleft(entry)
        return entry

    # --- reads (tenant-scoped) --------------------------------------------------------

    def journal(
        self,
        identity: SessionIdentity,
        *,
        limit: int = 50,
        kind: Optional[str] = None,
    ) -> List[dict]:
        """Structured entries, newest first — the machine-queryable record."""
        entries = list(self._entries.get(self._key(identity), ()))
        if kind is not None:
            entries = [e for e in entries if e.kind == kind]
        return [e.to_dict() for e in entries[: max(0, limit)]]

    def timeline(self, identity: SessionIdentity, *, limit: int = 50) -> List[dict]:
        """Rendered lines, OLDEST first — a timeline is read forwards, unlike a log."""
        entries = list(self._entries.get(self._key(identity), ()))[: max(0, limit)]
        return [_to_timeline(e).to_dict() for e in reversed(entries)]

    def render(self, identity: SessionIdentity, *, limit: int = 50) -> str:
        """The timeline as plain text — what goes into an incident report."""
        return "\n".join(
            _to_timeline(e).render()
            for e in reversed(list(self._entries.get(self._key(identity), ()))[: max(0, limit)])
        )

    def count(self, identity: SessionIdentity) -> int:
        return len(self._entries.get(self._key(identity), ()))

    def forget(self, identity: SessionIdentity) -> None:
        """Release a session's journal (AI-5b refinement 8: a stopped session leaves nothing behind)."""
        self._entries.pop(self._key(identity), None)

    @property
    def sessions(self) -> int:
        return len(self._entries)


def _to_timeline(entry: DiagnosticEntry) -> TimelineEntry:
    label = _TIMELINE_LABELS.get(entry.event, entry.event)
    headline = _headline(entry)
    return TimelineEntry(
        at=entry.at,
        time=_hhmmss(entry.at),
        kind=entry.kind,
        label=f"{label} ({headline})" if headline else label,
        level=entry.level,
    )


def _headline(entry: DiagnosticEntry) -> Optional[str]:
    """At most ONE number or reason per timeline line — a line that needs parsing is not a timeline."""
    for key in _HEADLINE_FIELDS:
        if key in entry.measurement:
            value = entry.measurement[key]
            return f"{key} {value:g}"
    if entry.detail:
        return entry.detail[:80]
    return None


def _detail_from(record: dict) -> Optional[str]:
    for key in ("detail", "message", "reason", "recovery"):
        value = record.get(key)
        if isinstance(value, str) and value:
            return value[:500]
    return None


def _hhmmss(iso: str) -> str:
    """`2026-08-01T10:24:00.123Z` → `10:24:00`. Falls back to the raw value rather than guessing."""
    if "T" in iso and len(iso) >= 19:
        return iso[11:19]
    return iso or "--:--:--"
