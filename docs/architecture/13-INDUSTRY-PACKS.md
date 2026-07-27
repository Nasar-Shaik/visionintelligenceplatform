# 13 — Industry Packs (Plugins)

## Purpose

Define the plugin model that keeps the core generic (Law 1). An **Industry Pack** is how a vertical (Retail, Hospital, School, Warehouse, Bank, Smart City, Parking, …) is delivered — as **configuration and templates**, never as core code.

## Responsibilities

- Define exactly what a pack may and may not contribute.
- Define pack packaging, installation, versioning, and isolation.
- Guarantee the core builds/ships/tests correctly with all packs removed.

---

## 1. What a pack contributes (and only this)

An Industry Pack contributes **declarative artifacts** on top of the core capabilities:

| Contribution              | Mechanism                                                       | Core equivalent                                                 |
| ------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| **Rules**                 | Rule Pack (DSL templates)                                       | [10-RULE-ENGINE](10-RULE-ENGINE.md)                             |
| **Workflows**             | Workflow templates                                              | [11-WORKFLOW-ENGINE](11-WORKFLOW-ENGINE.md)                     |
| **Dashboards**            | Dashboard/widget definitions                                    | [16](16-OBSERVABILITY.md)/console                               |
| **Reports**               | Report definitions/schedules                                    | [analytics]                                                     |
| **Policies**              | Retention, privacy, escalation, access policies                 | [06](06-MULTI-TENANT-SAAS.md)/[15](15-SECURITY-ARCHITECTURE.md) |
| **Templates**             | Zones/lines presets, onboarding wizards, notification templates | [10](10-RULE-ENGINE.md)                                         |
| **Capability enablement** | Declares which existing capabilities it needs                   | [05](05-CAPABILITY-ARCHITECTURE.md)                             |

**A pack must NOT:**

- Contain or duplicate AI/perception logic (it _references_ capabilities; it never re-implements detection).
- Add branches to the core or be imported by the core.
- Depend on another pack.
- Bypass entitlements, tenancy, or the contract boundary.

> **The test for correctness:** delete every folder under `plugins/` → the platform still builds, tests green, and runs as a generic vision-intelligence engine. Re-add a pack → a vertical solution appears, with zero core diff.

## 2. Pack manifest

```yaml
pack:
  id: retail
  version: 1.4.0
  platformApi: '>=1.0 <2.0' # refuses to load outside this range
  requiresCapabilities: # references, not implementations
    - perception.person-detection
    - perception.tracking
    - spatial.zone-detection
    - spatial.line-crossing
    - object.left-removed
    - recognition.ocr # for POS correlation
  provides:
    rulePacks: [loss-prevention, queue-sla, after-hours]
    workflows: [lp-review, queue-response]
    dashboards: [store-ops, executive-rollup]
    reports: [footfall-conversion, shrink-weekly]
    policies: [retail-retention, retail-privacy]
    templates: [checkout-zones, entrance-lines]
  entitlement: pack.retail # gated by plan/subscription
```

## 3. Installation & lifecycle

- Packs are discovered by the **Plugin Registry** ([20](20-EXTENSIBILITY.md)) and installed **per tenant** (entitlement-gated). Installing seeds tunable rules/workflows/dashboards/reports/policies into the tenant's space; the tenant then customizes.
- Packs are **versioned**; upgrades are additive/migratable and never silently overwrite tenant customizations (seed vs. override tracked).
- The loader validates `platformApi` compatibility and required-capability availability before enabling; incompatible packs are refused, not crashed.

## 4. Isolation & trust

- Packs run within the platform's contract boundary; declarative artifacts are sandboxed (DSL, not code). Any pack that needs to ship a **new capability** (e.g. a novel detector) does so through the capability extension flow ([05 §6](05-CAPABILITY-ARCHITECTURE.md)) under a **trust tier** (first-party / verified-partner / community), with review and signing. → [20](20-EXTENSIBILITY.md)

## 5. Example packs (illustrative, all declarative)

- **Retail/Supermarket**: loss-prevention rules (concealment + no-POS-scan), queue-SLA, shelf-OOS; store-ops dashboard; shrink/footfall/conversion reports.
- **Hospital**: fall-response workflow, restricted-area, hygiene-compliance rules; ward-occupancy dashboard; HIPAA-aware privacy policy (pose-only mode default).
- **School**: perimeter/intruder, weapon-escalation, crowd-safety rules; campus-security dashboard; FR-off-by-default privacy policy.
- **Warehouse/Construction**: PPE-compliance, forklift-pedestrian proximity, danger-zone rules; safety dashboard; compliance reports.
- **Bank**: weapon-escalation, tailgating, casing/loitering, mask-at-entry policy rules; high-security console; SOC integration policy.
- **Smart City/Parking**: LPR watchlist, traffic/queue analytics, slot-occupancy rules; city-ops dashboard.

All reuse the **same** core capabilities; they differ only in rules/workflows/dashboards/reports/policies/templates.

## Design decisions

- **Declarative-only packs** are the enforcement mechanism for Law 1 — vertical velocity without core entropy.
- **Manifest-declared capability dependencies** let the loader verify a pack can actually run before enabling it.
- **Seed-vs-override tracking** lets packs upgrade without destroying tenant customization.

## Advantages

- New verticals ship in days as configuration; the core stays lean and universally testable.
- Partners/OEMs can author and sell packs via the marketplace.
- One bug fix in a core capability benefits every vertical at once.

## Tradeoffs

- Requires rich, expressive declarative surfaces (rules/workflows/dashboards/reports as data) up front; this investment is precisely what buys the "unlimited solutions" property.

## Future expansion

- Pack marketplace with revenue share; certified-partner trust tier; pack analytics (which templates perform); cross-industry template libraries.

## Cross-references

[00-ENGINEERING-CONSTITUTION](../00-ENGINEERING-CONSTITUTION.md) · [05-CAPABILITY-ARCHITECTURE](05-CAPABILITY-ARCHITECTURE.md) · [10-RULE-ENGINE](10-RULE-ENGINE.md) · [11-WORKFLOW-ENGINE](11-WORKFLOW-ENGINE.md) · [20-EXTENSIBILITY](20-EXTENSIBILITY.md)
