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

| `../p8/frame-path.mjs` | **P-8 Phase 2** — real frames from a synthetic RTSP source through media to the runtime at 1/2/4/8/16 cameras; frame accounting; the recording-survives-perception guarantee; idle baseline | ✅ yes | ✅ yes | backend + docker | ~7 min | Non-zero exit; prints the measured table either way | **Four.** ① media pointed at a runtime that does not exist → **7 red**. ② `cpus: 2` on the runtime → the capacity label changes (the only proof TD-61 is fixed). ③ RTSP source starved mid-run → the segment-progress check goes red (1/4 advanced, needs 4). ④ the accounting invariant itself went red at `806 vs 770` — and **the check was short, not the product**: it knew four of the six states a frame can be in | ✅ yes |

| `../p8/inference.mjs` | **P-8 Phase 3** — real inference: image + artifact integrity, the loaded model's self-report, a photograph of two people, **a test pattern that must detect nothing**, the decoder's own tests run inside the image, the whole path camera→RTSP→media→runtime→detections, the operator route and its permission, and the 1/2/4/8/16 ladder | ✅ yes | ✅ yes | backend + docker | ~9 min | Non-zero exit; prints the measured table either way | **Three.** ① a byte flipped in the model artifact → the runtime **refuses to start** naming both digests, **20 red** — and this mutation found six checks that passed **vacuously** (`[].every(...)` is `true`), now fixed. ② the `stub` backend restored → **11 red**, including a colour-bar test pattern reporting `person 0.660` in 0.05 ms. ③ suppression disabled in the decoder → **17 detections instead of 2**, which `> 0` would have passed | ✅ yes |
| `../p8/runtime-ui.mjs` | **P-8 Phase 3** — the AI Runtime page in a real browser: what it renders while inference runs, the polling budget over a real minute, **the runtime stopped underneath the open page**, and a viewer refused | ✅ yes | ✅ yes | browser + docker | ~2 min | Non-zero exit; screenshots written to `p8/screens/` | Covered by `inference.mjs`'s mutations — with the runtime stopped the page must say so **without being refreshed**, which is itself section 3 rather than a separate mutation | ✅ yes |
| `../p8/hardening.mjs` | **P-8 Phase 3H** — warm-up cost, reproducibility of a `DetectionResult`, the capacity ladder at 1/2/4/8/12/16 cameras with queue peak sampled _through_ each window, a computed sizing recommendation, and dashboard truthfulness traced field by field | ✅ yes | ✅ yes | backend + docker | ~15 min | Non-zero exit; prints the measured table either way; `SECTIONS=` runs one section | **Yes, and by the shipped check.** The `metrics` mutation (a renamed Prometheus series) runs `SECTIONS=5` against **this file** rather than a copy — **2 checks red**, precisely `detectionsTotal is the runtime's own number`. ⚠️ Its own §2 was also red once, at `1.2e-32`: an assertion on computed variance rather than on distinct values, measuring this file's floating-point rather than the runtime | ✅ yes |
| `../p8/mutations.mjs` | **P-8 Phase 3H** — breaks the platform seven ways (model · registry · decoder · runtime · metrics · gateway · dashboard) and asserts each verification goes red **at the check that names the fault**, then green again | ✅ yes | ✅ yes | backend + browser + docker | ~45 min | Refuses to run against an already-red baseline; restores in a `finally` from a **byte snapshot**, never from git | **It is the mutation harness — and it found three defects in the suite it tests.** `git checkout --` restore destroyed uncommitted work; the dashboard mutation rewrote a comment instead of the JSX and shipped an identical page; the gateway mutation was inert twice over (`FAST` skipped §6, then a compose literal beat the env var) | ✅ yes |
| `../p8/inference-soak.mjs` | **P-8 Phase 3H** — continuous multi-camera inference: memory and RSS drift compared **half against half**, CPU stability, queue peak, p95 drift, drop rate, sustained throughput and detection consistency | ✅ yes | ✅ yes | backend + docker | 15 min default | Non-zero exit; writes per-minute samples; `clean` subcommand for an interrupted run | ⚠️ **Not mutation-tested — it is a measurement, not an assertion about a code path.** Its guard against vacuity is that detection consistency must sit at 2.00/frame, which a dead or degraded runtime cannot satisfy | ✅ yes |
| `../p8/tracking-fixtures.mjs` | **P-8 Phase 4** — builds four motion clips with **authored trajectories** from the boxes the deployed model returns, then verifies each against that model: the background must detect **nothing**, every clip must detect the expected people, and the occlusion window is **measured** rather than computed | ✅ yes | ✅ yes | backend + docker | ~90 s | Non-zero exit; refuses to let the tracking suite run on fixtures the model cannot see | **It is the fixture gate.** ⚠️ It caught three of its own defects: `shortest=1` produced a 1.6 kB clip with no motion; the probe sampled the occlusion clip at the exact moment the subject is correctly hidden; and a fixed sampling window made a _faster_ walker appear hidden for **longer** (7.5 s vs 3.5 s), because the window had run past the end of the walk | ✅ yes |
| `../p8/tracking.mjs` | **P-8 Phase 4** — the five identity properties against ground truth, over real RTSP: one id while visible, the id survives occlusion, the frame empties on departure, a return gets a **new** id linked to the old, and two people crossing do not swap lanes | ✅ yes | ✅ yes | backend + docker | ~4 min | Non-zero exit; writes every observation so a mid-run duplicate cannot hide behind a clean final state | **Five, and each names its own check** — see `tracking-mutations.mjs`. ⚠️ It also caught a scenario defect in itself: an authored 10 s absence measured ~12 s once edge-of-frame detection latency was included, exactly the engine's re-entry budget, so no link formed and that was **correct**. The run now measures and prints the absence, so "the tracker failed" and "the scenario left the budget" can never be confused | ✅ yes |
| `../p8/tracking-deploy.mjs` | **P-8 Phase 4** — tracking as deployed: the modules are in the running image **and import**, the runtime reports the predictive associator, `/api/tracking/*` answers through the gateway, an anonymous request is refused, and the runtime is **still** not an upstream and publishes no port | ✅ yes | ✅ yes | backend + docker | ~15 s | Non-zero exit; every absence is paired with a presence from the same source | Shares the Phase 1 mutations for the boundary half; the presence half is covered by `tracking-mutations.mjs` | ✅ yes |
| `../p8/tracking-ui.mjs` | **P-8 Phase 4** — the four track pages in a browser: every speed on screen traced to a payload the page **received**, the unit present on every reading, dwell labelled geometry, the path drawn with no video behind it, and **zero** inputs on the statistics page | ✅ yes | ✅ yes | browser + docker | ~2 min | Non-zero exit; screenshots into the run directory, never over committed review screens | Covered by `tracking-mutations.mjs` — a broken tracker changes what the pages can truthfully show | ✅ yes |
| `../p8/tracking-benchmark.mjs` | **P-8 Phase 4** — tracks/s, tracking latency, identity stability against ground truth, lost, recovered, CPU, RAM and dropped frames at 1/2/4/8/16 cameras, one walking person per camera | ✅ yes | ✅ yes | backend + docker | ~6 min | Non-zero exit; prints the measured table either way | **It found two defects and one of them was in the product.** ⚠️ `createdTracks` was summed across live camera states, so releasing an idle camera made a lifetime total **fall** and the ladder differenced it into **−2 identities**. It also found that every camera pointed at one RTSP path meant only **one** camera was ever streaming — every rung above the first was measuring a single stream | ✅ yes |
| `../p8/tracking-mutations.mjs` | **P-8 Phase 4** — breaks tracking five ways (track-id generation · association · occlusion recovery · direction · lifetime) and asserts each goes red **at the check that names the fault**, then green again | ✅ yes | ✅ yes | backend + docker | ~25 min | Restores from a **byte snapshot** in a `finally`, never from git; `restore` subcommand rebuilds the runtime | **It is the mutation harness — and it found two defects in itself.** ⚠️ The track-id mutation ran against a **one-person** clip, where a recycled id is indistinguishable from a correct one, and reported green; it now runs against the crossing clip, where two people collapse into one identity. Two expectations carried text after the em-dash that the parser strips, so they could never match | ✅ yes |
| `../p8/loitering.mjs` | **P-8 Phase 7** — the first COMPLETE CUSTOMER FEATURE end to end: camera → assignment → tracking → identity → zone → events → rule (scope · condition · dwell) → incident candidate → incident, with **both negative halves on the same deployment at the same moment** — a camera with no zone that never stamps one, and a dry-run twin that raises nothing while its clock advances | ✅ yes | ✅ yes | backend + docker | ~6 min | Non-zero exit; creates a zone and two rules and removes them in a `finally` | **Eight, via `loitering-mutations.mjs`** — 7 red at the check naming the fault, 1 recorded negative control. ⚠️ Its own first run had **three instrument bugs**: both cameras pointed at one fixture path so the second was never created (the negative control asserted nothing while reporting "0 unexpectedly zoned"), the incidents key was wrong, and zone stats were read at the wrong level of the payload | ✅ yes |
| `../p8/loitering-mutations.mjs` | **P-8 Phase 7** — eight deliberate breaks (rule disabled · wrong zone · wrong dwell time · identity fragmentation · missing identity · event loss · duplicate events · candidate suppression), each asserted red **at the check that names it** | ✅ yes | ✅ yes | backend + docker | ~50 min | Restores from a **byte snapshot** in a `finally`, never from git; refuses to run on a red baseline | **It is the mutation harness — and its first run found two of its own mutations were VACUOUS.** ⚠️ `identity-fragmentation` swapped `identityId`→`trackId` and stayed green, because the fixture never fragments; it now breaks identity _stability_. `duplicate-events` was collapsed by the events store before reaching the engine; duplicates are now injected inside the engine as an explicit negative control, tolerated with a recorded reason | ✅ yes |
| `../p8/loitering-benchmark.mjs` | **P-8 Phase 7** — the three latencies **separated** (event→rule, rule→candidate, end-to-end), zone geometry cost per frame, CPU/RAM, 1→16 cameras. Every figure is the platform's own instrument, never the harness's clock | ✅ yes | ✅ yes | backend + docker | ~15 min | Non-zero exit; writes the rung table either way; refuses to publish a capacity number from one run | ⚠️ **Not mutation-tested — it is a measurement.** Its guard against vacuity is that a missing series reads `not measured` rather than `0`. Its own first run found two harness faults: a metrics regex that rejected the `{service="rules"}` label so every latency read "not measured", and an 8-camera rung refused by a declared capacity of 4 | ✅ yes |
| `../p8/loitering-ui.mjs` | **P-8 Phase 7** — the five operator surfaces in a real browser: zone editor, rule authoring, candidate list, candidate detail, live rule status. Every number on screen traced to a payload the page **received** | ✅ yes | ✅ yes | browser + docker | ~4 min | Non-zero exit; 36 checks; screenshots into the run directory | Covered by `loitering-mutations.mjs` — a broken rule changes what the pages can truthfully show. ⚠️ **The screenshots themselves found three defects**: live timers carried no `cameraId`, SVG zone labels were stretched by the transform that makes the geometry correct, and the timeline marked every 10 s sampling interval as a "gap" | ✅ yes |
| `../p8/rule-replay.mjs` | **P-8 Phase 7 (post-approval)** — **replay determinism**: persisted `EventEnvelope`s → replay → rule engine → candidate, compared **byte for byte** against the candidate the LIVE pass produced, across a rules-service restart. Excludes only `id` and `at`, and asserts those are the only two that differ. Also: replay is idempotent, the store is unchanged, and neither dry-run rule publishes | ✅ yes | ✅ yes | backend + docker | ~8 min | Non-zero exit; names the exact leaf path that diverged; raises **no incident** (both rules dry-run) | **It found a product defect on its first honest run, and two defects in itself before that.** ⚠️ ① seeding then replaying inside the JetStream duplicate window meant the broker suppressed all ten envelopes while the run reported "10 replayed" — **the count came from the sender**. ② `cooldownSeconds: 0` produced five candidates for one stationary person. ③ Then: two candidates from identical events, one naming `zn-82ea…` and one naming `Checkout Queue` — the zone catalogue was warmed **after** the engine started consuming, so every candidate for 15 s after any restart lost its `zoneVersion` and could never be re-examined against its own geometry | ✅ yes |
| `../../../tools/contracts/perception-boundary.mjs` | **P-8 Phase 3H** — a build failure, not a review item: exactly one file may call the runtime, only media may know where it lives, no source outside `ai/` may **name** a model-implementation concept, and no consumer may read a detection field the frozen schema does not declare | n/a — static | n/a | static analysis | ~2 s | Non-zero exit inside `pnpm verify:contracts`; names file and line | **Yes — planted `const nmsIouThreshold = 0.45` in `services/gateway/src` → §C red naming the file and the term; removed → green.** ⚠️ That probe found a real hole: the check used `\bnms\b`, and the `I` after `nms` is a word character, so **camelCase identifiers embedding a forbidden term slipped straight through**. It now matches the word components of each identifier. An earlier plain-grep version had the opposite fault — **four** hits, every one correct code, including `video-player-container.tsx` using "letterboxes" about video display; comments and string literals are stripped first. It also caught one real defect: the console held a hard-coded copy of media's "INFERENCE_URL is not set" message | ✅ yes |

