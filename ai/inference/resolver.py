"""Model resolution — the model-AGNOSTIC binding (ADR-0002). A `ModelResolver` turns a
`ModelSelector` into a concrete `(ModelBinding, ref)`, where `ref` is the backend-specific handle
(label space for the fake backend; ONNX artifact path for the real one). Swapping the model is a
registry/selector change, never code. The `FakeModelResolver` is stdlib-only; `MlflowModelResolver`
(heavy, integration-only) lives in adapters/mlflow_resolver.py.
"""

from __future__ import annotations

from typing import List, Mapping, Protocol, Tuple

from contracts import ModelBinding
from selector import ModelSelector, select


class ModelResolver(Protocol):
    def resolve(self, selector: ModelSelector) -> Tuple[ModelBinding, dict]: ...


# A small default catalog for dev/tests — the shape MLflow's registry carries via model tags.
DEFAULT_CATALOG: List[Mapping[str, object]] = [
    {
        "name": "person-detection",
        "version": "1",
        "task": "object-detection",
        "family": "yolo",
        "accelerators": ["cpu"],
        "labels": ["person"],
    },
    {
        "name": "vehicle-detection",
        "version": "1",
        "task": "object-detection",
        "family": "yolo",
        "accelerators": ["cpu"],
        "labels": ["vehicle"],
    },
]


class FakeModelResolver:
    """Resolves selectors against an in-memory catalog (no registry/network). Dependency-free."""

    def __init__(self, catalog: List[Mapping[str, object]] | None = None) -> None:
        self._catalog = catalog if catalog is not None else DEFAULT_CATALOG

    def resolve(self, selector: ModelSelector) -> Tuple[ModelBinding, dict]:
        model = select(selector, self._catalog)
        accel = selector.accelerators[0] if selector.accelerators else "cpu"
        binding = ModelBinding(
            name=str(model["name"]),
            version=str(model["version"]),
            task=str(model["task"]),
            family=str(model.get("family", "*")),
            accelerator=accel,
        )
        ref = {"labels": list(model.get("labels", [])) or ["object"]}
        return binding, ref
