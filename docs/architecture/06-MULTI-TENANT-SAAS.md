# 06 — Multi-Tenant SaaS Architecture

## Purpose

Define the tenancy model, the organizational hierarchy, isolation strategy, subscription/entitlement system, billing/metering, and configuration — the SaaS backbone every capability hangs off. Operationalizes Law 5 (secure & isolated by default).

## Responsibilities

- Own the tenant hierarchy and its scoping semantics.
- Enforce tenant isolation at the data, storage, stream, and compute layers.
- Resolve entitlements (plans, packs, feature flags, quotas) and meter usage.
- Support branding/white-label and multiple isolation modes for regulated customers.

---

## 1. Tenancy model & hierarchy

**Tenant = Organization** (a customer). Everything carries `tenantId`. Within a tenant, a scoping hierarchy drives permissions, dashboards, analytics rollups, rule targeting and billing:

```
Tenant (Organization)
 └── Region              (data-residency & routing boundary)
      └── Country
           └── Branch     (business/regional unit; billing rollups)
                └── Site  (physical premises: address, timezone, floorplans)
                     └── Building → Floor → Zone   (spatial scoping for rules/analytics)
                          └── Camera / Device       (ONVIF/RTSP/RTMP/sensor)
                               └── ROI Zones / Lines, assigned Capabilities, Rules
```

Users, roles, cameras, events, evidence, rules, workflows, reports — all carry `tenantId`; operational records also carry `branchId/siteId/cameraId` for scoping and analytics. Every level is optional in small deployments (a single shop is Tenant→Site→Camera) but the schema always supports the full depth.

## 2. Isolation strategy (defense in depth)

Three isolation **modes**, one schema:

1. **Pooled (default)** — shared cluster; **row-level isolation** via mandatory `tenantId` on every document and a data-layer guard that injects `tenantId` into every query and **throws if tenant context is absent**. Compound indexes lead with `tenantId`.
2. **Siloed (enterprise/regulated)** — dedicated database or cluster per tenant; identical schema; a resolver selects the datastore by tenant. For data-residency and noisy-neighbor isolation.
3. **Edge-local** — each edge box is bound to exactly one tenant; local data encrypted; syncs only to that tenant's cloud space.

**Isolation is enforced at every layer, not just the app:**

- **Context**: an authenticated request resolves `{tenantId, scopes, roles, permissions}` into request-scoped context (`AsyncLocalStorage` / gRPC metadata / event headers) that propagates across every hop.
- **Data**: repository guard auto-applies `tenantId`; a query without it is a hard error (fail-closed).
- **Storage**: object keys prefixed per tenant (`{tenantId}/{cameraId}/{eventId}`), short-lived signed URLs, per-tenant **KMS data keys** (envelope encryption) for clips/PII.
- **Stream**: media sessions authorized per camera per tenant; short-lived signed WebRTC/HLS tokens.
- **Compute**: inference jobs tagged with tenant; optional **dedicated worker/GPU pools** for enterprise (noisy-neighbor control).
- **Search/vector**: per-tenant namespace/index.
- **Network (on-prem/edge)**: per-tenant API keys, rate limits, camera VLAN segmentation.

Cross-tenant access is validated **negatively**: automated tests attempt cross-tenant access on every endpoint/stream and must fail. → [tests/isolation](../../tests/), [15](15-SECURITY-ARCHITECTURE.md)

## 3. Identity, roles & permissions

- **AuthN**: OAuth2/OIDC, JWT access (short-lived) + rotating refresh (reuse-detection), MFA, SSO/SAML + SCIM (enterprise), passkeys (roadmap), scoped API keys for machines. → [15](15-SECURITY-ARCHITECTURE.md), [21](21-API-ARCHITECTURE.md)
- **AuthZ**: **RBAC + ABAC**. Permissions are `resource:action[:scope]` (e.g. `event:acknowledge`, `clip:export`, `rule:manage`, `report:view:branch`). **Scopes**: `own`, `zone`, `site`, `branch`, `region`, `tenant`, `global`. ABAC attributes (time, camera sensitivity, reason-for-access, jurisdiction) refine RBAC for regulated actions (e.g., face-recognition queries gated by permission + jurisdiction).
- **Default roles** (customizable per tenant): Platform Super-Admin, Org Owner, Org Admin, Region/Branch Manager, Site Manager, Security Operator, Analyst/Viewer, Field/Installer Engineer, Service Account. Least-privilege by default; privileged actions audited.

## 4. Subscriptions, entitlements & feature flags

