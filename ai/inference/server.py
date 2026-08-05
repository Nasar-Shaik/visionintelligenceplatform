"""Minimal JSON HTTP transport, built on the Python **stdlib** `http.server` (no FastAPI/uvicorn —
keeps the runtime dependency-free and CI unit-testable, matching the ai/mlops precedent). It routes
to a manifest-driven CapabilityRegistry:

    GET  /health         liveness
    GET  /ready          readiness (default capability READY)
    GET  /               service info (runtime version)
    GET  /capabilities   descriptors of all loaded capabilities (discovery)
    GET  /status         per-capability lifecycle state + metrics
    GET  /metrics        Prometheus text (default capability)
    POST /infer          run a capability over one frame (internal-key gated) → DetectionResult

Responses use the platform `{success, data}` / `{success:false, error}` envelope. `/infer` requires
`x-internal-key` (constant-time) and builds a FrameContext fail-closed (no tenant → 400 + dropped).
"""

from __future__ import annotations

import hmac
import json
import os
import threading as _threading
import time
import time as _time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import parse_qs, urlsplit

from contracts import FrameContext
from errors import (
    ConfigurationFailure,
    Conflict,
    ContextRequired,
    InferenceError,
    NotFound,
    ValidationError,
)
import obslog
from registry import CapabilityRegistry

_MAX_BODY = 32 * 1024 * 1024  # 32 MiB (a base64 frame)

_SESSION_ACTIONS = ("stop", "pause", "resume", "restart")

# ⚠️ Polled or per-frame paths. Logging each one is thousands of lines an hour of no information, and
# it buries the line that matters — so they are logged only when they FAIL (TD-60).
_QUIET_PATHS = ("/health", "/ready", "/metrics", "/infer", "/runtime", "/tracking", "/tracking/tracks")

# Cameras that have delivered a frame recently: cameraKey -> monotonic seconds. Bounded by the number
# of cameras a deployment actually has, and pruned on read.
_CAMERA_WINDOW_SECONDS = 60.0
_cameras_seen: dict[str, float] = {}
_cameras_lock = _threading.Lock()
_STARTED_AT = _time.monotonic()


def _note_camera(tenant_id: str, camera_id: str) -> None:
    """Record that a camera delivered a frame. ⚠️ Derived, never stored: "current cameras" is a
    question about the last minute, not a count somebody has to remember to decrement."""
    if not camera_id:
        return
    with _cameras_lock:
        _cameras_seen[f"{tenant_id}/{camera_id}"] = _time.monotonic()


def _current_cameras() -> int:
    cutoff = _time.monotonic() - _CAMERA_WINDOW_SECONDS
    with _cameras_lock:
        for key in [k for k, seen in _cameras_seen.items() if seen < cutoff]:
            del _cameras_seen[key]
        return len(_cameras_seen)



def _runtime_metrics(registry, supervisor, service_name: str, version: str) -> str:
    """Runtime-level Prometheus series — the operational baseline (P-8 Phase 2 item 7).

    ⚠️ Distinct names from the per-capability block above (`inference_runtime_*`), because two series
    with one name and different meanings is how a dashboard starts lying. Everything here is derived
    at scrape time from what the runtime already knows; nothing is a counter somebody must remember
    to increment.
    """
    processed = 0.0
    dropped = 0.0
    skipped = 0.0
    latency = 0.0
    fps = 0.0
    queue = 0.0
    provider = "unknown"
    seen = 0
    for entry in registry.health():
        metrics = entry.get("metrics") or {}
        processed += float(metrics.get("framesProcessed", 0) or 0)
        dropped += float(metrics.get("droppedFrames", 0) or 0)
        skipped += float(metrics.get("framesSkipped", 0) or 0)
        latency += float(metrics.get("avgLatencyMs", 0) or 0)
        fps += float(metrics.get("fps", 0) or 0)
        queue += float(metrics.get("queueDepth", 0) or 0)
        provider = entry.get("executionProvider") or provider
        seen += 1
    if seen:
        latency /= seen

    memory_mb = 0.0
    cpu_percent = 0.0
    sessions = 0.0
    max_sessions = 0.0
    if supervisor is not None:
        try:
            resources = supervisor.scheduler_stats().get("resources") or {}
            memory_mb = float(resources.get("memoryMb") or 0)
            cpu_percent = float(resources.get("cpuPercent") or 0)
        except Exception:  # noqa: BLE001 - a metrics scrape must never fail the endpoint
            pass
        try:
            stats = supervisor.stats()
            sessions = float(stats.get("activeSessions") or 0)
            max_sessions = float(stats.get("maxSessions") or 0)
        except Exception:  # noqa: BLE001
            pass

    rows = [
        ("inference_runtime_frames_received_total", "counter", processed + dropped),
        ("inference_runtime_frames_processed_total", "counter", processed),
        ("inference_runtime_frames_dropped_total", "counter", dropped),
        ("inference_runtime_frames_skipped_total", "counter", skipped),
        ("inference_runtime_queue_depth", "gauge", queue),
        ("inference_runtime_fps_avg", "gauge", fps),
        ("inference_runtime_latency_ms_avg", "gauge", latency),
        ("inference_runtime_memory_rss_mb", "gauge", memory_mb),
        ("inference_runtime_cpu_percent", "gauge", cpu_percent),
        ("inference_runtime_cameras_current", "gauge", float(_current_cameras())),
        ("inference_runtime_sessions_active", "gauge", sessions),
        ("inference_runtime_sessions_max", "gauge", max_sessions),
        ("inference_runtime_uptime_seconds", "gauge", round(_time.monotonic() - _STARTED_AT, 3)),
    ]
    rows.extend(_tracking_metrics(registry))

    lines = [
        "# TYPE inference_runtime_build_info gauge",
        f'inference_runtime_build_info{{service="{service_name}",version="{version}",provider="{provider}"}} 1',
    ]
    for name, kind, value in rows:
        lines.append(f"# TYPE {name} {kind}")
        lines.append(f"{name} {value}")
    return "\n".join(lines) + "\n"


