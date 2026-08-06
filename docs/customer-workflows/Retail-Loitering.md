# Retail Loitering

**The first complete customer capability built on the Vision Intelligence Platform.**
Status: **production-verified, pending milestone freeze** (P-8 Phase 7).
Architecture of record: [ADR-0044](../adr/ADR-0044-one-word-two-zones.md),
[ADR-0041](../adr/ADR-0041-identity-travels-with-the-subject.md),
[ADR-0045](../adr/ADR-0045-the-incident-lifecycle-is-frozen.md).

> This document describes what the platform **does**, measured on a running deployment. Where a number
> appears it was measured; where something is not known, it says so. Nothing here is a projection.

---

## 1 · The business problem

A person standing still in one part of a shop for long enough is worth a human look. What "long
enough" and "one part of the shop" mean is different for every customer, every camera and every hour
of the day — and it is not a question a detection model can answer, because a model reports _what_ it
sees in a frame, never _how long_ it has been there.

Three things follow, and they are the whole design:

1. **Loitering is a duration, not a detection.** No amount of model accuracy produces it. It requires
   the platform to remember one person across many frames and measure elapsed time.
2. **The area matters as much as the duration.** Sixty seconds at a checkout queue is a queue.
   Sixty seconds beside a locked cabinet is something else. The same camera contains both.
3. **The customer must be able to change it without a release.** A rule that requires an engineer is
   a rule that is never tuned, and an untuned rule is switched off within a fortnight.

What a customer gets is a **rule they configure themselves** — an area, a duration and a schedule —
and an **incident an operator can act on**, carrying the evidence for why it exists.

⚠️ **What this is not.** It is not theft detection, intent detection, or a judgement about a person.
It reports a measurable fact — _this person was in this area for this long_ — and hands it to a human.
Every downstream decision is the human's.

---

## 2 · The business flow

```
   Camera  ─▶  Assignment  ─▶  Tracking  ─▶  Identity  ─▶  Events  ─▶  Rule  ─▶  Candidate
                                                                                    │
                                                            Operator  ◀── Incident ─┘
                                                                │
                                                          Evidence · Audit
```

Every hop below already existed before this capability. **Two things were added**: a zone, and a
clock.

### 2.1 Camera

An operator registers a camera against a place in the location hierarchy (site → building → floor →
area). The camera has a stream URL, a protocol and a schedule. Nothing about loitering is configured
here.

⚠️ A registered camera is **not** an analysed camera. Registration is a record; analysis is an
assignment, and the difference is what keeps the estate's camera count separate from its compute
bill.

### 2.2 Assignment

The Assignment Engine decides **which cameras are analysed by which runtime**, within a declared
capacity. A camera that is recorded but not assigned produces no detections and costs no inference.

⚠️ **This is where a customer's money is.** The platform will refuse to assign beyond declared
capacity rather than accept everything and degrade everything — a runtime silently dropping frames
under load is an alerting system that fails exactly when the shop is busy.

Zones ride to the enforcement point **on the assignment plan**: the same five-second poll that tells
media which cameras to analyse also tells it which polygons to test. No new integration, no new
failure mode ([ADR-0043](../adr/ADR-0043-assignment-is-a-control-plane-with-a-measured-data-plane.md),
ADR-0044).

### 2.3 Tracking

Per-frame detections are linked into **tracks** — "the same box, moving". A track is short-lived by
nature: it ends when the subject is occluded by a shelf, leaves the frame, or the detector misses a
few frames.

⚠️ **A dwell rule must never accumulate on a track.** Someone standing behind a pillar for two seconds
would restart their timer, and a loitering rule built on tracks reports the length of the camera's
attention span rather than the length of the visit.

### 2.4 Identity

Identity links tracks that belong to the same subject across gaps
([ADR-0038](../adr/ADR-0038-track-identity-across-gaps.md),
[ADR-0041](../adr/ADR-0041-identity-travels-with-the-subject.md)). A person occluded and re-detected
carries the same `identityId` and their visit continues.

⚠️ **`identityId` is a within-deployment continuity key, not a person.** It is not a face, not a name,
and it does not survive across cameras that never saw the subject at the same time. It answers "is
this the same one I was watching?" and nothing else.

