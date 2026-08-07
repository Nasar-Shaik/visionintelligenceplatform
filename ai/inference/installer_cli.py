"""`vip install` — the **Installer Toolkit** (P-9 A7).

One command a field engineer runs on a customer site, which answers the questions they are actually
asked while standing on a ladder:

    python installer_cli.py --site "Northgate Retail" --output ./install-report

    # a specific camera, credentials from the environment
    VIP_CAMERA_USERNAME=admin VIP_CAMERA_PASSWORD=… \\
      python installer_cli.py --site "Northgate" --camera rtsp://10.0.0.64:554/Streaming/Channels/102

    # discovery only, before anything is cabled
    python installer_cli.py --site "Northgate" --discover-only

It runs, in order: **network diagnostics → ONVIF discovery → ONVIF negotiation → staged RTSP probe →
latency → frame delivery → snapshot → (optional) certification → report.**

### ⭐ Why this is a toolkit and not a script

Every stage below already existed and was reachable only by someone who knew which Python module to
import. An installer does not. The value here is not new measurement — it is that **one command
produces one report that a person can hand to a customer**, and that the report says "we could not
check that" where it could not check.

### ⛔ What it deliberately does not claim

**Packet loss is not measured.** Nothing in this stack can see RTP sequence numbers — OpenCV hands
over decoded frames and throws the transport away. What *is* measured is **frame delivery**: frames
decoded against frames expected over a timed window. That is a useful number and it is not packet
loss, and the report says so in those words rather than putting a plausible percentage next to a
label an engineer will read as RTCP. A number in the right units with the wrong meaning is worse
than an honest gap ([ADR-0039](../../docs/adr/ADR-0039-absent-is-null.md)).

### Credentials

Read from `VIP_CAMERA_USERNAME` / `VIP_CAMERA_PASSWORD`, never from argv — argv is visible to every
process on the box and ends up in shell history. They are never written to the report.

Stdlib plus the runtime's own modules; `cv2` only when a stream is probed.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import subprocess  # noqa: S404 - route/interface inspection, fixed argv, no shell
import sys
import time
from typing import List, Optional

TOOLKIT_VERSION = "1.0.0"


# --- small helpers ---------------------------------------------------------------


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _run(argv: List[str], timeout: float = 5.0) -> Optional[str]:
    """A fixed-argv command, or `None` if it is not on this box. Never a shell, never user input."""
    try:
        out = subprocess.run(  # noqa: S603 - fixed argv, shell=False
            argv, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


class Stage:
    """One section of the report. `status` is `pass`/`warn`/`fail`/`skipped`/`not-executed`.

    ⚠️ `not-executed` is a first-class outcome, exactly as it is in the staged probe. An installer
    told "we did not check" goes and checks; an installer told "pass" does not.
    """

    def __init__(self, name: str, title: str) -> None:
        self.name = name
        self.title = title
        self.status = "not-executed"
        self.detail: Optional[str] = None
        self.data: dict = {}
        self.duration_ms: Optional[float] = None

    def to_dict(self) -> dict:
        out = {"name": self.name, "title": self.title, "status": self.status, "data": self.data}
        if self.detail:
            out["detail"] = self.detail
        if self.duration_ms is not None:
            out["durationMs"] = round(self.duration_ms, 1)
        return out


# --- stages ----------------------------------------------------------------------


def stage_network(args: argparse.Namespace) -> Stage:
    """Where is this box, and can it possibly see the cameras?"""
    stage = Stage("network", "Network diagnostics")
    started = time.monotonic()
    hostname = socket.gethostname()
    addresses = []
    try:
        for info in socket.getaddrinfo(hostname, None):
            addr = info[4][0]
            if addr not in addresses:
                addresses.append(addr)
    except OSError:
        pass
    # A second route to the same answer: the address the kernel would use to reach the internet.
    primary = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.settimeout(0.5)
        probe.connect(("203.0.113.1", 9))  # TEST-NET-3, never routed anywhere
        primary = probe.getsockname()[0]
        probe.close()
    except OSError:
        primary = None

    stage.data = {
        "hostname": hostname,
        "platform": f"{platform.system()} {platform.release()} {platform.machine()}",
        "addresses": addresses,
        "primaryAddress": primary,
        "routes": _run(["ip", "route"]) or _run(["netstat", "-rn"]),
    }
    if primary is None and not addresses:
        stage.status = "fail"
        stage.detail = "this machine has no usable network address — nothing below can succeed"
    else:
        stage.status = "pass"
        stage.detail = f"primary address {primary or addresses[0]}"
    # ⚠️ The single most common reason a hardware trial fails on day one, stated before it happens.
    stage.data["multicastNote"] = (
        "ONVIF discovery is WS-Discovery multicast and does NOT cross a routed boundary. If the "
        "cameras are on a different subnet from this machine, discovery will find nothing and the "
        "cameras must be added by address."
    )
    stage.duration_ms = (time.monotonic() - started) * 1000
    return stage


def stage_discovery(args: argparse.Namespace) -> Stage:
    """WS-Discovery: what answers on this segment?"""
    stage = Stage("discovery", "ONVIF discovery")
    started = time.monotonic()
    try:
        from onvif import OnvifDiscovery, UdpDiscoveryTransport

        devices = OnvifDiscovery(UdpDiscoveryTransport()).discover(
            timeout_seconds=args.subnet_timeout
        )
    except Exception as exc:  # noqa: BLE001 - a broken scan is an answer, not a crash
        stage.status = "fail"
        stage.detail = f"{type(exc).__name__}: {exc}"
        stage.duration_ms = (time.monotonic() - started) * 1000
        return stage

    stage.data = {
        "probedSeconds": args.subnet_timeout,
        "found": len(devices),
        "devices": [{"address": d.address, "label": getattr(d, "label", None)} for d in devices],
    }
    if devices:
        stage.status = "pass"
        stage.detail = f"{len(devices)} device(s) answered"
    else:
        # ⚠️ NOT a failure. "Nothing answered" is a real, common and correct result — the cameras may
        # be on another subnet, or ONVIF may be switched off at the device. Calling it `fail` sends
        # an installer looking for a fault that may not exist.
        stage.status = "warn"
        stage.detail = (
            "no device answered — check the cameras are on this subnet and ONVIF is enabled on them"
        )
    stage.duration_ms = (time.monotonic() - started) * 1000
    return stage


def stage_onvif(args: argparse.Namespace, discovered: Stage) -> Stage:
    """Negotiate each discovered device: firmware, serial, profiles."""
    stage = Stage("onvif", "ONVIF negotiation")
    addresses = [d["address"] for d in discovered.data.get("devices", [])]
    if not addresses:
        stage.status = "skipped"
        stage.detail = "no devices were discovered to negotiate with"
        return stage

    started = time.monotonic()
    from onvif import HttpSoapTransport, OnvifDevice

    username = os.environ.get("VIP_CAMERA_USERNAME")
    password = os.environ.get("VIP_CAMERA_PASSWORD")
    results = []
    for address in addresses:
        try:
            device = OnvifDevice(
                address, HttpSoapTransport(), username=username, password=password
            ).negotiate()
            results.append(
                {
                    "address": address,
                    "ok": True,
                    "label": device.label,
                    "firmware": device.firmware,
                    "serialNumber": device.serial_number,
                    "onvifVersion": device.onvif_version,
                    "ptz": device.ptz,
                    "profiles": [
                        {
                            "name": p.name,
                            "resolution": p.resolution,
                            "codec": p.codec,
                            "fps": p.fps,
                            "preferredForAnalysis": p.preferred_for_analysis,
                        }
                        for p in device.profiles
                    ],
                }
            )
        except Exception as exc:  # noqa: BLE001 - one hostile device must not end the visit
            results.append({"address": address, "ok": False, "error": f"{type(exc).__name__}: {exc}"})

    stage.data = {"devices": results}
    ok = [r for r in results if r["ok"]]
    stage.status = "pass" if len(ok) == len(results) else ("warn" if ok else "fail")
    stage.detail = f"{len(ok)}/{len(results)} negotiated"
    stage.duration_ms = (time.monotonic() - started) * 1000
    return stage


def stage_probe(args: argparse.Namespace, uri: str) -> Stage:
    """The staged probe: dns → tcp → authentication → negotiation → open → first frame → …

    ⭐ The whole value is WHICH stage stopped. `dns` sends the installer to their DNS server, `tcp`
    to their firewall, `authentication` to their password, `first-frame` to the camera itself.
    """
    stage = Stage("probe", "Staged stream probe")
    started = time.monotonic()
    from stream_probe import probe_stream

    username = os.environ.get("VIP_CAMERA_USERNAME")
    password = os.environ.get("VIP_CAMERA_PASSWORD")
    credentials = {"username": username, "password": password} if username else None
    from server import _apply_credentials  # noqa: WPS433 - one implementation of URI credentialing

    credentialed_uri, credentialed = _apply_credentials(uri, credentials)
    report = probe_stream(
        {"type": "rtsp", "uri": credentialed_uri, "_credentialed": credentialed},
        frames=args.frames,
        timeout_seconds=args.timeout,
    )
    payload = report.to_dict()
    stage.data = payload
    checks = payload.get("checks", [])
    failed = [c for c in checks if c.get("status") == "fail"]
    if payload.get("reachable") and payload.get("framesRead", 0) > 0 and not failed:
        stage.status = "pass"
        stage.detail = f"{payload.get('framesRead')} frames decoded"
    else:
        stage.status = "fail"
        stage.detail = (
            f"stopped at '{failed[0]['name']}': {failed[0].get('detail') or 'no detail'}"
            if failed
            else "the stream opened and delivered no frames"
        )
    stage.duration_ms = (time.monotonic() - started) * 1000
    return stage


def stage_latency(probe: Stage) -> Stage:
    """Latency, read off the probe rather than measured a second time."""
    stage = Stage("latency", "Latency")
    data = probe.data or {}
    if not data:
        stage.status = "not-executed"
        stage.detail = "no probe was run"
        return stage
    connect_ms = data.get("connectMs")
    first_frame_ms = data.get("firstFrameMs")
    jitter_ms = data.get("jitterMs")
    stage.data = {"connectMs": connect_ms, "firstFrameMs": first_frame_ms, "jitterMs": jitter_ms}
    if first_frame_ms is None:
        stage.status = "not-executed"
        stage.detail = "no frame arrived, so there is no time-to-first-frame"
        return stage
    # ⚠️ Thresholds are ADVISORY and say so. A slow camera on a busy site is not a failed install,
    # and an installer told "fail" by a number nobody agreed will start ignoring the tool.
    stage.status = "pass" if first_frame_ms < 3000 else "warn"
    stage.detail = (
        f"connect {connect_ms:.0f}ms · first frame {first_frame_ms:.0f}ms"
        f"{f' · jitter {jitter_ms:.0f}ms' if jitter_ms is not None else ''}"
        " (advisory thresholds)"
    )
    return stage


def stage_delivery(args: argparse.Namespace, uri: str) -> Stage:
    """Frame delivery over a timed window.

    ⛔ **This is NOT packet loss, and the report never calls it that.** Nothing in this stack sees RTP
    sequence numbers — OpenCV hands over decoded frames and discards the transport. What is measured
    is frames decoded against frames expected at the negotiated rate. A stream losing packets and a
    stream whose encoder is simply slow produce the same number here, and an engineer must know that
    before acting on it.
    """
    stage = Stage("delivery", "Frame delivery (not packet loss)")
    started = time.monotonic()
    try:
        import cv2  # noqa: WPS433 - HEAVY, only this stage needs it
    except ImportError:
        stage.status = "not-executed"
        stage.detail = "no decoder available in this environment"
        return stage

    from server import _apply_credentials

    username = os.environ.get("VIP_CAMERA_USERNAME")
    password = os.environ.get("VIP_CAMERA_PASSWORD")
    credentials = {"username": username, "password": password} if username else None
    credentialed_uri, _ = _apply_credentials(uri, credentials)

    cap = cv2.VideoCapture(credentialed_uri)
    if not cap.isOpened():
        cap.release()
        stage.status = "fail"
        stage.detail = "the stream could not be opened for the delivery window"
        stage.duration_ms = (time.monotonic() - started) * 1000
        return stage

    declared_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    window = max(2.0, float(args.window))
    deadline = time.monotonic() + window
    decoded = 0
    read_failures = 0
    while time.monotonic() < deadline:
        ok, _frame = cap.read()
        if ok:
            decoded += 1
        else:
            read_failures += 1
            if read_failures > 30:
                break
    cap.release()

    elapsed = time.monotonic() - started
    observed_fps = decoded / elapsed if elapsed > 0 else 0.0
    expected = declared_fps * elapsed if declared_fps > 0 else None
    stage.data = {
        "windowSeconds": round(elapsed, 2),
        "framesDecoded": decoded,
        "readFailures": read_failures,
        "declaredFps": declared_fps or None,
        "observedFps": round(observed_fps, 2),
        "expectedFrames": None if expected is None else round(expected),
        "deliveryPercent": (
            None if not expected else round(min(100.0, 100.0 * decoded / expected), 1)
        ),
        "isPacketLoss": False,
        "note": (
            "Frames decoded vs frames expected at the camera's declared rate. This is NOT packet "
            "loss: RTP sequence numbers are not visible to this tool. A lossy network and a slow "
            "encoder produce the same figure here."
        ),
    }
    if decoded == 0:
        stage.status = "fail"
        stage.detail = "the stream opened and delivered no frames"
    elif stage.data["deliveryPercent"] is None:
        stage.status = "warn"
        stage.detail = f"{decoded} frames in {elapsed:.1f}s — the camera declared no frame rate to compare against"
    elif stage.data["deliveryPercent"] >= 90:
        stage.status = "pass"
        stage.detail = f"{stage.data['deliveryPercent']}% of expected frames"
    else:
        stage.status = "warn"
        stage.detail = f"{stage.data['deliveryPercent']}% of expected frames — investigate before sign-off"
    stage.duration_ms = elapsed * 1000
    return stage


def stage_snapshot(args: argparse.Namespace, uri: str, out_dir: str) -> Stage:
    """One JPEG, so the report shows what the camera is actually pointed at.

    ⭐ The single most valuable artifact in the whole report. A camera can pass every check above and
    be aimed at a ceiling, and no measurement in this tool would notice.
    """
    stage = Stage("snapshot", "Snapshot")
    started = time.monotonic()
    try:
        import cv2  # noqa: WPS433
    except ImportError:
        stage.status = "not-executed"
        stage.detail = "no decoder available in this environment"
        return stage

    from server import _apply_credentials

    username = os.environ.get("VIP_CAMERA_USERNAME")
    password = os.environ.get("VIP_CAMERA_PASSWORD")
    credentials = {"username": username, "password": password} if username else None
    credentialed_uri, _ = _apply_credentials(uri, credentials)

    cap = cv2.VideoCapture(credentialed_uri)
    ok, frame = (False, None)
    if cap.isOpened():
        # Discard the first few: the first decoded frame after a connect is routinely a grey or
        # partially-decoded one, and a grey snapshot in a customer report looks like a broken camera.
        for _ in range(5):
            ok, frame = cap.read()
            if not ok:
                break
    cap.release()
    if not ok or frame is None:
        stage.status = "fail"
        stage.detail = "no frame could be captured"
        stage.duration_ms = (time.monotonic() - started) * 1000
        return stage

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "snapshot.jpg")
    cv2.imwrite(path, frame)
    height, width = int(frame.shape[0]), int(frame.shape[1])
    stage.data = {"path": os.path.basename(path), "resolution": f"{width}x{height}"}
    stage.status = "pass"
    stage.detail = f"{width}x{height} written to {os.path.basename(path)}"
    stage.duration_ms = (time.monotonic() - started) * 1000
    return stage


# --- report ----------------------------------------------------------------------

_MARK = {"pass": "✅", "warn": "⚠️", "fail": "⛔", "skipped": "—", "not-executed": "—"}


def render_report(payload: dict) -> str:
    """The markdown a customer is handed. Status words, never ticks alone."""
    lines = [
        f"# Installation report — {payload['site']}",
        "",
        f"**{payload['generatedAt']}** · toolkit {payload['toolkitVersion']} · "
        f"engineer: {payload.get('engineer') or 'unrecorded'}",
        "",
        f"**Verdict: {payload['verdict'].upper()}** — {payload['verdictDetail']}",
        "",
        "| Stage | Result | Detail |",
        "| ----- | ------ | ------ |",
    ]
    for stage in payload["stages"]:
        detail = (stage.get("detail") or "").replace("|", "\\|")
        lines.append(f"| {stage['title']} | {_MARK[stage['status']]} {stage['status']} | {detail} |")
    lines += ["", "## What this report does not say", ""]
    lines += [
        "- ⛔ **Packet loss was not measured.** The delivery figure is frames decoded against frames "
        "expected; RTP sequence numbers are not visible to this tool.",
        "- ⛔ **Nothing here certifies a camera.** Certification needs a deliberate link interruption "
        "and a clean-shutdown observation, both made by a person at the device.",
        "- ⚠️ Latency thresholds are advisory.",
        "",
    ]
    probe = next((s for s in payload["stages"] if s["name"] == "probe"), None)
    if probe and probe.get("data", {}).get("checks"):
        lines += ["## Staged probe detail", "", "| Stage | Status | Measured |", "| --- | --- | --- |"]
        for check in probe["data"]["checks"]:
            lines.append(
                f"| {check['name']} | {check['status']} | {check.get('measured') or check.get('detail') or ''} |"
            )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _verdict(stages: List[Stage]) -> tuple:
    failed = [s for s in stages if s.status == "fail"]
    warned = [s for s in stages if s.status == "warn"]
    if failed:
        return "no-go", f"{len(failed)} stage(s) failed: {', '.join(s.title for s in failed)}"
    if warned:
        return "go-with-findings", f"{len(warned)} stage(s) need attention: {', '.join(s.title for s in warned)}"
    return "go", "every executed stage passed"


# --- main ------------------------------------------------------------------------


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="vip install", description="VIP Installer Toolkit")
    p.add_argument("--site", required=True, help="site or customer name, for the report")
    p.add_argument("--engineer", help="who ran this, for the report")
    p.add_argument("--camera", help="one camera's RTSP URI (no embedded credentials)")
    p.add_argument("--output", default="install-report", help="directory for the report + snapshot")
    p.add_argument("--subnet-timeout", type=float, default=4.0, help="ONVIF discovery window (s)")
    p.add_argument("--timeout", type=float, default=10.0, help="probe timeout (s)")
    p.add_argument("--frames", type=int, default=5, help="frames the probe should read")
    p.add_argument("--window", type=float, default=10.0, help="frame-delivery window (s)")
    p.add_argument("--discover-only", action="store_true", help="stop after discovery")
    p.add_argument("--certify", metavar="TARGET", help="also run certification against this registry id")
    args = p.parse_args(argv)

    print(f"VIP Installer Toolkit {TOOLKIT_VERSION} — {args.site}\n")
    stages: List[Stage] = []

    def run(stage: Stage) -> Stage:
        stages.append(stage)
        print(f"  {_MARK[stage.status]} {stage.title:<28} {stage.detail or ''}")
        return stage

    run(stage_network(args))
    discovery = run(stage_discovery(args))
    if not args.discover_only:
        run(stage_onvif(args, discovery))

    uri = args.camera
    if uri is None and discovery.data.get("devices"):
        # Nothing is invented: only a device that actually answered is probed.
        first = discovery.data["devices"][0]["address"]
        print(f"\n  no --camera given; probing the first discovered device at {first}")
        uri = f"rtsp://{first}:554/"

    if args.discover_only:
        print("\n  --discover-only: stopping here")
    elif uri is None:
        for name, title in (
            ("probe", "Staged stream probe"),
            ("latency", "Latency"),
            ("delivery", "Frame delivery (not packet loss)"),
            ("snapshot", "Snapshot"),
        ):
            stage = Stage(name, title)
            stage.status = "not-executed"
            stage.detail = "no camera was given and none was discovered"
            run(stage)
    else:
        probe = run(stage_probe(args, uri))
        run(stage_latency(probe))
        run(stage_delivery(args, uri))
        run(stage_snapshot(args, uri, args.output))

    if args.certify:
        stage = Stage("certification", "Certification")
        stage.status = "not-executed"
        stage.detail = (
            f"run `certify_cli.py --target {args.certify} --source rtsp --uri {uri or '<uri>'}` "
            "with an engineer present — an unattended certification is one nobody can defend"
        )
        run(stage)

    verdict, verdict_detail = _verdict(stages)
    payload = {
        "toolkitVersion": TOOLKIT_VERSION,
        "site": args.site,
        "engineer": args.engineer,
        "generatedAt": _now(),
        "verdict": verdict,
        "verdictDetail": verdict_detail,
        "stages": [s.to_dict() for s in stages],
    }

    os.makedirs(args.output, exist_ok=True)
    with open(os.path.join(args.output, "installation-report.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
        fh.write("\n")
    with open(os.path.join(args.output, "INSTALLATION_REPORT.md"), "w", encoding="utf-8") as fh:
        fh.write(render_report(payload))

    print(f"\n  verdict: {verdict.upper()} — {verdict_detail}")
    print(f"  report written to {args.output}/INSTALLATION_REPORT.md")
    # ⚠️ Non-zero ONLY on a hard failure. A warn verdict is information for a human, and a tool that
    # exits non-zero on advisory findings is a tool whose exit code stops being read.
    return 1 if verdict == "no-go" else 0


if __name__ == "__main__":
    sys.exit(main())
