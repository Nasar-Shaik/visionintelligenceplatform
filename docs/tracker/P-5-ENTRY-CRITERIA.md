# P-5 Entry Criteria — the readiness matrix

**Status:** ✅ **ACCEPTED** by the Architect, 2026-08-03. All six criteria met.
**P-5 implementation is gated on one further step:** the [P-5 architecture document](../architecture/P-5-INCIDENT-MANAGEMENT.md) and its approval (Architect rec 14 — _"only after approval should implementation begin"_).
**Slice:** P-5.0 — Incident Management Entry Criteria · **Date:** 2026-08-03
**Authorised by:** Architect approval of P-4.2 and of the
[P-5 architecture validation pass](P-5-ARCHITECTURE-VALIDATION.md), which turned its six findings
into formal entry criteria.

> _"Once the six P-5 entry criteria are accepted and tracked, begin P-5 Incident Management."_

This document is the **single source of truth** for that gate (Architect rec 1). Nothing in P-5's
own scope — the workspace, the evidence viewer, the timeline, collaboration UI, reporting, SLA — was
built here. This slice built only what P-5 needs to exist first.

---

## The matrix

| ID      | Requirement                 | Owner    | Class              | Blocking | Status      | Evidence                                                                                        |
| ------- | --------------------------- | -------- | ------------------ | -------- | ----------- | ----------------------------------------------------------------------------------------------- |
| **G-1** | Incident workflow lifecycle | Workflow | enhancement        | yes      | ✅ complete | `IncidentStatus` +`investigating` +`escalated`; `ALLOWED_FROM` pinned by test; ADR-0029         |
| **G-2** | Incident collaboration      | Workflow | enhancement        | yes      | ✅ complete | `assignee` · `assignments` · `notes` · derived `IncidentActivity`; 5 routes                     |
| **G-3** | Incident query surface      | Workflow | enhancement        | yes      | ✅ complete | `IncidentQuery` **frozen** at 9 filters + window + cursor; asserted in `incident.test.ts`       |
| **G-4** | Search indexes              | Workflow | **technical debt** | yes      | ✅ **paid** | TD-22 closed: 9 new indexes, coverage test, `explain()` planner verification, scale benchmark   |
| **G-5** | Event retrieval             | Events   | enhancement        | yes      | ✅ complete | `GET /events/:id` + `EventQuery.correlationId` + 5 indexes + lookup metrics + migration test    |
| **G-6** | Evidence location snapshot  | Evidence | existing debt      | **no**   | ⏳ carried  | TD-20 / [E-1](E-1-EVIDENCE-LOCATION-SNAPSHOT.md) — unchanged, still unauthorised, not a blocker |

**G-6 is deliberately still open.** It is pre-existing debt owned by the Evidence context, it does
not block P-5 from starting, and the Architect's instruction was to keep carrying it without
redesigning the Location Hierarchy. P-5 will make it _visible_ for the first time — an investigation
into an old incident can show a location the camera has since left — which is worth knowing before an
operator finds it.

---

## What each criterion actually delivered

### G-1 · Lifecycle — and the one recommendation not followed as written

`raised → acknowledged → investigating → escalated → resolved → closed`, with `investigate` and
`escalate` reachable from each other because both really happen: an escalated incident gets
investigated by whoever it landed on, and an investigation that runs out of authority gets escalated.

⚠️ **`assigned` is not a status.** The entry criterion listed Assign alongside Investigate and
Escalate as lifecycle states; it is implemented as an **operation** instead. An incident can be
assigned while raised, acknowledged, investigating or escalated, and re-assigned without changing
state. Making it a status makes `assigned → resolved` and `resolved → assigned` both look legal and
the transition table stops meaning anything. Assign is a first-class action with its own route,
permission and immutable history — it simply does not move the incident. Reasoned in
[ADR-0029](../adr/ADR-0029-incident-workflow-entry-criteria.md).

⚠️ **Extending a published enum is not purely additive.** A consumer pinned to the P1-8 four-value
schema fails to parse an incident in a new state. In-repo this surfaced immediately as a compile
error in three console files whose `Record<IncidentStatus, …>` stopped being exhaustive — which is
the good version of this failure. An external integration gets the bad version, which is why the
enum is pinned by a test that must be edited deliberately.

### G-2 · Collaboration — three streams, one derived view

`assignee`, an append-only `assignments` stream, an append-only `notes` stream, and attachments that
are **references** (`{kind: 'evidence' | 'link', ref}`) rather than content.

The **activity log is derived**, not stored: `IncidentActivity` merges `history` + `assignments` +
`notes` on read. A stored fourth copy would be a second audit trail — the P-4.1 lesson, unchanged —
and the derived one works on incidents raised long before this contract existed, with no backfill.

Two boundaries held deliberately: an attachment never copies the evidence record (an immutable
record with a mutable copy beside it is not immutable), and a **closed incident is sealed** — no
transition, no assignment, no note. "Terminal; retained for audit" is only true if the record stops
changing.

