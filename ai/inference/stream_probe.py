"""Stream validation — run a staged probe against a source and report exactly what was observed.

**This is a measurement, not perception** (P-2, deepened in P-2.1). No session is created, no
capability runs, no inference happens, nothing is persisted. It lives in the runtime for the same
reason ONVIF discovery does: the runtime owns the decode path and is the only component that can
actually open a stream. The camera service owns onboarding and lifecycle and calls this through a
port (ADR-0023, ADR-0024).

Four properties carry the module:

1. **A staged report, not a boolean.** Stages are ordered by causation, each timed individually, and
   a failure leaves every later stage `not-executed` rather than `fail`. An installer told
   "connection failed" re-runs cable; one told "DNS ok, TCP ok, credentials rejected, stream not
   attempted" fixes a password. Per-stage timing turns "the camera is slow" into "negotiation takes
   1.4s" — a different problem with a different fix.

2. **One typed failure code, mutually exclusive** (Architect P-2.1 rec 8). The *server* names the
   failure; the console renders it. A UI that infers "probably credentials" from prose is business
   logic in the wrong tier, and it will disagree with the runtime the first time a message changes.

3. **Every result carries its `evidenceClass`** (AI-5e). A probe of a simulated source returns
   `simulated`, and the camera service refuses to call a camera `connected` on that however good the
   numbers look. Without this a demo environment reports an estate that does not exist.

4. **One validation engine, many providers** (P-2.2). RTSP, HTTP, WebRTC, a recorded DVR export, an
   NVR playback file, a USB camera and an edge stream are all validated by the pipeline below;
   `register_provider` declares what stages each one has. Adding a source type is a registration, not
   a new code path, and never a change to the camera lifecycle. A stage a provider does not have is
   `skipped`, which is distinct from both `fail` and `not-executed`.

Stdlib-only and deterministic: the resolver, the connector, the source builder and the clock are all
injected, so unit tests run against a `SimulatedStreamSource` and never touch a network.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from statistics import pstdev
from typing import Callable, Dict, List, Optional, Tuple

from errors import ConfigurationFailure, ConnectionFailure
from stream_source import build_source, redact_uri

# Bump when the probe's own measurement behaviour changes — what a stage means, where a timer starts.
# Two reports are only comparable if you know whether the probe changed in between (rec 6/4).
#
# 3 (P-2.2): stage applicability moved from a pair of ad-hoc scheme checks to the validation provider
# registry below, and every report now names the provider that produced it. A simulated or USB source
# no longer runs the DNS and TCP stages — it never touched a network, and reporting those as measured
# was the probe describing work it did not do.
PROBE_VERSION = "3"

# The ordered stages. Order IS the contract: each depends on the one before it, so the first failure
# in the list is always the thing to fix.
CHECK_ORDER = (
    "dns",
    "tcp",
    "authentication",
    "rtsp-negotiation",
    "stream-open",
    "first-frame",
    "frames-received",
    "codec",
    "resolution",
    "fps",
    "stream-profile",
    "latency",
    "jitter",
)

PASS, FAIL, WARN, SKIPPED, NOT_EXECUTED = "pass", "fail", "warn", "skipped", "not-executed"

# Mutually exclusive (rec 8). Exactly one is set on a failed probe, and none on a successful one.
# Overlapping codes would defeat the purpose: the console picks one remedy, not a set of maybes.
FAILURE_CODES = (
    "configuration-invalid",
    "dns-failure",
    "tcp-failure",
    "authentication-failure",
    "rtsp-negotiation-failure",
    "codec-unsupported",
    "timeout",
    "no-first-frame",
    "stream-interrupted",
)

# --- the validation provider registry ------------------------------------------------------------


@dataclass(frozen=True)
class ValidationProvider:
    """One kind of source the pipeline can validate (P-2.2, Architect rec 1).

    **This registry is the extension mechanism, and the engine below never learns about its rows.**
    Adding SRT, an NVR playback export or an edge stream is `register_provider(...)` — never a second
    validation path. A source type with its own probe would grow its own private idea of what
    "connected" means, and two definitions of connected is exactly what the lifecycle's evidence rule
    exists to prevent.

    Deliberately *providers*, not transports: a recorded DVR export and a USB camera are not
    transports at all, and they still need validating through the same staged pipeline so their
    reports can be read side by side with an RTSP one.

    A stage a provider does not have is reported `skipped` — never `fail`, and never silently
    omitted. "This provider has no RTSP negotiation" and "negotiation did not run" are different
    facts, and a reader a year later cannot recover the difference from a missing row.
    """

    id: str
    default_port: Optional[int] = None
    #: Has an RTSP-style DESCRIBE/SETUP/PLAY step before media flows.
    negotiated: bool = False
    #: Reached over a network — has a name to resolve, a socket to open, an identity to present.
    networked: bool = True
    label: str = ""


_PROVIDERS: Dict[str, ValidationProvider] = {}


def register_provider(provider: ValidationProvider) -> ValidationProvider:
    """Register a validation provider. Idempotent by id; later registration wins."""
    _PROVIDERS[provider.id] = provider
    return provider


def providers() -> Tuple[ValidationProvider, ...]:
    """Every registered provider, id-sorted. What `/capabilities` reports and tests enumerate."""
    return tuple(sorted(_PROVIDERS.values(), key=lambda p: p.id))


for _provider in (
    ValidationProvider("rtsp", 554, negotiated=True, label="RTSP"),
    ValidationProvider("rtsps", 322, negotiated=True, label="RTSP over TLS"),
    ValidationProvider("rtmp", 1935, label="RTMP"),
    ValidationProvider("rtmps", 443, label="RTMP over TLS"),
    ValidationProvider("http", 80, label="HTTP / MJPEG"),
    ValidationProvider("https", 443, label="HTTPS / MJPEG"),
    ValidationProvider("srt", 9710, label="SRT"),
    # WebRTC signalling rides a websocket and negotiates media inside it, so there is no separate
    # RTSP-style negotiation stage to report on.
    ValidationProvider("webrtc", 443, label="WebRTC"),
    # ONVIF PullPoint is an HTTP SOAP subscription: the same stages as HTTP under a different name.
    ValidationProvider("onvif-pullpoint", 80, label="ONVIF PullPoint"),
    # Local sources. No name to resolve, no socket, no credentials presented to anything.
    ValidationProvider("recorded-video", networked=False, label="Recorded video"),
    ValidationProvider("dvr-export", networked=False, label="DVR export"),
    ValidationProvider("nvr-playback", networked=False, label="NVR playback"),
    ValidationProvider("usb-camera", networked=False, label="USB camera"),
    ValidationProvider("edge-stream", networked=False, label="Edge stream"),
    ValidationProvider("simulated", networked=False, label="Simulated source"),
    # A source nobody has declared. Reported as `unknown` rather than guessed at: the probe still
    # tries to open it, and saying so beats inventing a port and blaming the camera for not listening.
    ValidationProvider("unknown", label="Unknown"),
):
    register_provider(_provider)

# Declared source type → provider, for the source types that ARE the provider. Everything else
# resolves by scheme. Consistent with `build_source`, which selects by declared type and never sniffs.
_SOURCE_TYPE_PROVIDERS: Dict[str, str] = {
    "simulated": "simulated",
    "file": "recorded-video",
    "usb": "usb-camera",
}
_SCHEME_PROVIDERS: Dict[str, str] = {
    "rtsp": "rtsp",
    "rtsps": "rtsps",
    "rtmp": "rtmp",
    "rtmps": "rtmps",
    "http": "http",
    "https": "https",
    "srt": "srt",
    "ws": "webrtc",
    "wss": "webrtc",
    "webrtc": "webrtc",
    "onvif": "onvif-pullpoint",
}


def resolve_provider(config: Dict, scheme: str, uri: str) -> ValidationProvider:
    """Select the provider for a probe.

    Order: an explicit `provider` on the config, then the declared source type, then the URI scheme.
    Declared beats derived at every step — a DVR export and an NVR playback are byte-identical files,
    and only the caller knows which one it handed over.
    """
    declared = str(config.get("provider") or "").strip()
    if declared in _PROVIDERS:
        return _PROVIDERS[declared]
    source_type = str(config.get("type", "")).strip()
    by_type = _SOURCE_TYPE_PROVIDERS.get(source_type)
    if by_type:
        return _PROVIDERS[by_type]
    by_scheme = _SCHEME_PROVIDERS.get(scheme)
    if by_scheme:
        return _PROVIDERS[by_scheme]
    return _PROVIDERS["recorded-video" if not scheme and not uri.strip().isdigit() else "unknown"]

# Substrings that mean "the device rejected who you say you are" rather than "the device is not
# there". FFmpeg/OpenCV surface this as free text, so this is pattern-matching on error strings and
# is deliberately conservative: an unrecognised failure leaves authentication `not-executed` rather
# than guessing, because a wrong diagnosis costs more than an absent one.
_AUTH_MARKERS = ("401", "unauthorized", "authentication", "auth failed", "403", "forbidden")
# Substrings that mean the device answered but would not agree to serve this stream.
_NEGOTIATION_MARKERS = ("describe", "setup", "455", "461", "462", "500", "unsupported transport")

# Below this, a stream is technically working but will cost more than it should to analyze.
_LOW_FPS_WARN = 1.0


@dataclass
class ProbeCheck:
    """One stage. `measured` is what the installer sees next to the tick; `duration_ms` is its cost."""

    name: str
    status: str
    measured: Optional[str] = None
    detail: Optional[str] = None
    duration_ms: Optional[float] = None

    def to_dict(self) -> dict:
        out: dict = {"name": self.name, "status": self.status}
        if self.measured is not None:
            out["measured"] = self.measured
        if self.detail is not None:
            out["detail"] = self.detail
        if self.duration_ms is not None:
            out["durationMs"] = round(self.duration_ms, 3)
        return out


@dataclass
class ProbeReport:
    """The measured result of one probe. Mirrors the `StreamProbeResult` contract."""

    evidence_class: str
    #: Which registered validation provider ran. Recorded so a stored report stays readable: a
    #: `skipped` RTSP-negotiation row only makes sense once you know what kind of source it was.
    provider: str = "unknown"
    reachable: bool = False
    frames_read: int = 0
    connect_ms: Optional[float] = None
    first_frame_ms: Optional[float] = None
    total_ms: Optional[float] = None
    jitter_ms: Optional[float] = None
    resolution: Optional[str] = None
    fps: Optional[float] = None
    codec: Optional[str] = None
    authentication: str = "unknown"
    profiles: List[dict] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    error: Optional[str] = None
    failure_code: Optional[str] = None
    checks: List[ProbeCheck] = field(default_factory=list)
    probed_at: str = ""
    probe_version: str = PROBE_VERSION
    runtime_version: Optional[str] = None
    config_version: Optional[str] = None
    operator: Optional[str] = None
    correlation_id: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {
            "probedAt": self.probed_at,
            "probeVersion": self.probe_version,
            "evidenceClass": self.evidence_class,
            "provider": self.provider,
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
            ("totalMs", self.total_ms),
            ("jitterMs", self.jitter_ms),
            ("resolution", self.resolution),
            ("fps", self.fps),
            ("codec", self.codec),
            ("error", self.error),
            ("failureCode", self.failure_code),
            ("runtimeVersion", self.runtime_version),
            ("configVersion", self.config_version),
            ("operator", self.operator),
            ("correlationId", self.correlation_id),
        ):
            if value is not None:
                out[key] = round(value, 3) if isinstance(value, float) else value
        return out


# --- helpers -------------------------------------------------------------------------------------


def _evidence_for(source_type: str) -> str:
    """Reuse the certification module's mapping — one table, so a source cannot mean two things."""
    from certification import evidence_for_source  # noqa: WPS433 - local, avoids an import cycle

    return evidence_for_source(source_type)


