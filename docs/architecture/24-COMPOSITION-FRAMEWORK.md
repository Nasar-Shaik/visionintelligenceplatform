# 24 — Capability Composition Framework

> One of the most important additions from the Enterprise Architecture Review. It introduces the reusable **Composition Layer** between atomic capabilities and events. Ratified by [ADR-0006](../adr/ADR-0006-composition-layer.md).

## Purpose
Provide a reusable, model-agnostic, industry-neutral layer of **mid-level business capabilities** ("compositions") — People Counting, Queue Analytics, Occupancy, Perimeter/Intrusion Monitoring, etc. — assembled from atomic capabilities ([05](05-CAPABILITY-ARCHITECTURE.md)) and emitting higher-order events. This prevents every tenant from re-expressing the same business logic in rules, and standardizes analytics.

## Responsibilities
- Define the composition contract and registry.
- Host the composition runtime (co-located with the Capability context, [23](23-SERVICE-OWNERSHIP.md)).
- Emit higher-order `composition.output.*` events consumed by Rules, Analytics, and the Digital Twin.

---

## 1. Where it sits (the six-layer model)

```
Capability  →  Composition  →  Event  →  Rule  →  Workflow  →  Industry Pack
 (atomic)      (reusable       (fact)    (tenant  (response)    (vertical
  building      business                  meaning)              config)
  blocks)       building blocks)
```
- A **capability** answers "what is in the frame" (person, plate, pose, zone-cross).
- A **composition** answers "what is happening" as a **reusable business measure** (12 people in queue; occupancy 84%; perimeter breached) — **without** deciding whether it *matters* (that is a Rule) or *to whom* (that is a Workflow/Pack).
- Compositions carry **no industry identity** (Law 1) and communicate only via events/contracts (Law 3). Updates [00 §5](../00-ENGINEERING-CONSTITUTION.md).

## 2. The composition contract

Like a capability, a composition is a versioned, self-describing, entitlement-gated unit registered in the registry:

```yaml
composition:
  id: composition.queue-analytics
  version: 1.0.0
  requires:                          # capability/composition dependencies (typed, acyclic)
    - capability: perception.person-detection
    - capability: perception.tracking
    - capability: spatial.zone-detection
  parameters:
    queue_zone: {type: zoneRef}
    wait_time_sla: {type: duration, default: 120s}
  generates_events:                  # higher-order events it emits
    - composition.queue.length          # e.g. { length: N, zoneId, ts }
    - composition.queue.wait-exceeded    # when wait > SLA
  supported_rules:                   # rule hooks it advertises (for builders/packs)
    - "queue length > N for > T"
    - "average wait > SLA"
  outputs:                           # read-model outputs (for Analytics/Twin)
    - metric: queue.length (time-series)
    - metric: queue.wait (time-series)
  api: /compositions/queue-analytics  # reusable API surface
  placement: [edge, cloud]
  resource_profile: { est_load: {per_stream_ms: 3, mem_mb: 120} }
```

**Every composition declares:** required capabilities · generated events · supported rules · outputs · reusable API. This is the exact field set the review asked for.

## 3. Reference composition library (initial)

All are reusable across every vertical; verticals differ only by which they enable and how their rules/packs use the emitted events.

