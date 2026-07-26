# 10 — Rule Engine

## Purpose
Define the enterprise Rule Engine: the declarative system by which **tenants (and Industry Packs) decide what matters** — without code. Operationalizes Law 3 (rule-driven) and is the primary mechanism that keeps industry logic out of the core (Law 1).

## Responsibilities
- Own the **Rule DSL**, the no-code **Rule Builder**, and the deterministic **evaluator**.
- Support conditions/expressions, scheduling, windows, zones, temporal & spatial logic, thresholds, confidence, and actions.
- Support reusable and industry **Rule Packs**, versioning, dry-run, and scoping.

---

## 1. Rule model — IF / WHEN / THEN

```
IF    <trigger>            (event pattern, AND/OR/NOT nested, sequences)
WHEN  <context filters>    (time/schedule, zone, identity, count, camera scope)
THEN  <actions>            (raise incident, extract evidence, notify, webhook, …)
```

A rule is **data** (stored, versioned, scoped), compiled to a fast condition tree. Rules subscribe to the Event Platform and emit outcomes (typically `incident.candidate` or aggregate/log actions). Rules **never** contain industry names — "shoplifting" is a *rule someone authored*, not a rule type.

## 2. Rule DSL

A safe, declarative DSL (authored via the builder, serialized to JSON; also hand-writable/versionable). Illustrative:

```yaml
rule: "restricted-area-after-hours"
scope: { branchId: "*", zoneId: "server-room" }
if:
  all:
    - event: spatial.zone.entered
      where: { subject.class: person }
    - not: { event: recognition.face.matched, where: { group: employees } }
when:
  schedule: { between: "20:00-06:00", tz: "site" }
then:
  - raise_incident: { severity: high, type: "unauthorized-access" }
  - extract_evidence: { pre: 10s, post: 20s }
  - notify: { policy: "security-escalation" }
  - escalate_if_unacked: { after: 3m }
```

The DSL is the contract; the builder is one authoring surface over it. Plugins ship DSL templates.

## 3. Conditions & expressions

- **Object/behavior triggers**: any event type (person/vehicle/fire/weapon detected, dwell exceeded, line crossed, ppe missing, plate read/matched, face matched/unknown, anomaly, speed > X).
- **Expressions** over event fields and attributes (comparisons, arithmetic, set membership, string/regex on OCR/plate), evaluated in a sandbox (no arbitrary code).
- **Composite logic**: AND/OR/NOT, nested groups.

## 4. Temporal rules

- **Windows**: sliding/tumbling time windows ("count in zone > N within 5 min").
- **Sequences**: "A then B within T" (e.g. entered-zone then removed-object within 30s).
- **Dwell/duration**: state maintained per subject/track.
- **Cooldown/suppression**: don't re-fire within T; debounce ongoing behavior into one incident.
- Stateful conditions tracked in Redis, keyed by tenant/scope/subject; deterministic and bounded.

## 5. Spatial rules

- **Zones/ROIs & lines** drawn on the camera image (polygon/line editor), named, versioned. Triggers: enters/exits/inside zone, crosses line + direction.
- **Occupancy/threshold** per zone; **speed** via homography calibration; **proximity** (e.g. person↔forklift) between tracked subjects.

## 6. Threshold & confidence rules

- **Threshold**: count/occupancy/queue-length/speed > configurable value.
- **Confidence gating**: only act above a (per-rule, per-capability) confidence; supports **two-stage confirmation** (act only after secondary verifier confirms). Prevents false-alarm fatigue.

## 7. Actions (THEN)

`raise_incident(severity,type)` · `extract_evidence(pre,post)` · `notify(policy|channel,recipients)` · `escalate_if_unacked(after)` · `webhook(url, signed)` · `trigger_ptz(preset)` · `activate_relay/siren` (edge I/O) · `add_to_case` · `emit_event(type)` · `suppress(for)` · `log_analytics(metric)`. Actions are themselves capabilities/plugin-extensible.

## 8. Rule Builder (no-code)

- **Canvas** with draggable **condition** and **action** blocks, visual wiring, live validation.
- **Zone/line editor** overlaid on the live/recorded camera image.
- **Dry-run**: test a rule against recorded footage / replayed events to preview trigger rate and false-positive rate **before** enabling. → [09 §8 replay](09-EVENT-PLATFORM.md)
- **Templates**: prefilled rules from Industry Packs; clone-and-tune.
- **Versioning & audit** of every rule change; **scoping** to tenant/branch/site/zone/camera-group.

## 9. Reusable & Industry Rule Packs

- A **Rule Pack** is a named, versioned bundle of rule templates + zones + thresholds, shipped by an Industry Pack ([13](13-INDUSTRY-PACKS.md)) or the platform. Installing a pack seeds tunable rules; it adds **no code**.
- Packs are the vehicle by which "retail loss prevention" or "hospital fall response" is delivered — as **configuration**, honoring Law 1.

## 10. Evaluator

- Rules compiled to condition trees; evaluated per event with stateful operators in Redis; scoped and tenant-isolated; horizontally scalable (partitioned by tenant/camera). Deterministic and unit-testable; every rule change is versioned and dry-runnable.

## Design decisions
- **DSL as the contract, builder as a view** keeps power users, APIs, and plugins first-class alongside the no-code UI.
- **Dry-run over replayed events** turns rule authoring into a safe, measurable activity — critical for trust in a safety product.
- **Rules carry no industry identity** — the single most important mechanism enforcing "no industry logic in core."

## Advantages
- Customers self-serve their own detections/automations; new verticals ship as rule packs.
- Deterministic, testable, auditable — suitable for regulated buyers.

## Tradeoffs
- A safe DSL + stateful temporal evaluation is more work than hardcoded `if` checks, and expressive DSLs risk complexity; mitigated by templates, validation, dry-run, and guardrails (bounded state, no arbitrary code).

## Future expansion
- ML-assisted rule suggestions from event history; natural-language → rule authoring; cross-camera/cross-site composite rules; CEP operators.

## Cross-references
[09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [11-WORKFLOW-ENGINE](11-WORKFLOW-ENGINE.md) · [13-INDUSTRY-PACKS](13-INDUSTRY-PACKS.md) · [20-EXTENSIBILITY](20-EXTENSIBILITY.md)
