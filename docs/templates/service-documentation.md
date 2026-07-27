<!-- Copy to services/<name>/README.md (or packages/plugins/capabilities). Every field is required. -->

# @vip/<name>

_One-line description + whether it is a template/reference._

> **Phase status:** _what exists now vs deferred._

## Purpose

_What this component is for._

## Responsibilities

_What it owns (data, APIs, published/consumed events) — align with docs/architecture/23 for services._

## Architecture Position

_Control or data plane; bounded context; where it sits in the dependency graph._

## Layering

```
src/
├── config/       env / configuration
├── domain/       pure entities/invariants (no framework, no I/O)
├── application/  use-cases
├── adapters/     repositories & clients (I/O only)
└── transport/    framework wiring (routes/plugins)
```

_Call direction: transport → application → domain; adapters implement ports. Enforced by `pnpm check:imports`._

## Dependencies

_Internal (workspace) + external (registry-verified, see DEPENDENCIES.md)._

## Configuration

_Env table: Var · Default · Notes._

## Run Instructions

```bash
pnpm --filter @vip/<name> dev
pnpm --filter @vip/<name> build
pnpm --filter @vip/<name> start
```

## Testing

```bash
pnpm --filter @vip/<name> test
pnpm --filter @vip/<name> typecheck
pnpm --filter @vip/<name> lint
```

## Extension Points

_Where/how this is extended (adapters, plugins, capabilities, hooks)._

## References

_Architecture sections + ADRs._
