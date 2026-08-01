"""Benchmark harness (AI-5a, Production Readiness) — establishes the platform's OFFICIAL performance
baseline and evaluates it against documented budgets/SLOs, so every future optimization is
evidence-driven (Architect AI-5 rec 1/9: benchmark before optimizing).

This is **operational** code — it measures the existing v1.0 pipeline, adds no perception capability,
and never touches the five frozen contracts. It mirrors `@vip/contracts/benchmark`
(`BenchmarkWorkload` / `PerformanceBudget` / `BenchmarkKpis` / `BenchmarkReport`).

Design for determinism + testability: the KPI math (`percentile`, `evaluate_budget`, `build_report`) is
pure and unit-tested with injected numbers; `run_benchmark` executes the real pipeline (stub adapter,
synthetic frames by default — real cameras/models are integration-only) and fills in wall-clock timings.
Multi-camera workloads (1/4/8, Architect rec 7) run N per-camera pipelines and aggregate. Stdlib-only.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

_RUNTIME_VERSION = "0.1.0"
_BENCHMARK_VERSION = "1.0.0"


# --- pure KPI math (deterministic, unit-tested) --------------------------------------------------

def percentile(samples: Sequence[float], pct: float) -> float:
    """Nearest-rank percentile (pct in [0,100]). Empty → 0.0. Deterministic."""
    if not samples:
        return 0.0
    ordered = sorted(samples)
    if pct <= 0:
        return ordered[0]
    if pct >= 100:
        return ordered[-1]
    rank = max(1, int(round((pct / 100.0) * len(ordered))))
    return ordered[min(rank, len(ordered)) - 1]


# KPI → (budget field, comparison). comparison "max" = KPI must be ≤ budget; "min" = KPI must be ≥ budget.
_BUDGET_RULES = {
    "fps": ("minSustainedFps", "min"),
    "inferenceLatencyP95Ms": ("maxInferenceLatencyMs", "max"),
    "eventLatencyMs": ("maxEventLatencyMs", "max"),
    "droppedFramePercent": ("maxFrameLossPercent", "max"),
    "cpuPercent": ("cpuCeilingPercent", "max"),
    "gpuPercent": ("gpuCeilingPercent", "max"),
    "memoryMb": ("memoryCeilingMb", "max"),
}


_WARN_MARGIN = 0.1  # within 10% of a limit → WARNING (informational, Architect AI-5a refinement 9)


def evaluate_budget(
    kpis: Dict[str, float], budget: Optional[Dict[str, object]], *, warn_margin: float = _WARN_MARGIN
) -> Tuple[Dict[str, str], Optional[bool]]:
    """Compare measured KPIs to a PerformanceBudget → per-KPI verdicts + overall pass. Verdicts are
    `pass` / `warning` (within `warn_margin` of the limit) / `fail` / `na`. A `warning` does NOT fail the
    run — evaluation is informational in AI-5a. Returns ({kpi: verdict}, passed); passed is None when no
    budget constrains anything."""
    if not budget:
        return {}, None
    status: Dict[str, str] = {}
    constrained = False
    overall = True
    for kpi, (field_name, cmp) in _BUDGET_RULES.items():
        limit = budget.get(field_name)
        if limit is None or kpi not in kpis or kpis[kpi] is None:
            status[kpi] = "na"
            continue
        constrained = True
        limit_f = float(limit)
        value = kpis[kpi]
        if cmp == "max":
            failed = value > limit_f
            warn = (not failed) and value >= limit_f * (1.0 - warn_margin)
        else:  # min
            failed = value < limit_f
            warn = (not failed) and value <= limit_f * (1.0 + warn_margin)
        status[kpi] = "fail" if failed else ("warning" if warn else "pass")
        overall = overall and not failed
    return status, (overall if constrained else None)


def stable_fingerprint(payload: dict, *, prefix: str) -> str:
    """A deterministic short digest of a dict (AI-5b refinement 5).

    Two benchmark reports are directly comparable ONLY when their configuration and hardware
    fingerprints match; when they differ, the delta is explained by config or hardware rather than by
    the runtime change under test. Sorted-key JSON + sha256 makes the digest reproducible across
    processes and machines (Python's `hash()` is salted per process and would be useless here).
    """
    import hashlib  # noqa: WPS433
    import json  # noqa: WPS433

    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def environment_fingerprint() -> dict:
    """A lightweight, best-effort environment fingerprint (Architect AI-5a refinement 2). Descriptive
    metadata only; missing fields are simply omitted (no hard dependency)."""
    import platform  # noqa: WPS433

    env: dict = {
        "os": platform.system() or "unknown",
        "arch": platform.machine() or "unknown",
        "pythonVersion": platform.python_version(),
    }
    proc = platform.processor()
    if proc:
        env["cpuModel"] = proc[:200]
    try:
        cores = os.cpu_count()
        if cores:
            env["logicalCores"] = int(cores)
    except Exception:
        pass
    return env


@dataclass
class BenchmarkKpis:
    fps: float
    inference_latency_p50_ms: float
    inference_latency_p95_ms: float
    event_latency_ms: float
    event_throughput: float
    dropped_frame_percent: float
    frames_processed: int
    duration_seconds: float
    cpu_percent: Optional[float] = None
    gpu_percent: Optional[float] = None
    memory_mb: Optional[float] = None

    def to_dict(self) -> dict:
        out = {
            "fps": round(self.fps, 6),
            "inferenceLatencyP50Ms": round(self.inference_latency_p50_ms, 6),
            "inferenceLatencyP95Ms": round(self.inference_latency_p95_ms, 6),
            "eventLatencyMs": round(self.event_latency_ms, 6),
            "eventThroughput": round(self.event_throughput, 6),
            "droppedFramePercent": round(self.dropped_frame_percent, 6),
            "framesProcessed": int(self.frames_processed),
            "durationSeconds": round(self.duration_seconds, 6),
        }
        for k, v in (("cpuPercent", self.cpu_percent), ("gpuPercent", self.gpu_percent), ("memoryMb", self.memory_mb)):
            if v is not None:
                out[k] = round(float(v), 6)
        return out


@dataclass
class BenchmarkWorkload:
    name: str
    cameras: int
    frames: int
    resolution: str = "synthetic"
    target_fps: float = 5.0
    duration_seconds: Optional[float] = None
    description: Optional[str] = None

    def to_dict(self) -> dict:
        out = {
            "name": self.name,
            "cameras": int(self.cameras),
            "resolution": self.resolution,
            "targetFps": float(self.target_fps),
            "frames": int(self.frames),
        }
        if self.duration_seconds is not None:
            out["durationSeconds"] = round(float(self.duration_seconds), 6)
        if self.description is not None:
            out["description"] = self.description
        return out


def build_report(
    *,
    report_id: str,
    deployment_class: str,
    workload: BenchmarkWorkload,
    kpis: BenchmarkKpis,
    budget: Optional[dict],
    recorded_at: str,
    runtime_version: str = _RUNTIME_VERSION,
    benchmark_version: str = _BENCHMARK_VERSION,
    environment: Optional[dict] = None,
    configuration: Optional[dict] = None,
    baseline_id: Optional[str] = None,
    host: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict:
    """Assemble a contract-shaped `BenchmarkReport` dict (mirrors @vip/contracts/benchmark), with the
    reproducibility metadata (version/environment/configuration) the Architect requested (refinements 1/2)."""
    kpi_dict = kpis.to_dict()
    status, passed = evaluate_budget(kpi_dict, budget)
    report = {
        "id": report_id,
        "benchmarkVersion": benchmark_version,
        "deploymentClass": deployment_class,
        "runtimeVersion": runtime_version,
        "workload": workload.to_dict(),
        "kpis": kpi_dict,
        "budgetStatus": status,
        "passed": passed,
        "configuration": dict(configuration or {}),
        "recordedAt": recorded_at,
    }
    if budget is not None:
        report["budget"] = dict(budget)
    # Reproducibility anchors (AI-5b refinement 5): runtime version · benchmark version · deployment
    # class are already fields above; these two make config/hardware comparability checkable at a
    # glance instead of by eyeballing two JSON blobs.
    report["configurationFingerprint"] = stable_fingerprint(report["configuration"], prefix="cfg")
    if environment is not None:
        report["environment"] = dict(environment)
        report["hardwareFingerprint"] = stable_fingerprint(dict(environment), prefix="hw")
    if baseline_id is not None:
        report["baselineId"] = baseline_id
    if host is not None:
        report["host"] = host
    if notes is not None:
        report["notes"] = notes
    return report


# --- pipeline execution (wall-clock; smoke-tested, not asserted on absolute numbers) --------------

@dataclass
class _Run:
    inference_samples_ms: List[float] = field(default_factory=list)
    frames: int = 0
    events: int = 0
    dropped: int = 0
    event_latency_ms_total: float = 0.0
    # AI-5b live-run signals (0/empty for offline runs, so the AI-5a baseline math is unchanged).
    reconnects: int = 0
    availability_samples: List[float] = field(default_factory=list)


def run_benchmark(
    workload: BenchmarkWorkload,
    *,
    deployment_class: str = "dev-laptop",
    budget: Optional[dict] = None,
    analyze: Optional[Callable[[int], object]] = None,
    now_iso: Optional[Callable[[], str]] = None,
    report_id: str = "bench_1",
    host: Optional[str] = None,
    warmup_cameras: int = 1,
    include_environment: bool = True,
    clock: Callable[[], float] = time.perf_counter,
    mode: str = "deterministic-synthetic",
) -> dict:
    """Run the workload over the real pipeline (stub-deterministic by default) and produce a
    `BenchmarkReport`. `analyze(camera_index) -> AnalyzeResult` is injectable so tests/CLI control the
    pipeline; the default builds a synthetic single-model pipeline per camera.

    Warm-up is separated from measurement (Architect AI-5a refinement 4): a warm-up pass primes the
    adapter/JIT/caches and is NOT timed, so initialization cost never skews the baseline."""
    analyze = analyze or _default_analyze(workload)
    # --- warm-up (untimed) ---
    for cam in range(max(0, warmup_cameras)):
        analyze(cam)
    # --- measured ---
    started = clock()
    run = _Run()
    for cam in range(workload.cameras):
        result = analyze(cam)
        timings = getattr(result, "timings", None)
        # Per-frame inference sample (mean over the run — a representative sample for the percentile set).
        frames = int(result.summary.get("framesSampled", workload.frames))
        run.frames += frames
        if timings is not None and frames:
            run.inference_samples_ms.append(timings.inference_ms / max(1, frames))
        run.events += len(result.events)
        # End-to-end latency proxy = sum of per-frame stage timings (decode→event) over frames.
        if timings is not None:
            td = timings.as_dict()
            per_frame = sum(v for v in td.values()) / max(1, frames)
            run.event_latency_ms_total += per_frame * frames
        # NOTE: sampler down-sampling is INTENTIONAL, not loss — it must NOT count as a dropped frame.
        # Read `backpressureDropped`, which ONLY a live run emits, and deliberately NOT the batch
        # summary's `framesDropped` — that older key counts sampler-skipped frames, and treating it as
        # loss would report ~80% frame loss for a perfectly healthy 30→5 fps offline run.
        run.dropped += int(result.summary.get("backpressureDropped", 0) or 0)
        run.reconnects += int(result.summary.get("reconnectCount", 0) or 0)
        availability = result.summary.get("availabilityPercent")
        if availability is not None:
            run.availability_samples.append(float(availability))
    elapsed = max(1e-9, clock() - started)

    total_frames = max(1, run.frames)
    kpis = BenchmarkKpis(
        fps=run.frames / elapsed / max(1, workload.cameras),
        inference_latency_p50_ms=percentile(run.inference_samples_ms, 50),
        inference_latency_p95_ms=percentile(run.inference_samples_ms, 95),
        event_latency_ms=run.event_latency_ms_total / total_frames,
        event_throughput=run.events / elapsed,
        dropped_frame_percent=100.0 * run.dropped / max(1, run.frames + run.dropped),
        frames_processed=run.frames,
        duration_seconds=elapsed,
        memory_mb=_rss_mb(),
    )
    iso = (now_iso or _now_iso)()
    configuration = {
        "frames": workload.frames,
        "cameras": workload.cameras,
        "targetFps": workload.target_fps,
        "warmupCameras": max(0, warmup_cameras),
        "mode": mode,
    }
    if run.availability_samples:
        # Live runs additionally document ingestion health, so a "slow" result can be attributed to a
        # flapping source rather than to the runtime (Architect AI-5a rec 4: document assumptions).
        configuration["streamAvailabilityPercent"] = round(
            sum(run.availability_samples) / len(run.availability_samples), 3
        )
        configuration["reconnectCount"] = run.reconnects
    return build_report(
        report_id=report_id, deployment_class=deployment_class, workload=workload,
        kpis=kpis, budget=budget, recorded_at=iso, host=host,
        environment=(environment_fingerprint() if include_environment else None),
        configuration=configuration,
    )


def _default_analyze(workload: BenchmarkWorkload):
    """A deterministic per-camera pipeline run (stub adapter, synthetic frames — no real deps)."""
    from playground import build_adapter  # noqa: WPS433 - local import keeps module import cheap
    from video_analyzer import AnalyzeOptions, VideoAnalyzer
    from video_decoder import StubFrameDecoder

    def _analyze(cam: int):
        opts = AnalyzeOptions(
            tenant_id="tnt_bench", camera_id=f"cam_{cam}", session_id=f"sess_bench_{cam}",
            labels=("person",), min_confidence=0.3, target_fps=workload.target_fps,
        )
        return VideoAnalyzer(build_adapter("stub"), opts).analyze(StubFrameDecoder.synthetic(workload.frames))

    return _analyze


def _rss_mb() -> Optional[float]:
    """Best-effort resident memory (MB). Uses `resource` where available; None otherwise (no hard dep)."""
    try:
        import resource  # noqa: WPS433 - POSIX only

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # ru_maxrss is KB on Linux, bytes on macOS — normalize conservatively to MB.
        return round(rss / 1024.0 / (1024.0 if rss > 10_000_000 else 1.0), 3)
    except Exception:
        return None


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"


# --- baseline comparison (AI-5c) — the evidence gate for optimization ----------------------------
# The Architect's workflow: Baseline → Optimization → Re-benchmark → Compare → Accept or reject.
# "Never merge optimizations without measurable benchmark improvements" is enforceable only if
# "measurable" is defined, so it is: a change must exceed a noise threshold to count at all.

# KPI → higher-is-better. Anything absent is treated as lower-is-better (latency, drops).
_HIGHER_IS_BETTER = {"fps": True, "eventThroughput": True, "framesProcessed": True}

_COMPARED_KPIS = (
    "fps",
    "inferenceLatencyP50Ms",
    "inferenceLatencyP95Ms",
    "eventLatencyMs",
    "eventThroughput",
    "droppedFramePercent",
)

_DEFAULT_THRESHOLD_PERCENT = 5.0


def compare_reports(
    baseline: dict,
    candidate: dict,
    *,
    threshold_percent: float = _DEFAULT_THRESHOLD_PERCENT,
    now_iso: Optional[Callable[[], str]] = None,
) -> dict:
    """Compare a candidate benchmark run against a baseline → a `BenchmarkComparison` dict.

    Guards comparability first: two reports whose configuration or hardware fingerprints differ are
    NOT comparable, and their deltas are reported as informational only. Without that guard a hardware
    upgrade or a changed frame count would launder itself as a code improvement — which is precisely
    the mistake an evidence-driven workflow exists to prevent.
    """
    baseline_kpis = baseline.get("kpis", {})
    candidate_kpis = candidate.get("kpis", {})

    comparable = True
    reasons: List[str] = []
    for field_name, label in (
        ("configurationFingerprint", "configuration"),
        ("hardwareFingerprint", "hardware"),
    ):
        base_fp, cand_fp = baseline.get(field_name), candidate.get(field_name)
        if base_fp and cand_fp and base_fp != cand_fp:
            comparable = False
            reasons.append(f"{label} differs ({base_fp} vs {cand_fp})")
    base_workload = (baseline.get("workload") or {}).get("name")
    cand_workload = (candidate.get("workload") or {}).get("name")
    if base_workload and cand_workload and base_workload != cand_workload:
        comparable = False
        reasons.append(f"workload differs ({base_workload} vs {cand_workload})")

    deltas: List[dict] = []
    improved: List[str] = []
    regressed: List[str] = []
    for kpi in _COMPARED_KPIS:
        if kpi not in baseline_kpis or kpi not in candidate_kpis:
            continue
        base_value = float(baseline_kpis[kpi])
        cand_value = float(candidate_kpis[kpi])
        delta = cand_value - base_value
        delta_percent = (100.0 * delta / abs(base_value)) if base_value else (0.0 if delta == 0 else 100.0)
        higher_better = _HIGHER_IS_BETTER.get(kpi, False)
        if abs(delta_percent) < threshold_percent:
            verdict = "unchanged"  # inside the noise band — not a result
        elif (delta > 0) == higher_better:
            verdict = "improved"
            improved.append(kpi)
        else:
            verdict = "regressed"
            regressed.append(kpi)
        deltas.append(
            {
                "kpi": kpi,
                "baseline": round(base_value, 6),
                "candidate": round(cand_value, 6),
                "delta": round(delta, 6),
                "deltaPercent": round(delta_percent, 3),
                "higherIsBetter": higher_better,
                "verdict": verdict,
            }
        )

    # Accept only a measurable improvement with no regression — and never on incomparable runs.
    accepted = comparable and bool(improved) and not regressed
    if not comparable:
        summary = "not comparable: " + "; ".join(reasons)
    elif regressed:
        summary = f"REJECT — regressed: {', '.join(regressed)}"
    elif improved:
        summary = f"ACCEPT — improved: {', '.join(improved)}"
    else:
        summary = f"REJECT — no measurable change beyond {threshold_percent:g}% threshold"

    return {
        "baselineId": str(baseline.get("id", "baseline")),
        "candidateId": str(candidate.get("id", "candidate")),
        "workload": cand_workload or base_workload or "unknown",
        "deploymentClass": candidate.get("deploymentClass", baseline.get("deploymentClass", "dev-laptop")),
        "comparable": comparable,
        **({"incomparableReason": "; ".join(reasons)} if reasons else {}),
        "deltas": deltas,
        "improved": improved,
        "regressed": regressed,
        "thresholdPercent": threshold_percent,
        "accepted": accepted,
        "summary": summary,
        "recordedAt": (now_iso or _now_iso)(),
    }


def compare_bundles(
    baseline_reports: List[dict],
    candidate_reports: List[dict],
    *,
    threshold_percent: float = _DEFAULT_THRESHOLD_PERCENT,
) -> List[dict]:
    """Compare two whole benchmark bundles, pairing reports by workload name."""
    by_name = {(r.get("workload") or {}).get("name"): r for r in baseline_reports}
    out: List[dict] = []
    for candidate in candidate_reports:
        name = (candidate.get("workload") or {}).get("name")
        baseline = by_name.get(name)
        if baseline is not None:
            out.append(compare_reports(baseline, candidate, threshold_percent=threshold_percent))
    return out


# Standard realistic workloads (Architect AI-5 rec 7) — 1/4/8 cameras.
def standard_suite(frames: int = 60, target_fps: float = 5.0) -> List[BenchmarkWorkload]:
    return [
        BenchmarkWorkload(name="single-camera", cameras=1, frames=frames, target_fps=target_fps),
        BenchmarkWorkload(name="four-cameras", cameras=4, frames=frames, target_fps=target_fps),
        BenchmarkWorkload(name="eight-cameras", cameras=8, frames=frames, target_fps=target_fps),
    ]


# --- live-ingestion workloads (AI-5b) -------------------------------------------------------------
# The Architect's AI-5a rec 9 asked future suites to add continuous execution, reconnect, and
# multi-resolution/rate scenarios. These run the SAME pipeline through the LIVE path (source →
# supervisor → bounded queue → analyzer) instead of the batch path, so the numbers are directly
# comparable to the AI-5a baseline while also exercising connection loss and backpressure.
# Still fully deterministic: the source is simulated and faults are scripted — no camera, no network.


def live_suite(frames: int = 60, target_fps: float = 5.0) -> List[BenchmarkWorkload]:
    return [
        BenchmarkWorkload(
            name="live-single-camera", cameras=1, frames=frames, resolution="simulated-1080p",
            target_fps=target_fps, description="One live source through the streaming pipeline.",
        ),
        BenchmarkWorkload(
            name="live-multi-camera", cameras=4, frames=frames, resolution="simulated-1080p",
            target_fps=target_fps, description="Four concurrent live sessions (multi-camera capacity).",
        ),
        BenchmarkWorkload(
            name="continuous-execution", cameras=1, frames=frames * 5, resolution="simulated-1080p",
            target_fps=target_fps, description="Long-running single source (stability over duration).",
        ),
        BenchmarkWorkload(
            name="reconnect-recovery", cameras=2, frames=frames, resolution="simulated-1080p",
            target_fps=target_fps,
            description="Live sources that drop mid-run — measures availability + recovery, not just speed.",
        ),
    ]


def live_analyze(workload: BenchmarkWorkload, *, drop_after: Optional[int] = None, queue_capacity: int = 32):
    """Build a per-camera LIVE run for `run_benchmark` — the streaming path end to end.

    `drop_after` scripts a connection loss so the reconnect-recovery workload measures what a
    production camera actually does (drop → back off → recover) rather than an idealized stream.
    """
    from playground import build_adapter  # noqa: WPS433
    from stream_pipeline import PipelineOptions, StreamPipeline
    from stream_source import ConnectionSupervisor, FaultPlan, ReconnectPolicy, SimulatedStreamSource
    from video_analyzer import AnalyzeOptions, VideoAnalyzer

    def _analyze(cam: int):
        faults = FaultPlan(drop_after_frames=drop_after, max_drops=1) if drop_after else None
        source = SimulatedStreamSource(
            uri=f"sim://bench-cam-{cam}", total_frames=workload.frames, faults=faults
        )
        supervisor = ConnectionSupervisor(
            source,
            policy=ReconnectPolicy(max_attempts=5, base_ms=1.0, max_ms=5.0),
            sleep=lambda _s: None,  # backoff is policy-tested elsewhere; don't pad the benchmark
        )
        opts = AnalyzeOptions(
            tenant_id="tnt_bench", camera_id=f"cam_{cam}", session_id=f"sess_live_{cam}",
            labels=("person",), min_confidence=0.3, target_fps=workload.target_fps,
        )
        analyzer = VideoAnalyzer(build_adapter("stub"), opts)
        pipeline = StreamPipeline(
            analyzer,
            options=PipelineOptions(queue_capacity=queue_capacity, target_fps=workload.target_fps),
        )
        events: List[dict] = []
        pipeline.run(supervisor.frames(), on_result=lambda a: events.extend(a.events))
        pipeline.flush()
        stats = pipeline.stats()
        ingestion = supervisor.stats()
        pipeline.close()  # release every queued frame before the next camera runs
        return _LiveRunResult(
            timings=analyzer.timings,
            events=events,
            summary={
                "framesSampled": stats["framesProcessed"],
                # Named distinctly from the batch summary's `framesDropped` (sampler-skipped) so the
                # two can never be confused: this is genuine backpressure loss.
                "backpressureDropped": stats["framesDropped"],
                "framesSkipped": stats["framesSkipped"],
                "reconnectCount": ingestion["reconnectCount"],
                "availabilityPercent": ingestion["availabilityPercent"],
            },
        )

    return _analyze


@dataclass
class _LiveRunResult:
    """The subset of `AnalyzeResult` that `run_benchmark` consumes — kept small on purpose, because a
    live run must not retain per-frame history just to be measured."""

    timings: object
    events: List[dict]
    summary: dict
