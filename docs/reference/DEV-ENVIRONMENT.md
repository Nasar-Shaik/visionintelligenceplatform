# Reference — Developer Environment & Local Stack

> **Status: reference / illustrative.** This captures a proven local development setup for the GPU video+inference pipeline. It is a **starting point**, not the ratified dev stack — the authoritative Compose/tooling is finalized in **Phase 0** ([TASK-BOARD P0-4](../../tracking/TASK-BOARD.md)) and lives under [`infra/docker/`](../../infra/). Where this doc and the ratified tech stack differ, [reference/TECH-STACK](TECH-STACK.md) and open items in [TASK-BOARD → Needs-Decision](../../tracking/TASK-BOARD.md) win.

## 1. Host workstation (recommended minimum)

For local development of the zero-copy GPU pipeline:

- **CPU:** 16+ physical cores (e.g. Intel i9-14900K / AMD Ryzen 9 7950X).
- **RAM:** 64 GB DDR5 (128 GB for multi-stream simulation).
- **GPU:** NVIDIA RTX 4090 (24 GB) or RTX 6000 Ada — Ampere/Ada with Tensor Cores for TensorRT.
- **Storage:** 2 TB NVMe Gen4 (stream cache + Docker layers), ≥5000 MB/s.
- **OS:** Ubuntu 24.04 LTS, kernel 6.8+; **NVIDIA Container Toolkit** for GPU passthrough into rootless Docker.

Non-GPU contributors (frontend, control-plane services) can develop against the Compose stack without a local GPU by pointing at a shared inference environment.

## 2. Host toolchain (one-time)

Install: build-essential, cmake, pkg-config, GStreamer 1.0 (+ base/good/bad/ugly/libav/rtsp plugins, `libgstrtspserver-1.0-dev`), Python 3 (dev/venv/pip), Node.js LTS + pnpm, jq. Then the NVIDIA layer:

```bash
# NVIDIA driver (555+) and Container Toolkit
sudo add-apt-repository ppa:graphics-drivers/ppa -y && sudo apt-get update
sudo apt-get install -y nvidia-driver-555 nvidia-utils-555
# Container Toolkit repo + install (see current NVIDIA docs for the exact keyring URLs)
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
# Verify
nvidia-smi && docker info | grep -i nvidia
```

> The exact NVIDIA apt keyring/source URLs change over time — always take them from NVIDIA's current install guide rather than pasting an old snippet.

## 3. Local Compose stack (backing services)

The dev stack mirrors production topology. Representative services (finalized in `infra/docker/docker-compose.yml`):

| Service           | Image (dev)                                                                | Purpose                                                           | Port      |
| ----------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------- |
| Event backbone    | Redpanda / Kafka (`confluentinc/cp-kafka`)                                 | Durable event log ([09](../architecture/09-EVENT-PLATFORM.md))    | 9092      |
| OLTP              | `mongo:8`                                                                  | Operational store ([18](../architecture/18-DATA-ARCHITECTURE.md)) | 27017     |
| Cache/state/queue | `redis:7-alpine` (appendonly)                                              | Sessions, rule state, queues                                      | 6379      |
| Object storage    | `minio`                                                                    | Clips, models, datasets (S3-compatible)                           | 9000/9001 |
| Search+vector     | OpenSearch **or** Qdrant/Milvus (see [ND-2](../../tracking/TASK-BOARD.md)) | Event search + embeddings                                         | 9200      |
| RTSP test source  | `bluenviron/mediamtx` + FFmpeg                                             | Synthetic camera streams                                          | 8554      |
| GPU pipeline      | `ai_platform/video_pipeline` (built locally)                               | Decode + inference (GPU passthrough)                              | —         |

GPU services declare the NVIDIA reservation and generous `shm_size` (e.g. `8gb`) to support zero-copy shared-memory allocations; mount `/dev/shm`.

> **Dev-only credentials** must never resemble production secrets and never leave `.env.example`. Real secrets come from the vault ([15 §4](../architecture/15-SECURITY-ARCHITECTURE.md)); nothing secret is committed.

## 4. Zero-copy GPU ingest (pattern)

The high-throughput ingest path decodes RTSP with hardware **NVDEC**, keeps frames in GPU (`NVMM`) memory, and hands pointers directly to a **TensorRT** engine — no host round-trip. GStreamer launch pattern:

```
rtspsrc location=rtsp://…/stream latency=200 ! rtph264depay ! h264parse !
nvv4l2decoder ! video/x-raw(memory:NVMM), format=NV12 !
appsink emit-signals=true max-buffers=5 drop=true
```

The appsink callback maps the NVMM buffer and executes inference in-place (CUDA/TensorRT context). A reference C++ implementation (CMake + GStreamer + TensorRT) belongs in `ai/inference/` once P3 begins; this pattern is the design contract for it. This is one concrete way to satisfy the `media.frame-extract` capability's edge placement ([05](../architecture/05-CAPABILITY-ARCHITECTURE.md), [07 §3](../architecture/07-DATA-AND-PIPELINE-FLOWS.md)).

## 5. Local end-to-end test

1. **Synthetic camera:** run MediaMTX + FFmpeg `testsrc` to publish `rtsp://localhost:8554/stream1`.
2. **Inject metadata:** push mock detection/track payloads to the event backbone to exercise the rule engine without real inference.
3. **Verify:** confirm stateful rule evaluation (e.g. dwell → loitering) dedupes and emits an event; check the event feed. Full E2E (camera → capability DAG → event → rule → alert → evidence) suites live in [`tests/e2e/`](../../tests/).

The camera simulator + injectors are formalized in [`tools/camera-simulator/`](../../tools/) and drive load/stress/scale tests.

## 6. Troubleshooting

| Symptom                        | Likely cause                                                                | Resolution                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Failed to initialize NVDEC`   | Container runtime not registered / driver mismatch                          | `nvidia-smi` on host; ensure `deploy.resources.reservations.devices` present; reinstall Container Toolkit                 |
| Frame latency spikes (>100 ms) | Host↔Device copies in the sink, or network jitter filling GStreamer buffers | Enforce `video/x-raw(memory:NVMM)`; raise `rtspsrc latency`; verify no CPU round-trip                                     |
| GPU OOM under multi-stream     | Too many concurrent models/streams per device                               | Reduce batch/streams; enable motion-gating; check placement/scheduler ([19](../architecture/19-PERFORMANCE-AND-SCALE.md)) |

## Cross-references

[17-DEVOPS-AND-INFRA](../architecture/17-DEVOPS-AND-INFRA.md) · [reference/TECH-STACK](TECH-STACK.md) · [reference/HARDWARE-SIZING](HARDWARE-SIZING.md) · [../../tracking/TASK-BOARD.md](../../tracking/TASK-BOARD.md)
