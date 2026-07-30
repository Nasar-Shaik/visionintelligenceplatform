# Run VIP Locally

The clean-clone quickstart. For daily commands see
[docs/setup/DAILY_DEVELOPMENT.md](docs/setup/DAILY_DEVELOPMENT.md); for everything else, the
[docs/setup](docs/setup/README.md) guides.

## Prerequisites

- **Node ≥ 22**, **pnpm ≥ 10** (`corepack enable && corepack prepare pnpm@11.17.0 --activate`)
- **Docker + Docker Compose**

## From a clean clone

```bash
pnpm install
cp .env.example .env

pnpm dev:stack        # 1. infrastructure (Mongo, Redis, MinIO, NATS) via Docker
pnpm seed             # 2. dev tenant + admin + sample data (idempotent)
pnpm dev:all          # 3. all backend services + the Operations Console
```

Then open **http://localhost:5173** and log in — tenant **`tnt_dev`**, password **`123456`**:

| Email              | Role                     |
| ------------------ | ------------------------ |
| `admin@vip.dev`    | `admin` (everything)     |
| `operator@vip.dev` | `operator` (ack/resolve) |
| `viewer@vip.dev`   | `viewer` (read-only)     |
| `owner@vip.dev`    | `owner`                  |

That's it — the dashboard, events, rules, incidents, and alerts are all populated by the seed.

## What each command does

| Command                | Result                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`         | Installs the pnpm workspace                                                                                                  |
| `cp .env.example .env` | Local dev config (weak dev secrets; never commit real ones)                                                                  |
| `pnpm dev:stack`       | Starts Docker infra (`pnpm dev:stack:down` to stop)                                                                          |
| `pnpm seed`            | Seeds a tenant, admin, camera, rule, event, incident, alert into MongoDB                                                     |
| `pnpm dev:all`         | Builds packages, then runs 9 services + the console (watched) on the ports in [RUN_FULL_STACK](docs/setup/RUN_FULL_STACK.md) |

## Verify your setup (optional, no infra needed)

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm check:imports && pnpm verify:contracts && pnpm format:check
```

## Troubleshooting

See the table in [docs/setup/RUN_FULL_STACK.md](docs/setup/RUN_FULL_STACK.md#troubleshooting). Most
common: a service can't reach Mongo → run `pnpm dev:stack` first; login 401 → run `pnpm seed`.
