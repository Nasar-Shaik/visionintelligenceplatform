# PROJECT BRAIN

> The one-page mental model of the entire project for any AI assistant or engineer. If you read only one file, read this — then follow the links. The **repository is the only source of truth**; no prior conversation is ever required.

## What this is

The **Vision Intelligence Platform (VIP)** — an enterprise, multi-tenant SaaS that turns camera streams into structured intelligence (events → rules → workflows → evidence → dashboards) as **reusable capabilities**, not vertical apps. Full definition: [`docs/00-ENGINEERING-CONSTITUTION.md`](../00-ENGINEERING-CONSTITUTION.md).

## The frozen architecture (v1.0 — do not redesign)

- **Status:** FROZEN v1.0 (2026-07-27). Change only via ADR ([`docs/adr/`](../adr/)). Freeze gate: [`docs/ARCHITECTURE-READINESS-REVIEW.md`](../ARCHITECTURE-READINESS-REVIEW.md).
- **Layers (never remove):** `Capability → Composition → Event → Rule → Workflow → Evidence → Dashboard`. Sections [05](../architecture/05-CAPABILITY-ARCHITECTURE.md), [24](../architecture/24-COMPOSITION-FRAMEWORK.md), [09](../architecture/09-EVENT-PLATFORM.md), [10](../architecture/10-RULE-ENGINE.md), [11](../architecture/11-WORKFLOW-ENGINE.md), [12](../architecture/12-EVIDENCE-MANAGEMENT.md).
- **Planes:** Control Plane (business mgmt) vs Data Plane (video/AI) — [27](../architecture/27-CONTROL-DATA-PLANE.md).
- **Pillars:** Plugin architecture [20](../architecture/20-EXTENSIBILITY.md) · Capability Registry [05 §3](../architecture/05-CAPABILITY-ARCHITECTURE.md) · Policy Engine [28](../architecture/28-POLICY-ENGINE.md) · Configuration Hierarchy [06 §6](../architecture/06-MULTI-TENANT-SAAS.md) · Connector Platform [25](../architecture/25-CONNECTOR-PLATFORM.md) · Model Adapter Layer [08 §8a](../architecture/08-AI-ML-PLATFORM.md).
- **Full index:** [`docs/README.md`](../README.md) (sections 00–28 + reference + ADRs).

## The five laws (never break)

1. No industry/customer logic in the core (it lives in `plugins/`). 2. Everything is a composable capability. 3. Event-/rule-/workflow-driven. 4. API-first & contract-first. 5. Secure & isolated by default. Full text: [Constitution §3](../00-ENGINEERING-CONSTITUTION.md).

## Tech stack (ratified)

TypeScript + **Fastify** (control/data plane), Python + **FastAPI** (vision), React+Vite+Tailwind (web), **MongoDB**, **Redis**, **MinIO**, **NATS JetStream** (event backbone), Docker/Compose, Vitest/Pytest/Playwright. Vision (future): ONNX Runtime, OpenCV, YOLO/RT-DETR/SAM2/ByteTrack. Details + rationale: [`docs/reference/TECH-STACK.md`](../reference/TECH-STACK.md). Recent stack ADRs: [0016 NATS](../adr/ADR-0016-nats-jetstream-event-backbone.md), [0017 Fastify](../adr/ADR-0017-fastify-control-plane.md).

## Where we are right now

- **Phase 0 — Program Setup.** First industry target: **Retail/Supermarket** (as plugins, never core).
- Live status / current slice / next step: [`docs/tracker/MASTER_PROGRESS.md`](../tracker/MASTER_PROGRESS.md) · Next work: [`tracking/TASK-BOARD.md`](../../tracking/TASK-BOARD.md).

## How to continue (any AI)

Read [`HOW_TO_CONTINUE.md`](HOW_TO_CONTINUE.md) → [`tracking/AGENT-ONBOARDING.md`](../../tracking/AGENT-ONBOARDING.md). Follow the rules in [`DEVELOPMENT_RULES.md`](DEVELOPMENT_RULES.md). Implement **one slice at a time**; update docs + trackers before stopping; never jump ahead; never redesign the frozen architecture.

## Map of the continuity docs

- `docs/ai/` — this brain, [PROJECT_STATE](PROJECT_STATE.md), [CURRENT_CONTEXT](CURRENT_CONTEXT.md), [CURRENT_PRIORITIES](CURRENT_PRIORITIES.md), [CURRENT_ARCHITECTURE](CURRENT_ARCHITECTURE.md), [HOW_TO_CONTINUE](HOW_TO_CONTINUE.md), [IMPLEMENTATION_GUIDE](IMPLEMENTATION_GUIDE.md), [PROMPT_GUIDE](PROMPT_GUIDE.md), [COMMON_COMMANDS](COMMON_COMMANDS.md), [DEVELOPMENT_RULES](DEVELOPMENT_RULES.md).
- `docs/project/` — program status/backlog/decisions/timeline (see [index](../project/README.md)).
- `docs/tracker/DAILY_LOG.md` — rolling engineering log; `docs/tracker/REVIEW_HISTORY.md` — per-slice reviews.
- `tracking/` — canonical roadmap/progress/task-board/milestones/tech-debt.
