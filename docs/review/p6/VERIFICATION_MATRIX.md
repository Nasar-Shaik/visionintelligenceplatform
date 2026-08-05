# Verification Matrix — the permanent inventory

> **What this is.** Every verification script the platform keeps, what it is entitled to claim, and —
> for the P-6.5 set — the mutation that proved it can fail. A script that has never failed has never
> been shown to be measuring anything.
>
> **Compiled at the P-6.5 freeze, 2026-08-05, against the deployment at commit `a139080`** (plus the
> freeze commit that follows it). Every run below went through `https://localhost` — the Caddy edge →
> the gateway → the services — against built images. Never `pnpm dev`.

## How to read it

- **Deployment verified** — the script exercised the running deployment, not a component, a mock or a
  test double. Where a script talks to MongoDB or NATS directly it does so _inside the production
  container_, because neither is published to the host.
- **Failed once, for the correct reason** — a mutation was applied to the **product** (or, where the
  claim is about a fixture's far end, to the fixture), the script was run, and it went red on the
  check that owns that claim, with a message that named the fault. Assertion-flipping was not
  accepted as evidence.
- **Restored green** — the mutation was reverted, the image rebuilt and redeployed, and the script
  re-run to completion.

---

## The audit, before the mutations

Every script was read against five questions before any of it was believed. What the reading found:

- **Does it run against the deployment?** All ten enter through `https://localhost` — the edge, then
  the gateway, then the services. None imports a React component, mounts a test renderer, starts a
  service in-process, or uses a mock, a stub or a fixture server standing in for a real one.
- **Does it verify deployment state or local state?** Counts, statuses and orderings are read back
  from the API or from MongoDB **inside the production container**; nothing asserts against a value
  the script itself put in a variable. Where a script needs its own data it creates it through the
  product (a channel through the API, an incident on the backbone) and removes it afterwards.
- **Does anything bypass the gateway or its security?** One thing, deliberately: raising an incident.
  `lifecycle-publish.mjs` is copied into the notify container and publishes a real `incident.raised`
  on the backbone — which is exactly what the workflow service does. ⚠️ The alternative, writing a
  delivery record straight into MongoDB, would fake the Alert Engine and then measure the fake.
  Everything an operator would do goes through the edge with a real token and real permissions.
- **Are its failures meaningful?** Each check prints what it measured, not only whether it passed, and
  the exit code is the verdict. Two scripts were found reporting a **crash** where a verdict belonged
  and were fixed.
- **Can it pass for the wrong reason?** This is the one that reading alone could not answer for most
  of them — hence the mutations below. Reading did catch two: a tautology, and a capture script that
  asserted nothing at all.

---

## The P-6.5 set

| Script                       | Capability verified                                                                                                                                                     | Deployment | Production stack | Kind                  | Runtime | Failure mode                                       | Failed once (mutation → red)                                                                                                                                                                                        | Restored green |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- | --------------------- | ------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `inbox.mjs`                  | Queue filter arithmetic, delivery-failure reasons, what may be acknowledged, tenant isolation, permissions, latency, per-record observability, **server-side ordering** | ✅         | ✅               | backend (API)         | ~40 s   | non-zero exit, one line per failed check           | `lastError` → `"fetch failed"` on a real row → **2c** red · a stale seeder restoring `attempts: 3` → **2d** red (unplanned, a real defect) · queue served oldest-first → **1g** red                                 | ✅             |
| `inbox-concurrency.mjs`      | Acknowledgement under concurrency: one winner, one audit event, queue drops by one — 13 rounds, 12 racers each in the sweep                                             | ✅         | ✅               | backend (raw sockets) | ~4 min  | non-zero exit; prints winners per round            | atomic status filter removed from the write → **5b** red: 8 of 12 rounds had 2–4 winners                                                                                                                            | ✅ 12/12       |
| `inbox-scale.mjs`            | 5,000-delivery queue: p95 latency, keyset paging, **the plan the service's own query causes**, payload size                                                             | ✅         | ✅               | backend + `mongosh`   | ~90 s   | non-zero exit; prints the plan and the sort        | queue sorted on an unindexed field → **2b** red: 5,011 documents examined to return 51, sorted in memory                                                                                                            | ✅             |
| `inbox-scale-ui.mjs`         | The same queue in a browser: time to first row, expansion latency, the page cap, the polling ceiling, heap                                                              | ✅         | ✅               | browser               | ~4 min  | non-zero exit; prints clicks, DOM nodes, requests  | page cap removed → **3a/3b/3c** red: "Load more" never stopped, 651 entries, 27 requests per 20 s                                                                                                                   | ✅             |
| `inbox-ux.mjs`               | Two operators on one alert (**including the split race**), refresh recovery, four viewports, keyboard + ARIA                                                            | ✅         | ✅               | browser (2 sessions)  | ~6 min  | non-zero exit; prints both operators' messages     | atomic filter removed → **1c/1d** red (both told they won) · poll + ack-refresh + live-stream refresh all removed → **1e/2d/2e** red · pre-fix message on a split → **1c/1d** red                                   | ✅             |
| `notification-lifecycle.mjs` | Every delivery state the platform has, produced through four real transports; retries measured; `pending` caught                                                        | ✅         | ✅               | backend + real HTTP   | ~4 min  | non-zero exit; prints each channel's trail         | the accepting far end changed to refuse → **2d** red                                                                                                                                                                | ✅             |
| `outage.mjs`                 | What System Health and the Inbox say while a dependency is away, and how long recovery takes                                                                            | ✅         | ✅               | browser + `docker`    | ~6 min  | non-zero exit; prints noticed/cleared seconds      | the retained queue's "stale" label removed → **5·gateway** red: the queue was kept and passed off as current                                                                                                        | ✅             |
| `soak.mjs`                   | Forty minutes open through three restarts: duplicates, rendered order, count against the server, heap, live path                                                        | ✅         | ✅               | browser + `docker`    | ~40 min | non-zero exit; prints transitions and samples      | the bell's own page shrunk from 50 to 10 → **5e** red at _5 vs 21 · capped true/false_ ⚠️ queue served oldest-first → **5d stayed green**: the console re-sorts client-side (see _What a mutation could not reach_) | ✅             |
| `p65-freeze-screens.mjs`     | The eight demonstration screenshots, each **containing** the state its filename claims                                                                                  | ✅         | ✅               | browser + `docker`    | ~4 min  | non-zero exit; names the shot and what was missing | `lastError` → `"fetch failed"` → **shot 02** red on both assertions                                                                                                                                                 | ✅             |
| `deployment-integrity.mjs`   | That the running bytes are the committed bytes — services, packages, console bundle, containers, seeder                                                                 | ✅         | ✅               | backend + `docker`    | ~60 s   | non-zero exit; names the differing files           | needed no mutation: it went red on three real states — a dirty tree, a **stale seeder image**, and stale local `dist`                                                                                               | ✅             |

### Regression suite (not scripts — the tests that hold the same claims)

| Suite                                              | Holds                                                                    | Runs under                            | Failed once                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------- |
| `services/notify/test/mongo-integration.test.ts`   | ⚠️ **The acknowledgement race** — 12 concurrent acks, exactly one winner | `pnpm test:integration`, real MongoDB | ✅ atomic filter removed → _expected length 1, got 10_          |
| `services/notify/test/webhook-sender.test.ts`      | Delivery-failure wording, against a real in-process HTTP server          | `pnpm test`                           | (P-6.5: written red first against the unactionable messages)    |
| `apps/console/src/features/alerts/alerts.test.tsx` | The queue's states, the cap, the stale banner, the split-race message    | `pnpm test`                           | ✅ the split-race test failed on the old wording before the fix |

---

## What a mutation could not reach

Recorded because a check whose limits are unknown is a check that will one day be trusted past them.

- **`soak.mjs` 5d cannot see a server-side ordering regression.** The console groups the delivery log
  into entries and sorts them itself, so a build that served the queue oldest-first still rendered
  newest-first. The claim was narrowed to what it actually measures — _the rendered order survives
  forty minutes of restarts_ — and the server's own order is now asserted in `inbox.mjs` **1g**,
  which does go red on that build.
- **`inbox-scale.mjs` 2a/2b measured a query the script wrote, not the one the service issues.** Under
  a build that sorted the queue on an unindexed field, both checks stayed green while the service did
  a 5,000-row in-memory sort. Section 2 now clears the plan cache, fetches the queue **through the
  gateway**, and reads the entry MongoDB then holds — so the sort it reports is the service's.
- **A single race round is not enough.** With the atomic filter removed, the six-racer round in
  `inbox-concurrency.mjs` §1 produced one 200 and five 409s — green, against the defect. Only the
  13-round × 12-racer sweep in §5 exposed it. The round that reads best in a report is not the round
  that does the work.
- **`inbox.mjs` acknowledges as it goes and cannot be idempotent.** Acknowledging is one-way by
  design, so a run consumes queue entries. `infra/docker/demo.sh reset` restores the dataset exactly;
  ⚠️ `pnpm seed:demo` is the **development** command and will report success having seeded a
  different database.

---

## The P-8 set

Added after the P-6.5 freeze. Same rule, no exception: a script is not trusted until it has been red
for the right reason.

| Script                            | Capability verified                                                                                                                                                          | Deployment | Production stack | Kind    | Runtime | Failure mode                                                               | Failed once (mutation → red)                                                                                                                                                                                                                                                                                                                                                                                                                                            | Restored green |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- | ------- | ------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `../p8/runtime-deploy.mjs`        | **P-8 Phase 1** — the AI runtime runs in the production stack: health, readiness, startup, metrics, no published port, no gateway route, no session, no frame, no leaked key | ✅ yes     | ✅ yes           | backend | ~70 s   | Non-zero exit per failed check; findings printed and not counted as passes | **Four, each attributed to one section.** ① `docker stop` → **13 red**, and the script reports them instead of crashing (the P-6.5 soak lesson applied). ② `INFERENCE_MANIFESTS_DIR=/tmp` → `/ready` reads `fail · capability=fail`, capabilities empty, metrics empty — **5 red**, ⚠️ while the container stayed `healthy`. ③ `ports: ['8085:8085']` → **1 red**, precisely the port check. ④ `INFERENCE_URL` on the gateway → **1 red**, precisely the upstream check | ✅ yes         |
| `deployment-integrity.mjs` **§6** | The runtime's Python bytes in the image are the tree's — no build step, so the comparison is exact                                                                           | ✅ yes     | ✅ yes           | backend | +5 s    | Names the differing files                                                  | Appended a comment to `ai/inference/health.py` → `✗ 6a·inference — 1 differ: health.py`                                                                                                                                                                                                                                                                                                                                                                                 | ✅ yes         |

⚠️ **What these mutations could not reach.** Nothing proves the runtime _infers_ anything — Phase 1
connects no camera and the `stub` backend fabricates its model identity. The script asserts the
absence deliberately; the presence is Phase 5's to prove.

---

## Inventory — scripts from earlier P-6 milestones

Kept, still run, and **not** mutation-tested in this pass: they belong to milestones already frozen,
and this freeze covers P-6.5. Any of them that fails is a defect in the deployment, not in the pass.

| Script                                                                             | Capability                                                | Kind    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- | ------- |
| `../roadmap-2026-08/verify.mjs`                                                    | The route walk — 12 routes render with the shell in place | browser |
| `../roadmap-2026-08/overflow.mjs`                                                  | The responsive gate at four widths (**gate 5**)           | browser |
| `system-health.mjs` · `system-health-ui.mjs`                                       | P-6.4 — dependency health, staleness, permissions         | both    |
| `p64-freeze.mjs` · `p64-freeze-ui.mjs`                                             | P-6.4 freeze                                              | both    |
| `p63-freeze.mjs` · `p63-freeze-ui.mjs` · `tenant-settings.mjs` · `settings-ui.mjs` | P-6.3 — tenant settings                                   | both    |
| `users-ui.mjs` · `offboarding.mjs`                                                 | P-6.2 — a user can be disabled                            | both    |
| `rule-edit.mjs` · `radix-state.mjs`                                                | P-6.1 — a rule can be edited                              | both    |
| `branding-runtime.mjs` · `restart-persistence.mjs`                                 | Branding at runtime; state across a restart               | both    |
| `inbox-ui.mjs`                                                                     | P-6.5 first pass — superseded by `inbox-ux.mjs`           | browser |

---

## Running them

```sh
# backend, from the repo root
node docs/review/p6/deployment-integrity.mjs      # first: is the deployment the commit?
node docs/review/p6/inbox.mjs
node docs/review/p6/notification-lifecycle.mjs
node docs/review/p6/inbox-scale.mjs load          # 5,000 disposable deliveries
node docs/review/p6/inbox-scale.mjs api
node docs/review/p6/inbox-concurrency.mjs
node docs/review/p6/inbox-scale.mjs clean         # ⚠️ always

# browser — ⚠️ from /private/tmp/pwrun, because Playwright is not a repo dependency
cp docs/review/p6/{inbox-ux,inbox-scale-ui,outage,soak,p65-freeze-screens,lifecycle-publish}.mjs /private/tmp/pwrun/
cd /private/tmp/pwrun && node inbox-ux.mjs

# the regression that holds the race — ⚠️ excluded from `pnpm test`, needs a reachable MongoDB
MONGO_URI=… pnpm --filter @vip/service-notify test:integration
```
