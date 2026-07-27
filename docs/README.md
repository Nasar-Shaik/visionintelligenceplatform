# Documentation — Navigation Index

This directory is the **Engineering Constitution** of the PaperlessTech Vision Intelligence Platform (VIP) and the complete architecture that governs it. It is the **single source of truth**. When code and docs disagree, that is a bug in one of them — open an ADR or a task, do not silently diverge.

## Reading order

Read [`00-ENGINEERING-CONSTITUTION.md`](00-ENGINEERING-CONSTITUTION.md) first. It is the governing document — principles, laws, and the model by which every other document is composed. Then read the architecture sections in order for a full mental model, or jump by topic.

## Architecture sections

Every section follows the same template: **Purpose · Responsibilities · Architecture · Design Decisions · Advantages · Tradeoffs · Future Expansion · Cross-References.**

| #   | Document                                                                            | Topic                                                                                     |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 00  | [Engineering Constitution](00-ENGINEERING-CONSTITUTION.md)                          | Governing principles, the five laws, composition model, how to change the architecture    |
| 01  | [Executive Summary](architecture/01-EXECUTIVE-SUMMARY.md)                           | What the platform is, business goals, differentiators                                     |
| 02  | [Product Vision & Business Goals](architecture/02-PRODUCT-VISION-AND-GOALS.md)      | Vision, target industries, non-functional targets                                         |
| 03  | [Architecture & Engineering Principles](architecture/03-ARCHITECTURE-PRINCIPLES.md) | The 15 platform principles + engineering standards                                        |
| 04  | [System Overview](architecture/04-SYSTEM-OVERVIEW.md)                               | Logical, physical, component & deployment views; service communication                    |
| 05  | [Capability Architecture](architecture/05-CAPABILITY-ARCHITECTURE.md)               | **The core idea** — reusable building blocks, the capability contract, the registry       |
| 06  | [Multi-Tenant SaaS](architecture/06-MULTI-TENANT-SAAS.md)                           | Tenant hierarchy, isolation, plans, entitlements, billing, metering                       |
| 07  | [Data, Video, AI & Event Flows](architecture/07-DATA-AND-PIPELINE-FLOWS.md)         | End-to-end pipeline; video/AI/inference/event/rule/workflow/alert/evidence flows          |
| 08  | [AI / ML Platform](architecture/08-AI-ML-PLATFORM.md)                               | Model & dataset registry, training, MLOps, runtimes, deployment, model-agnosticism        |
| 09  | [Event Platform](architecture/09-EVENT-PLATFORM.md)                                 | Taxonomy, catalog, lifecycle, correlation, dedup, storage, replay, streaming, timeline    |
| 10  | [Rule Engine](architecture/10-RULE-ENGINE.md)                                       | Rule DSL, builder, conditions, temporal/spatial rules, actions, rule packs                |
| 11  | [Workflow Engine](architecture/11-WORKFLOW-ENGINE.md)                               | Incident/case management, escalation, approvals, operator actions, audit                  |
| 12  | [Evidence Management](architecture/12-EVIDENCE-MANAGEMENT.md)                       | Clips, snapshots, timelines, annotations, export, retention, legal hold, chain of custody |
| 13  | [Industry Packs (Plugins)](architecture/13-INDUSTRY-PACKS.md)                       | The plugin model that keeps the core generic                                              |
| 14  | [Edge Platform](architecture/14-EDGE-PLATFORM.md)                                   | Edge agent, discovery, provisioning, offline mode, OTA, fleet management                  |
| 15  | [Security Architecture](architecture/15-SECURITY-ARCHITECTURE.md)                   | OAuth/OIDC, RBAC/ABAC, encryption, secrets, audit, GDPR/HIPAA/SOC2/ISO                    |
| 16  | [Observability](architecture/16-OBSERVABILITY.md)                                   | Metrics, tracing, logging, health, dashboards, alerting, capacity                         |
| 17  | [DevOps & Infrastructure](architecture/17-DEVOPS-AND-INFRA.md)                      | Docker/K8s/Helm/Terraform/CI-CD, blue-green, canary, DR                                   |
| 18  | [Data Architecture](architecture/18-DATA-ARCHITECTURE.md)                           | MongoDB, Redis, object storage, time-series, search, vector, tiering                      |
| 19  | [Performance & Scale](architecture/19-PERFORMANCE-AND-SCALE.md)                     | 2 → 10,000 cameras; scaling strategy per tier                                             |
| 20  | [Extensibility & Plugin SDK](architecture/20-EXTENSIBILITY.md)                      | Extension points, hooks, DI, versioning, forward compatibility                            |
| 21  | [API Architecture](architecture/21-API-ARCHITECTURE.md)                             | REST/WS/streaming/gRPC, versioning, auth flows, developer platform                        |
| 22  | [Bounded Contexts (DDD)](architecture/22-BOUNDED-CONTEXTS.md)                       | Explicit domain boundaries, owned data, published/subscribed events per context           |
| 23  | [Service Ownership & Dependency Graph](architecture/23-SERVICE-OWNERSHIP.md)        | Per-service ownership catalog + acyclic dependency graph                                  |
| 24  | [Capability Composition Framework](architecture/24-COMPOSITION-FRAMEWORK.md)        | The reusable Composition Layer (people counting, queue, occupancy…)                       |
| 25  | [Connector Platform](architecture/25-CONNECTOR-PLATFORM.md)                         | External-system integration (POS/ERP/access/MQTT/Modbus…) as plugins                      |
| 26  | [Digital Twin](architecture/26-DIGITAL-TWIN.md)                                     | Live spatial model for visualization & cross-camera reasoning                             |
| 27  | [Control Plane / Data Plane](architecture/27-CONTROL-DATA-PLANE.md)                 | Separation of business management from video/AI processing                                |
| 28  | [Policy Engine](architecture/28-POLICY-ENGINE.md)                                   | Governance (who/what/where/when) — distinct from the Rule Engine                          |

