# DEPENDENCIES

> Dependency policy + the pinned toolchain, with rationale. **Versions are verified against the official registry (`npm view`) at selection time — never assumed from memory.** Update this file whenever a dependency is added or upgraded.

## Policy (enforced)

1. Verify the latest **stable** version from the registry before adding/upgrading (no memory).
2. **No** alpha/beta/RC/nightly unless explicitly requested.
3. Prefer the latest stable **major** — unless it breaks a required tool (then pin the newest stable that keeps the toolchain working and record the deferral as tech debt).
4. Verify compatibility with existing deps (run install + build + test + lint).
5. Explain any major-version change that requires code changes.
6. Update this document after every change.

## Toolchain (verified 2026-07-27 via `npm view`)

| Package           | Pinned                   | Registry latest stable | Notes                                   |
| ----------------- | ------------------------ | ---------------------- | --------------------------------------- |
| node              | ≥22 (`.nvmrc` 24)        | 26.x                   | engines floor 22 (LTS); dev env runs 26 |
| pnpm              | `packageManager` 11.17.0 | 11.17.0                | monorepo package manager                |
| turbo             | ^2.10.7                  | 2.10.7                 | task runner                             |
| typescript        | **^5.9.3**               | 7.0.2                  | **deferred from 7** — see TD-1 below    |
| typescript-eslint | ^8.65.0                  | 8.65.0                 | peer: TS `>=4.8.4 <6.1.0` (no TS7 yet)  |
| eslint            | ^10.8.0                  | 10.8.0                 | flat config                             |
| @eslint/js        | ^10.0.1                  | 10.0.1                 |                                         |
| prettier          | ^3.9.6                   | 3.9.6                  |                                         |
| @types/node       | ^26.1.1                  | 26.1.1                 |                                         |
| zod               | ^4.4.3                   | 4.4.3                  | see major-change note                   |
| vitest            | ^4.1.10                  | 4.1.10                 | test runner                             |
| tsx               | ^4.23.1                  | 4.23.1                 | run TS scripts (codegen)                |

## Service runtime deps (verified 2026-07-27 via `npm view`)

Introduced by `@vip/service-identity` (P0-7); the reference stack every TS service uses.

| Package         | Pinned  | Registry latest stable | Notes                                                                                          |
| --------------- | ------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| fastify         | ^5.10.0 | 5.10.0                 | service framework (ADR-0017)                                                                   |
| @fastify/helmet | ^13.1.0 | 13.1.0                 | security headers; peer fastify ^5                                                              |
| prom-client     | ^15.1.3 | 15.1.3                 | Prometheus `/metrics` (per-instance registry)                                                  |
| pino-pretty     | ^13.1.3 | 13.1.3                 | dev-only pretty logs (pino ships with fastify)                                                 |
| mongodb         | ^7.5.0  | 7.5.0                  | official driver (P1-1 tenant store + `@vip/tenancy` `Collection<T>`); bundles its own TS types |
| jose            | ^6.2.4  | 6.2.4                  | JWT sign/verify (P1-2 `@vip/auth`); **pure-JS, zero deps, no build scripts**                   |

> **Build-free crypto (P1-2, ED-0023):** password hashing uses Node's built-in **scrypt** (no dep, no native addon) rather than argon2 (native build); JWT uses **jose** (pure-JS) rather than a native/heavier lib. Consistent with the project's ethos of avoiding native build-script approvals ([ED-0022](ENGINEERING_DECISION_LOG.md)).

> **Rejected (P1-1):** `@testcontainers/mongodb` for integration tests — it pulls native-build transitive deps (`ssh2`, `cpu-features`, `protobufjs`) that the supply-chain policy blocks and that would need build-script approval. Instead the tenant integration suite runs against the existing **dev-stack Mongo** via `MONGO_URI` and **skips gracefully** when unreachable ([ED-0022](ENGINEERING_DECISION_LOG.md)) — zero new build-script approvals.

## MLOps registry deps (verified 2026-07-27 · PyPI + Docker Hub)

Introduced by P0-5 registry bootstrap (`ai/mlops/`, `infra/docker/mlflow/`). Python deps pinned exactly (`==`); no lockfile yet (see Q-011).

| Package / Image | Pinned    | Registry latest | Notes                                             |
| --------------- | --------- | --------------- | ------------------------------------------------- |
| mlflow          | ==3.14.0  | 3.14.0          | tracking + Model Registry (server image + client) |
| dvc             | ==3.67.1  | 3.67.1          | Dataset Registry CLI                              |
| dvc-s3          | ==3.3.0   | 3.3.0           | DVC S3 (MinIO) remote driver                      |
| boto3           | ==1.43.56 | 1.43.56         | S3 client (MLflow artifacts + DVC)                |
| psycopg2-binary | ==2.9.12  | 2.9.12          | MLflow → Postgres backend driver (in image)       |
| postgres (img)  | 17        | 18              | **17 chosen** — see note                          |
| python (img)    | 3.12-slim | 3.14-slim       | 3.12 for broad ML-dep compatibility               |

Image build validated locally (`docker compose build mlflow`) and the full stack ran the end-to-end smoke test (log run → artifact to MinIO → register model → read back).

