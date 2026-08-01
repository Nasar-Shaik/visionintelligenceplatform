"""Hardware sizing (AI-5e, Architect recommendation 2).

**The question this answers.** "We have 24 cameras at 5 fps doing loitering and queue analytics — what
box do we ship?" Today that is answered by whoever has the most confident opinion. Every wrong answer
costs either a returned mini-PC or a customer whose system drops frames at 6pm.

**How it stays honest.** Sizing reuses the runtime's own cost model — `ComputeRegistry.unit_cost()`,
the same arithmetic admission control uses to decide whether a session can be admitted. There is no
second set of numbers to drift. When a measured `BenchmarkReport` is supplied, per-camera cost is
derived from it and `estimated` becomes false; with no benchmark the recommendation is explicitly
marked `estimated=True`, so nobody quotes a default to a customer as if it were a measurement.

**Headroom is not optional.** A box sized to 100% of its capacity has no room for the reconnect storm
after a power cut, when every camera comes back at once and the system is at its least able to cope.
The default target leaves 30%, and a recommendation that cannot leave any is reported as infeasible
rather than as a tight fit.

Stdlib-only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

from compute import ComputeRegistry, ComputeResource

#: Reference deployment classes with the capacity, CPU and memory they actually ship with. Capacity is
#: in the runtime's abstract units, taken from the same reference costs the scheduler uses. These are
#: **catalogue defaults**, replaced by a measured benchmark whenever one exists.
@dataclass(frozen=True)
class DeploymentHardware:
    deployment_class: str
    label: str
    capacity_units: float
    kind: str = "cpu"
    cpu_cores: Optional[int] = None
    memory_gb: Optional[float] = None
    gpu: Optional[str] = None
    notes: Optional[str] = None


REFERENCE_HARDWARE: Sequence[DeploymentHardware] = (
    DeploymentHardware(
        deployment_class="edge-device",
        label="Jetson Orin Nano / equivalent edge SoC",
        capacity_units=8.0,
        kind="cuda",
        cpu_cores=6,
        memory_gb=8.0,
        gpu="Jetson Orin Nano (integrated)",
        notes="Fanless, DIN-mountable; the only class that survives a retail ceiling void.",
    ),
    DeploymentHardware(
        deployment_class="mini-pc-i5",
        label="Intel NUC / mini-PC (i5, no discrete GPU)",
        capacity_units=8.0,
        kind="cpu",
        cpu_cores=8,
        memory_gb=16.0,
        notes="The default single-site box. CPU inference; sub-stream analysis is essential here.",
    ),
    DeploymentHardware(
        deployment_class="dev-laptop",
        label="Developer laptop",
        capacity_units=6.0,
        kind="cpu",
        cpu_cores=8,
        memory_gb=16.0,
        notes="Engineering and demonstration only — never a deployment target.",
    ),
    DeploymentHardware(
        deployment_class="rtx-desktop",
        label="Tower / industrial PC with an NVIDIA GPU",
        capacity_units=64.0,
        kind="cuda",
        cpu_cores=16,
        memory_gb=32.0,
        gpu="NVIDIA RTX-class",
        notes="Multi-site or high-camera-count deployments; the only class that scales past ~24 cameras.",
    ),
)

#: Spare capacity to keep free. A reconnect storm after a site power cut brings every camera back at
#: once — the worst moment to be at capacity.
DEFAULT_HEADROOM_PERCENT = 30.0

#: Extra cost multiplier per behaviour family enabled. Behaviour analysis is cheap relative to
#: inference but not free, and a 24-camera site running six composites is not the same workload as one
#: running none. First-order and deliberately conservative — replaced by measurement, like everything.
_WORKLOAD_COST = {
    "detection": 0.0,  # already in the base per-session cost
    "tracking": 0.05,
    "zones": 0.02,
    "loitering": 0.05,
    "queue": 0.05,
    "crowd": 0.08,
    "intrusion": 0.03,
    "fire": 0.10,
    "smoke": 0.10,
    "abandoned_object": 0.12,
    "fall_detection": 0.15,
    "violence": 0.20,
    "ppe": 0.15,
    "composite": 0.05,
}


@dataclass
class SizingRequest:
    profile: str
    cameras: int
    target_fps: float = 5.0
    workload: List[str] = field(default_factory=list)
    headroom_percent: float = DEFAULT_HEADROOM_PERCENT
    #: Restrict the recommendation to these classes (e.g. a customer who will only accept fanless).
    allowed_classes: Optional[Sequence[str]] = None


def workload_multiplier(workload: Sequence[str]) -> float:
    """Cost multiplier for the enabled behaviours. Unknown names cost the generic composite rate
    rather than nothing — an unrecognised analyzer is still an analyzer, and sizing it at zero is the
    error that produces an under-specified box."""
    extra = sum(_WORKLOAD_COST.get(name, _WORKLOAD_COST["composite"]) for name in workload)
    return round(1.0 + extra, 4)


def per_camera_units(
    *,
    target_fps: float,
    workload: Sequence[str],
    kind: str = "cpu",
    registry: Optional[ComputeRegistry] = None,
    benchmark: Optional[dict] = None,
) -> tuple:
    """Compute units one camera costs, and whether the figure was measured.

    With a `BenchmarkReport`, cost is derived from what the box actually achieved: a class whose
    measured sustained fps is `f` across `n` cameras has spare capacity in proportion, and that beats
    any catalogue number. Returns `(units, measured)`.
    """
    reg = registry or ComputeRegistry([ComputeResource(id=f"{kind}:0", kind=kind, capacity_units=1.0)])
    base = reg.unit_cost(kind, target_fps=target_fps)
    if benchmark:
        kpis = benchmark.get("kpis") or {}
        cameras = int((benchmark.get("workload") or {}).get("cameras") or 0)
        achieved = float(kpis.get("fps") or 0.0)
        requested = float((benchmark.get("workload") or {}).get("targetFps") or target_fps)
        if cameras > 0 and achieved > 0 and requested > 0:
            # Scale the reference cost by how far the measured run fell short of (or exceeded) its
            # own target. A box that sustained 3 of a requested 5 fps costs 5/3 as much per camera.
            attainment = min(2.0, requested / achieved) if achieved < requested else requested / achieved
            return round(base * attainment * workload_multiplier(workload), 6), True
    return round(base * workload_multiplier(workload), 6), False


def recommend(
    request: SizingRequest,
    *,
    hardware: Sequence[DeploymentHardware] = REFERENCE_HARDWARE,
    benchmark: Optional[dict] = None,
) -> dict:
    """Recommend the smallest deployment class that fits the workload with headroom to spare.

    Smallest-that-fits, not largest-available: over-specifying is a real cost to a customer buying
    forty sites, and a class that fits with 45% headroom is a better answer than one with 80%.
    """
    candidates = [
        h
        for h in hardware
        if request.allowed_classes is None or h.deployment_class in request.allowed_classes
    ]
    # Never recommend a laptop unless it is the only thing allowed — it is an engineering machine.
    deployable = [h for h in candidates if h.deployment_class != "dev-laptop"] or candidates

    best: Optional[dict] = None
    for h in sorted(deployable, key=lambda x: x.capacity_units):
        units, measured = per_camera_units(
            target_fps=request.target_fps,
            workload=request.workload,
            kind=h.kind,
            benchmark=benchmark,
        )
        required = round(units * request.cameras, 4)
        headroom = (
            0.0
            if h.capacity_units <= 0
            else round(100.0 * (h.capacity_units - required) / h.capacity_units, 2)
        )
        row = {
            "profile": request.profile,
            "cameras": request.cameras,
            "targetFps": request.target_fps,
            "workload": list(request.workload),
            "recommendedClass": h.deployment_class,
            "requiredCapacityUnits": required,
            "availableCapacityUnits": h.capacity_units,
            "headroomPercent": headroom,
            "feasible": headroom >= request.headroom_percent,
            "estimated": not measured,
            "rationale": _rationale(h, request, required, headroom, measured),
        }
        for key, value in (("cpuCores", h.cpu_cores), ("memoryGb", h.memory_gb), ("gpu", h.gpu)):
            if value:
                row[key] = value
        if benchmark and benchmark.get("id"):
            row["basis"] = benchmark["id"]
        if row["feasible"]:
            return row
        # Remember the largest attempt so an infeasible request still returns the closest answer,
        # with `feasible: false` and a rationale saying how far short it fell.
        best = row
    return best or _infeasible(request)


def _rationale(
    h: DeploymentHardware,
    request: SizingRequest,
    required: float,
    headroom: float,
    measured: bool,
) -> str:
    basis = "measured benchmark" if measured else "catalogue reference costs (not measured)"
    verdict = (
        f"{headroom:.0f}% headroom remains"
        if headroom >= request.headroom_percent
        else f"only {headroom:.0f}% headroom — below the {request.headroom_percent:.0f}% target"
    )
    return (
        f"{request.cameras} cameras at {request.target_fps:g} fps with "
        f"{len(request.workload)} behaviour(s) need {required:.2f} of the {h.capacity_units:g} units "
        f"a {h.label} provides; {verdict}. Basis: {basis}."
    )


def _infeasible(request: SizingRequest) -> dict:
    return {
        "profile": request.profile,
        "cameras": request.cameras,
        "targetFps": request.target_fps,
        "workload": list(request.workload),
        "recommendedClass": "rtx-desktop",
        "requiredCapacityUnits": 0.0,
        "availableCapacityUnits": 0.0,
        "headroomPercent": 0.0,
        "feasible": False,
        "estimated": True,
        "rationale": (
            "no reference deployment class was permitted by the request; split the site across "
            "multiple boxes or widen allowedClasses"
        ),
    }


def sizing_table(
    profile: str,
    camera_counts: Sequence[int] = (4, 8, 16, 24, 32, 48, 64),
    *,
    target_fps: float = 5.0,
    workload: Sequence[str] = ("tracking", "loitering", "queue"),
    benchmark: Optional[dict] = None,
) -> List[dict]:
    """The sizing guide as a table — one row per camera count. This is what goes in front of a sales
    engineer, and the `estimated` column is deliberately in it."""
    return [
        recommend(
            SizingRequest(
                profile=profile, cameras=n, target_fps=target_fps, workload=list(workload)
            ),
            benchmark=benchmark,
        )
        for n in camera_counts
    ]


def render_table(rows: Sequence[dict]) -> str:
    lines = [
        f"{'cameras':>8} {'class':<14} {'required':>9} {'available':>10} {'headroom':>9} "
        f"{'fits':>5} {'basis':<10}",
        "-" * 70,
    ]
    for row in rows:
        lines.append(
            f"{row['cameras']:>8} {row['recommendedClass']:<14} "
            f"{row['requiredCapacityUnits']:>9.2f} {row['availableCapacityUnits']:>10.1f} "
            f"{row['headroomPercent']:>8.0f}% {'yes' if row['feasible'] else 'NO':>5} "
            f"{'estimate' if row['estimated'] else 'measured':<10}"
        )
    return "\n".join(lines)


__all__ = [
    "DeploymentHardware",
    "REFERENCE_HARDWARE",
    "DEFAULT_HEADROOM_PERCENT",
    "SizingRequest",
    "workload_multiplier",
    "per_camera_units",
    "recommend",
    "sizing_table",
    "render_table",
]
