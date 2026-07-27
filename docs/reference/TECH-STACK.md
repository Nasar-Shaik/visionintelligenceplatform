# Reference — Ratified Tech Stack

> The technologies chosen for the platform and why. Changing any of these requires an ADR. Choices favor **model/vendor-agnosticism, horizontal scale, and deploy-anywhere** over any single-vendor convenience.

## Backend / services

| Concern           | Choice                                                                                | Rationale                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service framework | **Node.js + Fastify + TypeScript** (control/data plane), **Python + FastAPI** (AI/ML) | Fastify: native TS + JSON-Schema validation (contract-first); FastAPI for the CV/ML ecosystem. [ADR-0017](../adr/ADR-0017-fastify-control-plane.md) |
| Internal RPC      | **NATS request-reply** (default), **gRPC + Protobuf** where heavy typed calls warrant | Lightweight over the same backbone; gRPC optional                                                                                                   |
| Public API        | **REST/HTTP + OpenAPI 3.1** (generated), WebSocket, webhooks                          | Standard, documented, SDK-generable                                                                                                                 |
| Schema/validation | **Zod → JSON Schema/OpenAPI**; Protobuf for gRPC/edge                                 | Schema-first, single source, generated types                                                                                                        |
| Async jobs        | **BullMQ (Redis)** / worker pools                                                     | Clip transcode, embeddings, reports, retention, OTA                                                                                                 |

## Data

| Concern           | Choice                                                   | Rationale                                                                                                             |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| OLTP              | **MongoDB** (sharded by tenant)                          | Flexible evolving event/attribute schema; horizontal sharding                                                         |
| Cache/state/queue | **Redis** (cluster)                                      | Sessions, entitlements, rule state, rate limits                                                                       |
| Event backbone    | **NATS + JetStream** (cloud), NATS **leaf nodes** (edge) | Durable, replayable streams; lightweight edge-first fit. [ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md) |
| Object storage    | **S3 / MinIO / Azure Blob**                              | Clips, models, datasets, exports; tiered; signed URLs                                                                 |
| Time-series       | Timescale/Influx/Mongo-TS                                | Aggregates, metrics                                                                                                   |
| Search + vector   | Search engine + **Qdrant/Milvus/Atlas Vector**           | Structured + semantic/NL event search                                                                                 |

## AI / ML

| Concern            | Choice                                                                    | Rationale                                              |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| Training           | **PyTorch** (primary), TF where needed                                    | Ecosystem, CV model availability                       |
| Inference runtimes | **ONNX Runtime, TensorRT, OpenVINO**, CPU; **Triton** (cloud serving)     | Model/accelerator-agnostic, edge+cloud                 |
| CV libs            | OpenCV, YOLO family, MediaPipe, ByteTrack/DeepSORT, ArcFace, CLIP, PARSeq | Best-in-class per task; all behind capability contract |
| Registry           | **MLflow**-class + **DVC/lakeFS** (datasets)                              | Versioning, lineage, promotion                         |
| Orchestration      | Kubeflow/Airflow/Prefect                                                  | Continuous training pipelines                          |
| Media              | **FFmpeg/GStreamer**, WebRTC, HLS; NVDEC/VAAPI decode                     | Ingest/transcode/live/playback, HW-accelerated         |

## Frontend / mobile

| Concern | Choice                                                             | Rationale                                            |
| ------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| Web     | **React + TypeScript + Vite + Tailwind + Shadcn + TanStack Query** | Modern, fast, typed; feature-gated UI                |
| Mobile  | **React Native (Expo)**                                            | Shared core, offline queue, push, white-label builds |
| State   | Zustand + TanStack Query                                           | Simple, cache-first                                  |

## Infra / DevOps

| Concern       | Choice                                                           | Rationale                        |
| ------------- | ---------------------------------------------------------------- | -------------------------------- |
| Containers    | **Docker** (multi-stage, distroless, non-root, signed)           | Reproducible, secure             |
| Orchestration | **Kubernetes** (cloud/on-prem via k3s), **k3s/balena** (edge)    | Portable scale + fleet           |
| Packaging     | **Helm** (per service + umbrella per mode)                       | Deploy-anywhere via values       |
| IaC           | **Terraform**                                                    | Reproducible cloud, multi-region |
| CI/CD         | **GitHub Actions**                                               | Build/test/scan/model-CI/deploy  |
| Deploy        | Blue-green (control), canary (data/AI/models), staged OTA (edge) | Reversible                       |

## Security / observability

| Concern           | Choice                                                  | Rationale                             |
| ----------------- | ------------------------------------------------------- | ------------------------------------- |
| AuthN/Z           | OAuth2/OIDC, JWT, SAML/SCIM, RBAC+ABAC                  | Enterprise + regulated                |
| Secrets/keys      | Vault / cloud KMS, per-tenant data keys, rotation       | Isolation, compliance                 |
| Observability     | **OpenTelemetry**, Prometheus/Grafana, Loki/ELK, Sentry | Metrics/traces/logs across cloud+edge |
| Security scanning | Semgrep (SAST), ZAP (DAST), Trivy (images), gitleaks    | CI-enforced                           |

## Repository / build

| Concern   | Choice                                                 | Rationale                                 |
| --------- | ------------------------------------------------------ | ----------------------------------------- |
| Monorepo  | **pnpm + Turborepo** (TS), Python packages under `ai/` | Shared contracts, fast incremental builds |
| Contracts | `packages/contracts` (schema-first, generated types)   | Single integration source                 |

> Every choice is behind a contract/abstraction where it crosses a boundary, so a future swap (e.g. Kafka→Pulsar, Mongo→another engine, YOLO→DETR) is an ADR + adapter change, not a rewrite.
