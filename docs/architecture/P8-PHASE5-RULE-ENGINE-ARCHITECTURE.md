# P-8 Phase 5 — Rule Engine over Tracking · **Architecture for review**

- **Status:** 🟡 **DESIGN ONLY — no implementation code exists or may be written until this is approved**
- **Date:** 2026-08-06
- **Follows:** P-8 Phase 4 (object tracking), frozen 2026-08-05
- **Related:** [10-RULE-ENGINE.md](10-RULE-ENGINE.md), [09-EVENT-PLATFORM.md](09-EVENT-PLATFORM.md),
  [ADR-0038](../adr/ADR-0038-track-identity-across-gaps.md),
  [ADR-0039](../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md)

---

## ⚠️ The finding that should change the plan

The brief asks to **"build a generic event/rule engine that consumes Tracking events"**.

**A rule engine already exists, it is frozen, and it already consumes exactly the right input.**

`services/rules` was built in P-4 and carries: rule lifecycle (`draft → enabled → disabled`),
monotonic versioning with an immutable version history, a condition evaluator, windowed thresholds,
priority ordering with a deterministic tie-break, scope resolution to leaf nodes, a compiled-rule
cache, dry-run, an explain trace naming the stage that decided, a per-tenant evaluation budget,
rule fingerprinting, an audit trail, and incident-candidate generation. Its engine takes an
**`EventEnvelope` and never a `DetectionResult`** — a boundary asserted in its own header since P1-7.

Building a second engine would:

- create a **duplicate source of truth** for what a rule is, which the standing constraints forbid;
- require an ADR to break a frozen foundation, for a capability that foundation already provides;
- and discard rule versioning, audit and explain — the three things that make rule output usable as
  evidence, and the three things a new engine would take longest to earn back.

### So what is actually missing?

The producer. Nothing on the live path turns a `Track` into an `EventEnvelope`.

```
FRAME PATH TODAY                                    RULE PATH TODAY
────────────────────────────────────────────────    ─────────────────────────────────────
camera → media → POST /infer                        EventEnvelope → rules → RuleEngine
                    ↓                                     ↑              ↓
              Detections                                  │        IncidentCandidate
                    ↓                                     │              ↓
              RuntimeTracker  ✅ P-8 Phase 4              │        workflow / notify
                    ↓                                     │
              Tracks (identity, motion, dwell)            │
                    ↓                                     │
              ┌──────────────────────┐                    │
              │ EventPublisher stage │ ⚠️ **NO-OP**  ─────┘  ← THE GAP
              └──────────────────────┘       nothing is published
```

⚠️ **This is precisely the shape Phase 4 found and fixed.** Tracking already worked for _batch_
analysis and had nowhere to live on the live path. Zone geometry and spatial events are the same:
`ai/inference/zones.py` and `events.py` already build `spatial.zone.entered|exited` and
`analytics.occupancy.changed` for `VideoAnalyzer`, and the live pipeline's `EventPublisher` is
documented as _"No-op in P1-6; wired to NATS in P1-5"_ and was never wired.

### The event vocabulary is already frozen too

Every event type the six requested rules need is already in the catalogue:

| Requested rule            | Event type it needs                                  | Exists? |
| ------------------------- | ---------------------------------------------------- | ------- |
| Loitering                 | `temporal.dwell.exceeded`                            | ✅      |
| Restricted-area intrusion | `spatial.zone.entered`                               | ✅      |
| Line crossing             | `spatial.line.crossed`                               | ✅      |
| Occupancy                 | `analytics.occupancy.changed`                        | ✅      |
| Queue monitoring          | `analytics.queue.length`                             | ✅      |
| Dwell time                | `temporal.dwell.exceeded` + `tracking.track.updated` | ✅      |

**So Phase 5 is not a rule engine. It is the bridge that makes the rule engine reachable from a
camera** — and the six rules then become _configuration_ of a frozen engine rather than code.

That reframing is the single most important thing in this document, and it is why it is submitted for
approval before any code is written.

---

## 1 · What Phase 5 actually builds

Four components, in dependency order. Each is independently verifiable and independently shippable.

