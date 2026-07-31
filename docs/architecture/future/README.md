# Architecture Enhancement Proposal — Future Capabilities

_Status: ⏳ Architect Review Pending · Author: Claude · Date: 2026-07-29 · Documentation-only_

> A forward-readiness review commissioned before Phase-2 Productization. It documents where future
> **enterprise** capabilities should live, **without changing the frozen architecture (docs 01–28) or
> the current lean implementation**. Everything here is a **recommendation** — nothing is built until
> the Architect approves. Guiding rule: **"Is this required today? If no, document the extension point,
> don't build it."**
>
> **Key finding:** most of these capabilities are **already anticipated** in the frozen architecture
> (the capability registry + execution scheduler in [05], evidence management in [12], industry packs
> in [13], the AI/ML platform + MLflow in [08], performance/scale in [19]). This review **formalizes
> enterprise specs on top of those seams** — it does not invent parallel structures.

## Deliverables (index)

| #   | Deliverable                       | Doc                                                                                               | Formalizes (frozen ref)                                                         | ADR                  |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------- |
| 1   | Updated Architecture Roadmap      | [CAPABILITY_ROADMAP](CAPABILITY_ROADMAP.md) + [PROJECT_ROADMAP](../../project/PROJECT_ROADMAP.md) | —                                                                               | —                    |
| 2   | Architecture Enhancement Proposal | **this doc**                                                                                      | —                                                                               | —                    |
| 3   | Future Capability Roadmap         | [CAPABILITY_ROADMAP](CAPABILITY_ROADMAP.md)                                                       | —                                                                               | —                    |
| 4   | AI Capability Registry Spec       | [AI_CAPABILITY_REGISTRY](AI_CAPABILITY_REGISTRY.md)                                               | [05](../05-CAPABILITY-ARCHITECTURE.md), P1-6 runtime registry                   | ADR-0022             |
| 5   | Analysis Profile Spec             | [ANALYSIS_PROFILES](ANALYSIS_PROFILES.md)                                                         | [24](../24-COMPOSITION-FRAMEWORK.md), [10](../10-RULE-ENGINE.md)                | ADR-0021             |
| 6   | AI Pack Strategy                  | [AI_PACKS](AI_PACKS.md)                                                                           | [13](../13-INDUSTRY-PACKS.md), [20](../20-EXTENSIBILITY.md)                     | — (extends ADR-0007) |
| 7   | Evidence Package Spec             | [EVIDENCE_PACKAGE](EVIDENCE_PACKAGE.md)                                                           | [12](../12-EVIDENCE-MANAGEMENT.md), [18](../18-DATA-ARCHITECTURE.md)            | ADR-0020             |
| 8   | Human Review Feedback Workflow    | [HUMAN_REVIEW_FEEDBACK](HUMAN_REVIEW_FEEDBACK.md)                                                 | [08](../08-AI-ML-PLATFORM.md), [11](../11-WORKFLOW-ENGINE.md)                   | —                    |
| 9   | AI Benchmark Framework            | [AI_BENCHMARK_FRAMEWORK](AI_BENCHMARK_FRAMEWORK.md)                                               | [08](../08-AI-ML-PLATFORM.md), `ai/mlops`                                       | —                    |
| 10  | Future Inference Scheduler        | [INFERENCE_SCHEDULER](INFERENCE_SCHEDULER.md)                                                     | [05 §4](../05-CAPABILITY-ARCHITECTURE.md), [19](../19-PERFORMANCE-AND-SCALE.md) | —                    |
| 11  | Product Demonstration Workflows   | [DEMONSTRATION_WORKFLOWS](DEMONSTRATION_WORKFLOWS.md)                                             | P2-1 acceptance                                                                 | —                    |
| 12  | Risks & Recommendations           | **this doc §Risks**                                                                               | —                                                                               | —                    |
| 13  | Event Spine Semantics             | [EVENT_SPINE_SEMANTICS](EVENT_SPINE_SEMANTICS.md)                                                 | [09](../09-EVENT-PLATFORM.md), ADR-0005/0016                                    | —                    |
| 14  | Future AI Processing Pipeline     | [AI_PROCESSING_PIPELINE](AI_PROCESSING_PIPELINE.md)                                               | [05](../05-CAPABILITY-ARCHITECTURE.md), [08](../08-AI-ML-PLATFORM.md)           | ADR-0002/0012        |

