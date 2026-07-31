"""Behavior → Event translation (AI-3, Architect rec 3 + 11) — the SINGLE place a `BehaviorResult`
becomes a canonical `EventEnvelope`. Behavior analyzers never build envelopes; they emit platform
`BehaviorResult`s and this translator maps them, so behaviors stay independent of the platform event
model. A behaviorType with no mapping is skipped (never guessed) — additive, forward-compatible.

Boundary held (Architect rec 12): the runtime emits `perception.* / behavior.* / analytics.* /
security.*` events, NEVER `incident.*`. Meaning (severity/escalation/schedules) is the Rule Engine's.
Deterministic (id generator injected); stdlib-only.
"""

from __future__ import annotations

from typing import Callable, List, Mapping, Optional

from events import CATEGORY_BY_TYPE, PRIORITY_BY_TYPE, _assert_not_incident, _uuid_gen

_ENVELOPE_VERSION = "1.0.0"
_SCHEMA_VERSION = "1.0.0"

# behaviorType → canonical event type (mirrors packages/contracts/src/events/catalog.ts). Adding a
# behavior is a one-line entry here; the pipeline is untouched.
BEHAVIOR_EVENT_MAP: Mapping[str, str] = {
    "loitering": "behavior.loitering.detected",
    "queue": "analytics.queue.length",
    "intrusion": "security.intrusion.detected",
    "fire": "perception.fire.detected",
    "smoke": "perception.smoke.detected",
}


def event_type_for_behavior(behavior_type: str) -> Optional[str]:
    return BEHAVIOR_EVENT_MAP.get(behavior_type)


class BehaviorResultTranslator:
    """Maps `BehaviorResult` dicts to `EventEnvelope` dicts. The only bridge from perception to the spine."""

    def __init__(self, *, id_gen: Optional[Callable[[], str]] = None) -> None:
        self._id_gen = id_gen or _uuid_gen()

    def translate(self, behavior: Mapping[str, object]) -> Optional[dict]:
        """One BehaviorResult → one EventEnvelope, or None when the behaviorType has no event mapping."""
        behavior_type = str(behavior.get("behaviorType", ""))
        event_type = event_type_for_behavior(behavior_type)
        if event_type is None:
            return None
        _assert_not_incident(event_type)
        at = str(behavior.get("lastObserved") or behavior.get("firstObserved"))
        subjects: List[dict] = [{"trackId": tid} for tid in (behavior.get("subjects") or []) if isinstance(tid, str)]
        if behavior.get("zoneId"):
            for s in subjects or [{}]:
                s["zoneId"] = behavior["zoneId"]
            if not subjects:
                subjects = [{"zoneId": behavior["zoneId"]}]
        payload: dict = {
            "behaviorId": behavior.get("behaviorId"),
            "behaviorType": behavior_type,
            "category": behavior.get("category"),
            "state": behavior.get("state"),
            "metrics": behavior.get("metrics", {}),
        }
        for optional in ("zoneId", "sessionId", "windowMs", "correlationId", "behaviorVersion", "severity"):
            if behavior.get(optional) is not None:
                payload[optional] = behavior[optional]
        envelope: dict = {
            "id": self._id_gen(),
            "type": event_type,
            "envelopeVersion": _ENVELOPE_VERSION,
            "category": CATEGORY_BY_TYPE.get(event_type, "perception"),
            "schemaVersion": _SCHEMA_VERSION,
            "tenantId": str(behavior.get("tenantId", "")),
            "occurredAt": at,
            "ingestedAt": at,
            "producer": {"capability": f"behavior.{behavior_type}", "capabilityVersion": str(behavior.get("behaviorVersion") or "1.0.0")},
            "subjects": subjects,
            "payload": payload,
            "evidenceRefs": [],
            "priority": PRIORITY_BY_TYPE.get(event_type, "info"),
        }
        if behavior.get("cameraId"):
            envelope["cameraId"] = behavior["cameraId"]
        if behavior.get("confidence") is not None:
            envelope["confidence"] = behavior["confidence"]
        if behavior.get("correlationId"):
            envelope["correlationId"] = behavior["correlationId"]
        return envelope

    def translate_all(self, behaviors: List[Mapping[str, object]]) -> List[dict]:
        out: List[dict] = []
        for b in behaviors:
            env = self.translate(b)
            if env is not None:
                out.append(env)
        return out
