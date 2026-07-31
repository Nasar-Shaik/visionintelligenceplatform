"""Event generation (P2-2 G-3) — turn a runtime DetectionResult into normalized `EventEnvelope`
objects (the platform's currency, docs/architecture/09). This is the runtime's `translate → publish`
made concrete.

**Invariant (Architect):** the inference runtime produces **EventEnvelope** objects ONLY. It NEVER
creates an incident — meaning is assigned later by the rules/workflow contexts (Law 1/3, P1-7/P1-8).
Every generated type is asserted to be a `perception.*` / `behavior.*` / `analytics.*` / `system.*`
event, never `incident.*`.

Labels are mapped to canonical event types via a small, domain-neutral table that mirrors the
`@vip/contracts` event catalog; an unmapped label falls back to the generic
`perception.object.detected`. Pure + deterministic (id generator + clock injected); stdlib-only.
"""

from __future__ import annotations

import itertools
from typing import Callable, Dict, List, Mapping, Optional

_ENVELOPE_VERSION = "1.0.0"
_SCHEMA_VERSION = "1.0.0"

# label → canonical event type. Kept in sync with packages/contracts/src/events/catalog.ts.
LABEL_EVENT_MAP: Dict[str, str] = {
    "person": "perception.person.detected",
    "vehicle": "perception.vehicle.detected",
    "car": "perception.vehicle.detected",
    "truck": "perception.vehicle.detected",
    "bus": "perception.vehicle.detected",
    "fire": "perception.fire.detected",
    "flame": "perception.fire.detected",
    "smoke": "perception.smoke.detected",
    "weapon": "perception.weapon.detected",
    "gun": "perception.weapon.detected",
    "knife": "perception.weapon.detected",
    "face": "perception.face.detected",
    "pose": "perception.pose.detected",
}

# event type → coarse category (mirrors the TS catalog's category assignment).
CATEGORY_BY_TYPE: Dict[str, str] = {
    "perception.object.detected": "perception",
    "perception.person.detected": "perception",
    "perception.vehicle.detected": "perception",
    "perception.face.detected": "perception",
    "perception.pose.detected": "perception",
    "perception.fire.detected": "safety",
    "perception.smoke.detected": "safety",
    "perception.weapon.detected": "security",
    "safety.ppe.violation": "safety",
    "behavior.theft.suspected": "security",
    "behavior.fight.detected": "security",
    "behavior.fall.detected": "safety",
    "behavior.loitering.detected": "security",
    "analytics.people.count": "analytics",
    "analytics.queue.length": "analytics",
    "analytics.crowd.density": "analytics",  # AI-4
    "analytics.occupancy.changed": "analytics",
    "security.intrusion.detected": "security",  # AI-3 (perception primitive; rules decide significance)
    "behavior.theft.suspected": "security",  # AI-4 composite target (retail cash anomaly, config-driven)
    # spatial/tracking (AI-2) — mirror the TS catalog (spatial.zone.* is category "perception").
    "spatial.zone.entered": "perception",
    "spatial.zone.exited": "perception",
    "tracking.track.updated": "perception",
    "system.model.failed": "system",
}

# event type → default priority (mirrors the TS catalog).
PRIORITY_BY_TYPE: Dict[str, str] = {
    "perception.object.detected": "info",
    "perception.person.detected": "info",
    "perception.vehicle.detected": "info",
    "perception.face.detected": "info",
    "perception.pose.detected": "info",
    "perception.fire.detected": "critical",
    "perception.smoke.detected": "critical",
    "perception.weapon.detected": "critical",
    "safety.ppe.violation": "high",
    "behavior.theft.suspected": "high",
    "behavior.fight.detected": "high",
    "behavior.fall.detected": "high",
    "behavior.loitering.detected": "medium",
    "analytics.people.count": "info",
    "analytics.queue.length": "info",
    "analytics.crowd.density": "low",  # AI-4
    "analytics.occupancy.changed": "low",
    "behavior.theft.suspected": "high",  # AI-4 composite target
    "security.intrusion.detected": "high",  # AI-3
    "spatial.zone.entered": "info",
    "spatial.zone.exited": "info",
    "tracking.track.updated": "info",
    "system.model.failed": "high",
}

_GENERIC = "perception.object.detected"


def event_type_for_label(label: str) -> str:
    """Map a detection label to a canonical event type (generic fallback if unmapped)."""
    return LABEL_EVENT_MAP.get(label.strip().lower(), _GENERIC)


def _uuid_gen() -> Callable[[], str]:
    import uuid

    return lambda: str(uuid.uuid4())


def _assert_not_incident(event_type: str) -> None:
    # Hard invariant: the runtime never authors incidents.
    if event_type.startswith("incident."):
        raise AssertionError("inference runtime must never generate incident.* events")


