# Phase 1 — Storage Architecture

> Cross-cutting. Grounds Phase 1 data stores in [18-DATA-ARCHITECTURE](../18-DATA-ARCHITECTURE.md), [12-EVIDENCE-MANAGEMENT](../12-EVIDENCE-MANAGEMENT.md), and the tenant rules in [TENANT_ARCHITECTURE](TENANT_ARCHITECTURE.md).

## Purpose

Define how each backing store (MongoDB, Redis, MinIO) is used, tenant-isolated, and accessed — consistently across services.

## Responsibilities

- One documented pattern per store; **tenant isolation enforced by wrappers**, not per-service discipline.
- Ownership boundaries: a service owns its collections; others read via API/events ([22 golden rule](../22-BOUNDED-CONTEXTS.md)).

## Components & strategy

| Store        | Used for                                                 | Isolation                                                      | Access rule                                                         |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| **MongoDB**  | OLTP: tenants, users, cameras, events, rules, incidents  | `tenantId` on every doc; compound indexes lead with `tenantId` | `@vip/tenancy` repo guard injects/requires `tenantId` (fail-closed) |
| **Redis**    | sessions, refresh state, rate limits, rule state, caches | key prefix `t:{tenantId}:…`                                    | prefix-enforcing client wrapper                                     |
| **MinIO/S3** | recordings, evidence clips/snapshots                     | object prefix `{tenantId}/{cameraId}/…`                        | storage wrapper requires `TenantContext`; signed URLs only          |

## Data flow

```mermaid
flowchart TB
    Svc[Any service] --> Guard[@vip/tenancy guard]
    Guard -->|tenantId filter| Mongo[(MongoDB)]
    Svc --> RedisW[redis wrapper t:tenant:*] --> Redis[(Redis)]
    Svc --> S3W[storage wrapper tenant/prefix] --> MinIO[(MinIO)]
```

## APIs

Internal library APIs (not network): `@vip/tenancy` repository base; a Redis client wrapper; a storage/signed-URL helper. All require a `TenantContext`.

## Dependencies

Phase 0 dev stack (Mongo/Redis/MinIO) + `@vip/config` groups (`database`, `redis`, `storage`). No service bypasses the wrappers (review + `check:imports`).

## Failure handling

- Missing `TenantContext` at any wrapper → throw, fail-closed.
- Mongo unavailable → service unready (`/ready` 503); retries with backoff.
- MinIO write fail → retry + degraded flag; never blocks the hot path.
- Redis down → degrade (e.g. rate-limit fail-closed or bypass per policy), documented per use.

## Scaling strategy

- Mongo: indexes lead with `tenantId`; read replicas + materialized views for analytics (Phase 2); siloed DB per enterprise tenant later (connection resolver).
- MinIO: tenant-prefixed; lifecycle/tiering + retention tags for evidence.
- Redis: per-tenant logical DBs / sharding for hot state later.

## Security considerations

- Prefix/namespace isolation everywhere; signed, short-lived URLs for media; encryption at rest (app-layer in Phase 1; per-tenant KMS envelope encryption in Phase 3, [15 §4](../15-SECURITY-ARCHITECTURE.md)); no secrets in code (ADR-0018).

## Future extension points

- Siloed-per-tenant DBs; regional data planes ([27](../27-CONTROL-DATA-PLANE.md)); vector store for embeddings/search (Phase 2, [ND-2](../../../tracking/TASK-BOARD.md)); object lifecycle + legal hold.
