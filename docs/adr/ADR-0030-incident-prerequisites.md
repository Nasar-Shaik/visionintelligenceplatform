# ADR-0030 — P-5.1 prerequisites: measure before you classify, type the actor rather than guess it, and never report an SLA nobody set

- **Status:** Accepted
- **Date:** 2026-08-03 · **Accepted:** 2026-08-03 (Architect decision, P-5 architecture approval + P-5.1 authorisation)
- **Deciders:** Principal Architect + development
- **Touches:** `services/evidence` (`adapters/indexes.ts`, `ensureIndexes` reconcile, coverage test, planner verification, MongoDB benchmark); `@vip/contracts` (`IncidentActorKind`/`IncidentActorRef`, `IncidentActivityKind` expansion, `IncidentTimeline*`, `IncidentSla*`, `IncidentRecommendation`); `@vip/permissions` (`INCIDENT_PERMISSIONS`, `REFUSED_INCIDENT_PERMISSIONS`, `incident:close`/`attach`/`export`/`ai-recommend`); `services/workflow` (`domain/incident-actor.ts`, `domain/incident-sla.ts`, `domain/incident-timeline.ts`, `TimelineSources` port, timeline + SLA routes, SLA config). Relates to [ADR-0029], [P-5-INCIDENT-MANAGEMENT](../architecture/P-5-INCIDENT-MANAGEMENT.md), [CONSTRAINTS §40, §44, §52–60], TD-25.

## Context

The P-5 architecture was approved as the blueprint, with implementation gated on resolving its six
findings first. P-5.1 resolves five of them (F-6 needed no code — the note ≡ comment decision was
accepted as it stood) plus the permission expansion.

Six decisions in that work were not mechanical.

## Decision

### 1. The coverage model was wrong, and only measuring found it

TD-25 was raised from _reading_ the Evidence context's index list. Implementing it started by
porting the three-valued coverage model from the Workflow context — which then declared the
defective index **`covered`**, while `explain()` against a real MongoDB showed that same index
producing a **blocking `SORT`**.

Two corrections came out of that, and both are general:

- **The sort is a pair, not a key.** Every bounded read here sorts by `(capturedAt, _id)`. An index
  that reaches `capturedAt` and stops still hands the tiebreak to an in-memory sort. The model now
  walks the whole sort key list. The Workflow, camera and tenant models share the weaker version;
  they happen to be correct because their indexes carry the full cursor, but the model would not
  catch it if one stopped short.
- **"Unindexed" is not one failure — cardinality decides.** Measured:

  | Filter          | Cardinality | Examined / returned (before) |
  | --------------- | ----------- | ---------------------------- |
  | `eventId`       | identity    | **500 / 1**                  |
  | `correlationId` | identity    | **399 / 50**                 |
  | `cameraId`      | identity    | **497 / 50**                 |
  | `kind`+`status` | enum        | 99 / 50                      |

  A residual predicate over a cursor-ordered walk with a limit costs `limit ÷ selectivity`. For a
  two-valued enum that is ~100 documents and fine; for a near-unique id it is the tenant's entire
  history. So an **identity** filter must have a narrowing index and an **enum** filter may ride the
  time index — and indexing a two-valued field costs a write on every insert to save nothing.

After: every ratio is 1:1 and flat from 10,000 to 500,000 rows. `eventId` went from 500/1 to 1/1.

### 2. An actor's type is recorded, never inferred

`IncidentActor` was a bare string, so `"priya"`, `"system"` and a future AI principal were
indistinguishable. `IncidentActorRef {kind, id, displayName?}` is now written on every transition,
assignment and note, with `by` retained unchanged.

⚠️ **Pre-P-5.1 records resolve to `unknown`.** `"system"` is probably the platform — and _probably_
is the entire problem, because a person named system is an ordinary account. Typing old records by
guessing is the mistake CONSTRAINTS §52 exists to prevent, so `resolveActor` returns
`{kind: 'unknown', id: <the string>}` and the UI can say so.

The one inference that is not a guess: a bare string arriving through a write path always meant "the
principal id of the human making this request", so it normalises to `operator`.

### 3. The AI boundary is enforced twice, and neither is a convention

The permission catalog is the primary lock: `INCIDENT_PERMISSIONS` contains no write permission an
AI could hold, `incident:ai-recommend` is read-side and granted to no role, and
`REFUSED_INCIDENT_PERMISSIONS` names `incident:ai-resolve|ai-close|ai-assign` as permissions that
**must never exist** — because one that exists can be granted by an administrator who has not read
the comment.

