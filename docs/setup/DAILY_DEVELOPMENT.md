# Daily Development

The commands you run every day. One screen. (First time? See [README](README.md).)

## Start working

```bash
pnpm dev:stack     # infra (Mongo/Redis/MinIO/NATS) — leave running in the background
pnpm dev:all       # all 9 services + the console, watched/reloading
```

Open the console: **http://localhost:5173** · Log in with the seeded admin (see below).

## Seed / reset dev data (idempotent)

```bash
pnpm seed          # tenant + admin + sample camera/rule/event/incident/alert
```

Default login:

| Field    | Value           |
| -------- | --------------- |
| Tenant   | `tnt_dev`       |
| Email    | `admin@vip.dev` |
| Password | `DevPassw0rd!`  |

## Check your work (before committing)

```bash
pnpm typecheck
pnpm lint
pnpm test          # deterministic unit tests — no infra needed
pnpm format:check
pnpm check:imports
```

## Narrow the scope

```bash
pnpm --filter @vip/console dev            # just the web app  (alias: pnpm dev:web)
pnpm dev:services                         # all services, no console
pnpm --filter @vip/service-rules dev      # a single service
pnpm --filter @vip/console test           # one package's tests
```

## Stop

```bash
# Ctrl-C the dev:all terminal, then:
pnpm dev:stack:down
```

## When to reach for more

- Full-stack details, ports, troubleshooting → [RUN_FULL_STACK](RUN_FULL_STACK.md)
- Test tiers (unit vs integration) → [TESTING](TESTING.md)
- Demo walkthrough / what the seed creates → [DEMO](DEMO.md)
