# 17 — DevOps & Infrastructure

## Purpose

Define Docker, Kubernetes, Helm, Terraform, CI/CD, deployment strategies (blue-green, canary), autoscaling, disaster recovery, and backup/restore. Operationalizes Principles 8 and 15 (cloud-native, production-ready & reversible).

## Responsibilities

- Provide reproducible build, package, provision, deploy, scale, and recover processes for cloud, on-prem, hybrid, and edge.

---

## 1. Containerization

- **Docker** for every service (multi-stage builds, non-root, distroless/minimal base, signed images). One image per service; config via environment. GPU images built on CUDA/TensorRT or OpenVINO bases for AI/edge.
- Local dev via **Docker Compose** (Mongo, Redis, MinIO, streaming, RTSP test source) mirroring prod topology.

## 2. Orchestration

- **Kubernetes** for cloud (and on-prem via k3s/RKE). GPU node pools (scheduling via NVIDIA device plugin), CPU pools for stateless services, separate pools for streaming and workers.
- **Helm** charts per service + umbrella chart per deployment mode (cloud/on-prem/hybrid). Edge uses lightweight orchestration (k3s / balena-class) managed by the fleet service ([14](14-EDGE-PLATFORM.md)).

## 3. Infrastructure as Code

- **Terraform** for all cloud resources (K8s, GPU nodes, DB, object storage, streaming, DNS, CDN, KMS, networking). Environments (dev/staging/prod, per region) are code; no click-ops. On-prem gets a packaged installer + Helm values.

## 4. CI/CD

- **GitHub Actions** pipelines: build → unit/contract/integration tests → SAST/DAST/dependency/secret/image scans → **model CI** (benchmark + FP/FN gates for AI changes, [08 §5](08-AI-ML-PLATFORM.md)) → publish signed images/charts → deploy.
- **Import-graph & contract checks** enforce Constitution §6 (no core→plugin, no capability internals coupling). Trunk-based with short-lived branches; every merge is releasable.

## 5. Deployment strategies

- **Blue-green** for control-plane services (instant cutover + rollback).
- **Canary** for data-plane/AI services and models (progressive traffic, health-gated, auto-rollback). → [08 §6](08-AI-ML-PLATFORM.md)
- **Staged OTA** for edge fleet ([14 §7](14-EDGE-PLATFORM.md)).
- Every deploy has a defined, tested **rollback**; migrations are backward-compatible (expand/contract).

## 6. Autoscaling

- **HPA** on stateless services (CPU/RPS/latency); **queue-depth-based** scaling for workers; **GPU worker pools** scale on inference queue depth; **cluster autoscaler** for nodes. Scale floors/ceilings + budget alerts per environment. → [19](19-PERFORMANCE-AND-SCALE.md)

## 7. Disaster recovery

- Defined **RPO/RTO** per data class (audit/evidence stricter). Multi-AZ by default; **multi-region** DR for enterprise. Regular **DR drills** (restore + failover) are a milestone gate. Chaos testing (node/GPU/worker/storage/WAN failures) validates graceful degradation and no data loss.

## 8. Backup & restore

- Automated backups: OLTP (point-in-time), object storage (versioning + cross-region replication), configuration/registry, and edge local state. **Restore is tested**, not assumed — a restore drill is part of the production checklist ([../../tracking/MILESTONES.md](../../tracking/MILESTONES.md)).

## Design decisions

- **One codebase, many deployment modes via Helm/Terraform values** keeps deploy-anywhere honest.
- **Everything reversible** (blue-green/canary/OTA/migrations) makes frequent, safe delivery possible.
- **Model CI as a first-class gate** treats models with the same rigor as code.

## Advantages

- Reproducible, auditable infrastructure; fast, safe releases; portable across cloud/on-prem/edge.

## Tradeoffs

- Supporting cloud + on-prem + edge multiplies packaging/testing effort; contained by sharing images/charts and differing only in values.

## Future expansion

- GitOps (Argo/Flux), progressive delivery controllers (Argo Rollouts/Flagger), policy-as-code (OPA/Gatekeeper), FinOps automation, multi-region active-active control plane.

## Cross-references

[14-EDGE-PLATFORM](14-EDGE-PLATFORM.md) · [16-OBSERVABILITY](16-OBSERVABILITY.md) · [18-DATA-ARCHITECTURE](18-DATA-ARCHITECTURE.md) · [19-PERFORMANCE-AND-SCALE](19-PERFORMANCE-AND-SCALE.md)
