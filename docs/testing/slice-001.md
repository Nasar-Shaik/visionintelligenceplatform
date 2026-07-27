# Slice 001 — @vip/contracts · Manual Test Scenarios

- **Target:** the schema-first contracts package (Zod 4 + JSON-Schema codegen).
- **Prereqs:** `pnpm install`.

## Positive Tests

### T-1 Contract tests pass

- **Steps:** `pnpm --filter @vip/contracts test`
- **Expected:** 4 files, 19 tests, all pass.
- **Pass Criteria:** exit 0, 19 passed. **Result:** ☐ Pass ☐ Fail

### T-2 Types compile

- **Steps:** `pnpm --filter @vip/contracts typecheck`
- **Expected:** no errors.
- **Pass Criteria:** exit 0. **Result:** ☐ Pass ☐ Fail

### T-3 JSON Schema generation

- **Steps:** `pnpm --filter @vip/contracts codegen` then `ls packages/contracts/generated`
- **Expected:** 7 `*.schema.json` files (event-envelope, event-catalog-entry, capability-descriptor, capability-registry-record, tenant-context, api-error, config-node).
- **Pass Criteria:** 7 valid JSON Schema files, draft 2020-12. **Result:** ☐ Pass ☐ Fail

## Negative / Edge

### T-4 Invalid event envelope is rejected

- **Steps:** in a Node REPL, `import { EventEnvelope } from '@vip/contracts'` and parse an object missing `tenantId`.
- **Expected:** `EventEnvelope.safeParse(...)` returns `success:false`.
- **Pass Criteria:** validation fails with a field error. **Result:** ☐ Pass ☐ Fail

## Manual Validation

- Open a generated schema and confirm `$schema` targets `2020-12`.

## Performance / Failure

➖ N/A — pure types/validation package.

## Summary

- **Automated coverage:** 19 vitest tests + codegen.
- **Overall Pass Criteria:** T-1…T-4 pass.
