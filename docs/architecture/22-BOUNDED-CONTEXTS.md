# 22 — Bounded Contexts (Domain-Driven Design)

## Purpose
Make the platform's domain boundaries **explicit** so large teams and many AI agents can own, build, and evolve parts of the system independently without creating hidden coupling or cyclic dependencies. This is the DDD organizing view over the services in [04](04-SYSTEM-OVERVIEW.md) and the ownership catalog in [23](23-SERVICE-OWNERSHIP.md). Ratified by [ADR-0010](../adr/ADR-0010-ddd-bounded-contexts-and-ownership.md).

## Responsibilities
- Define each bounded context: its purpose, responsibilities, **owned data**, public APIs, published/subscribed events, dependencies, invariants (rules), extension points, and future expansion.
- Establish the rule that a context owns its data and integrates only via events/contracts — never another context's database.

---

## Context map (at a glance)

```
Identity ─┐                         ┌─ Billing ── Licensing
Tenant ───┼─ (control plane) ───────┤
          │                         └─ Fleet ── Deployment
Camera ─ Media ─ Inference ─ Capability ─ Composition ─ Event ─ Rule ─ Workflow ─ Evidence ─ Notification
                                    │                     │
                                 Tracking             Analytics ── Digital-Twin
                                                          │
                                                     Monitoring (observes all)
                                                     Connector (edge in/out of Event)
```
**Golden rule:** a context **owns its data**; other contexts read it only through that context's public API or its published events. No shared tables, no cross-context DB reads. The dependency graph is acyclic ([23 §Dependency Graph](23-SERVICE-OWNERSHIP.md)).

Relationship patterns (DDD): most integrations are **event-driven (published language = the event catalog, [09](09-EVENT-PLATFORM.md))**; control-plane reads are **customer/supplier** via APIs; `packages/contracts` is the **shared kernel** (schemas only).

---

## The contexts

> Format per context: **Purpose · Responsibilities · Owns · Public API · Publishes · Subscribes · Depends on · Invariants · Extension points · Future.** Events use the `<domain>.<subject>.<predicate>` taxonomy ([09](09-EVENT-PLATFORM.md)).

### 1. Identity Context
- **Purpose:** Authenticate principals (users, services) and manage credentials/sessions.
- **Responsibilities:** OIDC/JWT/refresh, MFA, SSO/SAML/SCIM, API keys, passkeys, session/device management.
- **Owns:** users, credentials, sessions, refresh tokens, MFA secrets, API keys.
- **Public API:** `/auth/*`, `/users`, `/api-keys`.
- **Publishes:** `identity.user.created|invited|disabled`, `identity.session.started|revoked`.
- **Subscribes:** `tenant.created` (bootstrap owner user).
- **Depends on:** Tenant (for tenant binding). **Invariants:** every principal resolves to exactly one tenant; credentials never logged.
- **Extension points:** external IdP providers, MFA methods. **Future:** passwordless-first, decentralized identity.

### 2. Tenant Context
- **Purpose:** Own the tenant, the org hierarchy, roles/permissions/scopes, entitlements, feature flags, and configuration.
- **Responsibilities:** provision tenants; org→region→…→zone hierarchy; RBAC/ABAC policy; entitlement resolution; config precedence; branding/domains.
- **Owns:** organizations, branches, sites, buildings, floors, zones, roles, permissions, scopes, entitlements, feature flags, configs, branding, custom domains.
- **Public API:** `/organizations`, `/branches`, `/sites`, `/zones`, `/roles`, `/plans`(read), `/feature-flags`, `/branding`.
- **Publishes:** `tenant.created|suspended`, `tenant.entitlements.changed`, `tenant.hierarchy.changed`.
- **Subscribes:** `billing.subscription.changed` (→ recompute entitlements).
- **Depends on:** Identity (principals). **Invariants:** no operation without resolved tenant; entitlement gates every capability/composition/connector.
- **Extension points:** custom role/permission bundles, config providers. **Future:** delegated admin for partners/OEMs.

