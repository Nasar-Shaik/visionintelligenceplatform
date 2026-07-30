"""Managed Model Registry (P2-2 G-3) — the control plane over the runtime's models.

Distinct from the manifest-driven CapabilityRegistry (which loads *capabilities*): this registry
tracks concrete **models** (YOLOv11/12, Fire, Smoke, Face, Pose, PPE …), each with append-only
**versions**, an **active version** selection, **metadata**, **capabilities** it can serve, and an
**enabled/disabled** status. Model execution stays behind the `ModelAdapter`/engine seam — this
registry never imports an engine; it records *which* model+version+engine a capability should run.

Tenant-scoped: every model belongs to a tenant; lookups are always `(tenant_id, model_id)`, so one
tenant can never address another's models (fail-closed, Law 5). Stdlib-only, deterministic (the
clock + id generator are injected), and produces dicts with the SAME camelCase field names as the
`@vip/contracts` `model-registration` / `model-version` schemas (parity asserted in tests).
"""

from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from errors import Conflict, NotFound, ValidationError

_ENGINES = ("yolo", "onnx", "tensorrt", "openvino", "python-custom")
_STATUSES = ("enabled", "disabled")


def _iso(now: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"


@dataclass
class ModelCapabilityProfile:
    """Structured, queryable model capabilities (P2-2 G-3) — mirrors @vip/contracts
    `model-capability-profile`. Lets rules/UI reason about a model instead of parsing its name."""

    supported_event_types: List[str] = field(default_factory=list)
    supported_categories: List[str] = field(default_factory=list)
    input_size: Optional[tuple] = None  # (width, height)
    expected_fps: Optional[float] = None
    acceleration: List[str] = field(default_factory=list)
    confidence_threshold: Optional[dict] = None  # {"min": .., "max": ..}

    def to_dict(self) -> dict:
        out: dict = {
            "supportedEventTypes": list(self.supported_event_types),
            "supportedCategories": list(self.supported_categories),
            "acceleration": list(self.acceleration),
        }
        if self.input_size is not None:
            out["inputSize"] = [int(self.input_size[0]), int(self.input_size[1])]
        if self.expected_fps is not None:
            out["expectedFps"] = float(self.expected_fps)
        if self.confidence_threshold is not None:
            out["confidenceThreshold"] = dict(self.confidence_threshold)
        return out

    @staticmethod
    def from_dict(data: Optional[dict]) -> "ModelCapabilityProfile":
        data = data or {}
        size = data.get("inputSize")
        return ModelCapabilityProfile(
            supported_event_types=list(data.get("supportedEventTypes", [])),
            supported_categories=list(data.get("supportedCategories", [])),
            input_size=tuple(size) if isinstance(size, (list, tuple)) and len(size) == 2 else None,
            expected_fps=data.get("expectedFps"),
            acceleration=list(data.get("acceleration", [])),
            confidence_threshold=data.get("confidenceThreshold"),
        )


@dataclass
class ModelVersion:
    """One immutable version of a model artifact (append-only)."""

    version: str
    engine: str
    format: str
    artifact_uri: str
    created_at: str
    classes: List[str] = field(default_factory=list)
    input_shape: List[int] = field(default_factory=list)
    accelerator: str = "cpu"
    checksum: Optional[str] = None
    metrics: Dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        out: dict = {
            "version": self.version,
            "engine": self.engine,
            "format": self.format,
            "artifactUri": self.artifact_uri,
            "classes": list(self.classes),
            "inputShape": [int(v) for v in self.input_shape],
            "accelerator": self.accelerator,
            "metrics": dict(self.metrics),
            "createdAt": self.created_at,
        }
        if self.checksum is not None:
            out["checksum"] = self.checksum
        return out


@dataclass
class ManagedModel:
    """A registered, tenant-scoped model with versions + an active selection."""

    id: str
    tenant_id: str
    name: str
    task: str
    engine: str
    status: str
    created_at: str
    updated_at: str
    active_version: Optional[str] = None
    versions: List[ModelVersion] = field(default_factory=list)
    capabilities: List[str] = field(default_factory=list)
    capability_profile: ModelCapabilityProfile = field(default_factory=ModelCapabilityProfile)
    metadata: Dict[str, object] = field(default_factory=lambda: {"tags": []})

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tenantId": self.tenant_id,
            "name": self.name,
            "task": self.task,
            "engine": self.engine,
            "status": self.status,
            "activeVersion": self.active_version,
            "versions": [v.to_dict() for v in self.versions],
            "capabilities": list(self.capabilities),
            "capabilityProfile": self.capability_profile.to_dict(),
            "metadata": dict(self.metadata),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class ModelRegistry:
    """In-memory, tenant-scoped model registry. Persistence is a later concern; the shape and rules
    live here so they are deterministically testable without a database."""

    def __init__(self, clock: Callable[[], float] = time.time, id_gen: Optional[Callable[[], str]] = None) -> None:
        self._clock = clock
        self._models: Dict[str, ManagedModel] = {}  # keyed by model id
        counter = itertools.count(1)
        self._id_gen = id_gen or (lambda: f"mdl_{next(counter)}")

    # --- registration ------------------------------------------------------------

    def register(
        self,
        tenant_id: str,
        *,
        name: str,
        task: str,
        engine: str,
        capabilities: Optional[List[str]] = None,
        capability_profile: Optional[dict] = None,
        metadata: Optional[Dict[str, object]] = None,
    ) -> ManagedModel:
        _require_tenant(tenant_id)
        _require_engine(engine)
        if not name.strip():
            raise ValidationError("model name is required")
        now = _iso(self._clock())
        model = ManagedModel(
            id=self._id_gen(),
            tenant_id=tenant_id,
            name=name,
            task=task,
            engine=engine,
            status="disabled",  # a model with no active version is not selectable yet
            active_version=None,
            versions=[],
            capabilities=list(capabilities or []),
            capability_profile=ModelCapabilityProfile.from_dict(capability_profile),
            metadata={"tags": [], **(metadata or {})},
            created_at=now,
            updated_at=now,
        )
        self._models[model.id] = model
        return model

    def add_version(
        self,
        tenant_id: str,
        model_id: str,
        *,
        version: str,
        format: str,
        artifact_uri: str,
        engine: Optional[str] = None,
        classes: Optional[List[str]] = None,
        input_shape: Optional[List[int]] = None,
        accelerator: str = "cpu",
        checksum: Optional[str] = None,
        metrics: Optional[Dict[str, float]] = None,
        activate: bool = False,
    ) -> ManagedModel:
        model = self.require(tenant_id, model_id)
        if any(v.version == version for v in model.versions):
            raise Conflict(f"version '{version}' already exists for model '{model_id}'")
        model.versions.append(
            ModelVersion(
                version=version,
                engine=engine or model.engine,
                format=format,
                artifact_uri=artifact_uri,
                classes=list(classes or []),
                input_shape=list(input_shape or []),
                accelerator=accelerator,
                checksum=checksum,
                metrics=dict(metrics or {}),
                created_at=_iso(self._clock()),
            )
        )
        if activate:
            model.active_version = version
        model.updated_at = _iso(self._clock())
        return model

    # --- selection / status ------------------------------------------------------

    def activate(self, tenant_id: str, model_id: str, version: str) -> ManagedModel:
        model = self.require(tenant_id, model_id)
        if not any(v.version == version for v in model.versions):
            raise NotFound(f"version '{version}' not found for model '{model_id}'")
        model.active_version = version
        model.updated_at = _iso(self._clock())
        return model

    def set_status(self, tenant_id: str, model_id: str, status: str) -> ManagedModel:
        if status not in _STATUSES:
            raise ValidationError(f"status must be one of {_STATUSES}")
        model = self.require(tenant_id, model_id)
        if status == "enabled" and model.active_version is None:
            raise Conflict("cannot enable a model with no active version")
        model.status = status
        model.updated_at = _iso(self._clock())
        return model

    def enable(self, tenant_id: str, model_id: str) -> ManagedModel:
        return self.set_status(tenant_id, model_id, "enabled")

    def disable(self, tenant_id: str, model_id: str) -> ManagedModel:
        return self.set_status(tenant_id, model_id, "disabled")

    def update_metadata(self, tenant_id: str, model_id: str, metadata: Dict[str, object]) -> ManagedModel:
        model = self.require(tenant_id, model_id)
        model.metadata = {"tags": [], **model.metadata, **metadata}
        model.updated_at = _iso(self._clock())
        return model

    # --- reads (tenant-scoped) ---------------------------------------------------

    def get(self, tenant_id: str, model_id: str) -> Optional[ManagedModel]:
        model = self._models.get(model_id)
        return model if model is not None and model.tenant_id == tenant_id else None

    def require(self, tenant_id: str, model_id: str) -> ManagedModel:
        model = self.get(tenant_id, model_id)
        if model is None:
            raise NotFound(f"model '{model_id}' not found")
        return model

    def list(self, tenant_id: str, *, capability: Optional[str] = None, status: Optional[str] = None) -> List[ManagedModel]:
        out = [m for m in self._models.values() if m.tenant_id == tenant_id]
        if capability is not None:
            out = [m for m in out if capability in m.capabilities]
        if status is not None:
            out = [m for m in out if m.status == status]
        return sorted(out, key=lambda m: m.created_at)

    def active_for_capability(self, tenant_id: str, capability_id: str) -> Optional[ManagedModel]:
        """The enabled model with an active version serving a capability (selection resolution)."""
        for model in self.list(tenant_id, capability=capability_id, status="enabled"):
            if model.active_version is not None:
                return model
        return None


def _require_tenant(tenant_id: str) -> None:
    if not isinstance(tenant_id, str) or tenant_id.strip() == "":
        raise ValidationError("a tenantId is required (fail-closed, Law 5)")


def _require_engine(engine: str) -> None:
    if engine not in _ENGINES:
        raise ValidationError(f"engine must be one of {_ENGINES}")
