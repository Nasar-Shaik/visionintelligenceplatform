# VIP — Testing & Run Guide (development so far)

> How to install, run, and test everything built to date. Written for a fresh clone on macOS/Linux.
> Last updated: 2026-07-29 · covers Phase 1 (backend vertical: camera → alert) + Phase 2 P2-1
> Operations Console slices **P2-1.0 → P2-1.4, P2-1.8 → P2-1.11**.

This guide is organised in **three tiers**, easiest and most reliable first:

| Tier  | What                                                                 | Needs                                  | Reliability                                    |
| ----- | -------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| **1** | Automated test suites + quality gates                                | Node + pnpm only                       | ✅ Deterministic, run anytime                  |
| **2** | Run & explore the console UI (shell, design system, component specs) | Node + pnpm                            | ✅ Works standalone (no live data)             |
| **3** | Full-stack end-to-end (real backend + live UI data)                  | Docker + all services + manual seeding | ⚠️ Involved — no one-command orchestration yet |

If you only do one thing: **Tier 1** proves the code is correct; **Tier 2** lets you click through the UI.

---

## 0. What exists right now

**Backend (Phase 1 — the camera→alert vertical, all 8 slices):** tenant isolation, auth/authorization,
camera registry, RTSP ingestion/recording, AI inference runtime, event pipeline, rule engine, incident
lifecycle, and the alert engine. 9 Node services + a Python inference runtime, communicating over NATS.

**Frontend (Phase 2 — Operations Console, `apps/console`):** the enabler-free slices are complete:

| Slice             | Route                                | What you can do                                                          |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| P2-1.2 Auth       | `/login`                             | Sign in (tenant + email + password); deny-by-default permission gating   |
| P2-1.3 Shell      | (all)                                | Sidebar nav, topbar, live clock, logout                                  |
| P2-1.4 Dashboard  | `/`                                  | KPIs + active-incidents + camera-health panels (15s poll)                |
| P2-1.8 Events     | `/events`                            | Filterable, cursor-paginated event timeline                              |
| P2-1.9 Rules      | `/rules`, `/rules/new`, `/rules/:id` | List, enable/disable, delete, author (RHF+Zod), dry-run, version history |
| P2-1.10 Incidents | `/incidents`                         | Queue + detail drawer with lifecycle timeline + ack/resolve/close        |
| P2-1.11 Alerts    | `/alerts`                            | Notification delivery log + acknowledge                                  |
| — Design system   | `/design`                            | Living gallery of every UI primitive (works with **no backend**)         |

**Not built yet** (blocked on backend enablers G-1…G-6): Cameras, Live Monitoring, Recorded Analysis,
Evidence Viewer, System Health, Settings — these render as labelled placeholder pages.

---

## 1. Prerequisites

- **Node.js ≥ 22** (`node -v`)
- **pnpm ≥ 10** (`corepack enable && corepack prepare pnpm@11.17.0 --activate`)
- **Docker + Docker Compose** (only for Tier 3 infra)
- **ffmpeg** (only for Tier 3 RTSP ingestion) — `brew install ffmpeg`
- **Python 3.11+** (only if you want to run the inference-runtime tests)

## 2. One-time setup

```bash
git clone <repo> && cd VisionIntelligencePlatform
pnpm install            # installs the whole workspace
cp .env.example .env    # dev secrets/ports — weak dev defaults, safe for local only
```

`.env` is the **only** secrets source (ADR-0018). The dev values are intentionally weak; never commit real
ones. Host ports use a non-standard `4xxxx` range to avoid clashing with other local Docker projects.

---

## Tier 1 — Automated tests & quality gates (start here)

These need **no Docker and no running services** (with one flagged exception). This is the authoritative
"is the code correct" check.

### 1.1 Run everything (Turborepo fan-out)

```bash
pnpm typecheck      # tsc across every package
pnpm lint           # eslint across every package
pnpm test           # vitest + pytest across every package
pnpm build          # tsc build + vite build (produces apps/console/dist)
pnpm check:imports  # architecture boundary enforcement (must be 0 violations)
pnpm verify:contracts   # every consumer's schema exists in @vip/contracts
pnpm format:check   # prettier
```

### 1.2 Console (frontend) test suite — the P2-1 slices

```bash
pnpm --filter @vip/console test        # 37 tests, 10 files (run once)
pnpm --filter @vip/console test:watch  # interactive watch mode
```

What these cover — each console slice ships MSW-mocked component tests that double as a **living spec**:

- **Auth** — token lifecycle, refresh-and-retry, permission expansion.
- **Shell** — permission-gated nav (operator vs. admin), routed outlet.
- **Dashboard** — MSW aggregation → KPIs + panels, empty states.
- **Events** — list + search filter, empty state.
- **Rules** — list + lifecycle badge, empty state, enable/disable PATCH, create validate+POST, deny-by-default block.
- **Incidents** — list + status badge, empty state, open drawer → ack POST, deny-by-default hides transitions.
- **Alerts** — list + channel/status, empty state, delivered→ack POST, deny-by-default hides ack.