def detections_to_events(
    result: Mapping[str, object],
    *,
    id_gen: Optional[Callable[[], str]] = None,
    ingested_at: Optional[str] = None,
) -> List[dict]:
    """Map a DetectionResult dict (see contracts.py `DetectionResult.to_dict`) to one EventEnvelope
    per detection. Deterministic when `id_gen` is supplied. Returns [] when there are no detections."""
    gen = id_gen or _uuid_gen()
    tenant_id = str(result.get("tenantId", ""))
    camera_id = result.get("cameraId")
    capability = str(result.get("capabilityId", ""))
    capability_version = str(result.get("capabilityVersion", "1.0.0"))
    model = result.get("model") if isinstance(result.get("model"), dict) else {}
    model_version = str(model.get("version")) if isinstance(model, dict) and model.get("version") else None
    frame = result.get("frame") if isinstance(result.get("frame"), dict) else {}
    occurred_at = str(frame.get("capturedAt") or result.get("at"))
    ingested = ingested_at or str(result.get("at"))
    correlation_id = result.get("correlationId")

    events: List[dict] = []
    detections = result.get("detections")
    if not isinstance(detections, list):
        return events
    for det in detections:
        if not isinstance(det, dict):
            continue
        label = str(det.get("label", "object"))
        event_type = event_type_for_label(label)
        _assert_not_incident(event_type)
        producer: dict = {"capability": capability, "capabilityVersion": capability_version}
        if model_version:
            producer["modelVersion"] = model_version
        subject: dict = {"class": label}
        if isinstance(det.get("bbox"), list):
            subject["bbox"] = det["bbox"]
        if isinstance(det.get("trackingId"), str):
            subject["trackId"] = det["trackingId"]
        envelope: dict = {
            "id": gen(),
            "type": event_type,
            "envelopeVersion": _ENVELOPE_VERSION,
            "category": CATEGORY_BY_TYPE.get(event_type, "perception"),
            "schemaVersion": _SCHEMA_VERSION,
            "tenantId": tenant_id,
            "occurredAt": occurred_at,
            "ingestedAt": ingested,
            "producer": producer,
            "confidence": det.get("confidence"),
            "subjects": [subject],
            "payload": {"label": label, **(det.get("attributes") or {})},
            "evidenceRefs": [],
            "priority": PRIORITY_BY_TYPE.get(event_type, "info"),
        }
        if isinstance(camera_id, str) and camera_id:
            envelope["cameraId"] = camera_id
        if isinstance(correlation_id, str) and correlation_id:
            envelope["correlationId"] = correlation_id
        events.append(envelope)
    return events


def model_failed_event(
    tenant_id: str,
    capability_id: str,
    error: str,
    *,
    capability_version: str = "1.0.0",
    camera_id: Optional[str] = None,
    at: str,
    id_gen: Optional[Callable[[], str]] = None,
) -> dict:
    """Build a `system.model.failed` EventEnvelope — the runtime's health signal on a load/inference
    failure. Never an incident; rules/workflow decide what a failure means (self-healing/rollback)."""
    gen = id_gen or _uuid_gen()
    event_type = "system.model.failed"
    _assert_not_incident(event_type)
    envelope: dict = {
        "id": gen(),
        "type": event_type,
        "envelopeVersion": _ENVELOPE_VERSION,
        "category": "system",
        "schemaVersion": _SCHEMA_VERSION,
        "tenantId": tenant_id,
        "occurredAt": at,
        "ingestedAt": at,
        "producer": {"capability": capability_id, "capabilityVersion": capability_version},
        "subjects": [],
        "payload": {"error": error, "capabilityId": capability_id},
        "evidenceRefs": [],
        "priority": PRIORITY_BY_TYPE[event_type],
    }
    if camera_id:
        envelope["cameraId"] = camera_id
    return envelope


# Canonical operational system events (P2-2 G-3) — mirror @vip/contracts event-types SYSTEM_EVENTS.
SYSTEM_EVENT_TYPES = frozenset(
    {
        "system.camera.connected",
        "system.camera.disconnected",
        "system.stream.started",
        "system.stream.stopped",
        "system.stream.reconnected",
        "system.stream.timeout",
        "system.recording.started",
        "system.recording.stopped",
        "system.model.loaded",
        "system.model.unloaded",
        "system.model.failed",
        "system.pipeline.started",
        "system.pipeline.stopped",
    }
)

_SYSTEM_PRIORITY = {
    "system.camera.disconnected": "high",
    "system.stream.timeout": "medium",
    "system.model.failed": "high",
}


