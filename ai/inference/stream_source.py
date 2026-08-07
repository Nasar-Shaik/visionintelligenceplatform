"""Video Source stage (AI-5b) — stage 1 of AI_EXECUTION_ARCHITECTURE, now present in the AI tier.

Until AI-5b the runtime only consumed FINITE sources (`FrameDecoder` over an MP4 / in-memory frames).
A live camera is different in kind: it is **unbounded**, it **disconnects**, and it must **recover**.
This module owns exactly that — connection lifecycle, reconnect policy, and availability accounting —
and nothing else. It does not decode semantics, does not sample, and never touches perception.

**Ownership** (Architect AI-5b refinement 2 — no overlap between tiers):

    StreamSource     owns  connection · reconnect · frame acquisition   ← THIS MODULE
    StreamPipeline   owns  queue · frame lifecycle · drop policy
    VideoAnalyzer    owns  AI processing only
    SessionRunner    owns  orchestration only

So this module never queues, never drops for backpressure, and never looks at a pixel.

Two seams, deliberately separated:

  - `StreamSource` (Protocol) — **transport-neutral** (Architect AI-5b refinement 4). RTSP is simply
    the first implementation; HTTP, USB, file, WebRTC, ONVIF and cloud sources plug into the SAME
    Protocol without a line of runtime change. Nothing in this module (or downstream) may assume a
    URL scheme, a codec, or a transport.
  - `ConnectionSupervisor` — the reconnect/availability policy, which is source-independent and lives
    ABOVE the Protocol. Every source therefore gets identical recovery semantics for free.

Failure separation (refinement 3): a source raises `ConnectionFailure` and nothing else. Model,
inference, and pipeline failures belong to other tiers and are never laundered through ingestion.

Implementations here:
  - `SimulatedStreamSource` — deterministic, dependency-free, with a scriptable fault plan. This is
    how CI proves connect/drop/reconnect/backoff/availability with **no network and no camera**.
  - `FileStreamSource`      — a finite file replayed as a live source (optionally looping).
  - `OpenCvStreamSource`    — real RTSP/HTTP/USB via a LAZY `cv2` import (integration-only). One class
    covers all three because OpenCV's `VideoCapture` is itself transport-neutral.
  - `RtspStreamSource`      — the production RTSP path (AI-5e): `OpenCvStreamSource` plus profile
    selection from declared capabilities and a TCP transport default. Interchangeable with
    `SimulatedStreamSource` through configuration alone; no runtime logic knows which is active.

Credentials are NEVER logged: `redact_uri` strips userinfo, and only the redacted form reaches stats,
errors, or diagnostics. Stdlib-only at import time.
"""

from __future__ import annotations

import itertools
import os
import time
from dataclasses import dataclass
from typing import Callable, Dict, Iterator, List, Optional, Protocol, Sequence

from errors import ConfigurationFailure, ConnectionFailure, failure_code
from operational_log import OperationalLog, SessionIdentity, null_log
from video_frame import Frame

# Connection lifecycle — mirrors @vip/contracts `StreamConnectionState`.
STREAM_STATES = ("idle", "connecting", "connected", "lost", "reconnecting", "stopped", "failed")

_DEFAULT_MAX_ATTEMPTS = 10
_DEFAULT_BASE_MS = 500.0
_DEFAULT_MAX_MS = 30_000.0


def redact_uri(uri: str) -> str:
    """Strip credentials from a source locator so it is safe to log/surface (`rtsp://u:p@h/s` →
    `rtsp://***@h/s`). Transport-agnostic: it only removes userinfo, whatever the scheme."""
    if "://" not in uri:
        return uri
    scheme, _, rest = uri.partition("://")
    if "@" not in rest:
        return uri
    _, _, tail = rest.partition("@")
    return f"{scheme}://***@{tail}"


def backoff_delay_ms(
    attempt: int, *, base_ms: float = _DEFAULT_BASE_MS, max_ms: float = _DEFAULT_MAX_MS
) -> float:
    """Bounded exponential backoff for reconnect attempt `attempt` (1-based). Deterministic — no
    jitter — so the schedule is unit-testable and reproducible across runs (the platform's testing
    standard). Jitter is a fleet-scale concern (AI-5d), not a correctness one."""
    if attempt < 1:
        return 0.0
    return min(float(max_ms), float(base_ms) * (2 ** (attempt - 1)))


