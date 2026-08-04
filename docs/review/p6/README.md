# P-6 · Make the Product Whole — implementation review

**In progress.** This package is written as each item lands, so it can be read before the milestone
closes. P-6 ends with a full review; what follows is the record so far.

**Verified against the running production deployment on 2026-08-04** — built images, deployed,
exercised through the edge. ⚠️ Never `pnpm dev` (gate 3; P-5.8 found evidence playback had never
worked outside it).

| Item                             | State   | Closed                                         |
| -------------------------------- | ------- | ---------------------------------------------- |
| **P-6.0** product version        | ✅ done | root `package.json` → `0.4.0`                  |
| **P-6.1** a rule can be edited   | ✅ done | **TD-21 · C-25 · L-6** — a pilot blocker       |
| **P-6.2** a user can be disabled | ✅ done | **TD-44 · C-03 · L-5** — the last blocker      |
| **P-6.3** tenant settings        | ✅ done | **C-05** — the first placeholder page replaced |
| **P-6.4** System Health          | ✅ done | **C-52** — and a page nobody could reach       |
| P-6.5 notification centre        | ⏳ next | C-31                                           |
| P-6.6 – P-6.14 (see the roadmap) | ⏳      | TD-45 · TD-46 · TD-47 · TD-40 (D-1) · TD-31    |

> ✅ **Both pilot blockers are closed.** No entry in
> [KNOWN_LIMITATIONS](../../project/KNOWN_LIMITATIONS.md) now blocks a first customer pilot.
> ⚠️ That is a floor, not a finish line — P-6 still owes six screens.

---

## P-6.1 · A rule can be edited

Full account in the commit message of `e17fe44`. The short version, because the lesson outlived the
fix:

An existing rule could not be saved. Submit failed validation on `lifecycle` and `severity` with
"Invalid input", so the PATCH never fired. **A Radix `Select` cannot adopt a value that changes after
it mounts** in this composition — its `SelectItem`s live in a portal that is unmounted while the menu
is closed, so a value arriving later has no item to resolve against and Radix reports an empty value.

The clue was in which fields failed: `actionType` and `actionSeverity` are the same construction and
worked, **because their stored values happen to equal the form defaults.** The two that failed were
the two that differed.

⚠️ **Two fixes were measured wrong before one measured right.** `reset()` in an effect (the original
code) and RHF's `values` option — the API built for exactly this case — both set form state _after_
mount. The second was deployed, the bundle confirmed to contain it, and the comboboxes were still
empty. Being the purpose-built API did not make it the right one, because the constraint is Radix's
mount, not RHF's plumbing. `key={field.value}` does work and was rejected: it remounts the trigger on
every selection and drops keyboard focus.

The form is now split and keyed by rule id, so it mounts once with its values.

### The regression test, and proof it can fail

[`ruleEditor.regression.test.tsx`](../../../apps/console/src/features/rules/ruleEditor.regression.test.tsx)
— 30 tests. The full **5 lifecycles × 5 severities** matrix, because a fixture sitting on a default
value would have been green throughout the entire defect. Each case asserts load, display (including
the hidden native `select` Radix submits from), save (the PATCH body carries the stored values) and
reload.

⚠️ **Verified red before it was trusted.** The editor was temporarily reverted to the pre-fix shape
— `defaultValues: DEFAULT_RULE_FORM` plus `reset()` in an effect, no `key` — and the suite failed
**27 of 30**. A check that cannot fail is not a check.

It also carries two counterweights: one test asserting a _changed_ Select still reaches the PATCH (so
"mount once" cannot degenerate into "ignore input"), and one asserting the fixtures still differ from
`DEFAULT_RULE_FORM` (so a future tidy-up cannot silently gut the file).

---

## P-6.2 · A user can be disabled

**The last pilot blocker.** Until now a user could be created and listed and nothing else — no role
change, no password reset, no deactivation. An offboarded employee kept their access to a security
product.

### The contract, and the three fields deliberately absent

