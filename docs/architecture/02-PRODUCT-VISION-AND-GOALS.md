# 02 — Product Vision & Business Goals

## Purpose

Establish the durable "why" and the measurable targets that constrain every architectural decision. When a design tradeoff is unclear, resolve it in favor of these goals.

## Responsibilities of this document

- Define the product vision and the customer segments/industries it must serve.
- Fix the non-functional requirements (NFRs) that the architecture must satisfy at every scale.
- Provide the acceptance envelope for "is the platform meeting its promise."

## Vision

> Make any camera intelligent, and make that intelligence **composable**. Give any organization — a single shop or a 10,000-camera enterprise — a system that watches continuously, understands what matters _to them_, acts through their own workflows, and produces searchable events, instant alerts, defensible evidence and clear analytics — while letting partners extend it for industries we have never seen.

The platform's success is measured by how many solutions can be built **without changing the core**.

## Target industries (served by plugins, not core)

Retail · Supermarket · Small shop · Warehouse · Manufacturing · Logistics · Office · Construction · Banking · Government · Smart City · Parking · Apartment/Residential · Hotel · Hospital · School. This list is **open-ended by design** — the architecture must accept an industry not on this list with only a new plugin.

## Target customers

- **SMB** (1–few cameras): self-serve, plug-and-play.
- **Multi-site operators** (chains, franchises): centralized, scoped, rolled-up.
- **Enterprise security & operations** (regulated, SOC-integrated, compliance-heavy).
- **System integrators / MSPs / OEMs**: white-label, resell, and publish plugins/models.

## Business goals

1. Deliver **sellable increments continuously** — the roadmap ([../../tracking/ROADMAP.md](../../tracking/ROADMAP.md)) ships value each phase, not only at the end.
2. **Camera-based recurring revenue** with high gross margin via edge offload and smart-clip storage.
3. **Capability breadth** (60+ vision capabilities) monetized as entitlement-gated packs.
4. **Vertical velocity**: a new Industry Pack is a configuration/plugin effort, measured in days, not a code fork.
5. **Ecosystem**: partner-published capabilities, models and Industry Packs through a marketplace.
6. **Regulated-market readiness**: bank/hospital/government via isolation, residency, on-prem/hybrid, and compliance tooling.

## Non-functional requirements (the architecture's hard constraints)

| Area                          | Target                                                               | Enforced by                                                            |
| ----------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Control-plane availability    | 99.9% (99.99% enterprise option)                                     | HA, multi-AZ, [17-DEVOPS](17-DEVOPS-AND-INFRA.md)                      |
| Edge autonomy                 | Full local operation during WAN outage; reconcile on reconnect       | [14-EDGE-PLATFORM](14-EDGE-PLATFORM.md)                                |
| Real-time detection latency   | < 300 ms frame→event (edge, real-time capabilities)                  | [07](07-DATA-AND-PIPELINE-FLOWS.md), [19](19-PERFORMANCE-AND-SCALE.md) |
| Alert latency                 | < 3 s event→notification (critical)                                  | [09](09-EVENT-PLATFORM.md), [11](11-WORKFLOW-ENGINE.md)                |
| Scale                         | 2 → 10,000+ cameras/tenant; 100k+ platform-wide                      | [19-PERFORMANCE-AND-SCALE](19-PERFORMANCE-AND-SCALE.md)                |
| Storage efficiency            | ≥ 90% reduction vs continuous recording                              | [12-EVIDENCE](12-EVIDENCE-MANAGEMENT.md)                               |
| Safety-critical model quality | ≥ 95% recall on fire/weapon/fall; high precision via 2-stage confirm | [08-AI-ML-PLATFORM](08-AI-ML-PLATFORM.md)                              |
| Tenant isolation              | Provable; automated cross-tenant tests must fail-closed              | [06](06-MULTI-TENANT-SAAS.md), [15](15-SECURITY-ARCHITECTURE.md)       |
| Security                      | TLS 1.3, AES-256 at rest, per-tenant KMS, signed media URLs          | [15-SECURITY](15-SECURITY-ARCHITECTURE.md)                             |
| Compliance                    | GDPR, HIPAA-aware, SOC 2, ISO 27001; regional residency              | [15-SECURITY](15-SECURITY-ARCHITECTURE.md)                             |
| Observability                 | Every service: metrics, traces, logs, health, SLOs                   | [16-OBSERVABILITY](16-OBSERVABILITY.md)                                |
| Recoverability                | Defined RPO/RTO; tested DR; reversible deploys & models              | [17-DEVOPS](17-DEVOPS-AND-INFRA.md)                                    |
| Extensibility                 | New capability/model/industry/sensor added without core change       | [20-EXTENSIBILITY](20-EXTENSIBILITY.md)                                |

## Design decisions

- **NFRs are contracts, not aspirations.** Each has an owning architecture section and is verified in CI/load/chaos suites ([tests/](../../tests/)).
- **Vertical breadth is an architectural requirement**, not a product backlog item — hence Law 1 (no industry logic in core).
- **Latency and cost are won at the edge**, so edge-first is a principle, not an option.

## Advantages

- Clear, measurable envelope prevents scope drift and gold-plating.
- Verticals and capabilities become additive, compounding the product's value over time.

## Tradeoffs

- Ambitious NFRs (offline edge + 99.9% cloud + provable isolation) demand disciplined engineering from day one; there is no "we'll add isolation later." This is intentional.

## Future expansion

- New sensor modalities (audio, thermal, radar, LiDAR, IoT) as capabilities.
- Prescriptive analytics and cross-site reasoning as higher-order compositions.
- Marketplace-driven vertical explosion via partner plugins.

## Cross-references

[00-ENGINEERING-CONSTITUTION](../00-ENGINEERING-CONSTITUTION.md) · [03-ARCHITECTURE-PRINCIPLES](03-ARCHITECTURE-PRINCIPLES.md) · [../../tracking/ROADMAP.md](../../tracking/ROADMAP.md)
