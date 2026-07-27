# Engineering Decision Log

> **Append-only.** Every engineering decision is recorded here and never deleted. Architectural decisions that change the frozen v1.0 design also get a full [ADR](../adr/); this log captures the broader set (tooling, process, dependency, implementation calls) and cross-references the ADR where one exists.
>
> Schema per entry: **Date · Decision · Alternatives Considered · Reason · Impact · Owner · Status · Future Review Required**.
> Statuses: `Accepted` · `Superseded` · `Reversed` · `Provisional`.

---

## ED-0001 — Monorepo: pnpm workspace + Turborepo

- **Date:** 2026-07-27 · **Slice:** 0 (P0-1)
- **Decision:** Single polyglot-friendly monorepo using pnpm workspaces + Turborepo for TS; Python under `ai/` managed separately.
- **Alternatives Considered:** npm/yarn workspaces (weaker perf/dedup); Nx (heavier, opinionated); multi-repo (coordination overhead, contract drift).
- **Reason:** Contract-first design needs one place for `@vip/contracts`; Turborepo gives cached, dependency-ordered task graphs; pnpm gives strict, fast, disk-efficient installs.
- **Impact:** All packages/services/plugins live in one tree; CI installs once; import-graph boundaries are machine-enforceable.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** No

## ED-0002 — Event backbone: NATS + JetStream

- **Date:** 2026-07-27 · **Slice:** 0 · **ADR:** [0016](../adr/ADR-0016-nats-jetstream-event-backbone.md)
- **Decision:** NATS JetStream as the durable event backbone, with leaf nodes at the edge. Resolves open decision ND-1.
- **Alternatives Considered:** Kafka/Redpanda (heavier ops, edge story weaker); Redis Streams (durability/scale limits); cloud-proprietary buses (lock-in).
- **Reason:** Lightweight, edge-first leaf-node topology, durable streams, low operational weight — fits edge+cloud placement (ADR-0004).
- **Impact:** Event contracts target JetStream semantics; TECH-STACK + docs 04/09/18 updated.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** Yes (load-validate in P2/P4)

## ED-0003 — TS/service framework: Fastify

