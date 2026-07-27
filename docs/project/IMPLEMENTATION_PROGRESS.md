# IMPLEMENTATION PROGRESS

> Slice-level implementation log. Program/phase status is canonical in [`tracking/PROGRESS.md`](../../tracking/PROGRESS.md); the roadmap in [`tracking/ROADMAP.md`](../../tracking/ROADMAP.md). This file records **what code/scaffolding actually shipped**, newest first.

## Phase 0 — Program Setup
### Slice 0 — Program & Continuity Setup · 2026-07-27 · ✅
- Stack decisions recorded: [ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md) NATS JetStream backbone (resolves ND-1), [ADR-0017](../adr/ADR-0017-fastify-control-plane.md) Fastify; TECH-STACK + docs 04/09/18 updated.
- AI-continuity system created: `docs/ai/*` (brain, how-to-continue, dev-rules, impl-guide, prompt-guide, commands, state/context/priorities/architecture).
- Project status system created: `docs/project/*` (this file + status/sprint/next/backlog/decisions/known-issues/tech-debt/arch-changes/timeline).
- Monorepo skeleton (P0-1): `pnpm-workspace.yaml`, root `package.json`, `turbo.json`, `tsconfig.base.json`, lint/format/editor config.
- Dev stack (P0-4): `infra/docker/docker-compose.dev.yml` (Mongo, Redis, MinIO, NATS/JetStream) + `.env.example`.
- Daily log: [`docs/daily/2026-07/2026-07-27.md`](../daily/2026-07/2026-07-27.md).

**Not yet built (next slices):** `packages/contracts` (P0-2), CI (P0-3), first service scaffold (P0-7), registry bootstrap (P0-5).
