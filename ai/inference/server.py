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
from registry import CapabilityRegistry

_MAX_BODY = 32 * 1024 * 1024  # 32 MiB (a base64 frame)

_SESSION_ACTIONS = ("stop", "pause", "resume", "restart")


def make_handler(
    registry: CapabilityRegistry,
    internal_key: str,
    service_name: str,
    version: str,
    model_registry=None,
    sessions=None,
    supervisor=None,
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
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _ok(self, data: object, status: int = 200) -> None:
            self._send(status, {"success": True, "data": data})

        def _err(self, status: int, code: str, message: str) -> None:
            self._send(status, {"success": False, "error": {"code": code, "message": message}})

        # --- routing ---------------------------------------------------------------
        def do_GET(self) -> None:  # noqa: N802
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
            else:
                self._err(404, "not_found", f"no route for POST {self.path}")

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
                self._err(500, "inference_error", str(exc))
                return
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
            self._send(200, text, content_type="text/plain; version=0.0.4")

        def _read_json(self):
            try:
                length = int(self.headers.get("content-length", "0"))
            except ValueError:
                return {}, "invalid content-length"
            if length <= 0:
                return {}, "empty body"
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
) -> ThreadingHTTPServer:
    if live_defaults:
        _LIVE_DEFAULTS.update(live_defaults)
    return ThreadingHTTPServer(
        (host, port),
        make_handler(
            registry, internal_key, service_name, version, model_registry, sessions, supervisor
        ),
    )
