"""Structured JSON logging for the runtime (TD-60, resolved in P-8 Phase 2).

**Why this exists.** P-8 Phase 1 deployed the runtime and measured its logging: one sentence at boot
and nothing ever again — `server.py` silenced per-request logging ("logs aggregated elsewhere", and
elsewhere was never built). Five requests produced zero log lines. An operator could not distinguish a
serving runtime from a wedged one without polling it, and a 4xx left no trace anywhere.

**Field names are pino's**, because the other ten services are Fastify/pino and one aggregator should
read the whole platform without a second parser: `level` is the numeric pino code, `time` is epoch
milliseconds, `msg` is the message. `service` is added so lines are attributable in a shared stream.

**Stdlib only** — the runtime's default backend has no third-party dependencies and this must not be
the thing that changes that.

### ⚠️ What is deliberately NOT logged

Per-frame lines. At 2 fps across 16 cameras `/infer` is ~32 requests a second; a line each is ~1 900
lines a minute of no information, and it buries the one line that matters. Frames are reported by the
**heartbeat** instead — a periodic summary whose absence is itself the signal that the runtime stopped.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any, Mapping, Optional

_LEVELS: Mapping[str, int] = {
    "trace": 10,
    "debug": 20,
    "info": 30,
    "warn": 40,
    "error": 50,
    "fatal": 60,
}

_lock = threading.Lock()
_min_level = 30
_service = "inference"


def configure(level: str = "info", service: str = "inference") -> None:
    """Set the threshold and the service name. An unknown level falls back to `info` rather than
    raising — a misconfigured log level must never be the reason a container will not start."""
    global _min_level, _service  # noqa: PLW0603 - module-level logger state, deliberately
    _min_level = _LEVELS.get(level.strip().lower(), 30)
    _service = service


def log(level: str, msg: str, **fields: Any) -> None:
    """Emit one JSON line. Never raises: a logger that can crash the process it observes is worse
    than no logger, and this one runs on the request path."""
    numeric = _LEVELS.get(level, 30)
    if numeric < _min_level:
        return
    record: dict[str, Any] = {
        "level": numeric,
        "time": int(time.time() * 1000),
        "service": _service,
        "msg": msg,
    }
    for key, value in fields.items():
        if value is not None:
            record[key] = value
    try:
        line = json.dumps(record, default=_safe_str)
    except Exception:  # noqa: BLE001 - ⚠️ ANY exception here, not just TypeError/ValueError. A test
        # caught this: `default=str` invokes __str__, which is arbitrary user code and can raise
        # anything at all. A logger that throws on the request path is worse than no logger.
        line = json.dumps(
            {"level": numeric, "time": record["time"], "service": _service, "msg": msg}
        )
    with _lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _safe_str(value: Any) -> str:
    """`str()` that cannot raise — `__str__` is arbitrary code and this runs on the request path."""
    try:
        return str(value)
    except Exception:  # noqa: BLE001
        return "<unrepresentable>"


def debug(msg: str, **fields: Any) -> None:
    log("debug", msg, **fields)


def info(msg: str, **fields: Any) -> None:
    log("info", msg, **fields)


def warn(msg: str, **fields: Any) -> None:
    log("warn", msg, **fields)


def error(msg: str, **fields: Any) -> None:
    log("error", msg, **fields)


class Heartbeat:
    """A periodic runtime-state line.

    ⚠️ It is emitted **whether or not anything changed**, because the useful signal is its absence: a
    runtime that has stopped pumping frames looks exactly like an idle one in the metrics, and only a
    line that should have arrived and did not tells an operator which it is.
    """

    def __init__(self, interval_seconds: float, snapshot: Any, *, name: str = "runtime heartbeat") -> None:
        self._interval = max(1.0, float(interval_seconds))
        self._snapshot = snapshot
        self._name = name
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="heartbeat", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                fields = self._snapshot()
            except Exception as exc:  # noqa: BLE001 - observability must never take the process down
                warn("heartbeat snapshot failed", error=str(exc))
                continue
            if isinstance(fields, dict):
                info(self._name, **fields)
