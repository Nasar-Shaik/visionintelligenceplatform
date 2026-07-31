# G-4 — Evidence APIs

> **Milestone:** P2-2 **G-4** (Evidence subsystem) · **Status:** ✅ **ACCEPTED** (Architect review 2026-07-31)
> **Scope:** a production-grade Evidence subsystem — snapshots, clips, manifest, metadata, custody,
> retention, secure retrieval — implementing the frozen **Evidence bounded context** ([22 §11](../architecture/22-BOUNDED-CONTEXTS.md), [23 §evidence](../architecture/23-SERVICE-OWNERSHIP.md), [12](../architecture/12-EVIDENCE-MANAGEMENT.md)).
> **Author:** Claude · _2026-07-30_

---

## 1. What shipped

A new **`services/evidence`** service (the frozen Evidence context — **not** an invented service) plus
the supporting contracts, storage provider, and permissions.

- **Contracts** ([`@vip/contracts/evidence`](../../packages/contracts/src/evidence/evidence.ts), **+10 published schemas → 53**):
  `EvidenceManifest` (canonical descriptor) + `Evidence` (manifest + lifecycle), `EvidenceKind`,
  `EvidenceStatus`, `StorageTier`, `EvidenceSource`/`EvidenceMedia`/`EvidenceIntegrity`/`EvidenceMetadata`/
  `EvidenceAiMetadata`/`EvidenceInterval`/`EvidenceRetention`, `RegisterEvidenceInput`,
  `UpdateEvidenceMetadataInput`, `SetRetentionInput`, `EvidenceQuery`/`EvidencePage`,
  `EvidenceDownloadTarget`, `EvidenceCustodyAction`/`EvidenceCustodyEntry`/`EvidenceCustodyPage`.
- **Storage abstraction** ([`@vip/storage`](../../packages/storage/)): new **`LocalFsObjectStore`** behind
  the existing `ObjectStore` port (S3/MinIO already there); provider chosen by config.
- **Permissions** ([`@vip/permissions`](../../packages/permissions/)): `evidence:*` (admin),
  `evidence:create`/`evidence:update` (operator); read via `*:read`; `evidence:manage` (retention/hold)
  admin/owner only.
- **Service** (hexagonal): domain (immutable manifest factory, sha256 integrity, stable ids, hash-chained
  custody, retention), application (`EvidenceService` + ports + publisher + metrics + incident consumer),
  adapters (in-memory + Mongo store/custody, storage-provider factory), transport (9 routes), bootstrap.
- **Gateway**: `/api/evidence/*` upstream wired (port 8090).

## 2. Architecture validation (Architect rec 8)

| Property                          | How it's guaranteed                                                                                       | Proof                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Evidence immutability**         | domain exposes no mutator for `media`/`source`/`id`/`capturedAt`; only overlay/lifecycle/retention change | `evidence-service.test.ts` "NEVER mutates the media"    |
| **Storage abstraction integrity** | one `ObjectStore` port; `local`/`s3` by config; keys opaque + provider-independent                        | `LocalFsObjectStore` tests (13) + provider factory      |
| **Tenant isolation**              | `@vip/tenancy` guard on every store op + per-tenant `TenantObjectStore`; cross-tenant → 404               | service + HTTP tests (404 both)                         |
| **Chain-of-custody integrity**    | append-only, hash-chained (`hash = sha256(prevHash\|content)`); `verifyChain`                             | `custody.test.ts` (tamper/reorder/broken-link detected) |
| **Event → Evidence traceability** | `source.{eventId,ruleId,incidentId,correlationId,cameraId,recordingId}`                                   | `incident-consumer.test.ts` (Event→Incident→Evidence)   |
| **Secure playback/download**      | signed-URL only (client ↔ storage), expiring; issuance audited                                            | service + HTTP tests (`signed://`, `accessed` custody)  |
| **Retention lifecycle**           | `retainUntil` + `legalHold` + `StorageTier`; `expireIfDue` gate; hold blocks purge                        | service tests (expire + refuse download)                |
| **Contract compatibility**        | +10 JSON schemas, 123 contract tests, additive-only                                                       | `verify:contracts` (53), `evidence.test.ts`             |
| **Documentation completeness**    | service README + this doc + ED-0034 + TD-15…18                                                            | this package                                            |