### 1.1 Zone Store — geometry, per camera, persisted

**Why first:** four of the six rules are meaningless without a region. There is a frozen `Zone`
contract (pure geometry: `area` polygon or `line` polyline, normalized coordinates, `attributes` for
meaning) and **nothing persists one**.

| Decision    | Choice                                             | Why                                                                                                                                                                                                     |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner       | **camera service**                                 | A zone is a property of a camera's field of view. Putting it in rules would make geometry a rule concept and break reuse by analytics                                                                   |
| Coordinates | **normalized [0,1]**, as the contract already says | Resolution-independent; survives a stream profile change. ⚠️ Pixel coordinates would silently break every rule the day a camera is reconfigured                                                         |
| Meaning     | **`attributes` only** — no `RestrictedZone` type   | A `CashCounterZone` type puts retail semantics in a contract every vertical shares. Meaning is assigned by the rule that references the zone                                                            |
| Versioning  | **immutable versions, like rules**                 | ⚠️ An incident says "entered the restricted area". If the polygon is mutable, an investigator six months later cannot reconstruct what the boundary _was_. The incident must reference `zoneId@version` |

⚠️ **This is a new persisted store on a frozen foundation and therefore needs an ADR** (Camera
Foundation is frozen; new write paths into a frozen foundation are a breaking-class change under the
uniform freeze rule). The ADR is part of Phase 5's deliverables, not an afterthought.

### 1.2 Spatial/Temporal Evaluator — `Track` → domain events

A **pure, stateless-per-call** component in the AI runtime, sitting exactly where `EventPublisher`
is a no-op today. It receives the tracks the `RuntimeTracker` produced for a frame plus that
camera's zones, and emits domain events.

```
RuntimeTracker.run() → tracks ──→ SpatialEvaluator(tracks, zones) ──→ [DomainEvent]
                                          │
                                  bounded per-track state:
                                  which zones was it in last frame?
                                  which side of each line?
                                  when did it stop moving?
```

⚠️ **It answers geometry, never meaning.** `spatial.zone.entered` says a centroid crossed a polygon
boundary. Whether that is an _intrusion_ depends on the zone's attributes, the time of day and the
tenant's rules — and all three of those are the rule engine's business. The same discipline that kept
`dwellSeconds` out of "loitering" in Phase 4 applies here without exception.

**Design decisions to review:**

| Question                                       | Proposal                                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Which point tests containment?                 | **Bottom-centre of the bbox**, not the centroid — it approximates where the person's feet are, and a centroid enters a floor zone when the head does                                                               |
| How is a boundary crossing debounced?          | ⚠️ **A track must be inside for `min_frames` before `entered` fires.** At 2 fps a jittering box on a boundary would otherwise emit dozens of enter/exit pairs, each one a rule evaluation and possibly an incident |
| Line-crossing direction                        | Signed side-of-line, with the crossing direction on the event. Direction is the difference between "entered the store" and "left the store"                                                                        |
| What if a track is `lost` while inside a zone? | ⚠️ **No exit event.** The object did not leave; the platform stopped seeing it. Emitting `exited` would make occlusion look like departure and end a dwell timer that should keep running                          |
| Occupancy                                      | Derived from confirmed tracks per zone per frame, emitted **on change only**                                                                                                                                       |

### 1.3 Event transport — the runtime's first publish

Today the runtime publishes nothing. Two candidate designs; **B is proposed**:

|                     | **A · runtime → NATS directly**                                  | **B · runtime returns events in the `/infer` response; media publishes**             |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Perception boundary | ⚠️ Runtime gains a broker client and a second network dependency | ✅ Unchanged — media stays the only consumer of the runtime                          |
| Failure mode        | A broker outage stalls or blocks inference                       | Events are dropped with the frame; inference is unaffected                           |
| Ordering            | Two paths, two orderings                                         | One path, one ordering                                                               |
| Tenant context      | Runtime would need broker credentials per tenant                 | Media already holds the tenant and the publish path                                  |
| Cost                | —                                                                | Response payload grows; media does one more publish per frame that produced an event |