def _looks_like_auth_failure(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in _AUTH_MARKERS)


def _looks_like_negotiation_failure(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in _NEGOTIATION_MARKERS)


def _default_port_for(scheme: str) -> Optional[int]:
    """The port this scheme's provider listens on by default, or `None` when it has none."""
    provider_id = _SCHEME_PROVIDERS.get(scheme)
    return _PROVIDERS[provider_id].default_port if provider_id else None


def split_endpoint(uri: str) -> Tuple[str, Optional[str], Optional[int]]:
    """`(scheme, host, port)` from a stream URI. Userinfo is stripped and never returned.

    Returns `(scheme, None, None)` for a URI with no authority (a file path, a device index), which
    is how the DNS and TCP stages know to report `skipped` rather than inventing a host to fail on.
    """
    if "://" not in uri:
        return "", None, None
    scheme, remainder = uri.split("://", 1)
    scheme = scheme.lower()
    authority = remainder.split("/", 1)[0]
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]
    host, port = authority, _default_port_for(scheme)
    if ":" in authority and not authority.startswith("["):
        host, _, raw_port = authority.rpartition(":")
        try:
            port = int(raw_port)
        except ValueError:
            host, port = authority, _default_port_for(scheme)
    return scheme, (host or None), port


def _default_resolve(host: str) -> List[str]:
    import socket  # noqa: WPS433 - local, only the real path needs it

    infos = socket.getaddrinfo(host, None)
    return sorted({info[4][0] for info in infos})


