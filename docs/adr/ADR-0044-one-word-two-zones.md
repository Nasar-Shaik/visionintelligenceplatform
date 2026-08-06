# ADR-0044 — One word, two zones: detection zones are not places

- **Status:** Accepted
- **Date:** 2026-08-06
- **Milestone:** P-8 Phase 7 — Retail Loitering (the first complete customer workflow)
- **Supersedes:** nothing. **Related:** ADR-0026 (validation-time cross-context reads),
  ADR-0038 (re-entry is a link), ADR-0039 (absent metrics are unavailable, never zero),
  ADR-0040 (one envelope, many payload schemas), ADR-0041 (identity travels with the subject),
  ADR-0043 (assignment is a control plane with a measured data plane)

## Context

Retail Loitering needs one fact the platform could not express: **was this person inside that area of
the picture?** Everything else the workflow needs already existed — tracking, identity across gaps, an
event platform, a rule engine with a windowed stateful stage, an incident pipeline, and a console.

Adding that fact required deciding three things.

### 1. Two different things in this platform are called a *zone*

| | **Location-hierarchy zone** | **Detection zone** |
|---|---|---|
| owned by | Tenant context (`OrgNode`) | Camera context |
| means | a *place* — "Floor 2 East" | an *area of one camera's picture* |
| carried on | `Camera.zoneId`, `RuleScope.nodeIds` | `EventEnvelope.zoneId`, `RuleScope.zoneIds` |
| how a subject relates to it | by which camera saw them | by where their feet were in the frame |

`EventEnvelope.zoneId` sat beside `branchId` and `siteId` under a heading that said *tenancy and
spatial scoping*, and **nothing had ever set it**. `ResolvedRuleScope.zoneIds` — the set the rule
engine's scope stage matches that field against — is the *hierarchy* expansion. So the branch had
never fired in production, and the day something started stamping the field, the two id spaces would
have met.

### 2. Where zone membership is computed

The candidates were the AI runtime, the rule engine, and media.

### 3. What a dwell rule accumulates on

ADR-0041 already answered this — `identityId`, never `trackId` — but nothing had ever needed it, so
nothing had ever proved the identity survived to a rule.

## Decision

### `EventEnvelope.zoneId` carries the **detection** zone, and the two id spaces stay in separate fields

The envelope's `zoneId` is stamped with the polygon the subject was standing in, because that is the
only zone the platform can **observe**. A hierarchy location is a property of the camera and is
derivable from `cameraId` at query time; it never needed to be on the wire, and it never was.

`ResolvedRuleScope` therefore carries **two** sets:

- `zoneIds` — the hierarchy expansion, unchanged, still matched against nothing;
- `detectionZoneIds` — the polygons a rule watches, matched against `envelope.zoneId`.

They are never compared to each other. Sharing one set would have matched nothing today and something
*wrong* the day the hierarchy was wired up — a rule scoped to the London site firing on a camera
polygon that happened to share an id.

⚠️ **Detection-zone scope narrows.** When a rule names any detection zone, an event outside every
named zone is outside the rule *even on a camera the rule also names*. Checking the camera first
would have made the zone scope decorative.

### Zone membership is computed in **media**, on the frame path, carried by the assignment plan

- **Not the AI runtime.** Architecture v1.0 is frozen; this would have been a new pipeline stage and
  a new configuration channel. A polygon is deployment configuration, not a model.
- **Not the rule engine.** It holds `EventEnvelope`s and no geometry. Giving it polygons means a
  camera-service lookup per rule per event — the shape PLATFORM_BOUNDARIES rule 4 exists to prevent.
- **Media**, because it is already the only service that talks to the runtime, already polls the
  assignment plan every five seconds, and already holds the `DetectionResult` with its bounding boxes
  in memory. **Zones ride on the plan.** The cost was one additive field on a contract the milestone
  already owned; there is no new integration, no new poll, and no new failure mode.

Two consequences worth stating:

- **The anchor is the floor contact point** — the bottom centre of the bounding box, not its centre.
  A standing person's box is about twice as tall as it is wide, so its centre drifts into a zone as
  soon as their shoulders cross the line, while the operator who drew the zone on the floor meant
  their feet.
