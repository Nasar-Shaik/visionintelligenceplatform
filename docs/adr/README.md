# Architecture Decision Records (ADRs)

An ADR captures **one architecturally significant decision**: its context, the decision, the alternatives considered, and the consequences. ADRs are **immutable and append-only** — you never edit an accepted ADR's decision; you supersede it with a new one that links back.

## When an ADR is required

Any decision that changes: a **contract**, a **boundary/dependency rule**, a **technology** (from [reference/TECH-STACK](../reference/TECH-STACK.md)), a **principle/law** ([00-ENGINEERING-CONSTITUTION](../00-ENGINEERING-CONSTITUTION.md)), or a **cross-cutting pattern** (isolation, event schema policy, deployment strategy).

## Process

1. Copy [`ADR-TEMPLATE.md`](ADR-TEMPLATE.md) → `ADR-NNNN-short-title.md` (next number).
2. Status starts `Proposed`; move to `Accepted` when ratified (or `Rejected`/`Superseded`).
3. Link the ADR from the affected `docs/architecture/NN-*.md` section(s).
4. Only then change code.

## Status values

`Proposed` · `Accepted` · `Rejected` · `Superseded by ADR-NNNN` · `Deprecated`

## Index

| #                                                                 | Title                                                               | Status   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| [0001](ADR-0001-capability-composition-over-vertical-features.md) | Capability composition over vertical features                       | Accepted |
| [0002](ADR-0002-model-agnostic-inference.md)                      | Model-agnostic inference via registry selectors                     | Accepted |
| [0003](ADR-0003-tenant-isolation-strategy.md)                     | Pooled-default / siloed-optional tenant isolation                   | Accepted |
| [0004](ADR-0004-edge-first-placement.md)                          | Edge-first capability placement, one codebase                       | Accepted |
| [0005](ADR-0005-event-driven-backbone.md)                         | Durable event backbone as the primary coupling                      | Accepted |
| [0006](ADR-0006-composition-layer.md)                             | Introduce a Composition Layer between capabilities and events       | Accepted |
| [0007](ADR-0007-models-as-plugins.md)                             | Models as plugins (model provider extension point + marketplace)    | Accepted |
| [0008](ADR-0008-connector-platform.md)                            | Connector Platform for external system integration                  | Accepted |
| [0009](ADR-0009-digital-twin.md)                                  | Digital Twin spatial abstraction                                    | Accepted |
| [0010](ADR-0010-ddd-bounded-contexts-and-ownership.md)            | Adopt DDD bounded contexts and explicit service ownership           | Accepted |
| [0011](ADR-0011-control-plane-data-plane-separation.md)           | Explicit Control Plane / Data Plane separation                      | Accepted |
| [0012](ADR-0012-model-adapter-layer.md)                           | Model Adapter Layer between capabilities and models                 | Accepted |
| [0013](ADR-0013-policy-engine.md)                                 | Policy Engine (distinct from the Rule Engine)                       | Accepted |
| [0014](ADR-0014-configuration-hierarchy.md)                       | Hierarchical configuration inheritance                              | Accepted |
| [0015](ADR-0015-contract-testing-and-plugin-certification.md)     | Contract testing & plugin certification gate                        | Accepted |
| [0016](ADR-0016-nats-jetstream-event-backbone.md)                 | NATS JetStream as the event backbone & messaging (resolves ND-1)    | Accepted |
| [0017](ADR-0017-fastify-control-plane.md)                         | Fastify for Control-Plane / TypeScript services                     | Accepted |
| [0018](ADR-0018-env-only-secrets-and-centralized-config.md)       | `.env`-only secrets & centralized configuration                     | Accepted |
| [0019](ADR-0019-operations-console-and-apps-layer.md)             | Operations Console & `apps/` workspace layer                        | Accepted |
| [0020](ADR-0020-immutable-evidence-package.md)                    | Immutable Evidence Package                                          | Proposed |
| [0021](ADR-0021-analysis-profiles.md)                             | Analysis Profiles                                                   | Proposed |
| [0022](ADR-0022-ai-capability-registry.md)                        | AI Capability Registry (enterprise catalog)                         | Proposed |
| [0023](ADR-0023-onvif-discovery-placement.md)                     | ONVIF discovery in the AI runtime; onboarding in the camera service | Accepted |

