# SPRINT-0005 — Secrets & centralized configuration (P0-6)

- **Date:** 2026-07-27 · **Phase/Slice:** Phase 0 · Slice 5 · **Branch:** feature/v1 · **Engineer:** Claude

## Objective

Implement P0-6 per the repo owner's deployment directive: **`.env` is the only secrets source** (no Vault/cloud KMS), with a **centralized, typed, fail-fast configuration** package so no code reads `process.env` directly. Keep deployment `cp .env.example .env → docker compose up -d`.

## Completed Work

- **`@vip/config`** (new shared package): `.env` loading via Node's built-in `process.loadEnvFile()` (**no `dotenv` dep**); `parseEnv` fail-fast validator (aggregated, group-named errors); typed camelCase groups — `app`, `database`, `redis`, `nats`, `storage`, `ai`, `jwt`. 14 unit tests.
- **Identity refactored** onto `@vip/config` (app group + `loadDotEnv()` at bootstrap); its config module no longer reads `process.env` for parsing. 19 tests still green; runtime smoke re-verified (boot + fail-fast on bad PORT + graceful shutdown).
- **ADR-0018** written; **doc 15 §4** reconciled (app secrets via env; KMS/vault = data-protection + optional extension); **`.env.example`** header rewritten + JWT group added; ADR index updated; **Q-006 resolved**.
- Governance: ED-0018, Constraints 15b/15c, A-014, R-015, Quality Gate Sprint 0005, slice-005 + this review.

## Architecture Compliance

Reverses the earlier "Vault/KMS" P0-6 assumption via [ADR-0018](../adr/ADR-0018-env-only-secrets-and-centralized-config.md) (the sanctioned freeze-change path). Data-protection KMS/vaulting (evidence encryption, camera credentials) is untouched. `check:imports`: **3 packages, 2 edges, 0 violations** (identity→config, identity→contracts — both valid `service→shared`). New [Constraints 15b/15c](../project/CONSTRAINTS.md).

## Definition of Done

| #   | Item                    | Status                                                               |
| --- | ----------------------- | -------------------------------------------------------------------- |
| 1   | Implementation Complete | ✅ `@vip/config` + identity refactor                                 |
| 2   | Documentation Updated   | ✅ ADR-0018, doc 15, governance                                      |
| 3   | README Updated          | ✅ packages/config README + .env.example                             |
| 4   | Unit Tests              | ✅ 14 (config) + 19 (identity)                                       |
| 5   | Integration Tests       | ✅ identity runtime smoke via config                                 |
| 6   | Scenario Tests          | ✅ [slice-005](../testing/slice-005.md)                              |
| 7   | Logging                 | ➖ N/A (config is pre-logging)                                       |
| 8   | Metrics                 | ➖ N/A                                                               |
| 9   | Health Checks           | ✅ identity still healthy                                            |
| 10  | Docker Validation       | ➖ N/A (no stack change; identity boots)                             |
| 11  | Dependency Review       | ✅ **zero new deps** (Node built-in)                                 |
| 12  | Security Review         | ✅ .env-only; no secrets committed; fail-fast; no direct process.env |
| 13  | Architecture Review     | ⏳ PENDING ARCHITECT REVIEW                                          |

## Files Created

`packages/config/**` (package.json, tsconfig, vitest.config, README, `src/`×9, `test/`×3); `docs/adr/ADR-0018-*.md`; `docs/testing/slice-005.md`; `docs/review/SPRINT-0005.md`.

## Files Modified

`services/identity/{package.json, src/config/env.ts, src/transport/server.ts, src/index.ts, test/config.test.ts}`, `.env.example`, `docs/architecture/15-SECURITY-ARCHITECTURE.md`, `docs/adr/README.md`, governance suite, trackers, daily log, `docs/{testing,review}/README.md`, `docs/ai/*`, `docs/project/CURRENT_SPRINT.md`, `pnpm-lock.yaml`.

## Risks

New **R-015** (no built-in rotation/audit — Accepted for the self-host model). See [RISK_REGISTER](../project/RISK_REGISTER.md).

## Technical Debt

TD-1 (carried). No new debt.

## Known Issues

None.

## Commands Executed

```
pnpm install
pnpm --filter @vip/config test
pnpm --filter @vip/service-identity typecheck
pnpm --filter @vip/service-identity test
pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check && pnpm check:imports
node services/identity/dist/index.js   # runtime smoke + fail-fast
```

## Tests Performed

Config unit tests; identity unit + inject tests; identity runtime smoke (boot from env, fail-fast on invalid PORT, graceful shutdown); full root gate.

## Test Results

`@vip/config` **14 passed**; identity **19 passed**; **52 TS tests** total. Runtime: `/health` 200, `/` returns configured name, `PORT=99999` → `ConfigError: Invalid "app" configuration` (exit 1), SIGTERM exit 0. Full gate green.

## Breaking Changes

None external. Internal: identity config fields are now camelCase (`nodeEnv/serviceName/host/port/logLevel/serviceVersion`).

## Next Sprint Recommendation

- **Proposed by:** Claude
- **Status:** WAITING FOR ARCHITECT APPROVAL
- **Reason:** **Phase 0 is now functionally complete** (P0-1..P0-7 done). Recommend a **Phase 0 Exit Review** slice: verify the exit criteria end-to-end (CI green on the empty service, contracts generating, dev stack — incl. MLflow/DVC — runs), then **open Phase 1** starting with **P1-1** (tenant model + fail-closed data-layer isolation guard), which turns the identity tenant-context seam into enforcement.
- **Dependencies:** none blocking; P1-1 builds on identity + @vip/config + the dev stack.
- **Risks:** R-010 (tenant enforcement) becomes the central concern of P1; needs an isolation test suite (P1-8).
- **Estimated Complexity:** Exit review = Low; P1-1 = Medium/High (isolation is security-critical).

## Architect Review

> PENDING ARCHITECT REVIEW
