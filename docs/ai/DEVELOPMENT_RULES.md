# DEVELOPMENT RULES

> The non-negotiables for writing code in this repo. Distilled from the [Constitution](../00-ENGINEERING-CONSTITUTION.md), [03-ARCHITECTURE-PRINCIPLES](../architecture/03-ARCHITECTURE-PRINCIPLES.md), and [CONTRIBUTING.md](../../CONTRIBUTING.md). Violating one blocks the merge.

## Architecture (frozen v1.0)

1. **Never redesign.** The architecture is frozen; change only via an ADR ([docs/adr/](../adr/)) written **before** code.
2. **Never remove abstraction layers.** Keep `Capability → Composition → Event → Rule → Workflow → Evidence → Dashboard`.
3. **No industry/customer logic in the core.** Retail/supermarket/etc. logic lives in `plugins/` only. The core must build & test with `plugins/` deleted.
4. **Respect the planes.** Control Plane ≠ Data Plane; no shared DBs across a context boundary ([22](../architecture/22-BOUNDED-CONTEXTS.md), [23](../architecture/23-SERVICE-OWNERSHIP.md), [27](../architecture/27-CONTROL-DATA-PLANE.md)).

## How we build

5. **Contract-first.** Define/extend the contract in `packages/contracts` before implementation. Contracts are versioned; breaking one needs an ADR.
6. **Capabilities are model-agnostic.** Reference models by selector via the Model Adapter Layer; never hardcode a model, vendor, or downstream consumer.
7. **Event-driven.** Services integrate via NATS JetStream events, not direct business calls. At-least-once + idempotent consumers.
8. **Multi-tenant always.** Every data path carries a resolved `tenantId`; no access without it (data-layer enforced, fail-closed).
9. **Policy-gated.** Governed actions (face-recognition, evidence export, retention…) consult the Policy Engine ([28](../architecture/28-POLICY-ENGINE.md)).
10. **Config via hierarchy.** No config in code; use the configuration hierarchy ([06 §6](../architecture/06-MULTI-TENANT-SAAS.md)).

## Language boundaries (polyglot by responsibility)

11. **TypeScript + Fastify** for the business/control & TS data-plane services. **Python + FastAPI** for the vision platform. Do **not** force one language everywhere.

## Quality

12. **Type-safe, lint-clean, formatted, documented, tested.** No duplication. Small, modular, reusable.
13. **Tests travel with code:** unit + integration + scenario + regression; health checks; contract tests for any contract; isolation test for any new data path.
14. **Observable by default:** every service exposes `/health`, `/ready`, `/metrics`; new paths emit metrics/traces/logs; no PII in logs; no secrets in the repo.
15. **Every new package/service/plugin/module gets a `README.md`** (purpose, responsibilities, deps, structure, run, test, arch refs, extension points).

## Process

16. **One slice at a time.** Finish it production-ready; update docs + trackers; write the daily log; then stop. Never jump ahead; wait for approval before the next sprint.
17. **The repo is the only source of truth.** Never rely on prior conversations. If context is missing, add it.

## Governance (Architect-mandated — a slice is not Done until these are updated)

18. **Definition of Done.** Every slice satisfies [DEFINITION_OF_DONE](../project/DEFINITION_OF_DONE.md). If any applicable item is incomplete, the slice is **NOT Done**.
19. **Record decisions & uncertainty — never silently.** Append to [ENGINEERING_DECISION_LOG](../project/ENGINEERING_DECISION_LOG.md); log new [RISKS](../project/RISK_REGISTER.md), [ASSUMPTIONS](../project/ASSUMPTIONS.md), and [OPEN_QUESTIONS](../project/OPEN_QUESTIONS.md).
20. **Honour the [CONSTRAINTS](../project/CONSTRAINTS.md).** They are hard rules; changing one needs an ADR.
21. **Score the [QUALITY_GATES](../project/QUALITY_GATES.md)** (PASS/FAIL + reason) and update the [API_INVENTORY](../project/API_INVENTORY.md) for any endpoint change.
22. **Write the PO-executable scenario** ([docs/testing/slice-NNN.md](../testing/)) and add the slice's **[review row](../tracker/REVIEW_HISTORY.md)** — leave its **Architect column PENDING**; never self-approve.
23. **Reuse the [templates](../templates/).** Do not invent new doc shapes.
24. **Dependencies:** registry-verify latest stable (compatibility, breaking changes, maintenance, license, security); no alpha/beta/rc unless requested; record in [DEPENDENCIES](../project/DEPENDENCIES.md).
25. **End-of-sprint validation + Architect handoff.** Answer the self-review questions; ensure every tracker/doc/daily-log is updated; produce a handoff sufficient to review the sprint without reading the whole repo.
