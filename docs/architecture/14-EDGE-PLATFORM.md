# 14 — Edge Platform

## Purpose
Define the edge computing platform: the edge agent, camera discovery, provisioning, health, offline operation, OTA updates, and fleet management. Operationalizes Principles 9–10 (edge-first, offline-capable).

## Responsibilities
- Run the same capability contracts locally, autonomously, and offline.
- Discover, provision, and monitor cameras and edge devices.
- Sync with the cloud (store-and-forward), receive OTA updates, and be managed at fleet scale.

---

## 1. Edge agent

A containerized runtime (`edge/agent`) deployed on Jetson (Orin Nano/NX/AGX), Intel mini-PC (OpenVINO), or GPU server. It runs: local **ingest → decode → frame-extract → capability DAG → event platform (embedded log) → rule engine → evidence (ring buffer + local store)**, plus a **sync client** and **OTA client**. It is **tenant-bound** (one tenant per box), encrypts local storage, and enforces the same tenant context as the cloud.

**Key property:** the agent runs the **same capability implementations and contracts** as the cloud; placement ([05 §4](05-CAPABILITY-ARCHITECTURE.md)) decides what runs here. Real-time/safety-critical capabilities run at the edge so they keep working with no WAN.

## 2. Camera discovery & onboarding

- **ONVIF** discovery (WS-Discovery) auto-finds cameras; manual **RTSP/RTMP** add supported; credentials stored in a local vault. Capture profile (resolution/FPS/codec/PTZ). "Add a camera and see live in < 60s" is a target. → [07](07-DATA-AND-PIPELINE-FLOWS.md)
- Camera compatibility DB (tested models) reduces onboarding friction.

## 3. Device provisioning & identity

- Each edge device has a hardware-rooted identity (TPM/secure element where available); provisioned via a signed enrollment token binding it to a tenant/site.
- Mutual-TLS between edge and cloud; per-device certificates rotated automatically.

## 4. Health & heartbeat

- Periodic **heartbeat** (device + per-camera health, temperature, GPU/CPU/mem/disk, stream status, model versions). Missing heartbeat → **camera/device-offline** event + alert. Auto-reconnect for dropped streams.

## 5. Offline mode (autonomy)

- On WAN loss the edge continues **full local operation**: inference, rules, evidence, and local alerting (relay/siren, LAN notifications). Events/evidence buffer in the **embedded durable log + local object store**.
- On reconnect: **store-and-forward** reconciliation syncs buffered events/evidence upstream with **idempotent** replay and defined conflict resolution (event IDs are globally unique; last-writer rules for config). No data loss is a hard requirement, verified by chaos tests.

## 6. Configuration sync

- Config (assigned capabilities, rules, zones, thresholds, model selectors, retention) is authored in the cloud and **synced down**; the edge caches the last-known-good and keeps running on it during outages. Layered config precedence per [06 §6](06-MULTI-TENANT-SAAS.md).

## 7. OTA updates

- **Agent** and **model** updates delivered OTA: signed artifacts, **staged rollout** (canary devices → cohort → fleet), health-gated promotion, and **automatic rollback** on failure. Models quantized (INT8) for the target accelerator before packaging. → [08 §6](08-AI-ML-PLATFORM.md)
- Updates are atomic (A/B partitions or container swap) so a bad update cannot brick a device.

## 8. Remote management & fleet management

- **Fleet service** (`services/fleet`) manages thousands of devices: inventory, grouping, config push, OTA campaigns, health dashboards, remote restart, log pull, and **remote wipe** (for lost/stolen/decommissioned devices).
- Fleet operations are tenant-scoped, RBAC-controlled, and audited.

## Design decisions
- **Same contracts at edge and cloud** ([ADR-0004](../adr/ADR-0004-edge-first-placement.md)) is what makes deploy-anywhere real and avoids a second codebase.
- **Embedded durable log + store-and-forward** gives true offline autonomy with deterministic reconciliation.
- **Signed, staged, rollback-able OTA** makes managing a large fleet safe.

## Advantages
- Real-time latency and privacy (video needn't leave the premises); bandwidth/cloud-GPU cost minimized.
- Resilience: sites keep working through outages.
- One engineering effort serves cloud and edge.

## Tradeoffs
- Fleet management, OTA, and offline reconciliation are significant complexity; unavoidable for an edge-first platform and contained in `edge/` + `services/fleet`.
- Heterogeneous edge hardware requires a supported-device matrix and per-target model builds.

## Future expansion
- Edge clustering (multi-box sites sharing load), edge-to-edge re-ID, on-device federated fine-tuning, support for new accelerators and sensor gateways.

## Cross-references
[05-CAPABILITY-ARCHITECTURE](05-CAPABILITY-ARCHITECTURE.md) · [07-DATA-AND-PIPELINE-FLOWS](07-DATA-AND-PIPELINE-FLOWS.md) · [08-AI-ML-PLATFORM](08-AI-ML-PLATFORM.md) · [17-DEVOPS-AND-INFRA](17-DEVOPS-AND-INFRA.md) · [19-PERFORMANCE-AND-SCALE](19-PERFORMANCE-AND-SCALE.md)
