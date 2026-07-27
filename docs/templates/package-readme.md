<!-- Copy to a package/plugin root as README.md. For services use service-documentation.md instead. -->

# @vip/<name>

_One-line description._

## Purpose

_What this package/plugin provides and why it exists._

## Responsibilities

_What it owns; what it deliberately does not do._

## Architecture Position

_Layer (shared/plugin), bounded context, who consumes it. For plugins: the extension point it implements and the rule that it must never import core internals._

## Dependencies

_Internal (workspace) + external (registry-verified — see [DEPENDENCIES](../../docs/project/DEPENDENCIES.md))._

## Configuration

_Any config/env, or "none"._

## Usage / Run

```bash
pnpm --filter @vip/<name> build
pnpm --filter @vip/<name> test
```

## Extension Points

_How this is extended, or "none"._

## References

_Architecture sections + ADRs._