def _default_connect(host: str, port: int, timeout: float) -> None:
    import socket  # noqa: WPS433 - local, only the real path needs it

    with socket.create_connection((host, port), timeout=timeout):
        return None


def _rtsp_auth_challenge(host: str, port: int, path: str, timeout: float) -> str:
    """Ask the RTSP control channel whether this stream is gated on credentials.

    Returns `"required"`, `"not-required"` or `"unknown"`. Never raises — an unknown answer must
    leave the probe exactly where it was.

    ### ⛔ Why this exists (P-9 A2)

    The `authentication` stage was decided by **pattern-matching the transport's error text** for
    "401"/"unauthorized". OpenCV's FFmpeg backend writes `method DESCRIBE failed: 401 Unauthorized`
    to **stderr** and hands Python nothing, so `stream_source.open()` could only ever raise
    `cannot open source: <uri>` — no marker, no match. Measured against a credentialed fixture with
    a deliberately wrong password, the probe reported:

        authentication=not-executed  stream-open=fail  failureCode=stream-interrupted  reachable=true

    ⚠️ **A wrong password is the single most common camera installation fault**, and the report named
    every stage except the one that was wrong. An installer is sent to the stream path or the network.

    ### What this measures, and what it infers

    An unauthenticated `DESCRIBE` **measures** whether the device demands credentials — that answer
    is read off the wire, not guessed. Combined with a credentialed open that just failed, the
    conclusion "the supplied credentials were rejected" is an **inference**, and the check's detail
    says so in those words rather than asserting a certainty the probe does not have.

    ⚠️ Deliberately not implementing RTSP Digest here. Completing the handshake would turn an
    inference into a measurement, and it is protocol work inside a frozen runtime — recorded as a
    Track B follow-up instead, where a real device can justify it.
    """
    import socket  # noqa: WPS433 - local, only the real path needs it

    request = (
        f"DESCRIBE rtsp://{host}:{port}{path} RTSP/1.0\r\n"
        "CSeq: 1\r\n"
        "Accept: application/sdp\r\n"
        "User-Agent: VIP-StreamProbe\r\n\r\n"
    )
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(request.encode("ascii", "ignore"))
            # The status line is all that is needed and arrives in the first segment. Reading a
            # bounded amount keeps a device that streams SDP forever from holding the probe open.
            head = sock.recv(2048).decode("iso-8859-1", "replace")
    except OSError:
        return "unknown"
    status = head.split("\r\n", 1)[0]
    if "401" in status or "unauthorized" in status.lower():
        return "required"
    if status.startswith("RTSP/1.0 200") or " 200 " in status:
        return "not-required"
    return "unknown"


