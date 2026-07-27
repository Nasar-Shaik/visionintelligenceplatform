# PaperlessTech Vision Intelligence Platform (VIP)

> An enterprise, multi-tenant **Vision Intelligence Platform**: a composable system that turns any camera stream (or other sensor) into structured **events**, evaluates them against customer-defined **rules**, drives **workflows**, and produces **evidence**, **alerts**, **analytics** and **reports** — across cloud, on-premise, hybrid and edge deployments.
>
> This is **not** a CCTV product and **not** an industry-specific application. It is a platform of reusable **capabilities** that compose into unlimited business solutions. Industry behavior lives in **plugins ("Industry Packs")**, never in the core.

This repository is the **single source of truth** for the platform. It is designed to be **AI-agent independent**: any engineer or AI coding assistant (Claude Code, Codex, Gemini, Kimi, or future systems) can clone it, read the documentation, understand the current project status, and continue development **without requiring historical context**.

---

## Start here

| If you are… | Read this first |
|---|---|
| **A human engineer, new to the repo** | [`docs/README.md`](docs/README.md) → [`docs/00-ENGINEERING-CONSTITUTION.md`](docs/00-ENGINEERING-CONSTITUTION.md) |
| **An AI coding agent picking up work** | [`tracking/AGENT-ONBOARDING.md`](tracking/AGENT-ONBOARDING.md) — the mandatory entry protocol |
| **A product / business stakeholder** | [`docs/architecture/01-EXECUTIVE-SUMMARY.md`](docs/architecture/01-EXECUTIVE-SUMMARY.md) |
| **Looking for "what's done / what's next"** | [`tracking/PROGRESS.md`](tracking/PROGRESS.md) and [`tracking/ROADMAP.md`](tracking/ROADMAP.md) |
| **Making a significant technical decision** | [`docs/adr/`](docs/adr/) (Architecture Decision Records) |
| **Committing / branching / opening a PR** | [`CONTRIBUTING.md`](CONTRIBUTING.md) (git workflow & Definition of Done) |

---

## Repository layout

```
vision-intelligence-platform/
├── README.md                 # You are here — project entry point
├── docs/                     # The Engineering Constitution + full architecture (source of truth)
│   ├── 00-ENGINEERING-CONSTITUTION.md
│   ├── ARCHITECTURE-READINESS-REVIEW.md  # v1.0 freeze gate + Go/No-Go
│   ├── architecture/         # Numbered architecture sections (01..28)
│   ├── adr/                  # Architecture Decision Records (immutable, append-only)
│   ├── reference/            # Glossary, tech stack, AI capability catalog
│   ├── runbooks/             # Operational runbooks (added as services ship)
│   └── diagrams/             # Source for diagrams (Mermaid/PlantUML)
├── tracking/                 # Living project-state: roadmap, progress, task board, milestones
│   ├── AGENT-ONBOARDING.md   # MANDATORY read for any agent starting work
│   ├── ROADMAP.md            # Phase 0 → Enterprise Release → Future Vision
│   ├── PROGRESS.md           # Current status of every phase/capability (the "where are we")
│   ├── TASK-BOARD.md         # Actionable backlog (Now / Next / Later)
│   ├── MILESTONES.md         # Milestone definitions & acceptance gates
│   └── TECH-DEBT.md          # Known shortcuts/deferrals register
├── services/                 # Backend services (control plane + data plane). See services/README.md
├── ai/                       # Python AI/ML: inference runtime, capability workers, MLOps
├── edge/                     # Edge agent, fleet, offline runtime
├── packages/                 # Shared libraries (contracts, SDKs, UI, permissions)
├── plugins/                  # Industry Packs & capability plugins (NO core logic depends on these)
├── infra/                    # IaC: Docker, Kubernetes/Helm, Terraform, gateway
├── tests/                    # Cross-service E2E, load, isolation, chaos suites
└── tools/                    # Dev tooling, code generators, camera simulators

(Legacy provenance — the three original analyses — is archived under docs/_archive/, not authoritative.)
```

Every top-level code directory contains a `README.md` describing its purpose, boundaries, and conventions. **The structure is self-documenting by design.**

---

## The five laws (summary — full text in the Constitution)

1. **No industry logic in the core.** Retail/Hospital/School/etc. behavior exists only as plugins.
2. **Everything is a capability.** Features are composed from reusable building blocks, never hardcoded workflows.
3. **Event-driven, rule-driven, workflow-driven.** The core reacts to events, evaluates rules, and runs workflows.
4. **API-first & contract-first.** No capability exists without a versioned, documented contract.
5. **Tenant isolation is non-negotiable.** No operation is possible without a resolved tenant context.

---

## Status

- **Phase:** Phase 0 (Architecture & Program Setup). See [`tracking/PROGRESS.md`](tracking/PROGRESS.md).
- **Architecture:** **FROZEN v1.0** (2026-07-27) — implementation-ready. Go/No-Go: ✅ GO ([readiness review](docs/ARCHITECTURE-READINESS-REVIEW.md)). All changes now go through [ADRs](docs/adr/).

## Provenance

This architecture is a **merge and reconciliation** of three prior AI-authored analyses (Fable, Grok, Gemini), now archived under [`docs/_archive/`](docs/_archive/). Those documents are **superseded** by `docs/` and retained only for historical traceability. Where they conflicted, the best engineering option was chosen and recorded as an ADR.
