# Quality Gates

> Every sprint is scored against these gates with **PASS / FAIL + reason**. A sprint with any unresolved FAIL on an applicable gate is not shippable. History is append-only (newest first).
>
> Legend: ✅ PASS · ❌ FAIL · ⏳ PENDING (external) · ➖ N/A (with reason).

## Gate definitions

| Gate              | Passes when…                                         | Mechanism                             |
| ----------------- | ---------------------------------------------------- | ------------------------------------- |
| Architecture      | No frozen-v1.0 violation; boundaries hold            | `check:imports`, review               |
| Security          | No committed secrets; SAST clean; deps triaged       | gitleaks, semgrep, pnpm audit         |
| Performance       | No known regression; perf work tracked               | (deferred to P2/P4; tracked as R-005) |
| Testing           | Unit/integration/scenario present and green          | vitest, `docs/testing/`               |
| Documentation     | Docs + governance trackers updated                   | review, DoD                           |
| Dependency Review | New deps registry-verified + recorded                | DEPENDENCIES.md                       |
| Lint              | ESLint (type-aware) clean                            | `pnpm lint`                           |
| Formatting        | Prettier clean                                       | `pnpm format:check`                   |
| Build             | All packages build                                   | `pnpm build`                          |
| Docker            | Compose validates / service boots                    | `docker compose config`, boot test    |
| Maintainability   | Layering intact; readable; documented                | review                                |
| Extensibility     | Plugin/adapter seams preserved; no vertical coupling | review, import-graph                  |

---

## Sprint 0008 — Slice 8 (P1-3 Camera registry + org hierarchy) · 2026-07-28

| Gate              | Result  | Reason                                                                                                                                                                                                                                                                            |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture      | ✅ PASS | `check:imports` 10 pkgs / 0 violations; only `service→shared` edges (camera→contracts/config/tenancy/auth/permissions/crypto); Camera owns cameras, Tenant keeps the hierarchy (22 §1/§3); frozen v1.0 unchanged ([ED-0024](ENGINEERING_DECISION_LOG.md))                         |
| Security          | ✅ PASS | Camera credentials **vaulted at rest** (AES-256-GCM, `@vip/crypto`); never returned/logged (`hasCredentials` only); URL-embedded creds rejected; per-service token verification; deny-by-default authz; cross-tenant → opaque 404; no secrets committed                           |
| Performance       | ➖ N/A  | Tenant-leading indexes (`uniq_tenant_stream`, `tenant_zone`); scrypt key derived once at boot; scale validated later (R-005)                                                                                                                                                      |
| Testing           | ✅ PASS | 48 TS tests for the slice (12 crypto, 14 camera contracts, 22 camera service incl. 4 real-Mongo integration): vaulting round-trip + tamper/wrong-key, authz, credential-safety, **cross-tenant isolation**; live-validated against dev-stack Mongo (repo total 200, 210 w/ Mongo) |
| Documentation     | ✅ PASS | crypto + camera READMEs, CAMERA_ARCHITECTURE grounding, API_INVENTORY, DEPENDENCIES, slice-008, trackers; TD-3 recorded                                                                                                                                                           |
| Dependency Review | ✅ PASS | **Zero new external deps** — `@vip/crypto` is `node:crypto` only (argon2/libsodium rejected, no native build); camera reuses the fastify/mongodb set — [ED-0024](ENGINEERING_DECISION_LOG.md)                                                                                     |
| Lint              | ✅ PASS | `pnpm lint` clean (type-aware, 10 pkgs)                                                                                                                                                                                                                                           |
| Formatting        | ✅ PASS | `pnpm format:check` clean                                                                                                                                                                                                                                                         |
| Build             | ✅ PASS | `pnpm build` all packages; `verify:contracts` 15 schemas                                                                                                                                                                                                                          |
| Docker            | ✅ PASS | camera boots against dev-stack Mongo; integration suite green (unique index, ciphertext round-trip, isolation)                                                                                                                                                                    |
| Maintainability   | ✅ PASS | strict layering (credential sealing in application, domain stays pure); reusable `@vip/crypto`; explicit DI                                                                                                                                                                       |
| Extensibility     | ✅ PASS | ONVIF discovery route stubbed (501) ahead of impl; envelope `v1` tag reserves key rotation; publisher seam for `camera.*` (NATS P1-5); async zone reconciliation seam (TD-3)                                                                                                      |

