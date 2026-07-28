"""Capability manifests (#1). Every capability is described by a machine-readable manifest (JSON);
the runtime LOADS capabilities from manifests instead of hardcoded registrations — enabling zero-code
registration, discovery, dynamic enable/disable, and (later) tenant-specific capability sets. Stdlib.

The manifest declares WHAT the capability is/needs (id, version, IO types, execution providers,
required-model selector, min confidence, tracking, pre/post stage names, generated events); the
runtime binds the concrete model + backend at load time. See docs/architecture/05, AI_PIPELINE.md.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import List

from selector import ModelSelector


@dataclass(frozen=True)
class CapabilityManifest:
    capability_id: str
    version: str
    kind: str
    input_types: List[str]
    output_type: str
    execution_providers: List[str]
    required_model: ModelSelector
    min_confidence: float
    tracking: bool
    preprocessing: str
    postprocessing: str
    generated_events: List[str]
    placement: List[str] = field(default_factory=lambda: ["cloud"])
    enabled: bool = True

    @staticmethod
    def from_dict(data: dict) -> "CapabilityManifest":
        rm = data.get("requiredModel", {}) or {}
        accel = rm.get("accelerator", "cpu")
        accels = accel if isinstance(accel, list) else [accel]
        return CapabilityManifest(
            capability_id=_req(data, "capabilityId"),
            version=_req(data, "version"),
            kind=data.get("kind", "perception"),
            input_types=list(data.get("inputTypes", ["media.frame"])),
            output_type=data.get("outputType", "perception.detection"),
            execution_providers=list(data.get("executionProviders", ["stub"])),
            required_model=ModelSelector(
                task=_req(rm, "task"),
                family=rm.get("family", "*"),
                version_range=rm.get("versionRange", ""),
                accelerators=tuple(accels),
            ),
            min_confidence=float(data.get("minConfidence", 0.0)),
            tracking=bool(data.get("tracking", False)),
            preprocessing=data.get("preprocessing", "default"),
            postprocessing=data.get("postprocessing", "confidence-threshold"),
            generated_events=list(data.get("generatedEvents", [])),
            placement=list(data.get("placement", ["cloud"])),
            enabled=bool(data.get("enabled", True)),
        )

    def descriptor(self) -> dict:
        """Project the manifest to the @vip/contracts CapabilityDescriptor shape (self-describe)."""
        return {
            "id": self.capability_id,
            "version": self.version,
            "kind": self.kind,
            "inputs": [{"type": t} for t in self.input_types],
            "outputs": [{"type": self.output_type}],
            "parameters": {"minConfidence": self.min_confidence, "tracking": self.tracking},
            "models": {
                "selector": {
                    "task": self.required_model.task,
                    "family": self.required_model.family,
                    "versionRange": self.required_model.version_range or None,
                    "accelerator": list(self.required_model.accelerators),
                }
            },
            "resourceProfile": {"accelerator": list(self.required_model.accelerators), "estLoad": {}},
            "placement": self.placement,
            "extensionPoints": [],
            "generatedEvents": self.generated_events,
        }


def _req(data: dict, key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or value == "":
        raise ValueError(f"manifest missing required field '{key}'")
    return value


def load_manifest(path: str) -> CapabilityManifest:
    with open(path, "r", encoding="utf-8") as fh:
        return CapabilityManifest.from_dict(json.load(fh))


def load_manifests(directory: str) -> List[CapabilityManifest]:
    """Load every `*.json` manifest in a directory (sorted, deterministic)."""
    manifests: List[CapabilityManifest] = []
    for name in sorted(os.listdir(directory)):
        if name.endswith(".json"):
            manifests.append(load_manifest(os.path.join(directory, name)))
    return manifests