class StreamSource(Protocol):
    """A live video source. Transport-neutral: RTSP/HTTP/USB/file/WebRTC/ONVIF/cloud all implement
    this and nothing else. `frames()` yields until the source ends or drops (raising
    `ConnectionFailure` on loss); `close()` is always safe to call twice."""

    source_type: str
    uri: str
    source_fps: float

    def open(self) -> None: ...

    def frames(self) -> Iterator[Frame]: ...

    def close(self) -> None: ...


# --- reconnect + availability policy (source-independent) ----------------------------------------


@dataclass
class ReconnectPolicy:
    """Bounded exponential backoff with a finite budget. `max_attempts <= 0` means never reconnect."""

    max_attempts: int = _DEFAULT_MAX_ATTEMPTS
    base_ms: float = _DEFAULT_BASE_MS
    max_ms: float = _DEFAULT_MAX_MS

    def delay_ms(self, attempt: int) -> float:
        return backoff_delay_ms(attempt, base_ms=self.base_ms, max_ms=self.max_ms)

    def schedule(self, count: Optional[int] = None) -> List[float]:
        """The full backoff schedule (ms) — handy for diagnostics and for asserting policy in tests."""
        n = self.max_attempts if count is None else count
        return [self.delay_ms(i) for i in range(1, max(0, n) + 1)]


@dataclass
class _Failure:
    count: int = 0
    last_error: Optional[str] = None
    last_at: Optional[str] = None


