# ADR-0014 — Hierarchical configuration inheritance

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Final Architecture Enhancement (v1.0)
- **Touches:** Principle 8; docs/architecture/06

## Context

[06 §6](../architecture/06-MULTI-TENANT-SAAS.md) established layered config (platform→tenant→branch/site→camera). Real deployments need a **deeper, well-defined inheritance chain** — down to capability, model, rule, and workflow — with deterministic conflict resolution, versioning, audit, and rollback, so a global default can be overridden precisely at any level without copy-paste.

## Decision

Adopt a full **configuration hierarchy** with inheritance: `Global → Platform → Tenant → Organization → Region → Country → Branch → Site → Building → Floor → Zone → Camera → Capability → Model → Rule → Workflow`. A child inherits its parent's effective config; **only overridden keys change** (sparse overrides). Conflicts resolve by **most-specific-wins**; every effective value is traceable to its source level, versioned, audited, and rollback-able.

## Alternatives considered

- **Shallow config (status quo).** Fine for small tenants; but forces duplication and error at deep hierarchies. Rejected.
- **Full config copied per node.** Simple reads; but unmaintainable and drift-prone. Rejected in favor of sparse inheritance.

## Consequences

- Positive: set-once-inherit-everywhere; precise overrides; auditable effective config; safe rollback.
- Negative/cost: a resolver that computes effective config across the chain (cached) and records provenance.
- Follow-ups: [06 §6](../architecture/06-MULTI-TENANT-SAAS.md) expanded with inheritance rules; config is Control-Plane owned and pushed/cached to the Data Plane ([27](../architecture/27-CONTROL-DATA-PLANE.md)).

## Compliance

Extends 12-factor config (Principle 8); no philosophy change.
