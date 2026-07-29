# Future Capability Roadmap (Updated Architecture Roadmap)

_Status: ⏳ Architect Review Pending · Documentation-only · Companion: [enhancement proposal](README.md)_

> Deliverables **1 (Updated Architecture Roadmap)** + **3 (Future Capability Roadmap)**. Places the
> future enterprise capabilities on the delivery timeline **over the frozen architecture** (docs
> 01–28, unchanged). The top-level [PROJECT_ROADMAP](../../project/PROJECT_ROADMAP.md) carries the
> phase view; this doc is the capability-level forward map.

## Where each capability lands (delivery sequence)

```
NOW  ── Phase 1 ✅ Core Platform (camera → alert vertical, all 8 slices approved)
        capability runtime · event pipeline · rules · incidents · alerts

NEXT ── Phase 2  Productization
        P2-1  Operations Console (SOC UI)                         [planned, ⏳]
        Backend enablers G-1…G-6 (live-preview, upload→analyze,   [planned, ⏳]
              media→inference, evidence refs, gateway CORS/SSE, assign/comments)
        ── first formalization of ──
        • Evidence Package (ADR-0020)   ← G-4 evidence refs mature into the full package
        • AI Capability Registry catalog (ADR-0022) surfaced read-only in the console

FUTURE ─ Phase 3  Enterprise Features
        • AI Capability Registry (full control-plane: status/deploy-modes/SLAs) — ADR-0022
        • Analysis Profiles (customer-facing capability bundles)                — ADR-0021
        • AI Packs (Retail / Warehouse / Hospital / School / Factory)           — extends ADR-0007/13
        • Human Review Feedback Loop (review dataset, analytics)
        • AI Benchmark Framework (accuracy/perf gates in MLOps)

        Phase 4  Production & Scaling
        • Inference Scheduler + GPU pool (behind the unchanged /infer API)
        • Multi-region, edge fleet, HA/DR (frozen docs 14/17/19/27)
```

## Capability → phase → frozen-architecture anchor

| Capability                       | Phase                  | Type                   | Frozen anchor                                                                   | Not-before signal                                |
| -------------------------------- | ---------------------- | ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| Evidence Package                 | 2→3                    | object-store lifecycle | [12](../12-EVIDENCE-MANAGEMENT.md), [18](../18-DATA-ARCHITECTURE.md)            | first incident with a clip in the console        |
| AI Capability Registry (catalog) | 2 (read) → 3 (control) | metadata + API         | [05](../05-CAPABILITY-ARCHITECTURE.md)                                          | multiple capabilities / customer-visible catalog |
| Analysis Profiles                | 3                      | tenant config          | [24](../24-COMPOSITION-FRAMEWORK.md)                                            | ≥ 2 capabilities to bundle                       |
| AI Packs                         | 3                      | plugins                | [13](../13-INDUSTRY-PACKS.md), [20](../20-EXTENSIBILITY.md)                     | first vertical customer (Retail)                 |
| Human Review Loop                | 3                      | workflow + dataset     | [08](../08-AI-ML-PLATFORM.md), [11](../11-WORKFLOW-ENGINE.md)                   | enough incidents to label                        |
| AI Benchmark Framework           | 3                      | MLOps/CI               | [08](../08-AI-ML-PLATFORM.md), `ai/mlops`                                       | ≥ 2 models / promotion decisions                 |
| Inference Scheduler              | 4                      | capacity component     | [05 §4](../05-CAPABILITY-ARCHITECTURE.md), [19](../19-PERFORMANCE-AND-SCALE.md) | GPU contention / multi-stream scale (R-005)      |

## Sequencing principles

1. **Product need drives order** — nothing is built ahead of a demo/customer requiring it.
2. **The core stays lean** — enterprise breadth arrives as **plugins (Packs)**, **config (Profiles)**,
   **object-store lifecycle (Evidence)**, and **capacity components (Scheduler)** — never as new
   business logic in the industry-neutral core.
3. **Each promotion is gated** — a spec moves `Proposed → Accepted` only at its phase gate, with the
   normal review + quality gates.

## Not built now

This roadmap changes **no code and no frozen architecture doc**. It is the agreed forward map; each
item is implemented only when its phase and product-need signal arrive.
