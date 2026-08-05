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
| **P-6.5** the Inbox              | ✅ done | **C-41 · C-42** — and an empty demo dataset    |
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

### The freeze pass

[`p64-freeze.mjs`](p64-freeze.mjs) **20/20** and [`p64-freeze-ui.mjs`](p64-freeze-ui.mjs) **31/31**,
both against the deployment.

**Every state, produced — not reasoned about.** `Healthy` from the baseline; `Degraded` by stopping
MinIO, where evidence and media still _answer_ with a failing check; `Unavailable` from a stopped
container and from a dependency every reporter says is failing; `Unknown` by pausing MongoDB;
`Not configured` from a **throwaway gateway with `STREAM_ENABLED=false` beside the real one** —
because that state belongs to a deployment's configuration, and turning real-time delivery off on the
stack an operator is using is not a verification, it is an outage; `Not built` from the capability
register; `Forbidden` from a viewer. ⚠️ Service-level `unknown` is the one state **not** produced,
and it is stated rather than omitted: it means a process answered on the port with something that is
not a readiness report, which in a deployment means deliberately serving a broken service.

⚠️ **A defect found by leaving the page open and stopping the gateway.** The whole report was replaced
by "Couldn't load · Request failed (502)" — every row gone, during the exact outage the page exists to
report. A reading from twenty seconds ago is not current, but it is the only context there is. The
report now survives a failed refresh, the summary reads `Last known: …`, and a banner says everything
below is no longer current. The bare error state is reserved for having never loaded at all.

⚠️ **Six of the restart checks failed, and the page was right.** They used `docker restart`, and a
container that is down for three seconds — behind a five-second server cache, sampled every fifteen —
is **invisible by arithmetic**. The check was demanding that a sampled reading report an event
shorter than its own interval. Held open instead, every one of the six appears unattended in **14–18
seconds** and clears in **14**: gateway, MongoDB, NATS, MinIO, evidence, workflow. The sampling limit
is now stated in L-28 rather than discovered by a customer.

**Polling, measured**: **4 requests in 62 seconds** on the stated 15-second interval, and **0 in 35
seconds** after navigating away — a forgotten tab does not poll forever. Navigation: deep link,
refresh, back, forward and the sidebar entry all restore the report.

### Honest limits

