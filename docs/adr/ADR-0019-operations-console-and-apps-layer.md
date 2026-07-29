# ADR-0019 — Operations Console & `apps/` workspace layer

- **Status:** Proposed
- **Date:** 2026-07-29
- **Deciders:** Principal Architect (productization directive) + development
- **Touches:** workspace layout (`pnpm-workspace.yaml`); import-graph boundary policy (`tools/import-graph/boundaries.json`, codifies [22]/[23]); frontend technology (new to [reference/TECH-STACK]); relates to [ED-0030]. Detailed plan: [phase2/OPERATIONS_CONSOLE](../architecture/phase2/OPERATIONS_CONSOLE.md), [phase2/DESIGN_SYSTEM](../architecture/phase2/DESIGN_SYSTEM.md).

## Context

Productization needs the platform's first frontend — a SOC Operations Console. It is a **client of the
gateway**, not a bounded context. The monorepo has no `apps/` layer and the import-graph has no notion
of a UI application, so introducing one is an architecturally-significant boundary decision.

## Decision

1. **Add an `apps/*` workspace glob** with `apps/console` as the first app.
2. **Add an import-graph `app` layer**: an app **may import shared `packages/*`** (notably
   `@vip/contracts` for types) but **must NOT import services or plugins**, and **nothing may import an
   app**. Enforced by `check:imports` alongside the existing rules.
3. **Frontend stack (Architect-mandated):** React 19 · TypeScript · Vite · Tailwind CSS v4 (+ Tailwind
   MCP) · shadcn/ui · Redux Toolkit (client state) · TanStack Query (server state) · React Router ·
   Lucide · Recharts · React Hook Form + Zod. Types are derived from `@vip/contracts` (one source of
   truth).
4. **Design-system-first**: dark SOC tokens + primitives before pages.

## Alternatives considered

- **UI inside a service** — rejected: a frontend is not a bounded context; the `apps/` layer keeps it a
  pure gateway client and independently deployable.
- **App imports service code for types** — rejected: deep coupling; it imports `@vip/contracts` only.
- **A different data/state stack** (Zustand, RTK Query, MUI/AntD) — rejected: the Architect mandated the
  stack above; shadcn/Tailwind give a controllable dark theme with no runtime lock-in.
- **No new import-graph layer** — rejected: without it, a UI could import service internals and erode
  the boundaries the platform depends on.

## Consequences

- **Positive:** the console cannot reach into service internals (boundary-enforced); one source of API
  types; a mainstream, isolated stack; the core stays untouched.
- **Cost:** a new CI `console` job (typecheck/lint/test/build) + import-graph enforcement of the `app`
  layer; frontend deps live under `apps/console` only.
- **Follow-ups:** on acceptance, scaffold `apps/console` (P2-1.0) and record deps in DEPENDENCIES.

## Compliance

Upholds bounded contexts, loose coupling, API-first (thin gateway client), and Law 1 (UI carries no
industry logic). **No frozen architecture doc (01–28) changes.** Proposed — implementation blocked until
ratified.
