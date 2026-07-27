# 20 — Extensibility & Plugin SDK

## Purpose

Define the extension mechanisms that let the platform absorb future capabilities, models, sensors, devices, and industries **without core changes**: plugin architecture, extension points, interfaces, events, hooks, dependency injection, and version compatibility. Operationalizes Principle 14 (extensible).

## Responsibilities

- Define the plugin model, extension-point catalog, hook system, DI, and the Plugin SDK.
- Guarantee forward/backward compatibility and safe loading of third-party extensions.

---

## 1. What can be extended

Everything that plausibly varies over a decade:

- **Capabilities** — new perception/spatial/reasoning building blocks ([05](05-CAPABILITY-ARCHITECTURE.md)).
- **Models & runtimes** — new model families, accelerators (via the registry, [08](08-AI-ML-PLATFORM.md)).
- **Sensors/devices** — new media sources (audio/thermal/radar/LiDAR/IoT) as media capabilities.
- **Rule primitives & actions** — new conditions/expressions/actions ([10](10-RULE-ENGINE.md)).
- **Workflow states/actions** — new transitions, approvals, action types ([11](11-WORKFLOW-ENGINE.md)).
- **Notification channels** — new delivery integrations ([11 §4](11-WORKFLOW-ENGINE.md)).
- **Industry Packs** — verticals as declarative bundles ([13](13-INDUSTRY-PACKS.md)).
- **Integrations** — POS, access control, SIEM, VMS, ITSM.

## 2. Extension points & hooks

- **Extension points** are declared, versioned interfaces the core exposes (e.g. `capability.provider`, `composition.provider`, `model.provider`, `connector.provider`, `rule.condition`, `rule.action`, `workflow.state`, `workflow.action`, `notification.channel`, `media.source`, `event.enricher`, `report.generator`). Plugins **implement** them; the core **discovers** them via the registry. Key additions from the Enterprise Architecture Review: **`model.provider`** (models as plugins → [08 §8](08-AI-ML-PLATFORM.md), [ADR-0007](../adr/ADR-0007-models-as-plugins.md)), **`composition.provider`** (reusable business compositions → [24](24-COMPOSITION-FRAMEWORK.md), [ADR-0006](../adr/ADR-0006-composition-layer.md)), and **`connector.provider`** (external-system integration → [25](25-CONNECTOR-PLATFORM.md), [ADR-0008](../adr/ADR-0008-connector-platform.md)).
- **Hooks** are lifecycle callbacks the core invokes at defined moments (e.g. `onEventPersisted`, `onIncidentRaised`, `beforeEvidenceExport`, `onEdgeSync`). Hooks are for enrichment/observation and must be **side-effect-bounded** (no blocking the hot path; async where possible).
- Extension points and hooks are **contracts** in `packages/contracts` — versioned, additive, documented.

## 3. Interfaces & dependency injection

- Plugins receive core services (event bus publish, registry read, storage, notification, logging) only through **injected interfaces** — never by importing core internals. DI enforces the dependency direction (plugin → core) and enables testing plugins in isolation with mocks.
- Capability implementations are resolved by DI from the registry, so any conforming implementation is substitutable.

## 4. Events as an extension surface

- Because everything meaningful is an event ([09](09-EVENT-PLATFORM.md)), the lowest-friction extension is a **new event consumer**: a plugin subscribes to event types and reacts, with zero change to producers. New event **producers** (a new capability/sensor) likewise attach without touching consumers.

## 5. Plugin SDK & packaging

- The **Plugin SDK** (`packages/plugin-sdk`) provides the typed interfaces, a manifest schema, a local test harness, and codegen from contracts. A plugin ships: a **manifest** (id, version, `platformApi` range, declared extension points, required capabilities/entitlements — see [13 §2](13-INDUSTRY-PACKS.md)), its declarative artifacts and/or capability implementations, and tests.
- The **Plugin Registry** (`services/registry`) validates the manifest, checks `platformApi` compatibility and capability availability, verifies signature/trust tier, and enables the plugin per tenant.

## 6. Trust tiers & safety

- **First-party** (built by us), **verified-partner** (reviewed + signed), **community** (sandboxed, restricted permissions). Declarative-only plugins (rules/workflows/dashboards) are inherently sandboxed. Code-bearing plugins (new capabilities/channels) run under resource limits and permission scoping; the loader refuses unsigned or incompatible plugins rather than failing at runtime.

## 6a. Plugin certification ([ADR-0015](../adr/ADR-0015-contract-testing-and-plugin-certification.md))

A plugin is **production-enabled only after passing certification** — a pipeline that yields a signed certificate bound to a platform-API range and trust tier. Certification checks:

- **Compatibility** (platform-API range) · **API compliance** · **capability compliance** (satisfies its declared contracts).
- **Security** (scan, no secret exfiltration, permission scope) · **version compatibility**.
- **Performance & resource budgets** — latency, **memory**, **CPU**, **GPU** within declared `resource_profile`.
- **Documentation** · **testing** (contract + unit) · **observability** (emits metrics/traces/logs) · **health checks**.

Only **certified** plugins run in production; uncertified/community plugins are limited to sandboxed/dev environments. Certification results are recorded in the Plugin Registry ([23](23-SERVICE-OWNERSHIP.md)) and re-run on new plugin/platform versions. Certification builds on **contract testing** ([03](03-ARCHITECTURE-PRINCIPLES.md)) — contract validation is a prerequisite, certification adds the security/performance/ops bar.

## 7. Version compatibility

- **Platform API** is semver'd; plugins declare a compatible range and are refused outside it (no silent breakage).
- **Contracts** are additive within a major; consumers tolerate unknown additive fields. Breaking changes → new major + ADR + deprecation window ([00 §7](../00-ENGINEERING-CONSTITUTION.md)).
- The registry can run multiple plugin versions and roll back a plugin per tenant.

## Design decisions

- **Extension points + DI + events** together let third parties extend every layer without ever importing core internals — the structural guarantee behind "future-proof."
- **Manifest-declared compatibility + trust tiers** make an open ecosystem safe for regulated customers.

## Advantages

- New capability, model, sensor, channel, or industry = a plugin, not a fork.
- Enables a marketplace and partner ecosystem without compromising the core.

## Tradeoffs

- A real SDK, registry, DI, and trust/sandboxing model is significant up-front engineering; it is the direct implementation of the platform's core promise and is non-optional.

## Future expansion

- Public marketplace with revenue share; WASM-sandboxed community capabilities; plugin analytics; automated compatibility testing of submitted plugins in CI.

## Cross-references

[05-CAPABILITY-ARCHITECTURE](05-CAPABILITY-ARCHITECTURE.md) · [09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [10-RULE-ENGINE](10-RULE-ENGINE.md) · [11-WORKFLOW-ENGINE](11-WORKFLOW-ENGINE.md) · [13-INDUSTRY-PACKS](13-INDUSTRY-PACKS.md)
