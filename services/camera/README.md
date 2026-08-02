# @vip/service-camera

The **Camera (inventory) context** service (Phase 1, P1-3). Onboards cameras, places each in the
tenant-owned location hierarchy, **vaults their credentials encrypted at rest**, exposes health,
and publishes the `camera.*` lifecycle events that drive media ingestion (P1-4).

> Design: [phase1/CAMERA_ARCHITECTURE](../../docs/architecture/phase1/CAMERA_ARCHITECTURE.md) ·
> ownership: [22-BOUNDED-CONTEXTS §3](../../docs/architecture/22-BOUNDED-CONTEXTS.md),
> [23-SERVICE-OWNERSHIP](../../docs/architecture/23-SERVICE-OWNERSHIP.md).

## Model

- **Cameras belong to the tenant.** Every record carries `tenantId` and flows through the
  [@vip/tenancy](../../packages/tenancy/README.md) fail-closed guard — a camera from another
  tenant is **unaddressable** (a `404`, never an existence leak).
- **The location hierarchy (`org → … → zone`) is owned by the Tenant context** ([P1-1 `OrgNode`](../tenant/README.md)),
  not here. A camera **references** its zone by `zoneId`. Referential integrity against the
  hierarchy is reconciled asynchronously over `tenant.hierarchy.changed` (P1-5) rather than a
  synchronous cross-service call — tracked as [TD-3](../../tracking/TECH-DEBT.md).
- **Credentials are vaulted, never surfaced.** On create/update they are sealed with
  [@vip/crypto](../../packages/crypto/README.md) (AES-256-GCM over an `.env`-derived key) and only
  the cipher is stored. Responses/events/logs expose `hasCredentials: boolean` — never the
  plaintext or cipher. A `streamUrl` may **not** embed `user:pass@` (rejected at the contract).

## Auth

The camera service **verifies the identity-issued Bearer access token itself** (defence-in-depth:
`iss=identity`, `aud=vip`, same expectation as the gateway — it does not blindly trust forwarded
headers). Every route is **permission-gated** (deny-by-default via
[@vip/permissions](../../packages/permissions/README.md)) and scoped to the token's tenant.

## Endpoints

| Method | Path                                | Purpose                                              | Auth            |
| ------ | ----------------------------------- | ---------------------------------------------------- | --------------- |
| POST   | `/cameras`                          | Onboard a camera (vault credentials)                 | `camera:create` |
| GET    | `/cameras`                          | List the tenant's cameras                            | `camera:read`   |
| GET    | `/cameras/:id`                      | Get one camera                                       | `camera:read`   |
| PATCH  | `/cameras/:id`                      | Update / re-vault credentials / metadata / caps      | `camera:update` |
| DELETE | `/cameras/:id`                      | Remove from inventory                                | `camera:delete` |
| GET    | `/cameras/:id/health`               | Observed health (`unknown` until probed)             | `camera:read`   |
| POST   | `/cameras/discover`                 | **P-1** ONVIF discovery + tenant reconciliation      | `camera:create` |
| POST   | `/cameras/bulk`                     | **P-1** Bulk onboard (DVR/NVR channels)              | `camera:create` |
| POST   | `/cameras/validate`                 | **G-1** Test-connection: validate a candidate config | `camera:read`   |
| POST   | `/cameras/:id/validate`             | **G-1** Validate an existing camera's config         | `camera:read`   |
| GET    | `/cameras/:id/capabilities`         | **G-1** Declared capabilities (ptz/audio/codecs/…)   | `camera:read`   |
| POST   | `/cameras/:id/health/check`         | **G-1** Active re-check → records a health snapshot  | `camera:update` |
| POST   | `/cameras/:id/enable`               | **G-1** Set status `enabled`                         | `camera:update` |
| POST   | `/cameras/:id/disable`              | **G-1** Set status `disabled`                        | `camera:update` |
| POST   | `/cameras/:id/probe`                | **P-2** Test the connection against the device       | `camera:update` |
| POST   | `/cameras/:id/capabilities/refresh` | **P-2** Re-read capabilities (`?force=true`)         | `camera:update` |
| GET    | `/cameras/:id/health/summary`       | **P-2** Trends over the timeline (`?window=`)        | `camera:read`   |
| POST   | `/cameras/:id/retire`               | **P-2** Decommission, keeping the record             | `camera:update` |
| POST   | `/cameras/:id/reinstate`            | **P-2** Return a retired camera to service           | `camera:update` |
| GET    | `/cameras/:id/probes`               | **P-2.2** Retained probe reports (`?limit=`)         | `camera:read`   |
| GET    | `/cameras/:id/probes/metrics`       | **P-2.2** Probe performance (`?window=`)             | `camera:read`   |
| GET    | `/cameras/:id/probes/:probeId`      | **P-2.2** Replay a stored report — contacts nothing  | `camera:read`   |
| GET    | `/cameras/:id/evidence`             | **P-2.2** Every record, one chronology (`?window=`)  | `camera:read`   |
| GET    | `/cameras/:id/confidence`           | **P-2.3** Reliability trend (`?window=`) — derived   | `camera:read`   |
| GET    | `/cameras/:id/decisions`            | **P-2.3** Why the platform did what it did           | `camera:read`   |
| GET    | `/cameras/metrics`                  | **P-2.2** Fleet probe performance (`?window=`)       | `camera:read`   |
| GET    | `/health` `/ready` `/metrics` `/`   | liveness / readiness / metrics / info                | —               |