## 3. The 8 design recommendations — where each landed

1. **Evidence Manifest** → `EvidenceManifest` (canonical, storage-independent; `Evidence` extends it).
2. **Preserve original** → write-once `media`; sidecar `metadata`/`ai`; no media mutator.
3. **Storage lifecycle** → `StorageTier` (active→warm→cold→archive), config/provider-independent (sweeps deferred, TD-18).
4. **Relationships** → N evidence per incident (query by `incidentId`); extensible `EvidenceKind`.
5. **Traceability** → `EvidenceSource` full chain (event/rule/incident/correlation/camera/recording).
6. **AI extensibility** → `EvidenceAiMetadata` engine-agnostic sidecar.
7. **Export-ready** → manifest + custody + query compose a future export (no structural change), TD-16.
8. **Arch validation** → §2 above + the test matrix.

## 4. Tests

| Suite                                   |      Count | Covers                                                                                 |
| --------------------------------------- | ---------: | -------------------------------------------------------------------------------------- |
| contracts `evidence.test.ts`            | 6 (of 123) | shapes, defaults, invariants                                                           |
| storage `local-fs-object-store.test.ts` |         13 | provider round-trip, signed URLs, traversal-safe, tenant wrapper                       |
| evidence `evidence-service.test.ts`     |          9 | register/idempotency/integrity/download/metadata/retention/expiry/isolation/pagination |
| evidence `custody.test.ts`              |          5 | hash-chain verify + tamper/reorder/broken-link detection                               |
| evidence `incident-consumer.test.ts`    |          2 | incident→evidence extraction + fail-closed dead-letter                                 |
| evidence `http.test.ts`                 |          6 | permission gating, 201/403/404/401, signed download, custody                           |
| evidence `mongo-integration.test.ts`    |          2 | real Mongo + LocalFs: idempotency, pagination, isolation, custody                      |

**Deterministic; no camera.** All repo gates green (typecheck 28, import-graph **19 pkgs 0-viol**,
contracts **53**, lint, build, format).

## 5. Technical debt (tracked)

[TD-15](../../tracking/TECH-DEBT.md) live media-backed extraction (the no-op extractor is the seam);
[TD-16](../../tracking/TECH-DEBT.md) export packages; [TD-17](../../tracking/TECH-DEBT.md) legal-hold
approval workflow + redaction; [TD-18](../../tracking/TECH-DEBT.md) automated retention sweeps + tier
transitions. All additive behind the shipped model.

## 6. Definition of Done

- [x] Architecture consistent with the frozen Evidence context; no frozen doc changed.
- [x] Type checking, import-graph clean, contracts validated, tests deterministic, all gates green.
- [x] Documentation complete (README, this review, ED-0034, TD register).
- [x] **Architect review of G-4** ✅ **APPROVED** (2026-07-31) — implemented as a true bounded context, not a file-storage service; architectural boundaries clean and consistent with the frozen platform. Five forward-architecture recommendations recorded (not blockers) — see §7.

## 7. Architect forward recommendations (G-4 acceptance, 2026-07-31)

Five strategic items raised at acceptance — **future evolution, NOT G-4 blockers**. The current model
already supports each without a structural change. Logged in the future-architecture index
([future/README §G-4 recommendations](../architecture/future/README.md)).

1. **Evidence Timeline** — an Investigation Timeline projection (Incident → Evidence → Snapshots → Clips → Operator Notes → Export Packages) over the existing evidence model; presentation-only, no model change.
2. **Evidence Collections** — group N evidence objects under an Investigation; already expressible via `source`/query, no implementation now.
3. **Storage Health Monitoring** — operational visibility per provider (availability, capacity, latency, signed-URL failures, retrieval failures); pairs with the `ObjectStore` port + `EvidenceMetrics`.
4. **Advanced Evidence Search** — structured-metadata search (camera/incident/rule/event/AI-label/confidence/trackId/date/tags) over the manifest, independent of storage implementation.
5. **AI Runtime Integration doc** — consolidate the full RTSP→…→Evidence→Alert→Dashboard journey into `docs/architecture/future/AI_RUNTIME_INTEGRATION.md`, preserving the existing modular design.