- A **plan** gates: camera count, enabled **capability packs**, retention days, storage GB, resolution/FPS, user count, API/webhooks, SSO/SCIM, white-label, deployment modes, support SLA.
- **Capability packs** map to sets of capabilities ([05](05-CAPABILITY-ARCHITECTURE.md)) and Industry Packs ([13](13-INDUSTRY-PACKS.md)). Enabling a capability requires an entitlement.
- **Entitlement resolution** at login → cached in Redis (`ff:{tenantId}`), enforced server-side on every call and reflected in UI via feature gates. Add-ons and per-camera overrides supported.
- **Feature flags** additionally gate incomplete/experimental work (progressive delivery), independent of billing.

## 5. Usage metering & billing

- **Metering** records billable dimensions per tenant: active cameras, storage GB, inference-hours (by placement), alert/notification credits, API calls, enabled packs. Emitted as events → aggregated by `services/billing`.
- **Billing** integrates a provider (Stripe or regional): per-camera subscription + metered add-ons, proration on camera add/remove, dunning, trials, freemium, coupons, and **reseller/partner billing** (sub-tenants under a partner brand with revenue share).
- Quotas: soft-limit warnings and hard-limit actions (stop new uploads / prompt upgrade), tracked against plan.

## 6. Configuration Hierarchy & Branding

Configuration is a **hierarchical inheritance chain** ([ADR-0014](../adr/ADR-0014-configuration-hierarchy.md)). No config in code (12-factor); every effective value is traceable, versioned, and rollback-able.

**Inheritance chain (parent → child):**

```
Global → Platform → Tenant → Organization → Region → Country → Branch → Site →
Building → Floor → Zone → Camera → Capability → Model → Rule → Workflow
```

- **Inheritance rules:** a child inherits its parent's **effective** config; only **overridden keys** change (sparse overrides). Unset keys always fall through to the nearest ancestor that sets them, down to Global defaults.
- **Conflict resolution / priority:** **most-specific level wins** (Camera overrides Site overrides Tenant…). Within a level, explicit deny/lock beats inherit (a parent may mark a key **locked** to forbid child override — e.g. a compliance-mandated retention floor).
- **Resolution:** a resolver computes the effective config for any node by walking the chain; results are **cached** (Redis) and pushed to the Data Plane with last-known-good ([27 §7](27-CONTROL-DATA-PLANE.md)).
- **Provenance:** every effective value records which level set it (for debugging and audit).
- **Versioning · audit · rollback:** config changes are versioned and audited ([15 §5](15-SECURITY-ARCHITECTURE.md)); any node's config can be rolled back to a prior version.

This chain governs not just tenancy settings but **capability parameters, model-adapter config, rule thresholds, and workflow settings** — set a default once at Global/Tenant and override precisely at a single Camera or Zone.

- **White-label** (enterprise/OEM): logo, palette, favicon, email + app naming, reflected in web and mobile builds — itself a config-hierarchy value.
- **Custom domains**: `cctv.customer.com` with automated DNS verification + ACME TLS; per-tenant routing at the gateway.

## Design decisions

- **Pooled-by-default, siloed-when-required** balances cost efficiency with the hard isolation regulated buyers demand — one schema serves both. See [ADR-0003](../adr/ADR-0003-tenant-isolation-strategy.md).
- **Isolation at the data layer, not by convention** makes leaks structurally hard rather than reviewer-dependent.
- **Entitlements resolve capabilities** so the same capability catalog is monetized flexibly without code changes.

## Advantages

- Cost-efficient multi-tenancy with an enterprise/regulated upgrade path.
- Fine-grained scoping supports very large orgs (least-privilege at zone/camera level).
- Metering/billing driven by the same event backbone as everything else.

## Tradeoffs

- Deep hierarchy + ABAC adds authorization complexity; mitigated by a central policy module (`packages/permissions`) reused everywhere and covered by an RBAC/ABAC test matrix.
- Siloed mode raises per-tenant operational cost; reserved for plans that justify it.

## Future expansion

- Tenant-defined custom roles/permission bundles UI.
- Delegated administration for partners/OEMs managing many sub-tenants.
- Data-residency-aware global routing and per-region key custody.

## Cross-references

[15-SECURITY-ARCHITECTURE](15-SECURITY-ARCHITECTURE.md) · [18-DATA-ARCHITECTURE](18-DATA-ARCHITECTURE.md) · [05-CAPABILITY-ARCHITECTURE](05-CAPABILITY-ARCHITECTURE.md) · [13-INDUSTRY-PACKS](13-INDUSTRY-PACKS.md)
