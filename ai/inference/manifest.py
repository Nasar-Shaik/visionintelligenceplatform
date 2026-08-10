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
from typing import Dict, List, Mapping, Optional

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
    #: Per-label overrides of `min_confidence`, by detector label.
    #:
    #: ⛔ **One floor cannot serve eighty classes.** `min_confidence` was chosen for `person`, which
    #: this deployment's detector scores 0.73–0.94 on real photographs. The same detector scores a
    #: real `handbag` at 0.47 and a real `backpack` at 0.28 — so a single 0.50 discards every carried
    #: object while looking exactly like a scene that contained none. That is not a threshold being
    #: strict; it is an entire capability silently switched off, and P-11 slice 2.10 measured it.
    #:
    #: ⚠️ Absent by default, and an empty map behaves **exactly** as before — a deployment that never
    #: declares one keeps the floor it was certified with. Raising or lowering a class here changes
    #: what the platform reports, so every entry needs its own evidence.
    min_confidence_by_label: Mapping[str, float] = field(default_factory=dict)

    def floor_for(self, label: Optional[str]) -> float:
        """The floor that applies to `label` — its own, or the capability's.

        ⚠️ Unknown labels get `min_confidence`, never the lowest declared floor. A per-class
        exception is a statement about that class, and spreading it to classes nobody measured
        would turn one piece of evidence into eighty claims.
        """
        if label is None:
            return self.min_confidence
        return self.min_confidence_by_label.get(label, self.min_confidence)

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
            min_confidence_by_label=_floors(data.get("minConfidenceByLabel")),
        )

    def descriptor(self) -> dict:
        """Project the manifest to the @vip/contracts CapabilityDescriptor shape (self-describe)."""
        return {
            "id": self.capability_id,
            "version": self.version,
            "kind": self.kind,
            "inputs": [{"type": t} for t in self.input_types],
            "outputs": [{"type": self.output_type}],
            # ⚠️ The per-label floors travel in the descriptor beside the default, because a caller
            # told only "minConfidence: 0.5" would describe this capability's behaviour wrongly for
            # every class that has its own. Omitted entirely when none is declared, so a deployment
            # that has not opted in publishes exactly the descriptor it always did.
            "parameters": {
                "minConfidence": self.min_confidence,
                "tracking": self.tracking,
                **(
                    {}
                    if not self.min_confidence_by_label
                    else {"minConfidenceByLabel": dict(sorted(self.min_confidence_by_label.items()))}
                ),
            },
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


def _floors(raw: object) -> Dict[str, float]:
    """Parse `minConfidenceByLabel`, refusing anything that is not a usable floor.

    ⛔ **Raises rather than skipping.** A malformed entry silently dropped would leave the class on
    the capability default, and the deployment would report "no carried objects" for exactly the
    reason it was configured not to — the failure this whole field exists to end. A manifest that
    cannot be read is a deployment that must not start.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("manifest field 'minConfidenceByLabel' must be an object of label → floor")
    out: Dict[str, float] = {}
    for label, value in raw.items():
        if not isinstance(label, str) or label == "":
            raise ValueError("manifest 'minConfidenceByLabel' has an empty label")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"manifest 'minConfidenceByLabel[{label}]' must be a number")
        floor = float(value)
        if not 0.0 <= floor <= 1.0:
            raise ValueError(f"manifest 'minConfidenceByLabel[{label}]' must be within 0.0–1.0, got {floor}")
        out[label] = floor
    return out


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
