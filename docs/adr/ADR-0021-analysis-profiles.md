# ADR-0021 — Analysis Profiles

- **Status:** Proposed
- **Date:** 2026-07-29
- **Deciders:** Principal Architect (architecture enhancement review) + development
- **Touches:** a new control-plane config shape (`AnalysisProfile`); composition [24], rule engine [10], config inheritance (ADR-0014). Full spec: [future/ANALYSIS_PROFILES](../architecture/future/ANALYSIS_PROFILES.md).

## Context

Customers should choose an **outcome** ("Retail Security"), not wire individual AI models. There is no
first-class way to bundle capability activations + rules + thresholds into a selectable unit; today a
tenant would configure capabilities and rules piecemeal.

## Decision

Introduce **Analysis Profiles** as **tenant configuration** (a control-plane record), not code:

1. A profile defines **enabled capabilities** (by id + selector), **rule templates** (existing rule
   contracts), **event-priority overrides**, **default confidence thresholds**, and **performance
   settings** (placement/fps/batch).
2. Profiles are **assigned to a scope** (org/site/camera) and resolved via the existing **hierarchical
   config inheritance** (ADR-0014).
3. **Resolution** produces a capability-activation set + rule instances + thresholds for the runtime and
   rule engine — **both unchanged**; a profile only supplies _what to run and at what confidence_.
4. System profiles ship as defaults; tenants may clone/customize.

## Alternatives considered

- **Expose raw models/capabilities to customers** — rejected: poor UX, leaks model concerns, no bundling.
- **A profiles microservice** — rejected: profiles are config + composition, not a bounded context; no
  new service.
- **Bake profiles into Packs only** — partially: Packs _ship_ profiles, but profiles must also be
  first-class tenant config independent of a vertical Pack (General Surveillance needs no Pack).
- **Hardcode industry logic in the core** — rejected (Law 1): profiles stay generic; deep vertical
  semantics live in Packs (plugins).

## Consequences

- **Positive:** one-click outcome selection; per-tenant tuning via existing config inheritance; the core
  stays industry-neutral; the runtime/rule engine are unchanged.
- **Cost:** a control-plane profile store + resolver (Phase-3); requires ≥ 2 capabilities to be useful.
- **Follow-ups:** P2-1 can launch with a single built-in **General Surveillance** profile so the
  "Select Analysis Profile" UX is complete before the full system exists.

## Compliance

Upholds Law 1 (neutral core), multi-tenant (per-tenant profiles), API-first, loose coupling (config, not
new coupling). **No frozen doc changes** — implements [24]/[10]/ADR-0014. Proposed.
