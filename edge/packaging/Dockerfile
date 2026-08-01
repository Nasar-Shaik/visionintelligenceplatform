# AI Runtime edge package (AI-5e, deliverable 6).
#
# Packaging is software; certification is hardware. This image being buildable and startable proves
# the package is correct. It proves nothing about any device — that requires `vip certify` against
# the physical unit, and until then every device stays 'pending-validation' in the compatibility
# registry (ai/inference/profiles/cameras/).
#
#   docker build -f edge/packaging/Dockerfile -t vip-ai-runtime:1.0.0 .
#   docker build --build-arg BASE_IMAGE=nvcr.io/nvidia/l4t-base:r36.2.0 \
#                --build-arg EXTRAS=cuda -t vip-ai-runtime:1.0.0-jetson .
#
# Targets, their base images and their prerequisites are declared in targets.json — one place, so a
# new device is a data change.

ARG BASE_IMAGE=python:3.11-slim-bookworm
FROM ${BASE_IMAGE}

# `cpu` (default) · `openvino` · `cuda`. Selects the execution provider extras only; the runtime
# itself is accelerator-neutral behind the ModelAdapter seam and never branches on this.
ARG EXTRAS=cpu
ARG RUNTIME_VERSION=1.0.0

LABEL org.opencontainers.image.title="VIP AI Runtime (edge)" \
      org.opencontainers.image.version="${RUNTIME_VERSION}" \
      org.opencontainers.image.description="Perception runtime — packaged, not certified" \
      io.vip.certification="pending-validation" \
      io.vip.extras="${EXTRAS}"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # RTSP over TCP by default. UDP loses frames on any congested or wireless link, and a "flaky
    # camera" that is really a UDP problem costs days to diagnose in the field.
    OPENCV_FFMPEG_CAPTURE_OPTIONS="rtsp_transport;tcp"

# ffmpeg/OpenCV need these; the slim base has none of them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ai/inference/requirements.txt /app/requirements.txt
RUN python -m pip install --upgrade pip \
 && python -m pip install -r /app/requirements.txt \
 && if [ "$EXTRAS" = "openvino" ]; then python -m pip install "onnxruntime-openvino"; fi \
 && if [ "$EXTRAS" = "cuda" ]; then python -m pip install "onnxruntime-gpu"; fi

COPY ai/inference /app/ai/inference

# Run unprivileged. An edge box sits on a customer's network with camera credentials in its
# environment; root inside the container buys nothing and costs a great deal if the image is wrong.
RUN useradd --system --uid 10001 --home /app vip && chown -R vip:vip /app
USER vip

WORKDIR /app/ai/inference

# The runtime's own health surface, not a synthetic ping — an HTTP 200 from a process whose sessions
# are all failing is exactly the reassurance nobody needs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys;\
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8081/health',timeout=4).status==200 else 1)"

EXPOSE 8081

# tini reaps the decoder subprocesses OpenCV leaves behind; without it a long-running edge container
# accumulates zombies until it cannot fork.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "server.py"]
