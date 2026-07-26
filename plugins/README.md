# plugins/ — Industry Packs & Capability Plugins

**This is the only place industry/customer/vertical logic may exist** (Law 1). The core (`services/`, `ai/`, `edge/`, `packages/`) must build, test, and run correctly with this entire directory deleted.

## What a plugin may contain
- **Industry Packs** — declarative only: rule templates, workflow templates, dashboards, reports, policies, zone/line templates, notification templates, onboarding wizards. **No AI code, no core branches.** ([13-INDUSTRY-PACKS](../docs/architecture/13-INDUSTRY-PACKS.md))
- **Capability plugins** — new capabilities/channels/integrations via declared extension points, under a **trust tier** (first-party / verified-partner / community), signed. ([20-EXTENSIBILITY](../docs/architecture/20-EXTENSIBILITY.md))

## Layout (illustrative; each pack is self-contained)
```
retail/        rules/ workflows/ dashboards/ reports/ policies/ templates/ manifest.yaml
hospital/      (declarative only; HIPAA-aware privacy policy, pose-only default)
warehouse/     construction/  bank/  school/  smart-city/  parking/  ...
channels/      Notification-channel plugins (e.g. custom webhook targets)
integrations/  POS / access-control / SIEM / VMS connectors (via extension points)
```

## Hard rules
- A plugin **must not** be imported by the core, depend on another plugin, or bypass entitlements/tenancy/contracts.
- Every plugin ships a `manifest.yaml` declaring `platformApi` range, required capabilities, provided artifacts, and entitlement.
- **Gate:** `rm -rf plugins/* && build && test` must stay green (milestone M13).

See [13-INDUSTRY-PACKS](../docs/architecture/13-INDUSTRY-PACKS.md) and [20-EXTENSIBILITY](../docs/architecture/20-EXTENSIBILITY.md).
