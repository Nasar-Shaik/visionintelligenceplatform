"""Inference Sessions (P2-2 G-3) — the first-class operational unit of the runtime.

A **session** represents ONE running inference pipeline bound to a camera + capability + model
version + engine. It is what the console monitors: a live state, a heartbeat, an immutable transition
history, and its latest metrics + health.

State machine (7 states):

    created ──start──▶ starting ──▶ running ──pause──▶ paused ──resume──▶ running
                                       │                  │
                                       └──────stop────────┴──────▶ stopped
    starting/running/paused ──(fatal)──▶ failed
    stopped/failed ──restart──▶ restarting ──▶ running

`start` and `restart` pass through the transient `starting`/`restarting` states (recorded in history)
and settle on `running`, so the 5 control actions (start/stop/pause/resume/restart) drive all 7
states. Illegal transitions raise `Conflict` (409). Tenant-scoped `(tenant_id, session_id)`.

Stdlib-only, deterministic (clock + id generator injected). `to_dict()` mirrors the @vip/contracts
`inference-session` camelCase shape (parity asserted in tests). Health is derived from state +
heartbeat freshness. This is the CONTROL PLANE for execution — pumping frames is the data plane.
"""

from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from errors import Conflict, NotFound, ValidationError

STATES = ("created", "starting", "running", "paused", "stopped", "failed", "restarting")

# action -> (allowed source states, transient state or None, final state)
_TRANSITIONS: Dict[str, tuple] = {
    "start": (("created",), "starting", "running"),
    "pause": (("running",), None, "paused"),
    "resume": (("paused",), None, "running"),
    "stop": (("running", "paused", "starting", "created"), None, "stopped"),
    "restart": (("stopped", "failed"), "restarting", "running"),
}

_DEFAULT_HEARTBEAT_TIMEOUT_S = 30.0


