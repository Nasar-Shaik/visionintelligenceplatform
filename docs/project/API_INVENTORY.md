# API Inventory

> Every API endpoint across all services. Updated whenever an endpoint is added, changed, or removed.
>
> Schema per endpoint: **Service · Method+Endpoint · Purpose · Authentication · Input · Output · Dependencies · Status · Version**.
> Status: `stable` · `beta` · `scaffold` (infra-only, no business logic) · `deprecated`.

## @vip/service-identity (v0.1.0)

> Phase 1 P1-2. Authentication + authorization. Users tenant-scoped (`@vip/tenancy`); tokens via `@vip/auth`; routes gated by `@vip/permissions`. Infra endpoints (`/health` `/ready` `/metrics` `/`) as the template. `/ready` includes a `mongo` check.

| Method | Endpoint                          | Purpose                             | Auth          | Input             | Output                                         | Dependencies                    | Status   | Version |
| ------ | --------------------------------- | ----------------------------------- | ------------- | ----------------- | ---------------------------------------------- | ------------------------------- | -------- | ------- |
| POST   | `/auth/login`                     | Authenticate within a tenant        | `x-tenant-id` | `LoginInput`      | `200 {success,data:TokenPair}` · `401` · `400` | Mongo, @vip/auth                | beta     | 0.1.0   |
| POST   | `/auth/refresh`                   | Rotate token pair (reuse-detection) | refresh token | `RefreshInput`    | `200 {success,data:TokenPair}` · `401`         | Mongo, @vip/auth                | beta     | 0.1.0   |
| POST   | `/auth/logout`                    | Revoke the refresh-token family     | refresh token | `RefreshInput`    | `204`                                          | Mongo                           | beta     | 0.1.0   |
| GET    | `/auth/me`                        | Principal from the access token     | Bearer        | —                 | `200 {success,data:Principal}` · `401`         | @vip/auth                       | beta     | 0.1.0   |
| POST   | `/users`                          | Create a user (tenant-scoped)       | `user:create` | `CreateUserInput` | `201 {success,data:User}` · `401/403/409`      | Mongo, @vip/tenancy/permissions | beta     | 0.1.0   |
| GET    | `/users`                          | List the tenant's users             | `user:read`   | —                 | `200 {success,data:User[]}` · `401/403`        | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness/readiness/metrics/info     | None          | —                 | infra (as template)                            | prom-client                     | scaffold | 0.1.0   |

## @vip/service-gateway (v0.1.0)

> Phase 1 P1-2. The trust boundary: edge token validation + context-forwarding reverse proxy. Injects trusted `x-tenant-id`/`x-principal-id`/`x-roles` from the token and strips client-supplied ones.

| Method | Endpoint                          | Purpose                                           | Auth   | Output                                                  | Dependencies         | Status   | Version |
| ------ | --------------------------------- | ------------------------------------------------- | ------ | ------------------------------------------------------- | -------------------- | -------- | ------- |
| GET    | `/whoami`                         | Resolve + return the caller's context             | Bearer | `200 {success,data:{principalId,tenantId,...}}` · `401` | @vip/auth            | beta     | 0.1.0   |
| ALL    | `/api/:service/*`                 | Reverse-proxy to an upstream with trusted context | Bearer | upstream response · `401` · `404` · `502`               | @vip/auth, upstreams | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness/readiness/metrics/info                   | None   | infra (as template)                                     | prom-client          | scaffold | 0.1.0   |

**Conventions (all services):**

