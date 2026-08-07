# Retail Capability Pack — implementation roadmap

**Nine capabilities, four primitives, and an honest account of which is which.**

**Written 2026-08-07.** This plans work; it authorises none of it. Built on
[VERTICALS](../customer-workflows/VERTICALS.md), [PHASE_8_PLAN](PHASE_8_PLAN.md) §3–4 and
`FUTURE_WORKFLOW_COVERAGE` in `packages/contracts/src/rules/templates.ts`, each re-checked against the
code rather than taken from the document.

> ⭐ **The headline, before the detail: three of the nine ship as configuration, four need one of three
> primitives that do not exist, and two carry a claim this platform cannot make at any price.**
> A plan that prices all nine the same will miss by the width of the last two.

---

## 1 · The pack at a glance

| #   | Capability             | Primitives needed                         | State                         | New primitive         | Effort     |
| --- | ---------------------- | ----------------------------------------- | ----------------------------- | --------------------- | ---------- |
| 1   | **Retail Loitering**   | zone + dwell(identity)                    | ✅ **SHIPPED** (C-14g)        | —                     | **0**      |
| 2   | **Restricted Area**    | zone + condition (+ short dwell)          | ✅ **configuration only**     | — ⚠️ unless timed     | **S**      |
| 3   | **Queue Detection**    | ⚠️ **three different products** — §4.3    | 🟡 **one third ships today**  | count (for length)    | **S / M**  |
| 4   | **Occupancy**          | zone + **distinct-subject count**         | 🔶 blocked                    | ⭐ **COUNT**          | **M**      |
| 5   | **Crowd Density**      | count + a declared capacity               | 🔶 blocked ⚠️ **not m²**      | ⭐ **COUNT**          | **M**      |
| 6   | **Counter Monitoring** | ⭐ **absence** + schedule + dwell         | ⛔ **two missing primitives** | **ABSENCE**, SCHEDULE | **L**      |
| 7   | **Wrong Direction**    | **line geometry + crossing sign**         | 🔶 blocked                    | ⭐ **LINE**           | **L**      |
| 8   | **People Counting**    | line crossing + ⚠️ **an aggregate store** | 🔶 blocked twice              | **LINE** + read model | **L**      |
| 9   | **Staff Presence**     | dwell + schedule + ⛔ **staff identity**  | ⛔ **not claimable**          | SCHEDULE + ⛔         | **M + ⛔** |

**Legend** — ✅ configuration today · 🟡 partly · 🔶 needs a named primitive · ⛔ needs something this
platform does not and should not casually acquire. **S** ≈ 2 days · **M** ≈ 1 week · **L** ≈ 2 weeks,
each including its eight verification deliverables.

⚠️ **Capabilities 4, 5 and part of 3 are one primitive apart.** Building `count` once turns three
blocked rows into three configuration rows, and unlocks five more across hospital, warehouse, education
and traffic. **It is the highest-leverage single piece of work in the pack.**

---

## 2 · The primitive ledger

### 2.1 What exists — verified in the code, not read from a document

| Primitive          | Where                                                 | Status                                 |
| ------------------ | ----------------------------------------------------- | -------------------------------------- |
| **Detection zone** | `contracts/zones/zone.ts`, `polygon` + `rectangle`    | ✅ shipped, versioned, editor + plans  |
| **Scope**          | tenant · node · camera · group · detection zone       | ✅ shipped, resolved and snapshotted   |
| **Condition**      | 10 operators over any dotted envelope path            | ✅ shipped, pure and total             |
| **Window**         | ≥ N **events** in W seconds, grouped                  | ✅ shipped ⚠️ **events, not subjects** |
| **Dwell**          | continuous presence of one subject, in **event time** | ✅ shipped (C-14g)                     |
| **Identity**       | subject continuity across gaps, **within a camera**   | ✅ shipped (C-14d)                     |
| **Dry run**        | evaluate fully, publish `rule.matched`, raise nothing | ✅ shipped ⭐ the pack's safety net    |
| **Evidence ref**   | camera + interval + events                            | ✅ shipped                             |

### 2.2 ⛔ What does not exist — including one the capability map says does