**L-28** — it is a live reading, not a history: "was it down last night?" is not answerable from the
product. **L-29** — a _hung_ dependency makes a service read `Unavailable` rather than `Degraded`,
because a blocked check and a stopped container look the same from outside (**TD-50** — the fix is
in every service's Mongo probe, not in the page). **TD-51** — nothing structurally prevents the next
edge/router path collision; the Caddyfile and `router.tsx` still know nothing about each other.

---

## P-6.5 · The Inbox

The brief was explicit: **not merely a notification list — the operator's event inbox.**

### A delivery log is not an inbox, and the difference is who is asking

`/alerts` was a delivery log: one row per channel per incident, answering the question an engineer
asks — _did the webhook POST succeed?_ An operator opening it asks a different question: _what needs
me?_ One incident that fanned out to three channels is **one** thing to deal with, and a screen that
lists it three times teaches people to skim the screen that exists to stop them skimming.

It is now grouped by incident, triaged by whether anybody has taken it, and every entry links to the
incident. ⚠️ **The per-channel records are not deleted** — they expand underneath, because "the
webhook to the customer's SOC never fired" is still something somebody has to know.

### ⚠️ Two questions, deliberately not collapsed

- **Has anyone dealt with this?** — the queue, and the number on the bell.
- **Did every channel deliver?** — shown beside it, and **not** cleared by acknowledging.

An operator taking an incident says nothing about whether the customer's own system was told. Merging
the two would either hide delivery failures behind an acknowledgement or leave handled incidents in
the queue because a webhook is misconfigured. Both produce a queue nobody trusts.

### The count that follows you

A bell in the top bar carries the number of **incidents** waiting, on every screen, and moves the
moment somebody takes one. ⚠️ A queue you have to remember to visit is a page. It counts incidents
rather than delivery records (three channels would otherwise read "3"), caps honestly at one page
(`50+`, never a number that silently stops rising), and shows **nothing at all** when it is zero or
when the request failed — a bell reading "0" because the fetch failed is a lie in the shape of an
all-clear.

### One additive contract field, and why the browser could not do it

`NotificationQuery.acknowledged` — optional, additive. `status` selects **one** state and the inbox's
question is the complement of one (`pending`, `sent`, `delivered` **and** `failed`). Filtering in the
browser answers it correctly for the rows that happen to be loaded and silently wrongly for the rest,
which is how an unread badge becomes a lie. ⚠️ A `failed` delivery counts as unacknowledged: it
reached nobody, so nobody can have dealt with it.

⚠️ It is parsed as two literal words, because a query string carries text and `Boolean('false')` is
`true` — a coercion that turns "unread only" into "everything" while every test passing a real
boolean stays green. Pinned by a test that fails against exactly that bug.

### ⚠️ Two defects, and neither was in the new code

**1 · The acknowledger was whatever the caller typed.** `ackedBy` came **entirely from the request
body**. The console sent nothing, so every acknowledgement it made was **unattributed** — a queue
nobody signs is a queue nobody owns — and a caller who did send it could name **anyone**. The record
of who took a security alert was client-supplied.

Found by looking at what the handled view rendered: "taken", with no name. The server now records the
**authenticated principal**; `by` stays in the contract for compatibility and is deliberately ignored.
⚠️ An audit field a caller can choose is not an audit field. ⚠️ The existing test **asserted the
defect** — it passed a `by` and checked it came back — so it was rewritten to assert attribution and
joined by one that forges a name and proves it is discarded.

**2 · The demo dataset had no alerts at all.** The seed wrote incidents and **no notifications**, so
the one screen that answers "what does an operator do when something happens" showed a prospect
nothing, while the incident queue beside it was full — through every demonstration this product has
ever had. The seed now writes the channels and the deliveries the Alert Engine would have produced,
consistent with each incident's own lifecycle: an incident somebody acknowledged has an acknowledged
in-app delivery **by the same person**, so the two screens agree.

⚠️ Including **one webhook failure per vertical**. A product that can only be shown succeeding has not
been shown, and "a failed delivery is visible in the console, with the reason" is a 0.5 exit
criterion that cannot be demonstrated against a dataset in which nothing ever fails. ⚠️ The first
attempt keyed the failure on "the oldest high-severity incident" and fired for **no vertical at all**
— every incident old enough happened to be low severity. A fixture that depends on a coincidence in
the fixtures is not a fixture.

### Verification

**[`inbox.mjs`](inbox.mjs) — 20/20** through the edge: the two halves of the queue add up to the
whole, a failed delivery sits in the queue rather than being filed as handled, acknowledging removes
it from the server's answer, a failed delivery **cannot** be acknowledged (409 — there was no
recipient), tenant isolation, and an operator may clear the queue where a viewer may not. p50 7.8 ms,
p95 9.1 ms.

**[`inbox-ui.mjs`](inbox-ui.mjs) — 24/24** in a real browser, including the bell moving without a
reload. ⚠️ **The script supplies its own subject.** Acknowledging is one-way by design, so a
verification that consumes the demo queue works once and reports "there is nothing to take" forever
after — which is what the first run did. One disposable delivery is inserted, used, and removed.

⚠️ Three of its checks were wrong before they were right, each in a way worth keeping: it demanded
the numeric form of "reached N of M channels" and went red against the entry reading **"reached no
channel"** — the one whose wording matters most; it intercepted a route with a glob containing `?`,
which is a wildcard, so it matched nothing and reported the live queue as empty; and it asserted
every historical acknowledgement was attributed, which reported a permanent past as a present defect.

Unit: notify **21** · console **20** (11 on the pure grouping, 9 on the screen).

### Screenshots

[the queue](screens/inbox-01-queue.png) ·
[a delivery that never arrived](screens/inbox-02-delivery-failure.png) ·
[after acknowledging](screens/inbox-03-after-acknowledge.png) ·
[handled](screens/inbox-04-handled.png) · [an empty queue](screens/inbox-05-empty-queue.png) ·
[phone](screens/inbox-06-phone.png) · [as a viewer](screens/inbox-07-viewer.png)

### Honest limits

