# P-6 · Make the Product Whole — implementation review

**In progress.** This package is written as each item lands, so it can be read before the milestone
closes. P-6 ends with a full review; what follows is the record so far.

**Verified against the running production deployment on 2026-08-04** — built images, deployed,
exercised through the edge. ⚠️ Never `pnpm dev` (gate 3; P-5.8 found evidence playback had never
worked outside it).

| Item                             | State   | Closed                                      |
| -------------------------------- | ------- | ------------------------------------------- |
| **P-6.0** product version        | ✅ done | root `package.json` → `0.4.0`               |
| **P-6.1** a rule can be edited   | ✅ done | **TD-21 · C-25 · L-6** — a pilot blocker    |
| **P-6.2** a user can be disabled | ✅ done | **TD-44 · C-03 · L-5** — the last blocker   |
| P-6.3 tenant settings screen     | ⏳ next | C-05                                        |
| P-6.4 System Health page         | ⏳      | placeholder today                           |
| P-6.5 notification centre        | ⏳      | C-31                                        |
| P-6.6 – P-6.14 (see the roadmap) | ⏳      | TD-45 · TD-46 · TD-47 · TD-40 (D-1) · TD-31 |

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

## Still open after P-6.2

Every remaining P-6 item, unchanged: tenant settings · System Health · notification centre · camera
depth · media catalogue · workspace empty states · `/live` telling the truth · global search
(TD-46) · command palette · responsive shell (TD-45) · table sort and counts (TD-47) · **D-1**, which
is a P-6 exit criterion and still undecided.

New limitations recorded, none of them blocking: **L-21** email is immutable · **L-22** no
self-service password change (needs email delivery, P-7) · **L-23** a disabled user's access token
stays valid for up to 15 minutes.