`UpdateUserInput` carries **roles only**. Each omission is a decision, recorded in the schema:

- **`email`** — the login identity and half of the `{tenantId, email}` unique key. Editing it changes
  who can sign in to an account that already owns incidents, assignments and audit lines: a takeover
  that reads as a typo fix. A new account plus a disabled old one leaves a trail (L-21).
- **`status`** — disabling is a named act with side effects, not a field edit. `POST /users/:id/disable`,
  the same shape as archiving a location. ⚠️ **A PATCH can therefore never lock somebody out by
  accident**, and the audit line says `user.disabled` rather than `user.updated`.
- **`password`** — a body that carried both a role grant and a credential would make one audit entry
  cover two different acts. Its own route.

### What disabling actually does

Two things, and the second is the one that matters:

1. The status flips. `login` and `refresh` already refused anything not `active`, so this is enforced
   at the door.
2. ⚠️ **Every refresh-token family is revoked.** Without this, the status flip alone would pass any
   test that re-read the record — and would leave the leaver signed in until their refresh token
   expired a week later.

`AuthService` owns `refresh_tokens`, so `UserService` calls a one-method `SessionRevoker` port rather
than reaching into the collection. One place knows how a session ends.

**Self-disable is refused at the service**, not only in the UI. Locking yourself out of a security
product mid-shift has no undo from inside the console.

### ⚠️ A defect only the deployment found

`sessionsRevoked` counted modified **token records** and reported **3** for a user with **2** open
sessions. Rotating a refresh token leaves the used record in place and inserts a successor in the
same family, so the count was measuring the history of a session rather than the session.

An administrator being told a security action affected more devices than the person owns is being
told something false, and the number would drift the longer someone stayed signed in. **A family is
a session.** Fixed to count distinct families, and pinned by an integration test that logs in twice,
rotates one, and asserts exactly `2`.

Nothing in the unit suite could have caught it: the fake store had no rotation history.

### Verification

**[`offboarding.mjs`](offboarding.mjs) — 19/19, through the gateway.** Not against `identity:8089`: a
test that skips the edge proves the route works and proves nothing about whether a customer can
reach it.

```
✓ a disposable user is created, and can sign in
✓ the session is live (refresh rotates)
✓ an admin disables the account → status disabled, sessionsRevoked=2 (2 sessions, 3 token records)
✓ the open session is dead immediately          ✓ they cannot sign in again
✓ an operator is refused (403) …but may still read the user (`*:read`)
✓ re-enable restores sign-in — and the revoked token stays revoked
✓ a password reset ends the live session; the old password stops working, the new one works
✓ a cross-tenant disable is 404, not 403        ✓ an admin cannot disable themselves (400)
```

⚠️ **404 rather than 403 on the cross-tenant attempt is deliberate.** A 403 would confirm the id
exists to someone in another tenant — an enumeration oracle across the isolation boundary.

**[`users-ui.mjs`](users-ui.mjs) — 24/24, in a real browser.** Render (zero pageerror, zero console
errors), the sidebar entry, accessibility (28 controls, all named; no target under 24 px; no heading
skips), a keyboard-only disable-and-cancel with a visible focus ring, painted-box overflow at seven
viewports, and an operator seeing the list with no write controls and no sidebar entry.

**Tests:** 30 identity (HTTP, in-memory) · 11 identity integration (real MongoDB) · 11 console (MSW)
· 30 rule-editor regression. Full gate: **68/68 turbo tasks**, lint 0 errors, format clean.

### Screenshots

`screens/` — [desktop](screens/users-desktop.png) · [disable dialog](screens/users-disable-dialog.png)
· [role dialog](screens/users-roles-dialog.png) · [operator view](screens/users-operator.png) ·
[phone](screens/users-phone.png) (⚠️ shows TD-45, the unresponsive shell).

### The dataset is pristine