def _tracking_metrics(registry) -> list:
    """Tracking's permanent series (P-8 Phase 4 freeze). Deployment-wide counts, no tenant labels.

    ⚠️ **A metric the runtime cannot measure is OMITTED, never emitted as zero.** Prometheus has no
    null, so `identity_switches`, `reidentification_success` and `false_recoveries` are simply not
    here — they need ground truth a live camera does not carry. `inference_tracking_ground_truth_
    available 0` is emitted in their place, so a dashboard can tell "not measurable here" apart from
    "the exporter is broken", and an alert on the missing series is impossible to write by accident.
    See ADR-0039.

    ⚠️ **No tenant or camera labels.** `/metrics` is the deployment's own scrape and is not tenant
    scoped, so labelling by tenant would publish one customer's activity to everyone reading it.
    Per-camera numbers live behind `/tracking/cameras`, which requires a tenant.
    """
    tracker = getattr(registry, "tracker", None)
    if not callable(getattr(tracker, "stats", None)):
        return [("inference_tracking_enabled", "gauge", 0)]
    try:
        stats = tracker.stats()
    except Exception:  # noqa: BLE001 - a metrics scrape must never fail the endpoint
        return [("inference_tracking_enabled", "gauge", 0)]

    rows = [
        ("inference_tracking_enabled", "gauge", 1),
        ("inference_tracking_cameras", "gauge", stats.get("camerasTracked", 0)),
        ("inference_tracking_active", "gauge", stats.get("activeTracks", 0)),
        ("inference_tracking_confirmed", "gauge", stats.get("confirmedTracks", 0)),
        ("inference_tracking_tentative", "gauge", stats.get("tentativeTracks", 0)),
        ("inference_tracking_lost", "gauge", stats.get("lostTracks", 0)),
        ("inference_tracking_created_total", "counter", stats.get("createdTracks", 0)),
        ("inference_tracking_terminated_total", "counter", stats.get("removedTracks", 0)),
        ("inference_tracking_recovered_total", "counter", stats.get("recoveredTracks", 0)),
        ("inference_tracking_occlusions_total", "counter", stats.get("occlusionsSurvived", 0)),
        ("inference_tracking_crossings_total", "counter", stats.get("crossings", 0)),
        (
            "inference_tracking_reentry_opportunities_total",
            "counter",
            stats.get("reentryOpportunities", 0),
        ),
        ("inference_tracking_frames_total", "counter", stats.get("framesTracked", 0)),
        ("inference_tracking_out_of_order_total", "counter", stats.get("outOfOrderFrames", 0)),
        ("inference_tracking_ground_truth_available", "gauge", 0),
    ]
    # ⚠️ The averages are `None` until something has been tracked, and a gauge of 0 there would read
    # as "tracks last no time at all" rather than "nothing has been tracked". Omitted until measured.
    for name, key in (
        ("inference_tracking_track_duration_seconds_avg", "averageTrackLifetimeSeconds"),
        ("inference_tracking_track_age_frames_avg", "averageTrackAgeFrames"),
        ("inference_tracking_latency_ms_avg", "averageTrackingMs"),
        ("inference_tracking_fragmentation", "fragmentation"),
    ):
        value = stats.get(key)
        if isinstance(value, (int, float)):
            rows.append((name, "gauge", value))
    return rows


def runtime_view(registry, supervisor, service_name: str, version: str, model_store=None) -> dict:
    """Everything the runtime dashboard shows, in one call (P-8 Phase 3).

    ⚠️ **Every field is measured or absent.** There is no placeholder: `gpu` is `None` on a machine
    with no GPU rather than "0%", and a model that failed to load reports FAILED rather than being
    omitted from the list. A dashboard whose empty state is indistinguishable from its healthy state
    is the thing this page exists to prevent.

    ⚠️ **No tenant data.** Counts, states, versions and label totals — nothing that identifies a
    camera, a person or a customer. The runtime persists nothing and this endpoint publishes nothing
    it would have had to persist.
    """
    capabilities = []
    provider = "unknown"
    for entry in registry.health():
        capabilities.append(entry)
        if entry.get("executionProvider"):
            provider = entry["executionProvider"]

    resources: dict = {}
    sessions_active = None
    if supervisor is not None:
        try:
            resources = supervisor.scheduler_stats().get("resources") or {}
        except Exception:  # noqa: BLE001 - a status page must never be the thing that breaks
            resources = {}
        try:
            sessions_active = supervisor.stats().get("activeSessions")
        except Exception:  # noqa: BLE001
            sessions_active = None

    registered = None
    if model_store is not None:
        try:
            registered = [m.descriptor(artifact_dir=model_store.artifact_dir) for m in model_store.all()]
        except Exception as exc:  # noqa: BLE001
            registered = [{"error": str(exc)[:200]}]

    loaded = [
        {
            "capabilityId": entry.get("capabilityId"),
            "state": entry.get("state"),
            "executionProvider": entry.get("executionProvider"),
            "model": entry.get("model"),
            "adapter": entry.get("adapter"),
        }
        for entry in capabilities
    ]

    return {
        "service": service_name,
        "runtimeVersion": version,
        "uptimeSeconds": round(_time.monotonic() - _STARTED_AT, 1),
        "executionProvider": provider,
        # ⚠️ Health is derived from the capabilities, not asserted: "ok" only when every enabled
        # capability is READY. A runtime that answers /health while its model failed to load is
        # exactly the lie P-8 Phase 1 was built to catch.
        "health": _derive_health(capabilities),
        "capabilities": capabilities,
        "loadedModels": loaded,
        "registeredModels": registered,
        "cameras": _current_cameras(),
        "sessionsActive": sessions_active,
        # ⚠️ Deployment-wide COUNTS only, no tenant scope and no identities — this is the same
        # engineering view as everything else on `/runtime`, and it must stay safe to show to an
        # operator of any tenant. Per-tenant tracks live behind `/tracking`, which requires a tenant.
        "tracking": _tracking_summary(registry),
        "resources": {
            "memoryMb": resources.get("memoryMb"),
            "cpuPercent": resources.get("cpuPercent"),
            # ⚠️ The cgroup quota, not the host's core count (TD-61). On a container limited to two
            # cores of a ten-core host, `os.cpu_count()` says ten and every capacity number derived
            # from it is wrong by a factor of five.
            "cpuCores": _available_cores(),
            # None, not 0 — there is no GPU in this deployment and saying "0%" implies there is.
            "gpuPercent": resources.get("gpuPercent"),
        },
    }