⚠️ **What these mutations could not reach.** Model _accuracy_. Two photographs prove the deployed
path, not quality: no labelled corpus, no mAP, no FP/FN promotion gates (TD-64). The platform can
say inference **runs** and must not say **how well it works**.

---

> ⚠️ **Audited end to end at the P-8 Phase 7 freeze (2026-08-07).** Every stage and script in this
> file was read against eight questions — can it produce a false green, a false red, silently measure
> the wrong thing, mutate tracked files, or depend on a previous stage, a warm cache, execution order,
> or one camera while reporting sixteen. Nine findings, four fixed, five recorded:
> [VERIFICATION_AUDIT](../../project/VERIFICATION_AUDIT.md). ⚠️ **One ladder in six asserts an
> invariant that would notice if its rungs stopped scaling**, and that is the one that caught the
> defect. Read F-1 before trusting any capacity table in this repository.

> ⚠️ **This inventory is incomplete, and saying so is the point.** The **P-8 Phase 5** (event bridge:
> `event-bridge.mjs`, `event-bridge-replay.mjs`, `event-bridge-benchmark.mjs`,
> `event-bridge-mutations.mjs`, `event-bridge-resilience.mjs`, `event-bridge-ui.mjs`) and **Phase 6**
> (assignment: `assignment.mjs`, `assignment-runtime.mjs`, `assignment-benchmark.mjs`,
> `assignment-mutations.mjs`, `assignment-ui.mjs`) scripts exist, run nightly, and have been red for
> the right reason — but their rows were never written here. They are listed rather than described,
> because a row invented from memory is worse than an absent one: this file's whole value is that
> every claim in it was witnessed. Backfilling them is scheduled work, not a note to remember.

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