The probe creates a user and **there is no DELETE route** — deliberately. Each run uses a fresh
address; the script prints the mongosh line that removes them. Verified after this run: **17 users,
all `active`**, matching the demo seed exactly.

---

## A responsive gate that was going red for the wrong reason

At 390 px `/users` reported **13 clipped elements**. Measured rather than assumed: `/rules` and
`/incidents` clip **the same 13**, and every one is inside the top bar's `ml-auto` cluster — one
shell defect (TD-45), not a page defect.

⚠️ **A check that is red on every page for a single known cause is a check everyone stops reading,
and the next real page-level overflow hides behind it.** `users-ui.mjs` now attributes each clipped
element to the shell or the page and fails only on the page's count, which is `0` at every viewport
from 390 to 1920.

---

## Also in this package

- ⚠️ **The rule editor's Selects were announced by their value, not their purpose.** A Radix
  `SelectTrigger` takes its accessible name from its content, so Lifecycle read as "Enabled,
  combobox". **The control was named — which is why the P-5.9 audit reported zero unnamed controls —
  but named the wrong thing.** All four now carry an id their label points at. Logged as PB-15.
- **[PRODUCT_POLISH_BACKLOG](../../project/PRODUCT_POLISH_BACKLOG.md)** created: 13 open items, each
  naming where it was observed. ⚠️ Nothing enters it from an opinion.
- The identity integration suite's setup was file-scoped: the teardown lived inside the first
  `describe`, so a second one ran against a closed Mongo client and failed with "Client must be
  connected" rather than anything about the behaviour it asserted.

## P-6.3 · Tenant settings

**The first placeholder page replaced.** `/settings` said "coming in P2-1.13" — our sprint
vocabulary on a customer's screen.

### It is a management surface, not a PATCH form

The backend supports exactly two mutable fields. The screen exposes **one**, and the reason each
other field is absent is on the page rather than in a commit message:

| Field         | Treatment                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Name**      | Editable. A label, referenced by nobody                                                                                           |
| **Status**    | ⚠️ **Read-only.** See below — this was the milestone's sharpest finding                                                           |
| **Slug**      | Immutable, with the reason shown: it is a key and namespace prefix, so changing it strands every reference that already spells it |
| **Tenant ID** | Immutable, shown because it is what support asks for                                                                              |
| **Branding**  | Read-only panel: what is in force, where it comes from, and **what it scores against WCAG**                                       |

### ⚠️ Suspending a tenant does nothing, so there is no Suspend button

`TenantStatus` is persisted and validated. Grepping every service found **no code path that reads
it** — nothing in identity, the gateway or the tenancy guard refuses a request because a tenant is
suspended.

A "Suspend this tenant" control would therefore claim to lock an entire customer out and silently
do nothing. On a security product that is the worst class of control there is. The status is shown
read-only, labelled **"not enforced"**, and the page names the limitation. Recorded as **L-24 /
TD-48**; it becomes editable when it is enforced, not before.

### Optimistic concurrency

`UpdateTenantInput` gains an **optional** `expectedUpdatedAt`. Optional is a compatibility
decision, not a soft guarantee: making it required would break the seed, the runbooks and every
`curl` on a schema whose whole point is being additive. The console always sends it.

⚠️ **The check lives in the update filter, not in an `if` above it.** Read-compare-then-write
leaves a window between the read and the write in which another administrator can commit — the
exact race the check exists to close, reintroduced by the shape of the check.

⚠️ **A frozen test clock found a real flaw.** `updatedAt` only works as a version while it strictly
increases; two writes in the same millisecond leave it unchanged, and a stale token still matches.
The harness froze the clock, so this happened _every_ time instead of rarely, and the conflict
check could never fire. `applyTenantUpdate` now guarantees monotonicity. **A guarantee that depends
on wall-clock resolution is not a guarantee.**

### The audit record

Every successful change emits `tenant.updated` with before/after **per field that actually moved**,
the actor and the correlation id. Before this, a rename emitted **nothing at all** — only a status
transition announced itself, so the commonest settings change in the product left no trace.

