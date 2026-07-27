# ADR-0013 — Policy Engine (distinct from the Rule Engine)

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Final Architecture Enhancement (v1.0), Security
- **Touches:** Law 5, Principle 12; docs/architecture/28, 15, 06, 10

## Context
The Rule Engine answers "**IF event THEN action**" (tenant business logic). A separate question governs "**who may do what, where, when**" — privacy, compliance, jurisdiction, and access constraints (GDPR/HIPAA/school/government, face-recognition allowed?, evidence export allowed?, retention limits, camera access). Today these are scattered across RBAC/ABAC ([06](../architecture/06-MULTI-TENANT-SAAS.md), [15](../architecture/15-SECURITY-ARCHITECTURE.md)). They deserve a first-class, centrally-evaluated **Policy Engine**.

## Decision
Introduce a **Policy Engine** ([28](../architecture/28-POLICY-ENGINE.md)): a centralized, declarative, ABAC/OPA-style policy decision point (PDP) evaluating `subject × action × resource × context(where/when/jurisdiction)` → permit/deny/obligation. It is **distinct from** and **complementary to** the Rule Engine, and is consulted as an enforcement gate by Workflow, Evidence, Notification, Connectors, the AI Runtime, and the Rule Engine itself (e.g. a rule action to export evidence must pass policy).

## Alternatives considered
- **Fold policy into rules.** One engine; but conflates business triggers with governance/compliance, making both harder and audits weaker. Rejected — different questions, different owners, different change cadence.
- **Leave as scattered RBAC/ABAC checks.** Works partially; but no central, auditable, jurisdiction-aware decision point → compliance risk. Rejected.

## Consequences
- Positive: one auditable place for privacy/compliance/jurisdiction decisions; regulated verticals (bank/hospital/gov/school) satisfied by policy, not code; enforcement consistent across services.
- Negative/cost: a PDP service + policy authoring/versioning; every governed action calls the PDP (cached).
- Follow-ups: [28](../architecture/28-POLICY-ENGINE.md) created; [15](../architecture/15-SECURITY-ARCHITECTURE.md) references it as the enforcement authority; policies are Control-Plane owned ([27](../architecture/27-CONTROL-DATA-PLANE.md)).

## Compliance
Strengthens Law 5 (secure by design) and Principle 12; no philosophy change — RBAC/ABAC becomes a policy-engine-backed capability.
