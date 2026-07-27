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

| Package         | Pinned  | Registry latest stable | Notes                                          |
| --------------- | ------- | ---------------------- | ---------------------------------------------- |
| fastify         | ^5.10.0 | 5.10.0                 | service framework (ADR-0017)                   |
| @fastify/helmet | ^13.1.0 | 13.1.0                 | security headers; peer fastify ^5              |
| prom-client     | ^15.1.3 | 15.1.3                 | Prometheus `/metrics` (per-instance registry)  |
| pino-pretty     | ^13.1.3 | 13.1.3                 | dev-only pretty logs (pino ships with fastify) |

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