def _tracking_summary(registry) -> dict:
    """What the runtime can say about tracking without naming a tenant.

    ⚠️ `enabled: false` is a real answer, not an omission. A runtime with tracking switched off must
    look different from one where nobody has walked past a camera, and on a status page those two
    render identically unless the difference is stated.
    """
    tracker = getattr(registry, "tracker", None)
    if not callable(getattr(tracker, "stats", None)):
        return {"enabled": False}
    try:
        return {"enabled": True, "engine": tracker.describe(), "stats": tracker.stats()}
    except Exception as exc:  # noqa: BLE001 - a status page must never be the thing that breaks
        return {"enabled": True, "error": str(exc)[:200]}


def _available_cores():
    try:
        from compute import available_cores  # noqa: WPS433 - keeps the server import light

        return round(available_cores(), 2)
    except Exception:  # noqa: BLE001
        return None


def _derive_health(capabilities) -> str:
    states = [entry.get("state") for entry in capabilities]
    if not states:
        return "unknown"
    if all(state == "READY" for state in states):
        return "ok"
    if any(state == "FAILED" for state in states):
        return "failed"
    return "degraded"


def runtime_snapshot(registry, supervisor) -> dict:
    """The heartbeat's payload — the same readings the metrics expose, as one log line."""
    processed = 0.0
    dropped = 0.0
    for entry in registry.health():
        metrics = entry.get("metrics") or {}
        processed += float(metrics.get("framesProcessed", 0) or 0)
        dropped += float(metrics.get("droppedFrames", 0) or 0)
    memory_mb = None
    cpu_percent = None
    sessions = None
    if supervisor is not None:
        try:
            resources = supervisor.scheduler_stats().get("resources") or {}
            memory_mb = resources.get("memoryMb")
            cpu_percent = resources.get("cpuPercent")
            sessions = supervisor.stats().get("activeSessions")
        except Exception:  # noqa: BLE001
            pass
    return {
        "framesProcessed": int(processed),
        "framesDropped": int(dropped),
        "cameras": _current_cameras(),
        "sessions": sessions,
        "memoryMb": memory_mb,
        "cpuPercent": cpu_percent,
        "uptimeSeconds": round(_time.monotonic() - _STARTED_AT, 1),
    }


