# `edge/packaging/` — deployment packages (AI-5e, deliverable 6)

> **Packaging is software. Certification is hardware.**
> Everything in this directory is buildable today. **Nothing in it is certified**, and the two must not
> be confused: an image that starts on a Jetson proves the image is correct, not that the Jetson is a
> supported deployment target. That claim requires `vip certify` against the physical unit, and until
> one exists every device stays `pending-validation` in the
> [compatibility registry](../../ai/inference/profiles/cameras/).

## Targets

Declared once in [`targets.json`](targets.json) — adding a device is a data change, not a code change.

| target           | hardware                            | class         | accelerator | certification      |
| ---------------- | ----------------------------------- | ------------- | ----------- | ------------------ |
| `docker-generic` | Any x86-64 Docker host              | `mini-pc-i5`  | CPU         | Pending Validation |
| `mini-pc`        | Mini PC (Intel i5, no discrete GPU) | `mini-pc-i5`  | OpenVINO    | Pending Validation |
| `intel-nuc`      | Intel NUC                           | `mini-pc-i5`  | OpenVINO    | Pending Validation |
| `jetson`         | NVIDIA Jetson Orin Nano / Xavier NX | `edge-device` | CUDA        | Pending Validation |
| `industrial-pc`  | Fanless DIN-rail industrial PC      | `rtx-desktop` | CPU         | Pending Validation |

`intel-nuc` builds the same image as `mini-pc`. It is a separate row anyway, because the question a
NUC raises is thermal — whether it throttles at hour 14 of a soak — and that is a different question
from a generic mini-PC's, answerable only by running the soak on one.

## Build

```bash
# from the repository root
docker build -f edge/packaging/Dockerfile -t vip-ai-runtime:1.0.0 .

# OpenVINO (mini-pc / intel-nuc)
docker build -f edge/packaging/Dockerfile --build-arg EXTRAS=openvino \
  -t vip-ai-runtime:1.0.0-openvino .

# Jetson — the L4T tag MUST match the device's installed JetPack, or CUDA will not initialise
docker build -f edge/packaging/Dockerfile \
  --build-arg BASE_IMAGE=nvcr.io/nvidia/l4t-base:r36.2.0 \
  --build-arg EXTRAS=cuda --platform linux/arm64 \
  -t vip-ai-runtime:1.0.0-jetson .
```

## Run

```bash
docker compose -f edge/packaging/docker-compose.yml up
```

Credentials come from the environment (`VIP_CAMERA_USERNAME` / `VIP_CAMERA_PASSWORD`) and are never
baked into an image, never passed on a command line, and never embedded in a stream URL. A camera
password in an image layer is permanent, distributable and invisible.

## What the image deliberately does

- **Runs unprivileged** (`uid 10001`). An edge box sits on a customer's network holding camera
  credentials; root inside the container buys nothing.
- **Defaults RTSP to TCP.** UDP loses frames on any congested or wireless link, and a "flaky camera"
  that is really a UDP problem costs days.
- **Uses `tini`.** OpenCV leaves decoder subprocesses behind; without an init a long-running edge
  container accumulates zombies until it cannot fork. This is precisely the class of failure a 72-hour
  soak exists to catch and a 10-minute test never will.
- **Health-checks the runtime's own `/health`**, not a synthetic ping. An HTTP 200 from a process whose
  sessions are all failing is the one reassurance nobody needs.

## Certifying a device

```bash
python ai/inference/certify_cli.py --target jetson-orin-nano --source rtsp \
  --uri "rtsp://cam.local:554/Streaming/Channels/102" \
  --deployment edge-device --soak-hours 24 --write-registry --output cert-out
```

Until that runs against real hardware and passes, this directory ships packages and makes no
compatibility claims. See [PRODUCTION_COMPATIBILITY §3](../../docs/architecture/future/PRODUCTION_COMPATIBILITY.md).
