# 27 — Control Plane / Data Plane Architecture

> Final Architecture Enhancement (v1.0). Formalizes the separation implied in [04](04-SYSTEM-OVERVIEW.md). Ratified by [ADR-0011](../adr/ADR-0011-control-plane-data-plane-separation.md).

## Purpose

Completely separate **business management** (Control Plane) from **video/AI processing** (Data Plane) so they scale, fail, deploy, and are secured independently — and so the Data Plane can run at the edge, offline, while the Control Plane stays cloud-managed.

## Responsibilities

### Control Plane (business management — cloud, global/regional)

Tenant management · Authentication · Authorization · Identity · Organization/hierarchy · Subscription · Billing · Licensing · Fleet management · Configuration · **Policy** ([28](28-POLICY-ENGINE.md)) · Audit · Monitoring · Deployment · Feature flags · Secrets · **API Gateway**.
Maps to contexts: Identity, Tenant, Billing, Licensing, Fleet, Deployment, Monitoring, Policy, Registry (control side). → [22](22-BOUNDED-CONTEXTS.md)

### Data Plane (video/AI processing — edge-first, regional)

Camera management · Streaming · Recording · Inference · Tracking · Capabilities · Composition · Events · Rules · Workflow · Evidence · Notifications · Analytics · **AI Runtime**.
Maps to contexts: Camera, Media, Inference, Capability, Tracking, Composition, Event, Rule, Workflow, Evidence, Notification, Analytics, Connector, Digital-Twin. → [22](22-BOUNDED-CONTEXTS.md)

## 1. The split (one picture)

```
┌──────────────────────── CONTROL PLANE (cloud, global/regional) ────────────────────────┐
│ Identity · Tenant · AuthZ/Policy · Billing · Licensing · Fleet · Config · Audit ·        │
│ Monitoring · Deployment · Feature Flags · Secrets · API Gateway · Registry(control)      │
└───────────────┬─────────────────────────────────────────────────────────▲───────────────┘
   config · policy · entitlements · model/OTA (push, cached)                │ telemetry · usage ·
                │                                                           │ health · events(sync)
┌───────────────▼─────────────────────── DATA PLANE (edge-first, regional) ─┴───────────────┐
│ Camera · Media · Inference · Tracking · Capability · Composition · Event · Rule ·          │
│ Workflow · Evidence · Notification · Analytics · AI Runtime · Connector · Digital-Twin     │
│  ── runs autonomously; caches last-known-good control decisions; works offline ──          │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Communication

- **Control → Data (downstream):** configuration, resolved **entitlements**, **policy** decisions/bundles, capability/model assignments, and model/agent **OTA** — **pushed and cached** at the Data Plane (last-known-good). Never a synchronous dependency on the hot path.
- **Data → Control (upstream):** telemetry, **usage/metering** events, health/heartbeat, and business events for aggregation — asynchronous, at-least-once, via the event backbone and store-and-forward from edge. → [09](09-EVENT-PLATFORM.md), [14](14-EDGE-PLATFORM.md)
- **Contract-only:** planes integrate solely through published contracts + events ([21](21-API-ARCHITECTURE.md)); no shared databases across the boundary ([23](23-SERVICE-OWNERSHIP.md)).

## 3. Scaling strategy

- **Control Plane:** stateless services, HPA; global or regionally-federated; modest, business-transaction load; scales with tenants/users, **not** cameras.
- **Data Plane:** scales with **cameras/streams**; GPU worker pools + edge fleet; regional; the heavy, elastic tier. → [19](19-PERFORMANCE-AND-SCALE.md)
- Decoupling means a spike in video processing never throttles billing/login, and vice-versa.

## 4. Failure isolation

- **Control Plane down →** Data Plane keeps ingesting, inferring, evaluating rules, raising incidents, and alerting using **cached** config/policy/entitlements; usage/telemetry buffer and sync on recovery.
- **Data Plane node/site down →** isolated to that region/site; Control Plane and other regions unaffected; edge autonomy covers WAN loss ([14 §5](14-EDGE-PLATFORM.md)).
- Reserved lanes for safety-critical capabilities survive Data-Plane load shedding ([19](19-PERFORMANCE-AND-SCALE.md)).

## 5. Deployment strategy

- **Control Plane:** cloud (global/regional), blue-green, multi-AZ, optional multi-region active-active. → [17](17-DEVOPS-AND-INFRA.md)
- **Data Plane:** cloud GPU, on-prem, hybrid, or edge — same contracts, placement decides ([ADR-0004](../adr/ADR-0004-edge-first-placement.md)); canary + staged OTA.
- The four deployment models ([HARDWARE-SIZING](../reference/HARDWARE-SIZING.md)) are all **Data-Plane placements** under one Control Plane.

## 6. Security

- Control Plane holds identity, secrets, policy, and audit (the crown jewels) with the strictest controls; Data Plane holds video/evidence with per-tenant KMS and (edge) encrypted local storage. → [15](15-SECURITY-ARCHITECTURE.md)
- Cross-plane traffic is mTLS; the Data Plane authenticates to the Control Plane per device/service; policy decisions are signed and cached with TTLs.
- Regional Data Planes satisfy **data residency**; the Control Plane can be global while video/events/evidence stay in-region.

## 7. Synchronization

- **Config/policy/entitlements:** versioned, pushed, cached with TTL + last-known-good; the Data Plane records the version it is running for auditability.
- **Usage/telemetry/events:** store-and-forward, idempotent, reconciled on reconnect (no data loss — chaos-tested, [14](14-EDGE-PLATFORM.md)).
- **Clock/version skew** handled explicitly; the Data Plane degrades gracefully to cached state rather than blocking.

## Design decisions

- **Push-and-cache, never call-through** on the hot path is what gives the Data Plane its autonomy and keeps the Control Plane off the critical latency budget.
- **Cameras scale the Data Plane; tenants scale the Control Plane** — independent cost/scale curves.

## Advantages

- Independent scaling, failure isolation, and deployment; true edge/offline autonomy; clean residency boundary; smaller blast radius.

## Tradeoffs

- A synchronization contract (versioned config/policy push + cache + reconciliation) and two topologies to test; contained by reusing the event backbone and edge store-and-forward already in the design.

## Future expansion

- Multi-region active-active Control Plane; regional Control-Plane federation; Data-Plane bursting between edge and cloud.

## Cross-references

[04-SYSTEM-OVERVIEW](04-SYSTEM-OVERVIEW.md) · [14-EDGE-PLATFORM](14-EDGE-PLATFORM.md) · [19-PERFORMANCE-AND-SCALE](19-PERFORMANCE-AND-SCALE.md) · [22-BOUNDED-CONTEXTS](22-BOUNDED-CONTEXTS.md) · [23-SERVICE-OWNERSHIP](23-SERVICE-OWNERSHIP.md) · [28-POLICY-ENGINE](28-POLICY-ENGINE.md) · [ADR-0011](../adr/ADR-0011-control-plane-data-plane-separation.md)
