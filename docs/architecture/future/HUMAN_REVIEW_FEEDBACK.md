# Human Review Feedback Loop — Workflow (Deliverable 8)

_Status: ⏳ Architect Review Pending · Documentation-only · Builds on [11-WORKFLOW-ENGINE](../11-WORKFLOW-ENGINE.md) + [08-AI-ML-PLATFORM](../08-AI-ML-PLATFORM.md)_

> Capture the operator's judgment on each incident so the platform can measure AI quality and, later,
> improve models. This is an **additive review disposition on the existing incident lifecycle** plus a
> **capture-only feedback dataset** — **not** an auto-retraining pipeline (governance/PII weight defers
> that to Phase 3+, AR-4).

## Workflow

```
Incident (raised → …)
   │  operator reviews (in the console Incident/Evidence viewer)
   ▼
Disposition:  Confirmed | False Positive | Ignored | Needs Investigation
   │  publish  incident.reviewed  (new event, additive)
   ▼
Historical Review Dataset  (labeled: incident + evidence + disposition + reviewer + time)
   │
   ├─▶ Analytics: precision/FP-rate per capability/rule/camera (Phase 3)
   └─▶ (future) curated training/eval sets for model improvement — human-in-the-loop, never automatic
```

## What already exists

- **Incident lifecycle** ([11], P1-8): `raised → acknowledged → resolved → closed`, versioned +
  `history[]` audited. **Disposition is orthogonal** to lifecycle status (an incident can be _resolved_
  **and** labeled _false positive_).
- **Correlation + provenance** end-to-end (evidence, model version, confidence) — the exact features a
  review label needs.
- **Dataset Registry** (`ai/mlops`: **DVC + MinIO**) — the home for a versioned review dataset.

## Proposed additions (future — NOT built)

| Addition                   | Shape                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `IncidentDisposition` enum | `confirmed` \| `false_positive` \| `ignored` \| `needs_investigation`                                                       |
| Incident field (additive)  | `review?: { disposition, reviewedBy, reviewedAt, note? }`                                                                   |
| Event (additive, catalog)  | `incident.reviewed` (system) — carries disposition + correlationId                                                          |
| Review dataset             | DVC-tracked: `{ incidentId, correlationId, capability, model+version, confidence, evidenceRef, disposition, reviewer, at }` |
| API                        | `POST /incidents/:id/review` (workflow; `incident:review` permission)                                                       |

All additive (new enum, optional field, new event) — no breaking change; no new service (extends
workflow + writes to the existing dataset registry).

## Value

- **AI quality signal:** FP-rate / precision per capability, rule, camera, site — surfaced in analytics
  and the benchmark framework ([AI_BENCHMARK_FRAMEWORK](AI_BENCHMARK_FRAMEWORK.md)).
- **Rule tuning:** high FP rules become obvious → operators adjust thresholds/windows.
- **Future model improvement:** a governed, labeled corpus for **human-approved** retraining/eval —
  never an automatic loop (avoids model drift + PII/consent issues).

## Principles

Event-driven (`incident.reviewed`), loose coupling (Workflow emits, Analytics/MLOps consume),
multi-tenant (labels are tenant-scoped), security (PII in evidence stays encrypted + access-audited).

## Not built now

**Phase 3**, once there are enough incidents to label and an analytics surface to consume them. The
minimal first step (a capture-only `disposition` + `incident.reviewed`) can be added cheaply when the
console Incident viewer exists — but **only on approval**.