⚠️ **An in-memory test double found an aliasing bug.** The before-values were read _after_ the
write. The MongoDB driver returns a fresh object so it happened to work; the fake returns the
stored reference and `updateOne` mutates it in place, so every audit event came out empty. Fixed by
snapshotting before the write — the audit's correctness should not depend on which store is
underneath it.

⚠️ **Where it lands is a limitation, and it is recorded rather than dressed up:** the tenant service
still uses `LoggingEventPublisher`, so this is a structured log line and not a queryable trail
(**L-25 / TD-49**). `AccessAuditEntry` is frozen with no consumer anywhere. The event is emitted in
the shape that consumer will want.

### Verification

**[`tenant-settings.mjs`](tenant-settings.mjs) — 22/22 through the gateway.** Mutable surface ·
409 on a stale write with the first administrator's change surviving · the same race across two
independent sessions · cross-tenant reads and writes refused · latency.

⚠️ **On cross-tenant, the platform answers 403 here and 404 for users, and both are right.** The
tenant gate is `ctx.tenantId !== pathTenantId` and **never touches the database**, so a real foreign
tenant and an id that has never existed return byte-identical responses — asserted directly, so a
future "friendlier message" that looks the tenant up first turns the test red.

**Latency, measured rather than assumed** (n=30, through the gateway, deployed):

|                      | p50        | p95         | max   |
| -------------------- | ---------- | ----------- | ----- |
| `PATCH /tenants/:id` | **7–8 ms** | **9–11 ms** | 11 ms |
| `GET /tenants/:id`   | **6–7 ms** | **7–17 ms** | —     |

**[`settings-ui.mjs`](settings-ui.mjs) — 36/36 in a real browser.** Eight render states, multi-tab
conflict across two genuine sessions, reload, cache consistency, accessibility, keyboard, and
overflow at six viewports with a 110-character multilingual name.

**[`restart-persistence.mjs`](restart-persistence.mjs) — 6/6.** Written through the API, **every
container restarted**, read back: the name survived and so did `updatedAt`, which is what proves
the concurrency token is durable rather than in-memory.

**[`branding-runtime.mjs`](branding-runtime.mjs) — 10/10.** ⚠️ Proves "no rebuild" by
`docker cp`-ing a new `branding.json` **into the running container** — a test that reads the file
already in the image proves only that the image is displayed. A new name, tagline and accent
applied on reload; the foreground flipped automatically; **a colour below 4.5:1 was refused rather
than shipped**; a malformed file fell back to defaults without blocking the console; and a second
tenant saw the same branding, confirming L-26.

⚠️ **The refusal test was wrong before it was right.** It used `#808080` on the assumption that
mid-grey obviously fails — it scores **4.67:1 against near-black** and legitimately passes, so the
check went red against correct behaviour. The band failing _both_ foregrounds is narrow (relative
luminance ≈ 0.183–0.204). `#7a7a7a` sits in it at 4.29:1 and 4.30:1.

### Three defects found by the browser, not by the tests

1. ⚠️ **Every toast was cut off on a phone.** sonner's container computed `width: 100%` with a
   16 px inset on both sides, painting 16 px past the right edge at 390 px — the save confirmation,
   delivery failures and the critical-incident alert alike. Found **only because the responsive
   check ran with a toast on screen**; a settled page measures clean. Setting sonner's own
   `--width` did not fix it — the mobile rule never consults it — and `max-width` is what binds.
   **The property a library documents is not necessarily the one that governs the case in front of
   you, and only the computed box says which.**
2. ⚠️ **The top bar showed `tnt_demo_retail`** — an internal id a customer never chose — which also
   made this page's own description ("the name appears in the top bar") untrue. It now shows the
   organisation name, with the id as the tooltip. That also made cache consistency checkable
   against a _second consumer_ of the query rather than the field the response landed in.
