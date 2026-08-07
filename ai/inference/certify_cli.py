"""`vip certify` — the production certification CLI (AI-5e, Architect recommendation 3).

One command that runs the whole procedure against a target and writes a reproducible bundle:

    discovery → compatibility → capability → benchmark → (optional) soak → summary → bundle

**It will not certify anything from this repository alone**, and that is the point. Run against a
simulated source it produces a complete, well-formed bundle whose status is `pending-validation`,
listing exactly which physical checks are outstanding. Point it at a real camera and the same command
produces the same artifacts with `hardware` evidence and a real verdict. Nothing in between requires a
code change — which is what makes it something an installer can run on a customer site.

    # against the simulated source — exercises the procedure, certifies nothing
    python certify_cli.py --target generic-rtsp --output cert-out

    # against a real camera, with credentials from the environment (never on the command line)
    python certify_cli.py --target hikvision-generic --source rtsp \\
        --uri "rtsp://cam.local:554/Streaming/Channels/102" --output cert-out

    # discover what is on the network first
    python certify_cli.py --discover --subnet-timeout 4

    # the compatibility matrix and the sizing guide
    python certify_cli.py --matrix
    python certify_cli.py --sizing retail-store --cameras 16

Credentials are read from `VIP_CAMERA_USERNAME` / `VIP_CAMERA_PASSWORD` — never from argv, because
argv is visible to every process on the box and ends up in shell history.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time
from typing import List, Optional

from benchmark import BenchmarkWorkload, environment_fingerprint, run_benchmark
from camera_registry import CameraRegistry, render_matrix
from certification import (
    CapabilityAccumulator,
    CertificationBudget,
    CertificationHarness,
    CertificationTarget,
    build_bundle,
    capability_report,
    evidence_for_source,
)
from compute import ComputeRegistry, ComputeResource
from resources import ResourceAccountant
from scheduler import InferenceScheduler, SchedulerPolicy
from session_runner import LiveSessionConfig, SessionSupervisor, ThreadExecutor
from sessions import SessionManager
from sizing import SizingRequest, recommend, render_table, sizing_table
from soak import SoakPolicy, SoakRun, render_report as render_soak
from stream_pipeline import PipelineOptions
from stream_source import ReconnectPolicy, SimulatedStreamSource, build_source
from video_analyzer import AnalyzeOptions, VideoAnalyzer

RUNTIME_VERSION = "1.0.0"
CERTIFICATION_VERSION = "1.0.0"


# --- discovery ------------------------------------------------------------------


def discover(args: argparse.Namespace) -> int:
    """WS-Discovery + capability negotiation against whatever answers on the LAN."""
    from onvif import HttpSoapTransport, OnvifDevice, OnvifDiscovery, UdpDiscoveryTransport

    print(f"probing for ONVIF devices ({args.subnet_timeout:g}s)…")
    devices = OnvifDiscovery(UdpDiscoveryTransport()).discover(timeout_seconds=args.subnet_timeout)
    if not devices:
        print("no devices answered. ONVIF may be disabled, or multicast may not cross this segment.")
        return 1
    registry = CameraRegistry().load()
    for device in devices:
        username = os.environ.get("VIP_CAMERA_USERNAME")
        password = os.environ.get("VIP_CAMERA_PASSWORD")
        try:
            device = OnvifDevice(
                device.address, HttpSoapTransport(), username=username, password=password
            ).negotiate(device)
        except Exception as exc:  # noqa: BLE001 - one hostile device must not end the scan
            print(f"  {device.address}: negotiation failed ({exc})")
            continue
        print(f"\n  {device.label}  [{device.address}]")
        print(f"    firmware : {device.firmware or 'unknown'}   serial: {device.serial_number or 'unknown'}")
        print(f"    onvif    : {device.onvif_version or 'unknown'}   ptz: {device.ptz}   "
              f"audio: {device.audio}   metadata: {device.metadata_stream}")
        for profile in device.profiles:
            mark = " ←analyze" if profile.preferred_for_analysis else ""
            print(f"    profile  : {profile.name:<14} {profile.resolution or '?':>10} "
                  f"{profile.codec or '?':<5} {profile.fps or '?'}fps{mark}")
        entry = registry.observe(device)
        print(f"    registry : {entry.id} — status stays '{entry.status}' (discovery certifies nothing)")
    if args.write_registry:
        registry.save()
        print(f"\nregistry updated: {registry.directory}")
    return 0


# --- certification --------------------------------------------------------------


def certify(args: argparse.Namespace) -> int:
    registry = CameraRegistry().load()
    entry = registry.get(args.target)
    if entry is None:
        print(f"error: no registry entry '{args.target}'. Known targets:", file=sys.stderr)
        for known in registry.entries():
            print(f"  {known.id:<24} {known.label}", file=sys.stderr)
        return 2

    source_type = args.source or (entry.transports[0] if entry.transports else "simulated")
    evidence = evidence_for_source(source_type)
    target = CertificationTarget(
        id=entry.id,
        label=entry.label,
        kind=entry.kind,
        manufacturer=entry.manufacturer,
        model=entry.model,
        firmware=entry.firmware[0] if entry.firmware else None,
        transports=[source_type],
        capabilities={"streamProfiles": entry.stream_profiles} if entry.stream_profiles else None,
    )
    environment = environment_fingerprint()
    harness = CertificationHarness(
        target,
        runtime_version=RUNTIME_VERSION,
        certification_version=CERTIFICATION_VERSION,
        budget=CertificationBudget(
            min_sustained_fps=args.min_fps,
            max_frame_loss_percent=args.max_loss,
        ),
        environment=environment,
    )

    print(f"certifying {entry.label} over '{source_type}' ({evidence} evidence)")
    accumulator = CapabilityAccumulator(evidence)
    diagnostics = _run_session(args, source_type, frames=args.frames, on_result=accumulator)
    harness.observe_session(
        diagnostics,
        source_type=source_type,
        secret=os.environ.get("VIP_CAMERA_PASSWORD"),
        capabilities=target.capabilities,
        requested_fps=args.fps,
        kpis={"fps": args.fps},
    )
    harness.seed_manual_checks()

    compatibility = harness.compatibility_report()
    observations = accumulator.observations()
    capability = capability_report(
        entry.id, observations, runtime_version=RUNTIME_VERSION
    )

    benchmarks: List[dict] = []
    if not args.no_benchmark:
        benchmarks.append(
            run_benchmark(
                BenchmarkWorkload(
                    name=f"certify-{entry.id}", cameras=1, frames=args.frames, target_fps=args.fps
                ),
                deployment_class=args.deployment,
                report_id=f"bench_certify_{entry.id}",
                host=f"{platform.system()} {platform.machine()}",
            )
        )

    soak_report = None
    if args.soak_hours:
        soak_report = _run_soak(args, entry.id, source_type, evidence)

    summary = harness.summary(
        compatibility_id=compatibility["id"],
        capability_id=capability["id"],
        soak_id=(soak_report or {}).get("id"),
        benchmark_ids=[b["id"] for b in benchmarks],
        deployment_class=args.deployment,
        extra_blockers=list((soak_report or {}).get("blockers") or []),
    )
    bundle = build_bundle(
        summary,
        runtime_version=RUNTIME_VERSION,
        site=args.site,
        compatibility=compatibility,
        capability=capability,
        soak=soak_report,
        benchmarks=benchmarks,
        configuration={"source": {"type": source_type, "uri": args.uri or "sim://certify"},
                       "targetFps": args.fps, "frames": args.frames},
        environment=environment,
        notes=args.notes,
    )

    _print_summary(summary, compatibility, soak_report)
    if args.write_registry:
        registry.certify(entry.id, summary, certification_version=CERTIFICATION_VERSION)
        registry.save()
        print(f"registry updated: status '{registry.get(entry.id).status}'")

    os.makedirs(args.output, exist_ok=True)
    for name, payload in (
        ("compatibility.json", compatibility),
        ("capability.json", capability),
        ("certification-summary.json", summary),
        ("validation-bundle.json", bundle),
    ):
        _write(os.path.join(args.output, name), payload)
    if soak_report:
        _write(os.path.join(args.output, "soak.json"), soak_report)
    for i, report in enumerate(benchmarks, start=1):
        _write(os.path.join(args.output, f"benchmark-{i}.json"), report)
    print(f"\nartifacts written to {os.path.abspath(args.output)}")
    # Exit non-zero only on a measured FAILURE. `pending-validation` is the expected outcome of a
    # simulated run and must not break a CI pipeline that legitimately has no camera attached.
    return 1 if summary["status"] in ("failed", "not-supported") else 0


def _run_session(args: argparse.Namespace, source_type: str, *, frames: int, on_result=None):  # noqa: ANN001, ANN202
    """Start one real session through the real supervisor and return its diagnostics.

    The REAL supervisor, scheduler and pipeline — not a certification-specific harness. A result
    obtained from a bespoke path would say nothing about production, which is the whole reason the
    procedure drives the frozen runtime rather than reimplementing it.

    ### ⛔ Why a live source needs a thread and a deadline (P-9 A3)

    `SessionSupervisor` defaults to `SynchronousExecutor` — *"runs the pump inline, the deterministic
    default for tests and benchmarks"* — which is exactly right for a **finite** simulated source and
    catastrophic for a live one. `OpenCvStreamSource.frames()` is an unbounded `while True`
    (correctly: a live camera stream has no end, and `totalFrames` is honoured only by the simulated
    source), so `supervisor.start()` never returned.

    Measured: `certify_cli --target generic-rtsp --source rtsp --uri rtsp://…` printed its header and
    then hung. Stack, at 35 s:

        stream_source.frames → stream_pipeline.run → session_runner._pump
        → SynchronousExecutor.submit → runner.start → supervisor.start → _run_session

    ⚠️ **Every hardware certification run — the entire point of Track B — would have hung**, before
    printing a summary or writing a bundle. Found on a synthetic fixture, which is the cheapest place
    to find it.

    The bound lives here rather than in the runtime because a live stream having no end is the
    correct behaviour; it is the *certification procedure* that wants a finite observation window.
    """
    analyze_options = AnalyzeOptions(
        tenant_id="tnt_certify", camera_id="cam_certify", engine=args.engine
    )
    analyzer = VideoAnalyzer(_adapter(args.engine), analyze_options)
    config = LiveSessionConfig(
        source={
            "type": source_type,
            "uri": args.uri or "sim://certify",
            "options": {"totalFrames": frames},
        },
        analyze=analyze_options,
        pipeline=PipelineOptions(queue_capacity=32, target_fps=args.fps, source_fps=30.0),
        reconnect=ReconnectPolicy(max_attempts=3, base_ms=200.0, max_ms=2000.0),
    )
    # A live transport never ends by itself, so its pump must not be the calling thread.
    live = source_type != "simulated"
    supervisor = SessionSupervisor(
        SessionManager(),
        max_sessions=2,
        scheduler=InferenceScheduler(
            ComputeRegistry([ComputeResource(id="cpu:0", kind="cpu", capacity_units=64.0)]),
            ResourceAccountant(),
            policy=SchedulerPolicy(reserved_capacity_percent=0.0),
        ),
        **({"executor_factory": ThreadExecutor} if live else {}),
    )
    source = (
        SimulatedStreamSource(uri="sim://certify", total_frames=frames)
        if source_type == "simulated"
        else build_source(config.source)
    )

    # Counted here rather than asked of the pipeline afterwards: the observation window has to close
    # on frames that actually arrived, and a camera that stalls at frame 12 must end the window by
    # deadline rather than by hope.
    seen = {"frames": 0}

    def observe(result) -> None:  # noqa: ANN001 - one analyzer result
        seen["frames"] += 1
        if on_result is not None:
            on_result(result)

    runner = supervisor.start(
        "tnt_certify",
        camera_id="cam_certify",
        capability_id="playground.detect",
        config=config,
        analyzer=analyzer,
        source=source,
        on_result=observe,
        log_sink=lambda _r: None,
    )
    if live:
        deadline = time.monotonic() + max(1.0, float(args.max_seconds))
        while (
            not runner.finished
            and seen["frames"] < frames
            and time.monotonic() < deadline
        ):
            time.sleep(0.1)
        if seen["frames"] < frames:
            # ⚠️ Said out loud. A run that observed 12 of 60 requested frames is a finding about the
            # device, and the checks below read the same diagnostics either way — but a human
            # watching a certification (which §8 of the plan requires) should not have to infer it.
            print(
                f"  window closed after {seen['frames']}/{frames} frames "
                f"({'deadline' if not runner.finished else 'stream ended'})"
            )
    diagnostics = runner.diagnostics()
    try:
        supervisor.stop("tnt_certify", runner.identity.session_id)
    except Exception:  # noqa: BLE001 - teardown must never mask the result
        pass
    return diagnostics


def _run_soak(args: argparse.Namespace, target_id: str, source_type: str, evidence: str) -> dict:
    """A soak driven from this CLI. With `--soak-hours` under an hour this is a smoke test of the
    procedure; a real soak is 24h+ and is expected to be run under a supervisor, not a terminal."""
    run = SoakRun(
        target_id,
        policy=SoakPolicy(
            planned_hours=args.soak_hours, sample_interval_seconds=args.soak_interval
        ),
        source_type=source_type,
        runtime_version=RUNTIME_VERSION,
    )
    print(f"soak: {args.soak_hours:g}h planned, sampling every {args.soak_interval:g}s")
    print("  (a soak shorter than its planned duration reports the shortfall as a blocker)")
    diagnostics = _run_session(args, source_type, frames=args.frames)
    backpressure = diagnostics.get("backpressure") or {}
    for _ in range(2):
        run.sample(
            {"queueUtilization": float(backpressure.get("queueUtilization") or 0.0)},
            frames_processed=int(backpressure.get("framesProcessed") or 0),
        )
    report = run.report()
    print(render_soak(report))
    return report


def _print_summary(summary: dict, compatibility: dict, soak: Optional[dict]) -> None:
    print()
    print(f"status   : {summary['status'].replace('-', ' ').upper()}")
    print(f"evidence : {summary['evidenceClass']}")
    print(f"checks   : {summary['checksPassed']} passed · {summary['checksFailed']} failed "
          f"· {summary['checksTotal']} total")
    for check in compatibility["checks"]:
        mark = {"pass": "ok ", "fail": "FAIL", "warn": "warn", "skipped": "skip",
                "not-executed": "—  "}[check["status"]]
        detail = f"  {check.get('detail')}" if check.get("detail") else ""
        print(f"  [{mark}] {check['name']}{detail}")
    if summary["blockers"]:
        print("blockers :")
        for blocker in summary["blockers"]:
            print(f"  - {blocker}")


# --- reporting subcommands ------------------------------------------------------


def matrix(_args: argparse.Namespace) -> int:
    registry = CameraRegistry().load()
    print(render_matrix(registry.matrix()))
    summary = registry.summary()
    print(f"\n{summary['devices']} devices · " + " · ".join(
        f"{k.replace('-', ' ')}: {v}" for k, v in summary["byStatus"].items() if v
    ))
    print("No hardware compatibility is claimed until a device has been physically validated.")
    return 0


def sizing(args: argparse.Namespace) -> int:
    if args.cameras:
        row = recommend(
            SizingRequest(
                profile=args.sizing,
                cameras=args.cameras,
                target_fps=args.fps,
                workload=list(args.workload or ()),
            )
        )
        print(render_table([row]))
        print(f"\n{row['rationale']}")
        return 0 if row["feasible"] else 1
    print(render_table(sizing_table(args.sizing, target_fps=args.fps)))
    print("\n'estimate' means catalogue reference costs, not a measurement. Supply a benchmark to "
          "turn these into measured numbers.")
    return 0


# --- helpers --------------------------------------------------------------------


def _adapter(engine: str):  # noqa: ANN202
    from playground import build_adapter  # noqa: WPS433

    return build_adapter(engine)


def _write(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
        fh.write("\n")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="vip certify",
        description="Run the production certification procedure against a device.",
        epilog="Credentials come from VIP_CAMERA_USERNAME / VIP_CAMERA_PASSWORD, never from argv.",
    )
    p.add_argument("--target", help="registry entry id (see --matrix)")
    p.add_argument("--source", help="declared source type: rtsp|onvif|usb|http|file|simulated")
    p.add_argument("--uri", help="source locator (no embedded credentials)")
    p.add_argument("--engine", default="stub", choices=["stub", "onnx"])
    p.add_argument("--deployment", default="dev-laptop",
                   choices=["dev-laptop", "mini-pc-i5", "rtx-desktop", "edge-device"])
    p.add_argument("--frames", type=int, default=60)
    # ⚠️ The observation window's hard ceiling on a LIVE source. Ignored for `simulated`, which ends
    # by itself. Without it a camera that opens and then stalls — the "opens then stalls" device the
    # probe contract already names — holds the certification open forever instead of failing it.
    p.add_argument("--max-seconds", type=float, default=120.0,
                   help="ceiling on a live observation window (s); the simulated source ignores it")
    p.add_argument("--fps", type=float, default=5.0)
    p.add_argument("--min-fps", type=float, default=None, help="certification floor for sustained fps")
    p.add_argument("--max-loss", type=float, default=None, help="certification ceiling for frame loss %%")
    p.add_argument("--no-benchmark", action="store_true")
    p.add_argument("--soak-hours", type=float, default=0.0, help="also run a soak of this duration")
    p.add_argument("--soak-interval", type=float, default=300.0, help="soak sample interval (s)")
    p.add_argument("--site", help="deployment/site label for the validation bundle")
    p.add_argument("--notes", help="free-text notes for the bundle")
    p.add_argument("--output", default="certification-output")
    p.add_argument("--write-registry", action="store_true",
                   help="apply the result to the camera compatibility registry")
    p.add_argument("--discover", action="store_true", help="probe the network for ONVIF devices")
    p.add_argument("--subnet-timeout", type=float, default=3.0)
    p.add_argument("--matrix", action="store_true", help="print the compatibility matrix and exit")
    p.add_argument("--sizing", help="print a hardware sizing guide for this deployment profile")
    p.add_argument("--cameras", type=int, default=0, help="camera count for --sizing")
    p.add_argument("--workload", nargs="*", help="behaviours enabled, for --sizing")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.matrix:
        return matrix(args)
    if args.sizing:
        return sizing(args)
    if args.discover:
        return discover(args)
    if not args.target:
        build_parser().print_help()
        return 2
    return certify(args)


if __name__ == "__main__":
    raise SystemExit(main())
