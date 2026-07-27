# Slice 000 — Program setup & dev stack · Manual Test Scenarios

- **Target:** monorepo scaffold + local Docker dev stack (no application code).
- **Prereqs:** Node 24, pnpm 11, Docker Desktop.

## Positive Tests

### T-1 Install succeeds

- **Steps:** `pnpm install`
- **Expected:** completes; lockfile satisfied.
- **Pass Criteria:** exit 0. **Result:** ☐ Pass ☐ Fail

### T-2 Dev-stack compose validates

- **Steps:** `docker compose -f infra/docker/docker-compose.dev.yml config`
- **Expected:** prints a resolved config, no errors.
- **Pass Criteria:** exit 0. **Result:** ☐ Pass ☐ Fail

### T-3 Dev stack launches (optional, needs Docker running)

- **Steps:** `pnpm dev:stack` then `docker compose -f infra/docker/docker-compose.dev.yml ps`
- **Expected:** Mongo (47017), Redis (46379), MinIO (49000/49001), NATS (44222/48222) become healthy.
- **Pass Criteria:** all services `healthy`. **Result:** ☐ Pass ☐ Fail
- **Teardown:** `pnpm dev:stack:down`

## Negative / Edge

### T-4 Ports avoid MERN conflicts

- **Steps:** with your MERN projects running, launch the dev stack.
- **Expected:** no port collision (VIP uses the 4xxxx range).
- **Pass Criteria:** stack starts alongside existing projects. **Result:** ☐ Pass ☐ Fail

## Manual Validation

- Confirm `.env.example` contains only `change_me_dev_only` placeholders (no real secrets).
- Confirm `docs/ai/` + `docs/project/` continuity docs render and cross-link.

## Performance / Failure

➖ N/A — no runtime code this slice.

## Summary

- **Automated coverage:** none (infrastructure slice); validation is via compose config + install.
- **Overall Pass Criteria:** T-1, T-2 pass; T-3/T-4 pass when Docker is available.
