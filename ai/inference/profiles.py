"""Behavior Profiles (AI-4, Architect rec 3/4/7/9 + refinements 3/4/5/7) — the DECLARATIVE deployment
mechanism for every industry. A profile configures GENERIC analyzers + composite rules for a
deployment (retail/hospital/warehouse/…); it carries NO workflow or business logic (that is the Rule
Engine's) and is **portable** — it references generic zone ROLES + runtime config, never tenant/camera/
zone IDs (rec 7). Retail is simply the first profile; a new customer onboards by authoring a profile,
never new analyzer code (rec 9).

`build_from_profile` fails fast (rec 3) if a profile references an unknown analyzer, an unknown
required behavior type, an unknown zone role, embeds a forbidden id (rec 7), or defines a circular
composite graph (rec 5). Stdlib-only, deterministic.
"""

from __future__ import annotations

import json
from typing import Dict, List, Tuple

from behavior_contracts import BehaviorConfig
from behavior_registry import BehaviorRegistry
from behaviors import ANALYZER_TYPES
from composite import CompositeRule, RuleCompositeAnalyzer
from composite_registry import CompositeRegistry

# Behavior types the primitive analyzers can emit (fire emits both fire + smoke).
PRIMITIVE_BEHAVIOR_TYPES = {"loitering", "queue", "intrusion", "crowd", "occupancy", "fire", "smoke"}

# Known generic zone roles (mirrors the @vip/contracts ZoneRole enum; open set, documented here).
KNOWN_ZONE_ROLES = {"entrance", "exit", "checkout", "cash", "queue", "restricted", "storage", "loading", "aisle"}

# Portability guard (rec 7): a profile must never embed deployment-specific identifiers.
FORBIDDEN_KEYS = {"tenantId", "cameraId", "zoneId", "tenant_id", "camera_id", "zone_id"}


class ProfileError(ValueError):
    """Raised with a clear, aggregated diagnostic when a profile fails validation."""


def _scan_forbidden(node: object, path: str, errors: List[str]) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            if k in FORBIDDEN_KEYS:
                errors.append(f"profile is not portable: forbidden key '{k}' at {path or '<root>'} (use zone roles + config)")
            _scan_forbidden(v, f"{path}.{k}" if path else k, errors)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _scan_forbidden(v, f"{path}[{i}]", errors)


def validate_profile(raw: dict) -> List[str]:
    """Return a list of validation errors (empty = valid). Fail-fast diagnostics for rec 3/7."""
    errors: List[str] = []
    if not isinstance(raw, dict):
        return ["profile must be a JSON object"]
    if not raw.get("profile"):
        errors.append("profile: missing required 'profile' name")

    _scan_forbidden(raw, "", errors)

    analyzers = raw.get("analyzers", {})
    if not isinstance(analyzers, dict):
        errors.append("profile.analyzers must be an object")
        analyzers = {}
    for name in analyzers:
        if name not in ANALYZER_TYPES:
            errors.append(f"profile.analyzers references unknown analyzer '{name}' (known: {sorted(ANALYZER_TYPES)})")

    composites = raw.get("composites", [])
    composite_types = {str(c.get("behaviorType")) for c in composites if isinstance(c, dict)}
    known_types = PRIMITIVE_BEHAVIOR_TYPES | composite_types
    for c in composites:
        if not isinstance(c, dict):
            errors.append("profile.composites entries must be objects")
            continue
        name = c.get("name", "<unnamed>")
        for key in ("name", "behaviorType", "eventType", "category"):
            if not c.get(key):
                errors.append(f"composite '{name}': missing required '{key}'")
        req = c.get("requiredTypes") or []
        if not req:
            errors.append(f"composite '{name}': requiredTypes must be non-empty")
        for t in req:
            if t not in known_types:
                errors.append(f"composite '{name}': requiredTypes references unknown behavior type '{t}'")
        role = c.get("zoneRole")
        if role is not None and role not in KNOWN_ZONE_ROLES:
            errors.append(f"composite '{name}': unknown zoneRole '{role}' (known: {sorted(KNOWN_ZONE_ROLES)})")
    return errors


def build_from_profile(raw: dict) -> Tuple[BehaviorRegistry, CompositeRegistry]:
    """Validate then build the primitive + composite registries a profile declares. Raises ProfileError
    (fail-fast) on any validation problem, including a circular composite graph (rec 5)."""
    errors = validate_profile(raw)
    if errors:
        raise ProfileError("invalid behavior profile:\n  - " + "\n  - ".join(errors))

    analyzers_cfg = raw.get("analyzers", {})
    registry = BehaviorRegistry()
    for name, cls in ANALYZER_TYPES.items():
        acfg = analyzers_cfg.get(name)
        config = BehaviorConfig.from_dict(acfg) if acfg else BehaviorConfig(enabled=False)
        registry.register(cls(config=config))
        if not (acfg and config.enabled):
            registry.disable(name)

    composites = CompositeRegistry()
    for c in raw.get("composites", []):
        composites.register(RuleCompositeAnalyzer(CompositeRule.from_dict(c)))
    composites.validate_acyclic()  # rec 5 — reject cycles at build time
    return registry, composites


def load_profile(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def zone_roles_from_zones(zones) -> Dict[str, str]:
    """Build the zone_id→role map the composite context needs, from generic `Zone.attributes.role`.
    Roles live on the zone config (portable); the profile never hardcodes zone ids (rec 7)."""
    roles: Dict[str, str] = {}
    for z in zones:
        role = z.attributes.get("role")
        if isinstance(role, str) and role:
            roles[z.id] = role
    return roles
