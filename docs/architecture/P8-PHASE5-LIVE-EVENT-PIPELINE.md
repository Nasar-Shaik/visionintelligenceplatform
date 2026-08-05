# P-8 Phase 5 — Live Event Pipeline · **Bridge architecture for review**

- **Status:** 🟡 **DESIGN ONLY — no implementation code exists or may be written until this is approved**
- **Date:** 2026-08-06
- **Supersedes:** the _"what Phase 5 builds"_ sections of
  [P8-PHASE5-RULE-ENGINE-ARCHITECTURE.md](P8-PHASE5-RULE-ENGINE-ARCHITECTURE.md) — that document's
  central finding was accepted, and this one is the detailed design that follows from it
- **Related:** [09-EVENT-PLATFORM.md](09-EVENT-PLATFORM.md), [10-RULE-ENGINE.md](10-RULE-ENGINE.md),
  [ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md) (event backbone + subject taxonomy),
  [ADR-0038](../adr/ADR-0038-track-identity-across-gaps.md),
  [ADR-0039](../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md)

---

## ⚠️ A second finding, larger than the first

The first review found that the Rule Engine already exists. Tracing the wiring for this document
found that **more of the pipeline is built than that review credited.**

`services/events` already runs a normalizer that consumes `DetectionResult` off
`t.{tenant}.capability.>`, converts it to `EventEnvelope`s, deduplicates them, persists them, and
publishes to `t.{tenant}.event.>`. The rules engine already subscribes to that. Its output already
lands on `AUTOMATION` as `IncidentCandidate` and `RuleMatch`.

⚠️ **The dedup key already prefers `trackId`.** It was written for tracked subjects before tracking
existed on the live path.

```
                    ┌──────────────────────── ALREADY BUILT AND FROZEN ─────────────────────────┐
camera → media → /infer → DetectionResult ⋯⋯ t.{t}.capability.>  →  events (normalize · dedup ·
                              │                       ▲               persist) → t.{t}.event.>
                              │                       │                                 │
                     RuntimeTracker ✅            ⚠️ NOBODY                              ▼
                     (Phase 4)                     PUBLISHES                    rules → RuleEngine
                              │                     HERE                                 │
                              ▼                                                          ▼
                    ┌──────────────────┐                                    IncidentCandidate
                    │ EventPublisher   │ ⚠️ no-op                                        │
                    └──────────────────┘                                    workflow · notify
```

### There are exactly two gaps, and they are very different sizes

| #     | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Size                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| **1** | **Nothing publishes.** Media parses the `/infer` response, counts detections by label for its own metrics, and discards the rest. ⚠️ It does **not** already hold a `DetectionResult` — the response carries `detections`, `inferenceMs`, `frameLatencyMs`, `executionProvider` and `model`, while the contract also requires `tenantId`, `cameraId`, `capabilityId`, `capabilityVersion`, `runtimeVersion`, `frame{seq, capturedAt}` and the preprocessing fingerprint. So the work is _assembling_ one from the response plus the frame context media already has, then publishing it — after which the entire chain runs on frozen code | ⚠️ **small change, very large effect** |
| **2** | **No spatial or temporal events.** The normalizer maps detections 1:1 to `perception.*`. It holds no zone geometry and no track history, so `spatial.zone.entered`, `spatial.line.crossed`, `temporal.dwell.exceeded` and `analytics.occupancy.changed` have **no producer anywhere on the live path**                                                                                                                                                                                                                                                                                                                                     | the real work                          |

⚠️ **Gap 1 must be delivered and verified on its own, before gap 2 exists.** It is the first time
this platform will have published a perception event end to end, and it will find the things that
only a running system finds — dedup window behaviour at 2 fps, event volume, ordering, back-pressure.
Building the spatial evaluator on top of an unproven publish would mean debugging two new subsystems
through each other. That is the mistake Phase 4 avoided by proving inference before adding tracking.

---

## 1 · The event model — ⚠️ do not create a `TrackingEvent` envelope

The brief says _"freeze the TrackingEvent schema before implementation"_. Taken literally that
creates a **second event model beside the frozen `EventEnvelope`** — the same duplicate-source-of-
truth trap the first review avoided for the rule engine, one layer down.

