# Slice 002 — CI quality gate · Manual Test Scenarios

- **Target:** the CI pipeline + import-graph enforcement + contract-testing harness.
- **Prereqs:** `pnpm install`.

## Positive Tests

### T-1 Full local gate is green

- **Steps:** run each:
  ```
  pnpm format:check
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm build
  pnpm check:imports
  pnpm verify:contracts
  ```
- **Expected:** each exits 0; `check:imports` reports 0 violations; `verify:contracts` reports 7 schemas.
- **Pass Criteria:** all seven commands succeed. **Result:** ☐ Pass ☐ Fail

### T-2 CI workflow present

- **Steps:** inspect `.github/workflows/ci.yml`.
- **Expected:** jobs quality, test, build, import-graph, contracts, security, dependency-audit, ci-summary.
- **Pass Criteria:** all jobs defined; `ci-summary` rolls them up. **Result:** ☐ Pass ☐ Fail

## Negative Tests (prove enforcement bites)

### T-3 Deep import is rejected

- **Steps:** temporarily add `import x from '@vip/contracts/src/index'` in a package file, run `pnpm check:imports`, then revert.
- **Expected:** fails with a `noDeepImports` violation, exit 1.
- **Pass Criteria:** violation reported; clean again after revert. **Result:** ☐ Pass ☐ Fail

### T-4 Core→plugin import is rejected

- **Steps:** temporarily create a dummy `plugins/x` and import it from a `packages/*` file, run `pnpm check:imports`, then revert.
- **Expected:** fails with `noCoreToPlugin`.
- **Pass Criteria:** violation reported. **Result:** ☐ Pass ☐ Fail

### T-5 Secret scanning ignores the example file

- **Steps:** confirm `.gitleaks.toml` allowlists `.env.example` and `change_me_dev_only`.
- **Expected:** dev placeholders are not flagged as leaks.
- **Pass Criteria:** allowlist present. **Result:** ☐ Pass ☐ Fail

## Manual Validation

- On first push to GitHub, confirm the `security` job (gitleaks + semgrep) runs green (Risk R-003).

## Performance / Failure

➖ N/A this slice.

## Summary

- **Automated coverage:** the gate itself; import-graph negative-tested on all 4 rules.
- **Overall Pass Criteria:** T-1…T-5 pass; T-3/T-4 confirm enforcement.