⚠️ **An event carrying no identity is skipped, never pooled.** Bucketing anonymous detections under a
placeholder produces a phantom subject who is always present and crosses every threshold. The Live
Rule Status page reports `dwellWithoutIdentity`; a non-zero value means identity is not reaching the
engine, and the rule is under-firing rather than mis-firing.

### 2.5 Zones

An operator draws a **named area on the camera's picture** — polygon or rectangle, in normalised
`[0,1]` coordinates, so it survives a resolution change. Up to 32 zones per camera, 64 points each.

- Zones are **reusable assets**: many rules may watch one zone.
- Zones are **versioned**. Editing one creates an immutable snapshot, so an incident from March
  resolves March's geometry rather than today's.
- Editing a zone is **not** a reassignment: the version counter is separate from the session epoch, so
  dragging a vertex does not throw away everybody's accumulated dwell.

⚠️ **"Inside the zone" means the subject's feet, in the picture.** Membership is a point-in-polygon
test on the **bottom centre of the bounding box** — the floor contact point. A standing person's box
is about twice as tall as it is wide, so testing its centre would put them in the zone as their
shoulders crossed the line, while the operator who drew it on the floor meant their feet.

⚠️ **A zone drawn on a picture is not a zone drawn on a floor.** There is no camera calibration and no
perspective correction. On a camera looking along a room, a polygon over the far half covers far more
physical floor than one over the near half. See [L-58](../project/KNOWN_LIMITATIONS.md).

### 2.6 Events

A detection inside a zone becomes an `EventEnvelope` stamped with that zone. **One detection produces
one event per zone it occupies** — "in the queue" and "in the aisle" are two facts, and a rule
watching the queue must see the first without the second.

A subject in **no** zone still produces its event, unchanged. Suppressing those would make drawing a
zone a switch that silently disabled every camera-wide rule on that camera.

⚠️ **The platform observes a continuously present subject about once every ten seconds**, whatever the
frame rate. The events service collapses repeated detections of one subject into one event per dedup
bucket (`EVENTS_DEDUP_WINDOW_MS`, 10 s). This is the single most important number in this document for
anyone configuring a rule — see §5.

### 2.7 The rule

Loitering is **configuration, not code**. The word does not appear in the rule engine. A loitering
rule is:

| Setting                | Meaning                                                                  | Default  |
| ---------------------- | ------------------------------------------------------------------------ | -------- |
| **Enabled / Disabled** | whether the engine evaluates it at all                                   | —        |
| **Scope**              | tenant, camera, camera group, hierarchy location, and/or detection zones | tenant   |
| **Minimum dwell**      | seconds a subject must be present before it fires                        | 60 s     |
| **Group by**           | `identity` (recommended) or `track`                                      | identity |
| **Reset after**        | gap after which a new visit begins                                       | 30 s     |
| **Cool-down**          | quiet period after firing, per subject                                   | 300 s    |
| **Priority**           | evaluation order among the tenant's rules                                | —        |
| **Dry run**            | evaluate fully, publish nothing                                          | off      |
| **Schedule**           | when the rule is live                                                    | always   |

⚠️ **Detection-zone scope narrows.** When a rule names any zone, an event outside every named zone is
outside the rule _even on a camera the rule also names_. Checking the camera first would make the zone
scope decorative.

⚠️ **Dry run is the safe way to tune.** Everything runs — the clock advances, the threshold is
crossed, the candidate is built in full — and nothing is published. What a dry run shows is exactly
what a live rule would have produced, because it is built by the same code path. This is how a
customer discovers their 30-second threshold would have fired 400 times a day _before_ it does.

### 2.8 The dwell clock

A **new stateful stage** in the rule engine, after scope and condition. It measures **elapsed time
between the first and most recent observation of one subject in one zone**.

⚠️ **Elapsed time, not event count.** "120 events in 60 seconds" is a statement about the deployment's
frame rate, not about the customer's policy, and it breaks the moment a camera is throttled. Every
timestamp the engine uses comes from the **event**, never from the node's clock — which is what makes
a replayed backlog contribute the duration it actually represents.

### 2.9 The incident candidate

When the threshold is crossed, the engine builds a candidate carrying:

