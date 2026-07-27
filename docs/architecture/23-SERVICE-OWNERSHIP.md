# 23 — Service Ownership & Dependency Graph

## Purpose
Define, for every service, exactly what it owns and how it behaves operationally, and present the **service dependency graph** that must remain acyclic. This is the operational companion to the domain view in [22](22-BOUNDED-CONTEXTS.md) and the component list in [04](04-SYSTEM-OVERVIEW.md). Ratified by [ADR-0010](../adr/ADR-0010-ddd-bounded-contexts-and-ownership.md).

## Responsibilities
- Give each service a single, unambiguous owner-of-record for its data, APIs, and events.
- Specify per service: responsibilities · inputs · outputs · owned database · owned APIs · published events · consumed events · external deps · internal deps · health checks · scaling strategy · failure handling · security responsibilities.
- Define the dependency graph and the no-cycles invariant (CI-enforced).

---

## 1. Service dependency graph (runtime data path)

```
Camera ─▶ Media ─▶ Inference ─▶ Capability ─▶ Composition ─▶ Event ─▶ Rule ─▶ Workflow ─▶ Evidence
                                    │              │            │                 │            │
                                 Tracking ─────────┘        Analytics         Notification ◀───┘
                                                               │
                                                          Digital-Twin
Connector ──▶ Event (inbound)      Workflow/Notification ──▶ Connector (outbound)
```

**Control-plane services** (read/config, off the hot path): `Gateway`, `Identity`, `Tenant`, `Entitlements`, `Registry`, `Fleet`, `Billing`, `Licensing`, `Deployment`. **Cross-cutting observer:** `Monitoring` (depends on all; nothing business depends on it).

**Invariants (CI-enforced):**
- **No cycles.** The graph above is a DAG on the hot path; control-plane calls point "inward" (data → control for reads) and never form a loop.
- **No shared databases.** A service reads another's data only via that service's API or published events ([22 golden rule](22-BOUNDED-CONTEXTS.md)).
- **Communication:** hot path = **events** (at-least-once, idempotent); queries/commands = **gRPC/REST**; media = streaming; emission = **outbox**. → [04 §4](04-SYSTEM-OVERVIEW.md)

---

## 2. Service ownership catalog

> Each service maps to a bounded context ([22](22-BOUNDED-CONTEXTS.md)). Health = `/health` (liveness) + `/ready` (readiness incl. backing services) + `/metrics` unless noted.

### gateway (Presentation)
- **Responsibilities:** API gateway — authN/Z, tenant routing, rate limit, request validation, WebSocket termination.
- **Inputs:** external HTTP/WS. **Outputs:** routed gRPC to services; responses.
- **Owned DB:** none (stateless). **Owned APIs:** the public `/api/v1/*` edge surface (proxied).
- **Publishes:** `api.request.metered` (→ Billing). **Consumes:** none.
- **External deps:** IdP (token validation). **Internal deps:** Identity, Tenant (context resolution).
- **Scaling:** stateless HPA on RPS/latency. **Failure:** fail-closed on auth; circuit-break to upstreams; shed load with 429.
- **Security:** TLS termination, WAF, rate limits, signed-URL issuance authority, no business logic.

### identity (Identity Context)
- **Responsibilities:** authenticate principals; sessions/MFA/SSO/API keys.
- **Inputs:** login/token requests. **Outputs:** tokens, principal context.
- **Owned DB:** users, credentials, sessions, refresh tokens, MFA, API keys. **Owned APIs:** `/auth/*`, `/users`, `/api-keys`.
- **Publishes:** `identity.user.*`, `identity.session.*`. **Consumes:** `tenant.created`.
- **External deps:** external IdPs. **Internal deps:** Tenant.
- **Scaling:** stateless HPA; session state in Redis. **Failure:** deny on doubt; refresh-reuse detection revokes lineage.
- **Security:** credential hashing (argon2), secret storage, breach lockout, audit of auth events.

