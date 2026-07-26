# services/ — Backend Services (Control + Data Plane)

Node.js/TypeScript services. **No industry/customer logic here** (Law 1). Each service is contract-first, tenant-scoped, observable, and independently deployable.

## Layout (one folder per service)
```
gateway/       API gateway: authN/Z, tenant routing, rate limit        (Presentation)
identity/      Tenants, users, roles, auth, sessions                    (Control)
entitlements/  Plans, packs, feature flags, quotas, metering            (Control)
inventory/     Org→…→camera/device hierarchy, zones                     (Control)
registry/      Capability + model/dataset + plugin registries          (Control)
fleet/         Edge provisioning, health, OTA, config sync              (Control)
billing/       Subscriptions, invoices, usage rollups                  (Control)
media/         Ingest, transcode, HLS/WebRTC, recording                 (Data)
pipeline/      Frame extraction + capability DAG orchestration          (Data)
events/        Event Platform (ingest/correlate/dedup/store/replay)     (Data)
rules/         Rule Engine evaluation                                   (Data)
workflow/      Incident/case/escalation orchestration                  (Data)
evidence/      Clips, snapshots, timelines, export, retention           (Data)
notify/        Multi-channel notification + escalation delivery         (Data)
analytics/     Aggregation, read models, reports                        (Data)
search/        Structured + semantic/NL event search                   (Data)
```

## Conventions
- Internal layout: `transport → application/service → domain → adapters(repos/clients)`. Domain never imports transport.
- Internal RPC: gRPC (Protobuf from `packages/contracts`). Public: REST/OpenAPI + WS via `gateway`.
- Mandatory: `/health`, `/ready`, `/metrics`; tenant context on every path; data-layer `tenantId` guard; outbox for event emission.
- Every service ships unit + contract + integration + isolation tests.

See [docs/architecture/04-SYSTEM-OVERVIEW](../docs/architecture/04-SYSTEM-OVERVIEW.md) for the component map and [03-ARCHITECTURE-PRINCIPLES](../docs/architecture/03-ARCHITECTURE-PRINCIPLES.md) for standards.
