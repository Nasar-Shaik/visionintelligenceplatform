"""Deployment Profiles (AI-5c) — operational defaults as configuration, never code.

A hospital and a parking lot need the same perception pipeline running very differently: 5 fps vs 2,
never-suspend vs suspend-freely, 64-deep queues vs 24. Before AI-5c those choices lived in environment
variables applied uniformly to a whole runtime. A `DeploymentProfile` makes them a **portable,
reviewable artifact** (Architect AI-5b rec 4 / AI-5c refinement 5).

**Two profile kinds, deliberately separate** (this is the distinction that keeps both reusable):

  - `BehaviorProfile` (AI-4, `profiles/*.json`)      — *what to detect*: which analyzers, what
    thresholds, which composites. Perception intent.
  - `DeploymentProfile` (AI-5c, `profiles/deployment/*.json`) — *how hard to work*: sampling rate,
    queue sizes, priorities, scheduling, degradation ceiling. Operational envelope.

A hospital can therefore run retail's behavior set on hospital-grade operational settings without
either profile knowing the other exists.

Profiles are **portable**: no tenant ids, no camera ids, no site ids — the same `warehouse.json` ships
to every warehouse customer. Validation is **fail-fast** (an unknown field or an impossible limit is a
`configuration` failure at load, never a surprise at 3am). Stdlib-only.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from errors import ConfigurationFailure
from health import HealthPolicy
from model_lifecycle import ModelLifecyclePolicy
from recovery import RecoveryPolicy
from scheduler import SchedulerPolicy

_HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOYMENT_PROFILES_DIR = os.path.join(_HERE, "profiles", "deployment")

_PRIORITIES = ("low", "normal", "high", "critical")
_DROP_POLICIES = ("drop-oldest", "drop-newest")
# Identifiers that would make a profile non-portable if embedded.
_FORBIDDEN_KEYS = ("tenantId", "tenant_id", "cameraId", "camera_id", "siteId", "site_id", "zoneId")


@dataclass
class DeploymentProfile:
    """Operational defaults for one deployment kind. Mirrors the `DeploymentProfile` contract."""

    profile: str
    version: str = "1.0.0"
    description: Optional[str] = None
    target_fps: float = 5.0
    queue_capacity: int = 32
    drop_policy: str = "drop-oldest"
    max_sessions: int = 8
    default_priority: str = "normal"
    target_event_latency_ms: Optional[float] = None
    preferred_stream_profile: Optional[str] = None
    enabled_behaviors: List[str] = field(default_factory=list)
    analyzer_costs: Dict[str, float] = field(default_factory=dict)
    protected_analyzers: List[str] = field(default_factory=list)
    sampling_stride: Optional[int] = None
    reconnect_max_attempts: int = 10
    reconnect_base_ms: float = 500.0
    reconnect_max_ms: float = 30000.0
    scheduler: SchedulerPolicy = field(default_factory=SchedulerPolicy)
    # AI-5d: health thresholds, recovery budgets and model-transition strictness are all operational
    # policy, which is exactly what a deployment profile is for. A hospital and a retail store then
    # differ by configuration alone (Architect AI-5d rec 4).
    health: HealthPolicy = field(default_factory=HealthPolicy)
    recovery: RecoveryPolicy = field(default_factory=RecoveryPolicy)
    model_lifecycle: ModelLifecyclePolicy = field(default_factory=ModelLifecyclePolicy)

    def to_dict(self) -> dict:
        out: dict = {
            "profile": self.profile,
            "version": self.version,
            "targetFps": self.target_fps,
            "queueCapacity": self.queue_capacity,
            "dropPolicy": self.drop_policy,
            "maxSessions": self.max_sessions,
            "defaultPriority": self.default_priority,
            "enabledBehaviors": list(self.enabled_behaviors),
        }
        for key, value in (
            ("description", self.description),
            ("targetEventLatencyMs", self.target_event_latency_ms),
            ("preferredStreamProfile", self.preferred_stream_profile),
            ("samplingStride", self.sampling_stride),
        ):
            if value is not None:
                out[key] = value
        if self.analyzer_costs or self.protected_analyzers:
            out["analyzerCosts"] = {
                "costs": dict(self.analyzer_costs),
                "protectedAnalyzers": list(self.protected_analyzers),
            }
        out["recovery"] = {
            "maxRestarts": self.recovery.max_restarts,
            "restartWindowSeconds": self.recovery.restart_window_seconds,
            "unlimitedRestarts": self.recovery.unlimited_restarts,
            "baseCooldownMs": self.recovery.base_cooldown_ms,
            "maxCooldownMs": self.recovery.max_cooldown_ms,
            "requireOperatorApproval": self.recovery.require_operator_approval,
            "stabilizationSeconds": self.recovery.stabilization_seconds,
            "autoRecoverCategories": list(self.recovery.auto_recover_categories),
        }
        out["health"] = {
            "degradedBelow": self.health.degraded_below,
            "unhealthyBelow": self.health.unhealthy_below,
            "trendWindowSamples": self.health.trend_window_samples,
            "projectionHorizonSamples": self.health.projection_horizon_samples,
            "predictiveDegradation": self.health.predictive_degradation,
            "stabilizationSamples": self.health.stabilization_samples,
        }
        return out


def parse_profile(doc: dict) -> DeploymentProfile:
    """Build + fail-fast validate a `DeploymentProfile` from its wire dict.

    Every rejection names the offending field and the acceptable range, because the person reading it
    is an operator editing JSON, not the engineer who wrote the parser.
    """
    if not isinstance(doc, dict):
        raise ConfigurationFailure("deployment profile must be a JSON object")

    name = str(doc.get("profile", "")).strip()
    if not name:
        raise ConfigurationFailure("deployment profile requires a 'profile' name")

    # Portability guard: a profile carrying a tenant/camera/site id cannot ship to another customer.
    for key in _walk_keys(doc):
        if key in _FORBIDDEN_KEYS:
            raise ConfigurationFailure(
                f"deployment profile '{name}' embeds '{key}' — profiles must be portable "
                "(no tenant/camera/site identifiers)"
            )

    target_fps = _positive_number(doc.get("targetFps", 5), "targetFps", name, maximum=120)
    queue_capacity = _positive_int(doc.get("queueCapacity", 32), "queueCapacity", name, maximum=4096)
    max_sessions = _positive_int(doc.get("maxSessions", 8), "maxSessions", name, maximum=512)

    drop_policy = str(doc.get("dropPolicy", "drop-oldest"))
    if drop_policy not in _DROP_POLICIES:
        raise ConfigurationFailure(
            f"deployment profile '{name}': dropPolicy must be one of {_DROP_POLICIES}, got '{drop_policy}'"
        )

    priority = str(doc.get("defaultPriority", "normal"))
    if priority not in _PRIORITIES:
        raise ConfigurationFailure(
            f"deployment profile '{name}': defaultPriority must be one of {_PRIORITIES}, got '{priority}'"
        )

    costs_doc = doc.get("analyzerCosts") or {}
    costs = {str(k): float(v) for k, v in (costs_doc.get("costs") or {}).items()}
    for analyzer, cost in costs.items():
        if cost < 0:
            raise ConfigurationFailure(
                f"deployment profile '{name}': analyzer cost for '{analyzer}' must be >= 0, got {cost}"
            )
    protected = [str(a) for a in (costs_doc.get("protectedAnalyzers") or [])]

    enabled = [str(b) for b in (doc.get("enabledBehaviors") or [])]
    # A protected analyzer that is not enabled is almost certainly a typo, and silently ignoring it
    # would leave an operator believing a safety behavior is protected when it is not even running.
    unknown_protected = [a for a in protected if enabled and a not in enabled]
    if unknown_protected:
        raise ConfigurationFailure(
            f"deployment profile '{name}': protectedAnalyzers {unknown_protected} are not in "
            f"enabledBehaviors {enabled}"
        )

    reconnect = doc.get("reconnect") or {}
    scheduler = _parse_scheduler(doc.get("scheduler") or {}, name)
    health = _parse_health(doc.get("health") or {}, name)
    recovery = _parse_recovery(doc.get("recovery") or {}, name)
    lifecycle = _parse_lifecycle(doc.get("modelLifecycle") or {}, name)

    return DeploymentProfile(
        profile=name,
        version=str(doc.get("version", "1.0.0")),
        description=doc.get("description"),
        target_fps=target_fps,
        queue_capacity=queue_capacity,
        drop_policy=drop_policy,
        max_sessions=max_sessions,
        default_priority=priority,
        target_event_latency_ms=(
            _positive_number(doc["targetEventLatencyMs"], "targetEventLatencyMs", name)
            if doc.get("targetEventLatencyMs") is not None
            else None
        ),
        preferred_stream_profile=doc.get("preferredStreamProfile"),
        enabled_behaviors=enabled,
        analyzer_costs=costs,
        protected_analyzers=protected,
        sampling_stride=(
            _positive_int(doc["samplingStride"], "samplingStride", name, maximum=600)
            if doc.get("samplingStride") is not None
            else None
        ),
        reconnect_max_attempts=int(reconnect.get("maxAttempts", 10)),
        reconnect_base_ms=float(reconnect.get("baseMs", 500.0)),
        reconnect_max_ms=float(reconnect.get("maxMs", 30000.0)),
        scheduler=scheduler,
        health=health,
        recovery=recovery,
        model_lifecycle=lifecycle,
    )


def _parse_scheduler(doc: dict, profile_name: str) -> SchedulerPolicy:
    """Map the wire `SchedulerPolicy` onto the runtime dataclass; `SchedulerPolicy.__post_init__`
    enforces the invariants (hysteresis gap, known strategy, known ladder rung)."""
    try:
        return SchedulerPolicy(
            strategy=str(doc.get("strategy", "weighted-fair")),
            max_batch_size=int(doc.get("maxBatchSize", 1)),
            max_consecutive_per_session=int(doc.get("maxConsecutivePerSession", 4)),
            degrade_above_queue_percent=float(doc.get("degradeAboveQueuePercent", 80.0)),
            recover_below_queue_percent=float(doc.get("recoverBelowQueuePercent", 50.0)),
            cpu_ceiling_percent=_opt_float(doc.get("cpuCeilingPercent")),
            memory_ceiling_mb=_opt_float(doc.get("memoryCeilingMb")),
            min_degraded_fps=float(doc.get("minDegradedFps", 1.0)),
            max_degradation=str(doc.get("maxDegradation", "suspended")),
            reduced_resolution_scale=float(doc.get("reducedResolutionScale", 0.5)),
            escalate_after_samples=int(doc.get("escalateAfterSamples", 2)),
            recover_after_samples=int(doc.get("recoverAfterSamples", 3)),
            admission_control=bool(doc.get("admissionControl", True)),
            reserved_capacity_percent=float(doc.get("reservedCapacityPercent", 10.0)),
            reserve_for=tuple(doc.get("reserveFor", ("critical",))),
            predictive=bool(doc.get("predictive", True)),
            trend_window_samples=int(doc.get("trendWindowSamples", 5)),
            predicted_pressure_threshold=float(doc.get("predictedPressureThreshold", 95.0)),
            prediction_horizon_samples=int(doc.get("predictionHorizonSamples", 3)),
        )
    except ConfigurationFailure as exc:
        raise ConfigurationFailure(f"deployment profile '{profile_name}': {exc}") from exc
    except (TypeError, ValueError) as exc:
        raise ConfigurationFailure(f"deployment profile '{profile_name}': invalid scheduler policy — {exc}") from exc


def _parse_health(doc: dict, profile_name: str) -> HealthPolicy:
    """Map the wire `HealthPolicy` onto the runtime dataclass; `__post_init__` enforces the ordering
    invariant between the two thresholds."""
    try:
        return HealthPolicy(
            component_weights={
                str(k): float(v) for k, v in (doc.get("componentWeights") or {}).items()
            },
            degraded_below=float(doc.get("degradedBelow", 80.0)),
            unhealthy_below=float(doc.get("unhealthyBelow", 50.0)),
            trend_window_samples=int(doc.get("trendWindowSamples", 5)),
            projection_horizon_samples=int(doc.get("projectionHorizonSamples", 3)),
            predictive_degradation=bool(doc.get("predictiveDegradation", True)),
            stabilization_samples=int(doc.get("stabilizationSamples", 3)),
        )
    except ConfigurationFailure as exc:
        raise ConfigurationFailure(f"deployment profile '{profile_name}': {exc}") from exc
    except (TypeError, ValueError) as exc:
        raise ConfigurationFailure(
            f"deployment profile '{profile_name}': invalid health policy — {exc}"
        ) from exc


def _parse_recovery(doc: dict, profile_name: str) -> RecoveryPolicy:
    """Map the wire `RecoveryPolicy` onto the runtime dataclass (Architect AI-5d rec 4).

    Rejections are loud on purpose: a profile that asks to auto-recover configuration errors would
    otherwise create a silent restart loop against a mistake only a human can fix.
    """
    try:
        return RecoveryPolicy(
            max_restarts=int(doc.get("maxRestarts", 3)),
            restart_window_seconds=float(doc.get("restartWindowSeconds", 3600.0)),
            unlimited_restarts=bool(doc.get("unlimitedRestarts", False)),
            base_cooldown_ms=float(doc.get("baseCooldownMs", 5000.0)),
            max_cooldown_ms=float(doc.get("maxCooldownMs", 300000.0)),
            require_operator_approval=bool(doc.get("requireOperatorApproval", False)),
            stabilization_seconds=float(doc.get("stabilizationSeconds", 30.0)),
            auto_recover_categories=tuple(
                doc.get("autoRecoverCategories", ("connection", "model"))
            ),
        )
    except ConfigurationFailure as exc:
        raise ConfigurationFailure(f"deployment profile '{profile_name}': {exc}") from exc
    except (TypeError, ValueError) as exc:
        raise ConfigurationFailure(
            f"deployment profile '{profile_name}': invalid recovery policy — {exc}"
        ) from exc


def _parse_lifecycle(doc: dict, profile_name: str) -> ModelLifecyclePolicy:
    """Map the wire `ModelLifecyclePolicy` onto the runtime dataclass."""
    try:
        return ModelLifecyclePolicy(
            validation_frames=int(doc.get("validationFrames", 20)),
            max_validation_latency_ms=_opt_float(doc.get("maxValidationLatencyMs")),
            latency_regression_percent=float(doc.get("latencyRegressionPercent", 25.0)),
            detection_delta_percent=float(doc.get("detectionDeltaPercent", 50.0)),
            drain_ms=float(doc.get("drainMs", 1000.0)),
            auto_rollback=bool(doc.get("autoRollback", True)),
            require_validation=bool(doc.get("requireValidation", True)),
        )
    except ConfigurationFailure as exc:
        raise ConfigurationFailure(f"deployment profile '{profile_name}': {exc}") from exc
    except (TypeError, ValueError) as exc:
        raise ConfigurationFailure(
            f"deployment profile '{profile_name}': invalid model lifecycle policy — {exc}"
        ) from exc


def load_profile(name: str, *, directory: Optional[str] = None) -> DeploymentProfile:
    """Load one deployment profile by name (e.g. `warehouse`)."""
    path = os.path.join(directory or DEPLOYMENT_PROFILES_DIR, f"{name}.json")
    if not os.path.isfile(path):
        available = ", ".join(available_profiles(directory=directory)) or "none"
        raise ConfigurationFailure(f"unknown deployment profile '{name}' (available: {available})")
    with open(path, encoding="utf-8") as fh:
        try:
            doc = json.load(fh)
        except json.JSONDecodeError as exc:
            raise ConfigurationFailure(f"deployment profile '{name}' is not valid JSON: {exc}") from exc
    return parse_profile(doc)


def available_profiles(*, directory: Optional[str] = None) -> List[str]:
    target = directory or DEPLOYMENT_PROFILES_DIR
    if not os.path.isdir(target):
        return []
    return sorted(f[:-5] for f in os.listdir(target) if f.endswith(".json"))


def load_all(*, directory: Optional[str] = None) -> Dict[str, DeploymentProfile]:
    """Load every shipped profile — used by tests to prove they all validate."""
    return {name: load_profile(name, directory=directory) for name in available_profiles(directory=directory)}


# --- camera capability reconciliation (Architect AI-5b rec 1) -------------------------------------


def resolve_stream_settings(
    *,
    requested_fps: float,
    capabilities: Optional[dict] = None,
    preferred_profile: Optional[str] = None,
) -> dict:
    """Reconcile what we WANT with what the camera CAN DO — by reading declared capabilities rather
    than probing the device (Architect AI-5b rec 1).

    Probing costs a connection and a decode on every session start; declared capabilities cost nothing
    on the Nth restart. Returns the settings to use plus the reasons anything was adjusted, so an
    operator can see why their requested 15 fps became 10.
    """
    result: dict = {"targetFps": float(requested_fps), "adjustments": [], "probed": False}
    if not capabilities:
        return result

    fps_range = capabilities.get("fpsRange")
    if isinstance(fps_range, dict):
        low, high = fps_range.get("min"), fps_range.get("max")
        if high is not None and result["targetFps"] > float(high):
            result["adjustments"].append(
                f"targetFps {result['targetFps']:g} → {float(high):g} (camera maximum)"
            )
            result["targetFps"] = float(high)
        if low is not None and result["targetFps"] < float(low):
            result["adjustments"].append(
                f"targetFps {result['targetFps']:g} → {float(low):g} (camera minimum)"
            )
            result["targetFps"] = float(low)

    profiles = capabilities.get("streamProfiles") or []
    chosen = None
    if preferred_profile:
        chosen = next((p for p in profiles if p.get("name") == preferred_profile), None)
        if chosen is None and profiles:
            result["adjustments"].append(
                f"stream profile '{preferred_profile}' not offered by this camera; using default"
            )
    if chosen is None:
        chosen = next((p for p in profiles if p.get("preferredForAnalysis")), None)
    if chosen is not None:
        result["streamProfile"] = chosen.get("name")
        if chosen.get("resolution"):
            result["resolution"] = chosen["resolution"]
        if chosen.get("path"):
            result["streamPath"] = chosen["path"]
        if chosen.get("fps") is not None and result["targetFps"] > float(chosen["fps"]):
            result["adjustments"].append(
                f"targetFps {result['targetFps']:g} → {float(chosen['fps']):g} (stream profile maximum)"
            )
            result["targetFps"] = float(chosen["fps"])
    return result


# --- helpers ---------------------------------------------------------------------------------------


def _walk_keys(doc, depth: int = 0):
    """Yield every key in a nested structure (bounded depth — a profile is not a tree of unknown size)."""
    if depth > 6:
        return
    if isinstance(doc, dict):
        for key, value in doc.items():
            yield key
            yield from _walk_keys(value, depth + 1)
    elif isinstance(doc, list):
        for item in doc:
            yield from _walk_keys(item, depth + 1)


def _positive_number(value, field_name: str, profile: str, *, maximum: Optional[float] = None) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise ConfigurationFailure(f"deployment profile '{profile}': {field_name} must be a number, got '{value}'") from None
    if parsed <= 0:
        raise ConfigurationFailure(f"deployment profile '{profile}': {field_name} must be > 0, got {parsed}")
    if maximum is not None and parsed > maximum:
        raise ConfigurationFailure(f"deployment profile '{profile}': {field_name} must be <= {maximum}, got {parsed}")
    return parsed


def _positive_int(value, field_name: str, profile: str, *, maximum: Optional[int] = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ConfigurationFailure(f"deployment profile '{profile}': {field_name} must be an integer, got '{value}'") from None
    if parsed < 1:
        raise ConfigurationFailure(f"deployment profile '{profile}': {field_name} must be >= 1, got {parsed}")
    if maximum is not None and parsed > maximum:
        raise ConfigurationFailure(f"deployment profile '{profile}': {field_name} must be <= {maximum}, got {parsed}")
    return parsed


def _opt_float(value) -> Optional[float]:
    return None if value is None else float(value)
