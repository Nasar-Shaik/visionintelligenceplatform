"""`vip demo` — **Customer Demonstration Mode** (P-9 A10) and **USB webcam validation** (P-9 A9).

    # the question a customer asks first: "can I see my camera working?"
    python demo_cli.py --source rtsp --uri rtsp://camera:554/stream --port 8099

    # a USB / built-in webcam
    python demo_cli.py --source usb --device 0 --port 8099

    # A9: measure the ingestion path and exit, no browser involved
    python demo_cli.py --source usb --device 0 --measure --seconds 20

Open `http://localhost:<port>/`. Live frames with detection boxes, track ids, live FPS, detection
counts, and the rule/incident panel beside them.

### ⛔ What this is, and what it is not

**It is a demonstration and diagnostic tool. It is not the product's live-video path.** No browser
decodes RTSP, and the platform has no transcode service — that is
[TD-28](../../docs/project/KNOWN_LIMITATIONS.md) and it is still open. This tool sidesteps it the
way every camera vendor's own web UI does, by pushing annotated JPEGs as
`multipart/x-mixed-replace`. That works in every browser and scales to roughly one viewer, which is
exactly right for a demo and exactly wrong for a product.

⚠️ Saying so matters more than it looks: a demo that a customer mistakes for the shipping feature
sets an expectation the roadmap has to pay for later.

### ⭐ No new inference

Frames go through `VideoAnalyzer` — the same analyzer the production pipeline uses, with the same
tracking and the same behaviours. This module draws rectangles on the result. If the boxes are wrong
here, they are wrong in the product; that is the point of reusing it rather than reimplementing it.

### A9 — USB webcam validation, and what it does not buy

`--measure` runs the same path with no browser and reports ingestion, decode, inference, tracking
and overlay as separate measurements.

⛔ **USB webcam validation is NOT a substitute for ONVIF certification.** A webcam proves a real lens,
real optics and real noise reach the decode path. It proves *nothing* about ONVIF discovery, RTSP
transport, vendor SOAP quirks, reconnect behaviour, or NVR export formats. `certification.py` maps
`usb → hardware` because the transport is genuinely physical, and that honest mapping is exactly why
this tool never writes a certification bundle — see `P9_HARDWARE_PROCUREMENT.md` §6.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import List, Optional

DEMO_VERSION = "1.0.0"

# --- shared state between the capture thread and the HTTP handlers ---------------


class DemoState:
    """What the capture loop has most recently produced. One writer, many readers."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.jpeg: Optional[bytes] = None
        self.frames = 0
        self.detections = 0
        self.tracks: List[str] = []
        self.fps = 0.0
        self.infer_ms = 0.0
        self.started = time.monotonic()
        self.error: Optional[str] = None
        self.stopping = False
        self.source_label = ""

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "frames": self.frames,
                "detections": self.detections,
                "tracks": list(self.tracks),
                "trackCount": len(self.tracks),
                "fps": round(self.fps, 2),
                "inferenceMs": round(self.infer_ms, 1),
                "uptimeSeconds": round(time.monotonic() - self.started, 1),
                "source": self.source_label,
                "error": self.error,
            }


# --- capture ---------------------------------------------------------------------

_PALETTE = [
    (66, 133, 244), (219, 68, 55), (244, 180, 0), (15, 157, 88),
    (171, 71, 188), (0, 172, 193), (255, 112, 67), (92, 107, 192),
]


def _colour_for(track_id: str) -> tuple:
    return _PALETTE[hash(track_id) % len(_PALETTE)]


class Ordinals:
    """Stable short numbers for long identity ids.

    ⚠️ The first version drew `track_id[:10]` on the box, which rendered as `trk_cam_de` — the same
    ten characters for every subject on the camera, because the prefix is the camera's, not the
    person's. In front of a customer that is worse than no label: it looks like a system that cannot
    tell two people apart. The full id stays in the side panel, where it is diagnostic rather than
    decorative.
    """

    def __init__(self) -> None:
        self._seen: dict = {}

    def of(self, identity: str) -> int:
        if identity not in self._seen:
            self._seen[identity] = len(self._seen) + 1
        return self._seen[identity]