Publishes `camera.registered`, `camera.updated`, `camera.removed`, `camera.health.checked` via a
publisher seam (NATS wiring in P1-5). Payloads carry ids/metadata only — **never** credentials.

**P2-2 G-1 (enhancements).** A camera now carries **`capabilities`** (what it supports — ptz, audio,
snapshot, codecs, resolutions, protocols; derived from protocol + capture at onboarding, or declared)
and **`metadata`** (operator/device fields — manufacturer, model, firmware, serial, location, tags,
notes). **Validation** (`/cameras/validate`) is a deterministic, no-persistence "test connection"
that reports structured checks (scheme, no-embedded-credentials, protocol match, resolution format);
active network reachability is intentionally _not_ proven here — that is the ingestion path's job
(Media enabler **G-2**), reported as an informational check only.

## Configuration (env)

Via [`@vip/config`](../../packages/config/README.md): `HOST`, `PORT`, `LOG_LEVEL`, `MONGO_URI`
(**required**), `JWT_SECRET` (**required**, verifies inbound tokens), `CREDENTIAL_ENCRYPTION_KEY`
(**required**, ≥16 chars — derives the vault key; keep **stable**, rotating it orphans existing
ciphertext). Invalid config aborts startup.

## Layering

`transport → application → domain`; `adapters` implement ports. Credentials are sealed in the
**application** layer (which holds the `SecretBox`), so the **domain stays pure** and never sees
plaintext. Enforced repo-wide by `pnpm check:imports`.

## Run / test

```bash
pnpm --filter @vip/service-camera dev        # watch mode (tsx)
pnpm --filter @vip/service-camera test       # vitest (unit + inject HTTP; real-Mongo when MONGO_URI set)
pnpm --filter @vip/service-camera build && node dist/index.js
```

HTTP/unit tests use Fastify `app.inject()` — no Docker required. The real-driver integration suite
(unique index, ciphertext round-trip, cross-tenant isolation) runs when `MONGO_URI` points at a
reachable Mongo (`pnpm dev:stack`), and skips otherwise.

## Network discovery (P-1)

`POST /cameras/discover` probes the local segment for ONVIF devices and reconciles the answers against
this tenant's inventory. It **persists nothing** — it returns candidates, and onboarding stays a
separate, deliberate act.

**The ONVIF implementation is not here.** The platform's only tested ONVIF stack lives in the AI
runtime (`ai/inference/onvif.py`, built for the AI-5e certification harness), and this service calls it
through a `DiscoveryProvider` port rather than growing a second one that would drift — see
[ADR-0023](../../docs/adr/ADR-0023-onvif-discovery-placement.md). Set `CAMERA_DISCOVERY_URL` to the
runtime's base URL to enable it.

**Leaving it unset is a supported deployment**, not a broken one: plenty of estates are onboarded from
a list of RTSP URLs. The service then reports discovery as _unavailable_ — which is deliberately
distinct from _found nothing_, because the first sends an installer to their settings and the second
sends them to their switch.

