# evidence — Evidence Context (Phase 2, P2-2 G-4)

The **Evidence bounded context** ([22 §11](../../docs/architecture/22-BOUNDED-CONTEXTS.md),
[23 §evidence](../../docs/architecture/23-SERVICE-OWNERSHIP.md),
[12-EVIDENCE-MANAGEMENT](../../docs/architecture/12-EVIDENCE-MANAGEMENT.md)): the **defensible record** of
what an AI-generated incident saw. It registers snapshots & video clips as **immutable, traceable
evidence** with a canonical **manifest**, version-safe overlay metadata, an append-only **hash-chained
chain-of-custody**, retention/legal-hold, and **signed-URL-only** secure retrieval — and it **never
depends on any AI engine** (consumes only standardized platform contracts).

> Contract-first against [`@vip/contracts/evidence`](../../packages/contracts/src/evidence/evidence.ts).
> Storage is provider-abstracted ([`@vip/storage`](../../packages/storage/) `ObjectStore`); tenant
> isolation via [`@vip/tenancy`](../../packages/tenancy/). Governed by G-4 (ED-0034).

## Design invariants (G-4)

1. **Immutable original.** The stored media is never modified. The `media` block (`storageKey`,
   `contentType`, `integrity`) + `source` + `capturedAt` are **write-once**; only the sidecar overlay
   (`metadata`), AI enrichment (`ai`), lifecycle (`status`), and `retention` evolve. Structurally
   enforced: the domain exposes no mutator for the original. **Original Media → Overlay → Presentation.**
2. **Evidence Manifest.** [`EvidenceManifest`](../../packages/contracts/src/evidence/evidence.ts) is the
   canonical, storage-implementation-independent descriptor (`storageKey` is opaque and resolves
   identically across any provider). Self-contained enough to be the JSON manifest in a future export.
3. **Stable, idempotent ids.** `id = evd_<sha1(tenantId|storageKey)>` — re-registering the same object
   returns the existing item (no duplicate, no duplicate custody).
4. **Integrity + chain-of-custody.** A SHA-256 over the bytes anchors tamper-evidence; every action
   (created/accessed/metadata-updated/retention-set/legal-hold/expired/purged) appends a **hash-chained**
   custody entry (`hash = sha256(prevHash | content)`), verifiable via `/custody/verify`.
5. **Traceability.** `source` links every item back through **Event → Rule → Incident → Evidence**
   (`eventId`, `ruleId`, `incidentId`, `correlationId`, `cameraId`, `recordingId`).
6. **Engine-agnostic AI extension.** `ai` (`EvidenceAiMetadata`) is a structured but engine-neutral
   sidecar stored verbatim — new models enrich evidence without a contract change.
7. **Tenant isolation.** Fail-closed via the `@vip/tenancy` guard + a per-tenant `TenantObjectStore`
   (`{tenant}/…` object prefix). Another tenant's item is always a **404**.
8. **Storage abstraction.** Bytes live behind the `ObjectStore` port; the provider is chosen by
   **config, not code** — `EVIDENCE_STORAGE_PROVIDER=local|s3` (Azure Blob / GCS drop in behind the
   same port). Retrieval is **signed-URL only** (client ↔ storage directly), so the service never
   streams media bytes.

## HTTP surface (behind the gateway at `/api/evidence/*`)

| Method | Path                           | Purpose                                | Permission        |
| ------ | ------------------------------ | -------------------------------------- | ----------------- |
| GET    | `/evidence`                    | list (filter + keyset pagination)      | `evidence:read`   |
| GET    | `/evidence/:id`                | get one item                           | `evidence:read`   |
| GET    | `/evidence/:id/manifest`       | canonical manifest (export descriptor) | `evidence:read`   |
| POST   | `/evidence`                    | register evidence for a stored object  | `evidence:create` |
| GET    | `/evidence/:id/download`       | short-lived **signed** URL (audited)   | `evidence:read`   |
| PATCH  | `/evidence/:id/metadata`       | version-safe overlay update            | `evidence:update` |
| POST   | `/evidence/:id/retention`      | set retention / legal hold / tier      | `evidence:manage` |
| GET    | `/evidence/:id/custody`        | chain-of-custody (oldest-first)        | `evidence:read`   |
| GET    | `/evidence/:id/custody/verify` | verify the custody hash-chain          | `evidence:read`   |

All routes are permission-gated (deny-by-default, [@vip/permissions](../../packages/permissions/)),
tenant-scoped from the validated access token (`iss=identity`, `aud=vip`), cross-tenant fail-closed.

## Event-driven

Consumes **`incident.raised`** ([22 §11]) via `IncidentEvidenceConsumer` → an injected
`IncidentEvidenceExtractor`. G-4 ships the wiring + a **no-op** extractor (live media-backed extraction
needs the Media frame source — deferred, see TD); the event path is real + tested. Publishes
**`evidence.created`** (`t.{tenant}.evidence.*`).

## Configuration (env, `.env` only — ADR-0018)

`PORT` (8090), `JWT_SECRET`, `MONGO_URI`, `NATS_URL`, S3 group (`S3_ENDPOINT`, `AWS_*`),
`EVIDENCE_STORAGE_PROVIDER` (`local`|`s3`), `EVIDENCE_LOCAL_DIR`, `EVIDENCE_LOCAL_PUBLIC_BASE_URL`,
`EVIDENCE_DOWNLOAD_TTL_SECONDS` (900), `EVIDENCE_DEFAULT_RETENTION_DAYS` (0 = indefinite),
`EVIDENCE_CONSUME_INCIDENTS` (`true`).

## Run / test

```bash
pnpm --filter @vip/service-evidence test              # deterministic units (no infra)
pnpm --filter @vip/service-evidence test:integration  # real Mongo + LocalFs (skips if no Mongo)
pnpm --filter @vip/service-evidence dev
```

## Deferred (tracked debt — [TD-15…TD-18](../../tracking/TECH-DEBT.md))

Live ring-buffer/key-frame **extraction** from Media (the no-op extractor is the seam); **export
packages** (watermark + manifest + custody bundle); **legal-hold approval workflow** + **redaction**;
**automated retention sweeps** + hot/cold/archive **tier transitions**. All are additive behind the
shipped model — no structural change required.
