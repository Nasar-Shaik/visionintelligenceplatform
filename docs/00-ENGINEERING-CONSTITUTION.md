# 00 — Engineering Constitution

> The governing document of the PaperlessTech Vision Intelligence Platform (VIP). Every other document, every service, every line of code is subordinate to it. It changes only through an Architecture Decision Record (ADR). It is written to hold for a decade of evolution across many teams and agents.

---

## 1. Purpose

To define **what kind of system this is**, the **immutable laws** that keep it coherent as hundreds of contributors extend it, and the **composition model** by which unlimited business solutions are built without ever modifying the core.

This document does not describe features. It describes the **rules of construction**. If you are about to write code and it does not obviously conform to this document, stop and reconcile — via an ADR if the Constitution is wrong, or via a redesign if the code is wrong.

---

## 2. What this platform is (and is not)

**It is** a horizontally-scalable, multi-tenant, event-driven **Vision Intelligence Platform**: an engine that ingests sensor streams (primarily video, extensibly audio/thermal/radar/IoT), extracts structured **observations** using swappable AI capabilities, turns observations into **events**, evaluates events against tenant-defined **rules**, and drives **workflows**, **evidence**, **notifications**, **analytics** and **reports** — deployable to cloud, on-prem, hybrid or edge with identical semantics.

**It is not:**

- Not a CCTV/VMS product. (A VMS can be built _on_ it.)
- Not "theft detection," "hospital monitoring," or any vertical application. Those are **compositions** expressed as plugins.
- Not tied to any AI model, vendor, cloud, or camera brand.
- Not a monolith of customer workflows. Customer intent is **data** (rules, workflows, configuration), never branching code.

> **Litmus test.** Before adding anything ask: _"Would this belong in the product of a competitor who serves a completely different industry than the one I'm thinking about?"_ If **no**, it does not go in the core — it goes in a plugin.

---

## 3. The Five Laws

These are non-negotiable. Violating one is a release blocker.

### Law 1 — No industry or customer logic in the core

The core (`services/`, `ai/`, `edge/`, `packages/`) must contain **zero** knowledge of Retail, Hospital, School, Bank, Warehouse, or any specific customer. Vertical behavior — which rules, which workflows, which dashboards, which reports, which policies — lives exclusively in **Industry Packs** under `plugins/`. The core must build, test, and ship correctly with **all plugins removed**.

### Law 2 — Everything is a composable capability

Functionality is delivered as **capabilities**: self-describing, independently deployable building blocks with a versioned contract (see [05-CAPABILITY-ARCHITECTURE](architecture/05-CAPABILITY-ARCHITECTURE.md)). New features are **compositions** of existing capabilities plus events, rules, workflows and plugins — not new bespoke pipelines. A capability declares its inputs, outputs, resource profile, and placement (edge/cloud), and can be swapped for another implementation of the same contract without touching consumers.

### Law 3 — Event-driven, rule-driven, workflow-driven

The system reacts to **events** on a durable event backbone. Business meaning is assigned by the **Rule Engine** (declarative, tenant-owned). Human/automated response is orchestrated by the **Workflow Engine**. No capability calls another capability's business logic directly; they communicate through events and contracts. This is what makes the platform extensible without redesign.

### Law 4 — API-first & contract-first

No capability, service, or plugin exists without a **published, versioned contract** (schema + API + event definitions) authored **before** implementation. Contracts live in `packages/contracts` and are the law of integration. Breaking a published contract requires a new version and an ADR. Every capability is reachable through the public API surface; internal-only shortcuts are prohibited.

### Law 5 — Secure & isolated by default

Every operation executes inside a resolved **tenant context**; data access without it is impossible by construction (enforced at the data layer, not by convention). Least-privilege, encryption in transit and at rest, full auditability, and privacy-by-design are defaults, not features. Security is designed in the contract, not bolted on later.

---

## 4. Supporting principles

These refine the Five Laws; the full treatment is in [03-ARCHITECTURE-PRINCIPLES](architecture/03-ARCHITECTURE-PRINCIPLES.md).

| Principle                 | One-line meaning                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Cloud-native**          | Stateless services, 12-factor, container-first, declarative infra.                   |
| **Edge-first**            | Heavy inference runs where the camera is; cloud is orchestration + heavy/batch.      |
| **Offline-capable**       | Edge operates fully during WAN loss and reconciles on reconnect.                     |
| **Model-agnostic**        | ONNX/TensorRT/OpenVINO/CPU/GPU; models are registry artifacts, never code constants. |
| **Horizontally scalable** | Every hot path scales by adding instances; no vertical-only bottleneck.              |
| **Observable**            | Everything emits metrics, traces, logs, and health by default.                       |
| **Extensible**            | Extension points, hooks, and DI everywhere a future need is plausible.               |
| **Deploy-anywhere**       | One codebase; cloud, on-prem, hybrid, edge differ only by configuration/placement.   |
| **Data-minimizing**       | Store events and evidence, not continuous raw video, unless policy requires it.      |
| **Reversible**            | Every deploy, model, and migration has a defined rollback.                           |

---

## 5. The composition model — how solutions are built

