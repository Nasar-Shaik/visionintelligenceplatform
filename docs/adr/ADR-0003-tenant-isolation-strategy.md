# ADR-0003 — Pooled-default / siloed-optional tenant isolation

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Architecture, Security
- **Touches:** Law 5; docs/architecture/06, 15, 18

## Context

The platform serves SMB self-serve tenants (cost-sensitive, high density) and regulated enterprise tenants (bank/hospital/government) demanding hard isolation and data residency. A single isolation model cannot optimally serve both.

## Decision

We will support three isolation modes on **one schema**: **Pooled** (default — shared cluster, row-level `tenantId` enforced at the data layer, fail-closed), **Siloed** (dedicated DB/cluster per enterprise/regulated tenant), and **Edge-local** (edge box bound to one tenant, encrypted). Isolation is enforced at every layer (context/data/storage/stream/compute/search/network), not by convention, and validated by negative cross-tenant tests.

## Alternatives considered

- **Pooled only.** Cheapest; but loses regulated/residency deals and concentrates blast radius. Rejected as sole option.
- **Siloed only.** Strongest isolation; but per-tenant cost/ops kills SMB economics. Rejected as sole option.

## Consequences

- Positive: cost-efficient density with an enterprise upgrade path; residency support; provable isolation.
- Negative/cost: resolver/routing complexity; siloed mode raises ops cost (reserved for plans that justify it).
- Follow-ups: automated cross-tenant access tests on every endpoint/stream are a standing gate; per-tenant KMS keys mandatory.

## Compliance

Implements Law 5. Data-layer enforcement (query without tenant context throws) is mandatory across all services.