3. ⚠️ **`Alert` announced static prose assertively.** `role="alert"` was set for all four variants,
   so a standing informational panel interrupted a screen reader on every render. Now
   variant-driven; `info` has no live region at all.

### Screenshots

`screens/` — [loading](screens/settings-01-loading.png) ·
[populated](screens/settings-02-populated.png) · [validation](screens/settings-03-validation.png) ·
[saving](screens/settings-04-saving.png) · [saved](screens/settings-05-saved.png) ·
[conflict](screens/settings-06-conflict.png) ·
[backend failure](screens/settings-07-backend-failure.png) · [phone](screens/settings-08-phone.png) ·
[permission denied](screens/settings-09-permission-denied.png) ·
[white-label](screens/branding-01-white-label.png) ·
[contrast refused](screens/branding-02-contrast-refused.png).

[unavailable](screens/settings-10-unavailable.png) was added in the freeze pass below, and is the
one capture in this milestone that is **staged rather than reached**: `/settings` reports
"unavailable" when the session carries no tenant, and sign-in requires a tenant, so no real session
can be in that state. The identity responses are rewritten in flight to produce it. The branch
exists for D-1 (tenant discovery at sign-in), which can produce one — and a page that rendered
nothing at all in that case would be a white screen.

### Dataset

Restored and verified: 17 users, five tenants at their seeded names. ⚠️ One restore initially put
back a _leftover probe name_ rather than the seeded one — a restore is only correct if what it
captured was, and the fix was to check against `tools/seed/demo.ts` instead of trusting the
starting state.

### The freeze pass — and two defects it found

Before P-6.3 was frozen, three claims that had never been measured were measured.
[`p63-freeze.mjs`](p63-freeze.mjs) (26/26) and [`p63-freeze-ui.mjs`](p63-freeze-ui.mjs) (21/21), both
against the deployment.

**Is `/settings` the only tenant-administration surface?** Yes — one route, one nav entry, one
editable tenant-name field, and exactly two modules that reach for the mutation (the API binding and
its hook). ⚠️ The check that matters is not "is there a second route" but "is there a second
**caller**": a duplicate edit surface arrives as a second component long before it arrives as a
second URL.

**Is every mutation audited exactly once?** It was not. Two defects, both real:

1. ⚠️ **A double-click logged the change twice.** Two identical submissions arriving together each
   read the old value, each wrote it, and each announced the same transition — one state change,
   two audit records claiming to be it. The write is now conditional on a field actually differing,
   so only one can match.
2. ⚠️ **A no-op save moved the version token.** Resubmitting an unchanged name wrote a fresh
   `updatedAt`, which handed a **409 to every other administrator** with the settings page open —
   a conflict manufactured out of a change that never happened. A no-op now touches nothing.

A third, found while fixing them: a status-only PATCH rewrote the **name** as well, from the value
read a few milliseconds earlier. Only the fields a caller names are written now.

⚠️ **The double-click test lives in `integration.test.ts`, against real MongoDB, and that was
measured rather than assumed.** Written first beside the HTTP tests, it went green with the fix
reverted: the in-memory collection resolves without yielding, so the two requests serialize and the
second sees the value already applied. A check that cannot fail is not a check, so it lives where
the race is real — where it fails with **3** events and passes with **1**.

**Is the deployment an upgrade or a fresh install?** An upgrade, and provably: the running tenant
image was built _after_ the documents it is serving were written, by a build that did not have
optimistic concurrency in it. A record written by the previous image reads, patches without a
version token (the compatibility guarantee), accepts its own pre-upgrade timestamp as a token, and
refuses a stale one. No migration was required because no stored shape changed.

**Navigation** — deep link, refresh, back, forward, and arriving from another page all restore the
same state; a saved change survives leaving and returning, a hard refresh, and agrees with the top
bar. **Branding across three simultaneously-open pages** — all three change together after refresh,
all resolve the same accent token, and ⚠️ tabs open _across_ the change do not half-update.