**Overall: PASS** (Architecture Review ⏳ PENDING — see [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md)).

## Sprint 0007 — Slice 7 (P1-2 Authentication + authorization) · 2026-07-28

| Gate              | Result  | Reason                                                                                                                                                                                                              |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture      | ✅ PASS | `check:imports` 8 pkgs / 0 violations; new `service→shared` edges only; frozen v1.0 unchanged; full Policy Engine seam preserved ([ED-0023](ENGINEERING_DECISION_LOG.md))                                           |
| Security          | ✅ PASS | scrypt password hashing; short-TTL HS256 access + rotating refresh with **reuse-detection** (family revocation); deny-by-default authz; gateway strips client-spoofed context; 401/403 opaque; no secrets committed |
| Performance       | ➖ N/A  | scrypt cost tuned (N=2^14); token verify is CPU-only; scale validated later (R-005)                                                                                                                                 |
| Testing           | ✅ PASS | 154 TS tests (160 w/ Mongo): auth units, RBAC PDP, identity auth vertical + reuse-detection, gateway trust boundary, real-Mongo integration; **live-validated**                                                     |
| Documentation     | ✅ PASS | auth/permissions/gateway + identity READMEs, AUTHENTICATION grounding, API_INVENTORY, DEPENDENCIES, slice-007, trackers                                                                                             |
| Dependency Review | ✅ PASS | `jose ^6.2.4` (pure-JS, no build) registry-verified; scrypt over argon2 (no native build) — [ED-0023](ENGINEERING_DECISION_LOG.md)                                                                                  |
| Lint              | ✅ PASS | `pnpm lint` clean (type-aware, 8 pkgs)                                                                                                                                                                              |
| Formatting        | ✅ PASS | `pnpm format:check` clean                                                                                                                                                                                           |
| Build             | ✅ PASS | `pnpm build` all packages; `verify:contracts` 12 schemas                                                                                                                                                            |
| Docker            | ✅ PASS | identity boots against dev-stack Mongo; `/ready` mongo pass; login issues a valid JWT; SIGTERM exit 0                                                                                                               |
| Maintainability   | ✅ PASS | strict layering; build-free crypto; explicit DI (auth preHandlers injected); domain framework-free                                                                                                                  |
| Extensibility     | ✅ PASS | RS256/JWKS, MFA/SSO, full Policy Engine documented as extension points; publisher seam for auth events (NATS in P1-5)                                                                                               |

**Overall: PASS** (Architecture Review ⏳ PENDING — see [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md)).

## Sprint 0006 — Slice 6 (P1-1 Tenant foundation + fail-closed isolation) · 2026-07-28

| Gate              | Result  | Reason                                                                                                                                                                        |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture      | ✅ PASS | `check:imports` 5 pkgs / 6 edges / 0 violations; new `service→shared` edges (tenant→contracts/config/tenancy); frozen v1.0 unchanged ([ED-0021](ENGINEERING_DECISION_LOG.md)) |
| Security          | ✅ PASS | Fail-closed isolation is the deliverable — cross-tenant read/write structurally impossible; 403 opaque (no tenant/record leak); no secrets committed                          |
| Performance       | ➖ N/A  | Tenant-leading indexes created; scale validated later (R-005)                                                                                                                 |
| Testing           | ✅ PASS | 62 TS tests (29 tenancy guard, 14 contracts, 19 svc incl. 3 real-Mongo integration); **validated live E2E** against dev-stack Mongo                                           |
| Documentation     | ✅ PASS | tenant + tenancy READMEs, TENANT_ARCHITECTURE grounding, API_INVENTORY, DEPENDENCIES, slice-006 scenario, trackers                                                            |
| Dependency Review | ✅ PASS | `mongodb ^7.5.0` registry-verified + recorded; `@testcontainers/mongodb` rejected (native build scripts) — [ED-0022](ENGINEERING_DECISION_LOG.md)                             |
| Lint              | ✅ PASS | `pnpm lint` clean (type-aware, 5 pkgs)                                                                                                                                        |
| Formatting        | ✅ PASS | `pnpm format:check` clean                                                                                                                                                     |
| Build             | ✅ PASS | `pnpm build` all packages; `verify:contracts` 9 schemas                                                                                                                       |
| Docker            | ✅ PASS | dev-stack Mongo launched; service boots (`node dist/index.js`), `/ready` mongo pass, SIGTERM exit 0; torn down                                                                |
| Maintainability   | ✅ PASS | Strict layering (transport→application→domain, adapters for I/O); domain framework-free; guard is the single choke point                                                      |
| Extensibility     | ✅ PASS | Event-publisher seam (NATS in P1-5); pooled→siloed abstracted by the guard; authz seam for P1-2                                                                               |

