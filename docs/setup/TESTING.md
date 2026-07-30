# Testing

Tests are split into two tiers so routine development never fails because infrastructure is missing.

## Tiers

| Tier            | Command                 | Needs infra?              | What                                                                    |
| --------------- | ----------------------- | ------------------------- | ----------------------------------------------------------------------- |
| **Unit**        | `pnpm test`             | ❌ No                     | Deterministic, in-memory. The default — run it anytime, including CI.   |
| **Integration** | `pnpm test:integration` | ✅ Yes (`pnpm dev:stack`) | Talks to real Mongo/MinIO. Verifies persistence, isolation, pagination. |

`pnpm test` **excludes** every `*integration.test.ts` file, so it is fully deterministic and needs no
Docker. Integration tests are named `*integration.test.ts` and run only via `pnpm test:integration`.

### Unit (default)

```bash
pnpm test                              # all packages (Turborepo)
pnpm --filter @vip/console test        # one package
pnpm --filter @vip/console test:watch  # watch mode
```

### Integration

```bash
pnpm dev:stack            # Mongo + MinIO must be up
pnpm test:integration     # runs the integration suites against the live stack
```

Integration suites **skip themselves cleanly** when their backing service is unreachable (a fast
connection probe), so `pnpm test:integration` is safe to run without the stack — it just reports the
suites as skipped rather than failing. With `pnpm dev:stack` up and the default `.env`, they connect
using the dev credentials and run for real.

## Quality gates

Run before committing (all must pass, no warnings):

```bash
pnpm typecheck          # tsc across every package
pnpm lint               # eslint
pnpm test               # unit tests
pnpm build              # tsc + vite build
pnpm check:imports      # architecture boundary enforcement (0 violations)
pnpm verify:contracts   # every consumer's schema exists in @vip/contracts
pnpm format:check       # prettier
```

## Python (inference runtime)

The Python vision workspace under `ai/` is managed separately (uv/pip) and is **not** part of
`pnpm test`. Run its suites with `pytest` from `ai/inference` / `ai/mlops` when working there.

## Notes

- Console component tests use MSW to mock the gateway, so they exercise real UI behaviour (loading /
  error / empty / success, permission gating) without a backend — the fastest way to validate the
  console.
- Integration test credentials default to the dev-stack values; override with `MONGO_URI` /
  `S3_ENDPOINT` + `AWS_*` for a non-default stack.