| [0024](ADR-0024-camera-lifecycle-evidence-gate.md) | A camera's operational state requires measured evidence | Accepted |
| [0025](ADR-0025-organization-hierarchy.md) | The organization hierarchy: containment, movement, archival and backend-owned traversal | Accepted |
| [0026](ADR-0026-rule-scope-validation-and-explainability.md) | Rules scope to the Location Hierarchy: resolve at validation, evaluate on a set | Accepted |
| [0027](ADR-0027-rule-operations-diagnostics-and-portability.md) | Rule operations: derive diagnostics, gate live edits, keep history append-only | Accepted |
| [0028](ADR-0028-rule-support-surface-and-the-p5-contract.md) | The rule support surface: compose the artifact, band the complexity, never score what was not checked | Accepted |
| [0029](ADR-0029-incident-workflow-entry-criteria.md) | Incident Management entry criteria: assignment is not a state, the activity log is derived, and no query ships without its index | Accepted |
| [0030](ADR-0030-incident-prerequisites.md) | P-5.1 prerequisites: measure before you classify, type the actor rather than guess it, and never report an SLA nobody set | Accepted |
| [0031](ADR-0031-workspace-prerequisites.md) | P-5.2.0 workspace prerequisites: freeze the shapes, refuse the ones that cannot be honest | Accepted |
| [0032](ADR-0032-investigation-workspace.md) | P-5.2 Investigation Workspace: the registry drives the screen, and the joins run as the caller | Accepted |
| [0033](ADR-0033-evidence-integration-and-chain.md) | P-5.3 evidence integration, collaboration and the evidence chain: measure the client, and let the chain break honestly | Accepted |
| [0034](ADR-0034-investigation-reservations.md) | P-5.4 investigation reservations: the contracts frozen before the last implementation phase | Accepted |
| [0035](ADR-0035-evidence-playback.md) | P-5.5 evidence playback: the first implementation milestone after the freeze | Accepted |
| [0036](ADR-0036-browser-facing-object-storage-endpoint.md) | A browser-facing endpoint for signed object-storage URLs | Accepted |
| [0037](ADR-0037-model-agnostic-runtime-and-registry-driven-loading.md) | A model-agnostic runtime with registry-driven model loading | Accepted |
| [0038](ADR-0038-track-identity-across-gaps.md) | Re-entry is a link, not a reused id: track identity across gaps | Accepted |
| [0039](ADR-0039-absent-metrics-are-unavailable-never-zero.md) | Absent metrics are reported as unavailable, never as zero — **platform-wide** | Accepted |
| [0040](ADR-0040-one-event-envelope-many-payload-schemas.md) | One `EventEnvelope`. Many payload schemas. No second transport | Accepted |
| [0041](ADR-0041-identity-travels-with-the-subject.md) | Identity travels with the subject, or rules under-fire silently | Accepted |
| [0042](ADR-0042-at-least-once-delivery-with-bounded-suppression.md) | Delivery is at-least-once, suppression is bounded, and recording outranks both | Accepted |

_Add new rows as ADRs are created. Never renumber; never delete._

> ⚠️ **This index was thirteen ADRs out of date** until 2026-08-05 — 0024–0036 existed as files and
> not as rows. An index nobody can trust is worse than no index, because the absence of a row reads
> as the absence of a decision. Backfilled while adding 0037.
>
> ⚠️ **And four out of date again by 2026-08-06** — 0038–0041 were written, referenced from the
> capability matrix and the limitation register, and never added here. Backfilled while adding 0042.
> The lesson from the first backfill was recorded and did not change the outcome, which says the
> instruction is not the mechanism: **the row belongs in the same commit as the file**, and a
> reviewer of a commit adding `docs/adr/ADR-nnnn-*.md` should look for the row before anything else.

> ADRs 0006–0010 were produced by the **Enterprise Architecture Review** (2026-07-26). ADRs 0011–0015 were produced by the **Final Architecture Enhancement** (2026-07-27) that froze the architecture as **v1.0**. All are strengthenings that preserve the existing philosophy. **After v1.0 freeze, every architectural change requires a new ADR.**
