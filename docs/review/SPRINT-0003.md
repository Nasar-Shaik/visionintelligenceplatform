# SPRINT-0003 — Identity service scaffold (P0-7) + Governance framework

- **Date:** 2026-07-27 · **Phase/Slice:** Phase 0 · Slice 3 · **Branch:** feature/v1 · **Engineer:** Claude

## Objective

Deliver the first backend service, `@vip/service-identity`, as the **reference Fastify
service template** (layering, health/ready/metrics, tenant-context seam, error envelope,
graceful shutdown) with **no auth/business logic** (that is P1). Additionally, institute
the **Architect-mandated governance framework** and backfill it across Slices 0–3.

## Completed Work

**Identity service (P0-7):**

- `@vip/service-identity` (Fastify 5), strict layering `transport → application → domain`, `adapters` for I/O (domain framework-free).
- Endpoints: `/health` (liveness), `/ready` (readiness registry → 503 on fail), `/metrics` (per-instance Prometheus), `/` (service-info in success envelope).
- Cross-cutting: zod fail-fast config; correlation-id `genReqId`; `@vip/contracts` `ApiError` error/404 envelope (opaque 5xx); helmet security headers; `TenantContext`-validated tenant seam (non-enforcing in P0); graceful SIGTERM/SIGINT drain.
- First real consumer of `@vip/contracts` → valid `service→shared` import edge.
- 19 service tests (unit + inject HTTP); **38 repo total**; live boot smoke-test green.

**Governance framework (this sprint):**

- `docs/project/`: ENGINEERING_DECISION_LOG, RISK_REGISTER, ASSUMPTIONS, OPEN_QUESTIONS, CONSTRAINTS, QUALITY_GATES, API_INVENTORY, DEFINITION_OF_DONE.
- `docs/testing/` slice-000…003 (PO-executable scenarios).
- `docs/review/` SPRINT-0000…0003 (this handoff set).
- `docs/templates/` reusable templates (ADR, engineering decision, package/service README, daily log, sprint review, test scenario, risk, assumption, open question).

## Architecture Compliance

Implements the ratified service template (docs [03](../architecture/03-ARCHITECTURE-PRINCIPLES.md)/[23](../architecture/23-SERVICE-OWNERSHIP.md), [ADR-0017](../adr/ADR-0017-fastify-control-plane.md)). No new architectural decision; frozen v1.0 intact. Boundary enforcement: `pnpm check:imports` → **2 packages, 1 edge, 0 violations**. Conforms to [CONSTRAINTS](../project/CONSTRAINTS.md) 1–10, 14–16. Tenant enforcement (Constraint 3) is a documented P1 deferral ([ED-0013](../project/ENGINEERING_DECISION_LOG.md), Risk R-010).

## Definition of Done

| #   | Item                    | Status                                                                                |
| --- | ----------------------- | ------------------------------------------------------------------------------------- |
| 1   | Implementation Complete | ✅ (scaffold scope; auth = P1)                                                        |
| 2   | Documentation Updated   | ✅ governance suite + trackers                                                        |
| 3   | README Updated          | ✅ service README + adapters README                                                   |
| 4   | Unit Tests              | ✅ config/readiness/domain/application                                                |
| 5   | Integration Tests       | ✅ inject-based HTTP (Testcontainers when Mongo lands, P1)                            |
| 6   | Scenario Tests          | ✅ [slice-003](../testing/slice-003.md)                                               |
| 7   | Logging                 | ✅ pino + correlation id                                                              |
| 8   | Metrics                 | ✅ Prometheus `/metrics`                                                              |
| 9   | Health Checks           | ✅ `/health` + `/ready`                                                               |
| 10  | Docker Validation       | ✅ boots via `node dist/index.js`; dev-stack compose validated (not launched — R-004) |
| 11  | Dependency Review       | ✅ registry-verified, recorded in DEPENDENCIES                                        |
| 12  | Security Review         | ✅ helmet, no secrets, opaque 5xx; CI scanners run on push (R-003)                    |
| 13  | Architecture Review     | ⏳ PENDING ARCHITECT REVIEW                                                           |

## Files Created

`services/identity/**` (package.json, tsconfig, vitest.config, README; `src/` config/domain/application×2/transport plugins×4+routes×3+server+index, adapters/README; `test/`×4). Governance: `docs/project/{ENGINEERING_DECISION_LOG,RISK_REGISTER,ASSUMPTIONS,OPEN_QUESTIONS,CONSTRAINTS,QUALITY_GATES,API_INVENTORY,DEFINITION_OF_DONE}.md`; `docs/testing/**`; `docs/review/**`; `docs/templates/**`.

## Files Modified

`docs/project/DEPENDENCIES.md`, `docs/project/CURRENT_SPRINT.md`, `docs/project/README.md`, `docs/ai/{CURRENT_CONTEXT,CURRENT_PRIORITIES}.md`, `docs/daily/2026-07/2026-07-27.md`, `tracking/{PROGRESS,TASK-BOARD}.md`, `pnpm-lock.yaml`.

## Risks

New: **R-009** (harness = schema-validation only), **R-010** (tenant seam non-enforcing until P1), **R-011** (infra image versions not yet governed). Carried: R-001…R-008. See [RISK_REGISTER](../project/RISK_REGISTER.md).

## Technical Debt

Unchanged: **TD-1** (TS pinned 5.9.3 pending typescript-eslint TS7 support). Minor: turbo "no output for test" warning until coverage is wired (Q-004).

## Known Issues

None open. See [KNOWN_ISSUES](../project/KNOWN_ISSUES.md).

## Commands Executed

```
pnpm install
pnpm --filter @vip/service-identity typecheck
pnpm --filter @vip/service-identity lint
pnpm --filter @vip/service-identity test
pnpm --filter @vip/service-identity build
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:imports
pnpm verify:contracts
```

## Tests Performed

Unit + inject-based HTTP (all endpoints, 404 envelope, correlation id, security headers); full root gate; live boot smoke-test (curl all endpoints + SIGTERM).

## Test Results

Identity **19 passed**; repo **38 passed**. Gate: format/lint/typecheck/build clean; `check:imports` 0 violations; `verify:contracts` 7/7. Smoke-test: `/health` 200, `/ready` 200 pass, `/` 200 envelope, `/metrics` 200 (`service="identity"`), 404 `ApiError`, helmet headers present, SIGTERM exit 0.

## Breaking Changes

None.

## Next Sprint Recommendation

- **Proposed by:** Claude
- **Status:** WAITING FOR ARCHITECT APPROVAL
- **Reason:** Complete Phase 0's remaining setup so feature work (P1) starts on a finished foundation. Recommend **Slice 4 = P0-5 registry bootstrap** (MLflow models + DVC datasets skeleton wired to MinIO), then **P0-6 secrets** (resolve Q-006 Vault vs KMS), then a **Phase 0 exit review**.
- **Dependencies:** P0-5 depends on the dev stack / object storage (P0-4, done); needs Q-008 (infra image governance) and ideally Q-006 resolved.
- **Risks:** R-004 (dev stack not yet launched — must run it for P0-5), R-011 (image version governance), plus new MLOps tooling versions to registry-verify.
- **Estimated Complexity:** Medium (infra + tooling wiring; no application logic).

## Architect Review

> PENDING ARCHITECT REVIEW