`EventEnvelope` is already the platform's event contract and already carries everything a tracking
event needs:

| Envelope field                                          | Carries                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `type`, `category`, `priority`                          | what happened, from the frozen catalogue                           |
| `tenantId`, `branchId`, `siteId`, `cameraId`, `zoneId`  | where — including the zone                                         |
| `occurredAt`, `ingestedAt`                              | when it happened vs when we learned                                |
| `producer{capability, capabilityVersion, modelVersion}` | provenance, model-agnostically                                     |
| `subjects[{trackId, class, bbox, attributes}]`          | ⚠️ **the tracked subject — `trackId` is already here**             |
| `correlationId`, `causationId`                          | chaining a dwell event back to the entry that started it           |
| `payload` (opaque, versioned by `schemaVersion`)        | the type-specific body                                             |
| `evidenceRefs`                                          | the frozen Evidence Foundation                                     |
| `envelopeVersion` vs `schemaVersion`                    | ⚠️ **already separates envelope evolution from payload evolution** |

### So what gets frozen is the PAYLOAD schemas, not a new envelope

**Proposal: `TrackingEvent` is a family of payload schemas carried by the existing envelope**, one
per event type, registered in the event catalogue and versioned by `schemaVersion`. This is precisely
what the envelope's two-version design was built for.

| Event type                         | Payload (proposed, for review)                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `tracking.track.updated`           | `{ state, motion{durationSeconds, pathLengthNormalized, averageSpeedNormalized, headingDegrees, dwellSeconds}, hits, age }` |
| `spatial.zone.entered` / `.exited` | `{ zoneVersion, entryPoint, dwellSecondsAtExit? }`                                                                          |
| `spatial.line.crossed`             | `{ lineVersion, direction: 'a-to-b' \| 'b-to-a', crossingPoint }`                                                           |
| `temporal.dwell.exceeded`          | `{ zoneVersion, dwellSeconds, thresholdSeconds }`                                                                           |
| `analytics.occupancy.changed`      | `{ zoneVersion, count, previousCount }`                                                                                     |
| `analytics.queue.length`           | `{ zoneVersion, length, previousLength }`                                                                                   |

### ⚠️ One frozen contract genuinely must change — and this is the most important item in the document

`EventSubject` has `trackId`. It does **not** have `identityId`.

ADR-0038 established that a track which leaves and returns gets a **new `trackId`**, linked by
`identityId`. So a dwell rule that accumulates by `trackId` sees a person who was briefly occluded as
**two short visits instead of one long one** — and a 60-second loitering rule silently never fires.

Under [L-42](../project/KNOWN_LIMITATIONS.md) that is not hypothetical: identity fragments under
load, and the two ladder runs disagree on how much (6 % vs 31 % overhead at 16 cameras).

⚠️ **A rule engine consuming tracks inherits every tracking limitation, and this is the one that
changes a verdict rather than a number.** The failure is silent: no error, no alert, an incident that
simply never happens.

**Proposal:** add `identityId` and `precededBy` to `EventSubject`, optional and additive, and let
rules aggregate by `identityId`. It is a small change to a frozen contract and it needs an ADR.

⚠️ **It does not make dwell correct — it makes it correctable.** Two fragments the tracker never
linked still look like two people. This closes the gap the platform _can_ close and discloses the
rest.

### Why this shape carries future producers without redesign

The brief requires Camera Assignment, Analytics, Rules and future AI modules to fit. They do, because
**a producer is identified by `producer.capability`, not by a type in the schema**. A new producer
adds catalogue entries and payload schemas; it changes no envelope, no bus subject, no consumer.
That property already exists — this design's contribution is not spending it.

---

## 2 · The Event Publisher — treated as a first-class subsystem

### 2.1 Where it lives

The first review offered runtime→NATS (A) or runtime→media→NATS (B) and proposed B. Tracing the
existing normalizer **strengthens B to the point where A should be withdrawn**:

- the events service already consumes `DetectionResult` off the capability subject, and media holds
  every field needed to assemble one — the response body plus the frame context it used to make the
  request. ⚠️ **The runtime could stamp the missing fields itself and return a complete
  `DetectionResult`**, which is worth deciding explicitly: it is the more honest provenance (the
  runtime is what knows its own `runtimeVersion` and preprocessing fingerprint) at the cost of a
  larger response body. See question 3;