def _iso(now: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"


@dataclass
class Transition:
    to: str
    at: str
    from_state: Optional[str] = None
    action: Optional[str] = None
    reason: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {"from": self.from_state, "to": self.to, "at": self.at}
        if self.action is not None:
            out["action"] = self.action
        if self.reason is not None:
            out["reason"] = self.reason
        return out


@dataclass
class InferenceSession:
    session_id: str
    tenant_id: str
    camera_id: str
    capability_id: str
    state: str
    created_at: str
    updated_at: str
    model_id: Optional[str] = None
    model_version: Optional[str] = None
    engine: Optional[str] = None
    started_at: Optional[str] = None
    last_heartbeat: Optional[str] = None
    last_error: Optional[str] = None
    metrics: Optional[dict] = None
    history: List[Transition] = field(default_factory=list)

    def to_dict(self) -> dict:
        out: dict = {
            "sessionId": self.session_id,
            "tenantId": self.tenant_id,
            "cameraId": self.camera_id,
            "capabilityId": self.capability_id,
            "state": self.state,
            "health": self.health(),
            "history": [t.to_dict() for t in self.history],
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }
        for key, value in (
            ("modelId", self.model_id),
            ("modelVersion", self.model_version),
            ("engine", self.engine),
            ("startedAt", self.started_at),
            ("lastHeartbeat", self.last_heartbeat),
            ("lastError", self.last_error),
            ("metrics", self.metrics),
        ):
            if value is not None:
                out[key] = value
        return out

    def health(self, now: Optional[float] = None, timeout_s: float = _DEFAULT_HEARTBEAT_TIMEOUT_S) -> str:
        """Derive operational health from state + heartbeat freshness (deterministic given `now`)."""
        if self.state in ("stopped", "failed"):
            return "down"
        if self.state == "created":
            return "unknown"
        if self.state in ("starting", "restarting", "paused"):
            return "degraded"
        # running: healthy while heartbeats are fresh, else degraded.
        if self.last_heartbeat is None:
            return "degraded"
        if now is None:
            return "healthy"
        age = now - _parse_iso(self.last_heartbeat)
        return "healthy" if age <= timeout_s else "degraded"


class SessionManager:
    """In-memory, tenant-scoped inference-session manager (deterministic; clock/id injected)."""

    def __init__(self, clock: Callable[[], float] = time.time, id_gen: Optional[Callable[[], str]] = None) -> None:
        self._clock = clock
        self._sessions: Dict[str, InferenceSession] = {}
        counter = itertools.count(1)
        self._id_gen = id_gen or (lambda: f"ses_{next(counter)}")

    def start(
        self,
        tenant_id: str,
        *,
        camera_id: str,
        capability_id: str,
        model_id: Optional[str] = None,
        model_version: Optional[str] = None,
        engine: Optional[str] = None,
    ) -> InferenceSession:
        """Create a session (created) and drive it start → starting → running."""
        _require_tenant(tenant_id)
        if not camera_id.strip() or not capability_id.strip():
            raise ValidationError("cameraId and capabilityId are required")
        now = _iso(self._clock())
        session = InferenceSession(
            session_id=self._id_gen(),
            tenant_id=tenant_id,
            camera_id=camera_id,
            capability_id=capability_id,
            model_id=model_id,
            model_version=model_version,
            engine=engine,
            state="created",
            created_at=now,
            updated_at=now,
            history=[Transition(from_state=None, to="created", at=now)],
        )
        self._sessions[session.session_id] = session
        return self._apply(session, "start")

    def transition(self, tenant_id: str, session_id: str, action: str, *, reason: Optional[str] = None) -> InferenceSession:
        session = self.require(tenant_id, session_id)
        return self._apply(session, action, reason=reason)

    def stop(self, tenant_id: str, session_id: str) -> InferenceSession:
        return self.transition(tenant_id, session_id, "stop")

    def pause(self, tenant_id: str, session_id: str) -> InferenceSession:
        return self.transition(tenant_id, session_id, "pause")

    def resume(self, tenant_id: str, session_id: str) -> InferenceSession:
        return self.transition(tenant_id, session_id, "resume")

    def restart(self, tenant_id: str, session_id: str) -> InferenceSession:
        return self.transition(tenant_id, session_id, "restart")

    def fail(self, tenant_id: str, session_id: str, error: str) -> InferenceSession:
        """Move a starting/running/paused/restarting session to `failed` (fatal error)."""
        session = self.require(tenant_id, session_id)
        if session.state not in ("starting", "running", "paused", "restarting"):
            raise Conflict(f"cannot fail a session in state '{session.state}'")
        prev = session.state
        session.last_error = error
        session.state = "failed"
        session.updated_at = _iso(self._clock())
        session.history.append(Transition(from_state=prev, to="failed", at=session.updated_at, reason=error))
        return session

    def heartbeat(self, tenant_id: str, session_id: str, metrics: Optional[dict] = None) -> InferenceSession:
        """Record a liveness heartbeat (and optionally the latest metrics) from a running session."""
        session = self.require(tenant_id, session_id)
        if session.state != "running":
            raise Conflict(f"cannot heartbeat a session in state '{session.state}'")
        session.last_heartbeat = _iso(self._clock())
        if metrics is not None:
            session.metrics = metrics
        session.updated_at = session.last_heartbeat
        return session

    # --- reads (tenant-scoped) ---------------------------------------------------

    def get(self, tenant_id: str, session_id: str) -> Optional[InferenceSession]:
        session = self._sessions.get(session_id)
        return session if session is not None and session.tenant_id == tenant_id else None

    def require(self, tenant_id: str, session_id: str) -> InferenceSession:
        session = self.get(tenant_id, session_id)
        if session is None:
            raise NotFound(f"session '{session_id}' not found")
        return session

    def list(self, tenant_id: str, *, camera_id: Optional[str] = None, state: Optional[str] = None) -> List[InferenceSession]:
        out = [s for s in self._sessions.values() if s.tenant_id == tenant_id]
        if camera_id is not None:
            out = [s for s in out if s.camera_id == camera_id]
        if state is not None:
            out = [s for s in out if s.state == state]
        return sorted(out, key=lambda s: s.created_at)

    # --- internals ---------------------------------------------------------------

    def _apply(self, session: InferenceSession, action: str, *, reason: Optional[str] = None) -> InferenceSession:
        rule = _TRANSITIONS.get(action)
        if rule is None:
            raise ValidationError(f"unknown action '{action}'")
        allowed, transient, target = rule
        if session.state not in allowed:
            raise Conflict(f"cannot '{action}' a session in state '{session.state}' (allowed: {allowed})")
        prev = session.state
        now = _iso(self._clock())
        if transient is not None:
            session.history.append(Transition(from_state=prev, to=transient, action=action, at=now))
            prev = transient
        session.state = target
        if target == "running":
            session.last_error = None
            if session.started_at is None:
                session.started_at = now
        session.updated_at = now
        session.history.append(Transition(from_state=prev, to=target, action=action, at=now, reason=reason))
        return session


def _require_tenant(tenant_id: str) -> None:
    if not isinstance(tenant_id, str) or tenant_id.strip() == "":
        raise ValidationError("a tenantId is required (fail-closed, Law 5)")


def _parse_iso(value: str) -> float:
    """Parse the runtime's own UTC ISO stamp (`…Z`, ms) back to epoch seconds (for health freshness).
    Inverse of `_iso` (which uses `gmtime`), so `calendar.timegm` is the correct converter."""
    import calendar

    try:
        base = calendar.timegm(time.strptime(value[:19], "%Y-%m-%dT%H:%M:%S"))
        ms = int(value[20:23]) / 1000.0 if "." in value and len(value) >= 23 else 0.0
        return base + ms
    except (ValueError, IndexError):
        return 0.0