### tenant (Tenant Context — includes entitlements/config)
- **Responsibilities:** tenant lifecycle, org hierarchy, RBAC/ABAC, entitlements, feature flags, config, branding/domains.
- **Inputs:** admin/config APIs; `billing.subscription.changed`. **Outputs:** entitlement decisions, hierarchy.
- **Owned DB:** organizations…zones, roles/permissions/scopes, entitlements, flags, configs, branding, domains. **Owned APIs:** `/organizations`,`/branches`,`/sites`,`/zones`,`/roles`,`/feature-flags`,`/branding`.
- **Publishes:** `tenant.created|suspended`, `tenant.entitlements.changed`, `tenant.hierarchy.changed`. **Consumes:** `billing.subscription.changed`.
- **Internal deps:** Identity. **Scaling:** stateless HPA; entitlements cached in Redis (`ff:{tenantId}`).
- **Failure:** entitlement cache miss → recompute (fail-closed to least privilege). **Security:** owns the RBAC/ABAC policy module (`packages/permissions`); tenant-isolation source of truth.

### inventory/camera (Camera Context)
- **Responsibilities:** camera/device inventory, zones, capability assignment, credentials, health status.
- **Inputs:** onboarding APIs, ONVIF discovery, `fleet.device.provisioned`. **Outputs:** camera config, assignments.
- **Owned DB:** cameras, devices, camera credentials(enc), zones/lines, assignments, camera health. **Owned APIs:** `/cameras`, `/cameras/:id/zones`, `/cameras/:id/capabilities`, `/cameras/discover`.
- **Publishes:** `camera.*`, `device.camera.offline|online`. **Consumes:** `fleet.device.provisioned`, `tenant.hierarchy.changed`.
- **Internal deps:** Tenant, (Fleet for binding). **Scaling:** stateless HPA. **Failure:** stale-config tolerant (edge caches last-good).
- **Security:** camera credential vaulting; VLAN/segmentation metadata; assignment authorization.

### media (Media Context)
- **Responsibilities:** ingest/decode/transcode/stream/record/ring-buffer.
- **Inputs:** RTSP/RTMP streams; `camera.*`. **Outputs:** frame batches (→ Inference), HLS/WebRTC, snapshots, ring buffer.
- **Owned DB:** stream sessions, ring-buffer config, recording segments (metadata; media in object storage). **Owned APIs:** `/cameras/:id/live|hls|playback|snapshot`.
- **Publishes:** `media.stream.*`, `media.frame.batch`. **Consumes:** `camera.registered|removed|assignment.changed`.
- **Internal deps:** Camera; object storage. **Scaling:** per-stream workers; GPU/decoder-bound; scale by camera count; SFU for live fan-out.
- **Failure:** auto-reconnect, backpressure, drop-to-lower-FPS before frame loss; ring buffer survives brief stalls.
- **Security:** raw video stays local (edge/hybrid); signed short-lived media tokens; no raw frames in logs.

### inference (Inference Context)
- **Responsibilities:** model-agnostic inference; batching; GPU/CPU scheduling; edge/cloud serving.
- **Inputs:** `media.frame.batch`; models from Registry. **Outputs:** `inference.detection.produced`.
- **Owned DB:** none (runtime state only). **Owned APIs:** internal gRPC `Infer`.
- **Publishes:** `inference.detection.produced`. **Consumes:** `media.frame.batch`, `registry.model.promoted|rolled-back`.
- **Internal deps:** Media, Registry. **Scaling:** GPU worker pools autoscaled on inference queue depth; batching across streams.
- **Failure:** GPU OOM → shed non-critical models, reserved lanes for safety-critical; degrade FPS gracefully.
- **Security:** model integrity/signature check; no plaintext frames persisted; tenant-tagged jobs.

