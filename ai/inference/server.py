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

from contracts import FrameContext
from errors import ContextRequired, InferenceError
from registry import CapabilityRegistry

_MAX_BODY = 32 * 1024 * 1024  # 32 MiB (a base64 frame)


def make_handler(registry: CapabilityRegistry, internal_key: str, service_name: str, version: str):
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
            if self.path == "/health":
                self._ok({"status": "ok"})
            elif self.path == "/ready":
                self._ready()
            elif self.path == "/":
                self._ok({"name": service_name, "version": version, "runtimeVersion": version})
            elif self.path == "/capabilities":
                self._ok(registry.descriptors())
            elif self.path == "/status":
                self._ok(registry.health())
            elif self.path == "/metrics":
                self._metrics()
            else:
                self._err(404, "not_found", f"no route for GET {self.path}")

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/infer":
                self._err(404, "not_found", f"no route for POST {self.path}")
                return
            if not hmac.compare_digest(self.headers.get("x-internal-key", ""), internal_key):
                self._err(401, "unauthenticated", "invalid internal credentials")
                return
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


def build_server(
    host: str, port: int, registry: CapabilityRegistry, internal_key: str, service_name: str, version: str
) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(registry, internal_key, service_name, version))