class RemoteAnalyzer:
    """Inference over HTTP against a **deployed** runtime, exactly as the media service does it.

    ⭐ This is what makes the tool usable where the camera actually is. The camera is on a laptop or
    an edge box; the ONNX model and its catalogue are baked into the runtime image. Capturing on one
    machine and inferring on another is not a workaround — it is the platform's own frame path
    (`media` runs ffmpeg and POSTs JPEG bytes to `/infer`), and running the demo any other way would
    be demonstrating something the product does not do.

    ⚠️ `x-internal-key` gated, so this needs the deployment's `INTERNAL_API_KEY`. It is read from the
    environment, never from argv.
    """

    def __init__(self, base_url: str, key: str, tenant: str, camera_id: str, capability: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.key = key
        self.tenant = tenant
        self.camera_id = camera_id
        self.capability = capability

    def analyze(self, jpeg: bytes, index: int) -> List[dict]:
        import base64
        import urllib.error
        import urllib.request

        payload = json.dumps(
            {
                "capabilityId": self.capability,
                "context": {"tenantId": self.tenant},
                "frame": {"cameraId": self.camera_id, "seq": index, "source": "vip-demo"},
                "imageBase64": base64.b64encode(jpeg).decode("ascii"),
            }
        ).encode()
        request = urllib.request.Request(
            f"{self.base_url}/infer",
            data=payload,
            headers={"content-type": "application/json", "x-internal-key": self.key},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 - fixed scheme
            body = json.loads(response.read())
        return list((body.get("data") or {}).get("detections") or [])


def _box_of(det: dict) -> Optional[tuple]:
    """`bbox` is `(x, y, w, h)` normalised. Returns `None` rather than a zero box when it is absent —
    a zero box would be drawn in the top-left corner and read as a detection that never happened."""
    box = det.get("bbox") or det.get("box")
    if isinstance(box, dict):
        box = (box.get("x"), box.get("y"), box.get("width"), box.get("height"))
    if not isinstance(box, (list, tuple)) or len(box) < 4 or any(v is None for v in box[:4]):
        return None
    return tuple(float(v) for v in box[:4])


def capture_loop(args: argparse.Namespace, state: DemoState) -> None:
    """Open the source, analyse each frame with the REAL analyzer, annotate, publish."""
    import cv2  # noqa: WPS433 - HEAVY, only this path needs it

    target = args.device if args.source == "usb" else args.uri
    state.source_label = f"{args.source}:{target}"

    analyzer = None
    if args.inference_url:
        key = os.environ.get("INTERNAL_API_KEY", "")
        if not key:
            state.error = "INTERNAL_API_KEY is not set — the runtime will refuse every frame"
            return
        analyzer = RemoteAnalyzer(
            args.inference_url, key, args.tenant, args.camera_id, args.capability
        )
    else:
        # In-container path: the analyzer and its model are right here.
        from adapters import build_adapter  # noqa: WPS433
        from video_analyzer import AnalyzeOptions, VideoAnalyzer  # noqa: WPS433

        options = AnalyzeOptions(tenant_id=args.tenant, camera_id=args.camera_id, engine=args.engine)
        local = VideoAnalyzer(build_adapter(args.engine), options)

        class _Local:
            def analyze(self, jpeg: bytes, index: int) -> List[dict]:
                result = local.analyze_frame(jpeg, frame_index=index)
                out = []
                for det in getattr(result, "detections", []) or []:
                    out.append(
                        {
                            "label": getattr(det, "label", "object"),
                            "confidence": getattr(det, "confidence", None),
                            "bbox": list(getattr(det, "bbox", ()) or ()),
                            "trackingId": getattr(det, "tracking_id", None),
                            "identityId": getattr(det, "identity_id", None),
                        }
                    )
                return out

        analyzer = _Local()

    cap = cv2.VideoCapture(target)
    if cap.isOpened() and args.source == "usb":
        # ⚠️ **Measured on a real lens (P-9 A9):** the first frames a webcam returns are pure black —
        # `mean=0.0 std=0.0` at frame 0, real scene content (`mean≈136 std≈57`) from frame 5. The
        # sensor and auto-exposure have not settled. Feeding those to a detector produces confident
        # zero-detection frames at the start of every demo, and a customer watching sees the product
        # "miss" them.
        for _ in range(8):
            cap.read()
    if not cap.isOpened():
        cap.release()
        # ⚠️ Named precisely. On macOS a denied camera is indistinguishable from an absent one unless
        # the message says so, and the fix is a system dialog rather than anything in this repository.
        state.error = (
            f"could not open {state.source_label}. "
            + (
                "On macOS, camera access must be granted to the terminal application in "
                "System Settings → Privacy & Security → Camera, and Docker Desktop cannot pass a "
                "host camera into a container at all."
                if args.source == "usb"
                else "Check the URI, credentials and that the device is reachable from here."
            )
        )
        return

    window: List[float] = []
    ordinals = Ordinals()
    index = 0
    # ⛔ **Boxes must be drawn on EVERY frame, not only analysed ones** (found in A10 verification).
    # Only every Nth frame is analysed — a laptop cannot run detection at capture rate — and the
    # first version drew boxes only on those. At `--every 3` that is a box on one frame in three,
    # which renders as a violent flicker and reads, to a customer, as a product that keeps losing
    # the person in front of it.
    #
    # ⚠️ The cost is that a drawn box can be up to N frames stale (~110 ms at 18 fps). That is a
    # small, stated inaccuracy about WHEN a detection happened, and it is the same thing every camera
    # vendor's own UI does. The measured `inferenceMs` in the panel is not smoothed, so the panel
    # still tells the truth about the rate.
    last_detections: List[dict] = []
    try:
        while not state.stopping:
            ok, frame = cap.read()
            if not ok:
                state.error = "the source stopped delivering frames"
                break
            index += 1
            # Sample rather than analyse every frame: the demo's job is to look right and stay
            # responsive, and a laptop cannot run detection at capture rate.
            analyse = index % max(1, args.every) == 0

            detections: List[dict] = []
            infer_ms = 0.0
            if analyse:
                ok_jpeg, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if ok_jpeg:
                    t0 = time.monotonic()
                    try:
                        detections = analyzer.analyze(bytes(buf.tobytes()), index)
                        state.error = None
                    except Exception as exc:  # noqa: BLE001 - a demo must not die on one bad frame
                        state.error = f"analysis failed: {type(exc).__name__}: {exc}"
                        detections = []
                    infer_ms = (time.monotonic() - t0) * 1000
                    last_detections = detections

            height, width = frame.shape[0], frame.shape[1]
            track_ids: List[str] = []
            for det in last_detections:
                box = _box_of(det)
                if box is None:
                    continue
                # Normalised (0..1) coordinates → pixels. Detections speak normalised because a zone
                # polygon must mean the same thing at any resolution.
                bx, by, bw, bh = box
                x1, y1 = int(bx * width), int(by * height)
                x2, y2 = x1 + int(bw * width), y1 + int(bh * height)
                # ⚠️ identityId, not trackingId, for the LABEL: a person briefly occluded returns
                # with a new tracking id (ADR-0038 forbids reuse) while identity survives the gap.
                # Showing tracking id would make one visitor look like several in front of a customer.
                track_id = str(det.get("identityId") or det.get("trackingId") or "?")
                track_ids.append(track_id)
                colour = _colour_for(track_id)
                cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 2)
                label = f"{det.get('label', 'object')} #{ordinals.of(track_id)}"
                confidence = det.get("confidence")
                if confidence is not None:
                    label += f" {float(confidence):.2f}"
                cv2.rectangle(frame, (x1, max(0, y1 - 20)), (x1 + 8 * len(label), y1), colour, -1)
                cv2.putText(frame, label, (x1 + 3, max(12, y1 - 6)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

            now = time.monotonic()
            window.append(now)
            window[:] = [t for t in window if now - t <= 2.0]

            ok_jpeg, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            with state.lock:
                if ok_jpeg:
                    state.jpeg = bytes(buf.tobytes())
                state.frames = index
                state.fps = len(window) / 2.0
                if analyse:
                    state.detections += len(detections)
                    state.tracks = sorted(set(track_ids))
                    state.infer_ms = infer_ms
    finally:
        cap.release()


# --- http ------------------------------------------------------------------------

PAGE = """<!doctype html><meta charset="utf-8"><title>VIP — live camera</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
 header{padding:14px 20px;border-bottom:1px solid #30363d;display:flex;gap:16px;align-items:baseline}
 h1{font-size:16px;margin:0;font-weight:600}
 .tag{font-size:11px;padding:2px 8px;border-radius:999px;background:#1f6feb33;color:#79c0ff;border:1px solid #1f6feb66}
 main{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:20px;padding:20px;align-items:start}
 img{width:100%;border-radius:8px;border:1px solid #30363d;background:#010409;display:block}
 .panel{border:1px solid #30363d;border-radius:8px;padding:14px;background:#161b22}
 .panel h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 10px}
 .row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #21262d}
 .row:last-child{border:0}
 .v{font-variant-numeric:tabular-nums;font-weight:600}
 .ids{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
 .id{font-size:11px;padding:2px 7px;border-radius:4px;background:#23863633;border:1px solid #23863666;color:#7ee787}
 .note{margin:0;padding:10px 14px;font-size:12px;color:#d29922;background:#bb800910;border:1px solid #bb800940;border-radius:6px}
 .err{color:#f85149;border-color:#f8514966;background:#f8514910}
 @media (max-width:900px){main{grid-template-columns:1fr}}
</style>
<header>
  <h1>Vision Intelligence Platform</h1>
  <span class="tag">demonstration mode</span>
  <span class="tag" id="src">—</span>
</header>
<main>
  <div>
    <img src="/stream.mjpg" alt="live camera with detection overlays">
    <p class="note" style="margin-top:14px">⚠️ Demonstration transport (MJPEG). The product's live
       video path does not exist yet — no browser decodes RTSP and there is no transcode service
       (TD-28). Detection, tracking and rules below are the real pipeline.</p>
  </div>
  <div>
    <div class="panel">
      <h2>Live</h2>
      <div class="row"><span>Frames</span><span class="v" id="frames">0</span></div>
      <div class="row"><span>FPS</span><span class="v" id="fps">0</span></div>
      <div class="row"><span>Inference</span><span class="v" id="ms">—</span></div>
      <div class="row"><span>Uptime</span><span class="v" id="up">0s</span></div>
    </div>
    <div class="panel" style="margin-top:14px">
      <h2>Detections</h2>
      <div class="row"><span>Total</span><span class="v" id="dets">0</span></div>
      <div class="row"><span>Tracked now</span><span class="v" id="tc">0</span></div>
      <div class="ids" id="ids"></div>
    </div>
    <div class="panel" style="margin-top:14px">
      <h2>Rules &amp; incidents</h2>
      <div class="row"><span>Rule state</span><span class="v" id="rule">not configured</span></div>
      <div class="row"><span>Incidents</span><span class="v" id="inc">0</span></div>
      <p style="font-size:12px;color:#8b949e;margin:10px 0 0">Rules run in the platform against
         published events. This demo analyses frames directly, so it shows perception rather than
         incidents — attach the camera in the console to see rules fire.</p>
    </div>
    <p class="note err" id="err" hidden></p>
  </div>
</main>
<script>
 const $ = (id) => document.getElementById(id);
 async function tick(){
   try{
     const r = await fetch('/stats'); const s = await r.json();
     $('frames').textContent = s.frames; $('fps').textContent = s.fps;
     $('ms').textContent = s.inferenceMs ? s.inferenceMs + ' ms' : '—';
     $('up').textContent = s.uptimeSeconds + 's';
     $('dets').textContent = s.detections; $('tc').textContent = s.trackCount;
     $('src').textContent = s.source || '—';
     $('ids').innerHTML = s.tracks.map(t => `<span class="id">${t}</span>`).join('');
     if (s.error) { $('err').hidden = false; $('err').textContent = '⛔ ' + s.error; }
     else { $('err').hidden = true; }
   }catch(e){ /* the page outlives a blip */ }
 }
 tick(); setInterval(tick, 1000);
</script>
"""


def serve(args: argparse.Namespace, state: DemoState) -> int:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_a) -> None:  # noqa: ANN002 - quiet
            return None

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/":
                body = PAGE.encode()
                self.send_response(200)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/stats":
                body = json.dumps(state.snapshot()).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/stream.mjpg":
                self.send_response(200)
                self.send_header("content-type", "multipart/x-mixed-replace; boundary=vipframe")
                self.end_headers()
                try:
                    while not state.stopping:
                        with state.lock:
                            frame = state.jpeg
                        if frame is None:
                            time.sleep(0.1)
                            continue
                        self.wfile.write(b"--vipframe\r\nContent-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(frame)}\r\n\r\n".encode())
                        self.wfile.write(frame)
                        self.wfile.write(b"\r\n")
                        time.sleep(1.0 / max(1, args.stream_fps))
                except (BrokenPipeError, ConnectionResetError):
                    return  # the viewer closed the tab; not an error
            else:
                self.send_response(404)
                self.end_headers()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"  demonstration mode → http://localhost:{args.port}/   (ctrl-c to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopping")
    finally:
        state.stopping = True
        httpd.shutdown()
    return 0


# --- A9: measure and exit ---------------------------------------------------------

_MARK = {"pass": "✅", "fail": "⛔", "warn": "⚠️", "not-executed": "—"}


def measure(args: argparse.Namespace, state: DemoState) -> int:
    """A9. Five separable claims, each reported on its own.

    ⚠️ Separable on purpose. "The webcam works" is not a measurement — ingestion can succeed while
    inference returns nothing, and inference can succeed while tracking never assigns an id. A single
    green tick over all five would hide the two that fail most often.
    """
    deadline = time.monotonic() + args.seconds
    while time.monotonic() < deadline and not state.error:
        time.sleep(0.25)
    state.stopping = True
    time.sleep(0.4)
    snap = state.snapshot()

    rows = []
    ingestion = "pass" if snap["frames"] > 0 else "fail"
    rows.append(("ingestion", ingestion, f"{snap['frames']} frames from {snap['source']}"))
    rows.append(("opencv decode", "pass" if snap["frames"] > 0 else "fail",
                 f"{snap['fps']} fps sustained"))
    rows.append(("inference", "pass" if snap["inferenceMs"] > 0 else "not-executed",
                 f"{snap['inferenceMs']} ms per analysed frame"))
    rows.append(("detections", "pass" if snap["detections"] > 0 else "warn",
                 f"{snap['detections']} total — zero is a valid result on an empty scene"))
    rows.append(("tracking", "pass" if snap["trackCount"] > 0 else "warn",
                 f"{snap['trackCount']} identities: {', '.join(snap['tracks']) or 'none'}"))
    rows.append(("overlays", "pass" if state.jpeg else "fail",
                 "annotated frame produced" if state.jpeg else "no frame was annotated"))

    print("\n  A9 — USB / lens ingestion validation\n")
    for name, status, detail in rows:
        print(f"  {_MARK[status]} {name:<16} {detail}")
    if snap["error"]:
        print(f"\n  ⛔ {snap['error']}")

    print(
        "\n  ⛔ This is NOT ONVIF certification. A webcam proves a real lens, real optics and real\n"
        "     noise reach the decode path. It proves nothing about ONVIF discovery, RTSP transport,\n"
        "     vendor quirks, reconnect behaviour or NVR exports, and no bundle is written here."
    )
    failed = [r for r in rows if r[1] == "fail"]
    return 1 if failed else 0


# --- main -------------------------------------------------------------------------


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="vip demo", description="Customer Demonstration Mode (P-9)")
    p.add_argument("--source", choices=["rtsp", "usb", "file"], default="rtsp")
    p.add_argument("--uri", help="rtsp:// or file path, for --source rtsp|file")
    p.add_argument("--device", type=int, default=0, help="device index, for --source usb")
    p.add_argument("--engine", default="onnx", choices=["stub", "onnx"],
                   help="in-process engine; ignored when --inference-url is given")
    # ⭐ The camera is where the camera is; the model is in the runtime image. Capturing on one
    # machine and inferring on another is the platform's own frame path, not a workaround.
    p.add_argument("--inference-url", help="deployed runtime base URL, e.g. http://localhost:18085")
    # The deployed capability id — `GET /capabilities` on the runtime lists them.
    p.add_argument("--capability", default="perception.person-detection")
    p.add_argument("--tenant", default="tnt_demo")
    p.add_argument("--camera-id", default="cam_demo")
    p.add_argument("--every", type=int, default=3, help="analyse every Nth frame")
    p.add_argument("--host", default="0.0.0.0")  # noqa: S104 - a demo tool, bound deliberately
    p.add_argument("--port", type=int, default=8099)
    p.add_argument("--stream-fps", type=int, default=12)
    p.add_argument("--measure", action="store_true", help="A9: measure, print, exit — no browser")
    p.add_argument("--seconds", type=float, default=20.0, help="with --measure")
    args = p.parse_args(argv)

    if args.source in ("rtsp", "file") and not args.uri:
        print("error: --uri is required for --source rtsp|file", file=sys.stderr)
        return 2

    print(f"VIP demonstration mode {DEMO_VERSION} — {args.source}")
    state = DemoState()
    thread = threading.Thread(target=capture_loop, args=(args, state), daemon=True, name="capture")
    thread.start()

    # Give the source a moment; a failure to open is reported rather than served as a blank page.
    for _ in range(40):
        if state.error or state.jpeg is not None:
            break
        time.sleep(0.25)
    if state.error and state.jpeg is None:
        print(f"\n  ⛔ {state.error}", file=sys.stderr)
        return 1

    return measure(args, state) if args.measure else serve(args, state)


if __name__ == "__main__":
    sys.exit(main())