> **Rows 13–14 are G-3.5-closeout additions (2026-07-30, [ED-0033](../../project/ENGINEERING_DECISION_LOG.md)):** documentation-only architecture notes commissioned by the Architect before formally closing G-3.5 — event-spine versioning/dedup/ordering semantics, and the future AI processing pipeline (Inference Adapter boundary + long-running behaviour workflows). Tracked as [TD-10…TD-14](../../../tracking/TECH-DEBT.md).

## G-4 acceptance — forward recommendations (2026-07-31)

Raised by the Architect at **G-4 Evidence** acceptance. **Future evolution, NOT blockers** — the shipped
evidence model already supports each without a structural change. Sequence strictly by product need.

| #   | Recommendation             | Nature                | Builds on (shipped in G-4)                                              | Home when built                              |
| --- | -------------------------- | --------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| G4-1 | **Evidence Timeline**      | presentation-only     | evidence model + `source` chain (Event→Rule→Incident→Evidence)         | console / workflow read-projection           |
| G4-2 | **Evidence Collections**   | grouping abstraction  | `EvidenceSource` + `EvidenceQuery` (N-per-incident already expressible) | contract + evidence query, when investigations demand it |
| G4-3 | **Storage Health Monitoring** | operational metrics | `ObjectStore` port + `EvidenceMetrics`                                  | evidence service `/metrics` + provider probes |
| G4-4 | **Advanced Evidence Search** | structured search   | `EvidenceMetadata`/`EvidenceAiMetadata` (storage-independent)          | evidence query layer / search index          |
| G4-5 | **AI Runtime Integration doc** | documentation-only | [AI_PROCESSING_PIPELINE](AI_PROCESSING_PIPELINE.md) (consolidate)      | `docs/architecture/future/AI_RUNTIME_INTEGRATION.md` |

Guiding rule unchanged: **"Is this required today? If no, document the extension point, don't build it."**

## Reconciliation with the existing ADR system

A suggestion arose to create a parallel `docs/architecture/adr/` (three-digit ADRs). **We keep the
single existing system at [`docs/adr/`](../../adr/README.md) (four-digit, immutable, append-only)** to
avoid fragmenting governance and re-deciding frozen choices. The suggested eight topics map as:

| Suggested topic                | Disposition                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Event-Driven Architecture      | **Already decided** → [ADR-0005](../../adr/ADR-0005-event-driven-backbone.md) + [ADR-0016](../../adr/ADR-0016-nats-jetstream-event-backbone.md) |
| Node + Python service split    | **Already decided** → polyglot principle ([00-Constitution](../../00-ENGINEERING-CONSTITUTION.md)); `ai/*` Python, `services/*` TS              |
| Multi-Tenant Database Strategy | **Already decided** → [ADR-0003](../../adr/ADR-0003-tenant-isolation-strategy.md)                                                               |
| Rule Engine Design             | **Already decided** → [ADR-0013](../../adr/ADR-0013-policy-engine.md) + ED-0028                                                                 |
| Incident Lifecycle             | **Already decided** → ED-0029 + [INCIDENT_LIFECYCLE](../phase1/INCIDENT_LIFECYCLE.md)                                                           |
| Evidence Package               | **NEW** → **ADR-0020** (this review)                                                                                                            |
| Analysis Profiles              | **NEW** → **ADR-0021** (this review)                                                                                                            |
| AI Capability Registry         | **NEW** → **ADR-0022** (this review)                                                                                                            |

Plus **ADR-0019** (Operations Console + `apps/` layer, from the P2-1 plan / ED-0030) is formalized now.
All four new ADRs are **Proposed** (⏳), never Accepted without ratification.

## Principles compliance matrix

Every proposed enhancement is checked against the ten mandated principles. **✓ = upholds · ➕ = actively
strengthens.**