def _path_of(uri: str) -> str:
    """The path portion of a stream URI, `/` when it has none. Userinfo never reaches this."""
    if "://" not in uri:
        return "/"
    remainder = uri.split("://", 1)[1]
    slash = remainder.find("/")
    return remainder[slash:] if slash >= 0 else "/"


def _finalize(checks: List[ProbeCheck], detail: str, applicable: Tuple[str, ...]) -> List[ProbeCheck]:
    """Fill unreached stages, mark inapplicable ones `skipped`, and sort into `CHECK_ORDER`.

    Three jobs, all load-bearing:

    - **`not-executed` fill** makes the report diagnostic rather than accusatory: once DNS fails, the
      codec was not wrong — it was never looked at.
    - **`skipped`** says the provider has no such stage (P-2.2). An HTTP source has no RTSP
      negotiation, and reporting that as "not executed" would imply the probe gave up on it.
    - **The sort** makes the list scannable. Stages are computed in whatever order is cheapest, and a
      list that reorders itself depending on how far the probe got cannot be read at a glance.
    """
    seen = {c.name for c in checks}
    for name in CHECK_ORDER:
        if name in seen:
            continue
        if name not in applicable:
            checks.append(
                ProbeCheck(name, SKIPPED, detail="this source type has no such stage")
            )
        else:
            checks.append(ProbeCheck(name, NOT_EXECUTED, detail=detail))
    return sorted(checks, key=lambda c: CHECK_ORDER.index(c.name))