| Missing              | Unlocks (retail / all verticals) | Shape of the work                                                                                  |
| -------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| ⭐ **COUNT**         | **3 / 8**                        | A stateful stage beside `dwell`, same shape, same event-time discipline                            |
| ⭐ **SCHEDULE**      | **2 / 6**                        | ⛔ **Documented as shipped and never built** — §5.1. ⚠️ Its real cost is a **timezone**            |
| **LINE + DIRECTION** | **2 / 5**                        | `line` is declared in `ZoneShape` and marked non-evaluable; needs per-subject previous-side state  |
| **ABSENCE**          | **1 / 3**                        | ⚠️ An inversion the event-driven engine cannot express — it needs a **clock the engine owns**      |
| **AGGREGATE STORE**  | **1 / many**                     | ⚠️ Rules can `emit-event`; **nothing counts the events**. "People counting" as a number needs C-51 |
| **STAFF IDENTITY**   | 1                                | ⛔ Model, badge or biometric. **Not a platform capability** — §5.4                                 |

---

## 3 · Capability by capability

Each: **required primitives · existing reusable components · new work · verification · customer value ·
effort.**

### 3.1 ✅ Retail Loitering — SHIPPED

|                  |                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primitives**   | zone scope + `dwell(groupBy: identity)`                                                                                                                           |
| **Reuses**       | Everything. It is the capability the primitives were built for                                                                                                    |
| **New work**     | ⛔ **None.** [C-14g](PRODUCT_CAPABILITY_MATRIX.md), 5 console pages, `LOITERING_TEMPLATE`, [Retail-Loitering.md](../customer-workflows/Retail-Loitering.md)       |
| **Verification** | ✅ Nightly `loitering` stage, mutation set, deployment run                                                                                                        |
| **Value**        | ⭐ The reference capability. Every row below is measured against how much of it can be reused                                                                     |
| **Effort**       | **0**                                                                                                                                                             |
| ⚠️ **But**       | Pilot is `⬜ unvalidated`: never a real camera ([L-58](KNOWN_LIMITATIONS.md)), never real footage. ⭐ [Offline Video](OFFLINE_VIDEO_PLAN.md) is what changes that |

### 3.2 ✅ Restricted Area — configuration only

|                  |                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primitives**   | zone scope + `eventTypes` pre-filter + condition on subject class; `dwell.minSeconds: 1–5` to suppress a person walking past the edge of a polygon                   |
| **Reuses**       | Loitering's entire path. The rule differs only in threshold and severity                                                                                             |
| **New work**     | A `RESTRICTED_AREA_TEMPLATE`, a customer workflow document, and a verification that the configuration does what the template claims                                  |
| **Verification** | Deployment run: a subject inside the polygon raises within one dedup bucket; ⭐ **a subject who walks past the edge does not** — the negative case is the capability |
| **Value**        | ⭐ **High and immediate.** The most-asked security capability, and it is already built                                                                               |
| **Effort**       | **S** — 2 days                                                                                                                                                       |
| ⛔ **Except**    | **"Restricted _after hours_" is a different capability** and needs SCHEDULE (§5.1). Ship the unconditional one; do not let the timed one ride along unnoticed        |

### 3.3 🟡 Queue Detection — ⚠️ three products under one word

⭐ **The most important clarification in this document.** "Queue detection" is sold as one thing and is
three, with three different costs:

| What the customer means   | Expressed by                                                      | State                                 | Effort |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------- | ------ |
| **(a) Queue wait time**   | zone + `dwell(identity)`                                          | ✅ **ships today**                    | **S**  |
| **(b) Queue length**      | zone + **distinct count**                                         | 🔶 needs COUNT                        | **M**  |
| **(c) Queue abandonment** | count + a subject leaving the zone **without reaching the front** | 🔶🔶 count + a second zone + ordering | **L**  |

|                  |                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reuses**       | (a) is Loitering with a different zone, threshold and title. Nothing new at all                                                                                              |
| **New work**     | (a) a template + doc + verification. (b) COUNT. (c) COUNT plus a two-zone ordering relation that does not exist                                                              |
| **Verification** | (a) authored footage with a **known** wait time; (b) ⭐ a scene with a **known** number of people — the trap `dwell` also had, named in [PHASE_8_PLAN](PHASE_8_PLAN.md) §4.2 |
| **Value**        | ⭐ (a) is genuinely valuable on its own — "how long did that customer wait?" is the retail question. (b) is the one on the brochure                                          |
| **Effort**       | **S** now, **M** after COUNT, **L** for (c)                                                                                                                                  |
| ⚠️ **Say**       | Ship (a) as **"Queue Wait Time"**, by that name. Calling it "Queue Detection" and delivering wait time is how a customer discovers the gap on day two                        |