**Overall: PASS** (Architecture Review ⏳ PENDING — see [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md)).

## Sprint 0005 — Slice 5 (Secrets & centralized config, P0-6) · 2026-07-27

| Gate                      | Result  | Reason                                                                                                                      |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Architecture              | ✅ PASS | New `@vip/config` shared lib (ADR-0018); identity refactored onto it; import-graph 3 pkgs / 2 edges / 0 violations          |
| Security                  | ✅ PASS | `.env`-only secrets; no external manager; no `process.env` in business logic; fail-fast on bad config; no secrets committed |
| Performance               | ➖ N/A  | Config load is startup-only                                                                                                 |
| Testing                   | ✅ PASS | `@vip/config` 14 tests; identity refactor keeps 19; runtime smoke (fail-fast verified). 52 TS tests                         |
| Documentation             | ✅ PASS | ADR-0018 + doc 15 §4 reconciled + `.env.example` + README + governance suite                                                |
| Dependency Review         | ✅ PASS | **Zero new deps** (Node `process.loadEnvFile()` built-in; reuses zod)                                                       |
| Lint / Formatting / Build | ✅ PASS | all clean                                                                                                                   |
| Docker                    | ➖ N/A  | No stack change (identity still boots; verified)                                                                            |
| Maintainability           | ✅ PASS | One typed config surface; grouped by concern; no abstraction without value                                                  |
| Extensibility             | ✅ PASS | Future secret stores are a single documented extension point; group loaders unchanged                                       |

**Overall: PASS** (Architecture Review ⏳ PENDING — see [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md)).

## Sprint 0004 — Slice 4 (Registry bootstrap, P0-5) · 2026-07-27

| Gate              | Result  | Reason                                                                                                                   |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Architecture      | ✅ PASS | MLflow+Postgres+MinIO (doc 08 §2) + DVC (§3); no core coupling; import-graph unaffected (infra)                          |
| Security          | ✅ PASS | No secrets committed (S3/DB creds are env placeholders); DVC creds via config.local; MLflow auth/TLS = prod TODO (R-014) |
| Performance       | ➖ N/A  | Bootstrap wiring; registry scale/HA validated in P9                                                                      |
| Testing           | ✅ PASS | 5 stdlib config unit tests + **live end-to-end integration smoke** (run→artifact→register→read-back)                     |
| Documentation     | ✅ PASS | ai/mlops + ai/datasets READMEs + governance suite + trackers                                                             |
| Dependency Review | ✅ PASS | mlflow 3.14.0, dvc 3.67.1, dvc-s3 3.3.0, boto3 1.43.56, psycopg2 2.9.12, postgres:17, python:3.12 — registry-verified    |
| Lint              | ✅ PASS | TS lint clean (no TS change); Python lint deferred (Q-011)                                                               |
| Formatting        | ✅ PASS | `pnpm format:check` clean                                                                                                |
| Build             | ✅ PASS | `pnpm build` clean; MLflow image builds                                                                                  |
| Docker            | ✅ PASS | Full MLOps stack launched healthy (MinIO/Postgres/MLflow/bucket bootstrap); smoke passed; torn down                      |
| Maintainability   | ✅ PASS | Config in one place (compose/env); stdlib-testable config module                                                         |
| Extensibility     | ✅ PASS | Registry selectors + model-card/CT hooks documented for P3/P9                                                            |

**Overall: PASS** (Architecture Review ⏳ PENDING — see [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md)).

## Sprint 0003 — Slice 3 (Identity service, P0-7) + Governance framework · 2026-07-27

