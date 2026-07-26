# 09 — MLOps, Security & Performance

---

## 1. MLOps

The closed loop that keeps 60+ models accurate across thousands of diverse sites.

### 1.1 Model Training
- Training scripts (PyTorch/TF) per model family; reproducible configs; mixed-precision; multi-GPU (DDP).
- Base models + **per-site/per-vertical fine-tuning** on customer-consented data.
- Augmentation for CCTV realism: low-light/IR, motion blur, weather, angle/perspective, occlusion, resolution jitter.
- **Auto-labeling + human-in-the-loop:** pre-label with strong models, correct via labeling tool; active-learning prioritizes uncertain/false cases.

### 1.2 Dataset Management
- **DVC / lakeFS** versioned datasets in object storage; lineage from raw → labeled → splits.
- **Datasets & versions** in registry (`datasets`, `datasetVersions`); consent/licensing metadata per source; PII handling & anonymization.
- Balanced/curated benchmark sets per detection for regression testing; synthetic data generation where scarce (weapons, fire, plates).

### 1.3 Model Versioning & Registry
- **MLflow / model registry** (`models`, `modelVersions`, `modelMetrics`): every model versioned with metrics, dataset lineage, training config, and **multi-artifact exports** (PyTorch → ONNX → TensorRT/OpenVINO INT8 for edge).
- Semantic model versions; per-tenant/per-camera assignment (`modelAssignments`); staged promotion (dev→shadow→canary→prod).

### 1.4 Continuous Training (CT)
- Pipelines (Kubeflow/Airflow/Prefect) triggered by: new labeled data volume, drift alerts, or schedule.
- Ingest field-flagged FP/FN → relabel → retrain → validate against benchmarks → gate on metric thresholds → register.
- **Edge OTA:** quantize, package, staged rollout to edge fleet with rollback.

### 1.5 A/B Testing & Shadow Deployment
- **Shadow:** new model runs alongside prod on live streams, logs predictions without acting → compare precision/recall/FP rate.
- **A/B / canary:** route a % of cameras/tenants to the new model; compare event quality + customer feedback; auto-rollback on regression.

### 1.6 Monitoring
- **Model monitoring:** per-model precision/recall proxies, FP/FN rates (from acknowledgments & customer flags), confidence distributions, **data drift** (input distribution shift per site), latency/throughput, GPU utilization.
- **Alerting** on accuracy degradation, drift, or latency SLO breach → trigger investigation/retrain.
- `driftReports`, `abTests`, `modelMetrics` collections; dashboards for MLOps.

### 1.7 Deployment
- **Serving:** Triton/ONNX Runtime/TensorRT servers (cloud), edge agent (Jetson/OpenVINO) for local inference.
- **CI for models:** every model change runs benchmark suite + FP/FN gates in CI before registry promotion.
- **Rollback:** any model version instantly re-pinnable per tenant/camera.

### 1.8 MLOps Loop (summary)
```
Field data → flag FP/FN → auto-label + review → dataset version →
train → validate (benchmarks + FP/FN gates) → register →
shadow → canary/A-B → promote → OTA to edge → monitor → (drift) → repeat
```

---

## 2. Security

### 2.1 Encryption
- **In transit:** TLS 1.3 everywhere (APIs, streams via SRTP/DTLS for WebRTC, edge↔cloud mutual-TLS).
- **At rest:** AES-256 for DB, object storage (clips), and edge local storage; **per-tenant KMS data keys** (envelope encryption) for clips/PHI.
- **Signed URLs** (short-lived) for all media/clip access; **field-level encryption** for sensitive attributes (faces, plates, credentials).

### 2.2 Authentication
- JWT access + rotating refresh (reuse detection), MFA, SSO/OIDC/SAML + SCIM (Enterprise), passkeys (roadmap), secure token storage + biometric on mobile, device/session management.

### 2.3 Authorization
- RBAC + fine-grained permissions + scoping (camera-group→branch→tenant) → row-level `tenantId` isolation, enforced on REST/WS/stream. Least-privilege defaults; privileged actions audited.

### 2.4 Audit Logs
- Immutable, append-only audit of every sensitive action: video/clip access, exports, rule changes, enrollment (face/plate), permission changes, config, logins. Tamper-evident (hash-chaining) option; exportable for compliance; SIEM streaming.

