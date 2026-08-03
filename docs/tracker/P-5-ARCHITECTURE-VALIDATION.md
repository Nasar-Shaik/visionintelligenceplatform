# P-5 — Architecture Validation Pass

**Run:** 2026-08-03, before any P-5 implementation, at the Architect's direction:

> _"Perform one architecture validation pass to confirm that Incident Management can be built entirely
> by consuming the existing frozen foundations. If any missing capability is discovered, document it
> explicitly, classify it as either an additive enhancement or technical debt, and obtain approval
> before modifying any existing foundation."_

**Method:** the P-5 scope as stated was taken item by item and traced to the contract, route and index
that would serve it. Where nothing served it, the gap is recorded below with the file it lives in.

---

## ⚠️ Verdict

**No frozen foundation needs to change. Six gaps exist, all in contexts that are not frozen, and P-5
cannot start until they are approved.**

|                                                      |                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Frozen foundations requiring change                  | **none** (Platform Core · AI Runtime · Operational Runtime · Camera Foundation · Evidence Foundation · Location Hierarchy) |
| Rule Designer requiring change                       | **none** — `GET /rules/:id/incident-context` was frozen for this in P-4.2                                                  |
| Gaps found                                           | **6**, all additive, all in the Workflow (Incidents) and Events contexts                                                   |
| Gaps that are technical debt rather than enhancement | **1** (G-4, an index that does not exist for a query P-5 will issue)                                                       |

The honest headline is the second half of that sentence. The freeze holds; the **product layer around
it is not finished**, and pretending otherwise by starting P-5 and discovering these one at a time is
the failure this pass exists to prevent.

---

## What the frozen foundations already provide

Each of these was traced to a real route or contract, not assumed.

| P-5 needs                                                                       | Served by                                                  | Where                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| Incident lifecycle + immutable history                                          | `Incident` · `IncidentTransition` · `IncidentStatus`       | Workflow context (P1-8)                    |
| Rule explanation, scope snapshot, dependency graph, compilation metadata, audit | `RuleIncidentContext`                                      | `GET /rules/:id/incident-context?version=` |
| Which zones/cameras the rule covered **then**                                   | `Rule.resolvedScope` on the immutable version              | snapshotted in P-4                         |
| Evidence for an incident                                                        | `EvidenceQuery.incidentId` / `.correlationId` / `.eventId` | `GET /evidence`                            |
| Chain of custody                                                                | `EvidenceCustodyEntry`                                     | `GET /evidence/:id/custody`                |
| Video playback, snapshots, clips, timeline                                      | `PlaybackTarget` · `Clip` · `RecordingSegment`             | Media context                              |
| Camera context                                                                  | `Camera` · `CameraHealth`                                  | Camera Foundation                          |
| Location context                                                                | `OrgLocation` with backend-owned breadcrumb                | Location Hierarchy                         |
| Correlation spine                                                               | `Incident.correlationId`, required and always present      | P1-8 rec 1                                 |
| Tenant isolation on every read                                                  | `TenantScope` + `TenantRepository`                         | Platform Core                              |

**The correlation id is the thing that makes P-5 possible at all.** It was made required in P1-8 and
threads frame → detection → event → candidate → incident → notification → evidence. Four of the six
gaps below are variations on _"that id exists but nothing can be queried by it"_.

---

## The six gaps

Each is classified, sized, and named with the file it lives in. **None is in a frozen foundation.**

### G-1 · The incident lifecycle is missing three states — _additive enhancement_

`IncidentStatus` is `raised → acknowledged → resolved → closed`. P-5 asks for **assign**,
**investigate** and **escalate** as well. The contract already anticipates this:

> _"`escalated`/`assigned`/cases are future (full Workflow engine) — see TECH-DEBT."_
> — `packages/contracts/src/incidents/incident.ts`

**Classification:** additive enhancement to the **Workflow context**, which is _not_ one of the six
frozen foundations.

⚠️ **It still needs approval**, for the reason P-4.2 recorded when adding one value to
`RuleReferenceKind`: **adding a value to a published enum is not purely additive for a strict
parser.** A console or integration pinned to the old schema fails to parse an incident in a new state.
The transition table also has to be extended deliberately — `assigned → resolved` is legal,
`closed → investigating` is not — and a state machine quietly gaining states is how illegal
transitions become reachable.

**Size:** contract + transition table + routes + console. Small, and entirely inside one context.

### G-2 · An incident cannot be assigned, annotated or commented on — _additive enhancement_

`Incident` has `resolution` and per-transition `note`. P-5 needs an assignee, operator notes,
comments, and attachments — the substance of an investigation workspace.

**Classification:** additive enhancement, Workflow context. Optional fields on `Incident` plus a
sub-resource for the note stream.

**One design note worth recording before someone does it the other way:** notes and comments belong in
the **Incident** context, not the Evidence Foundation, even when a note is _about_ a piece of evidence.
An evidence record is immutable by design — that immutability is the entire value of the Evidence
Foundation — and hanging a mutable annotation off it would quietly break the property the foundation
exists to guarantee. An annotation is an investigator's statement about evidence, referencing it by id.

**This is why no Evidence Foundation change is required.** The obvious implementation would have
demanded one.

### G-3 · Incidents cannot be searched by camera, zone, rule, correlation or time — _additive enhancement_

`IncidentQuery` supports `status`, `severity`, `limit`, `cursor` — and nothing else. P-5's stated
search is severity · camera · zone · rule · behaviour · time · status, and its **correlation** feature
is "show me related incidents", which needs `correlationId`.

**Classification:** additive enhancement, Workflow context. New optional query fields.

