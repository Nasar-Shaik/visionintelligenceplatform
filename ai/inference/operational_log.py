"""Operational identity + structured logging for the live runtime (AI-5b).

Two Architect refinements meet here:

  1. **Logical session identity** (refinement 1) — a running session is identified by
     `(tenantId, cameraId, sessionId)`, NEVER by a thread id, process id, or host handle. Threads are
     an implementation detail that changes on every restart; the logical identity survives restarts,
     thread churn, and relocation to another host, so it is the only thing metrics, logs, events, and
     diagnostics are allowed to reference.
  2. **Correlated operational logging** (refinement 7) — every reconnect, recovery and failure is
     emitted as a structured record carrying `tenantId`/`cameraId`/`sessionId`/`correlationId` plus the
     failure category, its diagnostic code, and its recovery path. Troubleshooting a production
     incident then means filtering on one identity, not grepping interleaved camera logs.

Deterministic and dependency-free: the sink and clock are injected, so tests assert exact records with
no I/O. The default sink writes one JSON object per line to stderr (12-factor).
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass
from typing import Callable, List, Optional

from errors import failure_category, failure_code, recovery_path


@dataclass(frozen=True)
class SessionIdentity:
    """The logical identity of a running session — mirrors @vip/contracts `SessionIdentity`.

    Frozen: an identity is never mutated in place, so a record captured at one moment cannot be
    retroactively rewritten by a later restart.
    """

    tenant_id: str
    camera_id: str
    session_id: str
    correlation_id: Optional[str] = None

    def to_dict(self) -> dict:
        out = {
            "tenantId": self.tenant_id,
            "cameraId": self.camera_id,
            "sessionId": self.session_id,
        }
        if self.correlation_id is not None:
            out["correlationId"] = self.correlation_id
        return out

    @property
    def key(self) -> str:
        """A stable, human-readable key for metrics labels and log grepping."""
        return f"{self.tenant_id}/{self.camera_id}/{self.session_id}"


def _stderr_sink(record: dict) -> None:
    print(json.dumps(record, sort_keys=True), file=sys.stderr)


class OperationalLog:
    """Structured, identity-correlated operational logging for one session.

    Every record is `{event, level, at, tenantId, cameraId, sessionId, correlationId?, ...fields}`.
    Failure records additionally carry `category`/`code`/`recovery`, so an operator reads the
    remediation straight off the log line instead of inferring it from a message.
    """

    def __init__(
        self,
        identity: SessionIdentity,
        *,
        sink: Optional[Callable[[dict], None]] = None,
        now_iso: Optional[Callable[[], str]] = None,
        capture: bool = False,
    ) -> None:
        self._identity = identity
        self._sink = sink if sink is not None else _stderr_sink
        self._now_iso = now_iso or _now_iso
        self._records: List[dict] = [] if capture else []
        self._capture = capture

    @property
    def identity(self) -> SessionIdentity:
        return self._identity

    @property
    def records(self) -> List[dict]:
        """Captured records (only when `capture=True`) — the assertion surface for tests."""
        return list(self._records)

    def emit(self, event: str, *, level: str = "info", **fields) -> dict:
        record = {
            "event": event,
            "level": level,
            "at": self._now_iso(),
            **self._identity.to_dict(),
            **{k: v for k, v in fields.items() if v is not None},
        }
        if self._capture:
            self._records.append(record)
        self._sink(record)
        return record

    # --- the three things production always needs correlated (refinement 7) -------

    def connection(self, event: str, **fields) -> dict:
        """`stream.connecting` / `stream.connected` / `stream.lost` / `stream.reconnecting`."""
        return self.emit(event, **fields)

    def recovery(self, *, attempt: int, recovery_ms: float, reconnect_count: int) -> dict:
        return self.emit(
            "stream.recovered",
            attempt=attempt,
            recoveryMs=round(recovery_ms, 3),
            reconnectCount=reconnect_count,
        )

    def failure(self, exc: BaseException, *, event: str = "runtime.failure", **fields) -> dict:
        """Emit a categorized failure — category, stable diagnostic code, and recovery path."""
        category = failure_category(exc)
        return self.emit(
            event,
            level="error",
            category=category,
            code=failure_code(category),
            recovery=recovery_path(category),
            message=str(exc)[:1000],
            **fields,
        )


def null_log(identity: SessionIdentity) -> OperationalLog:
    """A log that discards everything — for unit tests that do not assert on logging."""
    return OperationalLog(identity, sink=lambda _record: None)


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
