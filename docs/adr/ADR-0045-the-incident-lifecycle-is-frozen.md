# ADR-0045 — The incident lifecycle is frozen, and two of its states are declared unreachable

- **Status:** Accepted
- **Date:** 2026-08-06
- **Milestone:** P-8 Phase 7 — Retail Loitering (post-approval recommendation 2)
- **Supersedes:** nothing. **Extends:** ADR-0029 (incident workflow entry criteria — the enum-extension
  hazard), ADR-0030 (incident prerequisites). **Related:** ADR-0044 (one word, two zones).

## Context

The Architect approved P-8 Phase 7 and asked for the incident lifecycle to be **frozen as a
contract** before any more customer capabilities are built on it — architecture only: no workflow, no
UI, no persistence change, no business logic. The lifecycle named for freeze was:

```
Candidate → Open → Acknowledged → Resolved → Dismissed → Archived
```

Three things were already true when that arrived, and they decide most of what follows.

### 1. The platform already had a lifecycle, and it was already in production

`IncidentStatus` — `raised · acknowledged · investigating · escalated · resolved · closed` — has been
persisted on every incident since P1-8, is published on the wire as `incident.raised` /
`incident.acknowledged` / …, is consumed by the Notification context, is enforced by a transition
table with an audit trail, and is rendered by the console. Four of the six words the Architect used
already exist; two of them are spelled differently.

### 2. There is a second, earlier state machine, and it is not the same object

`IncidentCandidateStatus` — `candidate · promoted · dismissed · merged · expired` — lives in the
**Rules** context and describes a _proposal_, not an incident. A candidate that is never promoted has
no incident and therefore no incident lifecycle. `Candidate` is the first word in the Architect's
chain and the only one that does not name an `IncidentStatus`.

### 3. The transition table existed in **four** places

One in `services/workflow/src/domain/incident-state.ts` (the enforcing copy), and three in the
console: `features/incidents/status.ts`, `features/workspace/useCollaboration.ts`, and a second
label/colour map inside `ui/soc/incident-card.tsx`. Each carried a comment saying it _mirrored_ the
workflow state machine. Nobody had noticed there were four, because nothing had ever changed the enum
in a way that made them disagree out loud.

## Decision

### The existing `IncidentStatus` is the frozen lifecycle. Nothing is renamed.

| approved word | frozen as                           | why                                                                                                                                                                |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Candidate     | `IncidentCandidateStatus.candidate` | a different context and a different object — see §2 above                                                                                                          |
| **Open**      | **`raised`**                        | the same state under an older name. Renaming a persisted enum value is a migration of every stored incident **plus** a breaking change to a published subject name |
| Acknowledged  | `acknowledged`                      | —                                                                                                                                                                  |
| Resolved      | `resolved`                          | —                                                                                                                                                                  |
| **Dismissed** | **`dismissed`** — new               | see below                                                                                                                                                          |
| **Archived**  | **`archived`** — new                | see below                                                                                                                                                          |

`investigating` and `escalated` are **kept**. They are not in the approved chain, they are in
production since P-5.0 G-1, and the investigation workspace enters them. A freeze that dropped them
would be a freeze of something the platform is not running.

⚠️ **Renaming `raised` → `open` was considered and rejected.** It is a one-word change and a
three-context break: stored records, the `incident.raised` subject the Notification context filters
on, and every integration pinned to the current schema. The word an operator reads is a display
label, and the console renders `raised` as "Raised" today and could render it as "Open" tomorrow
without touching the wire at all.

### `dismissed` closes a real gap

Today an incident that turns out to be **nothing** must be `resolved` — the same word used for one
that was real and was handled. Every resolution count, every mean-time-to-resolve, and every "are
these rules any good" question is computed over a set that silently mixes the two. This matters more
now than it did last month: P-8 Phase 7 shipped the first rule that a customer will tune, and tuning
it means counting its false positives. A false positive is not a resolution; it is a statement about
the rule.