⚠️ Two checks in that script were wrong before they were right, both in the same way: they read a
name that does not exist (`nav` textContent instead of `document.title`; `--brand` instead of
`--color-brand`) and so reported "every page agrees" by comparing empty strings to each other. The
branding implementation records falling into the `--brand` trap once already.

**L-27** is the residual: a caller that omits the version token _and_ races another writer gets a
`from` value one revision stale. The console cannot reach it. Closing it means adding a method to
the frozen `@vip/tenancy` repository that nothing else needs.

---

## P-6.4 · System Health

The brief was explicit: **not a dashboard full of green icons.** Seven states, kept apart, and never
"Healthy" without evidence.

### The seven states already existed

`WorkspaceDependencyState` was frozen in P-5.3 to draw exactly this distinction one level down —
`ready · not-built · not-configured · degraded · unreachable · forbidden · unknown`. So
`SystemComponentState` **is** that enum, aliased, not copied. A second spelling of a state machine is
a second thing to keep in sync, and the first divergence would be silent.

### ⚠️ `/health` is not evidence of health, and that is demonstrated rather than argued

Every service exposes `GET /health` returning `{"status":"ok"}` unconditionally. It proves a process
is up, which is what an orchestrator restarts on; it **cannot fail while the process can answer**.

So the page is built on `/ready`, which runs the registered dependency checks — and the verification
proves the difference by pausing MongoDB and asking both. With the database paused:

```
✓ C1 · ⚠️ every liveness probe still answers "ok" — tenant:ok events:ok rules:ok
✓ C2 · …and the health page does not say healthy — identity:unreachable tenant:unreachable …
```

A System Health page built on `/health` would have been **entirely green** at that moment, with the
platform unable to serve a single request.

### Three things it refuses to do

- **It never says "All systems operational."** That sentence is true only if every component is
  `ready`, and `unknown` is not `ready`. The summary counts what is actually known and says so.
- **It never lists a dependency nothing checks.** Redis is in the production compose stack and **no
  service connects to it**. A row reading "Redis · unknown" is indistinguishable, to a customer, from
  "Redis · broken", and it would be the gateway asserting something is part of the system — the one
  thing the gateway cannot know.
- **It never counts a missing capability as a fault.** "Live video · Not built · planned for P-8" is
  a roadmap fact. Folding it into the outage count trains an operator to ignore the banner.

### One call, not ten

The gateway assembles the report: it asks every upstream's readiness inside the cluster, derives the
infrastructure rows from what those services say about **their own** dependencies — nothing here
opens a socket to MongoDB — and caches for 5 seconds so concurrent viewers collapse into one
fan-out. Measured: **p50 2.9 ms · p95 4.9 ms** (n=30, through the edge).

### ⚠️ The permission was wrong in both directions at once

`system:read` was written first. `*:read` would have handed the deployment's component and dependency
topology to every **viewer** — the TD-26 wildcard hazard, third instance — and `admin`, which holds
no `*:read` at all, would have been **refused a page its own operators could see**. The route test
failed as `admin` before anyone reasoned about the viewer half.

`system:inspect`, for the same reason `audit:inspect` is not `audit:read`. Granted to `admin` and
`operator`; `owner` holds it through `*`. A viewer is refused — and the sidebar entry is gated too,
because advertising a page that will refuse you is the worst of both.

### ⚠️ Two defects the deployment found, and one it had been hiding

**1 · The MongoDB row vanished during a database outage.** Pausing MongoDB made every service's
readiness probe block; all ten timed out as `unreachable`; none reported a check; and the dependency
they all share **disappeared from the report**. Ten red rows during a total database outage and not
one word about the database. A silent service now contributes its _last known_ dependency names, so
the row survives as `Unknown — nothing can speak for it`. Claiming `unreachable` would be an
inference, and inference is what sends someone to the wrong place.

**2 · "fetch failed" is not a reason.** That is what a stopped container reported — a sentence adding
nothing to the word "Unavailable". `undici` keeps the real cause one level down; it now reads
`fetch failed (ENOTFOUND)`.