⚠️ **B keeps the P-8 Phase 1 property intact**: the runtime is not on the gateway, has no host port,
and media is the only thing that talks to it. A is a smaller diff and a larger architectural change.

⚠️ **Back-pressure must be designed, not discovered.** At 2 fps × 16 cameras a zone with constant
traffic could produce a steady event stream. The proposal: events are **coalesced per track per
frame**, `occupancy.changed` fires only on change, and media applies the same drop-and-count
discipline it already uses for frames — with a counter, because a silently dropped event that should
have been an incident is the worst failure this design can have.

### 1.4 Rule wiring — configuration, not code

The existing engine consumes `EventEnvelope` from NATS. Once events flow, the six rules are rule
_documents_:

| Rule                 | Event                         | Condition                            | Window             |
| -------------------- | ----------------------------- | ------------------------------------ | ------------------ |
| Restricted intrusion | `spatial.zone.entered`        | `zone.attributes.restricted == true` | —                  |
| Line crossing        | `spatial.line.crossed`        | `direction == 'inbound'`             | —                  |
| Loitering            | `temporal.dwell.exceeded`     | `dwellSeconds > threshold` in a zone | —                  |
| Dwell time           | `temporal.dwell.exceeded`     | tenant threshold                     | —                  |
| Occupancy            | `analytics.occupancy.changed` | `count > limit`                      | —                  |
| Queue monitoring     | `analytics.queue.length`      | `length > limit` sustained           | ✅ existing window |

⚠️ **If a rule cannot be expressed in the frozen condition language, that is a finding to report —
not a licence to add a bespoke evaluator.** The right response is an additive extension to
`RuleCondition` with an ADR, so every vertical gets it.

---

## 2 · The verticals, without a redesign

The brief requires retail, warehouse, hospital, school, factory and parking to fit. They fit because
**no vertical noun appears anywhere in the design**:

- a zone is a polygon with attributes, not a `CashCounterZone`;
- an event says a boundary was crossed, not that a theft occurred;
- a rule is a document, so a vertical is a **pack of rule documents plus zone attribute
  conventions** — data, not code.

| Vertical  | Same primitives, different configuration                                         |
| --------- | -------------------------------------------------------------------------------- |
| Retail    | queue zones at tills, dwell at high-value shelves, line crossing at the entrance |
| Warehouse | restricted zones around machinery, occupancy limits in racking aisles            |
| Hospital  | dwell in corridors, restricted zones at drug storage, occupancy in waiting areas |
| School    | line crossing at gates outside hours, occupancy limits in halls                  |
| Factory   | restricted zones around presses, PPE checks _(needs a model — out of scope)_     |
| Parking   | dwell in bays, line crossing at barriers, occupancy per level                    |

⚠️ **One honest limit:** some vertical asks need _capabilities_, not rules. PPE detection, fall
detection and weapon detection each need a model this platform does not run. A rule pack must not
imply them. Phase 5 should ship a written statement of what each pack can and cannot do, in the same
register as the tracking limitations.

---

## 3 · Rule lifecycle, versioning, replay, debugging

Mostly **already built and frozen** — restated so the review can confirm nothing new is needed:

| Requirement      | Status                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule lifecycle   | ✅ built — `draft → enabled → disabled`, only `enabled` evaluates                                                                                                                                         |
| Rule versioning  | ✅ built — monotonic `version`, immutable version history, fingerprinting                                                                                                                                 |
| Rule scheduler   | ⚠️ **partly**: priority ordering and a per-tenant budget exist; _time-of-day_ scheduling ("restricted after 18:00") needs review — a condition on the envelope timestamp may be enough, and would be free |
| Rule debugging   | ✅ built — dry-run and an explain trace naming the deciding stage                                                                                                                                         |
| Evidence         | ✅ built — Evidence Foundation is frozen; the incident references it                                                                                                                                      |
| Incidents        | ✅ built — `IncidentCandidate`, audit trail, immutable history                                                                                                                                            |
| **Rule replay**  | ❌ **new** — see below                                                                                                                                                                                    |
| **Rule metrics** | ⚠️ partly — `rule-stats.ts` exists; the metrics ADR-0039 requires do not                                                                                                                                  |