class ConnectionSupervisor:
    """Owns ONE source's connection lifecycle: connect → read → detect loss → back off → reconnect,
    while accounting availability, reconnects, and recovery time.

    Deterministic by construction: `clock` and `sleep` are injected, so tests advance a fake clock and
    assert the exact backoff schedule with no real waiting and no network. The supervisor is
    source-independent — it manipulates the `StreamSource` Protocol only, so every transport (RTSP
    today, WebRTC tomorrow) inherits identical recovery semantics.

    It yields frames; it does NOT own them beyond that (the pipeline owns frame lifetime), and it
    never interprets pixels.
    """

    def __init__(
        self,
        source: StreamSource,
        *,
        policy: Optional[ReconnectPolicy] = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Optional[Callable[[float], None]] = None,
        now_iso: Optional[Callable[[], str]] = None,
        log: Optional[OperationalLog] = None,
    ) -> None:
        self._source = source
        self._policy = policy or ReconnectPolicy()
        self._clock = clock
        self._sleep = sleep if sleep is not None else time.sleep
        self._now_iso = now_iso or _now_iso
        # Every connection event is correlated with the LOGICAL session identity (refinements 1+7).
        self._log = log or null_log(SessionIdentity("unknown", "unknown", "unattached"))
        self.state = "idle"
        self.reconnect_count = 0
        self.frames_read = 0
        self.last_error: Optional[str] = None
        self.connected_at: Optional[str] = None
        self.last_frame_at: Optional[str] = None
        self._stopping = False
        self._started_at = self._clock()
        self._ended_at: Optional[float] = None  # frozen once terminal, so availability stops decaying
        self._connected_since: Optional[float] = None
        self._connected_seconds = 0.0
        self._lost_at: Optional[float] = None
        self._recovery_ms: List[float] = []
        self._failures: Dict[str, _Failure] = {}
        self._backoff_ms_total = 0.0

    # --- lifecycle ---------------------------------------------------------------

    @property
    def redacted_uri(self) -> str:
        return redact_uri(getattr(self._source, "uri", ""))

    def signal_stop(self) -> None:
        """Ask the frame loop to exit at its next boundary, **without releasing the decoder**.

        ⛔ Separated from `stop()` in P-9 A3, because the two must not happen at the same instant
        when the pump is on its own thread. `stop()` closed the source immediately, so a pump blocked
        inside a native `cv2.VideoCapture.read()` had its capture released underneath it — a
        use-after-free that ended the process with SIGSEGV (`double free or corruption`), reproducibly,
        on every live certification run.

        ⚠️ It had never fired before today. The synchronous executor has no second thread, and until
        `opencv-python-headless` was installed (A2) no live source could open at all — so the runtime
        had never once torn down a real decoder while a real thread was reading from it.
        """
        self._stopping = True

    def stop(self) -> None:
        """Stop and release. Idempotent.

        ⚠️ Callers running the frame loop on another thread must `signal_stop()`, join that thread,
        and only then call this — releasing the decoder is the last step, not the first.
        """
        self._stopping = True
        if self.state == "failed":
            self._finish("failed")
        else:
            self._finish("stopped")
        self._close_quietly()

    def _finish(self, state: str) -> None:
        """Enter a TERMINAL state once: settle connected-time and freeze the observation window, so
        availability/uptime are stable no matter when they are read afterwards."""
        self._settle_connected()
        self.state = state
        if self._ended_at is None:
            self._ended_at = self._clock()

    def frames(self) -> Iterator[Frame]:
        """Yield frames continuously across reconnects until stopped, the source ends cleanly, or the
        reconnect budget is exhausted (→ state `failed`, `ConnectionFailure` recorded not raised —
        ingestion degradation is reported operationally, never as a crash of the runtime)."""
        attempt = 0
        while not self._stopping:
            try:
                self._connect(reconnecting=attempt > 0)
            except ConnectionFailure as exc:
                self._record_failure("connection", exc)
                attempt += 1
                if not self._await_retry(attempt):
                    return
                continue

            attempt = 0  # a successful connect resets the budget
            try:
                for frame in self._source.frames():
                    if self._stopping:
                        break
                    self.frames_read += 1
                    self.last_frame_at = self._now_iso()
                    yield frame
            except ConnectionFailure as exc:
                self._on_loss(exc)
                attempt += 1
                if not self._await_retry(attempt):
                    return
                continue
            except Exception as exc:  # noqa: BLE001 - any source-side error IS a connection failure
                self._on_loss(ConnectionFailure(str(exc)))
                attempt += 1
                if not self._await_retry(attempt):
                    return
                continue

            # The source ended without error: a finite source is exhausted, not a failure.
            self._finish("stopped")
            self._close_quietly()
            return

    # --- internals ---------------------------------------------------------------

    def _connect(self, *, reconnecting: bool) -> None:
        self.state = "reconnecting" if reconnecting else "connecting"
        self._log.connection(
            "stream.reconnecting" if reconnecting else "stream.connecting", source=self.redacted_uri
        )
        try:
            self._source.open()
        except ConnectionFailure:
            raise
        except Exception as exc:  # noqa: BLE001 - normalize every open() error to the ingestion tier
            raise ConnectionFailure(str(exc)) from exc
        self.state = "connected"
        self.connected_at = self._now_iso()
        self._connected_since = self._clock()
        if reconnecting:
            self.reconnect_count += 1
            recovery_ms = 0.0
            if self._lost_at is not None:
                recovery_ms = max(0.0, (self._clock() - self._lost_at) * 1000.0)
                self._recovery_ms.append(recovery_ms)
                self._lost_at = None
            self._log.recovery(
                attempt=self.reconnect_count, recovery_ms=recovery_ms, reconnect_count=self.reconnect_count
            )
        else:
            self._log.connection("stream.connected", source=self.redacted_uri)

    def _on_loss(self, exc: ConnectionFailure) -> None:
        self._settle_connected()
        self.state = "lost"
        self._lost_at = self._clock()
        self._record_failure("connection", exc)
        self._log.failure(exc, event="stream.lost", source=self.redacted_uri)
        self._close_quietly()

    def _await_retry(self, attempt: int) -> bool:
        """Sleep out the backoff for `attempt`. Returns False when the budget is exhausted (terminal
        `failed`) or a stop was requested."""
        if self._stopping:
            self._finish("stopped")
            return False
        if attempt > self._policy.max_attempts:
            self._finish("failed")
            self._log.emit(
                "stream.exhausted",
                level="error",
                category="connection",
                code=failure_code("connection"),
                attempts=attempt - 1,
                source=self.redacted_uri,
            )
            return False
        delay = self._policy.delay_ms(attempt)
        self._backoff_ms_total += delay
        self.state = "reconnecting"
        self._sleep(delay / 1000.0)
        return not self._stopping

    def _settle_connected(self) -> None:
        if self._connected_since is not None:
            self._connected_seconds += max(0.0, self._clock() - self._connected_since)
            self._connected_since = None

    def _record_failure(self, category: str, exc: BaseException) -> None:
        # Messages are redacted: a source error may echo the URI back with credentials in it.
        message = redact_uri(str(exc))[:1000]
        entry = self._failures.setdefault(category, _Failure())
        entry.count += 1
        entry.last_error = message
        entry.last_at = self._now_iso()
        self.last_error = message

    def _close_quietly(self) -> None:
        try:
            self._source.close()
        except Exception:  # noqa: BLE001 - closing must never mask the real failure
            pass

    # --- observability -----------------------------------------------------------

    @property
    def uptime_seconds(self) -> float:
        """Observed wall-time. FROZEN once the source reaches a terminal state — otherwise a stopped
        session's availability would keep decaying just because time passes, which would make a
        completed run look progressively worse the later you read its stats."""
        end = self._clock() if self._ended_at is None else self._ended_at
        return max(0.0, end - self._started_at)

    @property
    def connected_seconds(self) -> float:
        live = 0.0 if self._connected_since is None else max(0.0, self._clock() - self._connected_since)
        return self._connected_seconds + live

    @property
    def availability_percent(self) -> float:
        total = self.uptime_seconds
        if total <= 0:
            return 100.0 if self.state == "connected" else 0.0
        return min(100.0, 100.0 * self.connected_seconds / total)

    @property
    def average_recovery_ms(self) -> float:
        return sum(self._recovery_ms) / len(self._recovery_ms) if self._recovery_ms else 0.0

    def record_failure(self, category: str, exc: BaseException) -> None:
        """Let the pipeline tier fold its own categorized failures (model/inference/pipeline) into the
        same per-session tally, without ingestion pretending to own them."""
        self._record_failure(category, exc)

    def stats(self) -> dict:
        """A `StreamIngestionStats`-shaped snapshot (camelCase; mirrors @vip/contracts)."""
        out: dict = {
            "state": self.state,
            "sourceType": getattr(self._source, "source_type", "simulated"),
            "source": self.redacted_uri,
            "framesRead": self.frames_read,
            "reconnectCount": self.reconnect_count,
            "availabilityPercent": round(self.availability_percent, 3),
            "averageRecoveryMs": round(self.average_recovery_ms, 3),
            "uptimeSeconds": round(self.uptime_seconds, 3),
            "failures": [
                {
                    "category": category,
                    "code": failure_code(category),
                    "count": entry.count,
                    **({"lastError": entry.last_error} if entry.last_error else {}),
                    **({"lastAt": entry.last_at} if entry.last_at else {}),
                }
                for category, entry in sorted(self._failures.items())
            ],
        }
        for key, value in (
            ("connectedAt", self.connected_at),
            ("lastFrameAt", self.last_frame_at),
            ("lastError", self.last_error),
        ):
            if value is not None:
                out[key] = value
        return out