It is reachable from every active state, for the same reason `resolved` is: a false positive is
recognisable at any point, and making an operator "resolve" one first is what makes the count
meaningless.

### `archived` is custody, not an outcome — and that is why it is a separate state

⚠️ **`archived` is not a synonym for `closed`, and the risk of it becoming one is the reason this
section exists.** ADR-0044 recorded the cost of one word meaning two things; the opposite mistake is
just as expensive.

- `closed` is an **outcome**: a person finished with this incident.
- `archived` is **custody**: a retention policy moved the record out of the working set after its
  period elapsed. No operator decided anything.

One is entered by a person, the other only ever by the platform, and `INCIDENT_LIFECYCLE` records
that difference in `enteredBy`. Collapsing them would make "how many did we close last month" a
question about the retention schedule.

### Both are **declared and unreachable**

`dismissed` and `archived` have `reachableFrom` sets and **no action targets them**. `ACTION_TARGET`
in the workflow domain is the only way into a state, so a state with no action cannot be produced by
any code path. `reachable: false` records that in the contract itself.

This is the pattern `IncidentCandidateStatus`, `RuleReferenceKind` and `DependencyStatus` already
used, and the reason is ADR-0029: **adding a value to a published enum is not purely additive for a
strict parser.** Declaring them costs one compile error per exhaustive consumer, today, where the
compiler finds all of them in eleven seconds. Adding them later costs a coordinated release across
the console, the notification service and every customer integration — and until that release lands,
a console that meets a `dismissed` incident renders a blank chip beside a record nobody can explain.

### The table moves into the contract, and the four copies become one

`INCIDENT_LIFECYCLE` in `@vip/contracts` is now the single declaration of which transitions exist:
per state, whether it is terminal, who may enter it, and which states it may be entered from.

- `services/workflow` **derives** `ALLOWED_FROM` from it. The test that asserts the enforcement
  table's exact shape is unchanged and still passes, which is what makes the derivation trustworthy
  rather than merely tidy.
- `apps/console/features/incidents/status.ts` derives which actions it offers.
- `apps/console/ui/soc/incident-card.tsx` owns the label/colour map, and `features` imports it —
  that direction, because the import boundary allows `features → ui` and not the reverse.
- `apps/console/features/workspace/useCollaboration.ts` **keeps its own table on purpose.** The
  workspace deliberately offers _less_ than the server permits: the frozen lifecycle allows `resolve`
  straight from `raised`, and the workspace does not offer it, because resolving an incident nobody
  has acknowledged is a mis-click on the way to the acknowledge button. That is a workflow opinion,
  not a rule. A test now asserts the workspace's table is a **subset** of the frozen one, so the
  narrowing can never silently become a widening.

## Consequences

### What this bought

- The lifecycle is one table, in one package, and a future state cannot be added without deciding
  where it may be entered from and by whom — the property `incident-state.ts` claimed and could not
  enforce while three other copies existed.
- Two states a later milestone will need are declared while nothing depends on the shape.
- A pre-existing divergence is now visible and checked: the workspace's affordances are narrower than
  the server's rules, deliberately, and are asserted to stay on the safe side of it.

### What it cost

- **`IncidentStatus` grew by two values.** ADR-0029's hazard is real and this ADR does not pretend
  otherwise: a strict parser pinned to the six-value schema fails on an eight-value enum. Nothing
  emits the new values, so nothing can meet one today; the cost is paid by whoever holds a pinned
  schema when the values first become reachable, and it is smaller now than at that moment.
- **`isTerminal` reads the contract's `terminal` flag** rather than comparing against `closed`. That
  is behaviour-preserving today (only `closed` is terminal and reachable) and correct tomorrow.
- **Nothing was built.** No dismissal action, no retention job, no UI to reach either state, no
  persistence change. Declaring a state and implementing it are separate acts and this ADR is only
  the first, exactly as approved.

### The guardrails

No new service. No change to the five frozen AI Runtime contracts. No persistence migration — an
existing incident's stored `status` is still one of the six values it was written with, and the two
new ones widen the schema without touching a record.