| Field                 | What it is                                                               |
| --------------------- | ------------------------------------------------------------------------ |
| Camera, Zone, Rule    | where, which area, which rule and **which version** of it                |
| Identity              | the subject the visit was filed under                                    |
| Duration              | observed seconds, against the configured threshold                       |
| Entry / last seen     | first and most recent observation                                        |
| **Exit**              | ⚠️ `null` — see below                                                    |
| Observations          | how many times the subject was actually seen                             |
| Track fragments       | how many tracks the visit was assembled from                             |
| Longest / typical gap | the honesty pair — see §5                                                |
| Confidence            | mean detection confidence, or `null` if unmeasurable                     |
| Explanation           | **structured**, not prose — the summary is rendered from the fields      |
| Timeline              | the ordered story: entered · observed · gap · threshold crossed · raised |
| Evidence              | **references** to footage and events — never copied bytes                |

⚠️ **`exitAt` is `null` on almost every candidate, and that is correct.** A candidate is raised
_during_ a loiter, so at the moment of raising nobody has left. Setting it to "last seen" would read
as _"they left at 14:32"_ when the truth is _"we last saw them at 14:32 and they may still be
there"_ — a fabricated fact on an evidence record.

⚠️ **The explanation is structured evidence, not text.** Every surface renders the same fields, so a
console, an export and an API consumer cannot disagree about why an incident exists.

### 2.10 The operator

Five surfaces, all reading deployment truth:

1. **Rule Management** — create, tune, enable, disable, dry-run, version, roll back.
2. **Zone Editor** — draw and name areas on a live frame; version history per zone.
3. **Incident Candidate List** — what fired, for whom, for how long, where.
4. **Incident Detail** — the timeline, the explanation, the evidence references.
5. **Live Rule Status** — which rules are loaded, which clocks are running right now, and the counters
   that say whether the engine is healthy.

⚠️ **Live Rule Status shows dwell timers in progress**, before anything fires. An operator can see a
person's clock at 40 of 60 seconds. That is the difference between an alerting system and a reporting
system.

### 2.11 Evidence

An incident **references** evidence; it never copies it.

- A **recording interval** — this camera, from entry minus 10 s to last-seen plus 10 s.
- **Event references** — the specific envelopes that made up the visit.
- Locators are **platform-relative paths**: no host, no scheme, no token. They stay valid across
  deployments and cannot become a credential leak inside an incident record.

⚠️ **The rule engine never touches media.** An engine that fetched a clip while deciding would put a
storage round trip on the per-event path and make an alert depend on a disk. It says _which camera
over which interval_, which it knows for free; turning that into a clip is the Evidence context's job,
on demand, when a person asks.

### 2.12 Audit

- Every rule change is a **version** with an author and a timestamp; earlier versions are restorable.
- Every zone edit is an **immutable snapshot**.
- The candidate carries the **rule version** that fired it, so an incident is explicable even after the
  rule has been retuned.
- Every incident lifecycle transition is recorded with actor, time and note; a closed incident is
  **sealed** — nothing may be appended (ADR-0045).
- A replayed window produces a **byte-identical** candidate, dedup key included, so an audit that
  re-runs the evidence gets the same answer. Verified nightly (`events/rule-replay`).

---

## 3 · Expected operator actions

| Situation                              | Action                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A candidate appears                    | Open the detail. Read **duration**, **observations** and the **gap pair** before looking at footage           |
| Duration looks right, gaps are regular | Treat the duration as sound; review the evidence interval                                                     |
| ⚠️ **Longest gap ≫ typical gap**       | The visit spans a hole the platform did not see. Treat the duration as an **upper bound** and check footage   |
| ⚠️ **Track fragments > 1**             | The duration spans a link the platform _inferred_. It may be two people                                       |
| Confidence is `null`                   | No observation carried one. Not "zero confidence" — unmeasured                                                |
| It was a real loiter                   | Acknowledge → investigate → resolve, with a note                                                              |
| It was nothing                         | Resolve with a note saying why. ⚠️ Today this is indistinguishable from a real one in the statistics — see §6 |
| The same false positive keeps arriving | Tune the **rule**, not the queue: raise the threshold, shrink the zone, or add a schedule                     |
| Before changing a live rule            | Clone it to **dry run** and watch for a day. The dry-run report is what the live rule would have produced     |