- **Date:** 2026-07-27 · **Slice:** 0 · **ADR:** [0017](../adr/ADR-0017-fastify-control-plane.md)
- **Decision:** Fastify + TypeScript for all Node services (replaces the Express placeholder). Python vision stays on FastAPI.
- **Alternatives Considered:** Express (weaker TS/JSON-Schema story, lower throughput); NestJS (heavy DI we don't need over our own layering).
- **Reason:** Native JSON-Schema validation aligns with contract-first (Law 4); strong TS types; high throughput; clean plugin model.
- **Impact:** Service template (P0-7) and all future TS services use Fastify.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** No

## ED-0004 — Docker dev-stack host ports in the 4xxxx range

- **Date:** 2026-07-27 · **Slice:** 0 (P0-4)
- **Decision:** Map dev-stack host ports to a non-standard `4xxxx` range (Mongo 47017, Redis 46379, MinIO 49000/49001, NATS 44222/48222).
- **Alternatives Considered:** Standard ports (27017/6379/9000/4222); random ephemeral ports (non-deterministic).
- **Reason:** The developer runs other MERN Docker projects on the standard ports; deterministic non-conflicting ports avoid collisions.
- **Impact:** `.env.example` + compose use these ports; container-internal ports stay standard and are overridable.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** No

## ED-0005 — Contracts: Zod 4 with native JSON-Schema generation

- **Date:** 2026-07-27 · **Slice:** 1 (P0-2)
- **Decision:** Adopt Zod 4 as the schema DSL; generate JSON Schema via Zod 4 native `z.toJSONSchema()`; remove `zod-to-json-schema`.
- **Alternatives Considered:** Zod 3 + `zod-to-json-schema` (extra dep, lags); TypeBox (less ergonomic inference); hand-written JSON Schema (drifts from types).
- **Reason:** One source of truth (Zod) yields both TS types and language-neutral JSON Schema with no converter dependency.
- **Impact:** Code changes applied (`z.uuid()`, `z.iso.datetime()`, `z.record(k,v)`); codegen emits 7 schemas; consumed by the contract-testing harness.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** No

## ED-0006 — TypeScript pinned to 5.9.3 (defer 7.x)

- **Date:** 2026-07-27 · **Slice:** 1 (P0-2) · **Debt:** [TD-1](../../tracking/TECH-DEBT.md)
- **Decision:** Pin TypeScript to latest stable **5.9.3** instead of registry-latest 7.0.2.
- **Alternatives Considered:** Adopt TS 7.0.2 (registry latest); disable type-aware linting to allow TS 7.
- **Reason:** `typescript-eslint@8.65` (latest) hard-refuses TS 7 (peer `<6.1.0`); TS 7 would disable type-aware lint rules — an unacceptable gap for a foundation.
- **Impact:** Full quality gate works today; recorded as TD-1 with pay-down trigger (typescript-eslint#10940). User confirmed.
- **Owner:** Claude · **Status:** Provisional (revisit on TS7 lint support) · **Future Review:** Yes

## ED-0007 — pnpm supply-chain build approval (esbuild)

- **Date:** 2026-07-27 · **Slice:** 1 (P0-2)
- **Decision:** Explicitly allow the `esbuild` install/build script via `pnpm-workspace.yaml` (`allowBuilds` + `onlyBuiltDependencies`).
- **Alternatives Considered:** Globally disable pnpm's build-script blocking (removes a security control); avoid tools needing native postinstall.
- **Reason:** pnpm ≥10 blocks postinstall scripts by default (supply-chain safety); esbuild (required by Vitest) needs its platform binary. Allowlist the minimum.
- **Impact:** Only esbuild is approved; everything else stays blocked-by-default.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** No

## ED-0008 — Import-graph enforcement as a zero-dependency in-repo tool

- **Date:** 2026-07-27 · **Slice:** 2 (P0-3)
- **Decision:** Build `tools/import-graph/` (Node, zero deps) driven by a declarative `boundaries.json`, rather than adopt an off-the-shelf checker.
- **Alternatives Considered:** `dependency-cruiser` (capable but heavier config + a dependency); ESLint import rules (per-package, weaker cross-package graph + cycle detection).
- **Reason:** Rules mirror our specific bounded-context boundaries (docs 22/23); zero deps runs anywhere; negative-tested for correctness.
- **Impact:** CI enforces noDeepImports / noCoreToPlugin / noCrossServiceInternals / noCycles on every push.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** Yes (extend to forbid cross-context DB access in P0/P1)

## ED-0009 — CI SAST via pip-installed Semgrep; pnpm audit advisory

- **Date:** 2026-07-27 · **Slice:** 2 (P0-3)
- **Decision:** Run Semgrep in CI via `pip install semgrep` with curated rulesets; keep `pnpm audit` non-blocking (`continue-on-error`).
- **Alternatives Considered:** A Semgrep marketplace action of uncertain version/token needs (violates "don't assume versions"); blocking audit (would hard-fail on unfixable transitive advisories).
- **Reason:** Self-contained, pinned rulesets; advisories stay visible without blocking merges on things outside our control.
- **Impact:** `security` job deterministic; `dependency-audit` informative. Secrets scanned by gitleaks with an allowlist for `.env.example`.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** Yes (add SARIF upload if GHAS available)

## ED-0010 — Dependabot scoped to GitHub Actions only

- **Date:** 2026-07-27 · **Slice:** 2 (P0-3)
- **Decision:** Dependabot updates the `github-actions` ecosystem only; npm/pnpm bumps remain manual.
- **Alternatives Considered:** Full Dependabot npm coverage (bypasses the manual registry-verification policy); no Dependabot (actions drift).
- **Reason:** The dependency policy requires human registry-verification for npm; Actions pinning is low-risk and safe to automate.
- **Impact:** Action SHAs stay current; application lockfile only changes under review.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** No

## ED-0011 — One-time repo-wide Prettier baseline

- **Date:** 2026-07-27 · **Slice:** 2 (P0-3)
- **Decision:** Format the whole repo once (committed separately as `style:`) so the CI `format:check` gate is enforceable.
- **Alternatives Considered:** Exclude prose docs from Prettier (weakens the gate); leave 100 files unformatted (gate can't be required).
- **Reason:** A meaningful format gate requires a clean baseline. proseWrap=preserve → cosmetic only, no prose reflow.
- **Impact:** All committed files are Prettier-clean; baseline isolated in commit `2c5e26b`.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** No

## ED-0012 — Prometheus per-instance registry (not global default)

- **Date:** 2026-07-27 · **Slice:** 3 (P0-7)
- **Decision:** Each service builds its own `prom-client` `Registry`; default metrics + histograms register against it.
- **Alternatives Considered:** Global default registry (shared singleton).
- **Reason:** The global registry throws "metric already registered" when multiple app instances exist (notably in tests); per-instance registries are clean and testable.
- **Impact:** `buildServer()` returns an isolated registry per app; tests run without collisions.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** No

## ED-0013 — Tenant-context as a non-enforcing seam in Phase 0

- **Date:** 2026-07-27 · **Slice:** 3 (P0-7)
- **Decision:** The identity service's tenant-context plugin validates inbound headers against the `TenantContext` contract but does **not** enforce presence yet.
- **Alternatives Considered:** Enforce tenant context now (impossible without auth); omit the seam entirely (loses the template shape).
- **Reason:** Auth (which mints tenant context) lands in P1; the seam demonstrates Law 5 plumbing without pretending enforcement exists.
- **Impact:** Documented clearly; enforcement + isolation tests are a P1 deliverable. Business routes must not trust `request.tenantContext` until then.
- **Owner:** Claude · **Status:** Provisional (enforcement in P1) · **Future Review:** Yes

## ED-0014 — Adopt the Architect governance framework

- **Date:** 2026-07-27 · **Slice:** 3 (governance)
- **Decision:** Institute the mandated governance artifacts (this log, risk register, assumptions, open questions, constraints, quality gates, API inventory, per-slice test scenarios, per-sprint review history, templates, per-slice Definition of Done, end-of-sprint validation, and architect handoff) as permanent, ongoing policy — backfilled for Slices 0–3.
- **Alternatives Considered:** Lightweight ad-hoc notes (insufficient for external architect review); defer until later phases (loses early history).
- **Reason:** External architect review requires self-contained, structured, append-only records; early establishment prevents historical loss.
- **Impact:** Every future slice updates these before it is considered Done; see [DEFINITION_OF_DONE](DEFINITION_OF_DONE.md) and [QUALITY_GATES](QUALITY_GATES.md).
- **Owner:** Claude · **Status:** Accepted · **Future Review:** No

## ED-0015 — Model Registry = MLflow + Postgres backend + MinIO artifacts

- **Date:** 2026-07-27 · **Slice:** 4 (P0-5)
- **Decision:** Stand up the Model Registry as **MLflow** (tracking + model registry) with a **Postgres** backend store and **MinIO/S3** artifact store, served with `--serve-artifacts` so clients need only `MLFLOW_TRACKING_URI`.
- **Alternatives Considered:** MLflow with a **SQLite/file** backend (no concurrency, not production-like, model-registry needs a DB); Weights & Biases / Neptune (SaaS, lock-in, cost); a bespoke registry (reinventing lineage/versioning).
- **Reason:** Doc 08 §2 mandates an "MLflow-class registry + object storage"; Postgres is the production-representative backend; serve-artifacts keeps client config minimal and avoids spreading S3 creds.
- **Impact:** New compose services (`mlflow`, `mlflow-postgres`, `createbuckets`) + a pinned MLflow image. Validated end-to-end (log run → MinIO artifact → register model → read back).
- **Owner:** Claude · **Status:** Accepted · **Future Review:** Yes (harden auth/TLS + run as a managed service beyond dev)

## ED-0016 — Dataset Registry = DVC with an S3 (MinIO) remote

- **Date:** 2026-07-27 · **Slice:** 4 (P0-5)
- **Decision:** Use **DVC** (remote on MinIO bucket `vip-datasets`) for dataset versioning; initialise at repo root; credentials via `.dvc/config.local`/env, never committed.
- **Alternatives Considered:** **lakeFS** (heavier infra, git-like over object store — revisit if we need branchable data at scale, Q-010); raw S3 prefixes (no lineage/versioning); Git LFS (not built for large ML datasets).
- **Reason:** Doc 08 §3 names DVC/lakeFS; DVC is lightweight, git-native (pointer files), and integrates with the same MinIO store. Good default for the bootstrap.
- **Impact:** `.dvc/config`, `.dvcignore`, `ai/datasets/` added; `/datasets/` gitignore scoped to root so `ai/datasets/` pointers/READMEs are tracked.
- **Owner:** Claude · **Status:** Accepted · **Future Review:** Yes (lakeFS comparison at data scale — Q-010)

## ED-0017 — MLOps config stdlib-only + a dedicated Python CI job; Postgres 17 pin

- **Date:** 2026-07-27 · **Slice:** 4 (P0-5)
- **Decision:** Keep `ai/mlops/config.py` **stdlib-only** so it is unit-testable without MLflow/DVC; add a CI `mlops` job running those tests on Python 3.12 (no pip install). Pin **postgres:17** and **python:3.12-slim** (not the newest 18/3.14) for compatibility certainty.
- **Alternatives Considered:** Put config in the Python workspace (deferred to P3); require heavy deps to test (slow, flaky CI); use newest images (unvalidated defaults).
- **Reason:** A runnable, dependency-free test gives real CI coverage now; conservative image pins avoid unproven defaults. MLflow 3.x host-header protection also required an explicit `--allowed-hosts` for the compose service name.
- **Impact:** CI gains a `mlops` job in the `ci-summary` rollup; DEPENDENCIES notes the 17/3.12 deferrals (Q-008).
- **Owner:** Claude · **Status:** Accepted · **Future Review:** Yes (adopt a Python dep lockfile + linter — Q-011)

## ED-0018 — `.env`-only secrets + centralized `@vip/config`

- **Date:** 2026-07-27 · **Slice:** 5 (P0-6) · **ADR:** [0018](../adr/ADR-0018-env-only-secrets-and-centralized-config.md)
- **Decision:** `.env` is the only secrets source (no external secret manager); build `@vip/config` — a centralized, typed, fail-fast, grouped config package that every TS service loads config through (no code reads `process.env` directly). Resolves Q-006.
- **Alternatives Considered:** Vault (self-host infra burden); cloud KMS/Secrets Manager (cloud coupling); a `SecretsProvider` abstraction now (no immediate 2nd impl); `dotenv` (unneeded — Node `process.loadEnvFile()`).
- **Reason:** Repo-owner deployment directive — `cp .env.example .env && docker compose up -d`, no extra infra. Simplicity + prod/self-host parity; zero new deps.
- **Impact:** New `packages/config`; identity refactored onto it; `.env.example` header + doc 15 §4 reconciled; external managers documented as future-only extension points. Reverses the earlier "Vault/KMS" P0-6 framing.
- **Owner:** Repo owner + Claude · **Status:** Accepted (supersedes the Vault/KMS assumption) · **Future Review:** Yes (only if an enterprise customer mandates a managed store)

## ED-0019 — Phase 1 re-scoped to an end-to-end vertical ("Core Platform")

- **Date:** 2026-07-27 · **Slice:** Phase 1 planning
- **Decision:** Define Phase 1 as a thin **camera → alert vertical** (P1-1 Tenant, P1-2 Auth, P1-3 Camera, P1-4 RTSP Ingestion, P1-5 Events, P1-6 AI Inference, P1-7 Rules, P1-8 Alerts), documented under [`docs/architecture/phase1/`](../architecture/phase1/README.md). Enterprise breadth (billing/metering, full entitlements, hash-chained audit, connectors, industry packs, digital twin, analytics) moves to **Phase 3**; the old horizontal "SaaS Foundation" P1 list is superseded.
- **Alternatives Considered:** Keep the horizontal Phase 1 (all SaaS-foundation services before any perception) — slower to a demonstrable product, integration risk deferred to the end.
- **Reason:** Owner directive + fastest path to a testable, sellable spine; each slice consumes the previous stage's real output, so integration is proven continuously. **Frozen architecture (01–28) is unchanged — only the delivery order is.**
- **Impact:** New `PROJECT_ROADMAP` + `phase1/` blueprint; `tracking/TASK-BOARD` Phase 1 list realigned; deferred items relabeled Phase 3. No architecture section edited.
- **Owner:** Repo owner + Claude · **Status:** Accepted · **Future Review:** No (delivery-plan; revisit at Phase 1 exit)