### pipeline/capability (Capability Context — also hosts Composition, see [24](24-COMPOSITION-FRAMEWORK.md))
- **Responsibilities:** capability registry, DAG orchestration, Execution Scheduler placement; hosts the Composition runtime.
- **Inputs:** `inference.detection.produced`, `camera.assignment.changed`, `tenant.entitlements.changed`. **Outputs:** `capability.output.*`, `composition.output.*`.
- **Owned DB:** capability/composition descriptors, per-camera DAG definitions. **Owned APIs:** `/capabilities`, `/capabilities/:id/assignments`.
- **Publishes:** `capability.output.*`, `composition.output.*`, `capability.registered`. **Consumes:** `inference.*`, `camera.*`, `tenant.entitlements.changed`.
- **Internal deps:** Inference, Tracking, Tenant. **Scaling:** stateless per-camera workers; scheduler balances edge/cloud.
- **Failure:** per-node isolation; a failing capability degrades its outputs only, not the DAG. **Security:** entitlement-gated capability enablement; no industry logic.

### tracking (Tracking Context)
- **Responsibilities:** multi-object tracking + re-ID substrate.
- **Inputs:** detection capability outputs. **Outputs:** `tracking.*`, re-ID matches.
- **Owned DB:** track state (TTL), re-ID embeddings (per-tenant vector namespace). **Owned APIs:** internal.
- **Publishes:** `tracking.track.updated|crossed`, `recognition.reid.matched`. **Consumes:** `capability.output.*detection`.
- **Internal deps:** Capability. **Scaling:** per-camera/zone workers; embeddings sharded per tenant.
- **Failure:** track loss tolerant (re-acquire); ephemeral state loss non-fatal. **Security:** embeddings encrypted; jurisdiction gating for re-ID.

### events (Event Context)
- **Responsibilities:** normalize/dedup/correlate/store/stream/replay events + timelines.
- **Inputs:** capability/composition/tracking/connector outputs. **Outputs:** persisted + correlated + streamed events.
- **Owned DB:** events, embeddings, correlations, timelines. **Owned APIs:** `/events`, `/timelines/:cameraId`, WS `/events`.
- **Publishes:** `event.persisted`, `situation.*`, `aggregate.*`. **Consumes:** `capability.output.*`, `composition.output.*`, `tracking.*`, `connector.inbound.*`.
- **Internal deps:** Capability, Composition, Connector. **Scaling:** partitioned by tenant/camera; consumer groups; horizontal.
- **Failure:** at-least-once + idempotent consumers; replay for recovery. **Security:** per-tenant partitions/namespaces; PII classification per event type.

### rules (Rule Context)
- **Responsibilities:** evaluate rules over events; dry-run; versioning; rule packs.
- **Inputs:** `event.persisted` + correlated/aggregate events. **Outputs:** `incident.candidate`, `rule.matched`.
- **Owned DB:** rules, versions, rule state (Redis), templates. **Owned APIs:** `/rules`, `/rules/:id/dry-run`, `/rule-packs`.
- **Publishes:** `incident.candidate`, `rule.matched`, `emit_event`. **Consumes:** `event.persisted`, `composition.output.*`.
- **Internal deps:** Event. **Scaling:** partitioned by tenant/camera; stateful ops in Redis.
- **Failure:** deterministic re-evaluation via replay; bounded rule state. **Security:** sandboxed DSL; tenant-scoped; audit rule changes.

### workflow (Workflow Context)
- **Responsibilities:** incident/case lifecycle, escalation, approvals, actions, audit.
- **Inputs:** `incident.candidate`, `rule.matched`, `notification.*`. **Outputs:** incident state, escalations, actions.
- **Owned DB:** incidents, cases, workflow defs/state, escalation policies, on-call, workflow audit. **Owned APIs:** `/incidents`, `/workflows`, `/escalation-policies`, `/on-call`.
- **Publishes:** `incident.*`, `workflow.escalated`, `workflow.approval.*`. **Consumes:** `incident.candidate`, `notification.delivered|acked`.
- **Internal deps:** Rule, Notification, Evidence. **Scaling:** stateful workflow instances; horizontal by tenant.
- **Failure:** durable state machine (resumable); timers survive restarts. **Security:** hash-chained audit; approval + reason-for-access enforcement.