### 3. Camera Context
- **Purpose:** Manage cameras/devices as inventory and their configuration (zones, assigned capabilities, credentials).
- **Responsibilities:** onboarding (ONVIF/RTSP/RTMP), credential vaulting, zone/line definitions, capability assignment, camera health status.
- **Owns:** cameras, devices, camera credentials (encrypted), zones/ROIs/lines, capability assignments, camera health.
- **Public API:** `/cameras`, `/cameras/:id/zones`, `/cameras/:id/capabilities`, `/cameras/discover`.
- **Publishes:** `camera.registered|updated|removed`, `camera.assignment.changed`, `device.camera.offline|online`.
- **Subscribes:** `fleet.device.provisioned` (bind camera↔edge), `tenant.hierarchy.changed`.
- **Depends on:** Tenant. **Invariants:** a camera belongs to one site/edge; credentials never leave the vault in plaintext.
- **Extension points:** new device/sensor source types, discovery protocols. **Future:** non-camera sensors (audio/thermal/radar/IoT).

### 4. Media Context
- **Purpose:** Ingest, decode, transcode, stream, record, and ring-buffer video.
- **Responsibilities:** RTSP/RTMP ingest, hardware decode, WebRTC/HLS renditions, snapshots, pre-roll ring buffer, optional recording, signed media URLs.
- **Owns:** stream sessions, ring-buffer config, recording segments, media tokens.
- **Public API:** `/cameras/:id/live`, `/cameras/:id/hls`, `/cameras/:id/playback`, `/cameras/:id/snapshot`.
- **Publishes:** `media.stream.started|stopped|degraded`, `media.frame.batch` (internal to Inference).
- **Subscribes:** `camera.registered|removed`, `camera.assignment.changed`.
- **Depends on:** Camera. **Invariants:** raw video does not leave the site in edge/hybrid mode; every stream URL is short-lived + signed.
- **Extension points:** codecs, decode backends, streaming protocols. **Future:** audio/thermal ingest, WebRTC SFU scale-out.

### 5. Inference Context
- **Purpose:** Run model-agnostic inference for perception capabilities.
- **Responsibilities:** load models by registry selector, batching, GPU/CPU scheduling, ROI masking, quantization, edge/cloud serving.
- **Owns:** loaded-model runtime state (no source-of-truth data; models come from Registry).
- **Public API:** internal gRPC `Infer(frameBatch, modelSelector) → detections` (not public).
- **Publishes:** `inference.detection.produced` (normalized detections).
- **Subscribes:** `media.frame.batch`, `registry.model.promoted|rolled-back`.
- **Depends on:** Media (frames), Registry (models). **Invariants:** never hardcodes a model; safety-critical inference keeps reserved lanes.
- **Extension points:** `model.provider` plugins ([20](20-EXTENSIBILITY.md)), runtimes/accelerators. **Future:** open-vocab/VLM models, sensor-fusion inference.

### 6. Capability Context
- **Purpose:** Own the capability registry, descriptors, and the DAG orchestrator that wires atomic capabilities per camera.
- **Responsibilities:** register/discover capabilities, build the capability DAG from descriptors, drive the Execution Scheduler placement.
- **Owns:** capability descriptors, capability registry, per-camera DAG definitions.
- **Public API:** `/capabilities`, `/capabilities/:id/assignments`.
- **Publishes:** `capability.output.*` (normalized per-capability events), `capability.registered`.
- **Subscribes:** `inference.detection.produced`, `camera.assignment.changed`, `tenant.entitlements.changed`.
- **Depends on:** Inference, Tenant (entitlements). **Invariants:** capabilities never carry industry logic; communicate only via events/contracts.
- **Extension points:** `capability.provider` plugins. **Future:** auto-composition suggestions. → [05](05-CAPABILITY-ARCHITECTURE.md)

