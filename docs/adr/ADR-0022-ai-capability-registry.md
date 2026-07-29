# ADR-0022 — AI Capability Registry (enterprise catalog)

- **Status:** Proposed
- **Date:** 2026-07-29
- **Deciders:** Principal Architect (architecture enhancement review) + development
- **Touches:** additive evolution of `CapabilityDescriptor`/`CapabilityRegistryRecord` in `@vip/contracts`; capability architecture [05]; relates to ADR-0002 (model-agnostic) / ADR-0012 (model adapter). Full spec: [future/AI_CAPABILITY_REGISTRY](../architecture/future/AI_CAPABILITY_REGISTRY.md).

## Context

P1-6 shipped a **manifest-driven runtime registry** (`ai/inference`) + the `CapabilityDescriptor` /
`CapabilityRegistryRecord` contracts — an **operational** view (what's loaded, is it healthy). Enterprise

- customers need a **governed catalog / control-plane** view: a versioned, customer-facing list of
  capabilities with status, deployment modes, hardware support, and SLAs — the thing Profiles and Packs
  compose against and the console surfaces.

## Decision

Formalize a **Capability Catalog** layer over the existing registry (not a parallel mechanism):

1. **Reuse the existing registration path** (manifest + descriptor); the catalog is the aggregated,
   governed read-model + a small control-plane store for status/SLA metadata.
2. **Additive contract evolution:** extend `lifecycleState` with **`beta`** (experimental/beta/stable/
   deprecated); extend placement/deployment with **`hybrid`**; add an optional **`latencyBudgetMs`** SLA
   and a human-facing `category`. All additive (never repurpose) per Constitution §7.
3. **Catalog API** (`GET /capabilities`, control-plane): read-only in the console (Phase 2), status/SLA
   management in Phase 3.
4. Capabilities remain **model-agnostic + industry-neutral**; the catalog references models **by
   selector** (ADR-0002), never by file/vendor.

## Alternatives considered

- **A second, parallel registry** — rejected: fragments the source of truth; extend the existing one.
- **Bake status/SLA into manifests only** — rejected: governance/status is control-plane state, not a
  static build artifact; but defaults may live in the manifest.
- **Breaking enum/field changes** — rejected: additive-only keeps long-lived consumers safe.
- **Expose models directly instead of capabilities** — rejected (ADR-0002): the capability is the stable,
  model-agnostic unit.

## Consequences

- **Positive:** one governed catalog for Profiles/Packs/console; additive evolution (no breakage);
  customer-facing capability transparency (status, hardware, SLA).
- **Cost:** a control-plane catalog store + API (Phase-3); contract additions land only when built.
- **Follow-ups:** Phase-2 surfaces the **existing** registry read-only; the governed catalog is Phase-3,
  gated on multiple capabilities.

## Compliance

Upholds Law 1/2 (neutral, model-agnostic), API-first (catalog API), observability (status/health/SLA),
extensibility (add capabilities without core change). **No frozen doc changes** — implements [05].
Proposed.