- **`zoneVersion` is a separate counter from `sessionEpoch`.** Dragging a vertex must not look like a
  reassignment: an assignment change releases tracking and publisher state, and editing a polygon is
  not a reason to throw away a person's accumulated dwell.

### One detection becomes **one event per zone it occupies**

`EventEnvelope.zoneId` is a single value — one event, one place. "A person is in the checkout queue"
and "a person is in the aisle" are two facts, and a rule scoped to the queue must see the first
without the second. Matching against an *array* would have made the scope stage a set intersection
per rule per event, which is precisely the per-event cost the compiled-scope design removed in P-4.

A subject in **no** zone still produces its event, unchanged. Suppressing those would have made
drawing a zone a switch that silently disabled every tenant-wide and camera-scoped rule on that
camera.

### Dwell is a **new stateful stage**, not a window

`window` counts events: "≥ 5 matches within 60 seconds". Dwell measures *elapsed time between the
first and most recent observation of one subject*. The two come apart whenever the frame rate does —
"120 events in 60 s" is a statement about the deployment's fps, not about the customer's rule, and it
breaks the moment a camera is throttled or a runtime sheds load. Expressing dwell as a count would
have made every loitering rule silently frame-rate-dependent.

It accumulates on `identityId` (ADR-0041) and refuses to evaluate when an event carries no subject
key at all, rather than bucketing anonymous detections under a placeholder.

## Consequences

### What this bought

- Loitering is **configuration**: a dwell block and a zone scope. The word *loitering* appears in the
  id of one template and nowhere in the engine. `FUTURE_WORKFLOW_COVERAGE` records, per workflow the
  Architect named, which primitive expresses it and — where one is missing — exactly what is missing.
- The same seam serves intrusion, queue monitoring and abandoned object with no new code.
- A camera-scoped rule can be **enabled** for the first time. Nothing had ever wired a camera
  directory into the rules service, so `unavailableCameraDirectory` reported `available: false`,
  validation reported `verified: false`, and every camera-scoped rule in every deployment was
  un-enablable. Nobody had noticed, because nothing had tried ([L-56]).

### What it cost, and what is now known that was not

⚠️ **The observation interval is set by the event dedup window, not by the frame rate.**

`services/events` collapses repeated detections of one subject into one event per dedup bucket
(`EVENTS_DEDUP_WINDOW_MS`, 10 s by default). A dwell rule therefore observes a *continuously present*
person about once every ten seconds however fast the camera runs. Three things follow, and all three
were discovered by running the deployment and reading the numbers rather than by any test:

1. **`resetAfterSeconds` must exceed the dedup window**, not the frame interval. The first validation
   check used the frame interval and would have blessed a 3-second reset that could never accumulate
   anything — a rule that saves, enables, reports healthy and never fires.
2. **`longestGapSeconds` alone is meaningless.** It read 10 s on every incident, and the summary said
   "the longest unobserved gap was 10s" — true, alarming, and describing nothing but the platform's
   own sampling. An operator would have learned within a week to ignore the one field that exists to
   make them careful. It now travels with `typicalGapSeconds` (the **median** interval), and
   `gapIsUnusual` — exported from contracts so no two surfaces can disagree — decides when to qualify
   a duration.
3. **Dwell resolution is bounded below by that window.** A rule with a threshold under ~20 s is
   measuring the dedup bucket as much as the customer's policy. Recorded in KNOWN_LIMITATIONS.

Other costs:

- **Dwell state is in-memory and lost on restart.** A rules service redeployed while somebody is
  standing in a monitored zone will not fire for them until they have been there for the full
  threshold again. Unlike windowed state it is *not* re-derivable from event replay in the general
  case. The seam for a Redis-backed store is the `DwellStateStore` port, unchanged.
- **Event volume grows where zones overlap**, and only there. A camera with one loitering zone
  produces the same number of events as before.
- **Group and zone scope are snapshotted at validation.** A camera added to a group afterwards is not
  covered until the rule is re-validated — visible (`resolvedAt`) rather than silent, and the same
  trade ADR-0026 made for the hierarchy.

### The guardrails

No new service. No frozen contract changed — zone memberships ride in `Detection.attributes`, the
open map the freeze explicitly permits. Nothing added to the frozen AI runtime. Every cross-context
read is validation-time and fails closed, except the zone-name cache, which fails soft and is
documented as doing so on the field it affects.
