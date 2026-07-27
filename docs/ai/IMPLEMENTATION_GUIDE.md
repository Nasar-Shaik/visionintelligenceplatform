# IMPLEMENTATION GUIDE

> How to build a slice correctly in this repo. Pairs with [DEVELOPMENT_RULES.md](DEVELOPMENT_RULES.md) and [HOW_TO_CONTINUE.md](HOW_TO_CONTINUE.md).

## Repo shape (where code goes)

```
services/    TS control/data-plane services (Fastify)      — see services/README.md
ai/          Python vision services (FastAPI) + capabilities — see ai/README.md
edge/        Edge agent runtime                              — see edge/README.md
packages/    Shared libs incl. contracts (source of truth)   — see packages/README.md
plugins/     Industry Packs & plugins (ALL vertical logic)   — see plugins/README.md
infra/       Docker/K8s/Terraform                            — see infra/README.md
tests/       Cross-service e2e/isolation/load/chaos/model    — see tests/README.md
tools/       Dev tooling, simulators, codegen                — see tools/README.md
```

## Service template (TS, Fastify) — the P0-7 shape

Internal layers (domain never imports transport):

```
service/
├── src/
│   ├── transport/     # Fastify routes/plugins, schema validation (from packages/contracts)
│   ├── application/   # use-cases / service layer
│   ├── domain/        # entities, invariants (no framework imports)
│   ├── adapters/      # repositories (Mongo), clients (NATS, Redis, MinIO)
│   └── index.ts       # bootstrap; registers /health /ready /metrics
├── test/              # unit + integration (Testcontainers)
└── README.md          # purpose/responsibilities/deps/run/test/arch refs
```

Every service: resolves tenant context, exposes `/health` `/ready` `/metrics`, emits events via NATS with the outbox pattern, and is entitlement/policy-aware.

## Capability template (Python) — future (P3)

Implements the capability contract ([05](../architecture/05-CAPABILITY-ARCHITECTURE.md)): `descriptor + init/process/health/dispose`; binds models via the Model Adapter Layer ([08 §8a](../architecture/08-AI-ML-PLATFORM.md)); emits normalized events; self-registers in the Capability Registry.

## The build loop (per slice)

1. **Review** architecture sections relevant to the slice + the task's dependencies.
2. **Contracts first** — add/extend schemas in `packages/contracts`; generate types.
3. **Implement** against the contract; keep the layers; no vertical logic in core.
4. **Test** — unit + integration (+ scenario/regression as relevant); isolation test for new data paths; contract tests.
5. **Observe** — health/metrics/logs.
6. **Document** — service `README.md`, update `docs/project/*` + `tracking/*`, append the daily log.
7. **Commit** per CONTRIBUTING; stop; report; await approval for the next slice.

## Testing expectations (every feature)

Unit · Integration · Scenario · Regression · Health checks · Docker test (runs in the compose stack) · Manual testing guide · Expected results · Failure cases · Performance notes. See [tests/README.md](../../tests/README.md).

## Definition of Done

See [HOW_TO_CONTINUE.md §3](HOW_TO_CONTINUE.md) and [CONTRIBUTING.md §4](../../CONTRIBUTING.md).
