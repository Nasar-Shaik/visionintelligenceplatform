"""Model-engine abstraction (P2-2 G-3) — the seam that keeps the runtime engine-agnostic.

The runtime already talks to a model only through the `ModelAdapter` Protocol (pipeline.py, #2). This
module makes the set of engines an explicit, extensible **registry**: an engine name maps to a factory
that builds its adapter. New engines (TensorRT, OpenVINO, a custom Python model) register here without
touching capability or pipeline code — YOLO is NOT special-cased.

Heavy engines (onnx/tensorrt/openvino) import their runtime **lazily** inside the factory, so the
dependency-free default path and the unit tests never import them. An engine that isn't installed
raises `EngineUnavailable`; the composition root may fall back to the stub adapter in dev.

Canonical engine names mirror `@vip/contracts` `ModelEngine`:
`yolo | onnx | tensorrt | openvino | python-custom`.
"""

from __future__ import annotations

from typing import Callable, Dict, List

from pipeline import ModelAdapter

CANONICAL_ENGINES = ("yolo", "onnx", "tensorrt", "openvino", "torchscript", "python-custom")


class EngineUnavailable(RuntimeError):
    """The requested engine's runtime is not installed in this environment."""


AdapterFactory = Callable[[], ModelAdapter]


class EngineRegistry:
    """Maps engine name → adapter factory. Backend-agnostic; the composition root registers the
    factories it wants available (real engines lazily, the stub always)."""

    def __init__(self) -> None:
        self._factories: Dict[str, AdapterFactory] = {}

    def register(self, engine: str, factory: AdapterFactory) -> None:
        if engine not in CANONICAL_ENGINES:
            raise ValueError(f"unknown engine '{engine}' (expected one of {CANONICAL_ENGINES})")
        self._factories[engine] = factory

    def available(self) -> List[str]:
        return sorted(self._factories)

    def supports(self, engine: str) -> bool:
        return engine in self._factories

    def create(self, engine: str) -> ModelAdapter:
        factory = self._factories.get(engine)
        if factory is None:
            raise EngineUnavailable(f"engine '{engine}' is not available in this runtime")
        return factory()


def default_registry(stub_factory: AdapterFactory) -> EngineRegistry:
    """A registry with the dependency-free stub registered for every engine name — the deterministic
    default used by tests and the `stub` backend. Real backends override individual factories with a
    lazily-imported adapter (onnx/tensorrt/openvino/python) at the composition root."""
    registry = EngineRegistry()
    for engine in CANONICAL_ENGINES:
        registry.register(engine, stub_factory)
    return registry