# P-8 Phase 4 — tracking. ⚠️ The fixtures are generated, not committed; the suite builds them.
node docs/review/p8/tracking-fixtures.mjs --verify  # first: can the model even see the clips?
node docs/review/p8/tracking.mjs                    # the five identity properties
node docs/review/p8/tracking-deploy.mjs
node docs/review/p8/tracking-benchmark.mjs
node docs/review/p8/tracking-mutations.mjs          # ⚠️ edits source + rebuilds; needs a clean tree
node docs/review/p8/tracking.mjs clean              # ⚠️ if a run was interrupted

# P-8 Phase 7 — the first complete customer workflow. ⚠️ `loitering.mjs` needs the fixture streams.
node docs/review/p8/loitering.mjs                    # camera → … → incident candidate
node docs/review/p8/rule-replay.mjs                  # ⚠️ ~8 min: it waits out the broker's dedup window twice
node docs/review/p8/loitering-benchmark.mjs
node docs/review/p8/loitering-mutations.mjs          # ⚠️ edits source + rebuilds; needs a clean tree
node docs/review/p8/loitering.mjs clean              # ⚠️ if a run was interrupted
node docs/review/p8/rule-replay.mjs clean            # ⚠️ likewise

# browser — ⚠️ from /private/tmp/pwrun, because Playwright is not a repo dependency
cp docs/review/p6/{inbox-ux,inbox-scale-ui,outage,soak,p65-freeze-screens,lifecycle-publish}.mjs /private/tmp/pwrun/
cd /private/tmp/pwrun && node inbox-ux.mjs

# the regression that holds the race — ⚠️ excluded from `pnpm test`, needs a reachable MongoDB
MONGO_URI=… pnpm --filter @vip/service-notify test:integration
```
