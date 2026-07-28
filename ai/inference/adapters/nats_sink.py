"""NatsEventSink (P1-5) — the final pipeline stage wired to the real backbone. Publishes each
`DetectionResult` onto the tenant-partitioned capability-output subject
`t.{tenantId}.capability.output.{capabilityId}`, where the events service consumes it, normalizes it
to an `EventEnvelope`, deduplicates, persists, and re-publishes on `t.{tenantId}.event.*`.

HEAVY / integration-only: `nats-py` is imported LAZILY so the default `null` sink and the entire
stdlib unit-test suite never load it. The runtime is synchronous (http.server); this bridges to the
asyncio NATS client via a private event loop on a daemon thread. Fail-closed: a blank/unsafe tenant
id is refused before it can widen a subject (Law 5), mirroring @vip/messaging's `assertTenantToken`.
"""

from __future__ import annotations

import json
import re
import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    from contracts import DetectionResult

_TENANT_TOKEN = re.compile(r"^[A-Za-z0-9_-]+$")


def capability_output_subject(tenant_id: str, capability_id: str) -> str:
    """`t.{tenantId}.capability.output.{capabilityId}` with a fail-closed tenant token check."""
    if not isinstance(tenant_id, str) or not _TENANT_TOKEN.match(tenant_id):
        raise ValueError(f"unsafe tenantId for subject: {tenant_id!r}")
    return f"t.{tenant_id}.capability.output.{capability_id}"


class NatsEventSink:
    """Sync façade over the asyncio NATS JetStream client. Construct once at bootstrap; `publish`
    is called per detection result from the request thread."""

    def __init__(
        self,
        servers: str,
        *,
        connect_timeout: float = 5.0,
        publish_timeout: float = 5.0,
    ) -> None:
        import asyncio  # noqa: WPS433 - stdlib, but keep bootstrap lazy/local
        from nats.aio.client import Client as Nats  # noqa: WPS433 - HEAVY, integration-only

        self._publish_timeout = publish_timeout
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, name="nats-sink", daemon=True)
        self._thread.start()

        self._nc = Nats()
        self._submit(self._nc.connect(servers=[servers])).result(timeout=connect_timeout)
        self._js = self._nc.jetstream()

    def _run_loop(self) -> None:
        import asyncio  # noqa: WPS433

        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _submit(self, coro):  # noqa: ANN001, ANN202 - asyncio Future
        import asyncio  # noqa: WPS433

        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def publish(self, result: "DetectionResult") -> None:
        subject = capability_output_subject(result.tenant_id, result.capability_id)
        payload = json.dumps(result.to_dict()).encode("utf-8")
        # JetStream ack confirms the message is durably stored on the capability-output stream.
        self._submit(self._js.publish(subject, payload)).result(timeout=self._publish_timeout)

    def close(self) -> None:
        try:
            self._submit(self._nc.drain()).result(timeout=5.0)
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)
