# P-5 — Incident Management: architecture

**Status:** ⏳ **Awaiting architectural review. No P-5 code has been written.**
**Date:** 2026-08-03 · **Authorised by:** Architect approval of P-5.0 + recommendation 14
**Layer:** Product Capability — composition over the frozen foundations, redesigning none of them.

> _"Before coding P-5, produce one architecture document describing: Incident Aggregate · Timeline ·
> Workspace · Evidence Integration · Search · Correlation · Permissions · Reporting · UI flow. Only
> after approval should implementation begin."_

This is that document. It folds in all fifteen recommendations, specifies every contract precisely
enough to be implemented from directly, and **names six findings that need a decision before
implementation starts** — one of which is a genuine index defect in another context, found by
applying recommendation 5's five-check rule to queries P-5 has not written yet.

Nothing here has been implemented. No contract, route, index or foundation was modified to produce
it.

---

## Contents

- [0 · Six findings that need a decision](#0--six-findings-that-need-a-decision)
- [1 · The Incident Context boundary](#1--the-incident-context-boundary-rec-1)
- [2 · The Incident aggregate](#2--the-incident-aggregate-rec-2)
- [3 · The timeline](#3--the-timeline-rec-3--rec-4)
- [4 · The Investigation Workspace contract](#4--the-investigation-workspace-contract-rec-7)
- [5 · Evidence integration](#5--evidence-integration-rec-13)
- [6 · Search](#6--search-rec-5)
- [7 · Correlation](#7--correlation-rec-10)
- [8 · Permissions](#8--permissions-rec-9)
- [9 · Reporting, metrics and SLA](#9--reporting-metrics-and-sla-rec-8)
- [10 · Scalability targets](#10--scalability-targets-rec-11)
- [11 · AI extension points](#11--ai-extension-points-rec-12)
- [12 · Event retrieval](#12--event-retrieval-rec-6)
- [13 · UI architecture and flow](#13--ui-architecture-and-flow)
- [14 · Delivery plan](#14--delivery-plan)
- [15 · What P-5 must not do](#15--what-p-5-must-not-do-rec-15)

---

## 0 · Six findings that need a decision

Everything below this section is design. This section is what the design **ran into**. Each item
changes what P-5 does, and three of them change its size.

### ⚠️ F-1 · The Evidence context has TD-22's defect, and the workspace will hit it

Recommendation 5 says no query merges without planner, explain, index, coverage and benchmark
verification. Applying that to the queries **P-5 will issue against Evidence** — before writing
them — finds the same shape of gap the Workflow context had:

`services/evidence/src/adapters/mongo-evidence-store.ts` creates three indexes:

| Index                | Keys                                        |
| -------------------- | ------------------------------------------- |
| `tenant_captured`    | `{tenantId, capturedAt, _id}`               |
| `tenant_incident`    | `{tenantId, source.incidentId, capturedAt}` |
| `tenant_kind_status` | `{tenantId, kind, status, capturedAt}`      |

`EvidenceQuery` filters on `kind`, `status`, `cameraId`, `incidentId`, `eventId`, `correlationId`
and a time window, and pages by `(capturedAt, _id)`.

**Measured, not inferred.** These three indexes were recreated against a real MongoDB with 500
evidence rows and each query explained with `executionStats`:

| Query (sorted `capturedAt, _id`, limit 50) | Index chosen      | Blocking `SORT` | Docs examined / returned |
| ------------------------------------------ | ----------------- | --------------- | ------------------------ |
| `incidentId` — the workspace panel         | `tenant_incident` | ⚠️ **yes**      | 10 / 10                  |
| `correlationId` — the spine                | `tenant_captured` | no              | ⚠️ **399 / 50**          |
| `eventId`                                  | `tenant_captured` | no              | ⚠️ **500 / 1**           |
| `cameraId`                                 | `tenant_captured` | no              | ⚠️ **497 / 50**          |
| `kind` + `status`                          | `tenant_captured` | no              | 99 / 50                  |

Two distinct defects, and the measurement sharpened both:

- **`tenant_incident` produces a blocking `SORT` stage.** It stops at `capturedAt` and never reaches
  `_id`, so it serves the leading sort key and hands the tiebreak to an in-memory sort — against
  MongoDB's 32 MB ceiling. This is TD-22's defect exactly, one context over, and it is on the query
  the workspace issues _first_.
- **`eventId`, `correlationId` and `cameraId` have no index**, and the planner falls back to
  `tenant_captured` — so it is **not** a `COLLSCAN` and there is no blocking sort, which is why
  reading the index list alone understates it. It is a tenant-wide **index walk with residual
  filtering**: `eventId` examined **all 500 documents to return 1**. That ratio is the whole finding
  — it is exactly the `scan` classification in the three-valued model (only the tenant prefix
  consumed, every predicate residual), and it grows linearly with the tenant's entire evidence
  history.
- **There is no index-coverage test** in the Evidence context, so neither would be noticed.

⚠️ At the §10 target of **10 million evidence references**, "examine everything to return one" is
the difference between a workspace panel and an outage.

**Classification: technical debt, TD-25.** ⚠️ **Adding an index is not a redesign of the Evidence
Foundation** — no contract, route, or behaviour changes, exactly as G-4 changed none in Workflow.
But the guardrail says do not redesign that foundation, so this needs the same explicit
authorisation G-4 got.

**Recommended:** pay it in the first P-5 slice, before the evidence panel is written — the only
order in which paying it means anything.

### ⚠️ F-2 · Actors are opaque strings, and old records cannot be retroactively typed

Recommendation 4 says do not merge operator, system, automation and AI actions into one stream
without type information. Today `IncidentActor` is `z.string()` — `"priya"`, `"system"` and a
future AI principal are indistinguishable by type. Filtering "show me only what a human did" is
impossible.

**Proposal:** add `IncidentActorRef { kind, id, displayName? }` where
`kind ∈ operator | system | automation | ai | unknown`, carried on every **timeline entry**.

⚠️ `unknown` is not defensive padding. Every incident raised before this exists carries a bare
string, and there is no honest way to decide whether `"system"` was a person named system. Typing
them by guessing is the mistake §52 exists to prevent. Pre-P-5 entries resolve to
`{kind: 'unknown', id: <the string>}`.

**Decision needed:** whether the stored streams also gain a typed field going forward (additive, and
means new records are typed at the source) or whether typing stays a read-time derivation.
**Recommendation: store it going forward.** A derivation that can only ever return `unknown` for old
data and guesses for new data is worse than a field.

### ⚠️ F-3 · A complete timeline is not derivable from the incident alone

`IncidentActivity` (P-5.0) derives three entry kinds from three arrays **on the incident document**
— one read. Recommendation 3 asks for eight kinds, and three of them live in other contexts:
`event` (Events), `attachment`/evidence (Evidence), `automation` (Notify).

So a complete timeline is a **fan-out**, not a projection. See [§3](#3--the-timeline-rec-3--rec-4)
for the design; the decision it forces is a **join budget**: at most three upstream calls per
timeline read, each bounded and paged, each degrading to a named gap rather than an error when the
upstream is unavailable — §44 applied to a read.

### ⚠️ F-4 · SLA tracking has no target to track against

P-5's scope lists SLA tracking and recommendation 8 lists SLA compliance. There is no SLA contract
anywhere: no target, no per-severity policy, no clock definition. "Compliance" against nothing is
not measurable.

**Proposal:** a minimal `IncidentSlaPolicy` per tenant per severity
(`acknowledgeWithinSeconds`, `resolveWithinSeconds`), with attainment **derived** from
`raisedAt`/`acknowledgedAt`/`resolvedAt` — no new stored state, no timers. **Escalation timers stay
deferred** (TD-8): measuring a breach and acting on one are different features, and only the first
is in scope.

**Decision needed:** approve the policy contract, or defer SLA to P-7 with reporting.

### ⚠️ F-5 · `IncidentActivityKind` 3 → 8 is another published-enum extension

Same hazard as `IncidentStatus` in P-5.0: a consumer pinned to the three-value schema fails to parse.
It is worth doing **once, now**, with all eight values, rather than growing it a value per slice.

### ⚠️ F-6 · "note" and "comment" are still one thing

Recommendation 3 lists `comment` and `note` as separate timeline entry kinds. P-5.0 deliberately
merged them, with the Architect's acceptance, because the distinction that genuinely exists is
**transition-bound** (`IncidentTransition.note`) versus **free-standing** (`IncidentNote`).

**Holding that line.** The timeline surfaces a transition-bound note _inside_ its `state-change`
entry and a free-standing one as a `note` entry. Adding a `comment` kind identical to `note` would
be two names for one object, which is how a schema starts lying about its domain.

---

## 1 · The Incident Context boundary (rec 1)

Extends [INCIDENT_BOUNDARY](INCIDENT_BOUNDARY.md), which already carries the dependency graph and
the consumption table. The ownership statement, stated as the Architect specified it:

**The Incident Context owns** — and no other context may own any of it:

| Owned          | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| Lifecycle      | status, transitions, the state machine, terminality             |
| Assignments    | who owns an incident, and the assignment history                |
| Collaboration  | notes, attachments-as-references, operator statements           |
| Timelines      | the merged narrative, derived                                   |
| Investigations | the workspace projection, its state, its findings               |
| Reporting      | incident-shaped aggregates, SLA attainment, operational metrics |

**The Incident Context consumes, read-only and by id:** Events · Rules · Evidence · Camera ·
Location. Never their storage; always a published route.

**No downstream context may own incident state.** Concretely, three things this forbids:

1. The **Notify** context may not decide an incident's status. `notification.acked` does not
   auto-acknowledge — that stays an explicit Workflow decision (TD-8 records the deferred loop).
2. The **Evidence** context may not carry investigation notes. An annotation is a Workflow object
   referencing evidence by id ([CONTEXT_OWNERSHIP](CONTEXT_OWNERSHIP.md)).
3. The **Rules** context may not learn whether a candidate became an incident. It emits and forgets.

---

## 2 · The Incident aggregate (rec 2)

**`Incident` is the aggregate root and the single authoritative entry point.** Everything on the
Architect's list resolves through it, and each one is either **stored on it** or **derived from an id
it carries** — never duplicated in a second owner.

| Aspect              | Where it lives                                  | Stored or derived                                |
| ------------------- | ----------------------------------------------- | ------------------------------------------------ |
| status              | `Incident.status`                               | stored (the state machine's only home)           |
| priority            | `Incident.severity`                             | stored, inherited from the candidate             |
| assignee            | `Incident.assignee` + `assignments[]`           | stored, append-only history                      |
| timeline            | `GET /incidents/:id/timeline`                   | **derived** — §3                                 |
| notes               | `Incident.notes[]`                              | stored, append-only, immutable entries           |
| attachments         | `IncidentNote.attachments[]`                    | stored as **references**, never content          |
| evidence references | `GET /evidence?incidentId=` / `?correlationId=` | **derived** — the Evidence context owns the rows |
| related events      | `GET /events?correlationId=` + `triggeredBy`    | **derived**                                      |
| related incidents   | `GET /incidents?correlationId=`                 | **derived** — §7                                 |
| rule references     | `Incident.source.{ruleId,ruleVersion}`          | stored as ids; the rule itself is derived        |

**The rule this table encodes:** the aggregate stores **identity and its own decisions**; everything
belonging to another context is stored as an **id** and resolved on read. An incident that stored the
camera's _name_ would go stale silently the day someone renames it.

**No aggregate expansion is proposed.** `Incident` gains nothing in P-5 beyond what F-2 and F-4 ask
for, if approved. The workspace is a **projection over the aggregate**, not a second copy of it.

### Concurrency

The `version` field is the optimistic-concurrency token and already bumps on every persisted change
(widened in P-5.0). Two operators acting at once: one wins, the other gets a 409 and retries. This is
correct and must not be softened into last-write-wins — an investigation record that silently drops a
comment is worse than one that asks you to try again.

---

## 3 · The timeline (rec 3 + rec 4)

### The contract, frozen

```ts
IncidentTimelineKind =
  | 'raised'        // the incident came into being
  | 'state-change'  // a lifecycle transition (carries its bound note, if any)
  | 'assignment'    // assigned, re-assigned, un-assigned
  | 'note'          // a free-standing operator note — see F-6
  | 'attachment'    // evidence or a link referenced from a note
  | 'event'         // a related event on the correlation spine
  | 'system'        // the platform acted (promotion, dedup collapse, expiry)
  | 'automation'    // a configured automation acted (notification sent/delivered/acked)
  | 'recommendation'// an AI suggestion — advisory only, §11

IncidentActorKind = 'operator' | 'system' | 'automation' | 'ai' | 'unknown'

IncidentActorRef  = { kind: IncidentActorKind; id: string; displayName?: string }

IncidentTimelineEntry = {
  id: string             // stable within one derivation, for React keys and deep links
  kind: IncidentTimelineKind
  at: IsoDateTime
  actor: IncidentActorRef
  summary: string        // a collapsed one-liner; the payload below is the authority
  source: 'incident' | 'events' | 'evidence' | 'notify'   // which context this came from
  transition?: IncidentTransition
  assignment?: IncidentAssignment
  note?: IncidentNote
  attachment?: IncidentAttachment
  event?: EventEnvelope
  evidenceId?: string
  recommendation?: IncidentRecommendation
}

IncidentTimeline = {
  incidentId, incidentVersion,
  entries: IncidentTimelineEntry[]         // oldest first
  gaps: IncidentTimelineGap[]              // what could not be fetched — see below
  derivedAt: IsoDateTime
}

IncidentTimelineGap = { source, reason: 'unavailable' | 'truncated', detail: string }
```

**Additive path (rec 3):** a new entry kind is a new enum value plus a new optional payload field.
Consumers render unknown kinds using `summary` + `actor` + `at`, which is why those four fields are
required on every entry regardless of kind.

### Derived, with a join budget (F-3)

`IncidentActivity` (P-5.0) stays exactly as it is — the three-stream projection over the incident
document, one read, no fan-out. `IncidentTimeline` is the **richer** view that joins upstream.

```
GET /incidents/:id/timeline?include=events,evidence,automation
  1. read the incident                         → raised · state-change · assignment · note · attachment
  2. GET /events?correlationId=&limit=N        → event            (bounded, one call)
  3. GET /evidence?correlationId=&limit=N      → attachment       (bounded, one call)
  4. notification history by correlation       → automation       (bounded, one call)
  merge → sort by (at, kind) → cap → report gaps
```

Four rules, each with a failure it prevents:

1. **At most three upstream calls, each bounded and paged.** Not one call per entry — the failure
   §54 records, which passes every test written against three rows.
2. **`include` is opt-in per source.** The incident header does not pay for the evidence panel.
3. **An unavailable upstream is a named `gap`, never an error and never silence.** A timeline that
   quietly omits the events is a timeline that says the events did not happen — §44 applied to a
   read.
4. **The cap is explicit and reported** as `reason: 'truncated'`. A busy correlation can carry
   thousands of events; the timeline shows the most recent N and says so.

Ordering ties break by `kind` in the order listed above, so the same incident produces the same
timeline on every node.

---

## 4 · The Investigation Workspace contract (rec 7)

Frozen before UI implementation, so the UI cannot force a redesign later.

**The workspace is a composition of existing reads, not a new authority.** It has exactly one new
route, and every section is independently fetchable — because a workspace that is one giant blocking
call has one loading state and one failure mode.

```ts
IncidentWorkspace = {
  incident: Incident                            // the aggregate root
  timeline: IncidentTimeline                    // §3
  rule: RuleIncidentContext                     // frozen in P-4.2 — the rule AS IT WAS
  triggerEvent?: EventEnvelope                  // via GET /events/:id — G-5
  explanation?: RuleExplanation                 // via POST /rules/:id/simulate WITH the event
  evidence: EvidenceRef[]                       // ids + kind + status + capturedAt, not content
  camera?: Camera                               // via GET /cameras/:id
  location?: OrgLocation                        // ⚠️ today's hierarchy — see §5 / TD-20
  relatedIncidents: IncidentSummary[]           // §7
  assignments: IncidentAssignment[]             // on the aggregate
  notes: IncidentNote[]                         // on the aggregate
  recommendations: IncidentRecommendation[]     // §11 — advisory, may be empty
  gaps: IncidentWorkspaceGap[]                  // ⚠️ what could not be resolved, and why
  derivedAt: IsoDateTime
}
```

**Three properties worth stating, because each has a tempting wrong version.**

**`explanation` is optional and that is load-bearing.** P-4.2 recorded that a per-event trace needs
the event. If the event has aged out of retention, there is no explanation — and the workspace must
say _"the triggering event is no longer retained"_, never render an explanation reconstructed from
the rule alone. That is the most-read panel in the product; a plausible fabrication there is the
worst thing this document can permit.

**`evidence` carries references, never content.** Bytes come from `GET /evidence/:id/download`,
signed, short-lived, and audited as an access. The workspace listing must not trigger N signed-URL
issuances — that would write N custody entries for a page nobody looked at.

**`gaps` is a first-class field, not error handling.** Every optional section above can be absent for
a legitimate reason: the event expired, the camera was decommissioned, the rule was archived, an
upstream is down. Each absence is reported with its reason. An empty panel with no explanation is
indistinguishable from a broken one.

### The one new route

```
GET /incidents/:id/workspace?include=timeline,rule,event,explanation,evidence,camera,location,related
```

Default `include` covers the header and timeline. The heavy joins — `explanation` (a rule simulation)
and `evidence` — are opt-in, because they are what the operator clicks _into_.

---

## 5 · Evidence integration (rec 13)

**Consumed, never owned.** P-5 issues three reads and one write-adjacent action:

| Purpose                    | Route                          | Permission      |
| -------------------------- | ------------------------------ | --------------- |
| Evidence for this incident | `GET /evidence?incidentId=`    | `evidence:read` |
| Everything on the spine    | `GET /evidence?correlationId=` | `evidence:read` |
| Chain of custody           | `GET /evidence/:id/custody`    | `evidence:read` |
| Play or download           | `GET /evidence/:id/download`   | `evidence:read` |

⚠️ **Both of the first two are affected by F-1, measured.** `incidentId` is indexed but produces a
blocking in-memory `SORT`; `correlationId` has no index and walks the tenant's whole evidence
history, examining 399 documents to return 50 at a 500-row fixture.

**Attaching evidence to an incident** is a Workflow write (`POST /incidents/:id/notes` with an
`{kind:'evidence', ref}` attachment) and an Evidence **read**. Nothing in P-5 mutates an evidence
record. The Evidence Foundation's immutability is what makes custody meaningful.

### TD-20 governance, restated as the Architect specified

Carried until resolved. **When implemented**, an evidence record must permanently preserve, at write
time: the **zone id**, the **location path**, and the **hierarchy snapshot** (the breadcrumb as it
was). No historical incident may resolve its location against today's hierarchy.

Until then, the workspace's `location` field is **today's ancestry**, and P-5 must label it as such
rather than presenting it as where the incident happened. That is a UI requirement, recorded here so
it is not discovered during implementation: a confident wrong breadcrumb is worse than a hedged one.

---

## 6 · Search (rec 5)

**`IncidentQuery` is frozen** (P-5.0, G-3) — nine filters, a time window, a cursor. P-5 adds **no
new filter**. The search feature is a UI over a contract that already exists and is already index-
verified, which is the whole point of having done G-4 first.

### The five-check rule, as a merge gate

Every new query in P-5 — in any context — passes all five before merge:

| Check                    | How                                                               | Runs                |
| ------------------------ | ----------------------------------------------------------------- | ------------------- |
| **Coverage**             | query shape declared in the context's `index-coverage.test.ts`    | always              |
| **Index**                | the index declared as data in `adapters/indexes.ts`               | always              |
| **Sort**                 | the model forbids `scan` — never an in-memory sort                | always              |
| **Planner / explain**    | `explain('queryPlanner')` asserts the index, no `SORT`/`COLLSCAN` | with a live MongoDB |
| **Regression benchmark** | a scale run at the §10 targets, baseline recorded                 | on demand           |

⚠️ The three-valued model (`covered` / `bounded` / **never `scan`**) is now the standard, per the
Architect's direction. Porting it to a context means porting the **self-test** with it — the part
that proves the model detects a missing index and one truncated before the cursor. A coverage model
that cannot fail proves nothing.

**Contexts still without it:** Evidence (F-1/TD-25), Events (added P-5.0), Notify, Media, Identity.
Adding it where P-5 does not query is out of scope and should be recorded, not done quietly.

---

## 7 · Correlation (rec 10)

### The strategy, and the one dimension that actually works

`correlationId` is **the** correlation dimension. It is required on every incident, indexed
(`tenant_correlation_time`), and threads frame → detection → event → candidate → incident →
notification → evidence. Everything else on the Architect's list is a **filter**, not a correlation:

| Dimension       | Mechanism                              | Status                               |
| --------------- | -------------------------------------- | ------------------------------------ |
| **correlation** | `correlationId` equality               | ✅ indexed — the spine               |
| camera          | `IncidentQuery.cameraId`               | ✅ indexed                           |
| zone            | `IncidentQuery.zoneId`                 | ✅ indexed                           |
| rule            | `IncidentQuery.ruleId`                 | ✅ indexed                           |
| time            | `IncidentQuery.from`/`to`              | ✅ rides the cursor index            |
| behavior        | `IncidentQuery.eventType` / `category` | ⚠️ proxy only — real id is **TD-23** |
| composite       | —                                      | ⚠️ **TD-23**, not queryable          |
| operator        | `IncidentQuery.assignee`               | ✅ indexed                           |

**"Related incidents" = same `correlationId`, excluding self.** One indexed query, bounded, paged.

⚠️ **What P-5 must not build: similarity correlation.** "Incidents that look like this one" is
fuzzy matching, it has no index, and at 100,000 incidents it is a scan wearing a product name. It
belongs in [§11](#11--ai-extension-points-rec-12) as an advisory recommendation with its own
mechanism, not in the correlation query path.

---

## 8 · Permissions (rec 9)

Designed now, not deferred. Existing permissions are unchanged; the four added in P-5.0 are already
live.

| Action          | Permission                               | Roles today             | Status            |
| --------------- | ---------------------------------------- | ----------------------- | ----------------- |
| View incident   | `incident:read`                          | viewer, operator, admin | ✅ exists         |
| Assign          | `incident:assign`                        | operator, admin         | ✅ P-5.0          |
| Investigate     | `incident:investigate`                   | operator, admin         | ✅ P-5.0          |
| Escalate        | `incident:escalate`                      | operator, admin         | ✅ P-5.0          |
| Comment         | `incident:comment`                       | operator, admin         | ✅ P-5.0          |
| Acknowledge     | `incident:ack`                           | operator, admin         | ✅ exists         |
| Resolve         | `incident:resolve`                       | operator, admin         | ✅ exists         |
| Close           | `incident:resolve`                       | operator, admin         | ⚠️ see below      |
| Attach evidence | `incident:comment` **+** `evidence:read` | operator, admin         | ✅ composed       |
| Archive         | —                                        | —                       | ⚠️ no such action |
| Read reports    | `incident:read`                          | viewer, operator, admin | ✅ exists         |

**Two decisions needed:**

**Close shares `incident:resolve`.** Whether closing an incident is a separate authority from
resolving it is a policy question, not a technical one. Splitting it is trivial and additive
(`incident:close`); leaving it is defensible because `close` is only reachable from `resolved`.
**Recommendation: split it.** In most operations teams the person who fixes a thing and the person
who signs it off are different, and the permission catalog should be able to express that.

**Archive does not exist and should not be invented here.** An incident's terminal state is `closed`
and the record is sealed. "Archive" in the Architect's list implies either retention tiering or
hiding from the default view — different features with different contracts. Recorded as an open
question, not designed speculatively.

**The AI constraint is enforced here, not by convention:** no role grants any `incident:*` write
permission to a machine principal, and §11's recommendation route is `incident:read`-gated. An AI
that cannot authenticate to a write route cannot mutate an incident regardless of what its prompt
says.

---

## 9 · Reporting, metrics and SLA (rec 8)

### Operational metrics — Prometheus, on the existing registry

Counters and gauges only, **operational, never read while deciding anything**:

| Series                                          | Type      | Labels             |
| ----------------------------------------------- | --------- | ------------------ |
| `workflow_incidents_raised_total`               | counter   | severity ✅ exists |
| `workflow_incident_transitions_total`           | counter   | to ✅ exists       |
| `workflow_incident_assignments_total`           | counter   | kind ✅ P-5.0      |
| `workflow_incident_notes_total`                 | counter   | ✅ P-5.0           |
| `workflow_incidents_open`                       | gauge     | status, severity   |
| `workflow_incident_time_to_acknowledge_seconds` | histogram | severity           |
| `workflow_incident_time_to_resolve_seconds`     | histogram | severity           |
| `workflow_incident_sla_breaches_total`          | counter   | severity, kind     |

⚠️ **`workflow_incidents_open` is a gauge over a tenant-wide count and must not be a scan per
scrape.** It is maintained incrementally on transition, or computed on a schedule with a documented
staleness — not recomputed every 15 seconds.

⚠️ **Per-tenant labels are deliberately absent.** Cardinality is the reason, and it is the same
decision P-4.2 made for per-rule labels. Per-tenant reporting comes from the query API below, not
from Prometheus.

### Reporting — derived, bounded, honest about its ceiling (F-5)

```ts
IncidentReportQuery = { from, to, groupBy: 'severity'|'status'|'camera'|'zone'|'rule'|'assignee' }
IncidentReport = {
  window: { from, to }
  buckets: { key, raised, resolved, closed,
             medianTimeToAcknowledgeSeconds?, medianTimeToResolveSeconds?,
             slaMet?, slaBreached? }[]
  truncated: boolean        // ⚠️ the window exceeded the aggregation ceiling
  derivedAt
}
```

Derived from the incidents themselves — **no rollup collection, no second source of truth**. The
honest constraint: an aggregation over an unbounded window at 100,000 incidents is not a request-time
operation. So the window is **capped**, and exceeding the cap sets `truncated: true` rather than
returning a plausible number over a partial scan.

**Decision needed:** if reporting over a year at full scale is required, that is a **rollup**, and a
rollup is a second store with its own consistency story. That is a P-7 (Analytics) decision, not
something to slip into P-5.

### SLA (F-4)

```ts
IncidentSlaPolicy = { tenantId, severity, acknowledgeWithinSeconds, resolveWithinSeconds }
IncidentSlaStatus = {                     // derived, never stored
  policy?: IncidentSlaPolicy              // absent = no policy = no claim about compliance
  acknowledge?: { dueAt, metAt?, breached: boolean, elapsedSeconds }
  resolve?:     { dueAt, metAt?, breached: boolean, elapsedSeconds }
}
```

⚠️ **No policy means no `IncidentSlaStatus`, not a passing one.** An incident with no SLA is not
compliant — it is unmeasured, and reporting must distinguish them. Same discipline as
`RuleHealthStatus.unknown`.

**Escalation timers remain deferred (TD-8).** Measuring a breach and automatically acting on one are
different features; only the first is proposed.

---

## 10 · Scalability targets (rec 11)

Targets to design against and to benchmark, captured **before** implementation so the baselines mean
something.

| Dimension                      | Target       | Where it bites                                  |
| ------------------------------ | ------------ | ----------------------------------------------- |
| Incidents per tenant           | 100,000      | search, reporting, the open-incidents gauge     |
| Events per tenant              | 1,000,000    | timeline event join, correlation walk           |
| Evidence references per tenant | 10,000,000   | ⚠️ evidence panel — **F-1**                     |
| Notes per incident             | 500 (capped) | document size; the cap is the case-model signal |
| Timeline entries rendered      | 500 / page   | virtualization — §13                            |

| Operation                   | Budget (p95) | Verified by                                |
| --------------------------- | ------------ | ------------------------------------------ |
| Incident search page (50)   | < 100 ms     | `bench/incident-search.bench.ts` + explain |
| Incident by id              | < 20 ms      | unique index, single seek                  |
| Timeline (incident only)    | < 50 ms      | one document read                          |
| Timeline (all sources)      | < 400 ms     | three bounded upstream calls               |
| Workspace (default include) | < 500 ms     | composition of the above                   |
| Correlation walk            | < 150 ms     | `tenant_correlation_time`                  |
| Report over 30 days         | < 2 s        | bounded aggregation, `truncated` beyond    |

⚠️ These are **budgets to design against and measure**, not thresholds a benchmark on a laptop can
certify. As in `RULE_ENGINE_BASELINE.md`, what transfers between machines is the **shape** — cost per
item flat as the collection grows — and that is what a regression gate asserts.

---

## 11 · AI extension points (rec 12)

Reserved now so they are additive later. **Nothing AI-related is built in P-5.**

```ts
IncidentRecommendationKind = 'summary' | 'similar-incidents' | 'root-cause' | 'suggested-action'

IncidentRecommendation = {
  id, incidentId, kind
  body: string
  confidence?: number                  // 0–1, absent when the producer does not report one
  basis: { incidentIds?, eventIds?, evidenceIds?, ruleIds? }   // what it looked at
  producer: { name, version }          // which model said it, so a bad one is traceable
  at: IsoDateTime
}
```

**Four rules, and the first is the one that matters:**

1. ⚠️ **AI may never modify incident state.** No transition, no assignment, no resolution, no status.
   A recommendation is a _read-side artefact_. This is enforced by the permission catalog (§8), not
   by convention — there is no route an AI principal can call that mutates an incident.
2. **Every recommendation carries its `basis` and its `producer`.** An unattributable suggestion in
   an investigation record is indistinguishable from a fact, which is how it ends up in a report.
3. **Recommendations appear in the timeline as `kind: 'recommendation'`, `actor.kind: 'ai'`** — never
   as a `note`, never attributed to a person.
4. **`confidence` is optional and absent means absent**, not zero, not 100. Same rule as everywhere
   else in this platform.

`similar-incidents` is where fuzzy matching belongs (§7) — advisory, clearly labelled, and never in
the correlation query path.

---

## 12 · Event retrieval (rec 6)

`GET /events/:id` stays exactly as delivered: **one event, by id, tenant-scoped, 404 for another
tenant.** It gains no filters, no expansion, no embedded relations. A by-id route that grows options
becomes a query route with a confusing name.

Future filters belong on `EventQuery`, and each is **additive**: one optional field, its index, one
row in `events/test/index-coverage.test.ts`. The path is already proven — `correlationId` took
exactly that shape in P-5.0.

| Possible future filter | Additive? | Prerequisite                                    |
| ---------------------- | --------- | ----------------------------------------------- |
| camera, zone, type     | ✅        | already exist and are indexed                   |
| correlation            | ✅        | delivered P-5.0                                 |
| time                   | ✅        | already exists                                  |
| severity               | ✅        | `EventEnvelope.priority` exists; needs an index |
| rule                   | ⚠️        | an event predates the rule that matched it      |
| behavior               | ⚠️        | **TD-23** — no producer writes the id           |

⚠️ **`EventEnvelope` is not touched.** Frozen AI Runtime v1.0 contract. Every row above is a query
surface.

---

## 13 · UI architecture and flow

The console stack already matches the Architect's list exactly — **React 19 · TypeScript · Tailwind
v4 · shadcn-style Radix + CVA · TanStack Query · Redux Toolkit · React Hook Form · Zod · Recharts ·
Lucide**. Nothing new is introduced.

### Feature layout

```
apps/console/src/features/incidents/
  IncidentsPage.tsx            (exists — queue; gains the frozen filters)
  IncidentDetailSheet.tsx      (exists — quick actions; stays the fast path)
  workspace/
    IncidentWorkspace.tsx      route: /incidents/:id
    IncidentHeader.tsx         status · severity · assignee · SLA · actions
    IncidentTimeline.tsx       virtualized, filterable by actor kind and entry kind
    RuleExplanationPanel.tsx   reuses the P-4 RuleExplanationView — no second renderer
    EvidencePanel.tsx          references → signed URL on demand, never on render
    EventInspector.tsx         the triggering event + related events
    ContextPanel.tsx           camera · location (⚠️ labelled per §5) · related incidents
    CollaborationPanel.tsx     notes, attachments, assignment
  useIncidentWorkspace.ts      one hook per section — independent loading and error states
```

### Flow

```
Queue ──select──► Detail sheet ──"Investigate"──► Workspace (/incidents/:id)
                       │                              │
                  quick ack/resolve            timeline · why it fired · evidence
                                                      │
                                          assign · comment · escalate · resolve
```

The **sheet stays**. An operator triaging forty incidents should not load a workspace forty times;
the workspace is what you open when the sheet is not enough.

### Non-negotiables

- **Every panel has four states** — loading (skeleton), empty (with the _reason_, per §4 `gaps`),
  error (retryable, scoped to the panel), loaded. A panel that fails must not blank the workspace.
- **Virtualize the timeline and the queue.** 500 entries and 50-row pages with infinite scroll.
- **Dark mode and light mode**, both first-class — this is a SOC product and the room is usually dark.
- **Keyboard**: `j`/`k` to move through the queue, `a` acknowledge, `e` escalate, `/` search, `Esc`
  to close. Shortcuts are discoverable via `?`, never the only route to an action.
- **Accessibility**: every action reachable by keyboard, every status conveyed by more than colour
  (a severity chip with only colour fails for the ~8% of men with colour-vision deficiency, in a
  product whose entire job is drawing attention to the right row).
- **Information density over whitespace** — Datadog and Defender, not a marketing page. An operator
  scanning a wall of incidents needs rows, not cards.
- **No AI output styled as operator input.** Recommendations are visually distinct and labelled.

---

## 14 · Delivery plan

Each slice stops for review, per the standing discipline.

| Slice     | Scope                                                                                                       | Gate                                      |
| --------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **P-5.1** | ⚠️ **TD-25 first** (F-1: evidence indexes + coverage test) · timeline contract + route · actor typing (F-2) | five checks green on every evidence query |
| **P-5.2** | Workspace contract + route · rule explanation wiring · event inspector                                      | workspace budget < 500 ms                 |
| **P-5.3** | Workspace UI · timeline UI · evidence panel · collaboration UI                                              | four states per panel; a11y; virtualized  |
| **P-5.4** | Search UI over the frozen `IncidentQuery` · correlation / related incidents                                 | no new filter; benchmark at §10 targets   |
| **P-5.5** | Reporting · metrics · SLA (if F-4 approved)                                                                 | `truncated` honoured; no rollup           |

**P-5.1 leads with the debt deliberately.** G-4 established that paying index debt _before_ the
queries that need it is the only order in which it means anything, and F-1 is the same debt in the
next context.

---

## 15 · What P-5 must not do (rec 15)

1. **No new services.** Everything is the Workflow context plus the console.
2. **No foundation redesign** — Platform Core · AI Runtime · Operational Runtime · Camera · Evidence ·
   Location · Rule Designer · Event contracts. Adding an **index** to a context is not a redesign
   (F-1), but it needs explicit authorisation.
3. **No breaking contract changes.** Additive only; an ADR for anything else.
4. **No second evaluator, no second audit trail, no second timeline store.** Derive.
5. **No AI writes.** Recommendations only, enforced by permissions (§11).
6. **No filter without its index**, verified five ways (§6).
7. **No fabricated panel.** An explanation without its event, a location presented as historical, an
   SLA status with no policy — each is absent-and-explained, never plausible-and-wrong.
8. **Runtime still emits only `EventEnvelope`s**, and nothing here adds a per-event database query.

---

## Approval requested

**P-5 implementation is blocked on this document and on decisions for six items:**

| Item    | Decision needed                                                                   |
| ------- | --------------------------------------------------------------------------------- |
| **F-1** | Authorise TD-25 — evidence indexes + coverage test, inside P-5.1. Not a redesign. |
| **F-2** | Store typed actors going forward, or derive at read time (recommend: store)       |
| **F-3** | Approve the three-call join budget and the `gaps` contract                        |
| **F-4** | Approve `IncidentSlaPolicy`, or defer SLA to P-7                                  |
| **F-5** | Approve the 3 → 8 timeline enum extension as one deliberate change                |
| **F-6** | Confirm note ≡ comment stays merged, as accepted in P-5.0                         |

Plus two smaller ones from §8: whether `incident:close` splits from `incident:resolve`
(recommend: yes), and what "archive" should mean, if anything.

**Nothing in this document has been implemented.**

---

## Related

- [P-5 entry criteria](../tracker/P-5-ENTRY-CRITERIA.md) · [P-5 architecture validation](../tracker/P-5-ARCHITECTURE-VALIDATION.md)
- [INCIDENT_BOUNDARY](INCIDENT_BOUNDARY.md) · [CONTEXT_OWNERSHIP](CONTEXT_OWNERSHIP.md)
- [ADR-0029](../adr/ADR-0029-incident-workflow-entry-criteria.md) · [CONSTRAINTS](../project/CONSTRAINTS.md) · [INDEX_POLICY](../project/INDEX_POLICY.md)
- [TECH-DEBT](../../tracking/TECH-DEBT.md) — TD-8, TD-20/E-1, TD-23, TD-25
