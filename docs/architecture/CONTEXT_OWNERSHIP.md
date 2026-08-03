# Context ownership — who owns what, so nothing drifts

**Governance documentation** (P-5.0, Architect rec 7). Describes what already exists; introduces
nothing.

Ownership drift is quiet. Nothing errors when a note about a piece of evidence gets stored on the
evidence record, or when the incident search grows a filter on data the Workflow context does not
own — the code works, the tests pass, and two contexts now share a concept neither of them fully
controls. This document names the line so crossing it is a decision rather than an afternoon.

---

## The register

| Context           | Owns                                                                                                            | Does **not** own                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Rules**         | Rule authoring · validation · **evaluation** · compilation · scope resolution · rule diagnostics, health, audit | Incidents. It emits `IncidentCandidate` and never persists one.                      |
| **Workflow**      | Incident **lifecycle** · assignment · notes / comments · attachments (as references) · incident search + audit  | Evidence bytes · event storage · rule semantics                                      |
| **Events**        | Historical event **retrieval** · ingest idempotency · replay                                                    | Event _meaning_. The catalog and the envelope are AI Runtime v1.0 contracts, frozen. |
| **Evidence**      | **Immutable** evidence records · chain of custody · retention · legal hold                                      | **Annotations.** An investigator's note belongs to Workflow.                         |
| **Locations**     | The org **hierarchy** and nothing else — nodes, paths, breadcrumbs                                              | What happens at a location; historical ancestry snapshots (see TD-20)                |
| **Camera**        | Camera inventory · configuration · health · probes                                                              | Where a camera's incidents live                                                      |
| **Media**         | Streams · recordings · clips · playback targets                                                                 | Evidence lifecycle (it produces artefacts; Evidence governs them)                    |
| **AI Runtime**    | Capabilities · models · inference. Emits **only** `EventEnvelope`s.                                             | Rules, incidents, or any product concept                                             |
| **Platform Core** | Tenancy · auth · permissions · config · messaging                                                               | Any domain concept at all                                                            |

---

## The three lines that are easiest to cross

### 1. Evidence owns evidence. Workflow owns what people say about it.

An evidence record is immutable by design — that immutability _is_ the value of the Evidence
Foundation, and it is what makes a chain of custody mean anything. Hanging a mutable annotation off
it would quietly break the property the foundation exists to guarantee.

So an annotation is an **investigator's statement about evidence**, stored as an
`IncidentNote.attachments[]` entry referencing the evidence by id. This is why no Evidence Foundation
change was needed for P-5: the obvious implementation would have demanded one.

### 2. Rules own evaluation. Workflow owns the consequence.

The Rules context decides _whether_ a rule fired and can explain _why_. It emits a candidate. It
never decides what an operator does about it, never stores an incident, and never learns whether one
was raised. Conversely, the Workflow context never re-evaluates a rule — it asks
`GET /rules/:id/incident-context?version=` for the rule **as it was**, and
`POST /rules/:id/simulate` to replay the triggering event through the same interpreter.

There is no second evaluator anywhere, and there must not be one.

### 3. Locations own the hierarchy. Whoever needs history snapshots it.

The Location Hierarchy answers "where is zone X _now_". That is correct and complete. A consumer who
needs "where was zone X in February" must have captured it in February — the pattern
`ProbeConfigurationSnapshot` already uses. TD-20 is exactly this gap in the Evidence context, and it
is filed against Evidence rather than Locations for that reason.

---

## The test each of these has to pass

Before adding a field, a route, or a filter, one question: **if this context vanished, would the
data still make sense where it lives?**

- A note on an incident: yes — it is a statement made during that investigation.
- A note on an evidence record: no — it is not part of the record's provenance, and it would
  outlive the reason it was written while claiming to be part of an immutable artefact.
- An incident's `triggeredBy.cameraId`: yes — a copied identifier is provenance, not ownership.
- An incident storing the camera's _name_: no — that is Camera's to change, and the copy goes stale
  silently.

---

## Related

- [INCIDENT_BOUNDARY](INCIDENT_BOUNDARY.md) · [22-BOUNDED-CONTEXTS](22-BOUNDED-CONTEXTS.md) · [23-SERVICE-OWNERSHIP](23-SERVICE-OWNERSHIP.md)
- [FOUNDATIONS](../project/FOUNDATIONS.md) · [CONSTRAINTS](../project/CONSTRAINTS.md)