**L-30** — there is no per-operator read state; the only state is "somebody acknowledged this", which
is right for a shared control room and worth saying out loud because the word "inbox" sets a
different expectation. **L-31** — no bulk clear and no snooze; acknowledging acts on one incident,
⚠️ and "acknowledge all" is refused on purpose. **L-4** stands: in-app and webhook only.
**TD-52** — ⚠️ the demo seed is **not idempotent**: two consecutive runs left 90 incidents where 18
were expected, found while seeding the alerts.

---

## P-6.5 freeze · the production-grade pass

Twelve areas, against the deployment. Four defects, one of them the most serious thing found in P-6,
and three checks that could not fail.

### ⚠️ Two operators could both take the same alert

`ack` read the record, checked it was acknowledgeable, and wrote it back. Two people seeing the same
alert land both passed the check before either wrote, and **both were told they had the incident**.

The first version of the test agreed with the code. Six simultaneous requests produced one `200` and
five `409`s — and it was a fiction: `fetch` pools by origin, so all six left on **one socket** eight
milliseconds apart and the server saw a neat queue. Given its own connection per racer, and repeated:

```
winners per round: 3, 4, 1, 1, 2, 3, 1, 2, 2, 4, 3, 2      ← before
winners per round: 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1  ← after (15 rounds × 16 operators)
```

Six operators looked correct. Twelve did not. In a security product this is not a cosmetic race: two
people each believe they own an alert, so each assumes the other is on it, the queue clears, and the
record names whichever write landed last rather than the person who acted.

Fixed by putting the acceptable statuses in the **filter** — `replaceIfStatus`, so MongoDB decides
the winner. The pre-read survives only to explain _why_ to the loser, re-read from storage rather
than assumed. ⚠️ The regression test lives in `mongo-integration.test.ts` against real MongoDB, and
was **verified red there first: 10 winners out of 12.** Against the in-memory store the same test
passes on the defect, which is exactly how it survived — `InMemoryNotificationStore.replaceIfStatus`
carries a comment saying so.