- the runtime therefore needs **no broker client, no credentials and no second network dependency**,
  and the P-8 Phase 1 property (the runtime is not on the gateway, publishes no host port, and media
  is its only consumer) stays intact without an argument;
- a broker outage degrades events while inference continues, rather than stalling the frame path.

**Proposal: media publishes.** The runtime's no-op `EventPublisher` stage is then _removed rather
than implemented_ — ⚠️ leaving a no-op named `EventPublisher` in the pipeline after deciding
publishing happens elsewhere would be a permanent invitation to wire the wrong thing.

### 2.2 What it must handle, decided now rather than discovered

| Concern              | Proposal                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Volume**           | 2 fps × 16 cameras × N detections. ⚠️ Publishing every detection every frame is ~32 messages/s before zones exist. The dedup window in `events` collapses repeats, but it collapses them **after** the broker hop   |
| **Back-pressure**    | The same drop-and-count discipline media already uses for frames, with a counter. ⚠️ A silently dropped event that should have been an incident is the worst failure available to this design                       |
| **Ordering**         | Per camera, best-effort. Out-of-order frames are already counted and skipped by the tracker; the publisher must not reintroduce them                                                                                |
| **Failure**          | A publish failure must never fail the frame path. Recorded as a metric, never as an exception into recording                                                                                                        |
| **Tenant isolation** | Subject is `t.{tenantId}.capability.{capabilityId}`; `events` already re-checks the subject token against the body's `tenantId` and dead-letters a mismatch. ⚠️ That check must stay — it is the cross-tenant guard |
| **Idempotency**      | `DetectionResult` already carries the identity needed for `dedupKey`; redelivery collapses                                                                                                                          |

### 2.3 Metrics — ADR-0039 applied before the code

