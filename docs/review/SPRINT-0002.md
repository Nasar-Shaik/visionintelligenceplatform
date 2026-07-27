# SPRINT-0002 — CI quality gate (P0-3)

- **Date:** 2026-07-27 · **Phase/Slice:** Phase 0 · Slice 2 · **Branch:** feature/v1 · **Engineer:** Claude
- _Retro-documented under the governance framework instituted in Slice 3._

## Objective

Stand up the CI quality gate: build/test/lint/format/typecheck, security scanning, import-graph boundary enforcement, and a contract-testing harness.

## Completed Work

- `.github/workflows/ci.yml` — 8 jobs (quality, test, build, import-graph, contracts, security, dependency-audit, ci-summary) over a shared composite setup action.
- `tools/import-graph/` — zero-dep boundary scanner + declarative `boundaries.json`; negative-tested on all 4 rules.
- `tools/contracts/verify-schemas.mjs` — contract-testing harness gate.
- `.gitleaks.toml`, `.github/dependabot.yml` (actions-only), repo-wide Prettier baseline (separate `style:` commit).

## Architecture Compliance

Import-graph rules **encode** already-ratified boundaries (docs 22/23, ADR-0010) — no new architecture. Fixed a self-edge false-cycle found during negative testing.

## Definition of Done

Impl ✅ · Docs ✅ (tools READMEs) · Unit tests ✅ (contracts 19) · Lint/format/build ✅ · Dependency review ✅ (Dependabot actions-only) · Security ✅ (gitleaks/semgrep wired) · Docker ➖ (no service) · Architecture Review ⏳ PENDING.

## Files Created / Modified

Created: `.github/workflows/ci.yml`, `.github/actions/setup/action.yml`, `.github/dependabot.yml`, `.gitleaks.toml`, `tools/import-graph/*`, `tools/contracts/*`. Modified: `package.json` (scripts), `.gitignore`, `tools/README.md`, tracking + docs; repo-wide format baseline.

## Risks / Technical Debt / Known Issues

Risks: **R-003** (scanners run GitHub-side, unproven on push), **R-007** (advisory audit). Debt: TD-1 (carried). Issues: none.

## Commands Executed

`pnpm format` · `pnpm format:check` · `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build` · `pnpm check:imports` · `pnpm verify:contracts` · import-graph negative tests (4 scenarios).

## Tests Performed / Results

Local gate green; import-graph 0 violations (+ 4 negative tests confirm enforcement); verify:contracts 7/7. See [slice-002](../testing/slice-002.md).

## Breaking Changes

None.

## Next Sprint Recommendation

Proceed to P0-7 first service scaffold. **Status:** (historical).

## Architect Review

> PENDING ARCHITECT REVIEW