Reading a slice's `*.test.tsx` is the fastest way to see exactly which gateway endpoints it calls and what
each state renders.

### 1.3 Backend service suites

```bash
pnpm --filter @vip/contracts test           # contract schemas
pnpm --filter @vip/service-rules test        # rule engine (see caveat below)
pnpm --filter @vip/service-workflow test     # incident state machine
pnpm --filter @vip/service-notify test       # alert fan-out / delivery / ack
# …one per service; or just `pnpm test` for all
```

> **Known caveat:** a few service suites include a `*mongo-integration.test.ts` that connects to a **real
> MongoDB**. Without the Tier-3 stack running (and its auth), these fail with
> `MongoServerError: … requires authentication`. That is an environment gap, **not** a code failure — the
> unit suites in the same package pass. To run them, bring up the stack (Tier 3) first, or skip them.

---

## Tier 2 — Run & explore the console UI (no backend needed)

```bash
pnpm --filter @vip/console dev
# → Vite dev server on http://localhost:5173
```

The console is a **pure client of the API gateway**; in dev, Vite proxies `/api/*` to the gateway
(`VITE_GATEWAY_URL`, default `http://localhost:8080`). There is **no browser mock mode**, so:

- ✅ **Works with no backend:** the **design system** at <http://localhost:5173/design> (every primitive,
  variant, and state), the login screen, and the app shell/navigation chrome.
- ⚠️ **Needs a backend for live data:** login submission and every data surface (Dashboard, Events, Rules,
  Incidents, Alerts) call the gateway; without one they surface honest loading/error states. To see real
  data, do **Tier 3**.

**Tip — verify UI behaviour without standing up the backend:** the component tests (Tier 1.2) already drive
every data surface against mocked gateway responses. That is the intended way to validate console behaviour
today; the live stack is for demos/manual QA.

---

## Tier 3 — Full-stack end-to-end (real backend + live UI)

This runs the whole camera→alert vertical behind the console. It is **involved** — there is no single
orchestration command yet, and no automated tenant/user seed (see the gap in §3.4).

### 3.1 Bring up infrastructure

```bash
pnpm dev:stack          # docker compose up -d: Mongo, Redis, MinIO, NATS, MLflow, RTSP test source
pnpm dev:stack:logs     # tail logs
pnpm dev:stack:down     # stop
```

Host ports (from `.env`): Mongo `47017`, Redis `46379`, MinIO `49000` (console `49001`), NATS `44222`
(monitor `48222`), MLflow `45000`.

### 3.2 Build the workspace once

```bash
pnpm build              # services import each other's compiled output
```

### 3.3 Run the services

Each service is `tsx watch` via its own `dev` script. **Important:** every service defaults to `PORT=8080`,
so when running them together you must give each a distinct `PORT`. The gateway's upstream URLs document the
intended assignment:

| Service  | Suggested PORT | Role                                                    |
| -------- | -------------- | ------------------------------------------------------- |
| gateway  | `8080`         | Single edge the console talks to (`/api/*`)             |
| identity | `8081`         | Auth: `/auth/login`, `/auth/refresh`, `/auth/me`, users |
| tenant   | `8082`         | Tenant provisioning + org hierarchy                     |
| camera   | `8083`         | Camera registry                                         |
| media    | `8084`*        | RTSP ingestion/recording                                |
| events   | `8085`*        | Event pipeline                                          |
| rules    | `8086`         | Rule engine                                             |
| workflow | `8087`         | Incident lifecycle                                      |
| notify   | `8088`         | Alert engine                                            |

> \* The `.env.example` comments list some ports differently (events 8084, media 8083); the exact numbers
> don't matter as long as (a) each service has a unique `PORT` and (b) the **gateway's upstream URLs**
> (`IDENTITY_URL`, `TENANT_URL`, … in `.env`) point at the ports you chose. Set `VITE_GATEWAY_URL` to the
> gateway's port if you don't use `8080`.

Run each in its own terminal, for example:

```bash
PORT=8080 pnpm --filter @vip/service-gateway dev
PORT=8081 pnpm --filter @vip/service-identity dev
PORT=8082 pnpm --filter @vip/service-tenant  dev
PORT=8086 pnpm --filter @vip/service-rules    dev
PORT=8087 pnpm --filter @vip/service-workflow dev
PORT=8088 pnpm --filter @vip/service-notify   dev
# + camera / media / events as needed
```

Then in `.env`, uncomment and set the gateway upstream URLs to match (`IDENTITY_URL=http://localhost:8081`,
`TENANT_URL=http://localhost:8082`, `RULES_URL=http://localhost:8086`, `WORKFLOW_URL=http://localhost:8087`,
`NOTIFY_URL=http://localhost:8088`, …).

### 3.4 Seed a tenant + admin user ⚠️ current gap

Login needs an existing **tenant** and a **user** in it — and there is **no seed script yet**. Two options:

1. **Provision via the APIs** (tenant service → create tenant + org root; identity → create the first
   admin user). The exact request bodies are the `CreateTenantInput` / user-creation contracts in
   `@vip/contracts` and the flows exercised in `services/tenant/test/integration.test.ts` and
   `services/identity/test/integration.test.ts` — those tests are the executable reference for the
   bootstrap sequence.
