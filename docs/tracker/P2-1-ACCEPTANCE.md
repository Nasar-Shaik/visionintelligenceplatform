# P2-1 Operations Console — Milestone Acceptance Review

_Reviewer: Claude (on behalf of the Principal Architect acceptance gate) · Date: 2026-07-30 ·
Branch: `feature/v1`_

## Verdict

**P2-1 (enabler-free scope) — ✅ ACCEPTED / COMPLETE.**
**P2-1 (full milestone as originally scoped) — 🟡 PARTIALLY COMPLETE** — the flagship
camera/live-video/recorded-analysis/evidence slices remain **blocked on backend enablers G-1…G-6**
and are explicitly out of the accepted scope.

The delivered tranche — the operator-facing SOC console over the existing camera→alert vertical, plus
the developer-experience/bootstrap hardening — satisfies its acceptance criteria and is accepted. The
milestone is **not** closed in full; a follow-on enabler milestone is required (see §10).

### Accepted scope (9 slices + DX hardening)

| Slice   | Subject                                                                                      | Status |
| ------- | -------------------------------------------------------------------------------------------- | ------ |
| P2-1.0  | Foundation (`apps/console`, `app` import-graph layer, tokens, store, router, gateway client) | ✅     |
| P2-1.1  | Design System (19 primitives + 13 SOC composites, `/design` gallery)                         | ✅     |
| P2-1.2  | Authentication (in-memory access token, rotating refresh, silent refresh, permission gating) | ✅     |
| P2-1.3  | App Shell & Navigation (permission-gated nav, topbar, logout)                                | ✅     |
| P2-1.4  | Dashboard (KPIs + active-incidents + camera-health, polling)                                 | ✅     |
| P2-1.8  | Events (filterable, cursor-paginated timeline)                                               | ✅     |
| P2-1.9  | Rules (list/author/enable-disable/delete + dry-run + version history)                        | ✅     |
| P2-1.10 | Incidents (queue + detail drawer + ack/resolve/close lifecycle)                              | ✅     |
| P2-1.11 | Alerts (delivery log + acknowledge)                                                          | ✅     |
| DX      | Local bootstrap: `dev:all`, `pnpm seed`, deterministic tests, gateway login fix              | ✅     |

### Not in accepted scope (blocked on G-1…G-6)

P2-1.5 Cameras · P2-1.6 Live Monitoring · P2-1.7 Recorded Analysis · P2-1.12 Evidence Viewer ·
P2-1.13 System Health + Settings · P2-1.14 Demo hardening.

---

## 1. Architecture compliance

**Compliant.** No frozen architecture document (01–28) was modified. No new backend platform service
was created. The console was added as a new `apps/` layer governed by [ADR-0019](../adr/ADR-0019-operations-console-and-apps-layer.md)
and [ED-0030](../project/ENGINEERING_DECISION_LOG.md).

- **Import-graph enforced:** `check:imports` reports **0 violations** across 18 packages. The `app`
  layer imports shared `packages/*` only (types from `@vip/contracts`, PDP from `@vip/permissions`);
  it never imports a service or plugin, and nothing imports the app (`noImportApp`, `noAppToBackend`).
- **Contract-first:** every gateway shape the console consumes exists in `@vip/contracts`;
  `verify:contracts` reports 30 schemas valid (draft 2020-12).
- **Frozen UI stack honoured:** React 19, TypeScript, Vite, Tailwind v4, shadcn/ui (Radix), Redux
  Toolkit, TanStack Query, React Router, RHF+Zod, Lucide, Recharts — no disallowed UI framework added.
- **State-ownership discipline:** TanStack Query = server state; Redux = client/session/UI/live; URL =
  view state. No overlap.
- **Deviation logged, not hidden:** implementation proceeded in the **enabler-free order**
  (Events→Rules→Incidents→Alerts) rather than the numeric order, because Cameras/Live/Analysis depend
  on unbuilt enablers. This was flagged in the tracker each slice, not done ad hoc.
- **One backend change during the DX pass** (gateway public-auth passthrough for
  `POST /api/identity/auth/{login,refresh,logout}`) was a _fix to an incomplete gateway_, not a new
  capability — see §8. It is a reviewed service extension in spirit and is covered by tests.

## 2. Code quality summary

