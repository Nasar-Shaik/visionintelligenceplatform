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
from errors import Conflict, ContextRequired, InferenceError, NotFound, ValidationError
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
            else:
                self._err(404, "not_found", f"no route for GET {self.path}")

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
                    self._ok(sessions.require(tenant, segs[1]).to_dict())
                else:
                    self._err(404, "not_found", f"no route for GET {self.path}")
            except NotFound as exc:
                self._err(404, "not_found", str(exc))

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
                    session = sessions.start(
                        tenant,
                        camera_id=str(body.get("cameraId", "")),
                        capability_id=str(body.get("capabilityId", "")),
                        model_id=body.get("modelId"),
                        model_version=body.get("modelVersion"),
                        engine=body.get("engine"),
                    )
                    self._ok(session.to_dict(), status=201)
                elif len(segs) == 3 and segs[2] in _SESSION_ACTIONS:  # POST /sessions/{id}/{action}
                    self._ok(sessions.transition(tenant, segs[1], segs[2]).to_dict())
                else:
                    self._err(404, "not_found", f"no route for POST {self.path}")
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
) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(
        (host, port),
        make_handler(registry, internal_key, service_name, version, model_registry, sessions),
    )