| Composition | Requires | Generates events | Outputs |
|---|---|---|---|
| **People Counting** | person-detection, tracking, line-crossing | `composition.count.in\|out` | counts (in/out), footfall time-series |
| **Queue Analytics** | person-detection, tracking, zone | `composition.queue.length\|wait-exceeded` | queue length, wait-time |
| **Occupancy** | person-detection, tracking, zone | `composition.occupancy.updated\|capacity-exceeded` | live occupancy, capacity % |
| **Crowd Density** | person-detection, tracking | `composition.crowd.density\|surge` | density map, surge alerts |
| **Perimeter Monitoring** | person/vehicle-detection, tracking, zone/line | `composition.perimeter.approach\|breach` | perimeter state |
| **Intrusion Monitoring** | person-detection, tracking, zone | `composition.intrusion.detected` | intrusion events (identity-agnostic) |
| **Asset Tracking** | object-detection, tracking, object-left/removed | `composition.asset.moved\|removed\|abandoned` | asset state |
| **Visitor Analytics** | person-detection, tracking, (optional face) | `composition.visitor.entered\|dwell` | visitor counts, dwell |
| **Area Monitoring** | person/vehicle-detection, tracking, zone | `composition.area.entered\|exited\|dwell` | per-zone presence |
| **Vehicle Monitoring** | vehicle-detection, tracking, lpr, line/speed | `composition.vehicle.counted\|speeding\|plate-read` | vehicle metrics |
| **Safety Monitoring** | person-detection, attribute(PPE), zone, pose | `composition.safety.ppe-missing\|proximity\|fall` | safety compliance/incidents |
| **Behavior Monitoring** | tracking, pose, reasoning.behavior | `composition.behavior.anomaly\|loiter\|aggression` | behavior signals |

Each is model-agnostic (its capabilities bind models by selector) and industry-neutral (a "queue" is a queue in a bank, a supermarket, or an airport).

## 4. How compositions compose into solutions (unchanged philosophy)

The example from [00 §5](../00-ENGINEERING-CONSTITUTION.md) now reads more cleanly:
- **Supermarket checkout SLA:** enable **Queue Analytics** composition → it emits `composition.queue.wait-exceeded` → tenant rule *IF wait-exceeded in `checkout` THEN notify store manager* → Retail Pack ships that rule + a queue dashboard. No new capability, no new composition code — just enablement + a rule.
- **Airport security lane:** the **same** Queue Analytics + Perimeter Monitoring compositions, different rules + an Airport Pack. Reuse, not reimplementation.

## 5. Execution & scheduling
Compositions are scheduled by the same **Execution Scheduler** as capabilities ([05 §4 / Execution Scheduler](05-CAPABILITY-ARCHITECTURE.md)): they extend the per-camera DAG (capability nodes → composition nodes → events), share the placement/batching machinery, and only run when a tenant enables them (entitlement + rule reference). This keeps compute proportional to what customers actually use.

## Design decisions
- **Compositions are contracts, not code paths** — registered, versioned, entitlement-gated exactly like capabilities, so the orchestrator/registry/observability treat them uniformly.
- **Higher-order events, not richer rules** — business aggregation lives in reusable compositions, keeping tenant rules simple and portable across verticals.
- **Strictly acyclic dependencies** — a composition may depend on capabilities and (carefully) other compositions; the dependency graph is validated like the service graph ([23](23-SERVICE-OWNERSHIP.md)).

## Advantages
- Massive reuse: the 12 reference compositions cover the bulk of what every vertical needs.
- Simpler rules and standardized analytics/metrics across all industries.
- New verticals mostly **enable existing compositions + author rules** — often zero engineering.

## Tradeoffs
- One more registered layer to design, schedule, and version; mitigated by reusing the capability machinery wholesale.
- Requires discipline to keep compositions industry-neutral (a composition that "knows" it's retail is a bug).

## Future expansion
- Partner-published compositions via the marketplace; auto-suggested compositions from a stated goal; composite-of-composites for complex situational awareness (feeding the Digital Twin, [26](26-DIGITAL-TWIN.md)).

## Cross-references
[05-CAPABILITY-ARCHITECTURE](05-CAPABILITY-ARCHITECTURE.md) · [09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [10-RULE-ENGINE](10-RULE-ENGINE.md) · [13-INDUSTRY-PACKS](13-INDUSTRY-PACKS.md) · [26-DIGITAL-TWIN](26-DIGITAL-TWIN.md) · [ADR-0006](../adr/ADR-0006-composition-layer.md)
