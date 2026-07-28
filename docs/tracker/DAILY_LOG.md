# Daily Development Log

> One rolling file, newest first. **Capture meaningful progress only — no exhaustive file lists** (those live in git history and per-slice [REVIEW_HISTORY](REVIEW_HISTORY.md)). One short entry per working day. Sign entries `[name · YYYY-MM-DD]`.

## 2026-07-28

- **P1-1 — Tenant foundation + fail-closed isolation (code complete, awaiting review).** Contract-first: added tenant/org-hierarchy schemas + lifecycle event types to `@vip/contracts` (9 JSON schemas). Built **`@vip/tenancy`** — the fail-closed data-layer guard (`TenantScope` + pure `scopedFilter/scopedInsert/guardUpdate/scopedPipeline` + `TenantRepository<T>` over Mongo). Built **`@vip/service-tenant`** (Fastify, from the identity template): provisioning, org hierarchy, cross-tenant **403** gate, `/ready` Mongo check, `tenant.created` publisher seam (NATS deferred to P1-5). **62 TS tests**; validated **live end-to-end against real Mongo** (provision → self-read 200 → wrong-context 403 → org-node isolation → SIGTERM). Full root gate green. Decisions [ED-0021](../project/ENGINEERING_DECISION_LOG.md) (registry vs guarded data), [ED-0022](../project/ENGINEERING_DECISION_LOG.md) (dev-stack Mongo over Testcontainers). Scenario: [slice-006](../testing/slice-006.md). `[Claude · 2026-07-28]`
- **Phase 1 blueprint approved** by the Architect. Began implementation prep.
- **Documentation optimization pass** (Architect-directed): merged the 3 Phase-1 meta-docs (IMPLEMENTATION_ORDER, DEPENDENCY_GRAPH, DEFINITION_OF_DONE) into [README](../architecture/phase1/README.md) + [ROADMAP](../architecture/phase1/ROADMAP.md) — Phase 1 docs 15 → 12. README is now the navigation page; ROADMAP is lean (objective/deps/acceptance/status per slice + sequencing + per-milestone exit).
- **Established `docs/tracker/`** as the single canonical tracker: [MASTER_PROGRESS](MASTER_PROGRESS.md) (dashboard), [REVIEW_HISTORY](REVIEW_HISTORY.md) (per-slice, replaces the 7 `docs/review/SPRINT-*` files), this log (replaces per-day files under `docs/daily/`). Redirected the redundant Phase-0 dashboards to the new canonical. Recorded as [ED-0020](../project/ENGINEERING_DECISION_LOG.md).
- **Next:** implement **P1-1** — tenant foundation + fail-closed isolation guard, contract-first.
- `[Claude · 2026-07-28]`

## 2026-07-27

- **Phase 0 built end-to-end (Slices 0–5, P0-1…P0-7):** monorepo + dev stack (ADR-0016 NATS, ADR-0017 Fastify); `@vip/contracts` (Zod 4 + JSON-Schema codegen, 19 tests); CI quality gate + import-graph + contract harness; `@vip/service-identity` Fastify reference template (19 tests) + the **engineering-governance framework**; MLOps registry (MLflow + DVC, validated live then torn down, 5 py tests); `@vip/config` **`.env`-only secrets** (ADR-0018, 14 tests). **52 TS + 5 py tests; architecture frozen v1.0; Phase 0 complete.**
- **Phase 1 architecture planning:** re-scoped Phase 1 to a **camera → alert vertical** ([ED-0019](../project/ENGINEERING_DECISION_LOG.md)); wrote the full `docs/architecture/phase1/` blueprint + PROJECT_ROADMAP. Frozen architecture 01–28 unchanged.
- Per-slice detail: [REVIEW_HISTORY](REVIEW_HISTORY.md). Notable fixes that day: import-graph self-edge false-cycle; TS pinned 5.9.3 (TD-1, typescript-eslint); MLflow 3.x allowed-hosts (R-012); Prometheus per-instance registry.
- `[Claude · 2026-07-27]`
