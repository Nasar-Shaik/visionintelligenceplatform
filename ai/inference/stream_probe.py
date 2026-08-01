"""Stream validation — open a source, read a few frames, report exactly what was observed (P-2).

**This is a measurement, not perception.** No session is created, no capability runs, no inference
happens, nothing is persisted. It exists in the runtime for the same reason ONVIF discovery does: the
runtime owns the decode path and is the only component that can actually open an RTSP stream. The
camera service owns onboarding and lifecycle, and calls this through a port (ADR-0023, ADR-0024).

Two properties carry the whole module:

1. **It reports a check list, not a boolean** (Architect P-2 rec 3/7). The checks are ordered and each
   depends on the previous one, so a failure leaves the rest `not-executed` rather than `fail`. An
   installer told "connection failed" re-runs cable; one told "reachable, credentials rejected,
   stream not attempted" fixes a password. That difference is the point of the whole endpoint.

2. **Every result carries its `evidenceClass`** (AI-5e). A probe of a simulated source returns
   `simulated`; the camera service refuses to call a camera `connected` on that, however good the
   numbers look. Without this a demo environment reports a fully connected estate that does not
   exist.

Stdlib-only and deterministic: the source is injected, so the unit tests probe a
`SimulatedStreamSource` and never touch a network.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from statistics import pstdev
from typing import Callable, Dict, List, Optional

from errors import ConfigurationFailure, ConnectionFailure
from stream_source import build_source, redact_uri

# The ordered checks. Order IS the contract: each depends on the one before it.
CHECK_ORDER = (
    "reachability",
    "authentication",
    "stream-open",
    "frames-received",
    "codec",
    "resolution",
    "fps",
    "latency",
    "jitter",
)

PASS, FAIL, WARN, NOT_EXECUTED = "pass", "fail", "warn", "not-executed"

# Substrings that mean "the device rejected who you say you are" rather than "the device is not
# there". FFmpeg/OpenCV surface this as free text, so this is pattern-matching on error strings and
# is deliberately conservative: an unrecognised failure reports `not-executed` for authentication
# rather than guessing, because a wrong diagnosis costs more than an absent one.
_AUTH_MARKERS = ("401", "unauthorized", "authentication", "auth failed", "403", "forbidden")

# Below this, a stream is technically working but will cost more than it should to analyze.
_LOW_FPS_WARN = 1.0


@dataclass
class ProbeCheck:
    """One ordered check. `measured` is what the installer sees next to the tick."""

    name: str
    status: str
    measured: Optional[str] = None
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {"name": self.name, "status": self.status}
        if self.measured is not None:
            out["measured"] = self.measured
        if self.detail is not None:
            out["detail"] = self.detail
        return out


@dataclass
class ProbeReport:
    """The measured result of one probe. Mirrors the `StreamProbeResult` contract."""

    evidence_class: str
    reachable: bool = False
    frames_read: int = 0
    connect_ms: Optional[float] = None
    first_frame_ms: Optional[float] = None
    jitter_ms: Optional[float] = None
    resolution: Optional[str] = None
    fps: Optional[float] = None
    codec: Optional[str] = None
    authentication: str = "unknown"
    profiles: List[dict] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    error: Optional[str] = None
    checks: List[ProbeCheck] = field(default_factory=list)
    probed_at: str = ""

    def to_dict(self) -> dict:
        out: dict = {
            "probedAt": self.probed_at,
            "evidenceClass": self.evidence_class,
            "reachable": self.reachable,
            "framesRead": self.frames_read,
            "authentication": self.authentication,
            "checks": [c.to_dict() for c in self.checks],
            "profiles": self.profiles,
            "warnings": self.warnings,
        }
        for key, value in (
            ("connectMs", self.connect_ms),
            ("firstFrameMs", self.first_frame_ms),
            ("jitterMs", self.jitter_ms),
            ("resolution", self.resolution),
            ("fps", self.fps),
            ("codec", self.codec),
            ("error", self.error),
        ):
            if value is not None:
                out[key] = round(value, 3) if isinstance(value, float) else value
        return out


def _evidence_for(source_type: str) -> str:
    """Reuse the certification module's mapping — one table, so a source cannot mean two things."""
    from certification import evidence_for_source  # noqa: WPS433 - local, avoids an import cycle

    return evidence_for_source(source_type)