### evidence (Evidence Context)
- **Responsibilities:** clips/snapshots/timelines/export/retention/legal-hold/custody.
- **Inputs:** ring buffer (Media), `incident.raised`, evidence actions. **Outputs:** stored evidence, exports.
- **Owned DB:** clips, snapshots, evidence metadata, annotations, exports, retention policies, legal holds, custody logs. **Owned APIs:** `/evidence`, `/exports`, `/legal-holds`.
- **Publishes:** `evidence.*`. **Consumes:** `incident.raised`, `event.persisted`(extract action).
- **Internal deps:** Media, Event, Workflow; object storage + KMS. **Scaling:** transcode worker pool; storage-tiering jobs.
- **Failure:** idempotent extraction; retry transcode; legal hold blocks purge. **Security:** per-tenant KMS, watermark+manifest, custody integrity, export approval.

### notify (Notification Context)
- **Responsibilities:** multi-channel delivery + escalation semantics.
- **Inputs:** `incident.raised`, `workflow.escalated`, rule `notify`. **Outputs:** channel deliveries, ack signals.
- **Owned DB:** channels, delivery log, preferences/quiet-hours. **Owned APIs:** `/notification-channels`, `/notifications`.
- **Publishes:** `notification.*`. **Consumes:** `incident.raised`, `workflow.escalated`.
- **External deps:** email/SMS/WhatsApp/voice/Slack/Teams providers (via Connector where applicable). **Internal deps:** Workflow.
- **Scaling:** channel worker pools; queue-depth scaling. **Failure:** retries + dead-letter; multi-provider failover; delivery logging.
- **Security:** provider credential vaulting; opt-out/consent; no sensitive payload in transit logs.

### analytics (Analytics Context)
- **Responsibilities:** aggregates, read models, reports, search read side.
- **Inputs:** `event.persisted`, `composition.output.*`, `aggregate.*`. **Outputs:** read models, reports, search results.
- **Owned DB:** analytics aggregates, KPI snapshots, dashboards, report defs/runs, saved searches; time-series + vector read side. **Owned APIs:** `/analytics/*`, `/dashboards`, `/reports`, `/search`.
- **Publishes:** `analytics.report.ready`, `aggregate.*`. **Consumes:** `event.persisted`, `composition.output.*`.
- **Internal deps:** Event, Composition. **Scaling:** read replicas + materialized views; heavy jobs off replicas.
- **Failure:** rebuildable from event replay; report retry. **Security:** read-only projections; scope-filtered queries; search RBAC + FR jurisdiction gating.

### registry (Registry Context)
- **Responsibilities:** model, dataset, and plugin registries (source of truth for artifacts + trust tiers).
- **Inputs:** model/dataset/plugin publish + promotion. **Outputs:** artifact metadata, selectors, promotion state.
- **Owned DB:** models, model versions, datasets, plugin manifests, promotions, model cards. **Owned APIs:** `/models`, `/datasets`, `/plugins`.
- **Publishes:** `registry.model.promoted|rolled-back`, `registry.plugin.enabled`. **Consumes:** `deploy.release.*`, model-CI results.
- **Internal deps:** object storage. **Scaling:** stateless HPA; artifacts in object storage. **Failure:** immutable versions; instant re-pin (rollback).
- **Security:** artifact signing, trust-tier enforcement, model-CI gate before promotion.

### fleet (Fleet Management Context)
- **Responsibilities:** edge provisioning, health, config sync, OTA, remote mgmt/wipe.
- **Inputs:** device heartbeats, `registry.model.promoted`, `camera.assignment.changed`. **Outputs:** OTA campaigns, config, device state.
- **Owned DB:** edge devices, edge health, edge deployments, OTA jobs, device certs. **Owned APIs:** `/edge-devices`, `/edge-devices/:id/ota`.
- **Publishes:** `fleet.device.*`, `fleet.ota.*`. **Consumes:** `registry.model.promoted`, `camera.assignment.changed`, `deploy.release.*`.
- **Internal deps:** Registry, Camera, Tenant. **Scaling:** handles thousands of devices; campaign batching.
- **Failure:** staged rollout + auto-rollback; offline devices reconcile on reconnect. **Security:** signed images, mTLS, remote wipe, encrypted local storage.