### 3.4 🔶 Occupancy — blocked on COUNT

|                   |                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primitives**    | zone + **distinct-subject count at an instant**                                                                                                                                                                                                   |
| **Reuses**        | Zone resolver, identity, event-time discipline, rule scope, incident path — everything except the stage                                                                                                                                           |
| **New work**      | ⭐ **COUNT** (§5.2). Then a template and a threshold                                                                                                                                                                                              |
| ⛔ **Not enough** | `RuleWindow` counts **events**, and the event stream is dedup-collapsed. Two events from one person read as two people; one person present for a minute reads as six. **A window is not an occupancy count and must never be shipped as one**     |
| **Verification**  | ⭐ Footage with a **known** number of people, including a scene where one person generates many events and the count stays at one                                                                                                                 |
| **Value**         | High — and it is the primitive under crowd density, dock occupancy, corridor congestion and student crowding                                                                                                                                      |
| **Effort**        | **M** — 1 week including COUNT's own verification                                                                                                                                                                                                 |
| ⚠️ **Limit**      | **Per-zone occupancy is engineering. Site-wide occupancy is research** — summing across cameras without double-counting needs cross-camera identity ([L-43](KNOWN_LIMITATIONS.md), ⛔ research). Do not let "occupancy" quietly mean the building |

### 3.5 🔶 Crowd Density — blocked on COUNT, and ⚠️ bounded by physics

|                             |                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primitives**              | COUNT + an **operator-declared capacity** for the zone                                                                                                                                                                                                                                                                                                                                                          |
| **Reuses**                  | Everything Occupancy reuses                                                                                                                                                                                                                                                                                                                                                                                     |
| **New work**                | COUNT, plus one additive field on `DetectionZone` (`capacity`) and a template expressing "count ÷ capacity ≥ threshold"                                                                                                                                                                                                                                                                                         |
| ⛔ **What cannot be built** | **Density in people per square metre.** There is no camera calibration, no ground plane and no perspective correction anywhere in this platform ([L-58](KNOWN_LIMITATIONS.md)); distances are fractions of the frame, never metres ([L-44](KNOWN_LIMITATIONS.md)). ⚠️ A polygon covering the far half of an image covers a much larger floor area than one covering the near half, **and nothing reports that** |
| **Verification**            | A scene at a known count against a declared capacity; ⭐ and a **negative**: the same count in a zone with double the capacity must not fire                                                                                                                                                                                                                                                                    |
| **Value**                   | Medium. Real for safety limits and event management; ⚠️ the m² version is what a buyer pictures                                                                                                                                                                                                                                                                                                                 |
| **Effort**                  | **M** — 1 week after COUNT                                                                                                                                                                                                                                                                                                                                                                                      |
| ⚠️ **Say**                  | Sell it as **"zone occupancy against a capacity you declare"**, never as density. The honest sentence is: _"you tell us the zone holds twenty; we tell you when there are eighteen."_                                                                                                                                                                                                                           |

### 3.6 ⛔ Counter Monitoring — ⚠️ the cheapest-looking, most expensive capability here

⭐ **This row is why the pack needed analysing rather than scheduling.** It reads like Loitering with a
smaller polygon. It is not.

| The customer means               | Expressed by    | State                               |
| -------------------------------- | --------------- | ----------------------------------- |
| "Someone lingering at the till"  | zone + dwell    | ✅ ships today                      |
| ⭐ **"The counter is unmanned"** | ⛔ **absence**  | ⛔ **the engine cannot express it** |
| "…during opening hours"          | ⛔ **schedule** | ⛔ **does not exist** (§5.1)        |