# --- implementations ------------------------------------------------------------------------------


@dataclass
class FaultPlan:
    """A deterministic fault script for `SimulatedStreamSource` — the whole point of which is that
    connection loss, flapping, and unrecoverable sources are ORDINARY unit tests, not manual QA."""

    # Number of leading `open()` calls that fail (cold camera / wrong credentials / boot order).
    fail_opens: int = 0
    # Drop the connection after this many frames on each successful connection (None = never drop).
    drop_after_frames: Optional[int] = None
    # How many times a drop should occur before the source runs clean (None = drop every time).
    max_drops: Optional[int] = None


class SimulatedStreamSource:
    """A deterministic, dependency-free live source (`source_type='simulated'`).

    Yields synthetic frames forever (or `total_frames` of them), optionally injecting connection
    faults from a `FaultPlan`. This is the CI standard for AI-5b: reconnect, backoff, availability and
    recovery are all provable with no network, no camera, and no wall-clock.
    """

    source_type = "simulated"

    def __init__(
        self,
        *,
        uri: str = "sim://camera",
        total_frames: Optional[int] = None,
        source_fps: float = 30.0,
        width: int = 1920,
        height: int = 1080,
        faults: Optional[FaultPlan] = None,
        seed: int = 7,
    ) -> None:
        self.uri = uri
        self.source_fps = source_fps
        self._total = total_frames
        self._width = width
        self._height = height
        self._faults = faults or FaultPlan()
        self._seed = seed
        self._opens = 0
        self._drops = 0
        self._emitted = 0
        self._open = False

    def open(self) -> None:
        self._opens += 1
        if self._opens <= self._faults.fail_opens:
            raise ConnectionFailure(f"simulated connect failure #{self._opens} for {self.uri}")
        self._open = True

    def frames(self) -> Iterator[Frame]:
        if not self._open:
            raise ConnectionFailure("source is not open")
        since_connect = 0
        while self._total is None or self._emitted < self._total:
            drop_at = self._faults.drop_after_frames
            if (
                drop_at is not None
                and since_connect >= drop_at
                and (self._faults.max_drops is None or self._drops < self._faults.max_drops)
            ):
                self._drops += 1
                self._open = False
                raise ConnectionFailure(f"simulated stream loss after {since_connect} frames")
            index = self._emitted
            self._emitted += 1
            since_connect += 1
            yield Frame(
                index=index,
                timestamp=f"{round(index / self.source_fps, 6)}s",
                source_video=self.uri,
                original_width=self._width,
                original_height=self._height,
                processed_width=self._width,
                processed_height=self._height,
                sampling_rate=1.0,
                image=bytes(((self._seed + index * 31 + j) % 251 for j in range(64))),
            )
        self._open = False

    def close(self) -> None:
        self._open = False