**3 · ⛔ The page could not be reached at all.** The edge routes `/health` to the gateway's liveness
probe — deliberately, with a comment explaining that an uptime monitor pointed at the obvious URL
must not get the SPA fallback and a cheerful 200. So a **console** route at `/health` is unreachable
in any deployment: the browser is handed `{"status":"ok"}` and never reaches the bundle.

The probe keeps the path; renaming something a customer's alerting points at, to make room for a
page, is the wrong way round. The page lives at **`/system`**, and ⚠️ **no redirect is possible** —
the request never arrives at the SPA to be redirected.

⚠️ **The placeholder had been equally unreachable, and `verify.mjs` reported the route as rendering
for two milestones**, because a JSON body logs no console errors and shows no crash boundary. The
route walk now asserts the **console shell** rendered. Proven against the old path:

```
✗ NOT THE CONSOLE  system      {"status":"ok"}
```

C-52 had been marked production-verified on the strength of the services' probes. The backend column
was true. The frontend column was a placeholder nobody could open.

### Verification

**[`system-health.mjs`](system-health.mjs) — 26/26**, through the edge, by breaking the deployment:
a service stopped (`Unavailable`, with a cause, and ⚠️ its silence _not_ counted as evidence about
the database), the database paused (the liveness/readiness contrast above), the permission boundary,
the cache, and latency.

**[`system-health-ui.mjs`](system-health-ui.mjs) — 24/24**, in a real browser. ⚠️ **Three of the six
screenshots are taken while the platform is actually broken** — a health page photographed only
against a healthy deployment proves the layout, not the product. Also: nothing painted off-screen at
390 px, zero unnamed controls, no heading skips, and the one control operable by keyboard alone.

**[`verify.mjs`](../roadmap-2026-08/verify.mjs) — 12/12 routes**, with the stricter assertion, and it
now exits non-zero.

Unit: gateway **62** (every aggregation case drives a real failure) · console **11** · permissions
**31**. ⚠️ The two deployment defects are pinned by tests **verified red** against the unfixed code.

### Screenshots

`screens/` — [loading](screens/health-01-loading.png) · [healthy](screens/health-02-healthy.png) ·
[one service down](screens/health-03-service-down.png) ·
[a database outage](screens/health-04-database-outage.png) · [phone](screens/health-05-phone.png) ·
[permission denied](screens/health-06-forbidden.png).

### Dataset

Restored and verified: **17 users, five tenants at their seeded names.** ⚠️ The probe accounts these
scripts create are removed rather than left disabled — there is no DELETE route, so the cleanup is a
`mongosh` line, and it is printed by the scripts that create them.

### Honest limits

**L-28** — it is a live reading, not a history: "was it down last night?" is not answerable from the
product. **L-29** — a _hung_ dependency makes a service read `Unavailable` rather than `Degraded`,
because a blocked check and a stopped container look the same from outside (**TD-50** — the fix is
in every service's Mongo probe, not in the page). **TD-51** — nothing structurally prevents the next
edge/router path collision; the Caddyfile and `router.tsx` still know nothing about each other.

---

## Still open after P-6.4

Notification centre · camera depth · media catalogue · workspace empty states ·
`/live` telling the truth · global search (TD-46) · command palette · responsive shell (TD-45) ·
table sort and counts (TD-47) · **D-1**, which is a P-6 exit criterion and still undecided.

New limitations recorded, none of them blocking a pilot: **L-21** email is immutable · **L-22** no
self-service password change (needs email delivery, P-7) · **L-23** a disabled user's access token
stays valid for up to 15 minutes · **L-24** suspending a tenant is not enforced · **L-25** settings
audit is log-only · **L-26** branding is per-deployment, not per-tenant · **L-27** a token-less
racing API client can log a stale `from` value · **L-28** System Health is a live reading, not a
history · **L-29** a hung dependency reads as unavailable rather than degraded.
