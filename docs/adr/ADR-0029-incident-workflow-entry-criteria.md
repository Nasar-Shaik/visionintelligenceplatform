# ADR-0029 — Incident Management entry criteria: assignment is not a state, the activity log is derived, and no query ships without its index

- **Status:** Accepted
- **Date:** 2026-08-03 · **Accepted:** 2026-08-03 (Architect decision, P-4.2 approval + six P-5 entry criteria)
- **Deciders:** Principal Architect + development
- **Touches:** `@vip/contracts` (`IncidentStatus` extension; `IncidentActor`, `IncidentAttachment`, `IncidentNote`, `IncidentAssignment`, `IncidentEscalation`, `IncidentActivity*`, `InvestigateIncidentInput`, `EscalateIncidentInput`, `AssignIncidentInput`, `AddIncidentNoteInput`, `IncidentQuery` filters; `EventQuery.correlationId`); `@vip/permissions` (four operator permissions); `services/workflow` (`incident-state.ts`, `incident-activity.ts`, `incident-factory.ts`, `indexes.ts`, routes, bench); `services/events` (`indexes.ts`, `getById`, `metrics.ts`, route); `apps/console` (status rendering only). Relates to [ADR-0028], [P-5-ARCHITECTURE-VALIDATION](../tracker/P-5-ARCHITECTURE-VALIDATION.md), [P-5-ENTRY-CRITERIA](../tracker/P-5-ENTRY-CRITERIA.md), [CONSTRAINTS §40, §44, §46, §52–55].

## Context

The P-5 architecture validation pass found six gaps between the frozen foundations and what Incident
Management needs. The Architect accepted the finding and made the six **formal entry criteria**: a
tracked checklist to complete before P-5 begins, with G-4 classified as technical debt and the rest
as additive enhancements to contexts that are not frozen.

Six decisions in that work were not mechanical. Three of them are places where the criteria as
written would have produced something worse than what was built.

## Decision

### 1. `assigned` is an operation, not a lifecycle state

G-1 listed **Assign** alongside Investigate and Escalate as incident lifecycle states. It is
implemented as an operation that does not change `status`.

An incident can be assigned while raised, acknowledged, investigating or escalated, and re-assigned
freely. A status answers _where is this_; an assignee answers _whose is this_. Folding them together
makes `assigned → resolved` and `resolved → assigned` both look legal and the transition table stops
carrying information. It is the same distinction `RULE_ARTIFACT_LIFECYCLE.md` draws one context over
between lifecycle states and things that happen _to_ a rule.

Assign keeps everything else a first-class action has: its own route, its own permission, and an
immutable `assignments` stream. It simply does not move the incident.

`investigating` and `escalated` **are** states and were added as such.

### 2. Extending `IncidentStatus` is recorded as a breaking-shaped change, not a footnote

Adding a value to a published enum is not purely additive for a strict parser: a consumer pinned to
the P1-8 four-value schema fails to parse an incident in a new state. This is the second time the
platform has taken that step deliberately (the first was `RuleReferenceKind` in P-4.1).

In-repo, the change surfaced immediately as a compile error in three console files whose
`Record<IncidentStatus, …>` stopped being exhaustive — the good version of this failure. One of them,
`incident-card.tsx`, had **re-typed the four values as a local string union** and would have silently
rendered nothing; it now aliases the contract type, so the next change breaks the build there too.

The enum is pinned by a test that has to be edited on purpose.

### 3. Three append-only streams, one derived activity log

G-2 listed Assignee, Notes, Comments, Attachments and Activity Log. Built as:

- `assignments`, `notes` and the existing `history` — three append-only arrays, each with a shape it
  actually needs.
- `IncidentActivity` — **derived on read** by merging them.

Note and comment are the same object; the distinction that genuinely exists is between a note bound
to a state change (`IncidentTransition.note`) and a free-standing one, so that is what the contract
models. A stored activity log would be a fourth copy every write path has to remember to append to —
a second audit trail, which is the P-4.1 mistake. Deriving it also means it works on incidents
raised long before this contract existed, with no migration.

Attachments are **references** (`evidence` id or `link` URI). Copying an evidence record into the
incident would put a mutable copy of an immutable artefact inside another context.

A **closed incident is sealed**: no transition, no assignment, no note. "Terminal; retained for
audit" is only true if the record stops changing.

Notes are capped at 500 per incident, because they are embedded in the document and 16 MB is a real
ceiling. An incident that reaches it wants a _case_, which is deferred with the full Workflow engine
(TD-8) — the cap is a signal, not a limit to raise.

### 4. Two of the requested search filters were not built, and are recorded instead

