# Architectural Constraints

> **Hard rules future engineers (human or AI) must never violate.** These encode the frozen v1.0 architecture and the Engineering Constitution. A change to any constraint requires an [ADR](../adr/) — not a code review comment.
>
> Many of these are **machine-enforced**; the enforcement mechanism is named so you know what will catch a violation.

## Core design (the Laws)

1. **No industry/customer logic in core.** Industries, connectors, and models are plugins. Core packages/services stay vertical-agnostic (Law 1). — _enforced: `check:imports` noCoreToPlugin; code review._
2. **Contract-first (Law 4).** Add/extend the schema in `@vip/contracts` before writing code that produces or consumes it. Types and JSON Schema derive from one source. — _enforced: contract-testing harness; review._
3. **Tenant isolation, fail-closed (Law 5).** Every record carries `tenantId`; no operation runs without resolved tenant context; on doubt, deny. — _enforced (from P1): data-layer guard + isolation test suite. Phase 0: seam only, see [ED-0013]._
4. **The architecture is frozen at v1.0.** Every architectural change goes through an ADR. No silent redesign. — _enforced: review; `docs/adr/`._

## Boundaries & coupling

5. **Never access another bounded context's database directly.** Read another context's data only via its API or its published events (22 golden rule). — _enforced: review; import-graph (cross-context DB check planned)._
6. **Never couple plugins to core internals, and never let core import a plugin.** — _enforced: `check:imports` noCoreToPlugin._
7. **Never deep-import another package's internals.** Import a package by its public entry only (`@vip/contracts`, not `@vip/contracts/src/...`). — _enforced: `check:imports` noDeepImports._
8. **Never import another service's code.** Cross-service communication is API/events only. — _enforced: `check:imports` noCrossServiceInternals._
9. **The package/service dependency graph stays acyclic.** — _enforced: `check:imports` noCycles._
10. **Domain layer imports nothing from transport/adapters or any framework.** Call direction is `transport → application → domain`; adapters implement ports. — _enforced: review; layering convention._

## Runtime platform (become enforceable as the engines land)

11. **Never bypass the Event Engine** for cross-context propagation once it exists. Side effects across contexts flow through events (outbox pattern), not direct calls. — _enforced (future): review; architecture tests._
12. **Never bypass the Policy Engine** for authorization/governance decisions once it exists. The Rule Engine (business logic) is distinct from the Policy Engine (who/what/where/when) — ADR-0013. — _enforced (future): PDP hooks._
13. **Never hardcode customer-specific logic** anywhere in core, capabilities, or shared packages. — _enforced: review; import-graph._
14. **Every service exposes `/health`, `/ready`, `/metrics`** and emits events via the outbox pattern. — _enforced: service template; review._
    14b. **Never commit model weights or dataset bytes to git.** They live in the registry / object storage — models in MLflow (+MinIO), datasets in DVC (+MinIO). Git holds only pointers (`*.dvc`), model cards, and metadata. — _enforced: `.gitignore` (weights/`/datasets/`) + DVC; review._
    14c. **Reference models by registry selector, never by hardcoded path/vendor** ([ADR-0002](../adr/ADR-0002-model-agnostic-inference.md)). — _enforced: review; capability contract._

## Engineering process

15. **Never choose a dependency version from memory.** Registry-verify latest stable; no alpha/beta/rc unless requested; document in [DEPENDENCIES](DEPENDENCIES.md). — _enforced: CI `--frozen-lockfile`; DEPENDENCIES review._
16. **Every service/package/plugin/capability ships a `README.md`** (purpose, responsibilities, architecture position, dependencies, config, run, test, extension points). — _enforced: review; [DoD](DEFINITION_OF_DONE.md)._
17. **Every slice satisfies the [Definition of Done](DEFINITION_OF_DONE.md)** and updates all governance trackers before it is Done. — _enforced: end-of-sprint validation._