---

## 4 · Measured performance

Measured on the reference host, 1 → 16 cameras, from the platform's own instruments (never from the
test harness's clock):

| Measurement                            | 1 camera       | 16 cameras     | What it isolates                   |
| -------------------------------------- | -------------- | -------------- | ---------------------------------- |
| **Event → rule** (transport)           | 66.0 ms        | 847.8 ms       | media, broker, events service      |
| **Rule → candidate** (evaluation)      | 4.4 ms         | 7.6 ms         | the rule set itself                |
| **End to end** (frame capture → raise) | 69.3 ms        | 865.6 ms       | everything                         |
| Zone geometry, per frame               | 10.6 µs        | 6.3 µs         | point-in-polygon on the frame path |
| Media CPU                              | 3.8 %          | 48.3 %         | —                                  |
| Rules CPU / memory                     | 0.8 % / 105 MB | 1.3 % / 114 MB | —                                  |

⚠️ **The rule engine is never the bottleneck.** Evaluation rises 1.7× while transport rises 13×.
Separating the three latencies is what makes that visible: one end-to-end number rising tells an
operator to look somewhere; these three tell them where.

⚠️ **Zone geometry is effectively free** and does not degrade with camera count.

**Sizing: 2 cameras supported, 4 provisional.** Unchanged by this milestone, and no new figure is
published from one run — the standing policy requires three independent agreeing runs.

---

## 5 · Configuring a rule that works

The single most important constraint:

> ⚠️ **The platform observes a continuously present subject about once every ten seconds**, regardless
> of frame rate ([L-57](../project/KNOWN_LIMITATIONS.md)).

| Setting           | Guidance                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Minimum dwell** | ⚠️ **Below ~20 s you are measuring the platform's sampling as much as the customer's policy.** 60 s is clean                                                                                                                              |
| **Reset after**   | ⚠️ Must exceed the ~10 s observation interval — **not** the frame interval. Below it, the visit restarts on almost every observation and the rule never fires while reporting healthy. Validation enforces the floor and names the reason |
| **Cool-down**     | Without one, a rule past its threshold raises on **every subsequent observation**. 300 s means one visit is one incident                                                                                                                  |
| **Group by**      | `identity`. `track` is offered for diagnosis and will under-report every occlusion                                                                                                                                                        |
| **Zone size**     | Remember §2.5: a polygon over the far half of the image covers far more floor than one over the near half                                                                                                                                 |

**Reading the two gap fields together.** `longestGapSeconds` alone is meaningless: on a healthy
deployment it reads ≈ 10 s on _every_ incident, because that is the sampling interval. It travels with
`typicalGapSeconds` (the median), and the platform exposes one shared predicate, `gapIsUnusual`, so no
two surfaces can disagree about whether a gap is real. **Longest ≈ typical is regular sampling.
Longest ≫ typical is a hole.**

---

## 6 · Limitations

Each links to its full entry in [KNOWN_LIMITATIONS](../project/KNOWN_LIMITATIONS.md).

| #        | Limitation                                                                                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L-57** | ⚠️ Dwell resolution is bounded below by the **event dedup window (~10 s)**, not by the frame rate. Thresholds under ~20 s partly measure the platform                                                                                              |
| **L-58** | ⚠️ "Inside the zone" is the subject's **feet in image coordinates**. No calibration, no ground plane, no perspective correction. **Never measured against a physical camera**                                                                      |
| **L-59** | ⚠️ Dwell state is **in memory**. A rules-service restart forgets visits in progress; they must re-accumulate the full threshold. Cool-downs are forgotten too                                                                                      |
| **L-56** | ✅ Closed. Camera-scoped rules could not be enabled in _any_ deployment before this milestone — nothing had ever wired a camera directory into the rules service                                                                                   |
| —        | ⚠️ **Group and zone scope are snapshotted at validation.** A camera added to a group afterwards is not covered until the rule is re-validated. Visible (`resolvedAt`), not silent                                                                  |
| —        | ⚠️ **Event volume grows where zones overlap**, and only there. One zone per camera costs nothing extra                                                                                                                                             |
| —        | ⚠️ **A dismissal is not distinguishable from a resolution.** A false positive must be `resolved` today, so resolution counts mix "handled" with "wasn't real". The `dismissed` state is declared and unreachable (ADR-0045); nothing counts it yet |
| —        | ⚠️ **No cross-camera identity.** A subject who walks from one camera to another is two subjects. Dwell does not span cameras                                                                                                                       |
| —        | ⚠️ **No re-identification, no appearance matching, no demographics.** The platform does not know who anyone is                                                                                                                                     |