### Rule replay — the one genuinely new mechanism

Phase 4 built `track_replay.py`: the tracker's whole input is (frame context, detections), so
recording that pair reproduces a run exactly. **The same argument extends one layer up.** The rule
engine's whole input is a stream of `EventEnvelope`s, so recording that stream lets a rule change be
tested against a real day without a camera.

⚠️ **This makes "why did this rule fire?" answerable retrospectively**, which is the question a
customer asks after a false positive — and it is not answerable today.

⚠️ **A rule replay holds tenant data** — zone names, camera ids, timestamps of real movements. Same
discipline as tracking replay: off by default, never enabled by an ordinary deployment path, and
never written outside a path an operator named.

### Rule metrics — ADR-0039 applies before the first line is written

| Metric                             | Measurable live?                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `rules.evaluated`, `rules.matched` | ✅ counts                                                                         |
| `rules.evaluation_ms` p50/p95      | ✅ timings                                                                        |
| `rules.candidates_generated`       | ✅ counts                                                                         |
| `rules.suppressed` (dedup/window)  | ✅ counts                                                                         |
| `rules.budget_exhausted`           | ✅ counts                                                                         |
| **`rules.false_positive_rate`**    | ❌ **needs ground truth — report unavailable**                                    |
| **`rules.precision` / `recall`**   | ❌ **needs ground truth — report unavailable**                                    |
| **`rules.missed_incidents`**       | ❌ **unmeasurable by definition** — the platform cannot count what it did not see |

⚠️ **Stated now, before implementation, because this is exactly where the pressure to invent a number
will be strongest.** "How accurate are your rules?" is the first question a customer asks. The
answer is measured against authored scenarios or an operator-acknowledgement loop that does not
exist yet — never estimated from evaluation counts. ADR-0039 governs this without amendment.

⚠️ **`rules.missed_incidents` deserves its own note.** It is not merely hard: a false _negative_ is
an event that was never generated, so no amount of instrumentation inside the platform can see it.
Only an external observer — an operator reviewing footage — can. Any product surface implying
otherwise would be a fabrication.

---

## 4 · Phased delivery, with the Definition of Done applied to each

Per the standing engineering principle, **every phase below ships all eight**: runtime, metrics,
browser visibility, deployment verification, mutation tests, nightly automation, benchmark evidence
and governance.

| Phase   | Deliverable                               | New nightly stages                               |
| ------- | ----------------------------------------- | ------------------------------------------------ |
| **5.1** | Zone Store + zone editor (camera service) | `rules/zones.sh`, `rules/zones-browser.sh`       |
| **5.2** | Spatial/Temporal Evaluator                | `rules/spatial.sh`, `rules/spatial-mutations.sh` |
| **5.3** | Event transport (runtime → media → NATS)  | `rules/events-deployment.sh`                     |
| **5.4** | Rule wiring + operator workflow           | `rules/engine.sh`, `rules/engine-browser.sh`     |
| **5.5** | Rule replay + rule metrics + benchmark    | `rules/replay.sh`, `rules/benchmark.sh`          |

The `rules/` folder is **already named** in `scripts/nightly/stages/README.md`, so no framework
change is needed — which was the point of naming it before anything filled it.

### Verification, designed before the code

⚠️ **The authored-fixture argument carries forward, and it gets stronger here.** "Did the rule fire
correctly?" is unanswerable on real footage for the same reason "was this the same person?" was. So:

- authored clips with a **written-down zone** and a **written-down expected verdict**;
- a person walking into a restricted zone → exactly **one** incident candidate, not zero and not
  fourteen (⚠️ the fourteen case is the real risk: a boundary-jittering track without debouncing);
- a person walking _along_ a boundary → **zero**;
- a track lost inside a zone → **no exit event**, and the dwell timer keeps running;
- a rule disabled mid-stream → evaluation stops **at the next event**, provably.

### Benchmark, and what it must measure

