# 07 — Hardware Planning & Deployment Models

---

## 1. Hardware Planning (by segment)

Sizing assumes ~10 fps analysis per camera with motion-gating, mixed models. GPU throughput is the main constraint; a Jetson Orin Nano handles ~4–8 light-model camera streams, Orin NX ~16–24, a T4/A2 dozens, per model mix.

### 1.1 Small Shop (1–4 cameras)
- **Option A (cloud):** no local compute; cameras → cloud (needs ~2–4 Mbps/cam upload). Cheapest to start.
- **Option B (edge):** **Jetson Orin Nano (8GB)** or Intel **N100/N305 mini-PC + OpenVINO**; 8–16 GB RAM; 256–512 GB SSD (local clips) + cloud for events.
- **CPU:** quad-core (mini-PC) · **GPU:** Orin Nano / iGPU (OpenVINO) · **RAM:** 8–16 GB · **Storage:** 256–512 GB SSD · **Bandwidth:** 5–10 Mbps up · **Cameras:** 2–4 MP ONVIF.

### 1.2 Medium Shop (4–8 cameras)
- **Edge:** **Jetson Orin NX (8–16GB)** or mini-PC (i5/Ryzen5 + optional RTX 3050/OpenVINO).
- **CPU:** 6-core · **GPU:** Orin NX / RTX 3050 · **RAM:** 16 GB · **Storage:** 1 TB SSD/NVMe · **Bandwidth:** 10–20 Mbps up · **Cameras:** 4–8× 2–5 MP.

### 1.3 Supermarket (16–32 cameras)
- **Edge server:** 1U/tower with **RTX A2000/4000** or 2× Jetson Orin NX; or **NVR + edge appliance**.
- **CPU:** 8–16 core Xeon/Ryzen · **GPU:** RTX A2000/A4000 (or T4) · **RAM:** 32–64 GB · **Storage:** 2–4 TB NVMe (hot clips) + NAS/cloud · **Bandwidth:** 20–50 Mbps up (hybrid: only events to cloud) · **Cameras:** 16–32× incl. checkout/entrance/shelf cams.

### 1.4 Warehouse (32–64 cameras)
- **Edge server(s):** rack server with **1–2× RTX A4000/A5000** or **T4×2**; PoE switches; ruggedized.
- **CPU:** 16–24 core · **GPU:** 1–2× A4000/A5000 · **RAM:** 64–128 GB · **Storage:** 4–8 TB NVMe + object store · **Bandwidth:** 50–100 Mbps (hybrid) · **Cameras:** 32–64 incl. gate LPR, dock, aisle, PPE zones.

### 1.5 Factory (64–128 cameras)
- **Edge cluster:** 2–3 GPU servers (**A5000/A6000** or **L4×N**), HA, redundant power/network.
- **CPU:** 24–48 core · **GPU:** multiple A5000/A6000/L4 · **RAM:** 128–256 GB · **Storage:** 8–16 TB NVMe + on-prem object store · **Bandwidth:** 100+ Mbps · **Cameras:** 64–128 incl. safety/PPE, danger-zone, thermal (fire).

### 1.6 Enterprise (256–1000+ cameras)
- **Model:** distributed **edge boxes per site** + **central cloud/on-prem GPU cluster** for aggregation, heavy/batch AI, search.
- **Per-site edge:** Orin NX / small GPU servers (16–48 cams each).
- **Core:** Kubernetes GPU cluster (**L4/L40S/A100** for batch, search embeddings, retraining); managed MongoDB (sharded), Redis cluster, object storage + CDN.
- **CPU/GPU/RAM:** scale-out; autoscaled GPU worker pools · **Storage:** tiered PB-scale object storage · **Bandwidth:** per-site 50–200 Mbps (events only upstream) · **Cameras:** 256–1000+ across sites.

