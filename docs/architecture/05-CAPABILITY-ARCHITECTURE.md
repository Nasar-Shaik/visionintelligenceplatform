# 05 — Capability Architecture

> **This is the core idea of the platform.** Read it carefully. Everything else composes from it.

## Purpose

Define the **reusable building block** — the _capability_ — its contract, lifecycle, registry, and how capabilities compose into solutions without bespoke code. This section operationalizes Law 2 (Everything is a composable capability).

## Responsibilities

- Define what a capability is and the uniform contract every capability satisfies.
- Define the capability catalog, registry, orchestration, and placement (edge/cloud).
- Show how capabilities compose via events into solutions, and how new capabilities are added.

---

## 1. What is a capability?

A **capability** is a self-describing, independently deployable unit of functionality with a versioned contract. It consumes typed inputs (frames, tracks, events, or other capability outputs) and produces typed outputs (detections, tracks, events, artifacts) **without knowing its consumers** and **without embedding any customer/industry logic**.

Capabilities fall into families:

- **Media capabilities**: ingestion, streaming, recording, frame extraction.
- **Perception capabilities**: object/person/vehicle detection, tracking, re-ID, pose, face recognition, OCR/LPR, fire/smoke, audio analytics, scene classification.
- **Spatial/temporal capabilities**: zone detection, line crossing, speed, queue, object-left/removed, heatmaps, trajectory, occupancy.
- **Reasoning capabilities**: behavior analysis, anomaly detection, correlation.
- **Platform capabilities**: event platform, rule engine, workflow engine, evidence, notification, analytics, report, search, model/dataset registry, deployment, monitoring.

The full inventory is in [reference/AI-CAPABILITY-CATALOG](../reference/AI-CAPABILITY-CATALOG.md). **No capability is a "feature"; every feature is a composition of capabilities.**

## 2. The capability contract (uniform for all)

Every capability declares a **descriptor** (machine-readable, in `packages/contracts`) and implements a small interface. The descriptor is the law:

```yaml
capability:
  id: perception.object-detection          # stable, namespaced
  version: 2.3.0                            # semver of the contract
  kind: perception                          # media|perception|spatial|reasoning|platform
  inputs:
    - type: media.frame                     # typed input contract(s)
      rate: adaptive                        # frame-rate expectations
  outputs:
    - type: perception.detection            # typed output contract(s)
  parameters:                               # tenant/camera-tunable config (schema)
    confidence_threshold: {type: float, default: 0.5}
    classes: {type: string[], default: ["person","vehicle"]}
    roi: {type: polygon[], optional: true}
  models:                                   # model-agnostic: refers to registry, not a file
    selector: {task: object-detection, family: "yolo|detr|*"}
  resource_profile:                         # for the scheduler
    accelerator: [gpu, cpu]
    est_load: {per_stream_ms: 12, mem_mb: 900}
  placement: [edge, cloud]                  # where it MAY run
  extension_points: [pre_process, post_process, class_map]
```

```typescript
interface Capability<In, Out, Params> {
  descriptor: CapabilityDescriptor;
  init(ctx: CapabilityContext, params: Params): Promise<void>; // load model via registry, warm up
  process(input: In, ctx: RequestContext): Promise<Out>; // pure w.r.t. business logic
  health(): HealthStatus;
  dispose(): Promise<void>;
}
```

**Rules the contract enforces:**

- **Model-agnostic**: a capability references a model by a **registry selector** (task/family/version range), never a hardcoded file or vendor. The runtime binds the concrete model. → [08](08-AI-ML-PLATFORM.md)
- **Consumer-agnostic**: outputs go to the event backbone / typed channels; the capability never names who consumes them.
- **Placement-agnostic**: the same implementation runs at edge or cloud; `placement` lists where it _may_ run, the scheduler decides where it _does_.
- **No industry logic**: parameters are generic (thresholds, classes, zones); "this is a shoplifting detector" is expressed by a **rule**, not by the capability.

## 3. Capability Registry (runtime, self-registering)

The **Capability Registry** (`services/registry`) is the runtime source of truth for capabilities: every capability (and composition and connector) **self-registers at startup** and is discoverable by `id` + compatible version.

**Stored per capability (the registry record):**

```
name · version · owner · description
input_types · output_types · dependencies (capability graph)
required_models (selectors) · required_gpu · required_cpu · memory_usage · latency (est.)
generated_events · configuration_schema
health_status · metrics (live) · license
lifecycle_state: experimental | stable | deprecated
```