def make_handler(
    registry: CapabilityRegistry,
    internal_key: str,
    service_name: str,
    version: str,
    model_registry=None,
    sessions=None,
    supervisor=None,
    model_store=None,
):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"{service_name}/{version}"

        def log_message(self, *_args) -> None:  # noqa: ANN002 - quiet; logs aggregated elsewhere
            return None

        # --- helpers ---------------------------------------------------------------
        def _send(self, status: int, payload, content_type: str = "application/json") -> None:
            text = json.dumps(payload) if content_type == "application/json" else str(payload)
            body = text.encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            try:
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                # ⚠️ The client went away mid-response — a media frame whose 2s timeout fired, or a
                # scraper that gave up. Measured in P-8 Phase 2: without this, every abandoned request
                # printed a Python traceback to stderr, and at 32 frames a second the tracebacks are
                # what an operator finds instead of the error that matters. It is a disconnect, not a
                # fault: counted as a warning line, never a stack trace.
                obslog.warn("client disconnected before the response was written", path=_split(self.path)[0])
                return
            self._log_request(status)

        def _log_request(self, status: int) -> None:
            """One structured line per control-plane request (TD-60). Quiet paths are logged only
            when they fail, so a healthcheck every 15s and a frame every 500ms stay out of the way."""
            path, _ = _split(self.path)
            if status < 400 and path in _QUIET_PATHS:
                return
            started = getattr(self, "_t0", None)
            obslog.log(
                "warn" if status >= 400 else "info",
                "request",
                method=self.command,
                path=path,
                status=status,
                durationMs=None if started is None else round((time.perf_counter() - started) * 1000, 2),
            )

        def _ok(self, data: object, status: int = 200) -> None:
            self._send(status, {"success": True, "data": data})

        def _err(self, status: int, code: str, message: str) -> None:
            self._send(status, {"success": False, "error": {"code": code, "message": message}})

        # --- routing ---------------------------------------------------------------
        def do_GET(self) -> None:  # noqa: N802
            self._t0 = time.perf_counter()
            path, _ = _split(self.path)
            segs = _segments(path)
            if path == "/health":
                self._ok({"status": "ok"})
            elif path == "/ready":
                self._ready()
            elif path == "/":
                self._ok({"name": service_name, "version": version, "runtimeVersion": version})
            elif path == "/capabilities":
                self._ok(registry.descriptors())
            elif path == "/status":
                self._ok(registry.health())
            elif path == "/metrics":
                self._metrics()
            elif path == "/runtime":
                # Engineering + deployment visibility (P-8 Phase 3). Deliberately NOT tenant-scoped:
                # runtime state is a property of the deployment, identical for every tenant, and
                # carries no tenant data. Reached only through media, which is the one service
                # allowed to talk to the runtime — the runtime stays off the gateway.
                self._ok(runtime_view(registry, supervisor, service_name, version, model_store))
            elif segs[:1] == ["tracking"]:
                self._get_tracking(segs)
            elif segs[:1] == ["models"]:
                self._get_models(segs)
            elif segs[:1] == ["sessions"]:
                self._get_sessions(segs)
            elif path == "/supervisor" and supervisor is not None:
                self._supervisor_stats()
            elif path == "/scheduler" and supervisor is not None:
                # AI-5c: scheduling strategy, per-session shares, compute placement, recent decisions.
                self._ok(supervisor.scheduler_stats())
            elif path == "/sla" and supervisor is not None:
                self._tenant_scoped(supervisor.sla)
            elif path == "/resources" and supervisor is not None:
                self._tenant_scoped(supervisor.resource_usage)
            elif path == "/sessions-health" and supervisor is not None:
                # AI-5d recs 1 + 2. Deliberately NOT under `/health`, which is the process liveness
                # probe an orchestrator polls — conflating the two would let a degraded camera look
                # like a dead container and get the pod restarted.
                self._tenant_scoped(supervisor.health)
            elif path == "/fleet-health" and supervisor is not None:
                self._tenant_scoped(supervisor.fleet_health)
            elif path == "/recovery-history" and supervisor is not None:
                self._tenant_scoped(supervisor.recovery_history)
            elif path == "/failure-analytics" and supervisor is not None:
                self._tenant_scoped(supervisor.failure_analytics)
            # AI-5e — certification governance. Deliberately NOT tenant-scoped: which cameras the
            # platform has certified and what the dataset corpus covers are properties of the
            # PRODUCT, identical for every tenant, and carry no tenant data.
            elif path == "/certification/matrix":
                self._certification_matrix()
            elif path == "/certification/coverage":
                self._dataset_coverage()
            else:
                self._err(404, "not_found", f"no route for GET {self.path}")

        # --- object tracking (P-8 Phase 4) -----------------------------------------
        def _get_tracking(self, segs) -> None:
            """Read-only views over the live tracker.

                GET /tracking                    aggregate statistics for this tenant
                GET /tracking/cameras            the same metrics, per camera
                GET /tracking/tracks             live tracks (optionally ?cameraId=&state=)
                GET /tracking/tracks/{trackId}   one track plus its lifecycle timeline

            ### ⚠️ Tenant-scoped, and it is not optional

            Unlike `/runtime`, this is **tenant data**: a track is a record of a person moving through
            a customer's premises. Every route below requires `x-tenant-id` and fails closed without
            it. The header is set by media from the caller's verified claims and never from anything
            the browser sent — see services/media/src/transport/routes/tracking.ts.

            ### ⚠️ Read-only, deliberately

            There is no route here that starts, stops, resets or reassigns anything. Tracking is a
            consequence of frames arriving, not a thing an operator steers, and a control that
            configures nothing would be worse than an absent one.
            """
            tracker = getattr(registry, "tracker", None)
            reads_tracks = callable(getattr(tracker, "tracks", None))
            if not reads_tracks:
                # ⚠️ A first-class answer, not an error: `INFERENCE_TRACKING_ENABLED=0` is a valid
                # deployment and the page must say "not enabled here" rather than render an empty
                # table that looks exactly like "nobody has walked past a camera".
                self._ok({"enabled": False, "detail": "object tracking is not enabled on this runtime"})
                return

            tenant = self._tenant()
            if tenant is None:
                self._err(400, "bad_request", "x-tenant-id header is required")
                return

            _, query = _split(self.path)
            q = parse_qs(query)
            if len(segs) == 1:
                self._ok({"enabled": True, "engine": tracker.describe(), "stats": tracker.stats(tenant)})
            elif len(segs) == 2 and segs[1] == "cameras":
                # ⚠️ Camera ids for THIS tenant only, from a tracker read that requires the tenant.
                # There is no "all cameras" here and there must not be: this is the surface that
                # Camera Processing Assignment will read from, and a list that leaked across tenants
                # would leak which sites a competitor is watching.
                self._ok({"cameras": tracker.cameras(tenant), "stats": tracker.stats(tenant)})
            elif len(segs) == 2 and segs[1] == "tracks":
                states = _first(q.get("state"))
                tracks = tracker.tracks(
                    tenant,
                    camera_id=_first(q.get("cameraId")),
                    states=[s for s in states.split(",") if s] if states else None,
                )
                self._ok({"tracks": [t.to_dict() for t in tracks], "stats": tracker.stats(tenant)})
            elif len(segs) == 3 and segs[1] == "tracks":
                detail = tracker.detail(tenant, segs[2])
                if detail is None:
                    self._err(404, "not_found", f"no live track '{segs[2]}'")
                    return
                self._ok(detail)
            else:
                self._err(404, "not_found", f"no route for GET {self.path}")

        def _supervisor_stats(self) -> None:
            """Multi-camera capacity + fleet health (tenant-scoped counts stay per-tenant elsewhere;
            this is the runtime's own capacity view for operators)."""
            self._ok(supervisor.stats())

        def _certification_matrix(self) -> None:
            """The official compatibility matrix (AI-5e deliverable 4). Every device stays
            `pending-validation` until a physical run says otherwise — this endpoint reports that
            status, it never computes one."""
            from camera_registry import CameraRegistry  # noqa: WPS433 - keeps server import light

            registry_ = CameraRegistry().load()
            self._ok(
                {
                    "matrix": registry_.matrix(),
                    **registry_.summary(),
                    "note": (
                        "No hardware compatibility is claimed until a device has been physically "
                        "validated. Run `vip certify` against the device to change a status."
                    ),
                }
            )

        def _dataset_coverage(self) -> None:
            """What the CCTV dataset corpus covers, and where it does not (AI-5e priority 3)."""
            from dataset import DatasetLibrary  # noqa: WPS433

            library = DatasetLibrary().load()
            self._ok(
                {
                    "cases": len(library),
                    "coverage": library.coverage(),
                    "missingFootage": [c.id for c in library.missing_footage()],
                }
            )

        def _tenant_scoped(self, fn) -> None:  # noqa: ANN001
            """SLA + resource views are per-session data, so they are tenant-scoped (Law 5)."""
            tenant = self._tenant()
            if tenant is None:
                self._err(400, "bad_request", "x-tenant-id header is required")
                return
            self._ok(fn(tenant))

        def do_POST(self) -> None:  # noqa: N802
            self._t0 = time.perf_counter()
            if not hmac.compare_digest(self.headers.get("x-internal-key", ""), internal_key):
                self._err(401, "unauthenticated", "invalid internal credentials")
                return
            path, _ = _split(self.path)
            segs = _segments(path)
            if path == "/infer":
                self._infer()
            elif path == "/playground/analyze":
                self._playground_analyze()
            elif segs[:1] == ["models"]:
                self._post_models(segs)
            elif segs[:1] == ["sessions"]:
                self._post_sessions(segs)
            elif path == "/discovery/onvif":
                self._discover_onvif()
            elif path == "/streams/validate":
                self._validate_stream()
            else:
                self._err(404, "not_found", f"no route for POST {self.path}")

        # --- /streams/validate (P-2) -----------------------------------------------
        def _validate_stream(self) -> None:
            """Open a stream, read a few frames, and report exactly what was observed.

            **A measurement, not perception** — the same bounded exception as `/discovery/onvif`
            (ADR-0023, ADR-0024): no session is created, no capability runs, nothing is persisted.
            The runtime owns the decode path, so it is the only component that can answer "does this
            camera actually stream?", and the camera service calls it through a port.

            Credentials arrive in the body because they are per-camera and cannot come from the
            runtime's environment the way discovery's do. That is a deliberate, bounded exposure on
            an internal-key-gated hop: the credentialed URI is built here, never logged, never
            echoed back, and every error path runs through `redact_uri`.
            """
            from stream_probe import probe_stream  # noqa: WPS433 - keeps the server import light

            body, err = self._read_json(allow_empty=True)
            if err is not None:
                self._err(400, "bad_request", err)
                return

            stream_url = str(body.get("streamUrl") or "").strip()
            if not stream_url:
                self._err(400, "bad_request", "streamUrl is required")
                return
            protocol = str(body.get("protocol") or "rtsp").strip().lower()
            try:
                timeout = max(1.0, min(60.0, float(body.get("timeoutSeconds", 8))))
                frames = max(1, min(30, int(body.get("frames", 3))))
            except (TypeError, ValueError):
                self._err(400, "bad_request", "timeoutSeconds and frames must be numbers")
                return

            credentials = body.get("credentials")
            uri, credentialed = _apply_credentials(stream_url, credentials)
            config = {
                # The DECLARED protocol selects the source implementation — the URI is never sniffed
                # (AI-5b refinement 4). `rtmp` has no dedicated branch and rides the generic path.
                "type": "rtsp" if protocol in ("rtsp", "onvif") else "http",
                "uri": uri,
                "capabilities": body.get("capabilities") or {},
                "_credentialed": credentialed,
                # Provenance, carried through so a stored report can be compared with a later one
                # (P-2.1 rec 4). The runtime never invents these — it echoes what the caller knew.
                "configVersion": body.get("configVersion"),
                "operator": body.get("operator"),
                "correlationId": body.get("correlationId")
                or self.headers.get("x-correlation-id"),
                "streamProfile": body.get("streamProfile"),
            }
            report = probe_stream(
                config, frames=frames, timeout_seconds=timeout, runtime_version=version
            )
            self._ok(report.to_dict())

        # --- /discovery/onvif (P-1) ------------------------------------------------
        def _discover_onvif(self) -> None:
            """Probe the local segment for ONVIF devices and negotiate their capabilities.

            **This endpoint exists here only because the ONVIF implementation does** (AI-5e built it
            for the certification harness). Device *discovery* is a camera-management concern, not a
            perception one, so the camera service owns the workflow and calls this as a read-only
            capability — recorded as a deliberate exception in ADR-0023 rather than left to look like
            the runtime quietly growing a second job.

            Nothing here touches the pipeline: no session is created, no frame is decoded, no tenant
            data is read or written. It returns configuration.
            """
            from onvif import (  # noqa: WPS433 - keeps the server import light
                HttpSoapTransport,
                OnvifDevice,
                OnvifDiscovery,
                UdpDiscoveryTransport,
            )

            body, err = self._read_json(allow_empty=True)
            if err is not None:
                self._err(400, "bad_request", err)
                return
            timeout = body.get("timeoutSeconds", 3)
            try:
                timeout = max(1.0, min(30.0, float(timeout)))
            except (TypeError, ValueError):
                self._err(400, "bad_request", "timeoutSeconds must be a number between 1 and 30")
                return

            # Credentials come from the runtime's environment, never from the request body — a camera
            # password must not travel through the gateway, the camera service and a JSON body to get
            # here, leaving a copy in every log along the way.
            username = os.environ.get("VIP_CAMERA_USERNAME")
            password = os.environ.get("VIP_CAMERA_PASSWORD")

            started = time.monotonic()
            # P-2: a directed negotiation of ONE device, for a capability refresh. Re-broadcasting
            # the whole segment to re-read one camera's profiles is wasteful, and across a routed
            # network it simply does not work — multicast never leaves the local segment, so a
            # camera on another VLAN would look like it had vanished.
            endpoint = str(body.get("endpoint") or "").strip()
            if endpoint:
                self._negotiate_one(endpoint, username, password, started)
                return
            try:
                found = OnvifDiscovery(UdpDiscoveryTransport()).discover(timeout_seconds=timeout)
            except OSError as exc:
                # Multicast is commonly blocked in containers and across VLANs. That is an
                # environment answer, not an empty network, and the caller must be able to tell them
                # apart — an installer told "no cameras found" will go and check the cameras.
                self._ok(
                    {
                        "devices": [],
                        "probedSeconds": round(time.monotonic() - started, 3),
                        "unavailable": f"WS-Discovery could not run on this host: {exc}",
                    }
                )
                return

            devices = []
            for device in found:
                warning = None
                try:
                    device = OnvifDevice(
                        device.address, HttpSoapTransport(), username=username, password=password
                    ).negotiate(device)
                except Exception as exc:  # noqa: BLE001 - one hostile device must not end the scan
                    warning = f"capability negotiation failed: {exc}"
                devices.append(_device_payload(device, warning))
            self._ok(
                {
                    "devices": devices,
                    "probedSeconds": round(time.monotonic() - started, 3),
                }
            )

        def _negotiate_one(self, endpoint: str, username, password, started) -> None:  # noqa: ANN001
            """Negotiate one already-known device (P-2 capability refresh) — no broadcast."""
            from onvif import HttpSoapTransport, OnvifDevice  # noqa: WPS433

            address = endpoint if "://" in endpoint else f"http://{endpoint}/onvif/device_service"
            try:
                device = OnvifDevice(
                    address, HttpSoapTransport(), username=username, password=password
                ).negotiate()
            except Exception as exc:  # noqa: BLE001 - a refusing device is an answer, not a crash
                self._ok(
                    {
                        "devices": [],
                        "probedSeconds": round(time.monotonic() - started, 3),
                        "unavailable": f"the device did not answer: {exc}",
                    }
                )
                return
            self._ok(
                {
                    "devices": [_device_payload(device, None)],
                    "probedSeconds": round(time.monotonic() - started, 3),
                }
            )

        # --- /infer ----------------------------------------------------------------
        def _infer(self) -> None:
            body, err = self._read_json()
            if err is not None:
                self._err(400, "bad_request", err)
                return
            try:
                capability = registry.get(body.get("capabilityId"))
            except KeyError as exc:
                self._err(404, "not_found", str(exc))
                return
            try:
                ctx = FrameContext.from_request(body)
            except ContextRequired as exc:
                capability.record_dropped()  # fail-closed drop is counted
                self._err(400, "context_required", str(exc))
                return
            except InferenceError as exc:
                self._err(400, "bad_request", str(exc))
                return
            try:
                result = capability.process(ctx)
            except InferenceError as exc:
                obslog.error("inference failed", cameraId=ctx.camera_id, error=str(exc))
                self._err(500, "inference_error", str(exc))
                return
            _note_camera(ctx.tenant_id, ctx.camera_id)
            self._ok(result)

        # --- AI Playground (AI-1; x-internal-key + x-tenant-id) --------------------
        def _playground_analyze(self) -> None:
            tenant = self._tenant()
            if tenant is None:
                self._err(400, "bad_request", "x-tenant-id header is required")
                return
            body, err = self._read_json()
            if err is not None:
                self._err(400, "bad_request", err)
                return
            try:
                from playground import analyze_request  # noqa: WPS433 - keeps import graph lean

                self._ok(analyze_request(body, tenant))
            except (ValueError, InferenceError) as exc:
                self._err(400, "bad_request", str(exc))

        # --- model registry (control plane; x-internal-key + x-tenant-id) ----------
        def _tenant(self) -> Optional[str]:
            tid = self.headers.get("x-tenant-id", "")
            return tid if tid.strip() else None

        def _get_models(self, segs) -> None:
            if model_registry is None:
                self._err(404, "not_found", "model registry not available")
                return
            tenant = self._tenant()
            if tenant is None:
                self._err(400, "bad_request", "x-tenant-id header is required")
                return
            _, query = _split(self.path)
            q = parse_qs(query)
            try:
                if len(segs) == 1:  # GET /models
                    models = model_registry.list(
                        tenant,
                        capability=_first(q.get("capability")),
                        status=_first(q.get("status")),
                    )
                    self._ok([m.to_dict() for m in models])
                elif len(segs) == 2:  # GET /models/{id}
                    self._ok(model_registry.require(tenant, segs[1]).to_dict())
                else:
                    self._err(404, "not_found", f"no route for GET {self.path}")
            except NotFound as exc:
                self._err(404, "not_found", str(exc))

        def _post_models(self, segs) -> None:
            if model_registry is None:
                self._err(404, "not_found", "model registry not available")
                return
            tenant = self._tenant()
            if tenant is None:
                self._err(400, "bad_request", "x-tenant-id header is required")
                return
            body, err = self._read_json()
            if err is not None:
                self._err(400, "bad_request", err)
                return
            try:
                if len(segs) == 1:  # POST /models — register
                    model = model_registry.register(
                        tenant,
                        name=str(body.get("name", "")),
                        task=str(body.get("task", "")),
                        engine=str(body.get("engine", "")),
                        capabilities=body.get("capabilities"),
                        capability_profile=body.get("capabilityProfile"),
                        metadata=body.get("metadata"),
                    )
                    self._ok(model.to_dict(), status=201)
                elif len(segs) == 3 and segs[2] == "versions":  # POST /models/{id}/versions
                    model = model_registry.add_version(
                        tenant,
                        segs[1],
                        version=str(body.get("version", "")),
                        format=str(body.get("format", "")),
                        artifact_uri=str(body.get("artifactUri", "")),
                        engine=body.get("engine"),
                        classes=body.get("classes"),
                        input_shape=body.get("inputShape"),
                        accelerator=body.get("accelerator", "cpu"),
                        checksum=body.get("checksum"),
                        metrics=body.get("metrics"),
                        activate=bool(body.get("activate", False)),
                    )
                    self._ok(model.to_dict())
                elif len(segs) == 3 and segs[2] == "activate":  # POST /models/{id}/activate
                    self._ok(model_registry.activate(tenant, segs[1], str(body.get("version", ""))).to_dict())
                elif len(segs) == 3 and segs[2] in ("enable", "disable"):
                    fn = model_registry.enable if segs[2] == "enable" else model_registry.disable
                    self._ok(fn(tenant, segs[1]).to_dict())
                else:
                    self._err(404, "not_found", f"no route for POST {self.path}")
            except ValidationError as exc:
                self._err(400, "bad_request", str(exc))
            except NotFound as exc:
                self._err(404, "not_found", str(exc))
            except Conflict as exc:
                self._err(409, "conflict", str(exc))

        # --- inference sessions ----------------------------------------------------
        def _get_sessions(self, segs) -> None:
            if sessions is None:
                self._err(404, "not_found", "sessions not available")
                return
            tenant = self._tenant()
            if tenant is None:
                self._err(400, "bad_request", "x-tenant-id header is required")
                return
            _, query = _split(self.path)
            q = parse_qs(query)
            try:
                if len(segs) == 1:  # GET /sessions
                    found = sessions.list(tenant, camera_id=_first(q.get("cameraId")), state=_first(q.get("state")))
                    self._ok([s.to_dict() for s in found])
                elif len(segs) == 2:  # GET /sessions/{id}
                    self._ok(self._session_dict(tenant, segs[1]))
                elif len(segs) == 3 and segs[2] == "metrics":  # GET /sessions/{id}/metrics (AI-5b)
                    self._ok(self._live(tenant, segs[1]).metrics())
                elif len(segs) == 3 and segs[2] == "stream":  # GET /sessions/{id}/stream (AI-5b)
                    self._ok(self._live(tenant, segs[1]).diagnostics())
                elif len(segs) == 3 and segs[2] == "health":  # GET /sessions/{id}/health (AI-5d)
                    runner = self._live(tenant, segs[1])
                    score = runner.health or runner.score_health()
                    if score is None:
                        self._err(404, "not_found", "health monitoring is not enabled on this runtime")
                        return
                    self._ok(score.to_dict())
                elif len(segs) == 3 and segs[2] == "diagnostics":  # AI-5d rec 5
                    if supervisor is None:
                        raise NotFound("live sessions are not enabled on this runtime")
                    self._ok(supervisor.operational_diagnostics(tenant, segs[1]))
                elif len(segs) == 3 and segs[2] == "timeline":  # AI-5d rec 5
                    if supervisor is None:
                        raise NotFound("live sessions are not enabled on this runtime")
                    self._ok(supervisor.timeline(tenant, segs[1]))
                elif len(segs) == 3 and segs[2] == "recovery":  # AI-5d rec 1
                    runner = self._live(tenant, segs[1])
                    self._ok(runner.operational_diagnostics()["recovery"])
                else:
                    self._err(404, "not_found", f"no route for GET {self.path}")
            except NotFound as exc:
                self._err(404, "not_found", str(exc))

        def _session_dict(self, tenant: str, session_id: str) -> dict:
            """The session record, enriched with live ingestion diagnostics when a runner is bound."""
            out = sessions.require(tenant, session_id).to_dict()
            if supervisor is not None:
                runner = supervisor.get(tenant, session_id)
                if runner is not None:
                    out["ingestion"] = runner.diagnostics()["ingestion"]
            return out

        def _live(self, tenant: str, session_id: str):
            """Require a LIVE session (one with a running pipeline behind it)."""
            if supervisor is None:
                raise NotFound("live sessions are not enabled on this runtime")
            return supervisor.require(tenant, session_id)

        def _post_sessions(self, segs) -> None:
            if sessions is None:
                self._err(404, "not_found", "sessions not available")
                return
            tenant = self._tenant()
            if tenant is None:
                self._err(400, "bad_request", "x-tenant-id header is required")
                return
            body, err = self._read_json()
            if err is not None and len(segs) == 1:
                self._err(400, "bad_request", err)
                return
            try:
                if len(segs) == 1:  # POST /sessions — start
                    source = body.get("source")
                    if source is not None and supervisor is not None:
                        # AI-5b: a `source` binds the session to a LIVE pipeline. Omitting it keeps
                        # the exact G-3 control-plane-only behavior, so no existing caller changes.
                        self._ok(_start_live(supervisor, tenant, body, source), status=201)
                        return
                    if source is not None and supervisor is None:
                        self._err(400, "bad_request", "live sessions are not enabled on this runtime")
                        return
                    session = sessions.start(
                        tenant,
                        camera_id=str(body.get("cameraId", "")),
                        capability_id=str(body.get("capabilityId", "")),
                        model_id=body.get("modelId"),
                        model_version=body.get("modelVersion"),
                        engine=body.get("engine"),
                    )
                    self._ok(session.to_dict(), status=201)
                elif len(segs) == 3 and segs[2] == "recover":  # POST /sessions/{id}/recover (AI-5d)
                    # Offers the session to auto-recovery. The runtime still answers within the
                    # deployment's budget — an operator asking does not bypass the policy, it only
                    # asks the question sooner than the supervisor's next sweep would.
                    if supervisor is None:
                        self._err(400, "bad_request", "live sessions are not enabled on this runtime")
                        return
                    runner = supervisor.require(tenant, segs[1])
                    attempt = runner.recover()
                    if attempt is None:
                        self._err(409, "conflict", "nothing to recover, or auto-recovery is disabled")
                        return
                    self._ok(attempt.to_dict())
                elif len(segs) == 3 and segs[2] in _SESSION_ACTIONS:  # POST /sessions/{id}/{action}
                    # A live session's lifecycle must reach the data plane, so route through the
                    # supervisor when one is bound; otherwise the control plane alone (unchanged).
                    if supervisor is not None and supervisor.get(tenant, segs[1]) is not None:
                        getattr(supervisor, segs[2])(tenant, segs[1])
                    else:
                        sessions.transition(tenant, segs[1], segs[2])
                    self._ok(self._session_dict(tenant, segs[1]))
                else:
                    self._err(404, "not_found", f"no route for POST {self.path}")
            except ConfigurationFailure as exc:
                self._err(400, "bad_request", str(exc))
            except ValidationError as exc:
                self._err(400, "bad_request", str(exc))
            except NotFound as exc:
                self._err(404, "not_found", str(exc))
            except Conflict as exc:
                self._err(409, "conflict", str(exc))

        def _ready(self) -> None:
            try:
                ready = registry.get(None).ready
            except KeyError:
                ready = False
            self._send(
                200 if ready else 503,
                {"status": "pass" if ready else "fail", "checks": [{"name": "capability", "status": "pass" if ready else "fail"}]},
            )

        def _metrics(self) -> None:
            try:
                text = registry.get(None).metrics.prometheus()
            except KeyError:
                text = ""
            self._send(
                200,
                text + _runtime_metrics(registry, supervisor, service_name, version),
                content_type="text/plain; version=0.0.4",
            )

        def _read_json(self, *, allow_empty: bool = False):
            try:
                length = int(self.headers.get("content-length", "0"))
            except ValueError:
                return {}, "invalid content-length"
            if length <= 0:
                # Discovery takes no required input, so an empty body is a valid request there and
                # only there — every other route still rejects one.
                return ({}, None) if allow_empty else ({}, "empty body")
            if length > _MAX_BODY:
                return {}, "body too large"
            try:
                parsed = json.loads(self.rfile.read(length))
            except json.JSONDecodeError as exc:
                return {}, f"invalid JSON: {exc}"
            if not isinstance(parsed, dict):
                return {}, "body must be a JSON object"
            return parsed, None

    return Handler


