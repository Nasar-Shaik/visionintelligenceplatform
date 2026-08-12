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

Then open **http://localhost:5173** and log in:

| Field        | Value                                                |
| ------------ | ---------------------------------------------------- |
| **Tenant**   | `tnt_dev` — ⚠️ the tenant **id**, not the slug `dev` |
| **Password** | `123456` — every seeded account shares it            |

| Email              | Role                     |
| ------------------ | ------------------------ |
| `admin@vip.dev`    | `admin` (everything)     |
| `operator@vip.dev` | `operator` (ack/resolve) |
| `viewer@vip.dev`   | `viewer` (read-only)     |
| `owner@vip.dev`    | `owner`                  |

That's it — the dashboard, events, rules, incidents, and alerts are all populated by the seed.

⛔ **Dev only.** `tools/seed/seed.ts` refuses to seed these under `NODE_ENV=production`: a
`SEED_PASSWORD` of 12+ characters is required and the development default is rejected outright.

### ⚠️ Use `localhost`, not `127.0.0.1`

Vite sets no `host`, so it binds **IPv6 localhost only**. `http://127.0.0.1:5173` is refused while
`http://localhost:5173` serves normally — the same page, one address dead:

```
http://127.0.0.1:5173  →  connection refused
http://localhost:5173  →  200
```

Run `pnpm --filter @vip/console dev -- --host` if you need both.

### Is it actually up?

⛔ A login that fails is usually a **dead gateway, not a wrong password** — the console is a static
page and loads fine with every service down, and `vite.config.ts` proxies `/api` to `:8080`. Check
the tier below the console before retyping credentials:

```bash
docker compose -f infra/docker/docker-compose.dev.yml ps   # infra: expect containers running
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/health   # gateway: expect 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173          # console: expect 200
```

| Symptom                                    | Cause                                        |
| ------------------------------------------ | -------------------------------------------- |
| Console loads, login says invalid          | gateway down (`000` above) → `pnpm dev:all`  |
| Gateway up, login 401                      | not seeded → `pnpm seed`                     |
| Nothing on 5173                            | console not started, or you used `127.0.0.1` |
| Ports 3000/3001/4000 answer but look wrong | ⚠️ another project on this machine, not VIP  |

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
