# Evidence Package — Specification (Deliverable 7)

_Status: ⏳ Architect Review Pending · ADR: [ADR-0020] · Documentation-only · Formalizes [12-EVIDENCE-MANAGEMENT](../12-EVIDENCE-MANAGEMENT.md) + [18-DATA-ARCHITECTURE](../18-DATA-ARCHITECTURE.md) + [15-SECURITY](../15-SECURITY-ARCHITECTURE.md)_

> Every incident should reference an **immutable Evidence Package** — the auditable, court-defensible
> bundle of everything that proves why the incident fired. This formalizes the evidence concept already
> in [12] and connects it to the P1-8 incident (which already carries `correlationId` + `triggeredBy`)
> and the **G-4 enabler** (evidence refs on `incident.raised`, currently deferred as [TD-8]).

## What already exists

- **Recordings** in a **tenant-prefixed object store** (`@vip/storage`, MinIO/S3):
  `{tenantId}/{cameraId}/recordings/…`, signed-URL access, fail-closed prefix isolation.
- **Incident** carries provenance: `triggeredBy` (eventId, eventType, camera, zone, occurredAt),
  `source` (ruleId/version/name), **required `correlationId`**, `severity`, `history[]`, `matchedCount`.
- **DetectionResult / EventEnvelope** carry model provenance (capability + version, execution provider,
  confidence) and the correlation chain (frame → detection → event → candidate → incident).
- **[12]** designs smart-clip evidence; **[15]** designs per-tenant KMS envelope encryption for
  evidence/PII; **[18]** the data lifecycle (raw ephemeral, aggregates/events persist).

## Package contents (directive fields → source)

| Element            | Source (already produced)                                                     |
| ------------------ | ----------------------------------------------------------------------------- |
| Snapshot           | frame at trigger time (media JPEG pipeline / G-1)                             |
| Video Clip         | pre/post-roll segment from the recording (media, [12] smart clip)             |
| Timeline           | the incident `history[]` + surrounding `event.persisted` window               |
| Triggering Event   | `EventEnvelope` (id, type, payload)                                           |
| Triggered Rule     | `source.ruleId` + the rule **version snapshot** (rule_versions)               |
| Camera Information | camera id + org/site/zone (tenant hierarchy)                                  |
| AI Model + Version | `producer.capability`+`capabilityVersion`, `modelVersion`, execution provider |
| Confidence         | `EventEnvelope.confidence` / detection confidence                             |
| Correlation ID     | `incident.correlationId` (the through-line)                                   |
| Incident Metadata  | severity, priority, status, matchedCount, timestamps                          |
| Audit Information  | who/when accessed + lifecycle events (append-only audit log)                  |

## Immutability & storage architecture

```
on incident.raised
   ├─ assemble EvidencePackage (references, not copies where possible)
   ├─ snapshot + clip → object store  {tenantId}/evidence/{incidentId}/…
   ├─ manifest.json (all fields above) → hashed (SHA-256) → contentHash
   ├─ seal: write-once (object-lock / WORM), per-tenant KMS-encrypted ([15])
   └─ incident.evidenceRef = { packageId, contentHash, storageUri }
```

- **Immutable:** object-lock / WORM + a **content hash** over the manifest; any tamper is detectable.
  The package is **never mutated** after seal — corrections are new packages linked to the original.
- **Tenant-isolated:** the existing `{tenantId}/…` prefix guard (`@vip/storage`) — evidence never
  crosses tenants; access is signed-URL only, permission-gated (`evidence:read`).
- **Encrypted at rest:** per-tenant KMS envelope ([15]); the manifest may hold PII → encryption + access
  audit are mandatory.
- **Referenced, not embedded:** the incident stores a light `evidenceRef`; the console Evidence Viewer
  resolves signed URLs on demand.

## Lifecycle

```
sealed ──▶ retained (tenant retention policy) ──▶ [legal hold?] ──▶ expired ──▶ purged
                                                      │
                                             GDPR/erasure request ──▶ crypto-shred (destroy tenant key)
```

- **Retention:** per-tenant policy (default from [12]/[18] — smart-clip only, TTL'd raw); legal-hold
  overrides expiry.
- **Erasure (GDPR "right to be forgotten") vs immutability:** resolved by **crypto-shredding** —
  destroy the per-record/tenant key so the immutable ciphertext is unrecoverable, without mutating the
  sealed object (AR-3).
- **Audit:** every access + lifecycle transition is appended to a tamper-evident log (hash-chained —
  aligns with the workflow audit deferred in [TD-8]).

## Proposed contract sketch (future — NOT built)

```
EvidencePackage = {
  id, tenantId, incidentId, correlationId,
  contentHash, storageUri, sealedAt,
  snapshot?: Ref, clip?: Ref, timeline: EventRef[],
  trigger: { event: EventRef, ruleVersionSnapshot: Ref },
  camera: { id, orgPath }, model: { capability, version, provider, confidence },
  retention: { policyId, expiresAt?, legalHold: boolean },
  audit: AuditRef,
}
IncidentEvidenceRef = { packageId, contentHash, storageUri }  // added to Incident (additive)
```

## Integration (no core change to the vertical)

- Built as the **G-4 enabler** (workflow + media extension, not a new service): on `incident.raised`,
  workflow requests media to seal the snapshot/clip and attaches `evidenceRef`.
- The console **Evidence Viewer** ([DEMONSTRATION_WORKFLOWS](DEMONSTRATION_WORKFLOWS.md)) renders it.
- Everything it needs (provenance, correlation, rule version, model version, confidence) is **already
  produced** by Phase 1 — this assembles + seals it.

## Not built now

Phase-2 delivers **G-4 evidence refs** (snapshot/clip signed URLs on an incident) — the minimum for the
Evidence Viewer demo. Full **immutable WORM + crypto-shred lifecycle + hash-chained audit** is
**Phase 3** (enterprise/compliance), gated on a customer compliance requirement.
