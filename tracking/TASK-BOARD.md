# Task Board

> The actionable backlog. Pull from **Now**; if empty, pull the top unblocked item from **Next**. Mark `in_progress` with your signature before starting and update on stop. Each item states its **dependency** and **Definition-of-Done pointer** (see [AGENT-ONBOARDING §5](AGENT-ONBOARDING.md)).

Format: `- [ ] <id> — <task> · deps: <…> · phase: <Px> · owner: <—>`

## Needs-Decision (resolve before/while building; may need an ADR)
- [ ] ND-1 — Confirm managed vs self-hosted streaming backbone for cloud (Kafka vs Redpanda vs cloud-native). deps: none · propose ADR-0006 if it changes TECH-STACK.
- [ ] ND-2 — Choose vector DB (Qdrant vs Milvus vs Atlas Vector) for event embeddings. deps: none · affects P6.
- [ ] ND-3 — Choose primary edge orchestrator (k3s vs balena vs bespoke) for fleet. deps: none · affects P2/P14.

## Now (Phase 0)
- [ ] P0-1 — Initialize monorepo: pnpm workspace + Turborepo + Python workspace under `ai/`; shared tsconfig/eslint/prettier. · deps: none · phase: P0
- [ ] P0-2 — Bootstrap `packages/contracts`: schema-first setup (Zod→JSON Schema/OpenAPI; Protobuf for gRPC/events), codegen for TS types. · deps: P0-1 · phase: P0
- [ ] P0-3 — CI skeleton (GitHub Actions): build, unit test, lint, SAST/secret scan, **import-graph enforcement** (no core→plugin, no capability internals). · deps: P0-1 · phase: P0
- [ ] P0-4 — Docker Compose dev stack: Mongo, Redis, MinIO, streaming backbone, RTSP test source. · deps: none · phase: P0
- [ ] P0-5 — Registry bootstrap: MLflow (models) + DVC (datasets) skeleton wired to object storage. · deps: P0-4 · phase: P0
- [ ] P0-6 — Secrets strategy: Vault/cloud-KMS integration pattern + `.env` conventions (no secrets in repo). · deps: none · phase: P0
- [ ] P0-7 — First empty service scaffold (`services/gateway` or `services/identity`) proving the service template (transport→service→domain→adapters, /health,/ready,/metrics). · deps: P0-2,P0-3 · phase: P0

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

## Done
- [x] ARCH-0 — Ratify architecture v1.0 (Constitution + 21 sections + reference + 5 ADRs) and build tracking system + repo skeleton. `[Architecture · 2026-07-26]`