2. **Read the integration tests as the source of truth** for the end-to-end path; they spin up the chain and
   assert the vertical, so they document precisely which calls create a tenant, a user, a camera, a rule,
   and drive an event → incident → notification.

> This bootstrap step is the main friction in Tier 3 today. A dev seed script is a sensible near-term
> follow-up; until then, the integration tests are the reliable recipe.

### 3.5 Run the console against the live stack

```bash
pnpm --filter @vip/console dev      # http://localhost:5173
# if the gateway isn't on 8080:
VITE_GATEWAY_URL=http://localhost:8080 pnpm --filter @vip/console dev
```

Log in with the tenant id + admin email/password you seeded.

---

## 4. Manual walkthrough (once Tier 3 is up)

The target success path is **login → register camera → live/ingest → analyze → events → rules → incident →
alert → acknowledge**. The console covers the operator-facing half of that today:

1. **Login** (`/login`) — enter tenant + email + password. On success you land on the Dashboard.
2. **Dashboard** (`/`) — confirm KPI tiles and the active-incidents / camera-health panels render (they
   poll every 15s). With an empty tenant you'll see honest "—"/empty states.
3. **Rules** (`/rules`) — click **New rule**. Fill name; add an event type (e.g.
   `perception.person.detected`); optionally a JSON condition
   `{"all":[{"field":"confidence","op":"gte","value":0.8}]}`; leave the action as **Raise incident**; set
   lifecycle to **Enabled**; save. Open the rule and use the **Dry run** panel with the sample event to see
   the prefilter→condition→window breakdown. Toggle **enable/disable** from the list.
4. **Events** (`/events`) — as detections flow through the pipeline, they appear here. Filter by severity /
   search; **Load more** paginates.
5. **Incidents** (`/incidents`) — when an enabled rule matches, an incident is raised. Click a row to open
   the drawer; follow the lifecycle: **Acknowledge → Resolve** (add a resolution note) **→ Close**. Watch the
   timeline grow. (Buttons appear per your role — see §5.)
6. **Alerts** (`/alerts`) — the alert engine records a delivery per channel per raised incident. Filter by
   delivery status; **Acknowledge** a delivered alert. Use an incident's alerts via `?incidentId=<id>`.

### Permission-driven behaviour to verify

The UI is **deny-by-default**; what you can see/do depends on your role (from `/auth/me`). Log in as
different roles to confirm gating:

| Role       | Sees                          | Can mutate                               |
| ---------- | ----------------------------- | ---------------------------------------- |
| `viewer`   | all read surfaces             | nothing (no action buttons render)       |
| `operator` | all read surfaces             | ack/resolve/close incidents, ack alerts  |
| `admin`    | everything incl. Settings nav | + full rule authoring/delete, everything |
| `owner`    | everything                    | everything                               |

Good things to spot-check: a **viewer** sees Rules/Incidents/Alerts as read-only (no New rule / no
Acknowledge / no transition buttons); an **operator** can ack but not author rules; the gateway still
enforces this server-side (the UI gate is UX, not security).

---

## 5. Troubleshooting

| Symptom                                                         | Cause / fix                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MongoServerError: … requires authentication` in a service test | It's a real-Mongo integration test; start the Tier-3 stack first, or ignore it (unit suites still pass).                 |
| Console data surfaces stuck loading / network errors            | No gateway reachable at `VITE_GATEWAY_URL`. Start the gateway (Tier 3) or use Tier 2 for the shell/`/design` only.       |
| All services fight over port 8080                               | Each defaults to `PORT=8080`; assign a distinct `PORT` per service (§3.3) and point the gateway's upstream URLs at them. |
| Login returns 401                                               | No such tenant/user, or wrong tenant id. Seed a tenant + user first (§3.4).                                              |
| Ports already in use on your machine                            | Edit the `*_PORT` values in `.env` (they use a `4xxxx` range specifically to avoid collisions).                          |
| `pnpm test` fails only on a Python/inference package            | Install Python 3.11+ and the runtime's `requirements.txt`, or filter it out.                                             |

---

## 6. Command cheat-sheet

```bash
# Setup
pnpm install
cp .env.example .env

# Tier 1 — automated (no infra)
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm check:imports && pnpm verify:contracts && pnpm format:check
pnpm --filter @vip/console test        # 37 console tests

# Tier 2 — explore the UI
pnpm --filter @vip/console dev          # → :5173 (/design works offline)

# Tier 3 — full stack
pnpm dev:stack                          # infra up
pnpm build                              # compile services
PORT=8080 pnpm --filter @vip/service-gateway dev   # …+ other services
pnpm --filter @vip/console dev          # UI against the live gateway
pnpm dev:stack:down                     # tear down
```

---

_This guide reflects the codebase as of the P2-1.11 commit. Slice details live in
`docs/tracker/REVIEW_HISTORY.md`; the running status is in `docs/tracker/MASTER_PROGRESS.md`._