### Postgres 17 vs 18 · Python 3.12 vs 3.14 (deferred)

Postgres **18** is GA, but **17** is chosen for the MLflow metadata backend — the most widely-deployed current major, unquestionably compatible with `psycopg2-binary 2.9.12` + MLflow 3.x. 18's default-behaviour changes (e.g. checksums) are unvalidated against this stack; revisit via Q-008. Python base pinned **3.12** (not 3.14) for the same conservative ML-ecosystem compatibility reason.

## Major-version change notes (policy #5)

### Zod 3 → 4 (adopted)

Zod 4 required code changes, all applied in `@vip/contracts`:

- `z.string().uuid()` → **`z.uuid()`**; `z.string().datetime()` → **`z.iso.datetime()`** (top-level format API).
- `z.record(valueSchema)` → **`z.record(keySchema, valueSchema)`** (key schema now required).
- JSON Schema generation now uses Zod 4's **native `z.toJSONSchema()`** — the external `zod-to-json-schema` dependency was **removed**.
  Verified: build + 19 contract tests + typecheck + codegen all pass.

### TypeScript 7 → deferred, pinned 5.9.3 (see TD-1)

TS 7.0.2 is the registry `latest` and builds/tests/typechecks fine, **but `typescript-eslint@8.65` (latest) hard-refuses TS 7.0** (peer `<6.1.0`; TS≥7.1 support tracked in typescript-eslint#10940). Choosing TS 7 would disable type-aware linting (no-floating-promises, no-unsafe-*, consistent-type-imports) — an unacceptable gap for a foundation. Decision: pin the **latest stable 5.x (5.9.3)** so the full quality gate works today; adopt TS 7 via an ADR when typescript-eslint supports it. Recorded as **[TD-1](../../tracking/TECH-DEBT.md)**.

## Verification log

- `2026-07-27` Slice 1 (P0-2): installed with pnpm 11.17.0; `@vip/contracts` — **19 tests pass** (Vitest 4), typecheck clean (TS 5.9.3), **lint clean** (ESLint 10 + typescript-eslint 8.65), codegen emits 7 JSON Schemas (Zod 4 native). esbuild build script approved in `pnpm-workspace.yaml`.
- `2026-07-27` Slice 3 (P0-7): added fastify 5.10.0 + @fastify/helmet 13.1.0 + prom-client 15.1.3 (+ dev pino-pretty 13.1.3) for `@vip/service-identity`. Install clean (no peer conflicts); **19 service tests pass**, typecheck/lint/build green, live boot smoke-test OK.
- `2026-07-27` Slice 4 (P0-5): pinned mlflow 3.14.0, dvc 3.67.1, dvc-s3 3.3.0, boto3 1.43.56, psycopg2-binary 2.9.12; images postgres:17, python:3.12-slim. MLflow image built; full MLOps stack (MinIO+Postgres+MLflow+bucket bootstrap) launched and passed the end-to-end registry smoke test; 5 stdlib config unit tests pass.
- `2026-07-27` Slice 5 (P0-6): `@vip/config` added with **zero new dependencies** — `.env` loaded via Node's built-in `process.loadEnvFile()` (no `dotenv`); reuses existing `zod`. 14 tests pass; identity refactored onto it.
- `2026-07-28` Slice 7 (P1-2): added `jose 6.2.4` (pure-JS HS256 JWT, no native build) for `@vip/auth`; `@vip/permissions` + `@vip/service-gateway` added with no new external deps. Full gate green.
- `2026-07-28` Slice 8 (P1-3): **zero new external dependencies** — `@vip/crypto` (AES-256-GCM credential vaulting) uses only Node's built-in `node:crypto` (no argon2/libsodium/native build); `@vip/service-camera` reuses the existing fastify/mongodb/helmet/prom-client set. Camera contracts + config `crypto` group add no packages. 22 camera tests (incl. 4 real-Mongo), full gate green.
- `2026-07-28` Slice 9 (P1-4): added `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` **3.1096.0** (pure-JS, **no native build / no install scripts** — verified against the pnpm supply-chain policy) for `@vip/storage` (MinIO/S3 recordings + signed URLs). `@vip/service-media` reuses fastify/helmet/prom-client. The **RTSP decoder uses the ffmpeg BINARY** (spawned child process) — a runtime **system dependency**, deliberately NOT an npm package (avoids a native addon; installed via the OS / the dev-stack `media` compose profile). 20 media tests (incl. 2 real-MinIO) + 9 storage tests (incl. 2 real-MinIO); full gate green.
- `2026-07-28` Slice 10 (P1-6): **zero new npm dependencies** — the `ai/inference` runtime core + its entire 38-test suite are **Python stdlib-only** (transport on `http.server`, no FastAPI/uvicorn), matching the ai/mlops convention. HEAVY deps for the `onnx` backend only are pinned in `ai/inference/requirements.txt`: `onnxruntime==1.19.2`, `numpy==2.0.2`, `pillow==11.3.0`, `mlflow==3.14.0`, `boto3==1.43.56` (registry-verified; not installed for unit tests / the `stub` backend). `@vip/contracts` perception schemas add no packages. TS + Python gates green.