class FileStreamSource:
    """Replay pre-decoded frames as a live source (`source_type='file'`) — optionally looping, which
    turns a short clip into a continuous stream for long-duration/stability runs without a camera."""

    source_type = "file"

    def __init__(
        self,
        frames: Sequence[Frame],
        *,
        uri: str = "file://memory",
        source_fps: float = 30.0,
        loop: bool = False,
        max_frames: Optional[int] = None,
    ) -> None:
        self._frames = list(frames)
        self.uri = uri
        self.source_fps = source_fps
        self._loop = loop
        self._max = max_frames
        self._open = False

    def open(self) -> None:
        if not self._frames:
            raise ConnectionFailure(f"no frames available from {self.uri}")
        self._open = True

    def frames(self) -> Iterator[Frame]:
        if not self._open:
            raise ConnectionFailure("source is not open")
        emitted = 0
        counter = itertools.count()
        while True:
            for frame in self._frames:
                if self._max is not None and emitted >= self._max:
                    return
                emitted += 1
                # Re-index on loop so downstream frame numbering stays monotonic (tracking depends
                # on it); the frame itself is immutable, so this produces a NEW Frame.
                index = next(counter)
                yield frame if index == frame.index else _reindex(frame, index)
            if not self._loop:
                return

    def close(self) -> None:
        self._open = False


