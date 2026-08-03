# The Incident boundary — what P-5 consumes, and from where

**Frozen 2026-08-03** (P-5.0, Architect recs 2 + 3), before P-5 implementation begins.

The purpose is narrow and worth stating plainly: **no Incident Management feature should require a
Rule Designer, Camera, Evidence, Location or Runtime redesign.** If one does, the boundary was drawn
wrong and that is a decision to take at the boundary, not a change to make in the frozen foundation.

---

## Ownership

**The Incident Context owns these, and no other context may own any part of them:**

| Owned          | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| Lifecycle      | status, transitions, the state machine, terminality             |
| Assignments    | who owns an incident, and the immutable assignment history      |
| Collaboration  | notes, attachments-as-references, operator statements           |
| Timelines      | the merged narrative — derived, never stored                    |
| Investigations | the workspace projection, its state, its findings               |
| Reporting      | incident-shaped aggregates, SLA attainment, operational metrics |

**It consumes, read-only and by id:** Events · Rules · Evidence · Camera · Location. Never their
storage; always a published route.

⚠️ **No downstream context may own incident state.** Three things that forbids, concretely:

1. The **Notify** context may not decide an incident's status. `notification.acked` does not
   auto-acknowledge — that stays an explicit Workflow decision (the deferred loop is TD-8).
2. The **Evidence** context may not carry investigation notes. An annotation is a Workflow object
   referencing evidence by id — see [CONTEXT_OWNERSHIP](CONTEXT_OWNERSHIP.md).
3. The **Rules** context may not learn whether a candidate became an incident. It emits and forgets.

---

## The dependency graph

Every arrow is a **published route or contract**. There is no arrow that is a shared database, and
there is none that points from a foundation back into Incident Management.

```
                        ┌──────────────────────────────┐
                        │   Incident Management (P-5)  │
                        │      Workflow context        │
                        └──────────────┬───────────────┘
                                       │  consumes (read-only, by id)
        ┌───────────────┬──────────────┼──────────────┬───────────────┐
        ▼               ▼              ▼              ▼               ▼
   ┌─────────┐    ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌───────────┐
   │  Rules  │    │  Events  │   │ Evidence │   │  Camera  │   │ Locations │
   └────┬────┘    └────┬─────┘   └────┬─────┘   └────┬─────┘   └─────┬─────┘
        │              │              │              │               │
        └──────────────┴──────────────┴──────────────┴───────────────┘
                                       │
                              ┌────────▼─────────┐
                              │  Platform Core   │
                              │ tenancy · auth · │
                              │ permissions      │
                              └──────────────────┘

   AI Runtime ──emits──► EventEnvelope ──► Events ──► Rules ──► IncidentCandidate ──► Workflow
```

**The correlation id is the spine.** `correlationId` is required on an `Incident` and threads frame →
detection → event → candidate → incident → notification → evidence. It is what makes an
investigation workspace possible at all, and four of the six P-5 entry criteria were variations on
_"that id exists but nothing could be queried by it"_.

---

## The frozen consumption contract

Incident Management consumes exactly these. Each was traced to a real route, not assumed.

| What P-5 needs                                   | Contract                                                   | Route                                      | Owner     |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------ | --------- |
| Event ids → the triggering event                 | `EventEnvelope`                                            | `GET /events/:id`                          | Events    |
| Related events                                   | `EventEnvelope`                                            | `GET /events?correlationId=`               | Events    |
| Rule id + version → the rule as it was           | `RuleIncidentContext`                                      | `GET /rules/:id/incident-context?version=` | Rules     |
| Scope snapshot (which zones it covered **then**) | `Rule.resolvedScope` on the immutable version              | via `RuleIncidentContext`                  | Rules     |
| Evaluation trace (why it fired)                  | `RuleExplanation`                                          | `POST /rules/:id/simulate` with the event  | Rules     |
| Dependency graph                                 | `RuleDependencyGraph`                                      | via `RuleIncidentContext`                  | Rules     |
| Rule metrics                                     | `RuleRuntimeStats`                                         | via `RuleIncidentContext` (optional)       | Rules     |
| Audit timeline                                   | `RuleAuditEntry[]`                                         | via `RuleIncidentContext`                  | Rules     |
| Compilation metadata                             | `RuleCompilation`                                          | via `RuleIncidentContext`                  | Rules     |
| Evidence references                              | `EvidenceQuery.incidentId` / `.correlationId` / `.eventId` | `GET /evidence`                            | Evidence  |
| Chain of custody                                 | `EvidenceCustodyEntry`                                     | `GET /evidence/:id/custody`                | Evidence  |
| Video playback / clips / timeline                | `PlaybackTarget` · `Clip` · `RecordingSegment`             | Media routes                               | Media     |
| Camera context                                   | `Camera` · `CameraHealth`                                  | `GET /cameras/:id`                         | Camera    |
| Location snapshot ⚠️                             | `OrgLocation` with backend-owned breadcrumb                | `GET /locations/:id`                       | Locations |
| Tenant isolation on every read                   | `TenantScope` · `TenantRepository`                         | structural                                 | Core      |

⚠️ **The location row is the known-imperfect one.** Resolving a zone id returns its _current_
ancestry. For a six-month-old incident whose camera has since moved, the workspace will show a
location that is not where it happened. That is [TD-20 / E-1](../tracker/E-1-EVIDENCE-LOCATION-SNAPSHOT.md),
it is owned by the Evidence context, and it is not a Location Hierarchy defect — the hierarchy is
behaving correctly in both halves. P-5 will make it visible for the first time.

---

## The rules that keep the boundary a boundary

1. **Consume by id, through a route.** Incident Management never reads another context's collection
   and never joins across databases.
2. **Nothing flows back.** No foundation queries the Workflow context. If one appears to need to,
   the Workflow context should be publishing an event instead.
3. **Snapshots over recomputation.** An incident refers to the rule _version_ and the scope
   expansion that version carried. Recomputing rewrites the past — the P-4 decision and the E-1
   failure, in one shape.
4. **The Incident owns its own narrative.** Notes, comments, assignment, attachments and the derived
   activity log are Workflow-owned. An annotation about a piece of evidence is an investigator's
   statement referencing it by id, not a mutation of it.
5. **Additive only, across the boundary.** A new field on a consumed contract is fine; a changed
   meaning is an ADR.

---

## What is _not_ on this list, and why

- **A composite-behaviour id.** `IncidentCandidate` does not carry one, so an incident cannot be
  searched or grouped by behaviour beyond `eventType` and `category`. Recorded as **TD-23**; adding
  it is a producer change in the Rules context, not a Workflow one.
- **A cases / incident-grouping model.** Deferred with the full Workflow engine (TD-8). The 500-note
  ceiling on a single incident is the signal that a case model is needed, not a limit to raise.
- **SLA timers and escalation policies.** P-5 scope lists SLA tracking; the _timer_ infrastructure
  (escalation policies, on-call rotation) remains TD-8. `escalation.at` is recorded, so elapsed time
  is derivable without it.

---

## Related

- [P-5 entry criteria](../tracker/P-5-ENTRY-CRITERIA.md) · [P-5 architecture validation](../tracker/P-5-ARCHITECTURE-VALIDATION.md)
- [CONTEXT_OWNERSHIP](CONTEXT_OWNERSHIP.md) · [FOUNDATIONS](../project/FOUNDATIONS.md)
- [22-BOUNDED-CONTEXTS](22-BOUNDED-CONTEXTS.md) · [11-WORKFLOW-ENGINE](11-WORKFLOW-ENGINE.md)