### billing / licensing (Billing & Licensing Contexts)
- **Responsibilities:** metering + invoicing (billing); license issue/validate incl. offline (licensing).
- **Owned DB:** plans, subscriptions, invoices, usage counters, credits, resellers (billing); licenses, grants, offline attestations (licensing). **Owned APIs:** `/plans`,`/subscriptions`,`/usage`,`/billing/*`; `/licenses`.
- **Publishes:** `billing.*`, `license.*`. **Consumes:** metering events; `tenant.entitlements.changed`.
- **Internal deps:** Tenant. **Scaling:** async metering aggregation; stateless. **Failure:** metering async (never blocks hot path); idempotent usage records.
- **Security:** PCI scope isolation (provider-hosted), license tamper-evidence, offline enforcement.

### connector (Connector Context) → [25](25-CONNECTOR-PLATFORM.md)
- **Responsibilities:** inbound/outbound external-system integration as plugins.
- **Owned DB:** connector instances, credentials(enc), delivery/ingest logs, mappings. **Owned APIs:** `/connectors`, `/connectors/:id/(enable|test)`.
- **Publishes:** `connector.inbound.*` (normalized), `connector.status.*`. **Consumes:** platform events for outbound (`incident.*`, `workflow.*`, rule actions).
- **Internal deps:** Event, Tenant. **Scaling:** per-connector workers; protocol adapters. **Failure:** retry + dead-letter; connector health isolated per instance.
- **Security:** per-connector credential vaulting, tenant-scoped, audited, entitlement-gated.

### monitoring (Monitoring Context) → [16](16-OBSERVABILITY.md)
- **Responsibilities:** platform observability (metrics/traces/logs/health/SLO/alerting/capacity).
- **Owned DB:** telemetry stores, SLO defs, ops alert rules. **Owned APIs:** ops dashboards; every service exposes `/metrics`.
- **Publishes:** `ops.alert.fired`, `ops.slo.breached`. **Consumes:** telemetry from all.
- **Internal deps:** all (observes). **Scaling:** telemetry pipeline scales with fleet; sampling/retention tiers.
- **Failure:** degrade to sampling; never on a business hot path. **Security:** no PII in telemetry; ops alerts separate from customer notifications.

### deployment (Deployment Context) → [17](17-DEVOPS-AND-INFRA.md)
- **Responsibilities:** package/provision/release/rollback across modes; DR/backup.
- **Owned:** deployment manifests/values, release records, migration state. **APIs:** CI/CD + admin (internal).
- **Publishes:** `deploy.release.*`. **Consumes:** `registry.model.promoted`, `ops.slo.breached`.
- **Internal deps:** Registry, Monitoring. **Scaling:** N/A (control). **Failure:** reversible deploys; expand/contract migrations; tested DR.
- **Security:** signed images/charts, least-privilege IaC, secrets from vault.

## Design decisions
- **One owner per data set**; everyone else integrates via events/APIs — the structural defense against coupling and cycles.
- **Metering, telemetry, and evidence transcode are async** so control/observability/billing never sit on the real-time hot path.
- **Failure handling favors graceful degradation** with reserved lanes for safety-critical inference.

## Advantages
- Any engineer/agent can pick a service and know precisely its contract, data, scaling, and failure behavior.
- The dependency graph + no-cycles CI rule keeps the architecture from decaying as it grows.

## Tradeoffs
- The catalog must be maintained as services land (part of the Definition of Done); the payoff is durable clarity for a large, long-lived team.

## Future expansion
- New services register here with the same 13-field profile and take their place in the DAG as event publishers/subscribers.

## Cross-references
[22-BOUNDED-CONTEXTS](22-BOUNDED-CONTEXTS.md) · [04-SYSTEM-OVERVIEW](04-SYSTEM-OVERVIEW.md) · [09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [16-OBSERVABILITY](16-OBSERVABILITY.md) · [17-DEVOPS-AND-INFRA](17-DEVOPS-AND-INFRA.md) · [ADR-0010](../adr/ADR-0010-ddd-bounded-contexts-and-ownership.md)
