# Task Board

> The actionable backlog. Pull from **Now**; if empty, pull the top unblocked item from **Next**. Mark `in_progress` with your signature before starting and update on stop. Each item states its **dependency** and **Definition-of-Done pointer** (see [AGENT-ONBOARDING §5](AGENT-ONBOARDING.md)).

Format: `- [ ] <id> — <task> · deps: <…> · phase: <Px> · owner: <—>`

## Needs-Decision (resolve before/while building; may need an ADR)

- [x] ND-1 — Event backbone → **NATS + JetStream** (leaf nodes at edge). Resolved [ADR-0016](../docs/adr/ADR-0016-nats-jetstream-event-backbone.md). `[Claude · 2026-07-27]`
- [ ] ND-2 — Choose vector DB (Qdrant vs Milvus vs Atlas Vector) for event embeddings. deps: none · affects P6.
- [ ] ND-3 — Choose primary edge orchestrator (k3s vs balena vs bespoke) for fleet. deps: none · affects P2/P14.

## Now (Phase 0)

- [x] P0-1 — Initialize monorepo: pnpm workspace + Turborepo + shared tsconfig/eslint/prettier. `[Claude · 2026-07-27]` (Python workspace under `ai/` deferred to P3 when vision code starts)
- [x] P0-2 — Bootstrap `packages/contracts`: Zod 4 schemas (event envelope/catalog, capability descriptor+registry record, config hierarchy, tenant context, API envelope) + native JSON-Schema codegen + 19 contract tests. `[Claude · 2026-07-27]` (Protobuf for gRPC/NATS payloads deferred until first service needs it)
- [x] P0-3 — CI skeleton (GitHub Actions): build, unit test, lint/format/typecheck, SAST/secret scan (gitleaks+semgrep), advisory dep-audit, **import-graph enforcement** (`tools/import-graph/`) + **contract-testing harness** (`tools/contracts/`). `[Claude · 2026-07-27]` (coverage output + SARIF upload deferred)
- [x] P0-4 — Docker Compose dev stack: Mongo, Redis, MinIO, **NATS/JetStream**. `[Claude · 2026-07-27]` (RTSP test source added in P2 when media ingestion begins)
- [ ] P0-5 — Registry bootstrap: MLflow (models) + DVC (datasets) skeleton wired to object storage. · deps: P0-4 · phase: P0
- [~] P0-6 — Secrets strategy: `.env.example` conventions done (no secrets in repo); Vault/cloud-KMS integration pattern still to wire. · deps: none · phase: P0
- [ ] P0-7 — First empty service scaffold (`services/identity`) proving the Fastify service template (transport→service→domain→adapters, /health,/ready,/metrics). · deps: P0-2,P0-3 · phase: P0

## Next (Phase 1 — pull when P0 exits)

- [ ] P1-1 — Tenant model + data-layer isolation guard (fail-closed `tenantId`; repo middleware). · deps: P0-7 · phase: P1
- [ ] P1-2 — Identity service: OIDC/JWT/refresh(reuse-detection)/MFA. · deps: P1-1 · phase: P1
- [ ] P1-3 — RBAC+ABAC policy module (`packages/permissions`) + scopes. · deps: P1-2 · phase: P1
- [ ] P1-4 — Org hierarchy (org→region→country→branch→site→building→floor→zone→camera) schema + CRUD. · deps: P1-1 · phase: P1
- [ ] P1-5 — Entitlements/feature-flags + Redis cache; `<FeatureGate>`. · deps: P1-1 · phase: P1
- [ ] P1-6 — Hash-chained audit log service. · deps: P1-1 · phase: P1
- [ ] P1-7 — Billing (Stripe) + usage metering + quotas. · deps: P1-5 · phase: P1
- [ ] P1-8 — Cross-tenant isolation test suite (must fail-closed on every endpoint). · deps: P1-1 · phase: P1

## Later (Phase 2+)

- Seeded from [ROADMAP](ROADMAP.md) as each phase approaches. Do not expand phases far ahead of their dependencies — keep the board honest.
- **From the Enterprise Review** (build in their natural phases; architecture is ratified):
  - Composition Layer runtime + registry + reference compositions ([24](../docs/architecture/24-COMPOSITION-FRAMEWORK.md)) → Phase 4/6.
  - Connector Platform runtime + `connector.provider` + first adapters (REST/webhook/MQTT/POS) ([25](../docs/architecture/25-CONNECTOR-PLATFORM.md)) → Phase 8.
  - `model.provider` extension point + marketplace surface ([08 §8](../docs/architecture/08-AI-ML-PLATFORM.md)) → Phase 9.
  - Digital Twin projection + `/twin/*` API ([26](../docs/architecture/26-DIGITAL-TWIN.md)) → Phase 5/6.
  - CI: extend import-graph checks to forbid cross-context DB access + enforce acyclic service/capability graphs ([23](../docs/architecture/23-SERVICE-OWNERSHIP.md)) → Phase 0/1.
- **From the Final Enhancement (v1.0)**:
  - Control-Plane vs Data-Plane deployment topologies + config/policy push-and-cache sync ([27](../docs/architecture/27-CONTROL-DATA-PLANE.md)) → Phase 1/2.
  - Model Adapter Layer + adapter conformance tests ([08 §8a](../docs/architecture/08-AI-ML-PLATFORM.md)) → Phase 3.
  - Runtime Capability Registry with full metadata schema ([05 §3](../docs/architecture/05-CAPABILITY-ARCHITECTURE.md)) → Phase 3.
  - Policy Engine (PDP) + enforcement hooks across services ([28](../docs/architecture/28-POLICY-ENGINE.md)) → Phase 1 (authz) → Phase 8 (full compliance).
  - Configuration hierarchy resolver + provenance/rollback ([06 §6](../docs/architecture/06-MULTI-TENANT-SAAS.md)) → Phase 1.
  - Contract-testing harness (all contract types) + plugin certification pipeline ([03](../docs/architecture/03-ARCHITECTURE-PRINCIPLES.md), [20 §6a](../docs/architecture/20-EXTENSIBILITY.md)) → Phase 0 (harness) → Phase 7 (certification).

## Done

- [x] ARCH-2 — Final Architecture Enhancement: **FROZE architecture v1.0**; added sections 27–28, ADRs 0011–0015, readiness review; integrated model-adapter/capability-registry/config-hierarchy/contract-testing/plugin-certification. `[Final Enhancement · 2026-07-27]`
- [x] ARCH-1 — Enterprise Architecture Review v1.1: added sections 22–26, ADRs 0006–0010, TECH-DEBT register; integrated composition/scheduler/execution-graph/models-as-plugins/deployment-profiles/agent-continuity. `[Enterprise Review · 2026-07-26]`
- [x] ARCH-0 — Ratify architecture v1.0 (Constitution + 21 sections + reference + 5 ADRs) and build tracking system + repo skeleton. `[Architecture · 2026-07-26]`