⚠️ **Do not implement this without G-4.** A filter with no index is a collection scan that is instant
against a fixture and a production incident against a year of data — the exact defect the P-3 hardening
found three times ([CONSTRAINTS §40](../project/CONSTRAINTS.md)).

### G-4 · The indexes for that search do not exist — ⚠️ _technical debt_

`services/workflow/src/adapters/mongo.ts` creates three indexes:
`{tenantId, id}` unique · `{tenantId, source.dedupKey}` unique · `{tenantId, raisedAt, id}`.

Every filter G-3 adds — `triggeredBy.cameraId`, `triggeredBy.zoneId`, `source.ruleId`,
`correlationId` — would be served by **none** of them. Under
[INDEX_POLICY](../project/INDEX_POLICY.md) the sort key must be the key _after_ the equality prefix,
so `{tenantId, raisedAt, id}` serves an unfiltered newest-first list and **abandons the sort** the
moment a filter is added.

**Classification: technical debt, not enhancement.** The distinction matters: an enhancement is
something the platform never claimed to do, and this is a query surface that will be _added_ alongside
an index that does not cover it unless someone checks. The Workflow context has **no index-coverage
test** — the tenant and camera services grew one in P-3 (`index-coverage.test.ts`) precisely because
review had missed three of these.

**Recommended pay-down:** port the P-3 pattern — index specs as data, plus a coverage test asserting
every query pattern the service issues has a covering index — into the Workflow context as part of
P-5. Registered as **TD-22**.

### G-5 · Events cannot be fetched by id, or by correlation — _additive enhancement_

This is the one that blocks a **flagship P-5 feature**, so it is worth being precise.

The investigation workspace shows _why this rule fired_. P-4.2 froze
`GET /rules/:id/incident-context`, which carries the rule as it was, its scope snapshot and its
condition — **but a per-event explanation trace needs the event**, and P-4.2 recorded that openly. An
incident carries `triggeredBy.eventId`. So P-5 fetches the event and calls
`POST /rules/:id/simulate` with it.

**It cannot.** `EventQuery` filters on `type`, `cameraId`, `zoneId`, `from`, `to`, `cursor`, `limit`.
There is **no `id` filter and no `GET /events/:id`** (`services/events/src/transport/routes/events.ts`
registers exactly two routes: `GET /events` and `POST /events/replay`). There is also no
`correlationId` filter, which is how "related events" for an incident would be found — and no index on
it either (`tenant_occurredAt`, `tenant_type_time`, `tenant_camera_time`, plus the dedup unique).

**Classification:** additive enhancement to the **Events context**. `GET /events/:id`, plus
`correlationId` on `EventQuery` **and** the index to serve it.

⚠️ **`EventEnvelope` itself is untouched** — it is one of the five frozen AI Runtime v1.0 contracts,
and nothing here proposes changing it. This is a _query_ surface.

### G-6 · An incident's location resolves to today's location — _existing technical debt, already registered_

An incident carries `triggeredBy.zoneId`. Resolving it to a breadcrumb reads the Location Hierarchy,
which returns the zone's **current** ancestry. If the camera or the zone moved since, the investigation
workspace shows a location that is not where the incident happened.

This is exactly [E-1 / TD-20](E-1-EVIDENCE-LOCATION-SNAPSHOT.md), found during the P-3 hardening and
owned by the Evidence context. It is **not new**, it is **not a P-5 gap**, and P-5 will make it
visible for the first time — which is worth knowing before an operator finds it.

**Classification:** existing technical debt (TD-20). No new work required to _start_ P-5; the fix
belongs to E-1 and remains unauthorised.

---

## What P-5 must not do

Recorded now, because each one is the path of least resistance at some point during the slice.

1. **Do not add annotations to the Evidence Foundation.** See G-2 — it would make an immutable record
   mutable.
2. **Do not add a query filter without its index.** See G-4, and CONSTRAINTS §40.
3. **Do not reach into another context's store.** Every read above is through a published route.
4. **Do not recompute a rule's scope for a historical incident.** The version carries the expansion it
   had; recomputing rewrites the past — the P-4 decision and the E-1 failure, in one.
5. **Do not extend `EventEnvelope`.** Frozen AI Runtime v1.0 contract. Query surfaces are separate.
6. **Do not build a second incident audit trail.** `Incident.history` is append-only and already
   there — the P-4.1 lesson about deriving rather than duplicating applies unchanged.

---

## Approval requested

Per the Architect's instruction, **P-5 is blocked on approval of the six items above.** They are all
additive and all outside the frozen foundations, but three carry consequences worth an explicit
decision:

| Item    | Needs approval because                                                                   |
| ------- | ---------------------------------------------------------------------------------------- |
| **G-1** | Extends a published enum — not purely additive for a strict parser                       |
| **G-4** | Is technical debt being paid down inside a product slice, which changes the slice's size |
| **G-5** | Adds a route and an index to a context P-5 does not own                                  |

The remaining three (G-2, G-3, G-6) are ordinary additive work or already-registered debt.

**Nothing in this pass has been implemented.** No contract, route, index or foundation was modified
while producing it.

---

## Related

- [P-4.2 tracker](P-4.2-RULE-DIAGNOSTICS.md) — the P-5 consumer contract this validates against
- [FOUNDATIONS](../project/FOUNDATIONS.md) · [INDEX_POLICY](../project/INDEX_POLICY.md) · [CONSTRAINTS](../project/CONSTRAINTS.md)
- [E-1 / TD-20](E-1-EVIDENCE-LOCATION-SNAPSHOT.md) · [TECH-DEBT](../../tracking/TECH-DEBT.md)