|                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New work**               | **ABSENCE** (§5.4) **and** SCHEDULE (§5.1) — two missing primitives in one capability                                                                                                                                                                                                                                                                                                                                                                                     |
| ⚠️ **Why absence is hard** | A rule engine driven by events reacts to something happening. _"Nobody is at the counter"_ is the **absence of events**, and absence needs a clock the engine owns rather than a message it receives. It is [ADR-0039](../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md) one layer up: **absent is not zero**                                                                                                                                                 |
| ⚠️ **And worse**           | An absence rule that fires when events stop cannot distinguish _"nobody is there"_ from _"the camera died"_, _"the runtime shed frames under load"_ ([L-47](KNOWN_LIMITATIONS.md)) or _"AI was unassigned"_ ([L-54](KNOWN_LIMITATIONS.md)). ⛔ **An unmanned-counter alert that fires on a camera outage trains the operator to ignore it.** Absence must be gated on the source being _known healthy_, which couples the rule engine to camera health for the first time |
| **Verification**           | A scene that genuinely empties **and** a camera that is disconnected — ⭐ the second must **not** raise an unmanned-counter incident                                                                                                                                                                                                                                                                                                                                      |
| **Value**                  | ⭐ Genuinely high. "Is the desk staffed?" is asked in retail, hospital, reception and warehouse                                                                                                                                                                                                                                                                                                                                                                           |
| **Effort**                 | **L** — 2 weeks, ⚠️ and it is the only row in this pack that touches the engine's architecture                                                                                                                                                                                                                                                                                                                                                                            |

### 3.7 🔶 Wrong Direction — blocked on LINE

|                  |                                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primitives**   | a `line`/`direction` zone + a side-of-line test carried **between frames per subject** + the sign of the crossing against the segment normal                                                                                                                                                    |
| **Reuses**       | ⭐ More than it looks: the geometry layer already accepts a line, the editor can draw one, the version history handles it, and the zone service refuses to store what it cannot evaluate — so **nothing has to be undone**. `ZONE_EVALUATION.line.needs` already states exactly what is missing |
| **New work**     | The crossing evaluator, per-subject previous-side state (a third stateful stage), the direction sign, editor support for orienting a line, and flipping one `evaluable` flag                                                                                                                    |
| ⚠️ **Trap**      | A subject standing **on** the line oscillates between sides and produces a crossing per frame. Needs hysteresis — a minimum displacement perpendicular to the line — designed in from the start, exactly as `dwell` needed a cool-down                                                          |
| **Verification** | Authored trajectories with **written-down** crossing directions, in both directions, plus a subject who approaches and turns back (must produce nothing)                                                                                                                                        |
| **Value**        | High in retail (entrance anti-passback), and it is the same primitive as tailgating, vehicle counting and traffic wrong-way                                                                                                                                                                     |
| **Effort**       | **L** — 2 weeks                                                                                                                                                                                                                                                                                 |

### 3.8 🔶 People Counting — blocked on LINE, and ⚠️ blocked again on something nobody notices

|                           |                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primitives**            | line crossing with direction (in/out) — **and an aggregate store**                                                                                                                                                                                                                                                               |
| ⛔ **The second blocker** | A rule's only actions are `raise-incident` and `emit-event`. It can emit `analytics.people.count` per crossing — ⭐ **and nothing anywhere counts them.** There is no read model, no aggregate, no counter, and no dashboard that can total them ([C-51](PRODUCT_CAPABILITY_MATRIX.md), contract not frozen; C-46 has no worker) |
| **New work**              | LINE, plus a read model and a surface. ⚠️ **People counting is a reporting capability wearing a perception costume**                                                                                                                                                                                                             |
| ⚠️ **Accuracy**           | With one line, no cross-camera identity and a dedup window ([L-57](KNOWN_LIMITATIONS.md)), a footfall number is an **estimate whose error is unmeasured**. ⛔ Retail footfall is used to calculate conversion rate and staff rosters — a number with unknown error used for a business decision is worse than no number          |
| **Verification**          | ⭐ A clip with a **counted-by-hand** ground truth, in and out, and the error stated as a number rather than a claim of accuracy                                                                                                                                                                                                  |
| **Value**                 | ⭐ Very high commercially, and it is the row most likely to be **oversold**                                                                                                                                                                                                                                                      |
| **Effort**                | **L+** — 2 weeks after LINE, plus the reporting surface                                                                                                                                                                                                                                                                          |

### 3.9 ⛔ Staff Presence — the platform cannot tell staff from customers

