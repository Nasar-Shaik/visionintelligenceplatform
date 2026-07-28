# Technical Debt Register

> The single place where known shortcuts, deferrals, and "we'll fix this later" decisions are recorded, so no agent rediscovers them the hard way. Adding debt without recording it here is a defect. Pay debt down by referencing its ID in the commit/PR that resolves it.

**How to use:** when you take a deliberate shortcut, add a row with an ID (`TD-NN`), what/why, the risk if left, and the trigger that should force paying it down. When you fix one, move it to **Resolved** with the resolving commit/PR. Sign entries `[<agent/name> · YYYY-MM-DD]`.

## Severity

`high` = correctness/security/scale risk; `medium` = maintainability/perf; `low` = cosmetic/ergonomic.

## Open debt

| ID   | Area      | What / why (the shortcut)                                                                                                                                                                                                                                                                                                                                                                            | Risk if left                                                                                                                       | Pay-down trigger                                                                                                                                                                | Sev    |
| ---- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| TD-1 | toolchain | TypeScript pinned to **5.9.3** instead of latest **7.0.2**, because `typescript-eslint` (latest 8.65) refuses TS 7.0 and type-aware linting would break. `[Claude · 2026-07-27]`                                                                                                                                                                                                                     | On latest-minus-one major of TS; miss TS7 native-compiler speed/features                                                           | typescript-eslint ships TS 7 support (typescript-eslint#10940) → bump TS to 7.x via ADR + rerun full gate                                                                       | low    |
| TD-2 | docs      | Tracker consolidated into `docs/tracker/` ([ED-0020](../docs/project/ENGINEERING_DECISION_LOG.md)), but the `docs/project/` + `docs/ai/` status files (CURRENT_STATUS, CURRENT_SPRINT, NEXT_STEPS, BACKLOG, DECISIONS, etc.) were left in place (redirected only where they'd break). Some still carry stale Phase-0 snapshots. `[Claude · 2026-07-28]`                                              | Duplicate/stale status surfaces; a future reader may trust an out-of-date file                                                     | Next doc-touching slice: reduce them to thin pointers to `docs/tracker/` + governance registers, or remove the redundant ones                                                   | low    |
| TD-3 | camera    | A camera's `zoneId` is validated for shape + tenant-scope but **not** confirmed to reference an existing `OrgNode` — cross-context existence checking is deferred to async reconciliation over `tenant.hierarchy.changed` rather than a synchronous camera→tenant call ([ED-0024](../docs/project/ENGINEERING_DECISION_LOG.md)). `[Claude · 2026-07-28]`                                             | A camera can be onboarded against a non-existent/deleted zone id until the backbone reconciles; orphaned cameras                   | P1-5 event backbone: camera subscribes to `tenant.hierarchy.changed` and rejects/repairs orphaned `zoneId`s (and validates on create against a local hierarchy cache)           | medium |
| TD-4 | media     | Extracted frames go to a **null perception sink** and media stream state is **in-memory** (per-camera workers; lost on restart). Media→camera credential resolve is authenticated by a **shared `INTERNAL_API_KEY`**, not a per-service machine principal. Recording metadata is not persisted (listed from MinIO). `[Claude · 2026-07-28]` ([ED-0025](../docs/project/ENGINEERING_DECISION_LOG.md)) | Frames aren't consumed until P1-6; a restart drops worker state (re-derivable); a leaked shared key authorizes any internal caller | P1-6 wires the real frame bus (drop-to-latest); a machine-principal/mTLS replaces the shared key; persist stream/recording state if restart-continuity or query needs demand it | medium |

## Resolved debt

| ID           | Area | Resolution | Commit/PR | Date |
| ------------ | ---- | ---------- | --------- | ---- |
| _(none yet)_ |      |            |           |      |

## Standing "intentional non-debt" (design choices that look like debt but are not)

These are deliberate, ADR-backed decisions — do **not** "fix" them without an ADR reversal:

- Pooled multi-tenancy by default (siloed only for enterprise) — [ADR-0003](../docs/adr/ADR-0003-tenant-isolation-strategy.md).
- Raw detections are ephemeral (TTL'd), only aggregates/events persist — [18-DATA-ARCHITECTURE](../docs/architecture/18-DATA-ARCHITECTURE.md).
- Smart-clip-only storage (no continuous cloud recording by default) — [12-EVIDENCE-MANAGEMENT](../docs/architecture/12-EVIDENCE-MANAGEMENT.md).
- Eventual consistency between planes (at-least-once + idempotency) — [ADR-0005](../docs/adr/ADR-0005-event-driven-backbone.md).

## Cross-references

[PROGRESS.md](PROGRESS.md) · [TASK-BOARD.md](TASK-BOARD.md) · [../docs/adr/](../docs/adr/)
