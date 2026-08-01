"""Benchmark CLI (AI-5a) — run the standard workloads (1/4/8 cameras) or a custom one against a
deployment class's budget, and write `benchmark.json` (the official baseline). Deterministic-by-default
(stub adapter, synthetic frames); real cameras/models/GPU are AI-5b+ integration paths.

    python benchmark_cli.py --deployment edge-device --suite --frames 60
    python benchmark_cli.py --deployment rtx-desktop --cameras 4 --frames 120 --output bench-out
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from typing import List, Optional

from benchmark import (
    BenchmarkWorkload,
    compare_bundles,
    environment_fingerprint,
    live_analyze,
    live_suite,
    run_benchmark,
    standard_suite,
)

_BUDGETS_PATH = os.path.join(os.path.dirname(__file__), "benchmarks", "budgets.json")


def _load_budget(deployment_class: str) -> Optional[dict]:
    try:
        with open(_BUDGETS_PATH, encoding="utf-8") as fh:
            return json.load(fh).get("budgets", {}).get(deployment_class)
    except FileNotFoundError:
        return None


def _host() -> str:
    return f"{platform.system()} {platform.machine()} · py{platform.python_version()}"


def run(args: argparse.Namespace) -> int:
    budget = None if args.no_budget else _load_budget(args.deployment)
    # `--live` runs the AI-5b streaming path (source → supervisor → bounded queue → analyzer); the
    # default remains the AI-5a offline path, so the accepted baseline stays reproducible verbatim.
    if args.live:
        workloads = live_suite(frames=args.frames, target_fps=args.fps)
    elif args.suite:
        workloads = standard_suite(frames=args.frames, target_fps=args.fps)
    else:
        workloads = [BenchmarkWorkload(name=f"{args.cameras}-camera", cameras=args.cameras, frames=args.frames, target_fps=args.fps)]

    mode = "deterministic-live" if args.live else "deterministic-synthetic"
    reports: List[dict] = []
    for i, wl in enumerate(workloads, start=1):
        analyze = None
        if args.live:
            # The reconnect workload scripts a mid-run source loss; the rest run clean.
            drop_after = max(1, wl.frames // 3) if wl.name == "reconnect-recovery" else None
            analyze = live_analyze(wl, drop_after=drop_after, queue_capacity=args.queue_size)
        report = run_benchmark(
            wl, deployment_class=args.deployment, budget=budget, analyze=analyze, mode=mode,
            report_id=f"bench_{args.deployment}_{wl.name}", host=_host(),
        )
        reports.append(report)
        _print_report(report)

    # Artifact bundle (Architect AI-5a refinement 7): benchmark.json · summary.txt · runtime_metrics.json
    # · environment.json · configuration.json.
    os.makedirs(args.output, exist_ok=True)
    env = environment_fingerprint()
    config = {
        "deploymentClass": args.deployment,
        "suite": bool(args.suite),
        "cameras": args.cameras,
        "frames": args.frames,
        "targetFps": args.fps,
        "budgetApplied": budget is not None,
        "mode": mode,
        "live": bool(args.live),
        "queueSize": args.queue_size,
    }
    runtime_metrics = [
        {
            "workload": r["workload"]["name"],
            "sessionCount": r["workload"]["cameras"],
            "fps": r["kpis"]["fps"],
            "eventLatencyMs": r["kpis"]["eventLatencyMs"],
            "eventThroughput": r["kpis"]["eventThroughput"],
            "droppedFrames": r["kpis"]["droppedFramePercent"],
            "benchmarkRunCount": 1,
            **({"streamAvailability": r["configuration"]["streamAvailabilityPercent"]}
               if "streamAvailabilityPercent" in r.get("configuration", {}) else {}),
            **({"reconnectCount": r["configuration"]["reconnectCount"]}
               if "reconnectCount" in r.get("configuration", {}) else {}),
        }
        for r in reports
    ]
    # Evidence gate (Architect AI-5b rec 7): Baseline -> Optimization -> Re-benchmark -> Compare.
    comparisons: List[dict] = []
    if args.baseline:
        try:
            with open(args.baseline, encoding="utf-8") as fh:
                baseline_reports = json.load(fh).get("reports", [])
            comparisons = compare_bundles(baseline_reports, reports, threshold_percent=args.threshold)
            print("\n--- comparison vs baseline ---")
            for c in comparisons:
                print(f"[{c['workload']}] {c['summary']}")
        except (OSError, json.JSONDecodeError) as exc:
            print(f"warning: could not read baseline '{args.baseline}': {exc}", file=sys.stderr)

    artifacts = {
        "benchmark.json": {"deploymentClass": args.deployment, "reports": reports},
        "runtime_metrics.json": {"metrics": runtime_metrics},
        "environment.json": env,
        "configuration.json": config,
    }
    if comparisons:
        artifacts["comparison.json"] = {"comparisons": comparisons}
    for name, doc in artifacts.items():
        with open(os.path.join(args.output, name), "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, sort_keys=True)
            fh.write("\n")
    with open(os.path.join(args.output, "summary.txt"), "w", encoding="utf-8") as fh:
        fh.write(_summary_text(args.deployment, reports, env))

    print(f"\nbaseline bundle written to: {os.path.abspath(args.output)} (benchmark.json · summary.txt · runtime_metrics.json · environment.json · configuration.json)")
    # Non-zero exit if any budget FAILED (a warning does not fail) — CI-gateable governance step.
    failed = [r for r in reports if r.get("passed") is False]
    # A comparison that REGRESSED also fails the run: "never merge optimizations without measurable
    # benchmark improvements" is only a rule if something enforces it.
    regressed = [c for c in comparisons if c.get("comparable") and c.get("regressed")]
    if regressed:
        print(f"\nBENCHMARK REGRESSION in {len(regressed)} workload(s) — rejecting.", file=sys.stderr)
    return 1 if (failed or regressed) else 0


def _summary_text(deployment: str, reports: List[dict], env: dict) -> str:
    lines = [
        "AI Benchmark — production baseline",
        "==================================",
        f"deployment    : {deployment}",
        f"environment   : {env.get('os')} {env.get('arch')} · py{env.get('pythonVersion')} · {env.get('logicalCores', '?')} cores",
        f"benchmark ver : {reports[0].get('benchmarkVersion') if reports else '?'}",
        "",
    ]
    for r in reports:
        k = r["kpis"]
        verdict = "n/a" if r.get("passed") is None else ("PASS" if r["passed"] else "FAIL")
        warns = [kpi for kpi, v in r.get("budgetStatus", {}).items() if v == "warning"]
        lines += [
            f"[{r['workload']['name']}] ({r['workload']['cameras']} cam) — {verdict}",
            f"  fps={k['fps']:.2f}  inferP50={k['inferenceLatencyP50Ms']:.2f}ms  inferP95={k['inferenceLatencyP95Ms']:.2f}ms",
            f"  eventLatency={k['eventLatencyMs']:.2f}ms  throughput={k['eventThroughput']:.1f}/s  dropped={k['droppedFramePercent']:.2f}%",
            (f"  warnings: {', '.join(warns)}" if warns else "  warnings: none"),
            "",
        ]
    return "\n".join(lines)


def _print_report(r: dict) -> None:
    k = r["kpis"]
    verdict = "n/a" if r.get("passed") is None else ("PASS" if r["passed"] else "FAIL")
    print(f"\n[{r['workload']['name']}] {r['deploymentClass']} — {verdict}")
    print(f"  fps={k['fps']:.2f}  inferP50={k['inferenceLatencyP50Ms']:.2f}ms  inferP95={k['inferenceLatencyP95Ms']:.2f}ms")
    print(f"  eventLatency={k['eventLatencyMs']:.2f}ms  throughput={k['eventThroughput']:.1f}/s  dropped={k['droppedFramePercent']:.2f}%")
    if r.get("budgetStatus"):
        fails = [kpi for kpi, v in r["budgetStatus"].items() if v == "fail"]
        if fails:
            print(f"  budget FAIL on: {', '.join(fails)}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ai-benchmark", description="Benchmark the AI runtime against a deployment budget.")
    p.add_argument("--deployment", default="dev-laptop", choices=["dev-laptop", "mini-pc-i5", "rtx-desktop", "edge-device"])
    p.add_argument("--suite", action="store_true", help="run the standard 1/4/8-camera workloads")
    p.add_argument("--live", action="store_true", help="run the AI-5b live-ingestion workloads (streaming path)")
    p.add_argument("--queue-size", type=int, default=32, dest="queue_size", help="bounded frame-queue capacity per live session")
    p.add_argument("--cameras", type=int, default=1, help="camera count for a single custom workload")
    p.add_argument("--frames", type=int, default=60, help="frames per camera")
    p.add_argument("--fps", type=float, default=5.0, help="target sampling FPS")
    p.add_argument("--no-budget", action="store_true", help="measure only; do not evaluate against a budget")
    p.add_argument("--baseline", help="path to a previous benchmark.json to compare against (evidence gate)")
    p.add_argument("--threshold", type=float, default=5.0, help="percent change below which a delta is noise")
    p.add_argument("--output", default="benchmark-output", help="output directory")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    return run(build_parser().parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