The registry supports:

- **Discovery** — consumers/pipeline find capabilities by id/type/version.
- **Dependency resolution** — the capability dependency graph ([§4a](#4a-capability-dependency-graph)) is resolved from `dependencies`; cycles are rejected.
- **Scheduling** — `required_gpu/cpu/memory/latency` + `placement` feed the Execution Scheduler ([§4b](#4b-execution-scheduler)).
- **Monitoring** — live `health_status`/`metrics` per capability flow to observability ([16](16-OBSERVABILITY.md)).
- **Version compatibility** — consumers bind to compatible descriptor versions; the loader refuses incompatible ones.

Additional rules:

- **Entitlement-gated:** which capabilities a tenant may enable is resolved from their plan/packs ([06](06-MULTI-TENANT-SAAS.md)); a capability disabled by entitlement is invisible to that tenant.
- **Lifecycle states** gate exposure: `experimental` (behind a flag), `stable` (GA), `deprecated` (warned, scheduled for removal).
- **Plugins self-register new capabilities** (subject to a trust tier + certification, [20](20-EXTENSIBILITY.md)) without any core change; registration requires passing contract validation ([03](03-ARCHITECTURE-PRINCIPLES.md)).

## 4. Orchestration & placement (the pipeline)

The **Pipeline Orchestrator** (`services/pipeline` in cloud; `edge/agent` at edge) builds, per camera, a **capability graph** from the camera's assigned capabilities and the tenant's rules:

```
media.ingest → media.frame-extract ─┬→ perception.person-detection → perception.tracking ─┐
                                     ├→ perception.fire-smoke                              │
                                     └→ perception.lpr                                     ▼
                                                                          reasoning.behavior + spatial.zone
                                                                                           │
                                                                                           ▼
                                                                                   EVENT PLATFORM
```

- The graph is a **DAG of capabilities** wired by input/output types. The orchestrator resolves it from descriptors; it is **generated, not hand-coded per camera**.
- **Placement**: the scheduler assigns each node to edge or cloud using `resource_profile`, available accelerators, latency class, and connectivity. Real-time/safety-critical nodes prefer edge; heavy/batch (embeddings, temporal action models, search) prefer cloud.
- **Efficiency levers** (see [19](19-PERFORMANCE-AND-SCALE.md)): motion-gated adaptive sampling, model sharing/batching across streams, ROI masking, backpressure with graceful degradation (shed non-critical capabilities before dropping frames for fire/weapon).

### 4a. Capability dependency graph

Capabilities have **typed input/output dependencies** that the orchestrator resolves into the DAG. The graph is **acyclic** and validated in CI (a cycle is a build failure). Representative dependencies:

```
person-detection ─┐
vehicle-detection ─┼─▶ tracking ─┬─▶ reasoning.behavior ─▶ (loitering / fall / aggression)
object-detection ──┘             ├─▶ spatial.line-crossing ─▶ people/vehicle counting
                                 ├─▶ spatial.zone-detection ─▶ occupancy / area / queue
                                 └─▶ spatial.speed-estimation ─▶ speeding
object-detection + tracking ───────▶ object.left-behind / object.removed ─▶ asset/abandoned
person-detection ─▶ pose ──────────▶ reasoning.behavior (fall/aggression/gesture)
person-detection ─▶ attribute(PPE) ─▶ safety (ppe-missing)
face-detection ─▶ face-recognition ; vehicle-detection ─▶ lpr
```

Rules the graph enforces: a capability declares the capability **outputs** it consumes (never another capability's internals); depth/placement flow from the graph; and the same graph feeds the **Composition Layer** ([24](24-COMPOSITION-FRAMEWORK.md)), where e.g. _Queue Analytics = tracking + zone_ and _People Counting = tracking + line-crossing_. The full capability↔composition dependency table lives in [24 §3](24-COMPOSITION-FRAMEWORK.md).

### 4b. Execution Scheduler

The orchestrator's scheduler runs **only the capabilities a tenant actually needs**, and optimizes shared resources across all streams on a node. Inputs: each tenant/camera's enabled capabilities + compositions (from entitlements and referenced rules), capability `resource_profile`s, available accelerators, latency class, connectivity, and power budget.

- **Demand-driven execution.** If Customer A needs only `tracking`, Customer B `tracking + OCR`, Customer C `tracking + pose`, Customer D `tracking + fire-detection`, the scheduler builds four different DAGs and loads only the required models. Capabilities not referenced by any enabled composition/rule are never scheduled.
- **Optimization objectives:** GPU/CPU utilization (batch shared models across streams), memory (share loaded model instances), frame rate (per-capability adaptive FPS + motion gating), latency (reserved lanes for safety-critical: fire/weapon/fall), and **power** (throttle non-critical work on constrained edge devices).
- **Placement:** edge vs cloud per node ([§4](#4-orchestration--placement-the-pipeline)); real-time/safety-critical prefer edge, heavy/batch prefer cloud.
- **Backpressure:** under saturation, degrade in a defined order — lower FPS → defer non-critical capabilities/compositions → never drop frames for safety-critical. → [19](19-PERFORMANCE-AND-SCALE.md)

This makes compute proportional to what customers actually use — the key to per-camera cost at scale.

## 5. How capabilities compose into solutions

Composition happens in **declarative layers above capabilities**, never in capability code:

1. **Compositions** — reusable mid-level business measures (queue, occupancy, counting, perimeter…) assembled from capabilities, emitting higher-order events. → [24](24-COMPOSITION-FRAMEWORK.md)
2. **Events** — capability/composition outputs become normalized events on the backbone. → [09](09-EVENT-PLATFORM.md)
3. **Rules** — tenants declare what combinations of events matter. → [10](10-RULE-ENGINE.md)
4. **Workflows** — declare what happens when they do. → [11](11-WORKFLOW-ENGINE.md)

An **Industry Pack** bundles rule/workflow/dashboard/report templates for a vertical. → [13](13-INDUSTRY-PACKS.md)

> **Worked example — "PPE compliance for a construction site" uses zero new code:**
> capabilities `person-detection` + `ppe-attribute` + `zone-detection` already exist → event `attribute.ppe.missing` in `zone=hazard` → rule _IF ppe.missing in hazard-zone THEN incident(medium)_ → workflow _notify safety officer, require acknowledgment, export clip_ → the **Construction Pack** ships that rule/workflow/report as a template. The exact same capabilities serve a hospital hygiene-compliance solution with a different rule + pack.

## 6. Adding a new capability (the extension flow)

1. Write the **descriptor + contract** in `packages/contracts` (inputs/outputs typed, versioned).
2. Implement `Capability<In,Out,Params>` in `ai/` (perception) or `services/` (platform).
3. Reference models by **registry selector** (never a hardcoded model). Register model artifacts separately. → [08](08-AI-ML-PLATFORM.md)
4. Add contract + unit + (if stateful) integration tests; declare `resource_profile` and `placement`.
5. Register in the Capability Registry; gate behind an entitlement/pack.
6. It is now discoverable and composable by rules/workflows/plugins — **no consumer changes required.**

## Design decisions

- **Uniform contract for all capabilities** (perception and platform alike) means the orchestrator, registry, entitlements, and observability treat everything the same way — one mental model.
- **Model reference by selector** decouples capability lifecycle from model lifecycle; models can be retrained/canaried/rolled back without touching capabilities.
- **DAG generated from descriptors** removes per-camera bespoke pipeline code — the biggest source of vertical lock-in in naive designs.

## Advantages

- New features and verticals are compositions → the product compounds instead of accreting code.
- Capabilities are independently testable, deployable, scalable, and swappable (e.g., replace a YOLO detector with a DETR one behind the same contract).
- Edge/cloud parity for free, because placement is a scheduler decision over identical implementations.

## Tradeoffs

- Requires disciplined contract design and a real registry/orchestrator up front (vs. a hardcoded pipeline). This is the deliberate cost of Law 2; it is repaid every time a new vertical costs a plugin instead of a fork.
- The DAG orchestrator and scheduler are non-trivial components requiring careful performance work.

## Future expansion

- New sensor modalities (audio/thermal/radar/LiDAR/IoT) are just new media/perception capabilities behind the same contract.
- Partner-published capabilities via the marketplace and plugin trust tiers.
- Auto-composition: suggest capability graphs from a stated goal (higher-order tooling), still emitting only rules/workflows.

## Cross-references

[00-ENGINEERING-CONSTITUTION](../00-ENGINEERING-CONSTITUTION.md) · [08-AI-ML-PLATFORM](08-AI-ML-PLATFORM.md) · [09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [13-INDUSTRY-PACKS](13-INDUSTRY-PACKS.md) · [20-EXTENSIBILITY](20-EXTENSIBILITY.md) · [reference/AI-CAPABILITY-CATALOG](../reference/AI-CAPABILITY-CATALOG.md)