### 2.5 Privacy (privacy-by-design)
- **On-device face/plate blurring** for non-consented subjects; **pose-only / anonymized modes** (no RGB retained) for sensitive areas (hospitals).
- **Consent management** for enrollment/FR; **camera privacy masking** (permanent redaction zones, e.g., neighboring property, restrooms).
- **Data minimization:** store events/clips, not continuous video; auto-expiry.
- **Purpose limitation & access policies:** who can view which cameras/clips, with reason logging.

### 2.6 GDPR
- Lawful basis + consent records; **DSAR** (access/export/erasure) tooling; right-to-erasure with irreversible anonymization while preserving audit integrity; data residency (regional deployment); DPA templates; retention limits; processor/sub-processor register; breach-notification workflow.

### 2.7 HIPAA Considerations (hospitals)
- BAA support; PHI minimization (avoid capturing/storing identifiable patient video where possible; pose-only mode); strict access controls + audit; encryption; on-prem/hybrid option to keep video on-site; configurable retention; workforce access reviews.

### 2.8 Video Access Policies & Data Retention
- Granular policies: which roles/users can live-view, playback, download, export per camera/zone; **reason-for-access** prompts; time-boxed access; **legal hold**; watermarked exports with chain-of-custody; per-plan/per-camera retention with automated deletion and verifiable purge.

### 2.9 Platform Security
- Pen-testing, SAST/DAST, dependency & image scanning, secrets vault + rotation, WAF, rate limiting, network segmentation (camera VLANs on-prem), signed edge images + remote wipe, hardened containers (non-root, distroless).

---

## 3. Performance & Scaling (1 → 1000+ Cameras)

The core constraint is **GPU inference throughput** and **stream fan-out**. Strategy: push inference to the **edge**, keep cloud **stateless & horizontally scalable**, and store **events not video**.

### 3.1 Per-scale strategy
| Scale | Compute strategy | Data/infra |
|-------|------------------|-----------|
| **1 camera** | Single edge box (Orin Nano) or cloud worker; 1 pipeline | single-node Mongo/Redis/MinIO or cloud shared |
| **4 cameras** | 1 edge box; batched inference; motion-gating | shared cloud tenant DB |
| **16 cameras** | Edge server (RTX A2000) or 2 Jetsons; model sharing across streams | Redis cache, object store; hybrid sync |
| **64 cameras** | 1–2 GPU servers; per-camera FPS/model tuning; worker pool | sharded-ready Mongo; dedicated worker queue |
| **256 cameras** | Multi-edge per site + cloud GPU pool; autoscaled workers | MongoDB sharding by tenant; Redis cluster; CDN for HLS |
| **1000+ cameras** | Distributed edge fleet + K8s GPU cluster (L4/L40S/A100) for batch/search/train; multi-region | PB object storage tiered; read replicas + materialized read models; global control plane, regional data planes |

### 3.2 Scaling techniques
- **Motion-gated adaptive sampling** — analyze only frames that matter (biggest efficiency lever).
- **Model sharing & batching** — one model instance serves many camera streams via GPU batching.
- **Edge offload** — real-time inference on-site; only events/clips to cloud (bandwidth + cloud-GPU savings).
- **Stateless API + HPA autoscaling**; **GPU worker pools** autoscaled on queue depth.
- **Stream fan-out** via HLS/CDN for many viewers; WebRTC SFU for live walls.
- **Sharded MongoDB** (`tenantId`), **Redis cluster**, **vector DB** scaled per namespace.
- **Materialized read models** (change streams) for dashboards; heavy analytics off replicas.
- **Tiered storage** + smart-clip-only → linear storage cost control.
- **Multi-region** for residency + latency; **edge fleet management** for thousands of boxes.
- **Backpressure & graceful degradation** — under load, drop to lower FPS / defer non-critical models before dropping frames for critical (fire/weapon).

### 3.3 Capacity model
Per-camera cost is modeled as `f(models enabled, FPS, resolution, edge vs cloud)`. Edge-heavy hybrid keeps **cloud GPU cost near-zero per camera** (only batch/search), enabling aggressive per-camera pricing. Autoscale floors/ceilings + budget alerts per environment; right-size from telemetry.