### 1.7 Edge Device Reference
| Device | Approx cameras | Use |
|--------|----------------|-----|
| Jetson Orin Nano 8GB | 4–8 | small shop / few cams |
| Jetson Orin NX 16GB | 16–24 | medium shop / small store |
| Jetson AGX Orin 64GB | 32–48 | store / warehouse zone |
| Intel mini-PC + OpenVINO (N100/i5/i7) | 2–12 | CPU/iGPU edge, low cost |
| RTX A2000/A4000 server | 16–48 | supermarket/warehouse |
| RTX A5000/A6000 / L4 server | 48–128 | factory/large site |
| L40S/A100 cluster (cloud) | batch/search/train | enterprise core |

**Camera requirements:** ONVIF Profile S/T, RTSP/RTMP, H.264/H.265, ≥2 MP (≥4–5 MP for LPR/shelf/face), good low-light/IR, correct placement (angle/height) per use-case; PoE recommended.

---

## 2. Deployment Models

Same codebase; the edge/cloud split and data residency relocate per model.

### 2.1 Cloud SaaS (fully hosted)
- Cameras stream to the cloud (directly or via a lightweight local relay). All processing, storage, dashboards in PaperlessTech cloud.
- **Pros:** zero on-site compute, fastest onboarding, auto-updates, multi-site out-of-box.
- **Cons:** bandwidth cost (needs good upload), video leaves premises (mitigated by relay that sends only frames/events).
- **Best for:** small/medium businesses, multi-site retail with good connectivity.

### 2.2 On-Premise (self-hosted)
- Full stack (API, AI, DB, storage, dashboards) deployed on customer hardware/K8s; **no video leaves the site**; optional license server.
- **Pros:** data sovereignty, compliance (bank/hospital/gov), no bandwidth dependency, lowest latency.
- **Cons:** customer manages hardware; updates via controlled channel.
- **Best for:** banks, hospitals, government, high-security enterprises.

### 2.3 Hybrid (recommended default)
- **Edge** does real-time inference & recording on-site; **cloud** handles orchestration, heavy/batch AI, search, multi-site aggregation, billing, dashboards. Only **events/metadata/thumbnails/short clips** go to cloud.
- **Pros:** best cost/latency/privacy balance; resilient (edge runs if WAN drops); scalable.
- **Cons:** manage edge fleet (handled by fleet-management + OTA).
- **Best for:** most SMB→enterprise deployments.

### 2.4 Edge AI
- Inference on Jetson/OpenVINO at the camera site; TensorRT/OpenVINO/ONNX INT8 models; local ring buffer + clip store; models updated OTA from cloud registry.
- Powers hybrid & offline modes; minimizes bandwidth and keeps raw video local.

### 2.5 Offline AI (air-gapped / no internet)
- Edge box operates **fully autonomously**: local detection, rules, alerts (local siren/relay, LAN notifications, local dashboard), local clip storage. **Syncs events/clips when connectivity returns**; licensing via offline license server.
- **Best for:** remote sites, ships, construction, secure facilities, unreliable-connectivity regions.

### 2.6 Deployment Comparison
| Model | Video leaves site? | Needs local GPU? | Bandwidth | Best for |
|-------|--------------------|------------------|-----------|----------|
| Cloud SaaS | Yes (or frames only) | No | High | SMB, connected multi-site |
| On-Prem | No | Yes | Low | Regulated/high-security |
| Hybrid | Events/clips only | Yes (edge) | Medium | Most customers |
| Edge AI | No (raw) | Yes | Low | Bandwidth/privacy-sensitive |
| Offline | No | Yes | None (sync later) | Air-gapped/remote |

---

## 3. Edge Fleet Management
- **Provisioning:** zero-touch via Field Engineer app (scan/QR), device bound to tenant.
- **OTA:** model + agent updates from cloud registry with staged rollout & rollback.
- **Health:** heartbeat, GPU/CPU/temp/storage, camera status, alert on degradation.
- **Security:** signed images, encrypted local storage, mutual-TLS to cloud, remote wipe.
- **Collections:** `edgeDevices`, `edgeHealth`, `edgeDeployments`, `otaJobs`.