|                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What is buildable**          | "A person is present at this position, during these hours" — zone + dwell + SCHEDULE. That is **§3.6's first row under a different name**                                                                                                                                                                                                                                                                                                                              |
| ⛔ **What is not**             | **Which** person. The registered model detects `person`. It does not detect a uniform, a badge, a lanyard or a role, and nothing in the platform associates an identity with an employee                                                                                                                                                                                                                                                                               |
| **The three ways to close it** | (1) a uniform/badge **model** — model work, not platform work, and it fails on a customer who has no uniform; (2) a **badge or BLE** signal — not video, and it is a new integration; (3) **face recognition** — ⛔ biometric processing under GDPR Art. 9. A lawful basis, a DPIA, a retention position and a subject-rights path come **before** there is a schema to store a faceprint in, and it is explicitly **post-GA** ([PRODUCT_ROADMAP](PRODUCT_ROADMAP.md)) |
| **Verification**               | Of the buildable half only, and the document must state what the tick covers                                                                                                                                                                                                                                                                                                                                                                                           |
| **Value**                      | ⚠️ The buildable half is real. The sold half is a different product                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Effort**                     | **M** for the buildable half (it is Counter Monitoring), **⛔** for the rest                                                                                                                                                                                                                                                                                                                                                                                           |
| ⭐ **Say**                     | Ship it as **"Position Manning"** or fold it into Counter Monitoring. ⛔ **Never as "Staff Presence" without a sentence saying the platform cannot identify staff.** [VERTICALS](../customer-workflows/VERTICALS.md) already carries that warning; the brochure must too                                                                                                                                                                                               |

---

## 4 · What the pack actually delivers, by phase

```
TODAY        ✅ Loitering ─── ✅ Restricted Area ─── ✅ Queue Wait Time          3 capabilities
                     │
             + COUNT ▼
PHASE 2      🔶 Occupancy ─── 🔶 Crowd Density ─── 🔶 Queue Length              6 capabilities
                     │                                    (+5 in other verticals)
             + SCHEDULE ▼
PHASE 3      ⛔ Timed Restricted Area ─── ⛔ Position Manning (hours)           7 capabilities
                     │
             + LINE ▼
PHASE 4      🔶 Wrong Direction ─── 🔶 People Counting*                         9 capabilities
                     │                     * + a reporting surface
             + ABSENCE ▼
PHASE 5      ⛔ Counter Unmanned                                                 9 complete
```

⭐ **Three capabilities are two days of work each. The remaining six are six weeks of primitives.**
That ratio is the single most important planning fact in this document, and it is the same shape
[VERTICALS §3](../customer-workflows/VERTICALS.md) warned about: _"the first capability was expensive,
the next six are cheap, the seventh is expensive again."_

---

## 5 · The missing primitives, specified

### 5.1 ⛔ SCHEDULE — documented as shipped, and never built

**Evidence, gathered while writing this document:**

```
Rule contract   → no schedule field                     (rules.ts:261)
Rules service   → no schedule evaluation in src/        (grep: zero hits)
Contracts       → 'schedule' = one RuleReferenceKind value nothing produces
Console         → 'Schedule' = one label in RuleValidationPanel
Whole repo      → no activeHours, daysOfWeek, timeOfDay, quietHours, cron
```

⚠️ **[VERTICALS](../customer-workflows/VERTICALS.md) §1 lists it ✅ shipped**, and five ✅ rows across
four verticals rest on it. **Corrected in the same commit as this document.**

**What it costs, and why it is not the two-hour job it looks like:**

| Part                | Cost                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The contract        | Small — an optional `schedule` block on `Rule`: weekday mask + local time ranges                                                                                                                                                                                                                                               |
| The evaluation gate | Small — one stage before `condition`, on the event's `occurredAt`. ⭐ It must be **event time**, never `Date.now()`, or a replayed or offline event is judged against the wrong hour                                                                                                                                           |
| ⭐ **The timezone** | ⚠️ **The real work.** "9 a.m." is a local claim and **nothing in this platform carries a timezone** — not a tenant, not a node, not a camera. The only `timezone` field in the whole contracts package is on `JobSchedule`, whose comment says exactly this. **Follow that precedent: the schedule carries its own IANA zone** |
| DST                 | ⚠️ Two Sundays a year an hour repeats or vanishes. A rule that fires "at 02:30" needs a stated answer                                                                                                                                                                                                                          |
| Verification        | ⭐ Boundary tests on both edges, across a DST transition, and one that fails if the gate reads wall clock                                                                                                                                                                                                                      |