| Metric                                                                           | Measurable?                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publisher.published_total`, `publisher.dropped_total`, `publisher.failed_total` | ✅                                                                                                                                                                                                          |
| `publisher.publish_ms` p50/p95                                                   | ✅                                                                                                                                                                                                          |
| `publisher.queue_depth`                                                          | ✅                                                                                                                                                                                                          |
| `events.normalized_total`, `events.deduped_total`                                | ✅                                                                                                                                                                                                          |
| **`publisher.lost_total`**                                                       | ⚠️ **partly** — messages the publisher dropped are countable; messages the broker lost are not visible from here. The metric must be named for what it counts (`dropped_by_publisher`), not for the outcome |
| **"did every real event become an incident?"**                                   | ❌ needs ground truth — **unavailable** (ADR-0039)                                                                                                                                                          |

---

## 3 · Rules as configuration

Rules stay **declarative and versioned**, which the frozen engine already provides. A vertical is a
**pack of rule documents plus zone attribute conventions** — data, not code.

⚠️ **The test that keeps it honest:** adding retail must not add a TypeScript file. If it does, the
abstraction failed and the right response is an additive extension to `RuleCondition` with an ADR, so
every vertical gets it — not a bespoke evaluator for one customer.

⚠️ **A rule pack must state what it cannot do.** PPE, fall and weapon rules need models this platform
does not run. A "retail pack" implying shoplifting detection would be the same class of claim as a
fabricated metric.

---

## 4 · Delivery, with the eight-part standard applied to each

Per the permanent standard, **each phase ships all eight**: runtime, metrics, browser visibility,
deployment verification, mutation testing, nightly automation, benchmark evidence, governance.

| Phase   | Deliverable                                                                                                                     | Why this order                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **5.1** | **The publish.** Media publishes `DetectionResult`; perception events flow to rules; a rule fires; an incident candidate exists | ⚠️ Proves the whole frozen chain end to end using only existing types. Everything after it builds on a _verified_ bridge |
| **5.2** | **Zone store** (camera service, immutable versions) + read-only zone view                                                       | Four of six rules are meaningless without geometry                                                                       |
| **5.3** | **Spatial/temporal evaluator** → the remaining four event types                                                                 | The real new logic                                                                                                       |
| **5.4** | **Rule configuration + operator workflow** — live events become evaluations and candidates                                      | The customer-visible result                                                                                              |
| **5.5** | **Event replay, publisher metrics, capacity benchmark**                                                                         | ⚠️ Re-measure sizing: rules add work to the same host and the honest expectation is the camera count **falls**           |

`scripts/nightly/stages/rules/` is already named in the stage tree, so no framework change is needed.

### Verification, designed before the code

⚠️ **The authored-fixture argument carries forward and gets stronger.** "Did the rule fire
correctly?" is unanswerable on real footage for the same reason "was this the same person?" was.

- a person entering a restricted zone → **exactly one** candidate, not zero and not fourteen
  (⚠️ the fourteen case is the real risk: boundary jitter at 2 fps without debouncing);
- a person walking _along_ a boundary → **zero**;
- a track lost inside a zone → **no exit event**, and the dwell timer keeps running;
- a rule disabled mid-stream → evaluation stops at the next event, provably;
- ⚠️ **a fragmented identity → the dwell rule still fires** if `identityId` aggregation is adopted,
  and demonstrably does not if it is not. This is the test that decides §1's contract change.

---

## 5 · Risks

| Risk                                                                                                                                                                                                                            | Severity |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| ⚠️ **Fragmentation silently breaks dwell rules** (L-42). The incident simply never happens — no error, no alert. §1's `identityId` change is the mitigation, and it is partial                                                  | **high** |
| ⚠️ **Boundary jitter produces an incident storm.** Debouncing is a correctness requirement, not a refinement                                                                                                                    | **high** |
| ⚠️ **Event volume was never measured.** Nothing has ever published from the perception tier. 5.1 exists partly to find this out before the design depends on it                                                                 | **high** |
| ⚠️ **Normalized coordinates are not ground coordinates** (L-44). A zone is a region of the _picture_; a distant person's feet may fall outside a zone their body overlaps. This is L-44 changing a verdict rather than a number | med      |
| ⚠️ **Tracking state does not survive a restart** (TD-67). A deploy mid-shift resets every dwell timer — acceptable for tracking, questionable once a timer decides whether an incident exists                                   | med      |
| Rule cost may be multiplicative in rules × cameras                                                                                                                                                                              | med      |
| ⚠️ **AI must remain advisory.** A rule creates a _candidate_; it never mutates an incident, evidence or a rule. Frozen foundations enforce this — listed so it is checked, not assumed                                          | med      |

---

## 6 · What Phase 5 will NOT do

- ❌ No new rule engine, and no new event envelope.
- ❌ No cross-camera rules (L-43 — identity does not cross cameras).
- ❌ No accuracy claims from live data (ADR-0039).
- ❌ No PPE, fall, weapon or face rules — each needs a model that does not exist here.
- ❌ No automatic action. A candidate goes to a human; workflow and notify are already built for it.
- ❌ No real-footage validation. L-1 stands until P-9.

---

## 7 · Questions for the Architect

1. **`EventSubject.identityId`** — approve the additive change to a frozen contract (ADR required)?
   ⚠️ **Without it, dwell and loitering rules under-fire whenever identity fragments, silently.**
   This is the highest-consequence question here.
2. **`TrackingEvent` as payload schemas on the frozen `EventEnvelope`**, rather than a new envelope
   type — confirm?
3. **Media publishes, not the runtime** — confirm, and confirm removing the runtime's no-op
   `EventPublisher` stage rather than implementing it? ⚠️ **Sub-question:** should the runtime return
   a _complete_ `DetectionResult` (it alone knows its `runtimeVersion` and preprocessing fingerprint,
   so provenance is more honest) or should media assemble one from the response plus its own frame
   context (smaller payload, but media asserts fields it did not produce)?
4. **5.1 shipped and reviewed on its own** before zones and the evaluator? It is a small change with
   a full eight-part delivery around it, and it is the only way to learn the event volume before
   designing against it.
5. **Dwell timers and restarts** (TD-67) — acceptable that a deploy resets them, or does Phase 5 owe
   durable dwell state?
6. **Zone versioning** — confirm immutable versions, so an incident six months old can name the
   boundary as it was?

---

**No implementation code has been written. Awaiting approval.**
