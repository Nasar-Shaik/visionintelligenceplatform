# Phase 1 — Implementation Order (first line to last)

> The recommended sequence, each step justified by **why now · depends on · enables**. One slice at a time (approval between slices). Every step is contract-first ([DEPENDENCY_GRAPH](DEPENDENCY_GRAPH.md)) and updates governance ([DEVELOPMENT_RULES 18–25](../../ai/DEVELOPMENT_RULES.md)).

## Step 0 — Contracts & shared modules (opens P1-1)

1. **Extend `@vip/contracts`** with tenant/org, user/auth, camera, event (exists), rule, incident schemas as each slice needs them.
   - _Why now:_ contract-first is Law 4; consumers need types.
   - _Depends on:_ Phase 0 contracts. _Enables:_ every service below.
2. **`@vip/tenancy`** (repo/query guard) + **`@vip/permissions`** (authz model) scaffolds.
   - _Why now:_ isolation + authz are used by every service.
   - _Depends on:_ `@vip/contracts` `TenantContext`. _Enables:_ P1-1, P1-2.

## M1 — Access

3. **P1-1 `tenant` service + isolation guard.**
   - _Why now:_ the tenant is the root of all data; nothing is safe to build until isolation is structural.
   - _Depends on:_ Step 0. _Enables:_ all tenant-scoped services + the isolation test gate.
4. **P1-2 `identity` extension + `gateway` + `@vip/permissions`.**
   - _Why now:_ you must authenticate and mint context before exposing any protected resource.
   - _Depends on:_ P1-1. _Enables:_ every authenticated API; safe camera management.

## M2 — Ingestion

5. **P1-3 `camera` service + org hierarchy.**
   - _Why now:_ you need a camera (and where it lives) before you can ingest it.
   - _Depends on:_ P1-1, P1-2. _Enables:_ P1-4 (a stream to connect to).
6. **P1-4 `media` service (RTSP → frames + recording).**
   - _Why now:_ frames are the raw material for perception; recording backs evidence.
   - _Depends on:_ P1-3, [STORAGE](STORAGE_ARCHITECTURE.md). _Enables:_ P1-6.

## M3 — Perception

7. **P1-6 `inference` capability (frames → detections).**
   - _Why now:_ detections are the signal events are made of; the model-agnostic runtime is proven here.
   - _Depends on:_ P1-4 + Phase 0 registry. _Enables:_ P1-5.
8. **P1-5 `events` service (detections → persisted events).**
   - _Why now:_ the backbone everything downstream reacts to; needs real detections to normalize.
   - _Depends on:_ P1-6, P1-1. _Enables:_ P1-7.

## M4 — Response

9. **P1-7 `rules` service (events → incident candidates).**
   - _Why now:_ deciding "this matters" requires a real event stream.
   - _Depends on:_ P1-5. _Enables:_ P1-8.
10. **P1-8 `workflow` + `notify` (candidates → delivered alert).**
    - _Why now:_ closes the vertical; needs candidates + evidence refs + recipients.
    - _Depends on:_ P1-7, P1-4, P1-2. _Enables:_ the **end-to-end demo** and Phase 1 exit.

## Continuous (every step)

- **[OBSERVABILITY](OBSERVABILITY.md):** each service ships `/health` `/ready` `/metrics` + correlation propagation as it is built.
- **Isolation tests:** grow the cross-tenant suite with every new data path; it is a standing CI gate.
- **Governance:** ADR (if architectural), ED-log, risks/assumptions/questions, quality gate, scenario doc, sprint review (Architect PENDING) per slice.

## Why this order (summary)

Security first (isolation → auth), then the **data flows in its natural direction** (camera → frames → detections → events → rules → alerts). Each step consumes the previous step's _real_ output, so integration is proven continuously rather than at the end — and the first demonstrable, sellable increment (an alert from a camera) arrives at the last step, not after a long horizontal build.
