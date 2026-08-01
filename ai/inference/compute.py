"""Compute Resources (AI-5c) — the scheduler's hardware-independent view of what it can run on.

The scheduler must never learn what CUDA is. Just as `ModelAdapter` (ADR-0012) keeps the pipeline
engine-agnostic, `ComputeResource` keeps *scheduling* hardware-agnostic: the scheduler reasons about
**capacity and cost in abstract units**, so the same code places work on a laptop CPU, an RTX box, a
Jetson NPU, or an Apple GPU without a branch (Architect AI-5c rec 1).

Two deliberate design choices:

  - **`capacity_units` is dimensionless.** Not cores, not VRAM, not TFLOPs — because the only thing
    every accelerator shares is "how much concurrent work fits". A CPU with 8 cores and a GPU with
    24 GB are both described by how many camera-sessions-worth of work they can carry, which is the
    only question a scheduler actually asks. Absolute hardware units would force the scheduler to
    understand each vendor's arithmetic, which is exactly the coupling this seam exists to prevent.
  - **Resource ids are node-qualified strings** (`cpu:0`, `node-a/cuda:0`). Nothing here assumes the
    resource is machine-local (rec 8), so a future distributed scheduler adds remote resources to the
    same registry rather than redesigning the runtime.

Probing is best-effort and **never required**: an unprobeable accelerator still schedules correctly
using its declared capacity. Stdlib-only at import; any vendor library is imported lazily inside its
own probe and a failure there degrades to "no reading", never to a broken runtime.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from errors import ConfigurationFailure

# Mirrors @vip/contracts `ComputeResourceKind`. Open-ended by design.
COMPUTE_KINDS = ("cpu", "cuda", "tensorrt", "openvino", "metal", "tpu", "npu")

# How many abstract units one camera session is assumed to cost on a resource of each kind, at the
# reference sampling rate. These are STARTING estimates refined by measurement (`observed_unit_cost`),
# never hard-coded truths — the whole point of AI-5a was that guesses get replaced by benchmarks.
_REFERENCE_UNIT_COST = {
    "cpu": 1.0,
    "cuda": 0.25,
    "tensorrt": 0.2,
    "openvino": 0.5,
    "metal": 0.4,
    "tpu": 0.3,
    "npu": 0.4,
}


@dataclass
class ComputeResource:
    """One schedulable compute resource. Mirrors the `ComputeResource` contract."""

    id: str
    kind: str
    capacity_units: float = 1.0
    label: Optional[str] = None
    available: bool = True
    memory_mb: Optional[float] = None
    allocated_units: float = 0.0
    utilization_percent: Optional[float] = None

    def __post_init__(self) -> None:
        if self.kind not in COMPUTE_KINDS:
            raise ConfigurationFailure(f"unknown compute kind '{self.kind}' (expected one of {COMPUTE_KINDS})")
        if self.capacity_units <= 0:
            raise ConfigurationFailure(f"capacity_units must be > 0, got {self.capacity_units}")

    @property
    def free_units(self) -> float:
        return max(0.0, self.capacity_units - self.allocated_units)

    @property
    def utilization(self) -> float:
        """Committed share of capacity (%) — the allocation view, distinct from any probed reading."""
        return min(100.0, 100.0 * self.allocated_units / self.capacity_units)

    def can_fit(self, units: float) -> bool:
        return self.available and units <= self.free_units + 1e-9

    def allocate(self, units: float) -> None:
        if not self.can_fit(units):
            raise ConfigurationFailure(f"resource '{self.id}' cannot fit {units} units")
        self.allocated_units += max(0.0, units)

    def release(self, units: float) -> None:
        # Never goes negative: a double-release must not manufacture capacity.
        self.allocated_units = max(0.0, self.allocated_units - max(0.0, units))

    def to_dict(self) -> dict:
        out: dict = {
            "id": self.id,
            "kind": self.kind,
            "capacityUnits": round(self.capacity_units, 6),
            "allocatedUnits": round(self.allocated_units, 6),
            "available": self.available,
        }
        for key, value in (
            ("label", self.label),
            ("memoryMb", self.memory_mb),
            ("utilizationPercent", self.utilization_percent),
        ):
            if value is not None:
                out[key] = round(value, 3) if isinstance(value, float) else value
        return out


class ComputeRegistry:
    """The set of resources the runtime may place work on.

    Placement is **capacity-based and kind-agnostic**: `place()` picks the resource with the most free
    units among those the session can use. That single rule covers CPU-only boxes, mixed CPU+GPU boxes,
    and (later) remote nodes, because "most free capacity" is meaningful for all of them.

    **Reservation** (Architect AI-5c refinement 1): a configurable share of total capacity is held back
    from ordinary admission. A runtime at 100% committed utilization cannot recover from its own
    success — every unit is spoken for, so a `critical` camera cannot start and a reconnecting session
    cannot get its capacity back. The reserve is the headroom that makes recovery possible, and only
    `privileged` placements may draw on it.
    """

    def __init__(
        self,
        resources: Optional[List[ComputeResource]] = None,
        *,
        reserved_percent: float = 0.0,
    ) -> None:
        if not 0.0 <= reserved_percent <= 50.0:
            raise ConfigurationFailure(
                f"reserved_percent must be between 0 and 50, got {reserved_percent}"
            )
        self._resources: Dict[str, ComputeResource] = {}
        self.reserved_percent = float(reserved_percent)
        for resource in resources or []:
            self.register(resource)

    @property
    def reserved_units(self) -> float:
        """Capacity held back across the whole registry (never placed for ordinary work)."""
        return self.total_capacity * self.reserved_percent / 100.0

    @property
    def unreserved_free_capacity(self) -> float:
        """Free capacity ordinary (non-privileged) work may draw on."""
        return max(0.0, self.free_capacity - self.reserved_units)

    def register(self, resource: ComputeResource) -> ComputeResource:
        if resource.id in self._resources:
            raise ConfigurationFailure(f"compute resource '{resource.id}' is already registered")
        self._resources[resource.id] = resource
        return resource

    def get(self, resource_id: str) -> Optional[ComputeResource]:
        return self._resources.get(resource_id)

    def list(self, *, kind: Optional[str] = None) -> List[ComputeResource]:
        out = list(self._resources.values())
        if kind is not None:
            out = [r for r in out if r.kind == kind]
        return sorted(out, key=lambda r: r.id)

    @property
    def total_capacity(self) -> float:
        return sum(r.capacity_units for r in self._resources.values() if r.available)

    @property
    def free_capacity(self) -> float:
        return sum(r.free_units for r in self._resources.values() if r.available)

    def place(
        self,
        units: float,
        *,
        kinds: Optional[List[str]] = None,
        privileged: bool = False,
    ) -> Optional[ComputeResource]:
        """Pick the best-fitting resource for `units` (most free capacity first), or None when nothing
        can serve it. Returning None is the signal admission control turns into a refusal.

        `privileged=True` (a `critical` session, or a recovery placement) may draw on the reserve;
        ordinary work may not, even when the raw free units would fit.
        """
        if not privileged and units > self.unreserved_free_capacity + 1e-9:
            return None  # would eat into the reserve
        candidates = [
            r
            for r in self._resources.values()
            if r.available and (kinds is None or r.kind in kinds) and r.can_fit(units)
        ]
        if not candidates:
            return None
        # Most free capacity wins; id breaks ties so placement is deterministic in tests.
        return sorted(candidates, key=lambda r: (-r.free_units, r.id))[0]

    def unit_cost(self, kind: str, *, target_fps: float, reference_fps: float = 5.0) -> float:
        """Estimated units one session costs on a resource of `kind` at `target_fps`. Linear in frame
        rate, which is the honest first-order model: twice the frames is twice the work."""
        base = _REFERENCE_UNIT_COST.get(kind, 1.0)
        return base * (max(0.1, target_fps) / max(0.1, reference_fps))

    def to_dict(self) -> List[dict]:
        return [r.to_dict() for r in self.list()]


# --- probes (best-effort, lazy, never fatal) ------------------------------------------------------


def detect_resources(*, probe_accelerators: bool = True) -> ComputeRegistry:
    """Build a registry for THIS machine. CPU is always present (there is always a CPU); accelerators
    are added only when a lazy probe confirms them, so a machine without CUDA simply has no CUDA
    resource rather than a broken one."""
    cores = os.cpu_count() or 1
    registry = ComputeRegistry(
        [
            ComputeResource(
                id="cpu:0",
                kind="cpu",
                # One session per core is a conservative, measurable starting point.
                capacity_units=float(max(1, cores)),
                label=f"CPU ({cores} logical cores)",
            )
        ]
    )
    if probe_accelerators:
        for resource in _probe_accelerators():
            try:
                registry.register(resource)
            except ConfigurationFailure:
                pass  # a duplicate probe result is not worth failing a runtime over
    return registry


def _probe_accelerators() -> List[ComputeResource]:
    """Detect accelerators without importing anything heavy unless it is actually present."""
    found: List[ComputeResource] = []
    # CUDA — only if torch is already installable/present. Never a hard dependency.
    try:  # pragma: no cover - hardware-dependent
        import torch  # noqa: WPS433 - HEAVY, optional

        if torch.cuda.is_available():
            for index in range(torch.cuda.device_count()):
                name = torch.cuda.get_device_name(index)
                found.append(
                    ComputeResource(
                        id=f"cuda:{index}",
                        kind="cuda",
                        capacity_units=8.0,
                        label=str(name)[:200],
                    )
                )
        elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            found.append(
                ComputeResource(id="metal:0", kind="metal", capacity_units=4.0, label="Apple GPU (MPS)")
            )
    except Exception:  # noqa: BLE001 - absence of a vendor library is normal, not an error
        pass
    return found


@dataclass
class ResourceSnapshot:
    """A point-in-time process resource sample. Best-effort: absent readings stay absent rather than
    being faked with zeros, because a zero CPU reading and an unavailable one mean opposite things."""

    cpu_percent: Optional[float] = None
    memory_mb: Optional[float] = None
    gpu_percent: Optional[float] = None
    gpu_memory_mb: Optional[float] = None
    logical_cores: Optional[int] = None
    at: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {}
        for key, value in (
            ("cpuPercent", self.cpu_percent),
            ("memoryMb", self.memory_mb),
            ("gpuPercent", self.gpu_percent),
            ("gpuMemoryMb", self.gpu_memory_mb),
        ):
            if value is not None:
                out[key] = round(float(value), 3)
        if self.logical_cores is not None:
            out["logicalCores"] = int(self.logical_cores)
        if self.at is not None:
            out["at"] = self.at
        return out


class ResourceMonitor:
    """Samples PROCESS resource usage (CPU%, RSS, optional GPU) with the stdlib only.

    CPU% is derived from `resource.getrusage` CPU-time deltas across samples — no psutil dependency,
    and deterministic under an injected clock, which is what lets the governor's escalation logic be
    unit-tested without a loaded machine.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        gpu_probe: Optional[Callable[[], Optional[float]]] = None,
        cpu_time: Optional[Callable[[], float]] = None,
        rss_mb: Optional[Callable[[], Optional[float]]] = None,
        now_iso: Optional[Callable[[], str]] = None,
    ) -> None:
        self._clock = clock
        self._gpu_probe = gpu_probe
        self._cpu_time = cpu_time or _process_cpu_seconds
        self._rss_mb = rss_mb or _process_rss_mb
        self._now_iso = now_iso or _now_iso
        self._cores = os.cpu_count() or 1
        self._last_wall = clock()
        self._last_cpu = self._cpu_time()

    def sample(self) -> ResourceSnapshot:
        """Take a sample. CPU% is the share of ONE core-equivalent across all cores (0–100)."""
        wall = self._clock()
        cpu = self._cpu_time()
        wall_delta = wall - self._last_wall
        cpu_delta = cpu - self._last_cpu
        self._last_wall, self._last_cpu = wall, cpu
        cpu_percent: Optional[float] = None
        if wall_delta > 0 and cpu_delta >= 0:
            cpu_percent = min(100.0, 100.0 * cpu_delta / (wall_delta * max(1, self._cores)))
        gpu = None
        if self._gpu_probe is not None:
            try:
                gpu = self._gpu_probe()
            except Exception:  # noqa: BLE001 - a GPU probe must never break monitoring
                gpu = None
        return ResourceSnapshot(
            cpu_percent=cpu_percent,
            memory_mb=self._rss_mb(),
            gpu_percent=gpu,
            logical_cores=self._cores,
            at=self._now_iso(),
        )


def _process_cpu_seconds() -> float:
    import resource as _resource  # noqa: WPS433 - POSIX

    usage = _resource.getrusage(_resource.RUSAGE_SELF)
    return float(usage.ru_utime + usage.ru_stime)


def _process_rss_mb() -> Optional[float]:
    try:
        import resource as _resource  # noqa: WPS433 - POSIX

        rss = _resource.getrusage(_resource.RUSAGE_SELF).ru_maxrss
        # ru_maxrss is KB on Linux, bytes on macOS — normalize conservatively to MB.
        return round(rss / 1024.0 / (1024.0 if rss > 10_000_000 else 1.0), 3)
    except Exception:  # noqa: BLE001
        return None


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
