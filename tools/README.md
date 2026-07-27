# tools/ — Developer Tooling

Internal utilities that are not shipped as product.

## Layout

```
import-graph/       Architecture-boundary enforcement — fails CI on forbidden imports (LIVE)
contracts/          Contract-testing harness — verifies generated schema artifacts (LIVE)
camera-simulator/   Synthetic RTSP/RTMP + event generators for scale/stress testing
codegen/            Contract → types/SDK/OpenAPI/Protobuf generators (invoked by CI)
scaffolding/        Templates for new service / capability / plugin (enforce conventions)
data-tools/         Dataset prep, labeling helpers, benchmark set builders (feed ai/mlops)
local-dev/          Seed scripts, demo tenant + sample footage, dev bootstrap
```

## Live tools (Phase 0)

- **`import-graph/`** — `pnpm check:imports` (or `node tools/import-graph/check-imports.mjs`). Enforces the boundaries in [`import-graph/boundaries.json`](import-graph/boundaries.json), which mirror [docs/architecture/22](../docs/architecture/22-BOUNDED-CONTEXTS.md) & [23](../docs/architecture/23-SERVICE-OWNERSHIP.md): no deep imports, no core→plugin, no cross-service internals, no dependency cycles. Zero-dependency Node script. Editing a rule is an architecture change → record an ADR.
- **`contracts/`** — `pnpm verify:contracts`. The contract-testing harness gate: after `@vip/contracts` codegen, asserts the required JSON Schema artifacts exist, parse, and target draft 2020-12. The seam where consumer-driven contract tests plug in as services arrive (ADR-0015).

Both run in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Conventions

- Scaffolding templates encode the Constitution's conventions so new components start compliant (layering, /health-/ready-/metrics, contract-first, tenant guard).
- The camera simulator is the backbone of load/stress/scale suites in [tests/](../tests/).

See [docs/README](../docs/README.md).
