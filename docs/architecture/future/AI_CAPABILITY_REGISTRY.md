# AI Capability Registry — Specification (Deliverable 4)

_Status: ⏳ Architect Review Pending · ADR: [ADR-0022] · Documentation-only · Extends [05-CAPABILITY-ARCHITECTURE](../05-CAPABILITY-ARCHITECTURE.md)_

> A centralized, customer-visible catalog of every AI capability the platform supports, with
> enterprise governance metadata. **This is not a new mechanism** — it **formalizes the catalog layer
> on top of the registry that already exists** (P1-6 `ai/inference` manifest-driven `CapabilityRegistry`
>
> - the `@vip/contracts` `CapabilityDescriptor` / `CapabilityRegistryRecord`). No core change now.

## What already exists (do not rebuild)

- **`CapabilityDescriptor` + `CapabilityRegistryRecord`** contracts ([05 §2–3]): id, version, kind,
  inputs/outputs, params, **model selector** (model-agnostic, ADR-0002), **resource profile**
  (accelerator + est. load), **placement** (`edge`/`cloud`), generated events, owner, description,
  dependencies, `requiredGpu`, license, **`lifecycleState` (experimental/stable/deprecated)**.
- **Manifest-driven runtime registry** (`ai/inference/manifests/*.json` → `CapabilityRegistry`):
  zero-code registration, discovery, dynamic enable/disable, lifecycle health, metrics, version
  metadata, `minConfidence`, execution providers.
- Capabilities are **model-agnostic + industry-neutral** (Law 1/2).

## The gap this closes

The runtime registry is **operational** (what's loaded, is it healthy). Enterprise needs a **catalog /
control-plane** view: a governed, versioned, customer-facing list with status, deployment modes,
hardware support, and SLAs — the thing Analysis Profiles ([ANALYSIS_PROFILES](ANALYSIS_PROFILES.md)) and
Packs ([AI_PACKS](AI_PACKS.md)) compose against, and the console surfaces.

## Directive metadata → mapping (existing vs proposed additions)

| Requested field                                    | Status                  | Source                                                                            |
| -------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| Capability Name / Category                         | ✅ exists               | `id`, `kind`                                                                      |
| Description                                        | ✅ exists               | `description`                                                                     |
| Model Name / Version                               | ✅ exists (by selector) | `models.selector` (resolved via MLflow, ADR-0002/0012)                            |
| Runtime Requirements                               | ✅ exists               | `resourceProfile`, execution providers                                            |
| Supported Input Types                              | ✅ exists               | `inputs[].type`                                                                   |
| Supported Hardware                                 | ✅ exists               | `resourceProfile.accelerator` (`gpu`/`cpu`)                                       |
| Confidence Threshold                               | ✅ exists               | manifest `minConfidence` (per-capability default; tenant-tunable)                 |
| Latency Expectations                               | ⚠️ partial              | `resourceProfile.estLoad.perStreamMs` → **add an explicit `latencyBudgetMs` SLA** |
| Status (Experimental/**Beta**/Stable/Deprecated)   | ⚠️ extend               | `lifecycleState` enum → **additively add `beta`**                                 |
| Supported Deployment Modes (Cloud/Edge/**Hybrid**) | ⚠️ extend               | `placement` (`edge`/`cloud`) → **add `hybrid`** (edge+cloud split)                |

**All additions are additive contract evolution** (new enum members, one new optional field) — no
breaking change, no repurposing (Constitution §7). Proposed for `@vip/contracts` **when built**.

## Proposed catalog shape (future contract sketch — NOT built)

```
CapabilityCatalogEntry = CapabilityRegistryRecord + {
  category: string            // human-facing grouping (e.g. "Safety", "Security", "Analytics")
  status: 'experimental'|'beta'|'stable'|'deprecated'
  deploymentModes: ('cloud'|'edge'|'hybrid')[]
  latencyBudgetMs: number     // SLA target
  supportedHardware: string[] // e.g. ["cpu","cuda","jetson-orin"]
  defaultConfidence: number
  docsUrl?: string
}
```

## Reference catalog (illustrative — capabilities are generic, not industry code)

| Capability                | Category | Status        | Modes        |
| ------------------------- | -------- | ------------- | ------------ |
| Person Detection          | Security | stable (P1-6) | cloud, edge  |
| Vehicle Detection         | Security | proposed      | cloud, edge  |
| Smoke Detection           | Safety   | proposed      | edge, hybrid |
| Fire Detection            | Safety   | proposed      | edge, hybrid |
| Crowd Detection           | Safety   | proposed      | cloud        |
| PPE Detection             | Safety   | proposed      | edge         |
| Loitering                 | Behavior | proposed      | cloud        |
| Intrusion                 | Security | proposed      | edge         |
| License Plate Recognition | Security | proposed      | cloud, edge  |

> Behavioral capabilities (loitering, intrusion) are **compositions** ([24](../24-COMPOSITION-FRAMEWORK.md))
> over primitive detections + spatial reasoning — they are capabilities, still industry-neutral.

## Integration (no core change)

- **Registration:** unchanged — a capability ships a manifest + descriptor; the catalog is the
  aggregated, governed view (a read model over registry records + a small control-plane store for
  status/SLA metadata).
- **API:** a future `GET /capabilities` catalog endpoint (Perception context / control plane); the
  console renders it read-only in Phase 2, manages status in Phase 3.
- **Consumers:** Profiles and Packs reference capabilities **by id + selector** — never by model file.
- **Adding a capability** never changes core architecture (Law 1) — exactly the frozen design intent.

## Not built now

Phase-2 surfaces the **existing** registry read-only in the console; the governed catalog +
status/SLA/deploy-mode control-plane is **Phase 3**, gated on multiple capabilities. Contract additions
(`beta`, `hybrid`, `latencyBudgetMs`) land only then.