### 7. Tracking Context
- **Purpose:** Provide multi-object tracking and re-identification as a shared substrate for temporal/spatial reasoning.
- **Responsibilities:** stable track IDs, trajectories, velocity, dwell, cross-frame/cross-camera re-ID.
- **Owns:** track state (ephemeral, TTL'd), re-ID embeddings (per-tenant namespace).
- **Public API:** internal; exposed as capability outputs.
- **Publishes:** `tracking.track.updated`, `tracking.track.crossed`, `recognition.reid.matched`.
- **Subscribes:** `capability.output.person-detection|vehicle-detection|object-detection`.
- **Depends on:** Capability (detections). **Invariants:** tracking is a capability itself; no business meaning attached here.
- **Extension points:** tracker algorithms, re-ID models (via `model.provider`). **Future:** global city-scale re-ID. *(Called out as its own context because so many compositions depend on it — see [Capability Dependency Graph, 05](05-CAPABILITY-ARCHITECTURE.md).)*

### 8. Event Context
- **Purpose:** The event backbone — normalize, deduplicate, correlate, prioritize, persist, stream, replay.
- **Responsibilities:** taxonomy/catalog, dedup, correlation, aggregation, storage, live fan-out, replay, timeline.
- **Owns:** events, event embeddings (vector), correlations, timelines.
- **Public API:** `/events`, `/events/:id`, `/timelines/:cameraId`, WS `/events`.
- **Publishes:** `event.persisted`, correlated/aggregate events (`situation.*`, `aggregate.*`).
- **Subscribes:** `capability.output.*`, `composition.output.*`, `tracking.*`, `connector.inbound.*`.
- **Depends on:** Capability, Composition, Connector. **Invariants:** events are domain-neutral (no industry meaning); additive-only schemas.
- **Extension points:** `event.enricher` hooks, CEP operators. **Future:** cross-tenant (privacy-preserving) aggregation. → [09](09-EVENT-PLATFORM.md)

### 9. Rule Context
- **Purpose:** Evaluate tenant-defined rules over events and emit business outcomes.
- **Responsibilities:** rule DSL, evaluator (temporal/spatial/threshold/confidence), dry-run, versioning, scoping, rule packs.
- **Owns:** rules, rule versions, rule state (Redis), rule templates.
- **Public API:** `/rules`, `/rules/:id/dry-run`, `/rule-packs`.
- **Publishes:** `incident.candidate`, `rule.matched`, rule-driven `emit_event` outputs.
- **Subscribes:** `event.persisted`, correlated/aggregate/`composition.output.*` events.
- **Depends on:** Event. **Invariants:** rules carry no industry identity; deterministic; sandboxed DSL (no arbitrary code).
- **Extension points:** `rule.condition`, `rule.action` plugins. **Future:** NL→rule authoring, ML-assisted suggestions. → [10](10-RULE-ENGINE.md)

### 10. Workflow Context
- **Purpose:** Orchestrate response after a rule fires — incidents, cases, escalation, approvals.
- **Responsibilities:** incident/case lifecycle, escalation policies + timers, approvals, operator/manager actions, audit.
- **Owns:** incidents, cases, workflow definitions/state, escalation policies, on-call schedules, audit log (workflow scope).
- **Public API:** `/incidents`, `/incidents/:id/(ack|assign|resolve)`, `/workflows`, `/escalation-policies`, `/on-call`.
- **Publishes:** `incident.raised|acknowledged|resolved|closed`, `workflow.escalated`, `workflow.approval.requested|granted`.
- **Subscribes:** `incident.candidate`, `rule.matched`, `notification.delivered|acked`.
- **Depends on:** Rule, Notification. **Invariants:** every action audited (hash-chained); workflows are declarative + industry-neutral.
- **Extension points:** `workflow.state`, `workflow.action`, approval providers. **Future:** BPMN import, ITSM/PSIM integration. → [11](11-WORKFLOW-ENGINE.md)

### 11. Evidence Context
- **Purpose:** Produce and govern defensible evidence (clips, snapshots, timelines, exports).
- **Responsibilities:** smart-clip extraction, merge, transcode, annotations, export (watermark+manifest), retention, legal hold, chain of custody.
- **Owns:** clips, snapshots, evidence metadata, bookmarks/annotations, exports, retention policies, legal holds, custody logs.
- **Public API:** `/evidence`, `/evidence/:id/download`, `/exports`, `/legal-holds`.
- **Publishes:** `evidence.created|exported|held|purged`.
- **Subscribes:** `incident.raised`, `event.persisted` (with `extract_evidence` action), `media.frame.batch` (ring buffer).
- **Depends on:** Media (ring buffer), Event, Workflow. **Invariants:** original media immutable (overlay annotations); custody append-only; legal hold overrides deletion.
- **Extension points:** export formats, redaction providers. **Future:** blockchain-anchored custody, synchronized multi-cam playback. → [12](12-EVIDENCE-MANAGEMENT.md)

### 12. Notification Context
- **Purpose:** Deliver notifications across channels with escalation semantics.
- **Responsibilities:** multi-channel delivery (email/SMS/WhatsApp/push/voice/webhook/Slack/Teams), dedupe, quiet hours, retries, delivery logging, ack tracking.
- **Owns:** notification channels, delivery log, quiet-hours/preferences.
- **Public API:** `/notification-channels`, `/notifications`.
- **Publishes:** `notification.sent|delivered|failed|acked`.
- **Subscribes:** `incident.raised`, `workflow.escalated`, rule `notify` actions.
- **Depends on:** Workflow/Rule (triggers). **Invariants:** channels are pluggable; critical path budget < 3 s.
- **Extension points:** `notification.channel` plugins. **Future:** two-way conversational channels. → [11 §4](11-WORKFLOW-ENGINE.md)

### 13. Analytics Context
- **Purpose:** Aggregate events/tracks/compositions into metrics, read models, and reports.
- **Responsibilities:** counting/occupancy/heatmaps/dwell/queue/footfall/trends, materialized read models, report generation/scheduling, forecasting; NL/semantic search read side.
- **Owns:** analytics aggregates, KPI snapshots, dashboards, report definitions/runs, saved searches.
- **Public API:** `/analytics/*`, `/dashboards`, `/reports`, `/search`.
- **Publishes:** `analytics.report.ready`, `aggregate.*` (may feed Event/Rule).
- **Subscribes:** `event.persisted`, `composition.output.*`, `aggregate.*`.
- **Depends on:** Event, Composition. **Invariants:** read-only projections; never the source of truth.
- **Extension points:** `report.generator`, dashboard widgets, forecasting models. **Future:** prescriptive analytics, cross-site benchmarking. → [16](16-OBSERVABILITY.md)/analytics

### 14. Monitoring Context (Observability)
- **Purpose:** Observe the platform itself (metrics, traces, logs, health, SLOs) — distinct from customer event alerts.
- **Responsibilities:** telemetry collection, SLO/error-budget alerting, capacity signals, dashboards, on-call paging.
- **Owns:** platform metrics/traces/logs stores, SLO definitions, ops alert rules.
- **Public API:** `/health`, `/ready`, `/metrics` (per service); ops dashboards.
- **Publishes:** `ops.alert.fired`, `ops.slo.breached`.
- **Subscribes:** telemetry from every context (cross-cutting consumer).
- **Depends on:** all (observes). **Invariants:** no PII in telemetry; ops alerts ≠ customer notifications.
- **Extension points:** exporters, alerting integrations. **Future:** anomaly detection on ops metrics, capacity forecasting. → [16](16-OBSERVABILITY.md)

### 15. Deployment Context
- **Purpose:** Package, provision, release, and roll back the platform across cloud/on-prem/hybrid/edge.
- **Responsibilities:** IaC, Helm/umbrella charts per mode, blue-green/canary, migrations (expand/contract), DR/backup orchestration.
- **Owns:** deployment manifests/values, release records, migration state.
- **Public API:** CI/CD + platform admin (internal).
- **Publishes:** `deploy.release.started|succeeded|rolled-back`.
- **Subscribes:** `registry.model.promoted` (may trigger canary), `ops.slo.breached` (auto-rollback signal).
- **Depends on:** Registry, Monitoring. **Invariants:** every deploy reversible; migrations backward-compatible.
- **Extension points:** deployment targets, progressive-delivery controllers. **Future:** GitOps, multi-region active-active. → [17](17-DEVOPS-AND-INFRA.md)

### 16. Billing Context
- **Purpose:** Meter usage and bill tenants/partners.
- **Responsibilities:** usage metering (cameras, storage, inference-hours, alert credits, API), subscriptions, invoices, proration, dunning, reseller/partner billing.
- **Owns:** plans, subscriptions, invoices, usage counters, credits, reseller accounts, payment methods.
- **Public API:** `/plans`, `/subscriptions`, `/usage`, `/billing/*`.
- **Publishes:** `billing.subscription.changed`, `billing.usage.recorded`, `billing.quota.exceeded`.
- **Subscribes:** metering events from all metered contexts (`media.*`, `inference.*`, `notification.*`, API gateway).
- **Depends on:** Tenant. **Invariants:** metering never blocks the hot path (async); quotas enforced by Tenant entitlements.
- **Extension points:** billing providers, metering dimensions. **Future:** marketplace revenue-share settlement. → [06](06-MULTI-TENANT-SAAS.md)

### 17. Licensing Context
- **Purpose:** Issue and validate licenses, especially for on-prem/air-gapped and OEM deployments.
- **Responsibilities:** license issuance/validation, offline license server, entitlement attestation for disconnected sites, OEM/white-label license keys.
- **Owns:** licenses, license grants, offline attestation records.
- **Public API:** `/licenses`, offline license server endpoints.
- **Publishes:** `license.issued|revoked|expiring`.
- **Subscribes:** `billing.subscription.changed`, `tenant.entitlements.changed`.
- **Depends on:** Billing, Tenant. **Invariants:** on-prem entitlements enforceable offline; license tamper-evident.
- **Extension points:** license models (per-camera/site/OEM). **Future:** usage-based on-prem metering with periodic reconciliation.

### 18. Fleet Management Context
- **Purpose:** Manage the edge device fleet at scale.
- **Responsibilities:** device provisioning/identity, health/heartbeat, config sync, OTA (agent + models), remote management/wipe, fleet grouping.
- **Owns:** edge devices, edge health, edge deployments, OTA jobs, device certificates.
- **Public API:** `/edge-devices`, `/edge-devices/:id/ota`.
- **Publishes:** `fleet.device.provisioned|online|offline|degraded`, `fleet.ota.started|succeeded|rolled-back`.
- **Subscribes:** `registry.model.promoted` (OTA campaign), `camera.assignment.changed` (config sync), `deploy.release.*`.
- **Depends on:** Registry, Deployment, Camera, Tenant. **Invariants:** device bound to one tenant; OTA signed/staged/rollback-able; local storage encrypted.
- **Extension points:** device types, OTA strategies. **Future:** edge clustering, edge-to-edge coordination. → [14](14-EDGE-PLATFORM.md)

### Additional contexts (defined in their own sections)
- **Composition Context** — reusable business compositions between Capability and Event. → [24](24-COMPOSITION-FRAMEWORK.md)
- **Connector Context** — inbound/outbound external-system integration as plugins. → [25](25-CONNECTOR-PLATFORM.md)
- **Digital-Twin Context** — live spatial projection for visualization/reasoning. → [26](26-DIGITAL-TWIN.md)
- **Registry Context** — model/dataset/plugin registries (source of truth for artifacts). → [08](08-AI-ML-PLATFORM.md), [20](20-EXTENSIBILITY.md)

## Design decisions
- **Data ownership per context, integration via events** is the mechanism that prevents the shared-database coupling that kills large systems.
- **Tracking is its own context** because it is the shared substrate most compositions depend on; isolating it clarifies the dependency graph.
- **Monitoring subscribes to all but is depended on by none** (cross-cutting observer) — it never sits on a business hot path.

## Advantages
- Clear team/agent ownership; safe independent evolution; explicit, acyclic dependencies.
- The context map doubles as an onboarding map and a work-allocation map.

## Tradeoffs
- More upfront definition and the discipline to never cross a context's data boundary; enforced by CI (no cross-context DB access) and code review.

## Future expansion
- New contexts (e.g. Sensor-Fusion, Marketplace-Settlement) slot in as event publishers/subscribers without disturbing existing ones.

## Cross-references
[04-SYSTEM-OVERVIEW](04-SYSTEM-OVERVIEW.md) · [23-SERVICE-OWNERSHIP](23-SERVICE-OWNERSHIP.md) · [09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [24-COMPOSITION-FRAMEWORK](24-COMPOSITION-FRAMEWORK.md) · [ADR-0010](../adr/ADR-0010-ddd-bounded-contexts-and-ownership.md)
