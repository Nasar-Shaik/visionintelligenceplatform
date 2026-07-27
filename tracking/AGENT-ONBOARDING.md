# Agent Onboarding Protocol

> **Mandatory entry point for any AI coding agent or new engineer.**
> This repository is designed to be worked on by many agents over many years, each starting cold. This document is how you acquire context in minutes and continue work correctly **without any conversation history**.

## 0. The contract

You are one of many contributors. You will start with **no memory** of prior work. Everything you need is written down. In return, **you must write down everything the next agent will need.** An unrecorded decision or an un-updated status file is a defect.

## 0.1 Where to find each thing (AI-agent continuity map)

Any assistant (Claude Code, Codex, ChatGPT, Gemini, Kimi, or a future system) can acquire full context from these fixed locations — no conversation history required:

| You need… | Read |
|---|---|
| **Architecture** (the whole system) | [`docs/`](../docs/) → [`00-ENGINEERING-CONSTITUTION`](../docs/00-ENGINEERING-CONSTITUTION.md), sections 01–26 |
| **Current status** (where are we) | [`PROGRESS.md`](PROGRESS.md) |
| **Coding standards** | [`docs/architecture/03-ARCHITECTURE-PRINCIPLES`](../docs/architecture/03-ARCHITECTURE-PRINCIPLES.md) + [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| **Roadmap** | [`ROADMAP.md`](ROADMAP.md) |
| **Pending work** | [`TASK-BOARD.md`](TASK-BOARD.md) |
| **Completed work** | [`PROGRESS.md`](PROGRESS.md) + `TASK-BOARD.md` → Done |
| **Design decisions** (why) | [`docs/adr/`](../docs/adr/) |
| **Technical debt** | [`TECH-DEBT.md`](TECH-DEBT.md) |
| **Next priorities** | [`TASK-BOARD.md`](TASK-BOARD.md) → Now |
| **Domain/service ownership** | [`docs/architecture/22-BOUNDED-CONTEXTS`](../docs/architecture/22-BOUNDED-CONTEXTS.md), [`23-SERVICE-OWNERSHIP`](../docs/architecture/23-SERVICE-OWNERSHIP.md) |
| **Control vs Data plane** | [`docs/architecture/27-CONTROL-DATA-PLANE`](../docs/architecture/27-CONTROL-DATA-PLANE.md) |
| **Governance / policy** (who/what/where/when) | [`docs/architecture/28-POLICY-ENGINE`](../docs/architecture/28-POLICY-ENGINE.md) |
| **Freeze status & Go/No-Go** | [`docs/ARCHITECTURE-READINESS-REVIEW`](../docs/ARCHITECTURE-READINESS-REVIEW.md) |

If any of these is stale or contradicts the code, fixing it is part of your task — the docs must never lie.

> **Architecture is FROZEN at v1.0 (2026-07-27).** Sections 01–28 + ADRs 0001–0015 are the baseline. You may implement freely against it, but any change to the *architecture itself* requires a new ADR ([`docs/adr/`](../docs/adr/)) before code — never edit a frozen decision silently.

## 1. Read-in sequence (do this every time you start)

1. [`README.md`](../README.md) — what the platform is and the repo layout.
2. [`docs/00-ENGINEERING-CONSTITUTION.md`](../docs/00-ENGINEERING-CONSTITUTION.md) — the laws you must not break.
3. [`tracking/PROGRESS.md`](PROGRESS.md) — **the current state of the world.** What phase we are in, what is done, what is in flight, and by whom/what.
4. [`tracking/TASK-BOARD.md`](TASK-BOARD.md) — the actionable backlog (Now / Next / Later).
5. [`tracking/ROADMAP.md`](ROADMAP.md) — the phase plan and where the current work sits within it.
6. Any ADRs in [`docs/adr/`](../docs/adr/) touching your area — decisions already made that you must respect.
7. The `README.md` of the specific `services/`, `ai/`, `edge/`, `packages/`, or `plugins/` directory you will work in.

If, after this sequence, you cannot determine what to do next, the failure is in the tracking files — **fix the tracking files first** (make the ambiguity explicit), then proceed.

## 2. Picking work

- Take the top item from **TASK-BOARD.md → Now**. If empty, pull the highest-priority item from **Next** that has no unmet dependency (dependencies are stated on each item).
- Confirm it does not conflict with an `in_progress` item owned by another agent (see PROGRESS.md).
- Mark the item `in_progress` in TASK-BOARD.md with your identifier and the date **before** you start.

## 3. Doing work — the invariants

Every change must satisfy the [Engineering Constitution](../docs/00-ENGINEERING-CONSTITUTION.md). The non-negotiables:

- **No industry/customer logic in the core.** If your change encodes "retail" or "hospital" behavior anywhere under `services/`, `ai/`, or `packages/`, it is wrong — it belongs in `plugins/`.
- **Contract-first.** Change or add the contract (in `packages/contracts`) before the implementation. Contracts are versioned; do not break a published contract without an ADR.
- **Tenant context is mandatory.** No data access without a resolved `tenantId`. No exceptions.
- **Capabilities are self-describing and swappable.** A capability must not hardcode a model, a vendor, or a downstream consumer.
- **Tests travel with code.** New capability → contract test + unit test. New rule/workflow primitive → evaluator test. Cross-tenant access → an isolation test that proves it fails.

## 4. Recording work (do this before you stop)

You are not done until the record is updated:

1. **PROGRESS.md** — move the item's status; note what changed, what remains, and any landmine you hit. Write it for a stranger.
2. **TASK-BOARD.md** — mark done / re-queue; add any follow-up tasks you discovered (with dependencies).
3. **ADR** — if you made a decision that changes a contract, boundary, technology, or principle, write an ADR (copy [`docs/adr/ADR-TEMPLATE.md`](../docs/adr/ADR-TEMPLATE.md), next number, link it from the affected architecture section).
4. **Architecture docs** — if the design changed, update the relevant `docs/architecture/NN-*.md` so the docs never lie.
   - **Technical debt** — if you took a deliberate shortcut, record it in [`TECH-DEBT.md`](TECH-DEBT.md) (never leave undocumented debt).
5. **Milestone check** — if your work completes a milestone gate in [`MILESTONES.md`](MILESTONES.md), tick it and note the evidence (test run, demo, metric).

## 5. Definition of Done (every task)

- [ ] Contract added/updated and versioned (if applicable).
- [ ] Implementation matches the contract; no core dependency on any plugin.
- [ ] Tenant isolation preserved; isolation test present for new data paths.
- [ ] Unit + integration tests pass; new behavior covered.
- [ ] Observability: the new path emits metrics/traces/logs per [16-OBSERVABILITY](../docs/architecture/16-OBSERVABILITY.md).
- [ ] Docs and tracking updated (§4 above).
- [ ] No secrets, no PII in logs, no hardcoded tenant/customer values.

## 6. When you are blocked or the spec is ambiguous

Do **not** invent a customer workflow to unblock yourself. Instead:
1. Record the ambiguity as a task in TASK-BOARD.md under **Needs-Decision**, with the options and a recommendation.
2. If it changes architecture, draft an ADR in `Proposed` status.
3. Pick the next unblocked task and continue.

## 7. Identifiers

When you edit tracking files, sign your entries: `[<agent-or-name> · YYYY-MM-DD]`. This is how the next agent knows who touched what and when — the only "history" that survives a cold start.

## 8. Landing it in git

How your change becomes a commit/branch/PR is governed by [`../CONTRIBUTING.md`](../CONTRIBUTING.md): branch off `main` (`feature/*`, `fix/*`, …), use Conventional Commits, keep `main` always-green, and merge only when the Definition of Done (§5) and CI pass. ADR-before-code for any architectural change.