- Every response carries a correlation id — inbound `x-request-id` is honoured, else one is generated (`genReqId`).
- Errors use the `@vip/contracts` `ApiError` envelope: `{ success:false, error:{ code, message, correlationId, details? } }`. 5xx messages are opaque (real cause logged server-side).
- Tenant context (when present) is validated against the `TenantContext` contract via `x-tenant-id` / `x-principal-id` headers — **seam only in Phase 0**, enforced from P1.
- Security headers set by `@fastify/helmet` (`x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, …).

## @vip/service-tenant (v0.1.0)

> Phase 1 P1-1. Provisions tenants + org hierarchy; enforces fail-closed isolation (`@vip/tenancy`). Auth arrives in P1-2 — until then provisioning is open and tenant context comes from `x-tenant-id`/`x-principal-id` headers. Every tenant-addressed route refuses a path naming a different tenant than the caller's context (**cross-tenant → 403**).

| Method | Endpoint                          | Purpose                               | Auth             | Input                | Output                                          | Dependencies        | Status   | Version |
| ------ | --------------------------------- | ------------------------------------- | ---------------- | -------------------- | ----------------------------------------------- | ------------------- | -------- | ------- |
| POST   | `/tenants`                        | Provision a tenant + org root         | None (P1-2 adds) | `CreateTenantInput`  | `201 {success,data:{tenant,orgRoot}}` · `409`   | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/tenants/:tenantId`              | Get the caller's tenant               | tenant context   | —                    | `200 {success,data:Tenant}` · `401/403/404`     | Mongo, @vip/tenancy | beta     | 0.1.0   |
| PATCH  | `/tenants/:tenantId`              | Update name / lifecycle status        | tenant context   | `UpdateTenantInput`  | `200 {success,data:Tenant}` · `401/403/404`     | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/tenants/:tenantId/org-nodes`    | List the tenant's org nodes           | tenant context   | —                    | `200 {success,data:OrgNode[]}` · `401/403`      | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/tenants/:tenantId/org-nodes`    | Create an org-hierarchy node          | tenant context   | `CreateOrgNodeInput` | `201 {success,data:OrgNode}` · `400/401/403`    | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | Liveness / readiness / metrics / info | None             | —                    | as identity (`/ready` includes a `mongo` check) | prom-client         | scaffold | 0.1.0   |

## @vip/service-camera (v0.1.0)

> Phase 1 P1-3. Camera inventory: onboard cameras into the tenant-owned org hierarchy (`zoneId` → `OrgNode`), vault credentials at rest (`@vip/crypto`, AES-256-GCM), publish `camera.*` lifecycle events. Verifies the identity-issued Bearer token itself (`iss=identity`, `aud=vip`); every route is permission-gated (deny-by-default) and tenant-scoped from the token — a camera in another tenant is a **404** (no existence leak). **Credentials are never returned** (only `hasCredentials`).

| Method | Endpoint                          | Purpose                                 | Auth            | Input                  | Output                                          | Dependencies                     | Status   | Version |
| ------ | --------------------------------- | --------------------------------------- | --------------- | ---------------------- | ----------------------------------------------- | -------------------------------- | -------- | ------- |
| POST   | `/cameras`                        | Onboard a camera (vault credentials)    | `camera:create` | `CreateCameraInput`    | `201 {success,data:Camera}` · `400/401/403/409` | Mongo, @vip/tenancy, @vip/crypto | beta     | 0.1.0   |
| GET    | `/cameras`                        | List the tenant's cameras               | `camera:read`   | —                      | `200 {success,data:Camera[]}` · `401/403`       | Mongo, @vip/tenancy              | beta     | 0.1.0   |
| GET    | `/cameras/:id`                    | Get one camera (own tenant)             | `camera:read`   | —                      | `200 {success,data:Camera}` · `401/403/404`     | Mongo, @vip/tenancy              | beta     | 0.1.0   |
| PATCH  | `/cameras/:id`                    | Update / re-vault credentials           | `camera:update` | `UpdateCameraInput`    | `200 {success,data:Camera}` · `400/401/403/404` | Mongo, @vip/tenancy, @vip/crypto | beta     | 0.1.0   |
| DELETE | `/cameras/:id`                    | Remove a camera from inventory          | `camera:delete` | —                      | `204` · `401/403/404`                           | Mongo, @vip/tenancy              | beta     | 0.1.0   |
| GET    | `/cameras/:id/health`             | Camera observed health (unknown → P1-4) | `camera:read`   | —                      | `200 {success,data:CameraHealthReport}` · `404` | Mongo, @vip/tenancy              | beta     | 0.1.0   |
| POST   | `/cameras/discover`               | ONVIF/network discovery (stub)          | `camera:create` | `DiscoverCamerasInput` | `501 not_implemented`                           | —                                | stub     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | Liveness / readiness / metrics / info   | None            | —                      | as identity (`/ready` includes a `mongo` check) | prom-client                      | scaffold | 0.1.0   |

### Camera Processing Assignment — the control plane (P-8 Phase 6)

> Decides which cameras consume AI, on which runtime, under which profile. ⚠️ **No route here can
> affect recording**: there is no recording field on any request or response, and nothing calls into
> the stream supervisor ([ADR-0043](../adr/ADR-0043-assignment-is-a-control-plane-with-a-measured-data-plane.md)).

| Method | Endpoint                               | Purpose                                                         | Auth                 | Body                           | Output                                                           |
| ------ | -------------------------------------- | --------------------------------------------------------------- | -------------------- | ------------------------------ | ---------------------------------------------------------------- |
| GET    | `/assignments`                         | Every camera's assignment (`?state=&runtimeId=&profileId=`)     | `assignment:read`    | —                              | `200 {data:CameraAssignment[]}`                                  |
| GET    | `/assignments/capacity`                | Totals, per-runtime occupancy, **suggested placement**          | `assignment:read`    | —                              | `200 {data:AssignmentCapacityReport}`                            |
| GET    | `/assignments/history`                 | Immutable audit trail (`?cameraId=&limit=`)                     | `assignment:read`    | —                              | `200 {data:AssignmentHistoryEntry[]}`                            |
| POST   | `/assignments/bulk`                    | Bulk enable/disable/pause/resume/restart/assign/remove          | `assignment:write`   | `BulkAssignmentRequest`        | `200` \| ⚠️ **`207` when partial** `{data:BulkAssignmentResult}` |
| GET    | `/assignments/:cameraId`               | One camera's assignment                                         | `assignment:read`    | —                              | `200 {data:CameraAssignment}` · `404`                            |
| POST   | `/assignments/:cameraId/enable`        | Bind a profile, place, and start                                | `assignment:write`   | `{profileId,runtimeId?,note?}` | `200 {data:CameraAssignment}` · `409` naming the refusal         |
| POST   | `/assignments/:cameraId/runtime`       | Move to a runtime (omit to re-place)                            | `assignment:write`   | `{runtimeId?,note?}`           | `200 {data:CameraAssignment}` · `409`                            |
| POST   | `/assignments/:cameraId/disable`       | Stop AI — releases tracking and publisher state                 | `assignment:write`   | `{note?}`                      | `200 {data:CameraAssignment}`                                    |
| POST   | `/assignments/:cameraId/restart`       | New session on the same assignment                              | `assignment:write`   | `{note?}`                      | `200 {data:CameraAssignment}`                                    |
| POST   | `/assignments/:cameraId/pause`         | ⚠️ Suspend frames, **retain** state — shift work                | `assignment:control` | `{note?}`                      | `200 {data:CameraAssignment}`                                    |
| POST   | `/assignments/:cameraId/resume`        | Resume a paused camera                                          | `assignment:control` | `{note?}`                      | `200 {data:CameraAssignment}`                                    |
| DELETE | `/assignments/:cameraId`               | Remove the assignment entirely                                  | `assignment:write`   | —                              | `200 {data:CameraAssignment}`                                    |
| GET    | `/cameras/:cameraId/capability-matrix` | ⚠️ What this camera can do, **with the evidence for each fact** | `assignment:read`    | —                              | `200 {data:CameraCapabilityMatrix}` · `404`                      |
| GET    | `/processing-profiles`                 | Catalogue, with `supported` **measured** per deployment         | `assignment:read`    | —                              | `200 {data:ProcessingProfile[]}`                                 |
| POST   | `/processing-profiles`                 | Create a tenant profile                                         | `assignment:write`   | `CreateProcessingProfileInput` | `201` · `409`                                                    |
| PATCH  | `/processing-profiles/:profileId`      | Edit a profile (built-ins included)                             | `assignment:write`   | `UpdateProcessingProfileInput` | `200` · `404`                                                    |
| DELETE | `/processing-profiles/:profileId`      | Delete — refuses built-ins and profiles in use                  | `assignment:write`   | —                              | `204` · `409`                                                    |
| GET    | `/processing-runtimes`                 | Registered runtimes with **measured** health                    | `assignment:read`    | —                              | `200 {data:ProcessingRuntime[]}`                                 |
| POST   | `/processing-runtimes`                 | Register a runtime (health starts `unknown`)                    | `assignment:runtime` | `RegisterRuntimeInput`         | `201` · `409`                                                    |
| PATCH  | `/processing-runtimes/:runtimeId`      | Edit URL, capacity, labels, enabled                             | `assignment:runtime` | `UpdateRuntimeInput`           | `200` · `404`                                                    |
| DELETE | `/processing-runtimes/:runtimeId`      | Deregister — **re-places** its cameras, never drops them        | `assignment:runtime` | —                              | `200 {data:{reassigned,failed}}`                                 |
| GET    | `/camera-groups`                       | ⚠️ Stored and listed; **no bulk operation targets one yet**     | `assignment:read`    | —                              | `200 {data:CameraGroup[]}`                                       |
| POST   | `/camera-groups`                       | Create a group                                                  | `assignment:write`   | `CreateCameraGroupInput`       | `201` · `409`                                                    |
| PATCH  | `/camera-groups/:groupId`              | Edit a group                                                    | `assignment:write`   | `UpdateCameraGroupInput`       | `200` · `404`                                                    |
| DELETE | `/camera-groups/:groupId`              | Delete a group                                                  | `assignment:write`   | —                              | `204` · `404`                                                    |

### Internal (service-to-service, not gateway-exposed)

| Method | Endpoint                       | Purpose                                                                         | Auth                             | Output                                                |
| ------ | ------------------------------ | ------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------- |
| GET    | `/internal/cameras/:id/stream` | Resolve a camera's connection **with decrypted creds** (media)                  | `x-internal-key` + `x-tenant-id` | `200 {success,data:StreamConnection}` · `401/400/404` |
| GET    | `/internal/assignment/plan`    | ⚠️ **Cross-tenant** processing plan for the enforcement point                   | `x-internal-key`                 | `200 {success,data:AssignmentPlan}` · `401`           |
| POST   | `/internal/assignment/report`  | ⚠️ The **only** path to an observed state — runtime health and per-camera facts | `x-internal-key`                 | `200 {success,data:{failover,failed}}` · `400/401`    |

> Camera context, P1-4. The single sanctioned credential-decryption point; the gateway **strips**
> client `x-internal-key`, so only trusted internal services reach it ([ED-0025](ENGINEERING_DECISION_LOG.md)).

## @vip/service-media (v0.1.0)

> Phase 1 P1-4. Per-camera ingestion workers: connect RTSP/RTMP (creds from camera), decode (ffmpeg), extract frames, record segments to tenant-scoped MinIO (`{tenantId}/{cameraId}/recordings/…`, @vip/storage). Auto-reconnect with backoff; emits `media.stream.*` + `media.recording.segment`. Verifies the identity token itself (`iss=identity`); tenant from the token — another tenant's stream is a **404**.

| Method | Endpoint                          | Purpose                                            | Auth              | Output                                                     | Dependencies                 | Status   | Version |
| ------ | --------------------------------- | -------------------------------------------------- | ----------------- | ---------------------------------------------------------- | ---------------------------- | -------- | ------- |
| POST   | `/streams/:cameraId/start`        | Start a camera's ingestion worker                  | `stream:control`  | `202 {success,data:StreamStatus}` · `401/403`              | @vip/storage, camera, ffmpeg | beta     | 0.1.0   |
| POST   | `/streams/:cameraId/stop`         | Stop the worker (no reconnect)                     | `stream:control`  | `200 {success,data:StreamStatus}` · `401/403/404`          | —                            | beta     | 0.1.0   |
| GET    | `/streams/:cameraId/status`       | Worker status                                      | `stream:read`     | `200 {success,data:StreamStatus}` · `401/403/404`          | —                            | beta     | 0.1.0   |
| GET    | `/streams`                        | List the tenant's workers                          | `stream:read`     | `200 {success,data:StreamStatus[]}` · `401/403`            | —                            | beta     | 0.1.0   |
| GET    | `/perception/event-bridge`        | Event Publisher state (P-8 Phase 5)                | `system:inspect`  | `200 {success,data:EventPublisherStats}` · `401/403`       | @vip/messaging               | beta     | 0.1.0   |
| GET    | `/perception/assignment`          | Assignment gate state (P-8 Phase 6)                | `system:inspect`  | `200 {success,data:AssignmentClientStats}` · `401/403`     | camera service               | beta     | 0.1.0   |
| GET    | `/perception/assignment/cameras`  | ⚠️ Per-camera processing metrics — **TENANT DATA** | `assignment:read` | `200 {success,data:CameraProcessingMetrics[]}` · `401/403` | runtime, publisher           | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | Liveness / readiness / metrics / info              | None              | as template (`/ready` includes a `storage` check)          | prom-client, @vip/storage    | scaffold | 0.1.0   |

> ⚠️ **`/perception/event-bridge` is deployment state, not tenant data**, which is why it is behind
> `system:inspect` rather than a media permission and why it carries **no camera id** — the last
> camera published for would name a customer's premises on an operations page. Reached by the console
> as `/api/system/event-bridge`. **Publishes** (NATS, not HTTP):
> `t.{tenantId}.capability.output.{capabilityId}` — the edge that did not exist before P-8 Phase 5.

## @vip/service-events (v0.1.0)

> Phase 1 P1-5. The Event context: consumes capability outputs off NATS JetStream (`t.*.capability.output.*`), normalizes each `DetectionResult` → `EventEnvelope` (label → catalog type), deduplicates + persists tenant-scoped to Mongo (unique `{tenantId,dedupKey}` index), and re-publishes on `t.{tenant}.event.*` (the `event.persisted` signal). Fail-closed dead-lettering on missing/invalid tenant. Verifies the identity token itself (`iss=identity`); tenant from the token — a query never widens across tenants.

| Method | Endpoint                          | Purpose                                                                   | Auth           | Input                | Output                                                 | Dependencies          | Status   | Version |
| ------ | --------------------------------- | ------------------------------------------------------------------------- | -------------- | -------------------- | ------------------------------------------------------ | --------------------- | -------- | ------- |
| GET    | `/events/:id`                     | One persisted envelope by id (P-5.0 G-5)                                  | `event:read`   | —                    | `200 {success,data:EventEnvelope}` · `401/403/404`     | Mongo, @vip/tenancy   | beta     | 0.1.0   |
| GET    | `/events`                         | Tenant-scoped, cursor-paged, filtered query (+`correlationId`, P-5.0 G-5) | `event:read`   | `EventQuery` (query) | `200 {success,data:EventPage}` · `400/401/403`         | Mongo, @vip/tenancy   | beta     | 0.1.0   |
| POST   | `/events/replay`                  | Re-publish a bounded window onto the backbone                             | `event:replay` | `EventReplayRequest` | `200 {success,data:EventReplayResult}` · `400/401/403` | @vip/messaging, Mongo | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / Prometheus / info                                  | None           | —                    | infra (`/ready` includes a `mongo` check)              | prom-client, Mongo    | scaffold | 0.1.0   |

> **Consumes** (NATS, not HTTP): `t.*.capability.output.*` (capability outputs). **Publishes:** `t.{tenantId}.event.{type}` (`event.persisted`).

## @vip/service-rules (v0.1.0)

> Phase 1 P1-7. The Rule Context (automation brain): consumes `event.persisted` off NATS and evaluates tenant-defined, **versioned** rules (a pure **sandboxed predicate DSL** over the `EventEnvelope` — never `DetectionResult`) with optional windowed thresholds, emitting `incident.candidate` + `rule.matched`. Rules carry a lifecycle (`draft`→`enabled`→…) + priority; every change is audited. Verifies the identity token itself (`iss=identity`); tenant from the token — a rule in another tenant is a **404**. Distinct from the Policy Engine (ADR-0013).

| Method | Endpoint                          | Purpose                                                                      | Auth          | Input                 | Output                                                                               | Dependencies                    | Status   | Version |
| ------ | --------------------------------- | ---------------------------------------------------------------------------- | ------------- | --------------------- | ------------------------------------------------------------------------------------ | ------------------------------- | -------- | ------- |
| POST   | `/rules`                          | Create a rule (version 1 + audit)                                            | `rule:create` | `CreateRuleInput`     | `201 {success,data:Rule}` · `400/401/403`                                            | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules`                          | List the tenant's rules                                                      | `rule:read`   | —                     | `200 {success,data:Rule[]}` · `401/403`                                              | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/:id`                      | Get one rule (own tenant)                                                    | `rule:read`   | —                     | `200 {success,data:Rule}` · `401/403/404`                                            | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/:id/versions`             | Rule audit trail (newest first)                                              | `rule:read`   | —                     | `200 {success,data:RuleVersionRecord[]}` · `404`                                     | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| POST   | `/rules/:id/dry-run`              | Test vs a sample event (**no side effects**)                                 | `rule:read`   | `RuleDryRunInput`     | `200 {success,data:RuleDryRunResult}` · `400/404`                                    | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| PATCH  | `/rules/:id`                      | Update (version bump + audit)                                                | `rule:update` | `UpdateRuleInput`     | `200 {success,data:Rule}` · `400/401/403/404`                                        | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| DELETE | `/rules/:id`                      | Remove (final `deleted` audit snapshot)                                      | `rule:delete` | —                     | `204` · `401/403/404`                                                                | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/:id/validation`           | Check references (**read-only**, P-4)                                        | `rule:read`   | —                     | `200 {success,data:RuleValidationReport}` · `404`                                    | Mongo, hierarchy + camera ports | beta     | 0.1.0   |
| GET    | `/rules/:id/audit`                | Lifecycle timeline, **derived** (P-4.1)                                      | `rule:read`   | —                     | `200 {success,data:RuleAuditEntry[]}` · `404`                                        | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/:id/dependencies`         | What it points at; `?status=true` adds whether it is there (P-4.1/4.2)       | `rule:read`   | —                     | `200 {success,data:RuleDependencyGraph}` · `404`                                     | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/:id/compilation`          | Fingerprints for this version (P-4.1)                                        | `rule:read`   | —                     | `200 {success,data:RuleCompilation}` · `404`                                         | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/dependents`               | What depends on `?kind=&ref=` (P-4.1)                                        | `rule:read`   | query                 | `200 {success,data:RuleDependents}` · `400`                                          | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/stats`                    | Per-rule + cache numbers, **this node**                                      | `rule:read`   | —                     | `200 {success,data:RuleStatsReport}` · **`501`** when this node does not evaluate    | in-process registry             | beta     | 0.1.0   |
| GET    | `/rules/export`                   | Rules as a portable package (P-4.1)                                          | `rule:read`   | —                     | `200 {success,data:RulePackage}` · `401/403`                                         | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| POST   | `/rules/import`                   | Import a package — drafts only; incompatible imports nothing; `?onConflict=` | `rule:create` | `RulePackage`         | `200 {success,data:RuleImportResult}` · `400/403`                                    | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| POST   | `/rules/:id/simulate`             | Run vs supplied events (**no side effects**)                                 | `rule:read`   | `RuleSimulationInput` | `200 {success,data:RuleSimulationResult}` · **`501`** for replay over stored history | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| POST   | `/rules/:id/rollback`             | Restore an earlier version's content (P-4.1)                                 | `rule:update` | `RuleRollbackInput`   | `200 {success,data:Rule}` · `400/404`                                                | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/:id/health`               | Verdict + every deduction named (P-4.2)                                      | `rule:read`   | —                     | `200 {success,data:RuleHealth}` · `404`                                              | Mongo, hierarchy + camera ports | beta     | 0.1.0   |
| GET    | `/rules/:id/complexity`           | Cost relative to deployment limits (P-4.2)                                   | `rule:read`   | —                     | `200 {success,data:RuleComplexityReport}` · `404`                                    | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/:id/diff`                 | What changed between two versions (P-4.2)                                    | `rule:read`   | `?from=&to=`          | `200 {success,data:RuleDiff}` · `400/404`                                            | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/:id/diagnostics`          | **The support artifact** (P-4.2)                                             | `rule:read`   | —                     | `200 {success,data:RuleDiagnosticPackage}` · `404`                                   | Mongo, hierarchy + camera ports | beta     | 0.1.0   |
| GET    | `/rules/:id/incident-context`     | **The frozen P-5 contract** (P-4.2)                                          | `rule:read`   | `?version=`           | `200 {success,data:RuleIncidentContext}` · `400/404`                                 | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/rules/diagnostics`              | Filter rules by what is wrong (P-4.2)                                        | `rule:read`   | query filters         | `200 {success,data:RuleDiagnosticSearchResult}` · `400`                              | Mongo, hierarchy + camera ports | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / Prometheus / info                                     | None          | —                     | infra (`/ready` = Mongo; `/metrics` = eval metrics)                                  | prom-client, Mongo              | scaffold | 0.1.0   |

> **Consumes** (NATS, not HTTP): `t.*.event.*` (`event.persisted`). **Publishes:** `t.{tenantId}.incident.candidate`, `t.{tenantId}.rule.matched`.
>
> **Two planes, one service** (P-4.2): these routes split into an **authoring** plane (`rules`, `:id`,
> `versions`, `validation`, `dry-run`, `simulate`, `rollback`, `PATCH`, `DELETE`) and an **operations**
> plane (everything diagnostic, plus export/import), in `transport/routes/rule-authoring.ts` and
> `rule-operations.ts`. **No path moved** — the separation is structural, because renaming published
> routes breaks every consumer for a naming improvement ([CONSTRAINTS §41, §55](CONSTRAINTS.md)). The
> third plane, the runtime, is a bus consumer with no HTTP surface at all.
>
> The two **501**s are deliberate and permanent parts of the contract, not gaps: `/rules/stats` on a node that is not evaluating has no numbers to report and says so rather than returning zeroes, and `/rules/:id/simulate` with a `range` needs the event archive, which belongs to another context ([ADR-0027](../adr/ADR-0027-rule-operations-diagnostics-and-portability.md)).

## @vip/service-workflow (v0.1.0)

> Phase 1 P1-8. The Workflow Context: owns the **incident lifecycle**. Consumes `incident.candidate` off NATS and idempotently promotes it to a persisted `raised` Incident, then drives operator transitions (`acknowledged → resolved → closed`). Incidents are **never created via the API** (only promoted). Verifies the identity token (`iss=identity`); tenant from the token — another tenant's incident is a **404**; an illegal lifecycle move is a **409**.

| Method | Endpoint                          | Purpose                                                                                                                                                                    | Auth                                                            | Input                      | Output                                                 | Dependencies        | Status   | Version |
| ------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------- | ------------------------------------------------------ | ------------------- | -------- | ------- |
| GET    | `/incidents`                      | Search incidents — status · severity · category · eventType · camera · zone · rule · correlation · assignee · time window, paged (P-5.0 G-3, **frozen**)                   | `incident:read`                                                 | `IncidentQuery` (query)    | `200 {success,data:IncidentPage}` · `400/401/403`      | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/incidents/:id`                  | Get one incident (own tenant)                                                                                                                                              | `incident:read`                                                 | —                          | `200 {success,data:Incident}` · `401/403/404`          | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/incidents/:id/ack`              | Acknowledge (raised → acknowledged)                                                                                                                                        | `incident:ack`                                                  | `AcknowledgeIncidentInput` | `200 {success,data:Incident}` · `403/404/409`          | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/incidents/:id/resolve`          | Resolve (raised\|acknowledged → resolved)                                                                                                                                  | `incident:resolve`                                              | `ResolveIncidentInput`     | `200 {success,data:Incident}` · `403/404/409`          | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/incidents/:id/close`            | Close (resolved → closed)                                                                                                                                                  | `incident:close` ⚠️ split in P-5.1; still granted to `operator` | `CloseIncidentInput`       | `200 {success,data:Incident}` · `403/404/409`          | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/incidents/:id/investigate`      | Begin investigating (P-5.0 G-1)                                                                                                                                            | `incident:investigate`                                          | `InvestigateIncidentInput` | `200 {success,data:Incident}` · `403/404/409`          | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/incidents/:id/escalate`         | Escalate, recording who now owns it (G-1)                                                                                                                                  | `incident:escalate`                                             | `EscalateIncidentInput`    | `200 {success,data:Incident}` · `403/404/409`          | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/incidents/:id/assign`           | Assign / un-assign — **not** a lifecycle transition (G-2)                                                                                                                  | `incident:assign`                                               | `AssignIncidentInput`      | `200 {success,data:Incident}` · `403/404/409`          | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/incidents/:id/notes`            | Append an immutable operator note (G-2)                                                                                                                                    | `incident:comment`                                              | `AddIncidentNoteInput`     | `201 {success,data:Incident}` · `400/403/404/409`      | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/incidents/:id/activity`         | Derived activity log — transitions + assignments + notes (G-2)                                                                                                             | `incident:read`                                                 | —                          | `200 {success,data:IncidentActivity}` · `401/403/404`  | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/incidents/:id/timeline`         | Full investigation timeline — incident streams + bounded joins (`?include=events,evidence,notify`); an unavailable source becomes a typed `gap`, never silence (P-5.1 F-3) | `incident:read`                                                 | query                      | `200 {success,data:IncidentTimeline}` · `401/403/404`  | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/incidents/:id/sla`              | Derived SLA attainment — `unknown` when no policy is configured, never a flattering default (P-5.1 F-4)                                                                    | `incident:read`                                                 | —                          | `200 {success,data:IncidentSlaStatus}` · `401/403/404` | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / Prometheus / info                                                                                                                                   | None                                                            | —                          | infra (`/ready` = Mongo; `/metrics` = lifecycle)       | prom-client, Mongo  | scaffold | 0.1.0   |

> **Consumes** (NATS): `t.*.incident.candidate`. **Publishes:** `t.{tenantId}.incident.raised|acknowledged|resolved|closed`.

## @vip/service-notify (v0.1.0)

> Phase 1 P1-8. The Notification Context (**Alert Engine**): consumes `incident.raised` off NATS (Incident contracts only) and fans out to the tenant's channels (`in-app`/`webhook`), recording a delivery log and publishing `notification.*`. Channel CRUD + delivery-log read + recipient ack via a permission-gated API. Another tenant's channel/notification is a **404**; acking a non-ackable notification is a **409**.

| Method | Endpoint                          | Purpose                                      | Auth                  | Input                  | Output                                                 | Dependencies        | Status   | Version |
| ------ | --------------------------------- | -------------------------------------------- | --------------------- | ---------------------- | ------------------------------------------------------ | ------------------- | -------- | ------- |
| POST   | `/notification-channels`          | Create a channel (per-type config validated) | `notification:create` | `CreateChannelInput`   | `201 {success,data:NotificationChannel}` · `400/403`   | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/notification-channels`          | List the tenant's channels                   | `notification:read`   | —                      | `200 {success,data:NotificationChannel[]}` · `401/403` | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/notification-channels/:id`      | Get one channel (own tenant)                 | `notification:read`   | —                      | `200 {success,data:NotificationChannel}` · `404`       | Mongo, @vip/tenancy | beta     | 0.1.0   |
| PATCH  | `/notification-channels/:id`      | Update a channel                             | `notification:update` | `UpdateChannelInput`   | `200 {success,data:NotificationChannel}` · `400/404`   | Mongo, @vip/tenancy | beta     | 0.1.0   |
| DELETE | `/notification-channels/:id`      | Remove a channel                             | `notification:delete` | —                      | `204` · `401/403/404`                                  | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/notifications`                  | Delivery log (incident/status, paged)        | `notification:read`   | query                  | `200 {success,data:NotificationPage}` · `401/403`      | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/notifications/:id`              | Get one delivery record                      | `notification:read`   | —                      | `200 {success,data:Notification}` · `404`              | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/notifications/:id/ack`          | Recipient acknowledges a delivered alert     | `notification:ack`    | `AckNotificationInput` | `200 {success,data:Notification}` · `403/404/409`      | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / Prometheus / info     | None                  | —                      | infra (`/ready` = Mongo; `/metrics` = delivery)        | prom-client, Mongo  | scaffold | 0.1.0   |

> **Consumes** (NATS): `t.*.incident.raised`. **Publishes:** `t.{tenantId}.notification.sent|delivered|failed|acked`.

## inference (ai/inference, Python — v0.1.0)

> Phase 1 P1-6. The AI capability runtime (Perception context). Manifest-driven capabilities, model-agnostic (selector→registry via the adapter layer), staged pipeline, lifecycle states, metrics, version-stamped results. Internal (called by the pipeline, not user-facing); `/infer` is `x-internal-key` gated and fail-closed on missing tenant. Stdlib `http.server` transport.

| Method | Endpoint                          | Purpose                                            | Auth             | Input              | Output                                                   | Status |
| ------ | --------------------------------- | -------------------------------------------------- | ---------------- | ------------------ | -------------------------------------------------------- | ------ |
| POST   | `/infer`                          | Run a capability over one frame                    | `x-internal-key` | `InferenceRequest` | `200 {success,data:DetectionResult}` · `400/401/404/500` | beta   |
| GET    | `/capabilities`                   | Descriptors of all loaded capabilities (discovery) | None             | —                  | `200 {success,data:CapabilityDescriptor[]}`              | beta   |
| GET    | `/status`                         | Per-capability lifecycle state + metrics           | None             | —                  | `200 {success,data:[…]}`                                 | beta   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / Prometheus / info           | None             | —                  | infra (`/ready` = default capability READY)              | beta   |

## Infrastructure services (third-party APIs in the dev stack)

> Not VIP-authored endpoints; listed so integrators know what the stack exposes. Dev only, network-restricted, no auth (R-014).

| Service | Endpoint                                            | Purpose                                                      | Auth                                   | Status |
| ------- | --------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- | ------ |
| MLflow  | `http://localhost:45000/` (UI)                      | Model Registry + experiment tracking UI                      | None (dev)                             | infra  |
| MLflow  | `GET /health`                                       | Liveness (used by the compose healthcheck)                   | None                                   | infra  |
| MLflow  | `/api/2.0/mlflow/*` (REST)                          | Tracking + Model Registry REST API (used by `mlflow` client) | None (dev); `--allowed-hosts` enforced | infra  |
| MinIO   | `http://localhost:49001/` (console) · `:49000` (S3) | Object storage (MLflow artifacts, DVC datasets)              | root creds                             | infra  |

## Planned (not yet implemented)

| Service  | Endpoint (target)                              | Phase | Notes                                 |
| -------- | ---------------------------------------------- | ----- | ------------------------------------- |
| identity | `POST /auth/*`, `GET/POST /users`, `/api-keys` | P1    | OIDC/JWT/refresh(reuse-detection)/MFA |
| gateway  | public REST/OpenAPI + WS surface               | P1    | authN/Z, tenant routing, rate limit   |
| tenant   | `/tenants`, config/entitlements                | P1    |                                       |

_Add rows as each service exposes endpoints; keep this table in sync with each service README and the generated OpenAPI (from `@vip/contracts`)._
