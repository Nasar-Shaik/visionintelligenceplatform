# AI Capability Packs — Strategy (Deliverable 6)

_Status: ⏳ Architect Review Pending · Documentation-only · Formalizes [13-INDUSTRY-PACKS](../13-INDUSTRY-PACKS.md) + [20-EXTENSIBILITY](../20-EXTENSIBILITY.md); extends [ADR-0007](../../adr/ADR-0007-models-as-plugins.md)_

> A **Pack** is a versioned, entitlement-gated bundle that turns the industry-neutral core into a
> vertical solution — **without adding industry code to the core** (Law 1). Packs are **plugins**
> (`plugins/**`), which the import-graph already isolates (`noCoreToPlugin`). This formalizes the
> **packaging + distribution** strategy for the already-designed industry-pack concept.

## What already exists

- **`plugins/**` workspace layer** + import-graph rule **`noCoreToPlugin`**: the core (shared +
  services) may **never** import a plugin; plugins may use shared libs + their own SDK.
- **[13-INDUSTRY-PACKS]** designs industry packs as the vertical extension point; **[20-EXTENSIBILITY]**
  defines the plugin/extension model; **ADR-0007** makes models pluggable with a marketplace path.
- **Composition Framework** ([24]) + **capability registry** ([05]) — packs compose these.

## What a Pack contains (directive fields → mechanism)

| Pack element    | Mechanism (reuses existing)                                                   |
| --------------- | ----------------------------------------------------------------------------- |
| AI capabilities | capability manifests + descriptors ([05]); model providers (ADR-0007)         |
| Rules           | rule contracts ([10]) shipped as templates (instantiated per tenant)          |
| Incidents       | incident types/titles/severity mappings (workflow config)                     |
| Alerts          | notification channel + template presets (notify config)                       |
| Dashboards      | console dashboard definitions (declarative widgets over existing read models) |
| Reports         | report definitions (Phase-3 analytics)                                        |

## Packaging strategy

```
Pack = signed, versioned bundle
  manifest.json         # id, version, entitlement sku, dependencies (core version range), capabilities
  capabilities/         # capability manifests + descriptors + model selectors
  profiles/             # Analysis Profiles (bundles of the above)
  rules/                # rule templates
  incidents/ alerts/    # type + template presets
  dashboards/ reports/  # declarative definitions
```

- **Distribution:** a Pack is a plugin package; installed per-deployment, **enabled per-tenant via
  entitlements** (Phase-3 billing/entitlements). Certified via the **plugin certification gate**
  (ADR-0015 — contract tests + boundary checks) before it can load.
- **Isolation:** a Pack **cannot reach into service internals** (import-graph enforced); it interacts
  only through contracts, events, and extension points ([20]).
- **Versioning:** semver; a Pack declares a **core version range** it supports (Constitution §7).

## Pack catalog (illustrative)

| Pack                   | Contains                                                                      | Phase                                        |
| ---------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| **VIP Core**           | person detection + base rules/incidents/alerts + General Surveillance profile | ships with the platform (Phase 1–2 baseline) |
| Retail Intelligence    | loitering, intrusion, crowd + retail profiles/rules/dashboards                | Phase 3 (first vertical)                     |
| Warehouse Intelligence | ppe, vehicle, safety-zone + warehouse profiles                                | Phase 3                                      |
| Hospital Intelligence  | wandering, restricted-area, crowd                                             | Phase 3                                      |
| School Intelligence    | perimeter, intrusion, occupancy                                               | Phase 3                                      |
| Factory Intelligence   | ppe, smoke, fire, machine-zone                                                | Phase 3                                      |

> **Explicitly out of scope now** (per the productization non-goals): retail/shoplifting/cashier
> intelligence, face recognition. Packs are the _future home_ for verticals, not a Phase-2 build.

## Compliance

Upholds **Law 1** (industry-neutral core), **loose coupling** (packs via contracts/events only),
**API-first** (packs consume public APIs), **multi-tenant** (entitlement-gated per tenant). Adds **no**
new bounded context — a Pack is a plugin, not a service.

## Not built now

**Phase 3**, triggered by the first vertical customer. **VIP Core** (the baseline capability + rules
already shipped) is the only "pack" the current platform needs; formal Pack packaging is documented and
deferred.
