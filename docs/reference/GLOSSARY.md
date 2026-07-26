# Reference — Glossary (Canonical Vocabulary)

> Use these terms **everywhere** — code, docs, events, APIs, tracking. One concept, one name. Ambiguity here becomes bugs downstream.

| Term | Definition |
|---|---|
| **Platform / VIP** | The PaperlessTech Vision Intelligence Platform — the whole system. |
| **Core** | Everything under `services/`, `ai/`, `edge/`, `packages/`. Contains **no** industry/customer logic. |
| **Capability** | A reusable, self-describing, model-agnostic building block with a versioned contract ([05](../architecture/05-CAPABILITY-ARCHITECTURE.md)). The unit of functionality. |
| **Capability descriptor** | The machine-readable declaration of a capability's inputs/outputs/params/placement/resource-profile. |
| **Model selector** | How a capability references a model by `{task, family, version-range, accelerator}` instead of a hardcoded artifact. |
| **Placement** | The scheduler decision of whether a capability node runs at edge or cloud. |
| **Event** | A normalized, versioned, **domain-neutral** fact on the backbone ([09](../architecture/09-EVENT-PLATFORM.md)). The platform's currency. |
| **Event taxonomy / catalog** | The versioned namespace of event types and their schemas. |
| **Rule** | Declarative, tenant-owned IF/WHEN/THEN over events that assigns business meaning ([10](../architecture/10-RULE-ENGINE.md)). Carries no industry identity. |
| **Rule Pack** | A versioned bundle of rule templates shipped by an Industry Pack or the platform. |
| **Workflow** | A declarative state machine driving response after a rule fires ([11](../architecture/11-WORKFLOW-ENGINE.md)). |
| **Incident** | The human-facing unit aggregating related events + evidence, with a lifecycle. |
| **Case** | A container grouping multiple incidents (investigation/audit) with its own state + evidence bundle. |
| **Evidence** | Clips/snapshots/metadata with chain of custody ([12](../architecture/12-EVIDENCE-MANAGEMENT.md)). |
| **Industry Pack** | A **plugin** delivering a vertical as declarative artifacts only (rules/workflows/dashboards/reports/policies/templates) ([13](../architecture/13-INDUSTRY-PACKS.md)). |
| **Plugin** | Any runtime-loaded extension implementing declared extension points ([20](../architecture/20-EXTENSIBILITY.md)). |
| **Extension point** | A declared, versioned interface the core exposes for plugins to implement. |
| **Hook** | A lifecycle callback the core invokes at a defined moment for enrichment/observation. |
| **Tenant** | A customer organization; the top isolation boundary. Everything carries `tenantId`. |
| **Scope** | The hierarchy level a permission/assignment applies to: `own→zone→site→branch→region→tenant→global`. |
| **Entitlement** | A tenant's resolved allowance (plan + packs + flags + quotas) governing which capabilities/features are available. |
| **Edge agent** | The tenant-bound on-premise runtime executing the same capability contracts locally and offline ([14](../architecture/14-EDGE-PLATFORM.md)). |
| **Ring buffer** | Rolling per-camera pre-roll buffer enabling pre-event evidence without continuous recording. |
| **Smart clip** | Event-scoped clip (pre+post roll, merged) — the storage-economics mechanism. |
| **Model Registry** | Source of truth for versioned model artifacts + lineage + metrics ([08](../architecture/08-AI-ML-PLATFORM.md)). |
| **Dataset Registry** | Versioned datasets with lineage/consent/licensing. |
| **Contract** | A versioned schema/API/event definition in `packages/contracts`; the law of integration. |
| **Read model** | A materialized, query-optimized projection (e.g. for dashboards) derived from events/OLTP. |
| **Two-stage confirmation** | Fast detector + secondary verifier before escalating high-severity events (reduces false positives). |
| **Chain of custody** | The append-only, tamper-evident record of an evidence item's creation/access/export/hold. |
| **Placement-agnostic / model-agnostic / consumer-agnostic** | The three independences every capability must preserve. |

## Naming rules
- Event types: `<domain>.<subject>.<predicate>`, lowercase, dot-separated (e.g. `spatial.line.crossed`).
- Capability IDs: `<family>.<name>` (e.g. `perception.person-detection`).
- Permissions: `resource:action[:scope]` (e.g. `evidence:export:branch`).
- Never encode a customer/industry name in a core identifier.