def _looks_like_auth_failure(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in _AUTH_MARKERS)


def _finalize(checks: List[ProbeCheck], detail: str) -> List[ProbeCheck]:
    """Mark every check the probe never reached as `not-executed`, then sort into `CHECK_ORDER`.

    Two jobs, both load-bearing. The `not-executed` fill is what makes the report diagnostic rather
    than accusatory: once reachability fails, the codec was not wrong — it was never looked at.

    The sort is what makes the report *readable*. Checks are computed in whatever order is cheapest
    (resolution falls out of the last frame; latency needs the first), and an installer reading a
    list that reorders itself depending on how far the probe got cannot scan it. `CHECK_ORDER` is
    the order of causation, so the first failure in the list is always the thing to fix.
    """
    seen = {c.name for c in checks}
    for name in CHECK_ORDER:
        if name not in seen:
            checks.append(ProbeCheck(name=name, status=NOT_EXECUTED, detail=detail))
    return sorted(checks, key=lambda c: CHECK_ORDER.index(c.name))


def probe_stream(
    config: Dict,
    *,
    frames: int = 3,
    timeout_seconds: float = 8.0,
    build: Optional[Callable[[Dict], object]] = None,
    clock: Callable[[], float] = time.monotonic,
    now: Optional[Callable[[], str]] = None,
) -> ProbeReport:
    """Open the configured source, read up to `frames` frames, and report what was observed.

    `build` and `clock` are injected so the unit tests run a deterministic simulated source with a
    fake clock — no network, no camera, no sleeping.

    `build` defaults to `None` and resolves to the module-level `build_source` at call time, rather
    than being bound as a default argument. A default argument is captured when the function is
    defined, which would make the seam unpatchable from the outside and force a test-only branch
    into the endpoint — the thing this indirection exists to avoid.
    """
    build = build or build_source
    from datetime import datetime, timezone  # noqa: WPS433 - local, keeps import cost off the server

    timestamp = now() if now else datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    source_type = str(config.get("type", "")).strip()
    report = ProbeReport(evidence_class=_evidence_for(source_type), probed_at=timestamp)
    checks: List[ProbeCheck] = []

    # --- build ---------------------------------------------------------------------------------
    try:
        source = build(config)
    except ConfigurationFailure as exc:
        report.error = str(exc)
        checks.append(ProbeCheck("reachability", FAIL, detail=str(exc)))
        report.checks = _finalize(checks, "not attempted — the configuration is not usable")
        return report

    uri = str(config.get("uri", ""))
    started = clock()

    # --- open ----------------------------------------------------------------------------------
    try:
        source.open()
    except (ConnectionFailure, OSError) as exc:
        message = redact_uri(str(exc))
        report.error = message
        report.connect_ms = (clock() - started) * 1000.0
        if _looks_like_auth_failure(message):
            # The device is there and said no. Reachability passed; the credentials are the problem.
            report.reachable = True
            report.authentication = "failed"
            checks.append(ProbeCheck("reachability", PASS, detail="the device answered"))
            checks.append(ProbeCheck("authentication", FAIL, detail=message))
            report.checks = _finalize(checks, "not attempted — the device rejected the credentials")
        else:
            checks.append(ProbeCheck("reachability", FAIL, detail=message))
            report.checks = _finalize(checks, "not attempted — the device could not be reached")
        return report

    report.reachable = True
    report.connect_ms = (clock() - started) * 1000.0
    checks.append(
        ProbeCheck("reachability", PASS, measured=f"{report.connect_ms:.0f} ms", detail="the device answered")
    )
    # Opening a stream the device gated on credentials proves the credentials were accepted. When no
    # credentials were supplied the stream is simply open — that is not an authentication result, and
    # claiming one would be inventing a measurement.
    if config.get("_credentialed"):
        checks.append(ProbeCheck("authentication", PASS, detail="the device accepted the credentials"))
        report.authentication = "ok"
    else:
        checks.append(
            ProbeCheck("authentication", NOT_EXECUTED, detail="no credentials were supplied")
        )
    checks.append(ProbeCheck("stream-open", PASS, detail=f"opened {redact_uri(uri)}"))

    # --- read ----------------------------------------------------------------------------------
    deadline = started + timeout_seconds
    arrivals: List[float] = []
    last_frame = None
    read_error: Optional[str] = None
    try:
        for frame in source.frames():
            # One clock read per frame: it is this frame's arrival AND the deadline check. Reading
            # twice would make the measured inter-frame interval depend on how many times the probe
            # happened to look at its watch.
            arrived = clock()
            arrivals.append(arrived)
            last_frame = frame
            if report.first_frame_ms is None:
                report.first_frame_ms = (arrived - started) * 1000.0
            report.frames_read += 1
            if report.frames_read >= frames or arrived >= deadline:
                break
    except (ConnectionFailure, OSError) as exc:
        read_error = redact_uri(str(exc))
    finally:
        try:
            source.close()
        except Exception:  # noqa: BLE001 - a failed close must not mask what was measured
            pass

    if report.frames_read == 0:
        # The device opened and then produced nothing. This is a real and common failure — a camera
        # serving a profile it cannot actually encode — and it is NOT a connection failure.
        detail = read_error or f"the stream opened but produced no frames within {timeout_seconds:.0f}s"
        report.error = detail
        checks.append(ProbeCheck("frames-received", FAIL, measured="0 frames", detail=detail))
        report.checks = _finalize(checks, "not attempted — no frame was decoded")
        return report

    checks.append(
        ProbeCheck("frames-received", PASS, measured=f"{report.frames_read} frames")
    )

    # --- measure -------------------------------------------------------------------------------
    if last_frame is not None:
        report.resolution = f"{last_frame.original_width}x{last_frame.original_height}"
        checks.append(ProbeCheck("resolution", PASS, measured=report.resolution))
    else:  # pragma: no cover - unreachable while frames_read > 0
        checks.append(ProbeCheck("resolution", NOT_EXECUTED))

    # Codec is not observable from an encoded frame without parsing it, and guessing from the source
    # type would be a declaration dressed up as a measurement. Reported as declared, or not at all.
    declared_codec = (config.get("capabilities") or {}).get("codecs") or []
    if declared_codec:
        report.codec = str(declared_codec[0])
        checks.append(
            ProbeCheck("codec", PASS, measured=report.codec, detail="declared, not verified by decode")
        )
    else:
        checks.append(
            ProbeCheck("codec", NOT_EXECUTED, detail="no codec is declared for this camera")
        )

    intervals = [(b - a) * 1000.0 for a, b in zip(arrivals, arrivals[1:])]
    if intervals:
        mean_ms = sum(intervals) / len(intervals)
        report.fps = (1000.0 / mean_ms) if mean_ms > 0 else 0.0
        report.jitter_ms = pstdev(intervals) if len(intervals) > 1 else 0.0
        fps_status = PASS if report.fps >= _LOW_FPS_WARN else WARN
        checks.append(ProbeCheck("fps", fps_status, measured=f"{report.fps:.1f} fps"))
        if fps_status == WARN:
            report.warnings.append(
                f"the stream delivered {report.fps:.1f} fps — below the {_LOW_FPS_WARN:.0f} fps floor "
                "analysis needs to be useful"
            )
        checks.append(ProbeCheck("jitter", PASS, measured=f"{report.jitter_ms:.0f} ms"))
    else:
        # One frame is enough to prove the stream works and not enough to characterise its timing.
        detail = "only one frame was read — a rate needs at least two"
        checks.append(ProbeCheck("fps", NOT_EXECUTED, detail=detail))
        checks.append(ProbeCheck("jitter", NOT_EXECUTED, detail=detail))

    if report.first_frame_ms is not None:
        checks.append(ProbeCheck("latency", PASS, measured=f"{report.first_frame_ms:.0f} ms"))

    profiles = (config.get("capabilities") or {}).get("streamProfiles") or []
    report.profiles = list(profiles)[:10]

    report.checks = _finalize(checks, "not measured by this probe")
    return report