> Sections 22–26 / ADRs 0006–0010 came from the **Enterprise Architecture Review** (2026-07-26). Sections 27–28 / ADRs 0011–0015 came from the **Final Architecture Enhancement** (2026-07-27) that froze the architecture as **v1.0**. All preserve the existing philosophy.

## Freeze status

**Architecture Version 1.0 — FROZEN (2026-07-27).** See the [Architecture Implementation Readiness Review](ARCHITECTURE-READINESS-REVIEW.md) (Go/No-Go: ✅ GO). After freeze, **every architectural change requires an ADR** ([adr/](adr/)).

## Reference

| Document                                                    | Topic                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [AI Capability Catalog](reference/AI-CAPABILITY-CATALOG.md) | The 60+ vision capabilities as reusable, model-agnostic building blocks             |
| [Model Reference](reference/MODEL-REFERENCE.md)             | Per-capability datasets, accuracy targets, and placement (registry starting points) |
| [Hardware Sizing](reference/HARDWARE-SIZING.md)             | Edge/cloud sizing per scale, device matrix, camera requirements, deployment models  |
| [Dev Environment](reference/DEV-ENVIRONMENT.md)             | Local GPU pipeline stack, toolchain, zero-copy ingest, E2E test setup               |
| [Glossary](reference/GLOSSARY.md)                           | Canonical vocabulary — use these terms everywhere                                   |
| [Tech Stack](reference/TECH-STACK.md)                       | Ratified technologies and the rationale for each                                    |

## Decisions

[`adr/`](adr/) holds **Architecture Decision Records** — immutable, append-only, numbered. Any decision that changes a contract, a boundary, a technology, or a principle **must** be recorded as an ADR. See [`adr/README.md`](adr/README.md).

## How this document set is maintained

- **Architecture (`docs/`) changes** only through an ADR. The ADR is written first; the affected sections are then edited to match, and the ADR is linked from them.
- **Project state (`tracking/`) changes** continuously as work proceeds — it is expected to be edited every working session.
- Keep prose **dense and technical**. This is a reference, not a narrative.
