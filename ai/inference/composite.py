"""Composite Behavior tier (AI-4, Architect rec 1/5/6) — the fifth platform contract in the chain
`DetectionResult → Track → BehaviorResult → CompositeBehavior → EventEnvelope`.

A **CompositeBehaviorAnalyzer** consumes ONLY `BehaviorResult`s (never Detections / Tracks / ZoneEngine
internals — rec 5) and produces higher-order `BehaviorResult`s that reference their contributors via
`relatedBehaviorIds`. The composition engine is **domain-neutral** (rec 1): retail/healthcare/etc. are
CONFIGURATION, never new types. The generic **`RuleCompositeAnalyzer`** evaluates a declarative rule
("these behavior types co-occur on the same subject/zone, optionally with a dwell threshold, in a zone
of a given role") — so a customer defines new composites in config, not code (rec 11).

Composite is still PERCEPTION (rec 10): it answers "what was observed?", never "what should happen?"
(no schedules / permissions / business hours / POS). Stdlib-only, deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Protocol, Sequence, Tuple

from behavior import BehaviorObservation
from behavior_contracts import BehaviorCategory, BehaviorConfig, BehaviorResult


@dataclass(frozen=True)
class CompositeContext:
    """Immutable per-frame input for composite analyzers — the ACTIVE primitive BehaviorResults plus a
    plain zone_id→role map (so composites target zones by role without touching the ZoneEngine — rec 5)."""

    tenant_id: str
    camera_id: str
    frame_index: int
    at: str
    t: float
    behaviors: Tuple[BehaviorResult, ...]
    zone_roles: Dict[str, str] = field(default_factory=dict)
    session_id: Optional[str] = None

    def by_type(self, behavior_type: str) -> List[BehaviorResult]:
        return [b for b in self.behaviors if b.behavior_type == behavior_type]

    def role_of(self, zone_id: Optional[str]) -> Optional[str]:
        return self.zone_roles.get(zone_id) if zone_id else None


class CompositeBehaviorAnalyzer(Protocol):
    """The composite seam. Like `BehaviorAnalyzer`, but its input is BehaviorResults, not Tracks."""

    name: str
    behavior_type: str
    category: BehaviorCategory
    version: str
    config: BehaviorConfig

    def analyze(self, ctx: CompositeContext) -> List[BehaviorObservation]:
        ...


# --- confidence strategies (Architect AI-4 refinement 2) — replaceable without any downstream change --

def _confidence(values: Sequence[float], strategy: str) -> float:
    if not values:
        return 0.0
    if strategy == "max":
        return max(values)
    if strategy == "mean":
        return sum(values) / len(values)
    if strategy == "weighted":  # confidence-weighted mean (emphasizes higher-confidence contributors)
        denom = sum(values)
        return sum(v * v for v in values) / denom if denom else 0.0
    return min(values)  # default: the weakest link


@dataclass
class CompositeRule:
    """Declarative composite definition (mirrors the `BehaviorProfile.composites[]` contract)."""

    name: str
    behavior_type: str
    category: BehaviorCategory
    event_type: str
    required_types: List[str]
    zone_role: Optional[str] = None
    min_dwell_seconds: Optional[float] = None
    group_by: str = "subject"  # or "zone"
    strategy: str = "all_of"
    confidence_strategy: str = "min"
    version: str = "1.0.0"

    @staticmethod
    def from_dict(raw: dict) -> "CompositeRule":
        return CompositeRule(
            name=str(raw["name"]),
            behavior_type=str(raw["behaviorType"]),
            category=BehaviorCategory(str(raw.get("category", "operational"))),
            event_type=str(raw["eventType"]),
            required_types=[str(t) for t in raw["requiredTypes"]],
            zone_role=(str(raw["zoneRole"]) if raw.get("zoneRole") else None),
            min_dwell_seconds=(float(raw["minDwellSeconds"]) if raw.get("minDwellSeconds") is not None else None),
            group_by=str(raw.get("groupBy", "subject")),
            strategy=str(raw.get("strategy", "all_of")),
            confidence_strategy=str(raw.get("confidenceStrategy", "min")),
            version=str(raw.get("version", "1.0.0")),
        )


class RuleCompositeAnalyzer:
    """A GENERIC, config-driven composite (Architect AI-4 rec 1/11). One class serves every deployment;
    retail cash-counter / checkout / staff monitoring are just different `CompositeRule` configs."""

    def __init__(self, rule: CompositeRule, *, config: BehaviorConfig | None = None) -> None:
        self.rule = rule
        self.name = rule.name
        self.behavior_type = rule.behavior_type
        self.category = rule.category
        self.version = rule.version
        self.config = config or BehaviorConfig()

    def analyze(self, ctx: CompositeContext) -> List[BehaviorObservation]:
        rule = self.rule
        # Only behaviors of the required types participate; optionally restrict to a zone role.
        candidates = [b for b in ctx.behaviors if b.behavior_type in rule.required_types]
        if rule.zone_role is not None:
            candidates = [b for b in candidates if ctx.role_of(b.zone_id) == rule.zone_role]
        if not candidates:
            return []

        groups: Dict[str, List[BehaviorResult]] = {}
        for b in candidates:
            key = (b.subjects[0] if b.subjects else b.behavior_id) if rule.group_by == "subject" else (b.zone_id or "")
            groups.setdefault(key, []).append(b)

        out: List[BehaviorObservation] = []
        required = set(rule.required_types)
        for key, members in sorted(groups.items()):
            present = {b.behavior_type for b in members}
            if not required.issubset(present):  # all_of strategy
                continue
            if rule.min_dwell_seconds is not None:
                dwell = max((float(b.metrics.get("dwellSeconds", 0.0)) for b in members), default=0.0)
                if dwell < rule.min_dwell_seconds:
                    continue
            confs = [b.confidence for b in members]
            confidence = round(_confidence(confs, rule.confidence_strategy), 6)
            subjects = sorted({s for b in members for s in b.subjects})
            zones = sorted({b.zone_id for b in members if b.zone_id})
            contributor_ids = [b.behavior_id for b in members]
            trace = [{"behaviorType": b.behavior_type, "behaviorId": b.behavior_id, "state": b.state.value} for b in members]
            evidence: Dict[str, object] = {}
            if subjects:
                evidence["contributingTracks"] = subjects
            if zones:
                evidence["contributingZones"] = zones
            composite_meta = {
                "contributingBehaviorCount": len(members),
                "evaluationStrategy": rule.strategy,
                "compositionVersion": rule.version,
            }
            out.append(
                BehaviorObservation(
                    key=f"{rule.name}:{key}",
                    confidence=confidence,
                    subjects=subjects,
                    metrics={"contributingBehaviorCount": float(len(members))},
                    zone_id=(zones[0] if zones else None),
                    related_behavior_ids=contributor_ids,
                    evidence=evidence or None,
                    composite_meta=composite_meta,
                    attributes={"eventType": rule.event_type, "compositeTrace": trace},
                )
            )
        return out
