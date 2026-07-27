# Slice 005 — Secrets & centralized config (`@vip/config`) · Manual Test Scenarios

- **Target:** `.env`-only configuration via the `@vip/config` package + the identity service refactored onto it.
- **Prereqs:** `pnpm install`; `cp .env.example .env`.

## Positive Tests

### T-1 Config unit tests pass

- **Steps:** `pnpm --filter @vip/config test`
- **Expected:** 3 files, 14 tests pass.
- **Pass Criteria:** exit 0. **Result:** ☐ Pass ☐ Fail

### T-2 Identity boots from `.env` via @vip/config

- **Steps:**
  ```bash
  pnpm --filter @vip/service-identity build
  PORT=48090 HOST=127.0.0.1 NODE_ENV=production SERVICE_NAME=identity node services/identity/dist/index.js
  curl -s http://127.0.0.1:48090/
  ```
- **Expected:** `{"success":true,"data":{"name":"identity",...}}` — config resolved through @vip/config.
- **Pass Criteria:** 200 with the configured service name. **Result:** ☐ Pass ☐ Fail

### T-3 `.env` is loaded automatically

- **Steps:** put `SERVICE_NAME=from-dotenv` in `.env`, run the service with no inline env, `curl /`.
- **Expected:** `data.name` = `from-dotenv` (loaded by `loadDotEnv()`).
- **Pass Criteria:** value comes from `.env`. **Result:** ☐ Pass ☐ Fail

## Negative / Edge

### T-4 Fail-fast on invalid config

- **Steps:** `PORT=99999 node services/identity/dist/index.js`
- **Expected:** aborts with `ConfigError: Invalid "app" configuration:  - PORT: Too big …` (non-zero exit; never listens).
- **Pass Criteria:** clear, group-named error; process exits 1. **Result:** ☐ Pass ☐ Fail

### T-5 Each infra group fails fast when its required key is missing

- **Steps:** in a REPL, `import { loadDatabaseConfig } from '@vip/config'; loadDatabaseConfig({})`.
- **Expected:** throws `ConfigError` naming `database` and `MONGO_URI`.
- **Pass Criteria:** fail-fast per group. **Result:** ☐ Pass ☐ Fail

## Manual Validation

- **No external secret service** anywhere: deployment is `cp .env.example .env` → edit → `docker compose up -d`.
- Grep the codebase: business logic does **not** read `process.env` directly (only `@vip/config` and bootstrap do).
- `.env.example` documents every key incl. the JWT group (consumed from P1).

## Performance / Failure

➖ N/A — configuration loads once at startup.

## Summary

- **Automated coverage:** `@vip/config` 14 tests + identity 19 (via the shared loader).
- **Overall Pass Criteria:** T-1…T-5 pass.