def _host_of(endpoint: str) -> str:
    """Host[:port] of an ONVIF service address — what an installer recognises on their switch."""
    if "://" not in endpoint:
        return endpoint
    return endpoint.split("://", 1)[1].split("/", 1)[0]


def _device_payload(device, warning) -> dict:  # noqa: ANN001 - onvif.DiscoveredDevice
    """The wire shape of one discovered device, shared by the broadcast and directed paths.

    `identity` (P-2) is what lets the camera service recognise this device after its IP changes. The
    ONVIF endpoint UUID is the strongest identifier a camera offers, and `lastKnownAddress` is
    deliberately carried alongside it rather than inside it — the address is the part expected to
    change.
    """
    identity = device.to_identity()
    stream_url = _stream_url(device)
    return {
        "endpoint": device.address,
        "address": _host_of(device.address),
        "metadata": device.to_metadata(),
        "capabilities": device.to_capabilities(),
        "registryId": device.registry_id,
        **({"identity": identity} if identity else {}),
        **({"warning": warning} if warning else {}),
        **({"suggestedStreamUrl": stream_url} if stream_url else {}),
    }


def _apply_credentials(stream_url: str, credentials) -> tuple:  # noqa: ANN001 - optional dict
    """Build the credentialed URI a probe needs, and say whether credentials were actually applied.

    RTSP authentication happens in the URI — FFmpeg/OpenCV expose no other way to pass it — so the
    one place in the platform that assembles a credentialed URL is here, transiently, for the
    duration of a single probe. It is never persisted, never logged, and never returned: the caller
    passes the result straight into the probe, and every error path redacts it.

    The boolean matters as much as the URI. Opening a stream that needed no credentials proves
    nothing about credentials, and the probe must not report an authentication *result* it did not
    obtain.
    """
    if not isinstance(credentials, dict):
        return stream_url, False
    username = str(credentials.get("username") or "")
    password = str(credentials.get("password") or "")
    if not username or "://" not in stream_url:
        return stream_url, False
    from urllib.parse import quote  # noqa: WPS433 - local; only this path needs it

    scheme, remainder = stream_url.split("://", 1)
    userinfo = f"{quote(username, safe='')}:{quote(password, safe='')}"
    return f"{scheme}://{userinfo}@{remainder}", True


