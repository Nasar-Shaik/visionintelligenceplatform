# COMMON COMMANDS

> Canonical commands. As tooling lands each phase, keep this current. (Monorepo tooling scaffolded in Phase 0; some commands become active once `package.json` scripts exist.)

## Prerequisites

- Node.js ≥ 20 (see `.nvmrc`), **pnpm** ≥ 9, **Docker** + Docker Compose, Python ≥ 3.11 (vision).

## Dev environment (backing services)

```bash
# Start the local stack: MongoDB, Redis, MinIO, NATS (JetStream)
docker compose -f infra/docker/docker-compose.dev.yml up -d

# Status / logs / stop
docker compose -f infra/docker/docker-compose.dev.yml ps
docker compose -f infra/docker/docker-compose.dev.yml logs -f nats
docker compose -f infra/docker/docker-compose.dev.yml down
```

Default **host** endpoints (dev) use a non-standard `4xxxx` range to avoid clashing with other local Docker projects (e.g. MERN on 27017/6379/9000): Mongo `47017`, Redis `46379`, MinIO `49000`/console `49001`, NATS `44222`/monitoring `48222`. Override any via `.env`. Credentials in `.env` (copy from `.env.example`).

## Monorepo (once scripts exist — P0-1/P0-2 onward)

```bash
pnpm install                 # install workspace deps
pnpm -w build                # build all packages (Turborepo)
pnpm -w lint                 # eslint
pnpm -w format               # prettier
pnpm -w test                 # unit tests (Vitest)
pnpm --filter <pkg> <script> # run a script in one package
```

## Python vision (once `ai/` is set up — P3)

```bash
uv sync            # or: python -m venv .venv && pip install -e .
pytest             # unit tests
uvicorn app:app --reload   # run a FastAPI service
```

## Git (see CONTRIBUTING.md)

```bash
git checkout -b feature/<scope>-<desc>
git commit -m "feat(<scope>): <summary>"    # Conventional Commits
git push origin <branch>
```

## Quality gate before commit

`pnpm -w lint && pnpm -w test` (TS) · `pytest` (Python) · docs + trackers + daily log updated.
