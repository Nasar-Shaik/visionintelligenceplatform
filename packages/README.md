# packages/ — Shared Libraries

Cross-cutting libraries shared by services, edge, web, and mobile. **No industry logic** (Law 1).

## Layout
```
contracts/     THE source of integration truth: schemas (Zod→JSON Schema/OpenAPI), Protobuf,
               event catalog, capability descriptors, plugin manifests. Types are GENERATED from here.
plugin-sdk/    Typed extension-point interfaces, manifest schema, DI helpers, plugin test harness
permissions/   RBAC+ABAC policy module reused by every service
api-client/    Generated TS SDK for the public API
ui/            Shared React components (Shadcn-based), FeatureGate/PermissionGate
event-schema/  Event envelope + taxonomy helpers (thin, over contracts)
config/ i18n/ utils/ mobile-core/   Shared config, localization, utilities, mobile foundation
```

## Rules
- `contracts/` has **no runtime dependencies** so anything can depend on it. Contracts are versioned (semver); breaking change → major + ADR.
- Never hand-maintain a type that can be generated from a contract.

See [03-ARCHITECTURE-PRINCIPLES](../docs/architecture/03-ARCHITECTURE-PRINCIPLES.md), [20-EXTENSIBILITY](../docs/architecture/20-EXTENSIBILITY.md), [21-API-ARCHITECTURE](../docs/architecture/21-API-ARCHITECTURE.md).