**Effort: 4–5 days.** ⚠️ Two of them are the timezone.

### 5.2 ⭐ COUNT — the one worth building first

**`RuleCount`** — distinct subjects present in a zone at an instant. A stateful stage beside `dwell`,
with the same shape, the same port pattern and the same event-time discipline.

```ts
RuleCount {
  minSubjects: number          // fire at or above this many
  withinSeconds: number        // the observation window a subject counts as "present" for
  groupBy: 'identity' | 'track'   // identity, for the same reason dwell defaults to it
  cooldownSeconds: number      // or it fires every frame past the threshold, as dwell would have
}
```

⚠️ **The trap, named in [PHASE_8_PLAN](PHASE_8_PLAN.md) §4.2 before a line was written:** a count over
a **dedup-collapsed** event stream is not "how many people are here" — it is "how many distinct subject
keys the platform observed in the last bucket". ⭐ **The primitive must state which of those it reports
and be verified against a scene with a known number of people.** Dwell would have been silently
frame-rate-dependent if it had counted events instead of measuring time; this is the same mistake with
a different variable.

⚠️ **`withinSeconds` must exceed the ~10 s dedup window** ([L-57](KNOWN_LIMITATIONS.md)), exactly as
`resetAfterSeconds` must — and validation must enforce the floor **naming the dedup window as the
reason**, because the first version of dwell's check used the frame interval and would have blessed a
3-second value.

**Effort: 5–6 days** including the state store, the console surface and the eight deliverables.
**Unlocks: 3 retail rows and 5 more across four other verticals.**

### 5.3 LINE + DIRECTION

`ZoneShape` already declares `line`, `path` and `direction`; `ZONE_EVALUATION` marks them
non-evaluable and states precisely what each needs; the zone service **refuses to store a shape it
cannot evaluate**, so no operator has ever drawn one and waited. ⭐ **A future milestone implements one
by writing an evaluator and flipping one flag** — that claim is about to be tested, and it is a good
test of the design.

**New:** a per-subject previous-side store (the third stateful stage), the crossing test, the sign
against the segment normal, hysteresis, and editor support for orienting a line.

**Effort: 8–10 days.**

### 5.4 ABSENCE — ⚠️ an architectural change, not a stage

The engine reacts to messages. Absence is the lack of one, so it needs **a clock the engine owns** —
a periodic sweep over zones with an expectation, asking "has anything been seen here recently?".

⛔ **Three things must be settled before this is scheduled:**

1. **Whose clock?** A sweep in the rules service is state and timers on a per-event path — the reason
   `DwellStateStore` is in memory in the first place ([L-59](KNOWN_LIMITATIONS.md)).
2. **What is "healthy"?** Absence must not fire on a dead camera, a shed frame or an unassigned AI
   gate. This couples the rule engine to camera health for the first time.
3. **What is the evidence?** An incident that says "nothing happened" cannot reference the frame that
   proves it. ⚠️ [ADR-0024](../adr/ADR-0024-camera-lifecycle-evidence-gate.md)'s evidence discipline
   applied to a negative is an open question, not a detail.

**Effort: 10 days, ⚠️ with an ADR and the lowest confidence in this document.** Schedule it last, or on
a customer's explicit demand — never speculatively.

---

## 6 · ⛔ What this pack must not claim

| Claim                              | Why it cannot be made                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"Density in people per m²"**     | No calibration, no ground plane, no perspective correction (L-58); distances are frame fractions (L-44)                                                                                 |
| **"Staff presence"** meaning staff | The model detects `person`. Identification is a model, a badge, or biometrics — §3.9                                                                                                    |
| **"Footfall accuracy of N %"**     | ⭐ No labelled corpus, no accuracy gates (TD-64), and none may be invented from runtime statistics (ADR-0039)                                                                           |
| **"Occupancy across the site"**    | Cross-camera identity is ⛔ **research** (L-43)                                                                                                                                         |
| **"Real-time" under ~20 seconds**  | The event dedup window is 10 s and it is a floor under every time-based capability (L-57)                                                                                               |
| **Any of it "validated"**          | ⬜ Every capability here is verified against synthetic input. ⭐ [Offline Video](OFFLINE_VIDEO_PLAN.md) is the instrument that changes that, and it comes first for exactly this reason |
| **A machine-guard or safety use**  | ⛔ Nothing here is a safety system. In-memory state, a documented restart gap (L-59), video latency                                                                                     |