def _applicable_stages(
    provider: ValidationProvider, host: Optional[str], port: Optional[int]
) -> Tuple[str, ...]:
    """The stages this provider actually has — derived from the registry, not from the scheme.

    The engine asks the provider what it has; it does not know the provider's name. That is what
    makes a new provider a registration rather than a change here.
    """
    stages = list(CHECK_ORDER)
    if not provider.networked or host is None:
        # A recorded export, a USB camera or a simulated source has no endpoint to resolve, no socket
        # to open and nothing to present credentials to.
        for name in ("dns", "tcp", "authentication", "rtsp-negotiation"):
            stages.remove(name)
        return tuple(stages)
    if not provider.negotiated:
        stages.remove("rtsp-negotiation")
    if port is None:
        # A networked provider with no port to dial: the name still resolves, but there is no socket
        # stage to run. Reporting it `skipped` says that; `not-executed` would imply the probe gave up.
        stages.remove("tcp")
    return tuple(stages)


# --- the probe -----------------------------------------------------------------------------------


def probe_stream(
    config: Dict,
    *,
    frames: int = 3,
    timeout_seconds: float = 8.0,
    build: Optional[Callable[[Dict], object]] = None,
    clock: Callable[[], float] = time.monotonic,
    now: Optional[Callable[[], str]] = None,
    resolve: Optional[Callable[[str], List[str]]] = None,
    connect: Optional[Callable[[str, int, float], None]] = None,
    rtsp_challenge: Optional[Callable[[str, int, str, float], str]] = None,
    runtime_version: Optional[str] = None,
) -> ProbeReport:
    """Run the staged probe and report what was observed.

    `build`, `clock`, `resolve`, `connect` and `rtsp_challenge` are injected so unit tests run a
    deterministic simulated source with a fake clock — no network, no camera, no sleeping. They
    default to `None` and resolve at call time rather than being bound as default arguments, which
    keeps the seams patchable from outside without a test-only branch inside the endpoint.
    """
    build = build or build_source
    resolve = resolve or _default_resolve
    connect = connect or _default_connect
    rtsp_challenge = rtsp_challenge or _rtsp_auth_challenge
    from datetime import datetime, timezone  # noqa: WPS433 - local, keeps import cost off the server

    timestamp = now() if now else datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    source_type = str(config.get("type", "")).strip()
    uri = str(config.get("uri", ""))
    scheme, host, port = split_endpoint(uri)
    provider = resolve_provider(config, scheme, uri)
    applicable = _applicable_stages(provider, host, port)

    report = ProbeReport(
        evidence_class=_evidence_for(source_type),
        provider=provider.id,
        probed_at=timestamp,
        runtime_version=runtime_version,
        config_version=config.get("configVersion") or None,
        operator=config.get("operator") or None,
        correlation_id=config.get("correlationId") or None,
    )
    checks: List[ProbeCheck] = []
    overall_start = clock()

    def finish(detail: str, code: Optional[str]) -> ProbeReport:
        report.failure_code = code
        report.total_ms = (clock() - overall_start) * 1000.0
        report.checks = _finalize(checks, detail, applicable)
        return report

    # --- configuration -------------------------------------------------------------------------
    # ⭐ The probe's budget travels DOWN to the capture (P-9 A11). Without this the open is bounded
    # by the source's own 10s default, the camera service's transport ceiling fires first, and a
    # device that accepts TCP and then stalls is reported as "the stream validator is unreachable" —
    # "we could not test this camera" — instead of "this camera does not serve RTSP".
    if not (config.get("options") or {}).get("readTimeoutMs"):
        config = {**config, "options": {**(config.get("options") or {}),
                                        "readTimeoutMs": max(1000.0, timeout_seconds * 1000.0)}}
    try:
        source = build(config)
    except ConfigurationFailure as exc:
        report.error = str(exc)
        first = applicable[0] if applicable else "stream-open"
        checks.append(ProbeCheck(first, FAIL, detail=str(exc)))
        return finish("not attempted — the configuration is not usable", "configuration-invalid")

    # --- dns -----------------------------------------------------------------------------------
    if "dns" in applicable and host:
        started = clock()
        try:
            addresses = resolve(host)
        except OSError as exc:
            checks.append(
                ProbeCheck("dns", FAIL, detail=str(exc), duration_ms=(clock() - started) * 1000.0)
            )
            report.error = f"could not resolve {host}: {exc}"
            # A name that does not resolve is a DNS or hosts-file problem. Sending an installer to
            # check cabling for it wastes the visit.
            return finish("not attempted — the hostname did not resolve", "dns-failure")
        checks.append(
            ProbeCheck(
                "dns",
                PASS,
                measured=addresses[0] if addresses else host,
                duration_ms=(clock() - started) * 1000.0,
            )
        )

    # --- tcp -----------------------------------------------------------------------------------
    if "tcp" in applicable and host and port:
        started = clock()
        try:
            connect(host, port, min(timeout_seconds, 5.0))
        except OSError as exc:
            checks.append(
                ProbeCheck(
                    "tcp",
                    FAIL,
                    measured=f"{host}:{port}",
                    detail=str(exc),
                    duration_ms=(clock() - started) * 1000.0,
                )
            )
            report.error = f"cannot reach {host}:{port}: {exc}"
            # The name resolved and nothing is listening. That is a firewall, a powered-down camera,
            # or the wrong port — and it is emphatically not a credentials problem.
            return finish("not attempted — the device could not be reached", "tcp-failure")
        checks.append(
            ProbeCheck(
                "tcp",
                PASS,
                measured=f"{host}:{port}",
                duration_ms=(clock() - started) * 1000.0,
            )
        )
        report.reachable = True

    # --- open (authentication + negotiation happen inside) --------------------------------------
    open_started = clock()
    try:
        source.open()
    except (ConnectionFailure, OSError) as exc:
        message = redact_uri(str(exc))
        elapsed = (clock() - open_started) * 1000.0
        report.error = message
        report.connect_ms = elapsed
        if _looks_like_auth_failure(message):
            report.reachable = True
            report.authentication = "failed"
            checks.append(ProbeCheck("authentication", FAIL, detail=message, duration_ms=elapsed))
            return finish(
                "not attempted — the device rejected the credentials", "authentication-failure"
            )
        if "rtsp-negotiation" in applicable and _looks_like_negotiation_failure(message):
            report.reachable = True
            checks.append(
                ProbeCheck("rtsp-negotiation", FAIL, detail=message, duration_ms=elapsed)
            )
            # The device is there and authenticated, and will not serve THIS stream — usually a wrong
            # path or a profile the camera cannot encode. Different fix from either neighbour.
            return finish(
                "not attempted — the device would not serve this stream",
                "rtsp-negotiation-failure",
            )
        # ⭐ The transport said nothing useful about WHY. Ask the control channel directly rather
        # than reporting a generic open failure — see `_rtsp_auth_challenge`. This runs only on a
        # path that was already going to `stream-interrupted`, so no probe that works today changes.
        if "authentication" in applicable and scheme.startswith("rtsp") and host and port:
            gated = rtsp_challenge(host, port, _path_of(uri), min(timeout_seconds, 5.0))
            if gated == "required":
                report.reachable = True
                report.authentication = "failed"
                credentialed = bool(config.get("_credentialed"))
                checks.append(
                    ProbeCheck(
                        "authentication",
                        FAIL,
                        detail=(
                            "the device requires credentials and rejected the ones supplied"
                            if credentialed
                            else "the device requires credentials and none were supplied"
                        ),
                        duration_ms=elapsed,
                    )
                )
                return finish(
                    "not attempted — the device rejected the credentials", "authentication-failure"
                )
        checks.append(ProbeCheck("stream-open", FAIL, detail=message, duration_ms=elapsed))
        return finish("not attempted — the stream could not be opened", "stream-interrupted")

    open_ms = (clock() - open_started) * 1000.0
    report.reachable = True
    report.connect_ms = open_ms

    # Opening a stream the device gated on credentials proves the credentials were accepted. With no
    # credentials supplied the stream is simply open — that is not an authentication *result*, and
    # claiming one would be inventing a measurement.
    if "authentication" in applicable:
        if config.get("_credentialed"):
            checks.append(
                ProbeCheck(
                    "authentication",
                    PASS,
                    detail="the device accepted the credentials",
                    duration_ms=open_ms,
                )
            )
            report.authentication = "ok"
        else:
            checks.append(
                ProbeCheck("authentication", NOT_EXECUTED, detail="no credentials were supplied")
            )
    if "rtsp-negotiation" in applicable:
        checks.append(
            ProbeCheck("rtsp-negotiation", PASS, measured=f"{open_ms:.0f} ms", duration_ms=open_ms)
        )
    checks.append(
        ProbeCheck(
            "stream-open",
            PASS,
            measured=f"{open_ms:.0f} ms",
            detail=f"opened {redact_uri(uri)}",
            duration_ms=open_ms,
        )
    )

    # --- read ------------------------------------------------------------------------------------
    read_started = clock()
    deadline = read_started + timeout_seconds
    arrivals: List[float] = []
    last_frame = None
    read_error: Optional[str] = None
    timed_out = False
    try:
        for frame in source.frames():
            # One clock read per frame: it is this frame's arrival AND the deadline check. Reading
            # twice would make the measured inter-frame interval depend on how many times the probe
            # happened to look at its watch.
            arrived = clock()
            arrivals.append(arrived)
            last_frame = frame
            if report.first_frame_ms is None:
                report.first_frame_ms = (arrived - read_started) * 1000.0
            report.frames_read += 1
            if report.frames_read >= frames:
                break
            if arrived >= deadline:
                timed_out = True
                break
    except (ConnectionFailure, OSError) as exc:
        read_error = redact_uri(str(exc))
    finally:
        try:
            source.close()
        except Exception:  # noqa: BLE001 - a failed close must not mask what was measured
            pass

    if report.frames_read == 0:
        # The device opened and then produced nothing — a real and common failure (a camera serving a
        # profile it cannot actually encode). It is NOT a connection failure, and calling it one
        # sends someone to the network for a device problem.
        detail = read_error or f"the stream opened but produced no frames within {timeout_seconds:.0f}s"
        report.error = detail
        checks.append(ProbeCheck("first-frame", FAIL, measured="0 frames", detail=detail))
        code = "timeout" if read_error is None else "no-first-frame"
        return finish("not attempted — no frame was decoded", code)

    checks.append(
        ProbeCheck(
            "first-frame",
            PASS,
            measured=f"{report.first_frame_ms:.0f} ms",
            duration_ms=report.first_frame_ms,
        )
    )
    frames_status = WARN if (read_error or timed_out) else PASS
    checks.append(
        ProbeCheck(
            "frames-received",
            frames_status,
            measured=f"{report.frames_read} frames",
            detail=read_error or ("the probe window elapsed" if timed_out else None),
            duration_ms=(clock() - read_started) * 1000.0,
        )
    )
    if read_error:
        report.warnings.append(f"the stream was interrupted after {report.frames_read} frames")

    # --- measure ---------------------------------------------------------------------------------
    if last_frame is not None:
        report.resolution = f"{last_frame.original_width}x{last_frame.original_height}"
        checks.append(ProbeCheck("resolution", PASS, measured=report.resolution))

    # Codec is not observable from an encoded frame without parsing it, and guessing from the source
    # type would be a declaration dressed up as a measurement. Reported as declared, or not at all.
    declared = (config.get("capabilities") or {}).get("codecs") or []
    if declared:
        report.codec = str(declared[0])
        checks.append(
            ProbeCheck("codec", PASS, measured=report.codec, detail="declared, not verified by decode")
        )
    else:
        checks.append(ProbeCheck("codec", NOT_EXECUTED, detail="no codec is declared for this camera"))

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
        # One frame proves the stream works and is not enough to characterise its timing.
        detail = "only one frame was read — a rate needs at least two"
        checks.append(ProbeCheck("fps", NOT_EXECUTED, detail=detail))
        checks.append(ProbeCheck("jitter", NOT_EXECUTED, detail=detail))

    if report.first_frame_ms is not None:
        checks.append(ProbeCheck("latency", PASS, measured=f"{report.first_frame_ms:.0f} ms"))

    profiles = (config.get("capabilities") or {}).get("streamProfiles") or []
    report.profiles = list(profiles)[:10]
    requested = config.get("streamProfile")
    if requested:
        matched = any(p.get("name") == requested for p in report.profiles)
        checks.append(
            ProbeCheck(
                "stream-profile",
                PASS if matched else WARN,
                measured=str(requested),
                detail=None if matched else "the device did not advertise this profile",
            )
        )
    elif report.profiles:
        checks.append(
            ProbeCheck("stream-profile", PASS, measured=f"{len(report.profiles)} advertised")
        )

    return finish("not measured by this probe", None)
