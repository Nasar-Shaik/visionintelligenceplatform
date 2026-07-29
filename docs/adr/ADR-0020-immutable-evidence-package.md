# ADR-0020 — Immutable Evidence Package

- **Status:** Proposed
- **Date:** 2026-07-29
- **Deciders:** Principal Architect (architecture enhancement review) + development
- **Touches:** a new `@vip/contracts` shape (`EvidencePackage` + additive `Incident.evidenceRef`); the evidence lifecycle in [12-EVIDENCE-MANAGEMENT], data lifecycle [18], security/KMS [15]. Full spec: [future/EVIDENCE_PACKAGE](../architecture/future/EVIDENCE_PACKAGE.md).

## Context

Every incident should reference an auditable, court-defensible bundle proving why it fired. Phase-1
incidents already carry provenance (`correlationId`, `triggeredBy`, rule + model versions, confidence)
and media records tenant-prefixed clips, but there is **no assembled, immutable evidence artifact**
(evidence linking is deferred as [TD-8]; the G-4 enabler produces refs but not the sealed package).

## Decision

Define an **immutable Evidence Package**, assembled on `incident.raised` and referenced by the incident:

1. **Contents:** snapshot, clip, timeline, triggering event, triggered **rule-version snapshot**,
   camera/org info, AI model + version, confidence, correlation id, incident metadata, audit info.
2. **Immutable:** sealed **write-once (object-lock/WORM)** + a **SHA-256 content hash** over the
   manifest; never mutated after seal (corrections are new, linked packages).
3. **Isolated + encrypted:** stored under the existing `{tenantId}/evidence/{incidentId}/…` prefix
   (`@vip/storage` fail-closed guard), per-tenant **KMS envelope** ([15]); signed-URL, permission-gated
   access.
4. **Lifecycle:** retention policy + legal hold; **GDPR erasure via crypto-shredding** (destroy the key,
   not the sealed object); every access/transition **audit-logged (hash-chained)**.
5. **Referenced, not embedded:** `Incident.evidenceRef = { packageId, contentHash, storageUri }`
   (additive field).

## Alternatives considered

- **Embed evidence in the incident document** — rejected: bloats the store, no WORM/immutability, no
  signed-URL streaming.
- **Mutable evidence** — rejected: not court-defensible; tamper-evidence requires immutability.
- **Delete objects for GDPR** — rejected: breaks immutability; **crypto-shredding** satisfies both.
- **A new evidence service** — rejected: it is an object-store lifecycle owned by the existing Evidence
  context ([12]) + workflow/media extensions; no new service.

## Consequences

- **Positive:** auditable, tamper-evident, compliance-ready evidence; reuses tenant isolation + KMS;
  the Evidence Viewer becomes a flagship feature.
- **Cost:** WORM storage + KMS + audit adds ops weight (Phase-3 enterprise); erasure-vs-immutability
  handled by crypto-shredding.
- **Follow-ups:** Phase-2 ships **G-4 refs** (minimum for the demo); full WORM/shred/audit is Phase-3.

## Compliance

Strengthens security-by-design + multi-tenant isolation; event-driven (assembled on `incident.raised`);
API-first (signed-URL evidence API). **No frozen doc changes** — implements [12]/[15]/[18]. Proposed.
