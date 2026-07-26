# 03 — Architecture & Engineering Principles

## Purpose
Turn the Constitution's Five Laws into concrete, testable principles and engineering standards that guide day-to-day decisions and code review.

## Responsibilities
- Define the 15 platform principles and what each forbids/requires.
- Define the engineering standards (code, contracts, testing, review) every contributor follows.

---

## Part A — The 15 platform principles

1. **Multi-tenant SaaS.** Every artifact and operation is tenant-scoped; isolation is enforced at the data layer. → [06](06-MULTI-TENANT-SAAS.md)
2. **Modular.** The system is a set of independently buildable/deployable modules with explicit boundaries; no module reaches into another's internals.
3. **Plugin-based.** Behavior that varies by customer/industry is a plugin, loaded at runtime, never a core branch. → [13](13-INDUSTRY-PACKS.md), [20](20-EXTENSIBILITY.md)
4. **Event-driven.** Components communicate via durable events on a backbone; no synchronous business coupling between capabilities. → [09](09-EVENT-PLATFORM.md)
5. **Rule-driven.** "What matters" is declarative tenant data evaluated by the Rule Engine, not code. → [10](10-RULE-ENGINE.md)
6. **API-first.** Every capability is defined by a contract before implementation and reachable through the public API surface. → [21](21-API-ARCHITECTURE.md)
7. **AI model-agnostic.** Models are registry artifacts behind a uniform inference contract; runtimes (ONNX/TensorRT/OpenVINO/CPU/GPU) are pluggable. → [08](08-AI-ML-PLATFORM.md)
8. **Cloud-native.** Stateless services, 12-factor config, containerized, orchestrated, declaratively provisioned. → [17](17-DEVOPS-AND-INFRA.md)
9. **Edge-first.** Real-time inference runs at the edge by default; the cloud does orchestration, heavy/batch and aggregation. → [14](14-EDGE-PLATFORM.md)
10. **Offline-capable.** Edge functions fully without the cloud and reconciles deterministically on reconnect.
11. **Horizontally scalable.** Every hot path scales out; state lives in scalable stores, not in service memory. → [19](19-PERFORMANCE-AND-SCALE.md)
12. **Secure by design.** AuthN/Z, encryption, secrets, audit and privacy are part of every contract. → [15](15-SECURITY-ARCHITECTURE.md)
13. **Observable.** Metrics, traces, logs, health and SLOs are emitted by default; unobservable code is incomplete. → [16](16-OBSERVABILITY.md)
14. **Extensible.** Extension points, hooks, interfaces and DI exist wherever a future need is plausible. → [20](20-EXTENSIBILITY.md)
15. **Production-ready & reversible.** Everything ships with tests, runbooks, rollback, backup/restore, and DR. → [17](17-DEVOPS-AND-INFRA.md)

---

## Part B — Engineering standards

### Contracts
- Contracts (schemas, API specs, event definitions) live in `packages/contracts`, are the **single source of integration truth**, and are authored before code.
- Schema-first: define with a schema language (Zod → JSON Schema / OpenAPI 3.1 for HTTP; Protobuf for gRPC and edge↔cloud; JSON Schema for events). Types are **generated**, never hand-maintained in two places.
- Semantic versioning; additive-only within a major; breaking changes need an ADR + deprecation window.

### Services
- 12-factor: config from environment, no config in code, stateless request handling, backing services attached by URL/credential.
- Layered internally: `transport → application/service → domain → adapters(repositories/clients)`. Domain logic never imports transport.
- Idempotency keys on all mutating public endpoints; retries assume at-least-once delivery everywhere.
- Every service exposes `/health` (liveness), `/ready` (readiness), and `/metrics`.

### Data
- Mandatory `tenantId` on every record; compound indexes lead with `tenantId`. Access without tenant context throws.
- Separate **hot/OLTP**, **analytics/read-model**, **time-series**, **object**, **search/vector** stores by workload. → [18](18-DATA-ARCHITECTURE.md)
- High-volume ephemeral data (raw detections) is TTL'd; only aggregates/events persist long-term.

### Testing (travels with code — see [tests/](../../tests/))
- **Unit** for logic; **contract** tests for every published contract; **integration** with real backing services (Testcontainers); **isolation** tests proving cross-tenant access fails; **E2E** for critical journeys; **load/stress** to target camera counts; **model validation** gates (precision/recall, FP/FN) for AI capabilities.
- A capability is not "done" without a contract test and an isolation test on any new data path.

### Code review gates (CI-enforced where possible)
- Import graph respects §6 of the Constitution (no core→plugin, no capability↔capability internals).
- No secrets, no PII in logs, no hardcoded tenant/customer/model constants.
- Observability present on new paths; docs & tracking updated.

### Naming & vocabulary
- Use the canonical terms from [reference/GLOSSARY](../reference/GLOSSARY.md) everywhere (code, docs, events, APIs). One concept, one name.

---

## Design decisions
- **Principles are enforced, not aspirational**: import-graph linting, contract tests, and isolation tests make violations fail CI rather than depend on reviewer memory.
- **Schema-first + generated types** eliminates drift between services, SDKs, and docs.

## Advantages
- New contributors and agents inherit a consistent system; review is about correctness, not style debates.
- Enforcement in CI keeps the architecture intact as the team scales.

## Tradeoffs
- Strict standards slow the very first commits (scaffolding contracts, DI, tests) but eliminate the compounding cost of divergence — the correct trade for a decade-long platform.

## Future expansion
- Additional generated targets (Python/Go/mobile SDKs) from the same contracts.
- Policy-as-code checks (OPA) for architectural and security invariants in CI.

## Cross-references
[00-ENGINEERING-CONSTITUTION](../00-ENGINEERING-CONSTITUTION.md) · [20-EXTENSIBILITY](20-EXTENSIBILITY.md) · [21-API-ARCHITECTURE](21-API-ARCHITECTURE.md)