| Measure                              | Why                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Rule evaluations/sec at 1→16 cameras | The ladder shape Phase 4 established                                                                                                       |
| Evaluation latency p50/p95           | An incident that arrives late is a report, not an alert                                                                                    |
| Events/sec produced per camera       | ⚠️ The number that decides whether transport design B holds                                                                                |
| Incident candidates/sec              | Feeds workflow and notify — a downstream capacity question                                                                                 |
| Rules × cameras scaling              | ⚠️ **Is it multiplicative?** 50 rules × 16 cameras is the case that matters, and the compiled-rule cache is what should stop it being 800× |

⚠️ **Sizing must be re-measured, not inherited.** The published 2 cameras/host assumes perception
only. Rules add work to the same host, and the honest expectation is that the number **falls**.
Publishing the old figure after adding a subsystem would be the exact failure the three-agreeing-runs
policy was written to prevent.

---

## 5 · Risks, stated before they are discovered

| Risk                                                                                                                                                                                                                                                                                                  | Severity |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| ⚠️ **Boundary jitter produces an incident storm.** A track flickering on a zone edge at 2 fps generates enter/exit pairs indefinitely. Debouncing is a _correctness_ requirement, not a refinement                                                                                                    | **high** |
| ⚠️ **Identity fragmentation becomes visible to the customer.** L-42: at 16 cameras one person can become several identities. A dwell rule then sees three 20-second visits instead of one 60-second one and **never fires**. A rule engine consuming tracks inherits every tracking limitation        | **high** |
| ⚠️ **Normalized coordinates are not ground coordinates.** A zone drawn on a 2D image is a region of the _picture_. A person far away occupies few pixels and their feet may fall outside a zone their body overlaps. This is L-44 arriving in a place where it changes a verdict rather than a number | med      |
| ⚠️ **Tracking state does not survive a restart** (TD-67). A deploy mid-shift resets every dwell timer. Acceptable for tracking, questionable once a dwell timer decides whether an incident exists                                                                                                    | med      |
| Rule evaluation cost is multiplicative in rules × cameras                                                                                                                                                                                                                                             | med      |
| ⚠️ **AI must remain advisory.** A rule may create a _candidate_; it must never mutate an incident, evidence or another rule. The frozen foundations already enforce this — it is listed so it is checked, not assumed                                                                                 | med      |

---

## 6 · What this phase will NOT do

Stated so the boundary is agreed before implementation rather than defended during review:

- ❌ **No new rule engine.** The frozen one is used.
- ❌ **No cross-camera rules.** L-43: identity does not cross cameras. A rule spanning two cameras
  would be built on an association the platform cannot make.
- ❌ **No accuracy claims.** No precision, recall or false-positive rate from live data (ADR-0039).
- ❌ **No PPE, fall, weapon or face rules.** Each needs a model that does not exist here.
- ❌ **No automatic action.** A rule produces a _candidate_; a human decides. Workflow and notify are
  already built for this and their contracts are frozen.
- ❌ **No real-footage validation.** L-1 stands until P-9.

---

## 7 · Questions for the Architect

These change the design, so they are asked **before** the code:

1. **Does the reframing hold?** Phase 5 as _"the bridge to the frozen rule engine"_ rather than _"a
   new rule engine"_. Everything below depends on this answer.
2. **Zone Store in the camera service** — is a new persisted store on a frozen foundation acceptable
   with an ADR, or should zones live elsewhere?
3. **Event transport A or B?** B preserves the perception boundary at the cost of a larger `/infer`
   response. A is a smaller change to a bigger property.
4. **Time-of-day scheduling** — extend `RuleCondition` additively, or is a condition on the envelope
   timestamp sufficient? (The second is free.)
5. **Is fragmentation-under-load a blocker for dwell rules?** L-42 means a dwell rule can silently
   fail to fire at high camera counts. Options: cap dwell rules to the supported camera count,
   aggregate by `identityId` rather than `trackId`, or accept and disclose. ⚠️ **This is the one that
   most affects what can be sold.**
6. **Phased 5.1→5.5, or one delivery?** Phased means five review packages; one delivery means the
   first working end-to-end demonstration is much later.

---

**No implementation code has been written. Awaiting approval.**
