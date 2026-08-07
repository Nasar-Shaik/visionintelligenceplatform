# ADR-0047 — An analysis run is part of an event's identity

- **Status:** Accepted
- **Date:** 2026-08-07
- **Milestone:** P-8 Phase 8 (Offline Video Investigation), slice 3→4
- **Scope:** **platform-wide** — amends the frozen `EventEnvelope`
- **Amends:** [ADR-0040](ADR-0040-one-event-envelope-many-payload-schemas.md) (one envelope, many payloads)
- **Related:** [ADR-0038](ADR-0038-track-identity-across-gaps.md),
  [ADR-0039](ADR-0039-absent-metrics-are-unavailable-never-zero.md),
  [ADR-0041](ADR-0041-identity-travels-with-the-subject.md),
  [L-61](../project/KNOWN_LIMITATIONS.md)

## Context

Offline video investigation replays a stored recording through the live pipeline. To make an
analysis reproducible — the same file at 1× and at 8× producing the same answer — every frame is
stamped with **footage time**: where it sits in the recording, not when the analysis happened to run.
That property is verified and it is the milestone's central acceptance criterion.

It also breaks deduplication, and it does so silently.

`services/events` deduplicates on `tenant + type + camera + zone + track + time-bucket`, where the
bucket is derived from `occurredAt`. Every one of those six is a property of the observation, so
**re-analysing one recording on one camera reproduces all six exactly**. And because footage time
never advances, the collision is **permanent** rather than windowed.

⛔ Measured on the deployed stack before this decision:

```
detections offered : 120
events_normalized_total{outcome="deduped"}   +120
events_normalized_total{outcome="persisted"}   +0
session state      : succeeded, framesAnalysed 60, detections 120
```

An operator re-running an investigation — after adding a rule, adjusting a zone, or simply to check —
saw a completed analysis with an **empty timeline** and nothing anywhere saying why. The rerun the
product is built around (`sequence`, `maxSessionsPerAnalysis: 20`) returned nothing.

### ⛔ Why nothing already on the envelope could carry this

`correlationId` is the obvious candidate and it is the wrong one. On the live path the event
publisher stamps it **per frame** (`tenant:camera:seq`), deliberately, so that "follow this frame
through the pipeline" is answerable. Feeding it to the dedup key would give every live frame a unique
key and **switch deduplication off for every camera on the platform**.

`causationId`, `payload` and `subjects` were each considered and rejected for the same reason in
different clothes: dedup identity is a first-class property, and reading it out of a free-form bag
makes an invariant depend on a convention nothing enforces.

## Decision

**Add `analysisSessionId` to `EventEnvelope` as an optional field, and append it to the dedup key
only when it is present.**

```ts
// packages/contracts/src/events/envelope.ts
analysisSessionId: z.string().min(1).max(120).optional(),
```

```ts
// services/events/src/domain/event-normalizer.ts
const parts = [tenantId, type, camera, zone, track, bucket];
if (envelope.analysisSessionId !== undefined) parts.push(envelope.analysisSessionId);
return parts.join('|');
```

It reaches the envelope through `DetectionResult.analysisSessionId`, also optional and also additive.

⭐ **Media stamps it, not the runtime.** AI Runtime v1.0 is frozen and closed; it neither knows nor
needs to know that offline analysis exists. The frame sink holds the frame's provenance, so it is the
only component that can state this truthfully, and it attaches it on the way to the broker **after**
the contract validation — so a malformed result is still attributed to the runtime that produced it.

## Consequences

### ⭐ Live behaviour is unchanged, and "unchanged" is meant literally

A live camera has no analysis run, so the field is **absent** on every event any existing producer
emits, and `dedupKey` appends nothing. Live keys are therefore **byte-identical** to the strings this
function produced before this ADR existed.

⚠️ That is a correctness requirement, not tidiness. Dedup state outlives a deployment: a key whose
*shape* changed would make every live camera miss its window once on rollout — a burst of duplicate
events at exactly the moment an operator is watching a deploy. Joining a placeholder into the key
would have done precisely that. A test asserts the byte-identity.

### Within one analysis, deduplication is unchanged

Two observations of the same subject in the same bucket of the *same* session still collapse. Only
**different runs** are separated. An analysis does not multiply its own events.

### Absent is a real answer

⚠️ Consistent with [ADR-0039](ADR-0039-absent-metrics-are-unavailable-never-zero.md): absent means
"a live camera produced this", never "unknown" and never a placeholder. Consumers must treat absence
as live rather than defaulting it.

### Migration

**None required, and that is the point of an additive optional field.** Events written before this
ADR have no `analysisSessionId`; they read back identically, their dedup keys are unchanged, and no
backfill is possible or meaningful — they were produced by live cameras, which have no analysis run.
The new index `tenant_analysis_time` is created on start like every other and matches nothing until
the first offline analysis runs.

### What it unlocks

The field is the join key for everything downstream of this milestone, none of which any other field
can answer:

| Consumer                | Question it must answer                               |
| ----------------------- | ----------------------------------------------------- |
| Investigation timeline  | the events **this run** produced, in footage order    |
| Incident review         | which incidents belong to this run, not the live queue |
| Evidence extraction     | the frame this run's incident came from               |
| Export report           | a defensible record of one run                        |
| Model comparison        | two runs over the same footage, told apart            |

## Alternatives rejected

| Alternative                                  | Why not                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Use `correlationId` in the dedup key         | ⛔ Stamped per frame on the live path — would disable deduplication for every camera on the platform                  |
| Put it in `payload` and read it from there   | Makes a dedup invariant depend on an unenforced convention in a free-form bag                                         |
| Give offline analysis a synthetic camera id  | ⛔ The camera carries the zones and the rule scope. A synthetic camera is evaluated against the wrong polygons        |
| Offset footage time per run so buckets differ | ⛔ Destroys the parity guarantee this milestone exists to provide, and puts a lie in `occurredAt`                     |
| A separate collection for offline events      | A second event path — exactly what this milestone was commissioned not to build                                       |