A customer solution is **never** written as code. It is assembled from six layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│  INDUSTRY PACK (plugin)   rules · workflows · dashboards · reports ·  │
│                           policies · templates   (declarative only)   │
├─────────────────────────────────────────────────────────────────────┤
│  WORKFLOW ENGINE          incidents · cases · escalation · approvals  │
├─────────────────────────────────────────────────────────────────────┤
│  RULE ENGINE              tenant-defined IF/WHEN/THEN over events      │
├─────────────────────────────────────────────────────────────────────┤
│  EVENT PLATFORM           taxonomy · correlation · dedup · timeline    │
├─────────────────────────────────────────────────────────────────────┤
│  COMPOSITION LAYER        reusable business measures (people counting, │
│                           queue, occupancy, perimeter…)  → see doc 24  │
├─────────────────────────────────────────────────────────────────────┤
│  CAPABILITIES             ingestion · inference · tracking · OCR · …   │
│                           (reusable building blocks, model-agnostic)   │
└─────────────────────────────────────────────────────────────────────┘
```

> The **Composition Layer** ([24-COMPOSITION-FRAMEWORK](architecture/24-COMPOSITION-FRAMEWORK.md), [ADR-0006](adr/ADR-0006-composition-layer.md)) was added by the Enterprise Architecture Review. It is optional in the mental model — atomic capabilities can still feed events directly — but it is where reusable mid-level business logic lives so it is not re-authored in every tenant's rules. It carries no industry identity.

**Example — "supermarket shoplifting alerting" is built, not coded:**

1. **Capabilities** (already in core): video ingestion, person detection, tracking, pose, zone/line detection, object-left/removed, OCR (for POS), clip extraction.
2. **Events** (already defined): `object.concealed`, `zone.dwell.exceeded`, `pos.transaction`, `track.path`.
3. **Rule** (data, authored in the Rule Engine): _IF concealment-gesture in `shelf-zone` AND no matching `pos.transaction` within 120s THEN raise `incident` severity=review._
4. **Workflow** (data): route to Loss-Prevention queue → require human review → export evidence with chain of custody.
5. **Industry Pack** (`plugins/retail`): ships the above rule template, a loss-prevention dashboard, a shrink report, and a retention policy — **and nothing else**. It adds no AI code.

The same capabilities compose into hospital fall-response, warehouse PPE compliance, or smart-city traffic analytics. **New verticals are new plugins, not new engines.**

---

## 6. Boundaries & dependency rules

- **Core may not depend on plugins.** Compile-time and runtime. The dependency arrow points **plugin → core** only, through published extension points.
- **Capabilities may not depend on each other's internals.** They communicate via events and contracts. A capability may declare it _consumes_ an event type; it may not import another capability's code.
- **Plugins may not depend on other plugins.** Shared vertical logic that emerges is promoted into a core capability or a shared plugin library via ADR.
- **Contracts have no runtime dependencies.** `packages/contracts` is pure schema/types so anything can depend on it.
- **The data layer owns isolation.** Application code cannot opt out of tenant scoping.

A dependency that violates these rules does not get merged. CI enforces the import graph.

---

## 7. Versioning & compatibility

- **Contracts** use semantic versioning. Additive = minor; breaking = major + ADR + migration/deprecation window.
- **Capabilities** advertise the contract version(s) they satisfy; the runtime binds consumers to compatible providers.
- **Plugins** declare a compatible **platform API version range**; the plugin loader refuses incompatible plugins rather than failing at runtime.
- **Events** are versioned in their schema; consumers tolerate unknown additive fields (Postel's law). Never repurpose a field.
- **Models** are immutable, versioned registry artifacts; a deployment pins exact versions and can roll back instantly.

Backward compatibility is a feature we sell. Assume every published contract has an external consumer.

---

## 8. How to change the architecture

1. Write an **ADR** (`docs/adr/`, next number, `Proposed`). State context, decision, alternatives, consequences, and which Law/principle it touches.
2. Socialize/accept it (`Accepted`). Superseding a prior ADR links both ways; ADRs are never deleted.
3. Edit the affected `docs/architecture/NN-*.md` sections to match, linking the ADR.
4. Only then change code. The docs must never describe a system that doesn't exist, and code must never embody a decision no ADR records.

If you find code and docs disagree, that is a **defect** — file it, don't perpetuate it.

---

## 9. Non-goals (explicitly out of scope for the core, forever)

- Hardcoded vertical dashboards, reports, or alert logic.
- A single "best" AI model baked into a capability.
- Assumptions of a specific cloud, camera vendor, or database engine leaking past the contract boundary.
- Human workflows expressed as imperative code branches.
- Any feature that cannot be expressed as capability + event + rule + workflow + plugin.

---

## 10. Cross-references

- Principles in depth → [03-ARCHITECTURE-PRINCIPLES](architecture/03-ARCHITECTURE-PRINCIPLES.md)
- The building blocks → [05-CAPABILITY-ARCHITECTURE](architecture/05-CAPABILITY-ARCHITECTURE.md)
- Event/Rule/Workflow backbone → [09](architecture/09-EVENT-PLATFORM.md), [10](architecture/10-RULE-ENGINE.md), [11](architecture/11-WORKFLOW-ENGINE.md)
- The plugin model → [13-INDUSTRY-PACKS](architecture/13-INDUSTRY-PACKS.md), [20-EXTENSIBILITY](architecture/20-EXTENSIBILITY.md)
- Decisions of record → [`adr/`](adr/)
- Current state & plan → [`../tracking/`](../tracking/)
