# @vip/contracts

**The single source of integration truth** for the Vision Intelligence Platform. Versioned [Zod](https://zod.dev) schemas + inferred TypeScript types for events, capabilities, configuration, and API envelopes. JSON Schema / OpenAPI are **generated** from these — never hand-maintained (Law 4, contract-first).

## Purpose

Every service, capability, plugin, and SDK integrates through these contracts. If it crosses a boundary, its shape is defined here first, then implemented. Breaking a published contract requires a major version bump + an ADR ([Constitution §7](../../docs/00-ENGINEERING-CONSTITUTION.md)).

## Responsibilities

- Define the **event envelope** + priority + catalog ([docs/architecture/09](../../docs/architecture/09-EVENT-PLATFORM.md)).
- Define the **capability descriptor** + registry record ([05](../../docs/architecture/05-CAPABILITY-ARCHITECTURE.md)).
- Define the **configuration hierarchy** model + reference resolver ([06 §6](../../docs/architecture/06-MULTI-TENANT-SAAS.md), [ADR-0014](../../docs/adr/ADR-0014-configuration-hierarchy.md)).
- Define the **tenant context** ([06 §2](../../docs/architecture/06-MULTI-TENANT-SAAS.md)) and **API envelope** ([21](../../docs/architecture/21-API-ARCHITECTURE.md)).

## Folder structure

```
src/
├── common/      primitives (semver/uuid/ids), tenant-context, api-envelope
├── events/      priority, envelope, catalog
├── capability/  descriptor + registry record
├── config/      configuration hierarchy + resolver
└── index.ts     barrel export
scripts/generate-json-schema.ts   → emits generated/*.schema.json
test/            contract tests (Vitest)
```

## Dependencies

`zod` (v4 — uses the native `z.toJSONSchema()`; no external JSON-Schema converter). No runtime dependency on any other package (so anything may depend on this — Constitution §6). Pinned versions & rationale: [docs/project/DEPENDENCIES.md](../../docs/project/DEPENDENCIES.md).

## Run / build

```bash
pnpm --filter @vip/contracts build       # tsc → dist/
pnpm --filter @vip/contracts codegen      # emit generated/*.schema.json
pnpm --filter @vip/contracts typecheck
```

## Testing

```bash
pnpm --filter @vip/contracts test         # Vitest contract tests
```

Tests assert each schema accepts valid inputs, rejects invalid ones, enforces tenant presence, bounds confidence, resolves config precedence/locking, and keeps the event catalog consistent.

## Architecture references

[00 §7 versioning](../../docs/00-ENGINEERING-CONSTITUTION.md) · [05 capabilities](../../docs/architecture/05-CAPABILITY-ARCHITECTURE.md) · [06 §6 config](../../docs/architecture/06-MULTI-TENANT-SAAS.md) · [09 events](../../docs/architecture/09-EVENT-PLATFORM.md) · [21 API](../../docs/architecture/21-API-ARCHITECTURE.md) · [03 contract testing](../../docs/architecture/03-ARCHITECTURE-PRINCIPLES.md).

## Future extension points

Add: connector contracts ([25](../../docs/architecture/25-CONNECTOR-PLATFORM.md)), model-adapter contract ([08 §8a](../../docs/architecture/08-AI-ML-PLATFORM.md)), workflow/rule DSL schemas ([10](../../docs/architecture/10-RULE-ENGINE.md)/[11](../../docs/architecture/11-WORKFLOW-ENGINE.md)), plugin manifest ([20](../../docs/architecture/20-EXTENSIBILITY.md)), Protobuf for gRPC/NATS payloads. Each is additive and versioned.