- **Typecheck:** clean (`tsc` strict, 26/26 turbo tasks). `exactOptionalPropertyTypes` respected.
- **Lint:** clean (18/18), including the console's custom no-hardcoded-hex/px rule and
  `consistent-type-imports`.
- **Formatting:** `format:check` clean repo-wide.
- **Consistency:** every slice follows the same shape — typed `lib/api/*` module → TanStack
  Query/mutation hooks → `*Page` + composites → MSW-mocked tests → tracker update. Reusable
  `QueryBoundary` standardises loading→error→empty→content on every data surface.
- **Accessibility:** WCAG-AA contrast over oklch tokens; keyboard focus via a shared `focus-ring`
  utility; severity/status never colour-only; `prefers-reduced-motion` honoured.
- **Build:** production build green (18/18).

## 3. Test coverage summary

- **Unit (deterministic, no infra):** **396 tests across 18 suites** — `pnpm test`. Includes 37
  console component tests (10 files) driving every data surface + permission-gating path against a
  mocked gateway (MSW).
- **Integration (real infra):** **23 tests across 9 suites** — `pnpm test:integration`, validated
  green against the live dev stack (Mongo/MinIO): persistence, tenant isolation, keyset pagination.
- **Python:** inference/mlops suites run separately via pytest (outside `pnpm test`).
- **End-to-end (manual, validated this review):** `dev:stack → seed → dev:all` → **10/10 services +
  console healthy**, login `200`, and the seeded incident/event/alert are queryable through the
  gateway.
- **Gap:** no automated cross-service **E2E** suite yet (the vertical is proven by service-level
  integration tests + the manual walkthrough, not an automated browser E2E).

## 4. Developer experience improvements

The clean-clone path now works and every documented command is verified to exist and run:

```
pnpm install → pnpm dev:stack → pnpm seed → pnpm dev:all → http://localhost:5173
```

- **`pnpm dev:all`** — all 9 services + console concurrently (Turborepo persistent tasks).
- **`pnpm seed`** — idempotent bootstrap of tenant + admin + camera/rule/event/incident/alert,
  direct-to-Mongo (no services needed). Default creds: `tnt_dev` / `admin@vip.dev` / `DevPassw0rd!`.
- **Deterministic tests** — `pnpm test` excludes integration; `pnpm test:integration` is the
  infra-backed tier. Fixes the prior non-deterministic failure.
- **Turbo warnings removed**; distinct default service ports (no 8080 collisions);
  `loadDotEnv` finds the repo-root `.env` from any cwd.
- **Docs split & verified:** `RUN_LOCAL.md` + `docs/setup/{README,DAILY_DEVELOPMENT,RUN_FULL_STACK,TESTING,DEMO}.md`.

## 5. Remaining technical debt

| Item                                                                                                   | Impact              | Suggested owner/milestone                   |
| ------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------- |
| Console JS bundle ≈ 352 kB gz (no route-level code-splitting)                                          | Perf (initial load) | Console hardening pass                      |
| No automated browser E2E suite                                                                         | Coverage confidence | Enabler/QA milestone                        |
| Seed inserts incident/alert **documents** directly rather than driving them through the NATS pipeline  | Demo realism        | Nice-to-have                                |
| `dev:all` assumes `dev:stack` is up (no ordering)                                                      | DX papercut         | Optional wrapper script                     |
| Benign Node `ExperimentalWarning: localStorage` in jsdom console tests                                 | Cosmetic            | Optional vitest tweak                       |
| `/auth/me` returns `permissions: []` (roles are authoritative; console expands via `@vip/permissions`) | None today          | Revisit if server-computed perms are wanted |

## 6. Known limitations

- **Six P2-1 slices are unbuilt** (Cameras, Live, Analysis, Evidence, Health/Settings, Demo) — blocked
  on backend enablers **G-1…G-6**. The console ships labelled placeholder pages for these routes.
- **Original success criteria only partially met:** login → events → incidents → alerts ✅; register
  RTSP camera → live video → upload → analyze → evidence ❌ (need the unbuilt slices + enablers).
- **Real-time is polling**, not streaming (Dashboard/queues poll every 15–20 s); SSE/WebSocket arrives
  with enabler **G-5**.
- **No in-console user management** yet — additional users (viewer/operator) are created via the
  identity API, not the UI.

## 7. Performance observations

- Query keys are shared between KPI cards and panels, so each dashboard resource is fetched **once**
  per poll (no N+1 from the aggregation).