**Is it systemic?** The obvious next question, so it was asked rather than assumed. Every other
state transition that writes after a read is already safe, for three different reasons: incidents
carry a **version token** in the update filter (`replace(scope, next, expectedVersion)`); the Alert
Engine's own `replace` calls have a **single writer** per record, guarded by the per-`(incident,
channel)` uniqueness; and `disable`/`enable` on a user are **deliberately idempotent** — "already
disabled is the requested end state, not a conflict" — because two administrators disabling the same
leaver both succeeding is correct. Acknowledgement was the one transition where **exclusivity is the
whole point**, and it was the one without a guard.

The audit trail was never wrong, and not because of the HTTP layer: the publisher stamps
`msgId = {tenant}:{id}:acked` and JetStream collapses duplicates for 120 seconds, so **exactly one
`notification.acked` would have been published even while the row transitioned four times**. The
msgId was carrying more weight than it looked like it was.

### ⚠️ The demo dataset advertised a retry mechanism that does not exist

The seed wrote `attempts: 3` and `"connect ETIMEDOUT … after 3 attempts"`. Driving the real Alert
Engine over four real transports says otherwise: **every delivery, successful or failed, has
`attempts: 1`.** There is no retry loop, and the fan-out's idempotency guard means a redelivered
incident _skips_ a channel that already has a record — so a webhook that was down for thirty seconds
never receives that alert and nothing tries again.

A demo dataset showing a capability the product does not have is a promise somebody will be held to.
Corrected to one attempt, recorded as **L-32**, and **TD-53** opened at high priority. The check that
used to demand `attempts > 1` now asserts `attempts === 1`, so the day retries are built it goes red
and somebody has to update the claim deliberately.

### ⚠️ The queue disappeared during the outage it exists to survive

P-6.4 found System Health blanking when the gateway went away, and fixed it there. Nobody asked the
same question of the Inbox, which has the same shape and the same `QueryBoundary`. Asked here, with
the gateway stopped and the page open:

```
the queue (25)  →  Couldn’t load · Request failed (502)  (0)
```

Twenty-five entries gone for the twelve seconds the gateway took to come back — on the screen an
operator watches all shift, and an operator whose queue empties has no way to tell _nothing needs me_
from _I cannot see_. The queue is now **kept and labelled** ("This queue could not be refreshed…"),
and it repopulates in **2 s** instead of 12 because it never emptied. ⚠️ Keeping it silently would be
the worse failure of the two, so the check asserts the banner as well as the rows — a retained list
that does not say it is old is one an operator has no reason to doubt.

Verified red before it was trusted: with the fix reverted, the banner never appears.

### ⚠️ Two operators split one incident, and both were told it failed

Acknowledging is per **delivery**; an operator acts on an **incident**. Under a real race those come
apart — measured on the deployment, an incident that had reached two channels was **split** between
two people, and each was told _"1 of 2 could not be acknowledged"_ about an incident that was now
unambiguously taken. There was a second wording problem beside it: whether the loser got the useful
sentence or `cannot acknowledge a notification in status 'acked'` depended on **how** they lost — a
loser refused by the pre-read got the status enum, and that is the more likely of the two.

Both fixed by answering the question the operator actually asked. The message now follows what became
true of the incident — anything succeeded means it is taken; everything conflicting means somebody
else has it, named — and the server produces one refusal sentence whichever path refuses. Found by
reading the screenshots this pass produced, not by a test.

### ⚠️ "fetch failed" is not a reason, in a second place

A webhook to a dead host recorded `fetch failed`; one that never answered recorded
`This operation was aborted`. Both met the letter of the 0.5 exit criterion — _a failed delivery is
visible in the console, **with the reason**_ — and neither tells an operator which person to call.
The same `undici` lesson as the gateway's readiness probes in P-6.4, in a second place. Now:

```
the endpoint rejected it (HTTP 503)   ·   no response within 5s
connection refused by the endpoint    ·   the endpoint’s host name could not be resolved
```

### ⚠️ The one screen designed to stay open all shift got more expensive every time it was used

An infinite query refetches **every page it has loaded** on every interval. Measured at 5,000
deliveries: **29 KB per tick with one page, 610 KB with twenty** — about 800 MB per operator per
eight-hour shift, growing with each "Load more" and never coming back down. The queue is now bounded
at ten pages and **says so on screen**, because a "Load more" that quietly stops appearing is a queue
that looks finished when it is not. **L-34**, **TD-54**.

### Every state produced, and the three that do not exist

`pending · sent · delivered · failed · acked` — all five produced by the product, none inferred.
Delivered two ways (in-app, and a webhook answering 204); failed two ways (a 503, and a transport
that never answered); `sent` caught while a transport was still deciding; `acked` through the API,
attributed to the authenticated principal.

`pending` was the interesting one. It exists for one database round trip per delivery, so sampling
cannot catch it — eight `docker pause` snapshots caught the fan-out four times and never once inside
the window. Changing the odds instead of the luck: every channel silenced, twelve **in-app** channels
stood up so the fan-out is nothing but database writes, three hundred incidents raised in a single
publish, then the process frozen while the same queue drained. Caught at freeze 9, and confirmed
transient — it advanced to `delivered` as soon as the process ran again.

⚠️ **`expired`, `retried` and `dismissed` do not exist.** The enum has exactly five members and the
script asserts it, so adding a sixth forces somebody to come and say what it means.

### Scale, measured

5,000 deliveries loaded into the production log (and removed again, asserted back to the row it
started at):

|                       |                                                                      |
| --------------------- | -------------------------------------------------------------------- |
| queue query, p95      | **13.4 ms** · unfiltered 11.0 ms                                     |
| page 20, keyset       | **18.7 ms** — page 20 costs what page 1 costs                        |
| plan                  | `IXSCAN`, index-served sort, **9.2 documents read per row returned** |
| first entry on screen | **837 ms** · expand **38 ms** · triage filter **648 ms**             |
| DOM                   | 572 nodes for one page; the 5,000-row log is never in the browser    |

⚠️ The 9.2:1 read ratio is the honest number: `status: {$ne:'acked'}` is not in the index, so a
newest-first walk fetches and discards acknowledged rows. Fine here, worth knowing before a
customer's queue reaches six figures rather than after.

### Two operators, two browsers

The API race proves the transition; this is the half an operator experiences. Both press at the same
moment, and the loser used to be told **"1 of 1 could not be acknowledged"** — which sounds like the
product broke. Now:

> _this alert was acknowledged by security.manager@northgate.demo a moment ago_

Losing a race is ordinary shift work, and it must not read like a fault. Pinned by a console test
that mounts the real toaster, so what an operator is **told** is asserted as rendered text rather
than as a spy on a function call.

### Refresh, responsive, accessibility

The waiting count survives a refresh; the triage filter survives (it is in the URL, so it survives a
link too); an expanded row deliberately does not — a glance, not a setting. **A new critical alert
reached an open screen in 1 second with no refresh and no click**, so no cache can hide one.

Four screen sizes — 1920, 1440, 820, 390 — no horizontal scroll, nothing painted off-screen, no
control under 24 px, no page errors at any size. Every control named, no heading skips, the expander
reports its state, a live region carries the announcements, 30 tab stops all with a focus ring, and
**both Acknowledge and Open incident reachable without a mouse**.

⚠️ **Gate 5 is red, and not for anything in this milestone.** `overflow.mjs` clips at 768 px and
390 px — **identically on every page**, including ones this pass never touched, and every clipped
element sits outside `<main>` at `left: 429` on a 390 px viewport. That is the shell, which is
**TD-45**, already open and still owed by P-6. The Inbox's own content is clean at all four sizes;
this is reported rather than rounded up.

### Forty minutes with both screens open

Every dependency taken away one at a time and held down until the screen said so — a container out
for three seconds behind a five-second cache on a fifteen-second refresh is invisible by arithmetic.

| dependency                    | noticed | cleared | queue back |
| ----------------------------- | ------- | ------- | ---------- |
| MinIO (**Object storage**)    | 10 s    | 15 s    | —          |
| NATS (**Message backbone**)   | 9 s     | 15 s    | —          |
| evidence                      | 9 s     | 15 s    | —          |
| media                         | 9 s     | 15 s    | —          |
| workflow (row: **Incidents**) | 16 s    | 14 s    | 2 s        |
| MongoDB (→ **Unknown**)       | 8–10 s  | 8 s     | 2 s        |
| gateway (report marked stale) | 6 s     | 6 s     | 2 s        |

⚠️ MongoDB reads **Unknown**, not Unavailable — nobody can speak for it, which is the distinction
P-6.4 built. Over the run: **43 alerts raised, no duplicates after all the reconnecting, ordering
held, no page errors, heap 12.1 → 9.5 MB** across 58 samples.

⚠️ **Three of those seven were first reported as `NEVER`, and the page was right every time.** The
soak's reader took each row's label from the first `<p>, span`, which for a _healthy_ row is the state
dot's empty `<span>` — so healthy rows were dropped and MinIO "never recovered" on a platform where it
recovered in fifteen seconds. Then two expectations named rows that do not exist: the workflow
service's row is **Incidents**, MongoDB's is **MongoDB** rather than "database". ⚠️ **A check whose
expectation names something that does not exist cannot pass** — the mirror of one that cannot fail,
and just as worthless. Both scripts now assert every label against the page **before** the first
container is stopped, so a mismatch is red at second zero instead of a `NEVER` twenty-three minutes
in.

### Eight checks that could not do their job

Recorded together because the pattern is the point, not the individual mistakes. **Three could not
fail**, and **five could not pass** — the second kind is rarer, louder, and just as worthless, since
it sends you looking for a defect in a product that is behaving.

_Could not fail:_

1. **The race that never raced** — six requests serialised onto one socket, so the server saw a neat
   queue and answered correctly. The script now asserts the requests genuinely overlapped before it
   believes its own result.
2. **`'' === ''`** — the bell count was read from the link's text content, found nothing, and
   compared nothing to nothing across the refresh. It reads the accessible name now and asserts a
   digit is present _before_ comparing.
3. **The halves that added up to a page** — compared three single pages and read `200 + 200 = 200`
   at 5,000 rows. It pages through the whole set now.

_Could not pass:_

4. **The reader that could not see healthy** — a row's label taken from the first `<p>, span`, which
   for a healthy row is the state dot's empty `<span>`. Reported "never recovered" on a dependency
   that recovered in 15 s.
5. **Two labels that do not exist** — `workflow` and `database`, for rows the page calls **Incidents**
   and **MongoDB**.
6. **The toast that had already gone** — waited 2.5 s on one page then 2.5 s on the other before
   reading either; five seconds after a click, by which time sonner had cleared both at its
   four-second default. Reported that neither operator was told anything.
7. **The banner read through the wrong element** — `[role="alert"]` scooped up the page's own
   permanent delivery-failure banner and reported it as both operators' answer.
8. **The sentence that was on screen** — the cap message failed three ways in a row: the number was
   interpolated mid-sentence and split the text node; `getByText` with a regex then matched nothing
   anyway; and the regex expected "most recent 500 deliveries" when the page reads "the **500 most
   recent** deliveries". ⚠️ When a query disagrees with the page, believe the page.

⚠️ Two of these were only caught because the run **printed what it saw** rather than only whether it
passed. A check that reports `✗` and nothing else cannot be audited by the person reading it.

### TD-52 paid, and more than was owed

Incident ids are derived from the vertical and the spec index, so a re-run replaces instead of
duplicating. ⚠️ Upserting alone was not enough: anything an earlier run left behind under different
ids survived every subsequent run. The seed now **sweeps** — after writing, it removes demo-tenant
documents in the three collections it owns whose ids it did not write, and reports what it removed.
Verified by running it **three times in a row**: identical counts each time (19 incidents · 32
notifications · 127 events), with the non-demo `tnt_dev` tenant's rows correctly untouched.

---

### The scripts, and what each one is for

Every one runs against the **deployment**, through the edge, and reports what it measured rather than
only whether it passed. The Playwright ones must be copied to a directory that has Playwright
installed — it is deliberately not a repo dependency.

| Script                                                     | Answers                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`inbox.mjs`](inbox.mjs)                                   | The queue, delivery failures with their reasons, isolation, permissions, latency, and what every record carries   |
| [`inbox-ux.mjs`](inbox-ux.mjs)                             | Two browser sessions on one alert · refresh recovery · four screen sizes · accessibility and keyboard-only        |
| [`inbox-concurrency.mjs`](inbox-concurrency.mjs)           | The acknowledgement race — on **separate sockets**, and it proves the requests overlapped before believing itself |
| [`inbox-scale.mjs`](inbox-scale.mjs)                       | `load` / `api` / `clean` — 5,000 deliveries, latency, `explain`, and proof the harness left nothing behind        |
| [`inbox-scale-ui.mjs`](inbox-scale-ui.mjs)                 | The same 5,000 in a browser: render, interaction, DOM weight, and the polling ceiling                             |
| [`notification-lifecycle.mjs`](notification-lifecycle.mjs) | Every delivery state **produced** by the product over four real transports; the three that do not exist           |
| [`soak.mjs`](soak.mjs)                                     | Forty minutes with the Inbox and System Health open while every dependency is taken away and put back             |
| [`p65-freeze-screens.mjs`](p65-freeze-screens.mjs)         | The production screenshots — including a real degradation and a real recovery                                     |

⚠️ [`lifecycle-publish.mjs`](lifecycle-publish.mjs) is copied **into the notify container** and raises
a real `incident.raised` on the backbone. Nothing in this package writes a delivery record directly:
the Alert Engine produces every one of them, or the measurement is of nothing.

---

## Still open after P-6.5

Camera depth · media catalogue · workspace empty states ·
`/live` telling the truth · global search (TD-46) · command palette · responsive shell (TD-45) ·
table sort and counts (TD-47) · **D-1**, which is a P-6 exit criterion and still undecided.

New limitations recorded, none of them blocking a pilot: **L-21** email is immutable · **L-22** no
self-service password change (needs email delivery, P-7) · **L-23** a disabled user's access token
stays valid for up to 15 minutes · **L-24** suspending a tenant is not enforced · **L-25** settings
audit is log-only · **L-26** branding is per-deployment, not per-tenant · **L-27** a token-less
racing API client can log a stale `from` value · **L-28** System Health is a live reading, not a
history · **L-29** a hung dependency reads as unavailable rather than degraded · **L-30** the inbox
has no per-operator read state · **L-31** no bulk acknowledge and no snooze · **L-32** ⛔ a failed
delivery is never retried and nothing re-sends it — **say this before a customer wires their SOC to a
webhook** · **L-33** a delivery interrupted mid-flight stays `pending` for ever · **L-34** the queue
shows the most recent 500 deliveries and then says so · **L-35** a notification does not name the
service that produced it.

---

# P-6.5 freeze close-out — 2026-08-05

**Not an implementation pass.** P-6.5 was feature-complete and committed at `a139080`. What follows
is the audit that decided whether the _verification_ could be believed: every script mutation-tested,
every claim traced to the deployment, and the deployment traced to the commit.

Full inventory: **[VERIFICATION_MATRIX](VERIFICATION_MATRIX.md)**. Engineering lessons, written so a
later milestone inherits them without the incident: **[P6-5-LESSONS](P6-5-LESSONS.md)**.

## What the audit found

Two product defects, both customer-facing, neither visible to any check that existed:

⚠️ **The demonstration reset was putting back the fabrication the milestone removed.** The seeder runs
out of a service image, and that image had not been rebuilt since before the fix — so `demo.sh reset`
restored `attempts: 3` and _"connect ETIMEDOUT … after 3 attempts"_, describing a retry mechanism the
platform has never had, on a deployment whose source, tests and scripts were all correct. It surfaced
because `inbox.mjs` **2d** asserts the measured truth (`attempts === 1`) rather than the intent, and
went red on a dataset a salesperson would have demonstrated. Fixed by rebuilding; guarded by
[`deployment-integrity.mjs`](deployment-integrity.mjs) §5 and recorded as **TD-55**.

⚠️ **Two operators could both come away owning one incident.** Acknowledging is per delivery; the
button is per incident. On an incident that reached two channels, two operators pressing together
take one delivery each — both acknowledgements genuine, both told _"Alert acknowledged"_. Each
sentence was true and the pair of them was not. Measured on the deployment, then fixed to say both
things: _"Alert acknowledged — day.operator@northgate.demo is on this incident too"_. Incident-level
exclusivity needs a claim on the incident and is **L-36 → P-7**, deliberately not built inside a
freeze. ⚠️ It was found by a screenshot assertion added an hour earlier — a check on a _file_
catching a defect in the _product_.

## Nine verification defects, in four shapes

Four **could not fail**. Two **could pass for the wrong reason**. Two **could fail for the wrong
reason**. One could do neither — it crashed where a verdict belonged and took six later checks with
it.

| Where                    | What it was doing                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `inbox-ux.mjs` 1e        | `… \|\| true` — a tautology. Reported "both queues refreshed themselves" on every run since it was written                        |
| `inbox-scale.mjs` 2a/2b  | `explain()`ed a query **the script wrote**. A build doing a 5,000-row in-memory sort passed both checks                           |
| `p65-freeze-screens.mjs` | Wrote eight PNGs and asserted nothing about any of them. A blank page, a spinner or the login screen would have passed            |
| `inbox-ux.mjs` 2d        | Matched a probe title that persists **across runs** — an earlier run's alert satisfied "a new alert arrived"                      |
| `inbox-ux.mjs` targeting | Matched entries **by title**, and the load harness gives 2,500 incidents six titles. Two operators pressed different alerts       |
| `soak.mjs`               | Two: a fixture a container rebuild had deleted (nine alerts silently never raised), and a crash after 5d that skipped five checks |

All fixed. `inbox.mjs` gained **1g** — the server's own ordering — because the console sorts client-side,
so `soak.mjs` 5d rendered newest-first through a build that served the queue oldest-first.

## Mutation testing — the product was broken, not the assertion

Ten scripts, each run against a deliberately broken build or dataset, then restored and re-run.
Highlights, with the rest in the [matrix](VERIFICATION_MATRIX.md):

- **The atomic filter removed from the acknowledgement write.** `inbox-concurrency.mjs` §5 went red
  with 2–4 winners in 8 of 12 rounds; the notify integration test went red with _expected 1, got 10_;
  `inbox-ux.mjs` showed both operators told they had won. ⚠️ **§1's single six-racer round passed
  against the defect** — the round that reads best in a report is not the round that does the work.
- **The queue's page cap removed.** `inbox-scale-ui.mjs` measured 25 clicks, 651 entries and 27
  requests per 20 s — the TD-54 growth, visible again the moment its bound came off.
- **The retained queue's staleness label removed.** `outage.mjs` caught the queue being kept and
  passed off as current, which is the more dangerous half of the P-6.4 defect.
- **Polling, ack-refresh and the live stream's refresh all removed together.** Only then did the
  Inbox stop converging — two independent paths keep it fresh, which is worth knowing.

## Deployment integrity

[`deployment-integrity.mjs`](deployment-integrity.mjs) compares every service's and package's
compiled output, the console bundle in the image **and the one the edge serves**, the image each
container is actually running, and the seed inside the tool image, against a build of the working
tree. It needed no mutation to prove it works: it went red the first time on three real states — a
dirty tree, the stale seeder, and a stale local `dist` carrying a route file whose source had been
deleted two milestones earlier.

⚠️ It also exposed that `.d.ts` output is **not** byte-reproducible (TypeScript does not fix union
order across compilations), so runtime bytes are compared strictly and declarations are reported
rather than judged. A check that goes red on a correct deployment is a check that gets explained away.

## The freeze

**P-6.5 is frozen at commit `150d536`, 2026-08-05.** `deployment-integrity.mjs` reports _every
running byte is commit 150d5364_ — ten services, eight shared packages, the console bundle the edge
serves, the image every container is running, and the seed inside the tool image.

No further change to the Inbox or System Health without one of:

- a **production defect**,
- an **approved ADR**, or
- a **new implementation issue** opened against a later milestone.

### The gate, honestly

| Gate                                                        | Result                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 · deployment integrity                                    | ✅ every running byte is `150d536`                                                                                                                                                                                                                  |
| 1 · typecheck · lint · tests · imports · contracts · format | ✅ 28 · 20 · 28 task(s) · 0 violations · 70 schemas · clean                                                                                                                                                                                         |
| 1b · integration suite (`VIP_REQUIRE_MONGO=1`)              | ✅ 18 tasks — including the acknowledgement-race regression, which now **refuses** to skip                                                                                                                                                          |
| 2 · build + bundle budget + no chunk cycles                 | ✅ 19 tasks, 42 assets within budget                                                                                                                                                                                                                |
| 3 · production deployment verified                          | ✅ built images, deployed, exercised through the edge                                                                                                                                                                                               |
| 4 · every route renders                                     | ✅ `verify.mjs` 12/12, zero page errors                                                                                                                                                                                                             |
| 5 · responsive                                              | ⛔ **red at 768 px and 390 px — TD-45**, three and five clipped elements, identical on every page, every one of them in the shell's top bar. Pre-existing, owed by P-6, outside this milestone. The Inbox's own content is clean at all four widths |
| 6 · accessibility                                           | ✅ 0 unnamed · 0 under 24 px · 0 heading skips · every tab stop focus-visible                                                                                                                                                                       |
| 7 · keyboard-only                                           | ✅ acknowledging and opening an incident, no mouse                                                                                                                                                                                                  |
| 8 · recovery                                                | ✅ seven dependencies taken away and restored under a live screen; 9–11 s to notice, 14–15 s to clear                                                                                                                                               |
| 10 · review package                                         | ✅ this document, [VERIFICATION_MATRIX](VERIFICATION_MATRIX.md), [P6-5-LESSONS](P6-5-LESSONS.md)                                                                                                                                                    |
| 11 · limitations recorded                                   | ✅ L-36 added; L-32…L-35 carried forward                                                                                                                                                                                                            |
| 12 · governance current                                     | ✅ capability matrix · TECH-DEBT (TD-55, TD-56) · roadmap · release plan · MASTER_PROGRESS                                                                                                                                                          |
| 13 · the verification is itself verified                    | ✅ ten scripts, each failed once for the correct reason and restored                                                                                                                                                                                |

⚠️ **Gate 5 is reported red rather than rounded up.** It has been red on every page since P-6.2 for
one defect in one component, and the honest thing at a freeze is to say so — the milestone did not
cause it and cannot close it.
