# IMPLEMENTATION PROGRESS

> Slice-level implementation log. Program/phase status is canonical in [`tracking/PROGRESS.md`](../../tracking/PROGRESS.md); the roadmap in [`tracking/ROADMAP.md`](../../tracking/ROADMAP.md). This file records **what code/scaffolding actually shipped**, newest first.

## Phase 0 — Program Setup

### Slice 1 — Contracts foundation (P0-2) · 2026-07-27 · ✅

- Built `@vip/contracts` (schema-first, single source of integration truth):
  - `common/` — primitives (semver/uuid/iso-datetime/event-type/capability-id), tenant-context, API envelope.
  - `events/` — priority, event **envelope** (doc 09 §1), seed **event catalog** (doc 09 §2).
  - `capability/` — **descriptor** + **registry record** (doc 05 §2–§3).
  - `config/` — **configuration hierarchy** model + reference resolver (doc 06 §6, ADR-0014).
  - `scripts/generate-json-schema.ts` — emits JSON Schema via **Zod 4 native** `z.toJSONSchema()`.
- **Verified:** 19 contract tests pass (Vitest 4), typecheck clean (TS 5.9.3), lint clean (ESLint 10 + typescript-eslint 8.65), codegen produces 7 schemas.
- **Dependency work:** upgraded toolchain to latest stable (registry-verified); Zod 3→4 code changes applied; TS pinned 5.9.3 pending typescript-eslint TS7 support (TD-1). See [DEPENDENCIES.md](DEPENDENCIES.md).

### Slice 0 — Program & Continuity Setup · 2026-07-27 · ✅

- Stack decisions recorded: [ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md) NATS JetStream backbone (resolves ND-1), [ADR-0017](../adr/ADR-0017-fastify-control-plane.md) Fastify; TECH-STACK + docs 04/09/18 updated.
- AI-continuity system created: `docs/ai/*` (brain, how-to-continue, dev-rules, impl-guide, prompt-guide, commands, state/context/priorities/architecture).
- Project status system created: `docs/project/*` (this file + status/sprint/next/backlog/decisions/known-issues/tech-debt/arch-changes/timeline).
- Monorepo skeleton (P0-1): `pnpm-workspace.yaml`, root `package.json`, `turbo.json`, `tsconfig.base.json`, lint/format/editor config.
- Dev stack (P0-4): `infra/docker/docker-compose.dev.yml` (Mongo, Redis, MinIO, NATS/JetStream) + `.env.example`.
- Daily log: [`docs/daily/2026-07/2026-07-27.md`](../daily/2026-07/2026-07-27.md).

**Not yet built (next slices):** `packages/contracts` (P0-2), CI (P0-3), first service scaffold (P0-7), registry bootstrap (P0-5).
