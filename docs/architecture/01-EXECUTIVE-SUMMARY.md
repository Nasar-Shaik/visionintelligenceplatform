# 01 — Executive Summary

## Purpose

Give any reader — engineer, agent, executive, or partner — a correct mental model of the platform in one page, and orient them to the rest of the architecture.

## What we are building

The **PaperlessTech Vision Intelligence Platform (VIP)** is an enterprise, multi-tenant SaaS that converts sensor streams (primarily video) into **structured intelligence**: detections, tracks, events, incidents, evidence, analytics and alerts. It is a **platform of reusable capabilities**, not a vertical application. Customers and partners compose those capabilities — via **events, rules, workflows and industry plugins** — into unlimited business solutions (retail loss prevention, hospital patient safety, warehouse compliance, smart-city traffic, and any future use case) **without changing the core**.

## Why it is different

1. **Capability-composed, not feature-coded.** Every solution is an assembly of building blocks; the roadmap compounds instead of accreting bespoke code.
2. **Core carries no vertical logic.** Industries are plugins — the same engine serves a bank and a school; adding a vertical is adding a plugin.
3. **Deploy-anywhere with identical semantics.** One codebase runs cloud, on-prem, hybrid, and fully offline edge; deployment mode is configuration and capability _placement_, not a fork.
4. **Model-agnostic AI platform.** Models are versioned registry artifacts (ONNX/TensorRT/OpenVINO, CPU/GPU/edge), continuously trained, canary-deployed, and rollback-able. No model is hardcoded.
5. **Edge-first economics.** Heavy inference runs at the camera; only events, metadata and short evidence clips travel upstream — cutting bandwidth and cloud-GPU cost and preserving privacy.
6. **Event/Rule/Workflow as first-class platforms**, each independently extensible, giving customers no-code control over "what matters" and "what happens next."

## Primary capabilities (building blocks)

Ingestion · Camera management · Streaming · Recording · Frame extraction · Inference runtime · Object/person/vehicle detection · Tracking · Re-identification · Pose · Face recognition · OCR/LPR · Fire/smoke · Audio analytics · Scene classification · Zone/line/speed/queue analytics · Object-left/removed · Heatmaps · Trajectory & behavior analysis · Anomaly detection · Evidence & timeline generation · Rule engine · Workflow engine · Notification engine · Analytics & report engines · Model/Dataset registries · Deployment & monitoring. Full catalog: [reference/AI-CAPABILITY-CATALOG](../reference/AI-CAPABILITY-CATALOG.md).

## Business goals

- Ship a **sellable multi-tenant increment early** (video + capabilities + events + rules + alerts) and grow to **enterprise GA** without architectural rework.
- Support **2 → 10,000+ cameras** per tenant and **100k+ platform-wide** with linear cost via edge offload and smart-clip storage.
- Reach broad capability coverage (60+ vision capabilities) monetized as toggleable packs and an eventual **model/plugin marketplace**.
- Serve **any regulated vertical** (bank, hospital, government, school) via isolation, compliance tooling, and on-prem/hybrid options.
- Enable **channel growth**: white-label/OEM, partner-published capabilities and Industry Packs.

## Non-functional targets (headline; full list in [02](02-PRODUCT-VISION-AND-GOALS.md))

- Control-plane availability **99.9%**; edge autonomous during WAN outage.
- Edge frame-to-event latency **< 300 ms** for real-time capabilities; event-to-alert **< 3 s** for critical events.
- **≥ 90%** storage reduction vs continuous recording via smart-clip evidence.
- Tenant isolation provable by automated cross-tenant tests on every endpoint and stream.
- Compliance posture for **GDPR, HIPAA-aware, SOC 2, ISO 27001**; regional data residency.

## How to read on

- The vision and targets → [02](02-PRODUCT-VISION-AND-GOALS.md)
- The rules of construction → [00-ENGINEERING-CONSTITUTION](../00-ENGINEERING-CONSTITUTION.md) and [03](03-ARCHITECTURE-PRINCIPLES.md)
- The system shape → [04-SYSTEM-OVERVIEW](04-SYSTEM-OVERVIEW.md)
- The core idea (capabilities) → [05-CAPABILITY-ARCHITECTURE](05-CAPABILITY-ARCHITECTURE.md)
- What to build and when → [../../tracking/ROADMAP.md](../../tracking/ROADMAP.md)

## Tradeoffs (stated honestly)

- **Composition over hardcoding** adds up-front abstraction cost (contracts, registries, plugin loaders) that a single-vertical MVP would skip. We accept it deliberately: it is the entire reason the platform can serve any vertical for a decade. See [ADR-0001](../adr/ADR-0001-capability-composition-over-vertical-features.md).
- **Edge-first** adds fleet-management complexity in exchange for cost, latency and privacy wins.
- **Model-agnosticism** adds a runtime abstraction layer in exchange for never being trapped by a vendor or a model generation.