def system_event(
    event_type: str,
    tenant_id: str,
    *,
    at: str,
    camera_id: Optional[str] = None,
    payload: Optional[Mapping[str, object]] = None,
    id_gen: Optional[Callable[[], str]] = None,
) -> dict:
    """Build an operational `system.*` EventEnvelope (camera/stream/recording/model/pipeline
    lifecycle) for monitoring/troubleshooting. Never an incident."""
    if event_type not in SYSTEM_EVENT_TYPES:
        raise ValueError(f"unknown system event type '{event_type}'")
    _assert_not_incident(event_type)
    gen = id_gen or _uuid_gen()
    envelope: dict = {
        "id": gen(),
        "type": event_type,
        "envelopeVersion": _ENVELOPE_VERSION,
        "category": "system",
        "schemaVersion": _SCHEMA_VERSION,
        "tenantId": tenant_id,
        "occurredAt": at,
        "ingestedAt": at,
        "producer": {"capability": "system.inference-runtime", "capabilityVersion": "1.0.0"},
        "subjects": [],
        "payload": dict(payload or {}),
        "evidenceRefs": [],
        "priority": _SYSTEM_PRIORITY.get(event_type, "info"),
    }
    if camera_id:
        envelope["cameraId"] = camera_id
    return envelope


def deterministic_id_gen(prefix: str = "evt") -> Callable[[], str]:
    """A sequential id generator for deterministic tests."""
    counter = itertools.count(1)
    return lambda: f"{prefix}_{next(counter)}"


# --- tracking / spatial events (AI-2) -----------------------------------------------------------
# Built from platform Track/Zone primitives (never tracker internals). Business-neutral: the runtime
# emits the geometry/counting fact; the Rule Engine decides what it means. Camera + session identity
# always retained (multi-camera-ready). `confidence` is derived from track quality (additive).


def zone_transition_event(
    transition: Mapping[str, object],
    *,
    id_gen: Optional[Callable[[], str]] = None,
) -> dict:
    """A `ZoneTransition` dict → a `spatial.zone.entered|exited` EventEnvelope."""
    gen = id_gen or _uuid_gen()
    event_type = "spatial.zone.entered" if transition.get("transition") == "entered" else "spatial.zone.exited"
    _assert_not_incident(event_type)
    at = str(transition.get("at"))
    subject: dict = {"trackId": transition.get("trackId"), "zoneId": transition.get("zoneId")}
    envelope: dict = {
        "id": gen(),
        "type": event_type,
        "envelopeVersion": _ENVELOPE_VERSION,
        "category": CATEGORY_BY_TYPE[event_type],
        "schemaVersion": _SCHEMA_VERSION,
        "tenantId": str(transition.get("tenantId", "")),
        "occurredAt": at,
        "ingestedAt": at,
        "producer": {"capability": "tracking.zone", "capabilityVersion": "1.0.0"},
        "subjects": [subject],
        "payload": {
            "zoneId": transition.get("zoneId"),
            "trackId": transition.get("trackId"),
            "transition": transition.get("transition"),
            **({"sessionId": transition["sessionId"]} if transition.get("sessionId") else {}),
        },
        "evidenceRefs": [],
        "priority": PRIORITY_BY_TYPE[event_type],
    }
    if transition.get("cameraId"):
        envelope["cameraId"] = transition["cameraId"]
    if transition.get("confidence") is not None:
        envelope["confidence"] = transition["confidence"]  # event confidence from track quality
    return envelope


def counting_event(
    snapshot: Mapping[str, object],
    *,
    id_gen: Optional[Callable[[], str]] = None,
) -> dict:
    """A `CountingSnapshot` dict → an `analytics.occupancy.changed` EventEnvelope."""
    gen = id_gen or _uuid_gen()
    event_type = "analytics.occupancy.changed"
    _assert_not_incident(event_type)
    at = str(snapshot.get("at"))
    envelope: dict = {
        "id": gen(),
        "type": event_type,
        "envelopeVersion": _ENVELOPE_VERSION,
        "category": CATEGORY_BY_TYPE[event_type],
        "schemaVersion": _SCHEMA_VERSION,
        "tenantId": str(snapshot.get("tenantId", "")),
        "occurredAt": at,
        "ingestedAt": at,
        "producer": {"capability": "tracking.counting", "capabilityVersion": "1.0.0"},
        "subjects": [{"zoneId": snapshot.get("zoneId")}],
        "payload": {
            "zoneId": snapshot.get("zoneId"),
            "entered": snapshot.get("entered"),
            "exited": snapshot.get("exited"),
            "occupancy": snapshot.get("occupancy"),
        },
        "evidenceRefs": [],
        "priority": PRIORITY_BY_TYPE[event_type],
    }
    if snapshot.get("cameraId"):
        envelope["cameraId"] = snapshot["cameraId"]
    return envelope