| Gate              | Result                  | Reason                                                                                                                                   |
| ----------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture      | ✅ PASS                 | `check:imports` 2 pkgs / 1 edge / 0 violations; valid `service→shared` edge; no core→plugin                                              |
| Security          | ✅ PASS (local) / ⏳ CI | No secrets; helmet headers verified; gitleaks/semgrep run GitHub-side on push (R-003)                                                    |
| Performance       | ➖ N/A                  | No perf-sensitive path yet; deferred to P2/P4 (R-005)                                                                                    |
| Testing           | ✅ PASS                 | 38 tests total (19 identity: unit + inject HTTP); scenario docs in `docs/testing/`                                                       |
| Documentation     | ✅ PASS                 | README + governance suite + trackers + daily log updated                                                                                 |
| Dependency Review | ✅ PASS                 | fastify 5.10.0, helmet 13.1.0, prom-client 15.1.3, pino-pretty 13.1.3 — registry-verified, recorded                                      |
| Lint              | ✅ PASS                 | `pnpm lint` clean (type-aware)                                                                                                           |
| Formatting        | ✅ PASS                 | `pnpm format:check` clean                                                                                                                |
| Build             | ✅ PASS                 | `pnpm build` all packages                                                                                                                |
| Docker            | ✅ PASS                 | Service boots (`node dist/index.js`), all endpoints served, SIGTERM clean exit 0; dev-stack compose validated (not yet launched — R-004) |
| Maintainability   | ✅ PASS                 | Strict layering; domain framework-free; self-documenting README                                                                          |
| Extensibility     | ✅ PASS                 | Adapter/readiness/tenant seams in place; no vertical logic                                                                               |

**Overall: PASS** (Architecture Review ⏳ PENDING — see [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md)).

## Sprint 0002 — Slice 2 (CI quality gate, P0-3) · 2026-07-27

| Gate                            | Result          | Reason                                                                |
| ------------------------------- | --------------- | --------------------------------------------------------------------- |
| Architecture                    | ✅ PASS         | Import-graph tool built + negative-tested (4 rules)                   |
| Security                        | ✅ PASS (local) | gitleaks + semgrep + advisory audit wired; `.gitleaks.toml` allowlist |
| Testing                         | ✅ PASS         | 19 tests (contracts); import-graph negative tests                     |
| Documentation                   | ✅ PASS         | tools READMEs + trackers                                              |
| Dependency Review               | ✅ PASS         | No new runtime deps; Dependabot actions-only                          |
| Lint / Formatting / Build       | ✅ PASS         | Repo-wide Prettier baseline established                               |
| Docker                          | ➖ N/A          | No service yet                                                        |
| Maintainability / Extensibility | ✅ PASS         | Declarative boundaries.json; harness seam                             |

**Overall: PASS** (Architecture Review ⏳ PENDING — retro-documented).

## Sprint 0001 — Slice 1 (Contracts, P0-2) · 2026-07-27

| Gate                                                  | Result  | Reason                                                       |
| ----------------------------------------------------- | ------- | ------------------------------------------------------------ |
| Testing                                               | ✅ PASS | 19 contract tests                                            |
| Dependency Review                                     | ✅ PASS | Zod 4 adopted; TS pinned 5.9.3 (TD-1); all registry-verified |
| Lint / Formatting / Build                             | ✅ PASS | Type-aware lint green; codegen emits 7 schemas               |
| Architecture / Docs / Maintainability / Extensibility | ✅ PASS | Schema-first foundation                                      |
| Docker / Performance                                  | ➖ N/A  | Not applicable to a types package                            |

**Overall: PASS** (Architecture Review ⏳ PENDING — retro-documented).

## Sprint 0000 — Slice 0 (Program & dev stack) · 2026-07-27

| Gate          | Result  | Reason                                     |
| ------------- | ------- | ------------------------------------------ |
| Architecture  | ✅ PASS | Stack ADRs 0016/0017; no philosophy change |
| Docker        | ✅ PASS | `docker compose config` validated          |
| Documentation | ✅ PASS | Continuity system + monorepo scaffold      |
| Others        | ➖ N/A  | No application code this slice             |

**Overall: PASS** (Architecture Review ⏳ PENDING — retro-documented).
