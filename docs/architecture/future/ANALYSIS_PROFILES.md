# Analysis Profiles — Specification (Deliverable 5)

_Status: ⏳ Architect Review Pending · ADR: [ADR-0021] · Documentation-only · Builds on [24-COMPOSITION-FRAMEWORK](../24-COMPOSITION-FRAMEWORK.md) + [10-RULE-ENGINE](../10-RULE-ENGINE.md)_

> Customers should select an **outcome** ("Retail Security"), not wire up individual AI models. An
> **Analysis Profile** is a named, tenant-selectable bundle that resolves to a set of capability
> activations, rule templates, and config overrides — applied per site/camera/zone. It is
> **configuration and composition, not a new service**.

## What already exists

- **Capabilities** (model-agnostic, industry-neutral) + the **Composition Framework** ([24]) that
  combines primitive capabilities into higher-order behaviors.
- **Rules** ([10], P1-7): versioned, lifecycle-managed, tenant-scoped, priority-ordered, over the
  `EventEnvelope`; `severity` + `EventPriority`; per-rule confidence via predicates.
- **Hierarchical configuration** (ADR-0014): org → site → camera config inheritance.

## What a profile defines (directive fields → mechanism)

| Profile field                 | Resolves to                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Enabled AI capabilities       | a set of **capability ids + selectors** activated for the target scope               |
| Processing rules              | a bundle of **rule templates** (existing rule contracts) instantiated for the tenant |
| Event priorities              | `EventPriority` / rule `severity` overrides                                          |
| Default confidence thresholds | per-capability `minConfidence` overrides (tenant config, ADR-0014)                   |
| Performance optimizations     | frame rate / sampling / placement hints (edge vs cloud), batch settings              |

## Proposed shape (future contract sketch — NOT built)

```
AnalysisProfile = {
  id, tenantId?, name, description,
  capabilities: { capabilityId, selector?, minConfidence?, sampleRate? }[],
  ruleTemplates: RuleTemplateRef[],      // instantiate existing Rule contracts
  eventPriorityOverrides: { eventType, priority }[],
  performance: { placement?: 'edge'|'cloud'|'hybrid', maxFps?, batch?: number },
  status: 'experimental'|'beta'|'stable'|'deprecated',
}
```

Profiles are **tenant configuration** (a control-plane record), not code. System profiles ship as
defaults; tenants may clone/customize (ADR-0014 inheritance).

## Example profiles (illustrative)

| Profile              | Capabilities (by id)         | Notes                                  |
| -------------------- | ---------------------------- | -------------------------------------- |
| General Surveillance | person, vehicle detection    | broad, low-noise defaults              |
| Retail Security      | person, loitering, intrusion | after-hours + zone rules               |
| Warehouse Safety     | ppe, person, vehicle         | PPE-required zones, forklift proximity |
| School Monitoring    | person, intrusion, crowd     | perimeter + occupancy                  |
| Hospital Monitoring  | person, loitering, crowd     | restricted-area + wandering            |
| Industrial Safety    | ppe, smoke, fire, intrusion  | edge-first, critical severity          |

> These are **bundles of generic capabilities + rules** — the industry meaning lives in the profile
> (config) and, for deeper verticals, in a **Pack** ([AI_PACKS](AI_PACKS.md)). The core stays neutral.

## Integration with the AI Runtime (no core change)

```
Profile (config)  ──resolve──▶  { capability activations, rule instances, thresholds, placement }
        │                                   │
   applied per scope (org/site/camera)      ├─▶ capability runtime: which capabilities run + at what confidence/fps
   via ADR-0014 config inheritance          └─▶ rule engine: which rules are enabled + their severity
```

- **Runtime unchanged:** the runtime already binds capabilities by selector and runs enabled ones;
  a profile just supplies the **activation set + thresholds** for a scope.
- **Rule engine unchanged:** a profile instantiates existing rule contracts (versioned/audited as
  today); no new evaluation path.
- **Selection is a control-plane action** (assign a profile to a site/camera) surfaced in the console
  (Camera Management / Recorded Analysis "Select Analysis Profile").

## Not built now

Requires ≥ 2 capabilities to be meaningful. **Phase 3.** The P2-1 "Select Analysis Profile" step can
launch with a **single built-in "General Surveillance" profile** (the current person-detection
capability + a default rule) so the console workflow is complete without the full profile system.