---

## 7 · Verification approach

Every capability ships all eight deliverables ([DEFINITION_OF_DONE](DEFINITION_OF_DONE.md)) — including
the three "just configuration" ones.

⭐ **The mutation test is the one that will be tempting to skip on a template, and it is the one that
matters most.** Phase 7 found that two of its eight mutations were **vacuous**, and that camera-scoped
rules had never worked in any deployment ([L-56](KNOWN_LIMITATIONS.md)). A capability assembled from
existing primitives is exactly the kind that fails silently, because every component test passes.

**Per capability, minimum:**

| Deliverable    | Minimum bar                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------ |
| **Runtime**    | Unit tests over the new stage or the template's parameter validation                             |
| **Metrics**    | Stage-level counters; ⚠️ absent is `null` with a reason, never `0`                               |
| **Browser**    | The template is reachable, configurable and enablable **in the console**, against the deployment |
| **Deployment** | ⭐ A positive **and a negative** run: the capability fires, and the near-miss does not           |
| **Mutation**   | ≥ 3, each turning a verification red. ⛔ A vacuous mutation is a failed deliverable              |
| **Nightly**    | One stage row, registered in the commit that introduces it                                       |
| **Benchmark**  | Only where a stateful stage is added — per-event cost against the ≤0.11 ms tracking precedent    |
| **Governance** | Capability matrix row, `FUTURE_WORKFLOW_COVERAGE`, VERTICALS, a customer workflow document       |

⭐ **And one bar above all of them, once [Offline Video](OFFLINE_VIDEO_PLAN.md) exists:** every
capability is verified against **real footage a human labelled first**, including a negative clip. That
is P-8's own unmet exit criterion, and it is the difference between a capability and a configuration.

---

## 8 · Recommended order

| Order | Work                                                                   | Days     | Delivers                                     | Why here                                                     |
| ----- | ---------------------------------------------------------------------- | -------- | -------------------------------------------- | ------------------------------------------------------------ |
| **1** | **Restricted Area + Queue Wait Time** — templates, docs, verifications | **4**    | ⭐ 1 → 3 capabilities                        | Two days each, zero engine change, immediate value           |
| **2** | ⭐ **COUNT**                                                           | **5–6**  | + Occupancy, Density, Queue Length           | Highest leverage in the pack; 5 more rows in other verticals |
| **3** | **SCHEDULE**                                                           | **4–5**  | + timed variants of everything above         | Small, and it corrects a false ✅ in the capability map      |
| **4** | **LINE + DIRECTION**                                                   | **8–10** | + Wrong Direction, People Counting (partial) | Expensive; test of the "flip one flag" claim                 |
| **5** | **People-counting read model**                                         | **5**    | People Counting as a **number**              | ⚠️ Needs C-51; do not start it before the dashboard contract |
| **6** | **ABSENCE**                                                            | **10**   | + Counter Unmanned                           | ⛔ Architectural, needs an ADR, lowest confidence. **Last**  |

**Total: ~7–8 engineer-weeks for all nine**, of which **4 days delivers the first three**.

⚠️ **Steps 1–3 are ~3 weeks and deliver 7 of the 9.** If the pack has to be cut, cut from the bottom —
Wrong Direction and Counter Unmanned are 60 % of the cost for 22 % of the capabilities.

---

## Related

- [PRODUCT_IMPLEMENTATION_ORDER](PRODUCT_IMPLEMENTATION_ORDER.md) — where this pack sits against everything else
- [OFFLINE_VIDEO_PLAN](OFFLINE_VIDEO_PLAN.md) — ⭐ the instrument that validates every row here
- [VERTICALS](../customer-workflows/VERTICALS.md) — the same analysis across six verticals
- [Retail-Loitering](../customer-workflows/Retail-Loitering.md) — the shipped reference capability
- [KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md) — L-42 · L-43 · L-44 · L-57 · L-58 · L-59
