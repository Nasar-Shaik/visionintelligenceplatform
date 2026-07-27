# 28 — Policy Engine

> Final Architecture Enhancement (v1.0). A governance decision point **distinct from** the Rule Engine. Ratified by [ADR-0013](../adr/ADR-0013-policy-engine.md).

## Purpose

Centrally decide **who may do what, where, and when** — privacy, compliance, jurisdiction, and access governance — as a first-class, auditable, declarative engine, separate from the business logic of the Rule Engine.

## Rule Engine vs Policy Engine (the distinction)

|          | Rule Engine ([10](10-RULE-ENGINE.md)) | Policy Engine (this)                                                                                   |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Question | **IF event THEN action**              | **Who can do what, where, when**                                                                       |
| Domain   | Tenant business logic over events     | Governance: privacy, compliance, access, jurisdiction                                                  |
| Owner    | Tenant / Industry Pack                | Platform + tenant compliance/admin (Control Plane)                                                     |
| Output   | incidents/actions                     | permit / deny / **obligation** (e.g. "allow but redact")                                               |
| Example  | _IF loitering in vault THEN alert_    | _Face recognition is disallowed in this region; evidence export requires manager approval + watermark_ |

They are complementary: a **rule** may request an action (export evidence, run face-recognition), and the **policy engine** decides whether it is permitted and under what obligations.

## Responsibilities

- Own policies as declarative, versioned, hierarchical data (Control Plane, [27](27-CONTROL-DATA-PLANE.md)).
- Serve as the **Policy Decision Point (PDP)**: evaluate `subject × action × resource × context` → permit/deny/obligations.
- Provide enforcement hooks (PEPs) to every governed subsystem.

## 1. Policy model (ABAC / OPA-style)

```yaml
policy: 'face-recognition-jurisdiction'
scope: { region: 'EU' } # applies via config hierarchy (doc 06)
effect: deny
when:
  action: recognition.face.match
obligations: [] # deny needs none
---
policy: 'evidence-export-approval'
effect: permit
when:
  action: evidence.export
obligations:
  - require_approval: role:manager
  - watermark: true
  - reason_for_access: required
  - audit: true
```

Decisions are `permit | deny | permit-with-obligations`. Obligations (redact, watermark, require-approval, reason-for-access, retention-cap, notify-DPO) are returned to the enforcement point and **must** be honored.

## 2. Policy categories (examples — all declarative, industry-neutral primitives)

Tenant restrictions · Region/Country restrictions · Privacy rules · Face-recognition allowed? · Evidence export allowed? · Data retention limits · Camera access · Role permissions · Country compliance · **GDPR / HIPAA / school-privacy / government** restrictions. Verticals ship **policy templates** in their Industry Packs ([13](13-INDUSTRY-PACKS.md)); the engine and categories stay generic (Law 1).

## 3. Integration points (Policy Enforcement Points)

The PDP is consulted as a gate by:

- **AI Runtime / Inference** — may this capability/model run here (e.g. face-recognition in this jurisdiction)? → [08](08-AI-ML-PLATFORM.md)
- **Rule Engine** — is a rule's requested action permitted? → [10](10-RULE-ENGINE.md)
- **Workflow** — approvals/obligations on transitions (export, dismiss safety incident). → [11](11-WORKFLOW-ENGINE.md)
- **Evidence** — view/download/export/retention/legal-hold governance + obligations (watermark, redact, reason). → [12](12-EVIDENCE-MANAGEMENT.md)
- **Notification** — channel/recipient/PII constraints. → [11 §4](11-WORKFLOW-ENGINE.md)
- **Connectors** — what external data may flow in/out. → [25](25-CONNECTOR-PLATFORM.md)
- **API Gateway / AuthZ** — RBAC/ABAC becomes policy-engine-backed. → [06](06-MULTI-TENANT-SAAS.md), [15](15-SECURITY-ARCHITECTURE.md)

## 4. Evaluation & performance

- The PDP is centralized (Control Plane) but **decisions are cached and pushed to the Data Plane** with TTL + last-known-good, so enforcement works offline/at edge without a synchronous call ([27 §2](27-CONTROL-DATA-PLANE.md)).
- Deterministic, versioned, dry-runnable; conflicts resolve by explicit precedence (deny-overrides by default; most-specific scope wins via the config hierarchy, [06 §6](06-MULTI-TENANT-SAAS.md)).
- Every decision on a sensitive action is **audited** (hash-chained) with the policy version that decided it. → [15 §5](15-SECURITY-ARCHITECTURE.md)

## Design decisions

- **Separate PDP from Rule Engine** — governance and business logic change at different cadences, have different owners, and must be independently auditable.
- **Obligations, not just allow/deny** — enables "permit but redact/watermark/approve," which is how real privacy/compliance works.
- **Decisions cached to the Data Plane** — governance holds even offline, preserving edge autonomy.

## Advantages

- One auditable, jurisdiction-aware place for privacy/compliance/access; regulated verticals satisfied by policy, not code.
- Consistent enforcement across inference, rules, workflow, evidence, notification, and connectors.

## Tradeoffs

- A PDP + policy authoring/versioning and enforcement hooks in each subsystem; cost justified by the compliance stakes of the target industries.

## Future expansion

- Policy simulation/impact analysis; automated compliance-evidence reports; per-region policy packs; policy-as-code CI (OPA) alongside architectural checks.

## Cross-references

[10-RULE-ENGINE](10-RULE-ENGINE.md) · [15-SECURITY-ARCHITECTURE](15-SECURITY-ARCHITECTURE.md) · [06-MULTI-TENANT-SAAS](06-MULTI-TENANT-SAAS.md) · [27-CONTROL-DATA-PLANE](27-CONTROL-DATA-PLANE.md) · [12-EVIDENCE-MANAGEMENT](12-EVIDENCE-MANAGEMENT.md) · [ADR-0013](../adr/ADR-0013-policy-engine.md)
