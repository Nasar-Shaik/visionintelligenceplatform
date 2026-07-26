# 02 — SaaS Architecture

Multi-tenant design for a camera-centric AI platform: isolation, subscription, org hierarchy, RBAC, camera grouping, quotas, API keys, billing, branding and custom domains.

---

## 1. Multi-Tenant Design

**Tenancy unit = Organization** (a customer company). Everything is scoped by `tenantId` (= organizationId).

**Hierarchy:**
```
Organization (tenant)
 └── Branch (e.g., a city / franchise)
      └── Location / Site (a physical building)
           └── Camera Group (e.g., "Entrance", "Warehouse Zone A")
                └── Camera (device: ONVIF/RTSP)
                     └── Zones/ROIs, assigned AI models, rules
```
Users, roles, plans, cameras, events, clips, alerts, reports — all carry `tenantId`, and operational data also carries `branchId`/`locationId`/`cameraId` for scoping and analytics.

**Isolation modes:**
1. **Shared (default):** shared cluster, row-level isolation via mandatory `tenantId` on every document + query middleware. Compound indexes lead with `tenantId`.
2. **Silo (Enterprise/on-prem):** dedicated database or dedicated cluster / self-hosted stack; identical schema, resolver selects DB by tenant.
3. **Edge-local:** each edge box is bound to one tenant; local data encrypted, synced upstream to that tenant only.

---

## 2. Tenant Isolation (defense in depth)

1. **Auth context** injects `{ tenantId, branchIds, locationIds, userId, roles, permissions }` into `AsyncLocalStorage`.
2. **DB middleware** auto-applies `tenantId` to every read/write; a query without tenant context throws.
3. **Storage isolation:** object-storage prefixes per tenant (`s3://bucket/{tenantId}/...`), signed URLs, per-tenant KMS data keys for clips.
4. **Stream isolation:** media sessions authorized per camera per tenant; short-lived signed WebRTC/HLS tokens.
5. **Compute isolation:** GPU worker jobs tagged with tenant; optional dedicated worker pools for Enterprise (noisy-neighbor control).
6. **Network:** per-tenant API keys, rate limits, and (on-prem) VLAN/subnet segmentation for camera networks.
7. **Vector index namespace** per tenant for search embeddings.

---

## 3. Subscription Plans & Entitlements

Plans gate: **camera count, AI packs, retention days, storage GB, resolution/FPS, users, API access, SSO, white-label, support SLA.**

| Capability | Starter | Business | Pro | Enterprise |
|-----------|---------|----------|-----|------------|
| Cameras | 1–4 | up to 32 | up to 256 | 256–1000+ |
| AI packs | 1 | 5 | all | all + custom |
| Retention | 7d | 30d | 90d | configurable |
| NL search | – | ✓ | ✓ | ✓ |
| Rule engine | basic | ✓ | ✓ | ✓ |
| LPR / Face recog | – | add-on | ✓ | ✓ |
| API / Webhooks | – | limited | ✓ | ✓ |
| SSO/SAML/SCIM | – | – | ✓ | ✓ |
| White-label / domains | – | – | – | ✓ |
| Deployment | cloud | cloud | cloud/hybrid | cloud/hybrid/on-prem/edge |

**Entitlement resolution** at login → cached in Redis (`ff:{tenantId}`); enforced server-side and reflected in UI via `<FeatureGate>`. Usage metered against plan limits.

---

## 4. Organizations, Users, Roles, Permissions

**Roles (system defaults, customizable):** Platform Super-Admin, Org Owner, Org Admin, Branch Manager, Security Operator, Analyst/Viewer, Field Engineer, API/Service account.

**Permission model:** `resource:action[:scope]` — e.g. `camera:create`, `event:acknowledge`, `clip:export`, `rule:manage`, `report:view:branch`, `billing:manage`. Scopes: `own`, `camera-group`, `location`, `branch`, `tenant`, `global`.

**Scoping:** a Branch Manager sees only assigned branches; a Security Operator sees assigned camera groups; a Viewer is read-only. Camera-group-level assignment enables least-privilege for large orgs.

**Key collections:** `organizations`, `branches`, `locations`, `cameraGroups`, `users`, `roles`, `permissions`, `rolePermissions`, `userRoles`, `userScopes`.

---

## 5. Branches, Locations & Camera Groups

- **Branch** — business/regional unit; owns billing rollups and manager assignments.
- **Location/Site** — physical premises with address, timezone, floorplans/maps.
- **Camera Group** — logical grouping for rules, dashboards and permissions (e.g., "Checkout Lanes", "Perimeter").
- **Camera** — device record: RTSP/RTMP URL, ONVIF profile, resolution, FPS, codec, PTZ caps, edge-box binding, assigned models, zones, retention override, health status.

This hierarchy drives **dashboards, analytics rollups, permission scoping, rule targeting and billing**.

---

## 6. Storage Quotas & Retention

- Per-plan **storage quota (GB)** and **retention (days)**; per-camera retention override.
- **Smart clip extraction** (see [Doc 05](./05-PIPELINE-AND-ENGINES.md)) means only events + short clips are stored → drastic quota savings.
- Quota tracked in `usageCounters`; soft-limit warnings, hard-limit actions (stop new clip upload / prompt upgrade).
- Tiering: hot (recent clips, fast object storage) → cold (archive tier) → delete per retention policy or legal hold.

---

## 7. API Keys & Developer Platform

- Scoped API keys per tenant (`apiKeys`: hashed key, scopes, rate limit, IP allowlist, expiry).
- **Webhooks** for events/alerts (HMAC-signed, retried, delivery log).
- Public REST + WebSocket + streaming APIs (see [Doc 08](./08-DATA-API-STRUCTURE.md)); developer portal with docs, sandbox, usage analytics.
- Service accounts for integrations (POS, access control, SIEM).

---

## 8. Billing

- **Stripe** (or regional) integration: per-camera subscription + metered add-ons (SMS/voice/WhatsApp credits, extra storage, AI packs).
- Usage metering (active cameras, storage GB, alert credits) → invoices; proration on camera add/remove.
- Dunning, trials, freemium single-camera tier, coupons, partner/reseller billing.
- **Collections:** `plans`, `subscriptions`, `invoices`, `usageCounters`, `paymentMethods`, `credits`, `resellerAccounts`.

---

## 9. Custom Branding & Custom Domains

- **White-label** (Enterprise/OEM): logo, colors, favicon, email branding, app naming; reflected in web + mobile builds.
- **Custom domains:** `cctv.customer.com` with automated DNS verification + SSL (ACME); per-tenant routing at the gateway.
- **Reseller/OEM:** partners provision sub-tenants under their brand, own pricing, revenue share.
- **Collections:** `brandingConfigs`, `customDomains`, `resellerAccounts`.

---

## 10. Multi-Tenant Data Flow Summary

```
Edge box (tenant-bound) ──signed sync──> Regional data plane (tenantId enforced)
Camera stream ──authz per camera──> Media server ──signed HLS/WebRTC token──> User (scoped)
Event ──tenantId+branchId+cameraId──> Mongo (row isolation) + Vector index (tenant namespace)
Clip ──> Object storage s3://bucket/{tenantId}/{cameraId}/{eventId}.mp4 (KMS per-tenant key)
Billing ──usage per tenant──> Stripe
```

All cross-service calls propagate tenant context; no operation is possible without it.