class OpenCvStreamSource:
    """Real live capture via OpenCV (`cv2.VideoCapture`) — integration-only, LAZY import.

    One implementation covers RTSP, HTTP(S)/MJPEG, USB devices and files because `VideoCapture` is
    itself transport-neutral; `source_type` is declared by the caller, so the runtime keeps making no
    transport-specific assumption (refinement 4). Frames are JPEG-encoded so everything downstream
    stays byte-neutral (no numpy/cv2 type escapes the source seam). Read failures and end-of-stream
    are reported as `ConnectionFailure`, so the supervisor's recovery policy applies uniformly.
    """

    def __init__(
        self,
        uri: str,
        *,
        source_type: str = "rtsp",
        device_index: Optional[int] = None,
        resize_long_side: Optional[int] = None,
        jpeg_quality: int = 85,
        read_timeout_ms: float = 10_000.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.uri = uri
        self.source_type = source_type
        self.source_fps = 0.0  # discovered on open()
        self._device_index = device_index
        self._resize_long_side = resize_long_side
        self._jpeg_quality = jpeg_quality
        self._read_timeout_ms = read_timeout_ms
        self._clock = clock
        self._cap = None

    def open(self) -> None:
        import cv2  # noqa: WPS433 - HEAVY, integration-only

        target = self._device_index if self._device_index is not None else self.uri
        cap = cv2.VideoCapture(target)
        if not cap.isOpened():
            cap.release()
            # Redacted: the URI may embed camera credentials.
            raise ConnectionFailure(f"cannot open source: {redact_uri(self.uri)}")
        self.source_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0) or 30.0
        self._cap = cap

    def frames(self) -> Iterator[Frame]:
        import cv2  # noqa: WPS433 - HEAVY, integration-only

        cap = self._cap
        if cap is None:
            raise ConnectionFailure("source is not open")
        index = 0
        last_ok = self._clock()
        while True:
            ok, raw = cap.read()
            if not ok:
                # A live source that stops returning frames has dropped; a finite one has ended.
                # Both are surfaced as a connection event and resolved by the supervisor's policy.
                elapsed_ms = (self._clock() - last_ok) * 1000.0
                raise ConnectionFailure(
                    f"stream read failed after {elapsed_ms:.0f}ms: {redact_uri(self.uri)}"
                )
            last_ok = self._clock()
            oh, ow = int(raw.shape[0]), int(raw.shape[1])
            pw, ph = ow, oh
            if self._resize_long_side and max(ow, oh) > self._resize_long_side:
                scale = self._resize_long_side / float(max(ow, oh))
                pw, ph = int(ow * scale), int(oh * scale)
                raw = cv2.resize(raw, (pw, ph))
            encoded, buf = cv2.imencode(".jpg", raw, [cv2.IMWRITE_JPEG_QUALITY, self._jpeg_quality])
            if not encoded:
                continue
            yield Frame(
                index=index,
                timestamp=f"{round(index / self.source_fps, 6)}s",
                source_video=redact_uri(self.uri),
                original_width=ow,
                original_height=oh,
                processed_width=pw,
                processed_height=ph,
                sampling_rate=1.0,
                image=bytes(buf.tobytes()),
            )
            index += 1

    def close(self) -> None:
        cap, self._cap = self._cap, None
        if cap is not None:
            cap.release()


