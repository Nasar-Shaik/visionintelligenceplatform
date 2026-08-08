"""The perception plugin registry (P-10) — task → name → factory.

`EngineRegistry` answers "which backend can execute a model". This answers the question above it:
**"which modules can perceive, and what can each of them do?"** They compose — a pose module may be
an ONNX module, and it registers here under `pose` while resolving its backend there.

    registry.register(TASK_POSE, "rtmpose-s", lambda: RtmPoseModule())
    registry.create(TASK_POSE, "rtmpose-s").analyse(prepared)  → PerceptionOutput

### ⛔ Three rigidities in the existing registry, fixed here rather than copied

`EngineRegistry.register` rejects any name outside a hard-coded `CANONICAL_ENGINES` tuple, silently
overwrites an existing registration, and offers no way to ask what a registered thing *is*. Each is
survivable for six engine names and none of them is survivable for an open set of perception modules
across ten tasks:

- **Open set.** A task is validated against the *registry* of tasks (`perception.register_task`),
  not a constant, so a plugin can bring a task nobody has thought of.
- **No silent overwrite.** Re-registering a name raises unless `replace=True` is explicit. Two
  plugins claiming `"yolo11"` is a packaging bug, and the failure mode — whichever imported last
  wins — is invisible in every benchmark that follows.
- **Introspectable.** `describe()` returns what is loaded, because the model registry, the health
  endpoint and the benchmark report all need to state which modules a deployment actually has.

Stdlib-only. Deterministic. No I/O, no imports of any backend.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Protocol

from perception import PerceptionOutput, describe_task

#: A zero-argument factory. Construction is deferred so an unavailable heavy dependency raises at
#: `create()` — inside the composition root's error handling — and never at import time.
ModuleFactory = Callable[[], "PerceptionModule"]


class PerceptionModule(Protocol):
    """What every perception plugin implements, whatever it perceives.

    ⚠️ Intentionally the same four-verb shape as `ModelAdapter` (`load`/`preprocess`/…/`unload`),
    with `analyse` where `infer` was. A module author who has written an adapter already knows this
    interface, and the two can be bridged in ten lines (`adapt_model_adapter` below) rather than
    being two parallel worlds that drift.
    """

    task: str
    execution_provider: str

    def load(self, ref: dict) -> None: ...

    def preprocess(self, ctx: Any) -> Any: ...

    def analyse(self, prepared: Any) -> PerceptionOutput: ...

    def unload(self) -> None: ...


class ModuleUnavailable(RuntimeError):
    """The requested module is not registered, or its runtime is not installed here."""


class PerceptionRegistry:
    """Maps `(task, name)` → factory."""

    def __init__(self) -> None:
        self._factories: Dict[str, Dict[str, ModuleFactory]] = {}

    def register(self, task: str, name: str, factory: ModuleFactory, *, replace: bool = False) -> None:
        describe_task(task)  # fail closed on an unregistered task
        if not isinstance(name, str) or name.strip() == "":
            raise ValueError("module name must be a non-empty string")
        slot = self._factories.setdefault(task, {})
        if name in slot and not replace:
            raise ValueError(
                f"module '{name}' is already registered for task '{task}' — "
                f"pass replace=True to override deliberately"
            )
        slot[name] = factory

    def supports(self, task: str, name: str) -> bool:
        return name in self._factories.get(task, {})

    def available(self, task: Optional[str] = None) -> List[str]:
        """Module names for one task, or every task's names when `task` is omitted."""
        if task is None:
            return sorted({name for slot in self._factories.values() for name in slot})
        return sorted(self._factories.get(task, {}))

    def tasks(self) -> List[str]:
        """Only the tasks this deployment can actually serve — registered *and* non-empty.

        ⚠️ Not the same as `perception.known_tasks()`, and conflating them is how a deployment comes
        to advertise a capability it cannot execute. Known means "the contract can express it";
        this means "something here can produce it".
        """
        return sorted(task for task, slot in self._factories.items() if slot)

    def create(self, task: str, name: str) -> PerceptionModule:
        slot = self._factories.get(task, {})
        factory = slot.get(name)
        if factory is None:
            raise ModuleUnavailable(
                f"no module '{name}' for task '{task}' "
                f"(registered for this task: {', '.join(sorted(slot)) or 'none'})"
            )
        return factory()

    def describe(self) -> dict:
        """What this deployment can perceive — for the health endpoint and the benchmark report."""
        return {
            "tasks": [
                {"task": task, "modules": sorted(slot), "description": describe_task(task)}
                for task, slot in sorted(self._factories.items())
                if slot
            ]
        }


class _AdaptedDetector:
    """A `ModelAdapter` seen as a `PerceptionModule`.

    ⭐ **The proof that the plugin architecture is backward compatible, as code rather than a claim.**
    The shipped `yolox-nano` detector is not modified, not re-registered and not aware this module
    exists; it arrives here through the same `ModelAdapter` seam it has always implemented, and comes
    out the other side as a `PerceptionOutput`. If this bridge ever needs to change the adapter, the
    two interfaces have diverged and that is a design failure worth failing a build over.
    """

    task = "detection"

    def __init__(self, adapter: Any) -> None:
        self._adapter = adapter
        self.execution_provider = getattr(adapter, "execution_provider", "unknown")

    def load(self, ref: dict) -> None:
        self._adapter.load(ref)

    def preprocess(self, ctx: Any) -> Any:
        return self._adapter.preprocess(ctx)

    def analyse(self, prepared: Any) -> PerceptionOutput:
        from perception import from_raw_detections

        return from_raw_detections(self._adapter.infer(prepared))

    def unload(self) -> None:
        self._adapter.unload()


def adapt_model_adapter(adapter: Any) -> PerceptionModule:
    """Wrap any existing `ModelAdapter` as a detection `PerceptionModule`."""
    return _AdaptedDetector(adapter)


def registry_from_engines(engine_registry: Any, engines: Optional[List[str]] = None) -> PerceptionRegistry:
    """Every engine the runtime already has, offered as a detection module under its engine name.

    ⚠️ Deliberately not automatic anywhere — the composition root calls this. A registry that
    populated itself by scanning would make "what can this deployment perceive" depend on import
    order, which is the property that makes a plugin system unreviewable.
    """
    registry = PerceptionRegistry()
    for engine in engines if engines is not None else engine_registry.available():
        registry.register(
            "detection",
            engine,
            lambda e=engine: adapt_model_adapter(engine_registry.create(e)),
        )
    return registry