The domain is the second: `assertMayMutate` throws if an `ai-advisor` reaches any state-changing
path. Belt to the catalog's braces, and specifically so an AI action can never be _written into an
immutable audit trail_, where removing it later would mean rewriting history.

### 4. The activity enum models kinds, not a copy of another enum

The recommendation named sixteen activities. Nine are the _payload_ of a kind, not a kind:
acknowledgement / investigation / escalation / resolution are `state-change` plus `transition.to` —
which is `IncidentStatus`, and duplicating it here would leave two enums to keep in sync forever.
Assignment and reassignment differ only by `assignment.from` being present.

`Evidence Removed` was refused outright: evidence is immutable and attachments are append-only notes,
so there is nothing to remove. An enum value implying a capability that must not exist is worse than
a missing one.

AI accept/reject and camera/rule context changes are **deferred rather than added**, because nothing
emits them (CONSTRAINTS §58 applied to an enum). They are safe to add later precisely because every
entry carries `kind`, `actor`, `at` and `summary`, so a consumer renders an unrecognised kind rather
than breaking on it.

`transition` is retained as a value nothing emits, so a consumer pinned to the P-5.0 schema parses.

### 5. The timeline has a join budget, a timeout, and gaps

Three of the timeline's entry kinds are owned by other contexts, so it is a fan-out. The design
carries that rather than hiding it: **at most three upstream calls total** (never one per entry —
§54), opt-in per source, a **2-second timeout per call**, and every absence reported as a typed
`gap` — `unavailable`, `truncated` or `not-requested`.

⚠️ `not-requested` exists so a reader can always distinguish _there is nothing_ from _nobody asked_.
And the `TimelineSources` port **defaults to every source unavailable** — the P-4 pattern. A default
returning empty arrays would claim the sources were consulted; today they are not wired (P-5.2), and
the timeline says exactly that.

Calls are sequential, not parallel: three bounded reads are cheap, and a timeline endpoint that fans
out concurrently multiplies a retry storm across three neighbours at once.

### 6. No SLA policy means `unknown`, and `incident:close` is additive

`IncidentSlaStatus` is derived from the timestamps already stored, so changing a policy re-reports
history against the new target instead of leaving stale verdicts. With no configured policy the
state is **`unknown`** — never `met`. The failure avoided is a dashboard reporting 98% compliance
for a deployment that never set an SLA.

An incident resolved straight from `raised` counts the first move out of `raised` as attention;
otherwise the metric would punish the fastest possible response.

⚠️ **`incident:close` is granted to `operator`.** Splitting it from `incident:resolve` lets a tenant
enforce separation of duties, but _withholding_ it would silently remove an ability every operator
has today — a breaking behaviour change wearing a new permission's clothes. The split is additive;
a tenant that wants the separation revokes one grant.

`incident:create`, `incident:reopen` and `incident:delete` were **refused**: incidents are only
promoted from candidates, a closed incident is sealed (§57), and the history is immutable.

## Consequences

**Good.** The workspace's evidence panel is index-served and measured. Actor type is a fact rather
than a guess. The timeline degrades legibly instead of lying. SLA cannot be fabricated. The AI
boundary is checkable by a test rather than asserted in prose.

**Costs.** Four new indexes on `evidence` are write amplification on the capture path; three
existing indexes are dropped and rebuilt at boot, which is real work on a large collection and is
logged for that reason. Every write now stores an actor object alongside the string it already
stored. `GET /incidents/:id/timeline` currently returns three `unavailable` gaps in every
deployment, because the upstream clients are P-5.2.

**Deliberately not done.** No investigation workspace, no UI, no evidence viewer, no reporting — and
none of the dashboard, notification, playback or evidence-viewer contract freezes the same review
requested, because those are **separate milestones** and merging them would break the discipline the
same review opened by insisting on ("never merge multiple milestones together").

## Alternatives considered

- **Porting the Workflow coverage model unchanged** — rejected once it declared a measurably broken
  index sound. Measured evidence wins (decision 1).
- **Inferring actor type from the legacy string** — rejected: it produces confident wrong answers on
  exactly the records nobody can check (decision 2).
- **Enum values for every named activity** — rejected: it copies `IncidentStatus` into a second enum
  and adds a value implying evidence can be removed (decision 4).
- **Parallel upstream calls** — rejected for now: sequential bounded reads are cheap, and a fan-out
  under load hits three neighbours simultaneously. Revisit if the budget becomes the latency floor.
- **Storing SLA verdicts** — rejected: a stored verdict goes stale the moment a policy changes, and
  the timestamps it is derived from are already immutable.
