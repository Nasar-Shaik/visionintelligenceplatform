# Reference — Hardware Sizing & Deployment Models

> Sizing guidance for edge/cloud compute per deployment scale, the edge-device reference matrix, camera requirements, and the five deployment models. Complements [14-EDGE-PLATFORM](../architecture/14-EDGE-PLATFORM.md), [17-DEVOPS-AND-INFRA](../architecture/17-DEVOPS-AND-INFRA.md), and [19-PERFORMANCE-AND-SCALE](../architecture/19-PERFORMANCE-AND-SCALE.md).

**Basis:** ~10 fps analysis per camera with motion-gating and a mixed capability set. GPU inference throughput is the binding constraint; actual capacity varies with enabled capabilities, resolution, and FPS ([19 §6 cost model](../architecture/19-PERFORMANCE-AND-SCALE.md)). Treat these as **planning starting points**, validated per site.

## 1. Sizing by scale

| Scale | Cameras | Compute | RAM | Storage (hot) | Upstream bandwidth |
|---|---|---|---|---|---|
| **Small shop** | 1–4 | Jetson Orin Nano 8GB, or Intel N100/N305 mini-PC + OpenVINO; *or* cloud-only | 8–16 GB | 256–512 GB SSD | 5–10 Mbps |
| **Medium shop** | 4–8 | Jetson Orin NX 8–16GB, or i5/Ryzen5 + RTX 3050/OpenVINO | 16 GB | 1 TB NVMe | 10–20 Mbps |
| **Supermarket** | 16–32 | Edge server w/ RTX A2000/A4000 (or T4), or 2× Orin NX | 32–64 GB | 2–4 TB NVMe + NAS/cloud | 20–50 Mbps (events/clips only) |
| **Warehouse** | 32–64 | Rack server 1–2× RTX A4000/A5000 or T4×2; PoE switches | 64–128 GB | 4–8 TB NVMe + object store | 50–100 Mbps |
| **Factory** | 64–128 | Edge cluster 2–3 GPU servers (A5000/A6000 or L4×N), HA | 128–256 GB | 8–16 TB NVMe + on-prem object store | 100+ Mbps |
| **Enterprise** | 256–1000+ | Distributed edge per site (Orin NX/small GPU servers, 16–48 cams each) + central K8s GPU cluster (L4/L40S/A100) for batch/search/retrain | scale-out | tiered PB-scale object storage | 50–200 Mbps per site (events only) |

**Enterprise core** runs a Kubernetes GPU cluster for batch inference, search embeddings, and retraining, with sharded MongoDB, Redis cluster, object storage + CDN, and autoscaled GPU worker pools ([19 §3](../architecture/19-PERFORMANCE-AND-SCALE.md)).

## 2. Edge-device reference matrix

| Device | Approx. cameras | Typical use |
|---|---|---|
| Jetson Orin Nano 8GB | 4–8 | Small shop / few cams |
| Jetson Orin NX 16GB | 16–24 | Medium shop / small store |
| Jetson AGX Orin 64GB | 32–48 | Store / warehouse zone |
| Intel mini-PC + OpenVINO (N100/i5/i7) | 2–12 | Low-cost CPU/iGPU edge |
| RTX A2000/A4000 server | 16–48 | Supermarket / warehouse |
| RTX A5000/A6000 / L4 server | 48–128 | Factory / large site |
| L40S/A100 cluster (cloud) | batch/search/train | Enterprise core |

## 3. Camera requirements
- **Protocols:** ONVIF Profile S/T, RTSP/RTMP; **codecs:** H.264/H.265.
- **Resolution:** ≥2 MP general; **≥4–5 MP** for LPR, shelf/planogram, and face capabilities.
- **Conditions:** good low-light/IR performance; correct placement (angle/height) per capability.
- **Power/network:** PoE recommended; on-prem camera VLAN segmentation ([15 §8](../architecture/15-SECURITY-ARCHITECTURE.md)).

## 4. Deployment models (same codebase; placement/residency differ — [ADR-0004](../adr/ADR-0004-edge-first-placement.md))

| Model | Video leaves site? | Local GPU? | Bandwidth | Best for |
|---|---|---|---|---|
| **Cloud SaaS** | Yes (or frames-only via relay) | No | High | SMB, connected multi-site |
| **On-Prem** | No | Yes | Low | Banks, hospitals, government, high-security |
| **Hybrid (default)** | Events/clips only | Yes (edge) | Medium | Most SMB→enterprise |
| **Edge AI** | No (raw stays local) | Yes | Low | Bandwidth/privacy-sensitive |
| **Offline / air-gapped** | No | Yes | None (sync later) | Remote sites, ships, construction, secure facilities |

- **Hybrid (recommended default):** edge does real-time inference + recording; cloud does orchestration, heavy/batch AI, search, multi-site aggregation, billing, dashboards — only events/metadata/thumbnails/short clips travel upstream.
- **Offline:** edge operates autonomously (local detection, rules, alerts via siren/relay/LAN, local dashboard, local clip store) and reconciles on reconnect; licensing via offline license server ([14 §5](../architecture/14-EDGE-PLATFORM.md)).

## Cross-references
[14-EDGE-PLATFORM](../architecture/14-EDGE-PLATFORM.md) · [17-DEVOPS-AND-INFRA](../architecture/17-DEVOPS-AND-INFRA.md) · [19-PERFORMANCE-AND-SCALE](../architecture/19-PERFORMANCE-AND-SCALE.md) · [reference/TECH-STACK](TECH-STACK.md)