Three behaviours worth knowing before changing this code:

- **Already-onboarded devices are returned, marked** (`alreadyOnboarded` + `cameraId`), never filtered
  out. Someone re-scanning a half-configured site has to be able to tell "already added" from "did not
  answer". Matching is on a normalized stream URL: scheme and host case-insensitive per RFC 3986, path
  preserved (DVR channel paths are case-sensitive), trailing slash dropped.
- **Discovery never changes a certification status.** A successful `GetDeviceInformation` is not a
  passing certification run; the compatibility registry keeps every device at `pending-validation`
  ([CONSTRAINTS §18](../../docs/project/CONSTRAINTS.md)).
- **`POST /cameras/bulk` is deliberately not transactional.** One bad channel in a 16-channel DVR must
  not discard the other fifteen, so each camera is created independently and each row carries its own
  outcome. Items are validated **per item** against `CreateCameraInput`, not at the envelope.
- **Devices are matched on identity first, address second (P-2).** The ONVIF endpoint UUID is stored at
  onboarding, so a camera whose DHCP lease moved it is reported as `addressChanged` rather than offered
  as a new device. Without that, the estate ends up holding one physical camera twice.

## Camera lifecycle (P-2)

`discovered → validated → configured → connected → monitoring → degraded → offline → retired`

**The rule to know before touching `domain/lifecycle.ts`:** `connected`, `monitoring`, `degraded` and
`offline` are claims about a physical device and may only be entered from a probe of that device with
`EvidenceClass: hardware`. A flawless probe of a _simulated_ source returns its full check report and
advances nothing — otherwise a demo environment reports a connected estate that does not exist. This
is [CONSTRAINTS §18](../../docs/project/CONSTRAINTS.md) applied to devices; see
[ADR-0024](../../docs/adr/ADR-0024-camera-lifecycle-evidence-gate.md).

Transitions come from an explicit map. `retired → connected` does not exist: a decommissioned camera
must be **reinstated**, and reinstatement returns it to `configured`, not to whatever measured state it
held before. `retire` is **not** `delete` — the record and its timeline are kept, because an incident
investigation months later may need them.

The measurement is `POST /streams/validate` on the AI runtime, reached through the `StreamProbe` port
(same arrangement as discovery, same `CAMERA_DISCOVERY_URL`). It returns thirteen **ordered, timed**
stages — `dns → tcp → authentication → rtsp-negotiation → stream-open → first-frame →
frames-received → codec → resolution → fps → stream-profile → latency → jitter` — plus **one**
mutually-exclusive failure code. A failure leaves later stages `not-executed` rather than `fail`, and
a stage a transport does not have is `skipped`: three different facts that a boolean flattens into
one useless one.

**Do not re-derive the failure from the check list.** The runtime assigns `failureCode`; the console
maps it to words. Inferring it a second time is how two components come to disagree about one event.

Capabilities are **cached, not re-queried**: `CapabilityCache` records the firmware, timestamp and
source they were read against, and `domain/capability-cache.ts` decides whether to go back to the
device. Bump `CAPABILITY_CACHE_VERSION` whenever discovery starts extracting something new, or every
camera will keep reporting the narrower set it was first read with. Freshness (`fresh`/`aging`/
`expired`/`unknown`) is **computed on read** — a stored freshness value is wrong the moment after it
is written.

A refresh produces a **diff** (`domain/capability-diff.ts`), severity-classified so a 1080p→4K jump
is not buried beside a firmware string. Profiles are compared **by name, not position**: devices
reorder them between firmware versions, and a positional diff would report every profile as changed
on every upgrade.

**Device identity is appended to, never overwritten** (`CameraIdentityHistory`). "When did this
camera become a different device?" is unanswerable the moment a serial number is overwritten in
place.

## The operational evidence layer (P-2.2)

A probe is **evidence**, not the latest reading. Reports live in their own append-only collection
(`camera_probes`), and **there is no update path against it** — `domain/probe-archive.ts` exposes no
mutator and `CameraService.archive()` only ever inserts. A correction is a new record. Retention is
bounded per camera and `CameraProbeHistory.evicted` reports what was dropped, so a trimmed archive
can never read as a complete one ([CONSTRAINTS §27](../../docs/project/CONSTRAINTS.md)).

