# SPRINT-0001 — @vip/contracts schema-first foundation (P0-2)

- **Date:** 2026-07-27 · **Phase/Slice:** Phase 0 · Slice 1 · **Branch:** feature/v1 · **Engineer:** Claude
- _Retro-documented under the governance framework instituted in Slice 3._

## Objective

Build `@vip/contracts`, the single source of integration truth: versioned Zod 4 schemas + inferred types + JSON-Schema codegen.

## Completed Work

- Schemas: event envelope/catalog, capability descriptor + registry record, config hierarchy + resolver, tenant context, API envelope, primitives.
- JSON Schema via Zod 4 native `z.toJSONSchema()` (removed `zod-to-json-schema`).
- 19 contract tests; `docs/project/DEPENDENCIES.md`.

## Architecture Compliance

Contract-first (Law 4). No architecture change; two dependency decisions recorded (Zod 3→4 adopted; TS 7 deferred → 5.9.3).

## Definition of Done

Impl ✅ · Docs ✅ · README ✅ · Unit tests ✅ (19) · Dependency review ✅ · Lint/format/build ✅ · Docker ➖ (types pkg) · Architecture Review ⏳ PENDING.

## Files Created / Modified

Created: `packages/contracts/**`, `docs/project/DEPENDENCIES.md`. Modified: root `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.nvmrc`, tracking, `tracking/TECH-DEBT.md` (TD-1).

## Risks / Technical Debt / Known Issues

Debt: **TD-1** (TS 5.9.3 pin). Risks: R-001, R-002. Issues: none.

## Commands Executed

`pnpm install` · `pnpm --filter @vip/contracts test` · `… typecheck` · `… lint` · `… codegen` · `npm view <pkg> version`.

## Tests Performed / Results

`vitest run` → 4 files / **19 passed**; typecheck + lint clean; codegen 7 schemas. See [slice-001](../testing/slice-001.md).

## Breaking Changes

None (new package).

## Next Sprint Recommendation

Proceed to P0-3 CI. **Status:** (historical).

## Architect Review

> PENDING ARCHITECT REVIEW