def _stream_url(device) -> Optional[str]:  # noqa: ANN001 - onvif.DiscoveredDevice
    """An RTSP URL for the device's analysis profile, built from the host plus the discovered path.

    Deliberately assembled here rather than taken from the device's `GetStreamUri` reply: that reply
    routinely embeds the credentials, and the contract's `StreamUrl` rejects a credentialed URL. The
    port is left implicit (554 is the RTSP default) so an operator can correct it if their estate
    differs, rather than the platform inventing one.
    """
    profiles = [p for p in getattr(device, "profiles", []) or [] if p.preferred_for_analysis]
    if not profiles or not profiles[0].path:
        return None
    host = _host_of(getattr(device, "address", "")).split(":", 1)[0]
    return f"rtsp://{host}:554{profiles[0].path}" if host else None


def _start_live(supervisor, tenant: str, body: dict, source: dict) -> dict:
    """Start a LIVE session (AI-5b): build the per-session analyzer + pipeline options from the request
    and hand them to the supervisor. The transport does no perception work — it only translates the
    wire shape into the runner's config, which is why a new source transport needs no change here."""
    from playground import build_adapter  # noqa: WPS433 - keeps the import graph lean
    from session_runner import LiveSessionConfig
    from stream_pipeline import PipelineOptions
    from stream_source import ReconnectPolicy
    from video_analyzer import AnalyzeOptions, VideoAnalyzer

    defaults = _LIVE_DEFAULTS
    camera_id = str(body.get("cameraId", ""))
    capability_id = str(body.get("capabilityId", ""))
    if not camera_id or not capability_id:
        raise ValidationError("cameraId and capabilityId are required")

    target_fps = source.get("targetFps") or defaults["target_fps"]
    analyze = AnalyzeOptions(
        tenant_id=tenant,
        camera_id=camera_id,
        capability_id=capability_id,
        target_fps=float(target_fps),
        correlation_id=body.get("correlationId"),
        min_confidence=float(body.get("minConfidence", 0.5)),
        zones=body.get("zones") or (),
        profile=body.get("profile"),
    )
    config = LiveSessionConfig(
        source=source,
        analyze=analyze,
        pipeline=PipelineOptions(
            queue_capacity=int(defaults["queue_size"]),
            drop_policy=str(defaults["drop_policy"]),
            target_fps=float(target_fps),
        ),
        reconnect=ReconnectPolicy(
            max_attempts=int(defaults["reconnect_max_attempts"]),
            base_ms=float(defaults["reconnect_base_ms"]),
            max_ms=float(defaults["reconnect_max_ms"]),
        ),
    )
    runner = supervisor.start(
        tenant,
        camera_id=camera_id,
        capability_id=capability_id,
        config=config,
        analyzer=VideoAnalyzer(build_adapter(str(defaults.get("backend", "stub"))), analyze),
        correlation_id=body.get("correlationId"),
        log_sink=defaults.get("log_sink"),
        model_id=body.get("modelId"),
        model_version=body.get("modelVersion"),
        engine=body.get("engine"),
    )
    return runner.diagnostics()