Records are ordered by a per-camera **`sequence`**, not by timestamp. Two probes land in the same
millisecond routinely — a retry, a scheduled sweep — and a time sort leaves their order, and the
`previousProbeId` chain that "when did this start failing?" walks, down to the storage engine.

**Replay reconstructs; it never re-measures** (§28). `replayProbe()` is pure and has no camera,
network or probe port in scope, and its route is a `GET`. Support work happens days after a failure,
often on a camera since power-cycled into working — re-probing then measures a different moment.

**One validation engine, many providers** (§29). The runtime's `register_provider(...)` registry
declares which stages each source type has: RTSP · HTTP · WebRTC · SRT · recorded video · DVR
export · NVR playback · USB camera · edge stream. A new source type is a registration, never a second
validation path — two paths would grow two definitions of "connected".

**Drift classification** (`classifyDrift`) attributes each capability change to what was actually
observed and decides whether it needs attention. Codec, resolution, FPS, stream profiles and anything
security-classed stay `unexpected` **even under a firmware upgrade**: nobody upgrades a camera
intending to lose a profile, and filing it under "explained" is how it stops being investigated.

**Operational confidence** (`domain/confidence.ts`) is a _device reliability_ score and must never be
rendered beside an AI confidence. It is never computed from a single probe — two floors enforce that,
and `insufficient-evidence` carries no score at all.

**The compatibility register** is keyed by (dimension, value) across firmware, runtime version, ONVIF
version, codec, provider and edge profile. Older rows are never overwritten, and `unsupported` is
claimed only for a **device-side** failure under hardware evidence: a DNS failure, a dead switch port
or a wrong password says nothing whatsoever about a firmware.

**Four write models, one read model.** The lifecycle timeline, identity history, probe archive and
compatibility register have different bounds, keys and retention rules, so they stay separate on the
write side; `GET /cameras/:id/evidence` merges them chronologically on read. The archive is
authoritative for probes, so a lifecycle entry echoing an archived report is dropped from the merge
rather than counted twice.

## Chain of custody, and the freeze (P-2.3)

Every evidence item carries the **same envelope** whatever produced it — `evidenceId` ·
`evidenceType` · `evidenceClass` · `source` · `tenantId` · `producer` · `producerVersion` ·
`runtimeVersion` · `at` · `correlationId` · `sessionId`. `evidenceId` is **derived from the record**,
never generated: the timeline is merged from four stores on every request, and a generated id would
make every navigation link dangle on the next refresh.

Causation runs **both ways**. `rootCauseEvidenceId` answers _why did this happen_;
`causedEvidenceIds` answers _what did it break_, which is what decides whether an incident is over.

**Persist measurements; derive conclusions** ([CONSTRAINTS §30](../../docs/project/CONSTRAINTS.md)).
Confidence, trends, decisions and metrics are pure functions over stored records — there is no writer
for any of them. `domain/decisions.ts` reconstructs _why was this camera degraded / why was this probe
marked failed / why did confidence drop_, and **nothing consults a decision**: it is explainability
only, which is what allows it inside the freeze.

**The unified timeline is the only investigation API** (§32). Consumers read the envelope rather than
switching on the producer — the console's source and producer labels are lookups with a fallback, and
a test renders an evidence type the console has never heard of. `diagnostics`, `recovery`,
`certification` and `session` are declared ahead of their producers, because adding an enum value
later is the one contract change that is not purely additive for a strict parser.

**Fleet reads are bounded** (rec 5). Sorting and limiting live in the query, not after it; the fleet
aggregate counts cameras rather than loading them, and `FleetProbeMetrics.sampled` says when the caps
bit. A sampled aggregate presented as a census is worse than no aggregate.

> **🔒 The Camera Foundation is frozen** ([CONSTRAINTS §31](../../docs/project/CONSTRAINTS.md)):
> discovery · identity · lifecycle · capability cache · probe pipeline · evidence archive ·
> operational timeline · compatibility tracking. Extend through **additive contracts only** — a new
> field, a new enum value, a new validation provider, a new evidence type. A breaking change requires
> an ADR.