G-3 asked for search by Incident, Camera, Zone, Rule, **Behavior**, **Composite**, Correlation, Time
and Status. `IncidentCandidate` carries `ruleId`, `ruleVersion` and `ruleName` — and nothing about a
composite behaviour or a behaviour profile. A filter for either would parse, index, and always match
nothing.

Behaviour search is served by `eventType` (`behavior.loitering`, …) and `category`, which are real.
The missing id is **TD-23**, owned by the Rules context, because it is a producer change.

`IncidentQuery` is otherwise **frozen** at nine filters plus the window and cursor, asserted whole in
`incident.test.ts` so P-5 can be built against it without an API redesign.

### 5. Index coverage is classified three ways, not two

The tenant and camera services ask a yes/no question of each query: is there a covering index? With
one filter key that is right. Incident search has nine, and asking it of nine forces a choice between
indexing 36 pairs and shipping a query declared uncovered.

The model returns `covered` (every equality consumed, sort served), `bounded` (the index narrows past
the tenant, sort served, remainder residual) or `scan` — and no query may ever be `scan`. The two
failure modes are not the same size: an unserved sort is a 32 MB blocking-sort cliff, while an extra
residual predicate costs documents examined and shows up in `explain()` long before it hurts.

⚠️ **Written the obvious way, this was wrong.** The base cursor index `{tenantId, raisedAt, id}`
consumes the tenant and serves the sort for _any_ query, so a filter with no index of its own scored
`bounded` — while walking every incident the tenant had ever raised. An index now only counts as
narrowing if it consumes a key **beyond** the tenant prefix, and a self-test asserts the model
catches both the missing-index and the truncated-index cases.

Verification runs at three levels: the declaration model always; `explain()` against a real MongoDB
when one is reachable (it was — all ten filters confirmed, no `SORT`, no `COLLSCAN`); and a scale
benchmark at 100 / 1k / 10k / 100k.

### 6. The event by-id index is non-unique, and there is no cache metric

An envelope id is a UUID and a collision within a tenant would be a defect — but a **unique**
`{tenantId, id}` would route that collision into `persist`'s duplicate-key branch, which reports
"already stored" and skips publishing. That silently drops a real event to enforce a constraint
nothing needed. Uniqueness is `dedupKey`'s job and stays there; this index exists purely to make the
by-id lookup a seek.

Rec 4 named four lookup series: count, duration, cache hits, cache misses. Three are emitted. There
is no cache, and a `cache_hits_total` pinned at zero reads as a broken cache — a worse answer than an
absent series, and a dashboard panel that is wrong the day a cache is actually added. Same discipline
as CONSTRAINTS §53.

Separately, three P1-5 event indexes stopped at `occurredAt` and abandoned the `(occurredAt, id)`
sort. Fixing them changes an existing index's key set, which is an `IndexOptionsConflict` that fails
the service at boot — so `ensureIndexes` drops and rebuilds a changed name, and an integration test
recreates the P1-5 shape and proves the service still starts.

## Consequences

**Good.** P-5 can be built entirely against published routes with no frozen foundation touched.
TD-22 is closed _before_ the filters that needed it, which is the only order in which paying that
debt means anything. Every incident search filter is index-verified three ways. The investigation
workspace's flagship answer — _why did this rule fire_ — is now reachable end to end:
incident → `GET /events/:id` → `POST /rules/:id/simulate` with `GET /rules/:id/incident-context`.

**Costs.** Nine new indexes on `incidents` and two on `events` are write amplification on the hot
promotion path; that is the trade for a search that does not scan, and it is measurable. A note or an
assignment bumps the incident `version`, so two operators commenting at the same instant get a 409
rather than one silently losing their comment — correct, and worth knowing. The console renders two
new statuses but offers no buttons to reach them; those belong to the P-5 workspace.

**Deliberately not done.** No investigation workspace, evidence viewer, timeline, collaboration UI,
reporting or SLA tracking — that is P-5, and this slice stops before it.

## Alternatives considered

- **`assigned` as a status** — rejected: it makes the transition table meaningless (decision 1).
- **A stored activity log** — rejected: a second audit trail that also cannot describe the past
  (decision 3).
- **A separate `incident_notes` collection** — rejected for now: notes are always read with the
  incident, are tenant-scoped for free, and share the version guard. The 500-note cap is the point
  at which that reasoning stops holding, and the answer there is a case model, not a collection.
- **Compound indexes for filter pairs** — rejected: 36 pairs and 84 triples of write cost for reads
  nobody has issued. Revisit with evidence from a real deployment.
- **Shipping `behaviorId` / `compositeId` filters anyway** — rejected: a filter that always matches
  nothing is worse than an absent one, because it looks like an answer (decision 4).