# Runtime-wide live defaults, set by `build_server` from InferenceConfig (never read from env here —
# `@vip/config`-style centralization: config is resolved once, at the composition root).
_LIVE_DEFAULTS: dict = {
    "queue_size": 32,
    "drop_policy": "drop-oldest",
    "target_fps": 5.0,
    "reconnect_max_attempts": 10,
    "reconnect_base_ms": 500.0,
    "reconnect_max_ms": 30000.0,
    "backend": "stub",
}


def _split(path: str):
    """Return (path_without_query, query_string)."""
    parts = urlsplit(path)
    return parts.path, parts.query


def _segments(path: str):
    """Path segments with no empties, e.g. '/models/mdl_1/versions' → ['models','mdl_1','versions']."""
    return [s for s in path.split("/") if s]


def _first(values):
    return values[0] if values else None


def build_server(
    host: str,
    port: int,
    registry: CapabilityRegistry,
    internal_key: str,
    service_name: str,
    version: str,
    model_registry=None,
    sessions=None,
    supervisor=None,
    live_defaults=None,
    model_store=None,
) -> ThreadingHTTPServer:
    if live_defaults:
        _LIVE_DEFAULTS.update(live_defaults)
    return ThreadingHTTPServer(
        (host, port),
        make_handler(
            registry,
            internal_key,
            service_name,
            version,
            model_registry,
            sessions,
            supervisor,
            model_store,
        ),
    )
