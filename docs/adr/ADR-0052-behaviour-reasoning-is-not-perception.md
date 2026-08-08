# ADR-0052 · Behaviour reasoning is not perception

- **Status:** Accepted
- **Date:** 2026-08-08
- **Milestone:** P-11 Professional Perception Phase 2 (Behaviour Engine)
- **Relates to:** [ADR-0050](ADR-0050-the-perception-vocabulary-is-the-plugin-boundary.md), [ADR-0051](ADR-0051-track-history-becomes-durable.md), [INCIDENT_BOUNDARY](../architecture/INCIDENT_BOUNDARY.md)

## Context

The Behaviour Engine's seven items end with a **retail reasoning layer**: shelf interaction,
concealment, no-checkout, suspicious behaviour. Read literally, that is a request to put "is this
person stealing" inside the perception runtime.

⛔ **That would break a standing guardrail** — *the architecture remains perception-only; no business
logic in the runtime* — and the guardrail is not bureaucratic. It is what lets one perception stack
serve retail, hospital, warehouse, school and factory without a fork, which is the Architect's own
stated objective two paragraphs above the retail list.

There is also a commercial edge to it. "Concealment" is an accusation about a person. A runtime that
emits it has made a judgement; a runtime that emits *"this person's hand entered a bag region while
holding a tracked object"* has made an observation, and the customer's rule decides what that means
in their store, under their policy, with their thresholds.

## Decision

**Three layers, and the boundary between them is the perception/interpretation line.**

```
Layer 1  PERCEPTION          runtime · plugins behind the perception registry
         detection · pose · segmentation · re-id · OCR
         → emits observations. Never a judgement.

Layer 2  BEHAVIOUR PRIMITIVES   runtime · derived, domain-neutral, reusable
         trajectory · velocity · dwell · proximity · hand-object association
         · object ownership · zone transitions
         → emits facts about geometry and time. Still never a judgement.

Layer 3  DOMAIN REASONING       rules engine · per tenant, per industry pack
         shelf interaction → concealment → no-checkout → alert
         → the only layer that names an intent.
```

**1. Layers 1 and 2 ship in the runtime. Layer 3 does not.** The retail reasoning layer is authored
as **rules over behaviour primitives**, in the existing rule engine, where thresholds are a
customer's configuration and an incident has an owner and an audit trail.

**2. A primitive is domain-neutral or it does not belong in Layer 2.** The test: *can a hospital use
it?* `dwell_in_zone` passes — a hospital calls it "waiting", retail calls it "queueing", a factory
calls it "idle". `concealment` fails, and that failure is the signal it belongs in Layer 3.

**3. Every Layer 2 primitive is registered through the P-10 perception registry** and returns
`PerceptionOutput` — `FrameLabel` for statements about the scene, `RawInstance.attributes` for
statements about a subject. ⭐ No new pipeline stage, no second inference path.

**4. The runtime still emits `EventEnvelope` and still creates no incidents.** Unchanged.

## Consequences

⭐ **One engine, five industries.** Warehouse ("has this pallet moved"), hospital ("has this patient
left the bed"), school ("is this corridor crowded") and retail ("was this item concealed") are the
same primitives with different rules. A fixed theft heuristic in the runtime would have to be
duplicated and diverged for each.

⭐ **The accusation stays where it can be argued with.** A rule is visible in the console, versioned,
attributable and tunable per site. A hard-coded runtime heuristic is none of those, and the first
false accusation is the moment that matters.

⚠️ **Layer 3 will feel slower to demo.** A theft heuristic wired directly into the runtime would show
something sooner. That is precisely the technical debt the Architect's instruction — *"do not
implement fixed theft heuristics first"* — exists to prevent, and this ADR is that instruction made
structural.

⚠️ **Some primitives are genuinely ambiguous** and their placement is a judgement, recorded here:
`hand-object association` is Layer 2 (geometry). `object ownership` is Layer 2 (association over
time). `object taken vs replaced` is **Layer 3**, because it depends on which side of a shelf
boundary the customer considers "taken" — and, as ACTION_FOUNDATION §3 records, picking and placing
are the same skeleton.