class RtspStreamSource(OpenCvStreamSource):
    """The production RTSP path (AI-5e, deliverable 2).

    **This is a named class, not a new implementation.** `OpenCvStreamSource` already carries the
    transport-neutral capture loop, so RTSP-specific behavior is exactly two things, and both are
    configuration rather than logic:

      1. **Profile paths.** A device publishes several streams (`main`, `sub`); `for_profile()` builds
         the sub-stream URI from declared capabilities, so choosing the cheap stream is a lookup and
         never a probe.
      2. **Transport preference.** RTSP-over-TCP is the default because UDP loses frames on any
         congested or wireless link, and a "flaky camera" that is really a UDP problem costs days.

    Everything else — reconnect, redaction, failure categories, frame accounting — is inherited
    unchanged. The runtime above the source seam cannot tell an `RtspStreamSource` from a
    `SimulatedStreamSource`, which is the property that lets a scenario be developed against a
    simulation and then certified against a camera with no code change (`PRODUCTION_COMPATIBILITY §1`).
    """

    def __init__(
        self,
        uri: str,
        *,
        source_type: str = "rtsp",
        transport: str = "tcp",
        resize_long_side: Optional[int] = None,
        jpeg_quality: int = 85,
        read_timeout_ms: float = 10_000.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        # The DECLARED type is preserved, not rewritten to "rtsp". An ONVIF camera streams over RTSP
        # but the operator configured `onvif`, and diagnostics must echo back what was configured —
        # the runtime dispatches on declared type and never launders it (AI-5b refinement 4).
        super().__init__(
            uri,
            source_type=source_type,
            resize_long_side=resize_long_side,
            jpeg_quality=jpeg_quality,
            read_timeout_ms=read_timeout_ms,
            clock=clock,
        )
        if transport not in ("tcp", "udp"):
            raise ConfigurationFailure(f"unsupported rtsp transport '{transport}' (tcp|udp)")
        self.transport = transport

    def open(self) -> None:
        # OpenCV reads RTSP transport preference from FFmpeg's environment, not from an API. Set it
        # only if the operator has not already expressed a preference — their explicit choice wins.
        os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", f"rtsp_transport;{self.transport}")
        super().open()

    @classmethod
    def for_profile(
        cls,
        base_uri: str,
        capabilities: Optional[dict] = None,
        *,
        profile: Optional[str] = None,
        requested_fps: float = 5.0,
        **kwargs,  # noqa: ANN003 - forwarded verbatim to __init__
    ) -> "RtspStreamSource":
        """Build a source for a named stream profile, or for the one declared `preferredForAnalysis`.

        Selection is delegated to `deployment.resolve_stream_settings()` — the same function the
        scheduler already uses — so there is exactly ONE implementation of "which stream do we
        analyze". A second copy here would eventually disagree with it, and the disagreement would
        surface as a camera that benchmarks against the sub-stream and runs against the main one.

        Falls back to `base_uri` untouched when nothing is declared: a device publishing one stream,
        or one nobody ran discovery against, must still work.
        """
        from deployment import resolve_stream_settings  # noqa: WPS433 - local, avoids an import cycle

        settings = resolve_stream_settings(
            requested_fps=requested_fps,
            capabilities=capabilities or {},
            preferred_profile=profile,
        )
        path = settings.get("streamPath")
        return cls(_join_path(base_uri, path) if path else base_uri, **kwargs)


def _join_path(base_uri: str, path: str) -> str:
    """Replace the path of `base_uri` with `path`. Query strings on the profile path are preserved;
    credentials are never introduced here (the base URI carries none — that is enforced elsewhere)."""
    if "://" not in base_uri:
        return base_uri
    scheme, remainder = base_uri.split("://", 1)
    authority = remainder.split("/", 1)[0]
    suffix = path if path.startswith("/") else f"/{path}"
    return f"{scheme}://{authority}{suffix}"


def build_source(config: dict) -> StreamSource:
    """Build a `StreamSource` from a `StreamSourceConfig` dict (the wire shape). The runtime selects
    an implementation by declared `type` ONLY — it never sniffs the URI — so a new transport is a new
    branch here and nothing else. Credentials are resolved by reference elsewhere; this function
    accepts none inline."""
    source_type = str(config.get("type", "")).strip()
    uri = str(config.get("uri", "")).strip()
    # Misconfiguration is its own category (refinement 4): fail fast for an operator instead of
    # retrying forever against a source that can never work.
    if not source_type:
        raise ConfigurationFailure("source.type is required")
    if not uri:
        raise ConfigurationFailure("source.uri is required")
    options = dict(config.get("options") or {})
    fps = config.get("targetFps")

    if source_type == "simulated":
        return SimulatedStreamSource(
            uri=uri,
            total_frames=_opt_int(options.get("totalFrames")),
            source_fps=float(fps) if fps else 30.0,
        )
    if source_type in ("rtsp", "onvif"):
        # AI-5e: RTSP and ONVIF-declared cameras both stream over RTSP, so both take the production
        # RTSP path — profile selection from declared capabilities, TCP transport by default. Still
        # selected by DECLARED type only; the URI is never sniffed.
        return RtspStreamSource.for_profile(
            uri,
            config.get("capabilities") or {},
            profile=config.get("streamProfile") or options.get("streamProfile"),
            requested_fps=float(fps) if fps else 5.0,
            source_type=source_type,
            transport=str(options.get("transport") or options.get("rtspTransport") or "tcp"),
            resize_long_side=_opt_int(options.get("resizeLongSide")),
        )
    if source_type in ("http", "usb", "file", "cloud", "webrtc"):
        return OpenCvStreamSource(
            uri,
            source_type=source_type,
            device_index=_opt_int(options.get("deviceIndex")),
            resize_long_side=_opt_int(options.get("resizeLongSide")),
        )
    raise ConfigurationFailure(f"unsupported source type '{source_type}'")


def _opt_int(value) -> Optional[int]:  # noqa: ANN001
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _reindex(frame: Frame, index: int) -> Frame:
    """Frames are immutable (Architect AI-5b refinement 1) — re-indexing produces a NEW Frame."""
    from dataclasses import replace

    return replace(frame, index=index, timestamp=f"{round(index / 30.0, 6)}s")


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
