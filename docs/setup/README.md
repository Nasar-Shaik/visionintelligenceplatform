# Setup & Developer Guides

Start here. These guides are split by task so each stays short and every command in them is real and
verified.

| Guide                                         | Use it when                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| **[DAILY_DEVELOPMENT](DAILY_DEVELOPMENT.md)** | Every day — the handful of commands you actually run                           |
| **[RUN_FULL_STACK](RUN_FULL_STACK.md)**       | Running the whole platform locally (services, ports, gateway, troubleshooting) |
| **[TESTING](TESTING.md)**                     | Running tests + quality gates; unit vs. integration                            |
| **[DEMO](DEMO.md)**                           | Seeding data and walking through the console end-to-end                        |

The canonical clean-clone quickstart also lives at the repo root: **[RUN_LOCAL.md](../../RUN_LOCAL.md)**.

## Prerequisites

- **Node.js ≥ 22** · **pnpm ≥ 10** (`corepack enable && corepack prepare pnpm@11.17.0 --activate`)
- **Docker + Docker Compose** (local infrastructure)
- Optional: **ffmpeg** (RTSP ingestion), **Python 3.11+** (inference-runtime tests)

## First-time setup

```bash
pnpm install
cp .env.example .env       # dev secrets/ports (weak dev defaults — never commit real ones)
```

## The four-command workflow

```bash
pnpm dev:stack             # 1. infra (Docker): Mongo, Redis, MinIO, NATS, …
pnpm seed                  # 2. create a dev tenant + admin + sample data
pnpm dev:all               # 3. all services + the console
# 4. open http://localhost:5173 and log in (tnt_dev / admin@vip.dev / DevPassw0rd!)
```

> `pnpm build` runs automatically as a dependency of `dev:all` (Turborepo builds workspace packages
> first). Run it explicitly if you only want to compile: `pnpm build`.