| Enhancement            | Bounded Ctx               | Event-Driven             | Loose Coupling | High Cohesion | Horiz. Scale  | Cloud-Native      | Multi-Tenant         | API-First         | Observability | Security               |
| ---------------------- | ------------------------- | ------------------------ | -------------- | ------------- | ------------- | ----------------- | -------------------- | ----------------- | ------------- | ---------------------- |
| AI Capability Registry | ✓ (Perception)            | ✓                        | ✓              | ➕            | ✓             | ✓                 | ✓                    | ➕ (catalog API)  | ➕            | ✓                      |
| Analysis Profiles      | ✓ (config, not a service) | ✓                        | ✓              | ✓             | ✓             | ✓                 | ➕ (per-tenant)      | ✓                 | ✓             | ✓                      |
| AI Packs               | ✓ (plugins)               | ✓                        | ➕             | ✓             | ✓             | ✓                 | ➕ (entitlements)    | ✓                 | ✓             | ✓                      |
| Evidence Package       | ✓ (Evidence)              | ✓ (on `incident.raised`) | ✓              | ➕            | ✓             | ➕ (object store) | ➕ (tenant-prefixed) | ✓                 | ✓             | ➕ (immutable + audit) |
| Human Review Loop      | ✓ (Workflow→Analytics)    | ➕ (`incident.reviewed`) | ✓              | ✓             | ✓             | ✓                 | ✓                    | ✓                 | ➕            | ✓                      |
| Benchmark Framework    | ✓ (MLOps)                 | ✓                        | ✓              | ➕            | ✓             | ✓                 | n/a (offline)        | ✓                 | ➕            | ✓                      |
| Inference Scheduler    | ✓ (Perception)            | ✓ (queue subjects)       | ➕             | ➕            | ➕ (GPU pool) | ➕                | ✓                    | ✓ (unchanged API) | ➕            | ✓                      |

**No enhancement introduces a new bounded context, breaks a boundary, or changes an existing public
API.** Each is either a **new plugin/pack**, a **config artifact**, an **object-store lifecycle**, or a
**capacity component behind an unchanged interface**.

## Cross-cutting design rules for all enhancements

1. **Extend, don't fork.** Build on the existing capability descriptor/registry, evidence store,
   pack/plugin system, and MLflow — never a parallel mechanism.
2. **Contract-first.** Any new data shape is a `@vip/contracts` schema **before** a consumer (Law 4).
   New enums extend additively (never repurpose) — e.g. capability status gains `beta`.
3. **No core → plugin, no cross-service internals.** Packs are plugins; the core stays
   industry-agnostic (Law 1, import-graph enforced).
4. **Interfaces stable.** The Inference Scheduler slots behind the existing `/infer` + capability-output
   subjects — media/events/rules are unaffected.
5. **Documentation-only until approved.** Each spec ends with an explicit **"Not built now."**

## Risks & recommendations (deliverable 12)

| ID   | Risk                                                                                                                      | Sev  | Recommendation                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| AR-1 | **Over-building ahead of need** — specs tempt premature implementation, adding complexity the product doesn't yet require | Med  | Keep all specs ⏳; implement only when a customer/demo requires it; each ADR stays `Proposed` until then                     |
| AR-2 | **Registry/profile scope creep** blurs the industry-neutral core (Law 1)                                                  | Med  | Capabilities stay generic; **all industry semantics live in Packs (plugins)**; profiles are tenant config, not core code     |
| AR-3 | **Evidence immutability vs cost/retention** (WORM storage, PII, GDPR erasure tension)                                     | Med  | Tenant-prefixed object store + retention/legal-hold lifecycle + per-tenant KMS; erasure via crypto-shredding (doc [12]/[15]) |
| AR-4 | **Human-review data → model retraining** introduces a labeling/PII pipeline with governance weight                        | Med  | Phase-3 (Analytics/MLOps); start with capture-only (`incident.reviewed` + a review dataset), no auto-retrain                 |
| AR-5 | **Inference Scheduler / GPU pool** is the biggest scale unknown (R-005)                                                   | High | Prototype behind the unchanged `/infer` API with a load harness before committing; keep batch=1 default until proven         |
| AR-6 | **Benchmark accuracy gates** need labeled datasets not yet present                                                        | Med  | Reuse the DVC dataset registry (`ai/mlops`); gate model promotion on FP/FN in CI when datasets exist                         |
| AR-7 | **Doc drift** — 8 new specs can rot                                                                                       | Low  | Single index (this doc); each spec cross-links its frozen anchor; review at each phase gate                                  |

**Overall recommendation:** **Adopt the specs as the forward roadmap; implement none now.** Sequence
implementation strictly by product need — the Operations Console (P2-1) and its six enablers first;
Packs/Profiles/Human-Review/Benchmark/Scheduler as enterprise demand and scale pressure arrive
(Phase 3–4). This preserves a lean platform while making enterprise growth a documented, low-friction
path.

## Status

All twelve deliverables produced as **documentation only**. **No feature implemented, no frozen
architecture doc edited, no new service introduced.** Recommendations ⏳ **Architect Review Pending**.
