# 15 — Security Architecture

## Purpose

Define enterprise security: authentication, authorization, encryption, secrets, key rotation, audit, privacy, and compliance (GDPR/HIPAA/SOC 2/ISO 27001). Operationalizes Law 5 (secure & isolated by default).

## Responsibilities

- Provide platform-wide authN/Z, encryption, secrets, and audit.
- Enforce privacy-by-design and regulatory compliance postures.
- Make tenant isolation structurally provable.

---

## 1. Authentication

- **OAuth2 / OIDC** for user auth; **JWT** access (short-lived) + rotating refresh with **reuse detection**; **MFA**; **SSO (SAML/OIDC) + SCIM** provisioning for enterprise; **passkeys** (roadmap).
- **Machine auth**: scoped, rate-limited, IP-allowlisted **API keys**; **mTLS** for service-to-service and edge↔cloud; short-lived **signed URLs** for media/evidence.
- Mobile: secure token storage + biometric unlock; device/session management and revocation.

## 2. Authorization (RBAC + ABAC)

- **RBAC**: `resource:action[:scope]` permissions bound to roles; **scopes** `own→zone→site→branch→region→tenant→global`.
- **ABAC** refines RBAC with attributes: time-of-day, camera sensitivity, **reason-for-access**, jurisdiction, data classification. Regulated actions (face-recognition query, evidence export, enrollment) require attribute checks.
- Central policy module (`packages/permissions`) reused by every service; fail-closed; policy decisions on sensitive actions are audited. Row-level `tenantId` filtering is applied at the data layer beneath authorization.

## 3. Encryption

- **In transit**: TLS 1.3 everywhere; SRTP/DTLS for WebRTC; mTLS edge↔cloud and service↔service.
- **At rest**: AES-256 for OLTP, object storage, search, and edge local storage; **per-tenant KMS data keys** (envelope encryption) for clips/PII; **field-level encryption** for the most sensitive attributes (face embeddings, plates, credentials).

## 4. Secrets & key management

- **Application/deployment secrets** come from the **environment** (`.env` in dev; orchestrator-injected in prod), loaded and validated by `@vip/config` — no secrets in code or images (12-factor). **No external secret manager is required** for the default self-hosted deployment ([ADR-0018](../adr/ADR-0018-env-only-secrets-and-centralized-config.md)); Vault / cloud secret managers / Kubernetes Secrets are **optional** enterprise extension points (populate the process environment; loaders are unchanged).
- **Data-protection keys** are a separate concern: per-tenant **KMS data keys** (envelope encryption for evidence/PII), edge device certs, and camera/connector credential vaulting — with automatic **key rotation**. Signed, hardened container images.

## 5. Audit logs

- Immutable, **append-only, hash-chained** (tamper-evident) audit of every sensitive action: media/evidence access + export, rule/workflow changes, enrollment (face/plate), permission changes, config, logins, admin actions. Tenant-scoped, exportable, and **streamable to SIEM**. → [11 §8](11-WORKFLOW-ENGINE.md), [16](16-OBSERVABILITY.md)

## 6. Privacy by design

- **On-device face/plate blurring** for non-consented subjects; **pose-only / anonymized modes** (no RGB retained) for sensitive areas (hospitals).
- **Consent management** for enrollment/face-recognition; **permanent privacy masking** zones (restrooms, neighboring property).
- **Data minimization**: store events/evidence, not continuous video; automatic expiry.
- **Purpose limitation & reason-for-access** prompts with logging.

## 7. Compliance

- **GDPR**: lawful basis + consent records; **DSAR** (access/export/erasure) tooling; right-to-erasure with irreversible anonymization that preserves audit integrity; **data residency** (regional data planes); DPA templates; processor/sub-processor register; breach-notification workflow.
- **HIPAA-aware** (hospitals): BAA support; PHI minimization (pose-only where possible); strict access + audit; on-prem/hybrid to keep video on-site; configurable retention; workforce access reviews.
- **SOC 2 / ISO 27001**: control mapping, change management, least-privilege, monitoring, vendor management, incident response; evidence collection automated where possible.
- **Jurisdictional gating** for face-recognition/LPR (restricted in some regions) — enforced by ABAC + entitlements.

## 8. Platform security (hardening)

- SAST/DAST, dependency + image scanning, secret scanning (gitleaks) in CI; WAF + rate limiting at the gateway; network segmentation (camera VLANs on-prem); pen-testing + remediation; non-root/distroless containers; signed edge images + remote wipe.

## 9. Tenant isolation (security view)

- Isolation enforced at context → data → storage → stream → compute → search → network layers ([06 §2](06-MULTI-TENANT-SAAS.md)). **Negative testing**: automated cross-tenant access attempts on every endpoint/stream must fail-closed (in [tests/isolation](../../tests/)). Per-tenant KMS keys mean even storage-layer access cannot cross tenants.

## Design decisions

- **Isolation and privacy are contract-level, data-layer defaults**, not features — leaks become structurally hard.
- **Hash-chained audit + reason-for-access** gives the defensibility regulated buyers require.
- **ABAC on top of RBAC** cleanly expresses jurisdictional and sensitivity constraints without vertical code.

## Advantages

- One security model serves SMB self-serve through bank/hospital/government.
- Compliance postures are configuration/policy, largely reusable across tenants and packs.

## Tradeoffs

- Per-tenant KMS, field-level encryption, and tamper-evident audit add overhead and key-management complexity; justified by the target markets and non-negotiable for trust.

## Future expansion

- Confidential computing for inference; customer-managed keys (BYOK); zero-trust service mesh; automated compliance-evidence dashboards; differential-privacy analytics for smart-city.

## Cross-references

[06-MULTI-TENANT-SAAS](06-MULTI-TENANT-SAAS.md) · [11-WORKFLOW-ENGINE](11-WORKFLOW-ENGINE.md) · [12-EVIDENCE-MANAGEMENT](12-EVIDENCE-MANAGEMENT.md) · [16-OBSERVABILITY](16-OBSERVABILITY.md) · [21-API-ARCHITECTURE](21-API-ARCHITECTURE.md)