### G-3 · The frozen query surface

Nine filters — `status` · `severity` · `category` · `eventType` · `cameraId` · `zoneId` · `ruleId` ·
`correlationId` · `assignee` — plus a `from`/`to` window and the existing cursor. Frozen so P-5 can
be built against it without an API redesign (rec 9), and asserted whole in `incident.test.ts`.

⚠️ **Two filters the criterion asked for are deliberately absent.** "Behavior" and "Composite" have
no queryable id: `IncidentCandidate` carries `ruleId`, `ruleVersion` and `ruleName`, and nothing
about a composite behaviour or behaviour profile. A filter for either would always match nothing
while looking like it works. Behaviour search is served honestly by `eventType`
(`behavior.loitering`, …) and `category`; the missing id is recorded as **TD-23**.

### G-4 · Indexes — TD-22 paid before the filters landed, not after

Nine new indexes, every one ending in the `(raisedAt, id)` cursor pair. Verified three ways, because
the recommendation asked for coverage **and** sort **and** planner **and** benchmark **and**
regression:

| Check                 | Where                            | Runs                    |
| --------------------- | -------------------------------- | ----------------------- |
| Declaration + sort    | `test/index-coverage.test.ts`    | always                  |
| Planner (`explain()`) | `test/mongo-integration.test.ts` | when Mongo is reachable |
| Scale shape           | `bench/incident-search.bench.ts` | on demand               |

The coverage model is **three-valued** — `covered`, `bounded`, `scan` — rather than the two-valued
model the tenant and camera services use, and the reason is a mistake worth recording: written the
obvious way, the base cursor index `{tenantId, raisedAt, id}` made _any_ filter look served, because
it consumes the tenant and serves the sort. It also walks every incident the tenant ever raised. An
index now only counts as narrowing if it consumes a key **beyond** the tenant prefix, and a
self-test asserts the model catches both the missing-index and the truncated-index cases.

**Planner verification ran for real.** A MongoDB was reachable in this session, and all ten filters
were confirmed to choose the declared index with no `SORT` stage and no `COLLSCAN`.

### G-5 · Event retrieval

`GET /events/:id` — the route the investigation workspace's flagship answer depends on. An incident
carries `triggeredBy.eventId`; until now nothing could turn that back into an event, so _why did this
rule fire_ could not be answered. Plus `EventQuery.correlationId` for "every event related to this".

`EventEnvelope` is untouched — it is a frozen AI Runtime v1.0 contract, and this is a query surface.

Three things worth flagging:

- The by-id index is **non-unique on purpose**. A unique `{tenantId, id}` would route a genuine id
  collision into `persist`'s duplicate-key branch, which reports "already stored" and skips
  publishing — silently dropping a real event to enforce a constraint nothing needed. Uniqueness is
  `dedupKey`'s job and stays there.
- Three P1-5 indexes **stopped at `occurredAt`** and abandoned the `(occurredAt, id)` sort every
  paged read performs. Fixed here. Re-declaring a name with different keys is an
  `IndexOptionsConflict` that fails the service at boot, so `ensureIndexes` drops and rebuilds — and
  an integration test recreates the P1-5 shape and proves the service still starts.
- Lookup metrics have **no cache-hit / cache-miss counters, because there is no cache** (rec 4 named
  four series; three are real). A counter pinned at zero reads as a broken cache, which is a worse
  answer than an absent one.

---

## What P-5 must still not do

Carried forward from the validation pass, unchanged and now enforceable:

1. **Do not add annotations to the Evidence Foundation.** Notes live in the Incident context and
   reference evidence by id. Making an immutable record mutable defeats the foundation.
2. **Do not add a query filter without its index.** The coverage test fails first — that is the
   point of it.
3. **Do not reach into another context's store.** Every read is through a published route.
4. **Do not recompute a rule's scope for a historical incident.** The version carries the expansion
   it had.
5. **Do not extend `EventEnvelope`.** Frozen. Query surfaces are separate.
6. **Do not build a second incident audit trail.** `history`, `assignments` and `notes` are
   append-only and `IncidentActivity` derives the view.

---

## Related

- [P-5 architecture validation pass](P-5-ARCHITECTURE-VALIDATION.md) — where the six came from
- [INCIDENT_BOUNDARY](../architecture/INCIDENT_BOUNDARY.md) — what P-5 consumes, and from where
- [CONTEXT_OWNERSHIP](../architecture/CONTEXT_OWNERSHIP.md) — who owns what, so nothing drifts
- [ADR-0029](../adr/ADR-0029-incident-workflow-entry-criteria.md) · [TECH-DEBT](../../tracking/TECH-DEBT.md)
- [INDEX_POLICY](../project/INDEX_POLICY.md) · [CONSTRAINTS](../project/CONSTRAINTS.md)