- Cursor pagination (`useInfiniteQuery`) on Events/Incidents/Alerts avoids unbounded lists.
- Poll intervals (15–20 s) are conservative and appropriate until SSE lands.
- Production bundle ~352 kB gz — acceptable for an internal operator console; code-splitting is the
  first optimisation when it matters.
- Service integration tests complete in well under a second each; no persistence hot-spots observed at
  dev scale.

## 8. Security observations

- **Deny-by-default UX:** nav + every mutating action is permission-gated via the same PDP the
  services use (`can`, wildcard-aware). The gateway remains the real authorization boundary; the UI
  gate is UX only.
- **Token hygiene:** access token in memory only (XSS-safe); rotating refresh token persisted with
  reuse-detection server-side; single-flight silent refresh.
- **Gateway trust boundary intact.** The DX pass added a **narrow** public passthrough for identity
  `POST /auth/{login,refresh,logout}` (a client must be able to obtain a token). It:
  - forwards `x-tenant-id` as a **lookup scope only** (credentials are still verified by identity —
    validated: a wrong tenant still returns `401`, not a bypass);
  - continues to **strip privilege/internal headers** (`x-principal-id`, `x-roles`, `x-internal-key`)
    so a client cannot forge identity or reach internal endpoints on the public path;
  - is covered by 3 new gateway tests.
- **Cross-tenant isolation** remains enforced by `@vip/tenancy` + the standing isolation suite
  (integration tests green).
- **Secrets:** `.env`-only (ADR-0018); dev credentials are intentionally weak and documented as
  dev-only. **The seed's default password must never be used outside local dev.**

## 9. Production readiness

**Not production-ready — and not intended to be at this milestone.** This is a **dev/demo-grade**
console over a **dev-grade** backend. Blockers to production:

- Six functional slices unbuilt (§6); enablers G-1…G-6 not started.
- No CORS/edge hardening (enabler G-5), no SSE, no CDN/code-splitting, no browser E2E.
- Dev infrastructure (single-node Docker Mongo/MinIO/NATS), weak dev secrets.
- No load/soak testing, no HA/DR (Phase 4).

For its **intended purpose** — an operator console to demonstrate and drive the camera→alert vertical
locally — it is complete and validated.

## 10. Recommendation for next milestone

**Recommend: a backend-enabler milestone (proposed “P2-2 — Console Enablers G-1…G-6”) before any
further console feature slices.** Rationale: the remaining P2-1 UI slices are all blocked on these
service extensions; building them unblocks Cameras/Live/Analysis/Evidence in one coherent tranche.

Suggested sequence:

1. **G-1…G-3** (camera/media/inference read + stream surfaces) → unblocks P2-1.5 Cameras, P2-1.6 Live,
   P2-1.7 Analysis.
2. **G-5** (gateway CORS/SSE) → real-time + deployed-origin support.
3. **G-4/G-6** (evidence packaging, incident assignment/comments) → P2-1.12 Evidence, richer P2-1.10.
4. Then resume console slices P2-1.5→P2-1.7, P2-1.12, P2-1.13; close with P2-1.14 demo hardening +
   route-level code-splitting + a browser E2E suite.

Each enabler is a **reviewed service extension** (not a new service) and should be submitted for
Architect review before its dependent UI slice, per the standing governance.

---

## Acceptance criteria checklist (delivered scope)

| Criterion                                            | Result                               |
| ---------------------------------------------------- | ------------------------------------ |
| Frozen architecture/docs untouched                   | ✅                                   |
| Import-graph 0 violations                            | ✅                                   |
| Contract-first (schemas present)                     | ✅                                   |
| Typecheck / lint / format clean                      | ✅                                   |
| Unit tests deterministic + green (396)               | ✅                                   |
| Integration tests green on stack (23)                | ✅                                   |
| Build green                                          | ✅                                   |
| Login → Events → Incidents → Alerts walkthrough      | ✅ (validated e2e)                   |
| Deny-by-default permission gating                    | ✅                                   |
| Clean-clone bootstrap works; docs commands all exist | ✅                                   |
| Camera register → live → upload → analyze → evidence | ❌ blocked on G-1…G-6 (out of scope) |

**Conclusion:** the enabler-free P2-1 Operations Console scope is **ACCEPTED and COMPLETE**. The full
P2-1 milestone remains open pending the enabler milestone in §10.
