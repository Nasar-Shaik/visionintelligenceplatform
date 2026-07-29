# Project Roadmap — Vision Intelligence Platform

> Top-level delivery map. Architecture is **frozen v1.0** (sections [01–28](../architecture/)); this is the _delivery sequence_ over that architecture. Phase 1 is planned in detail under [`../architecture/phase1/`](../architecture/phase1/README.md).

```text
VisionIntelligencePlatform
│
├── Phase 0  ✅ Foundation
│     monorepo · @vip/contracts · CI gate · dev stack · MLOps registry
│     @vip/config (.env-only secrets) · identity service template
│
├── Phase 1  ✅ Core Platform   ← end-to-end vertical: "a camera produces an alert" (all 8 slices Architect-approved)
│     P1-1  Tenant            (multi-tenant foundation + fail-closed isolation)
│     P1-2  Authentication    (OIDC/JWT/refresh + RBAC/ABAC via Policy Engine)
│     P1-3  Camera Registry   (org→…→camera hierarchy, onboarding, credentials)
│     P1-4  RTSP Ingestion    (connect, decode, frame extraction, recording)
│     P1-5  Event Pipeline    (ingest→correlate→dedup→persist→replay)
│     P1-6  AI Inference      (model-agnostic capability runtime → detections)
│     P1-7  Rule Engine       (evaluate events → incident candidates)
│     P1-8  Alerts            (incident lifecycle + multi-channel notification)
│
├── Phase 2  🚧 Productization   ← turn the platform into a demonstrable product
│     P2-1  Operations Console (SOC UI: login·dashboard·cameras·live·analyze·events·rules·incidents·alerts·evidence)
│           + backend enablers G-1…G-6 (live-preview · upload→analyze · media→inference · evidence refs · CORS/SSE · assign/comments)
│     (Analytics — read models · dashboards · search · reports — folds in here / follows)
│
├── Phase 3  Enterprise Features
│     entitlements/billing · audit · compliance postures · connector platform
│     industry packs (Retail first) · digital twin
│
└── Phase 4  Production & Scaling
      multi-region · edge fleet at scale · HA/DR · GA hardening · marketplace
```

## Status

| Phase | Name                 | Status                           | Detail                                                                                                                                                                                 |
| ----- | -------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Foundation           | ✅ Complete                      | [tracking/PROGRESS](../../tracking/PROGRESS.md)                                                                                                                                        |
| 1     | Core Platform        | ✅ Complete (Architect-approved) | [phase1/README](../architecture/phase1/README.md) · [PHASE1_EXIT_REVIEW](PHASE1_EXIT_REVIEW.md) — 🟢 GO                                                                                |
| 2     | Productization       | 🚧 P2-1 plan ⏳ review           | [phase2/OPERATIONS_CONSOLE](../architecture/phase2/OPERATIONS_CONSOLE.md) · [DESIGN_SYSTEM](../architecture/phase2/DESIGN_SYSTEM.md) · [ED-0030](ENGINEERING_DECISION_LOG.md)          |
| 3     | Enterprise Features  | ⚪ Not started                   | [20](../architecture/20-EXTENSIBILITY.md), [24](../architecture/24-COMPOSITION-FRAMEWORK.md), [25](../architecture/25-CONNECTOR-PLATFORM.md), [26](../architecture/26-DIGITAL-TWIN.md) |
| 4     | Production & Scaling | ⚪ Not started                   | [17](../architecture/17-DEVOPS-AND-INFRA.md), [19](../architecture/19-PERFORMANCE-AND-SCALE.md), [27](../architecture/27-CONTROL-DATA-PLANE.md)                                        |

## Note on phasing

This roadmap re-scopes delivery so **Phase 1 is a thin, end-to-end vertical** (camera → alert) rather than a horizontal "all of SaaS foundation" phase — the fastest path to a demonstrable, testable product spine ([ED-0019](ENGINEERING_DECISION_LOG.md)). Enterprise breadth (billing, audit, compliance, connectors, packs) moves to Phase 3. The **frozen architecture is unchanged**; only the build order is.