---

## 7 · How this was verified

| Verification           | What it proves                                                                                                                                             | Where                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| End-to-end deployment  | camera → assignment → tracking → identity → zone → events → rule → candidate → browser, on a real deployment                                               | `loitering/loitering.sh`      |
| ⚠️ Negative controls   | a camera with **no zone** never stamps one; a **dry-run twin** raises nothing while its clock advances                                                     | same run, same moment         |
| Mutation suite         | eight deliberate breaks; **7 of 8 go red at the check that names the fault**                                                                               | `loitering/rule-mutations.sh` |
| Browser verification   | 36/36 — the operator surfaces render deployment truth, in a real browser                                                                                   | `loitering/rule-browser.sh`   |
| Capacity ladder        | 1 → 16 cameras, three latencies separated                                                                                                                  | `loitering/rule-benchmark.sh` |
| **Replay determinism** | the same persisted events produce a **byte-identical** candidate — dedup key, explanation, timeline and evidence included — across a rules-service restart | `events/rule-replay.sh`       |

⚠️ **What a mutation suite is for.** Not "does the verification fail when something breaks", but "does
it fail at the check that _names_ what broke". A suite that goes red in the wrong place has caught a
problem while being unable to say which, and whoever fixes it at 2 a.m. learns nothing.

---

## 8 · Future automation

Deliberately **not** built, and none of it requires an architectural change:

| Capability                     | What it needs                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incident lifecycle actions     | `dismissed` and `archived` are **declared and unreachable** (ADR-0045). The states exist; the actions do not                                                                    |
| Rule approval workflow         | `Draft` / `Published` and version history exist; an approval step does not                                                                                                      |
| Rule replay simulation         | replay is verified deterministic, so a "what would this rule have done last Tuesday" simulator has a sound foundation. The extension points are in place; no simulator is built |
| Durable dwell state            | the `DwellStateStore` port is unchanged; a Redis-backed adapter closes L-59                                                                                                     |
| Cross-camera identity          | ⚠️ a genuine research problem, not a wiring exercise. Nothing in this milestone assumes it                                                                                      |
| Schedule-aware thresholds      | different dwell limits by hour of day — configuration, not code                                                                                                                 |
| Automatic notification routing | the Notification context consumes `Incident`, never candidates. Already wired                                                                                                   |

---

## 9 · Why this generalises

The engine contains no business vocabulary. `FUTURE_WORKFLOW_COVERAGE` in the contracts package
records, per workflow, which primitive expresses it and — where one is missing — exactly what is
missing:

| Workflow                    | Expressed by                             | Missing                                  |
| --------------------------- | ---------------------------------------- | ---------------------------------------- |
| **Retail loitering**        | zone scope + dwell                       | — **shipped**                            |
| Intrusion / restricted area | zone scope + dwell (or immediate)        | — nothing                                |
| Queue monitoring            | zone scope + dwell, grouped              | — nothing                                |
| Abandoned object            | zone scope + dwell on a non-person class | — nothing                                |
| Occupancy                   | zone scope + count over subjects         | a **count** aggregation                  |
| Line crossing               | —                                        | a **line** geometry and a crossing test  |
| PPE                         | —                                        | an **attribute** the model does not emit |
| Theft                       | —                                        | composition across several signals       |

⚠️ **The last four are honest gaps, not roadmap items dressed as capabilities.** The geometry layer
already declares `line`, `path` and `direction` shapes as _non-evaluable_, so a rule cannot silently
be authored against a shape nothing tests.

See [VERTICALS.md](./VERTICALS.md) for how the same pipeline maps onto retail, hospital,
manufacturing, warehouse, education and traffic.
