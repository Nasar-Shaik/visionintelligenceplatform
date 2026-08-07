# One pipeline, six verticals

**How the platform built for Retail Loitering serves hospital, manufacturing, warehouse, education and
traffic — without a new engine.**

> ⚠️ **This is a capability map, not a roadmap.** Every row says what the existing pipeline can express
> today and what is genuinely missing. Nothing here is scheduled, and a row marked _missing_ is a
> statement about the platform, not a promise about a date. Selling a row that says "missing" is
> selling a research project.

Related: [Retail-Loitering.md](./Retail-Loitering.md), [ADR-0044](../adr/ADR-0044-one-word-two-zones.md),
`packages/contracts/src/rules/templates.ts` (`FUTURE_WORKFLOW_COVERAGE`).

---

## 1 · What every vertical shares

```
Camera ─▶ Assignment ─▶ Inference ─▶ Tracking ─▶ Identity ─▶ Events ─▶ Rules ─▶ Incident ─▶ Operator
```

Not one of these is domain-specific. A hospital corridor and a checkout aisle are the same eight hops;
what differs is **which polygon, which duration, which model, and what the incident is called**.

⚠️ **This is the actual claim being made, and it is falsifiable.** If a vertical needs a ninth hop,
the platform's design was wrong. §4 lists the five gaps that would need filling, and none of them is a
hop — all five are _primitives inside_ an existing stage.

### The primitives available today

| Primitive              | What it expresses                                          | Status                                                                                         |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Detection zone**     | a named polygon/rectangle on one camera's picture          | ✅ shipped                                                                                     |
| **Scope**              | tenant · location · camera · camera group · detection zone | ✅ shipped                                                                                     |
| **Condition**          | field predicates over the event envelope                   | ✅ shipped                                                                                     |
| **Window**             | "≥ N matching events within W seconds", grouped            | ✅ shipped                                                                                     |
| **Dwell**              | elapsed presence of one subject, in event time             | ✅ shipped                                                                                     |
| **Identity**           | subject continuity across gaps, within a camera            | ✅ shipped                                                                                     |
| **Schedule**           | when a rule is live                                        | ⛔ **NOT BUILT — corrected 2026-08-07.** See the note below                                    |
| **Dry run**            | evaluate fully, publish nothing                            | ✅ shipped                                                                                     |
| **Evidence reference** | camera + interval + events, never bytes                    | ✅ shipped                                                                                     |
| **Model registry**     | which model runs, per capability                           | ✅ shipped ([ADR-0037](../adr/ADR-0037-model-agnostic-runtime-and-registry-driven-loading.md)) |

⚠️ **The shipped model detects people.** Anything below that needs a forklift, a vehicle, a helmet or
a bag needs a _registered model that emits that class or attribute_. The runtime is model-agnostic and
that is a configuration exercise; the **model itself is not a platform capability** and no row below
pretends otherwise.

> ⛔ **Correction, 2026-08-07 — `Schedule` was listed ✅ shipped and does not exist.** Found by reading
> the code while planning the [Retail Capability Pack](../project/RETAIL_CAPABILITY_PACK.md): `Rule`
> has no schedule field, the rules service has no schedule evaluation, and the word appears in the
> contracts exactly once as a `RuleReferenceKind` value nothing produces. A **one-off absolute** time
> range can be expressed as a condition on `occurredAt`; a **recurring** "every night 18:00–06:00"
> cannot be expressed at all.
>
> ⚠️ **Five rows below rested on it** — out-of-hours presence, unauthorised entry, restricted corridor,
> restricted aisle and staff presence — and each is downgraded to 🔶 with `schedule` named. The rows
> that use zone scope **without** a schedule are unaffected and stay ✅.
>
> ⚠️ **Its real cost is a timezone.** "9 a.m." is a local claim and nothing in this platform carries a
> timezone — not a tenant, not a node, not a camera. The only such field in the contracts package is on
> `JobSchedule`, whose own comment says exactly this, and it is the precedent to follow. Specified in
> [RETAIL_CAPABILITY_PACK §5.1](../project/RETAIL_CAPABILITY_PACK.md); recorded in
> [PRODUCT_READINESS §7.1](../project/PRODUCT_READINESS.md).

---

## 2 · Vertical by vertical

Legend — **✅** expressible today with configuration only · **🔶** needs one named platform primitive ·
**🔴** needs a model the platform does not ship · **⛔** needs research, not engineering.

### Retail

| Capability        | Expressed by                                      | Status                                                                                              |
| ----------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Loitering**     | zone scope + dwell                                | ✅ **shipped**                                                                                      |
| Restricted area   | zone scope + dwell (short) or immediate           | ✅                                                                                                  |
| Shelf visit       | zone scope + dwell, short threshold               | ✅ ⚠️ but see the ~10 s sampling floor (L-57)                                                       |
| Staff presence    | zone scope + schedule + dwell                     | 🔶 **schedule** ⚠️ _presence_, not _identification_ — the platform cannot tell staff from customers |
| Queue length      | zone + **count of distinct subjects**             | 🔶 count aggregation                                                                                |
| Queue abandonment | queue length + a subject leaving before the front | 🔶 count + exit detection                                                                           |
| Tailgating        | **line crossing** + inter-arrival time            | 🔶 line geometry                                                                                    |
| Theft attempt     | composition of several weak signals               | ⛔ ⚠️ see §5                                                                                        |

### Hospital

| Capability          | Expressed by                                      | Status                                                                       |
| ------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Unauthorised entry  | zone scope + schedule                             | 🔶 **schedule** — ✅ if the zone is restricted at **all** times              |
| Patient wandering   | zone scope + dwell, **and cross-camera identity** | ⛔ ⚠️ a corridor is many cameras; the platform's identity does not span them |
| Fall detection      | a pose/action model                               | 🔴                                                                           |
| Bed-exit            | zone + absence ("the bed zone became empty")      | 🔶 absence stage                                                             |
| Corridor congestion | zone + count                                      | 🔶 count aggregation                                                         |

⚠️ **Healthcare deployments carry duties this document does not address** — clinical safety
classification, patient consent, and jurisdiction-specific rules about recording in care settings. The
platform provides evidence handling and audit; it does not provide a regulatory position.

### Manufacturing / factory

| Capability               | Expressed by                                 | Status                                             |
| ------------------------ | -------------------------------------------- | -------------------------------------------------- |
| Restricted zone          | zone scope + immediate or dwell              | ✅                                                 |
| Machine-guard breach     | zone scope, tight polygon, zero dwell        | ✅ ⚠️ **not a safety-rated interlock** — see below |
| PPE detection            | a helmet/vest **attribute** on the detection | 🔴                                                 |
| Forklift safety          | a **forklift class** + line/zone + proximity | 🔴 + 🔶                                            |
| Person-vehicle proximity | two subjects' relative position              | 🔶 spatial relation between subjects               |

⚠️ **Nothing here is a safety system.** A machine guard that depends on a video pipeline with
sub-second-to-second latency, in-memory state and a documented restart gap (L-59) must never be the
only thing between a person and a machine. It is a **supervisory** signal beside a rated interlock.

### Warehouse

| Capability        | Expressed by                           | Status                                                 |
| ----------------- | -------------------------------------- | ------------------------------------------------------ |
| Restricted aisle  | zone scope + schedule                  | 🔶 **schedule** — ✅ if restricted at **all** times    |
| Loading-bay dwell | zone scope + dwell, long threshold     | ✅                                                     |
| Dock occupancy    | zone + count                           | 🔶 count aggregation                                   |
| Vehicle movement  | a **vehicle class** + line crossing    | 🔴 + 🔶                                                |
| Abandoned object  | zone + dwell on a **non-person** class | 🔶 the dwell stage is class-agnostic; the model is not |

### Education

| Capability            | Expressed by                       | Status                                                |
| --------------------- | ---------------------------------- | ----------------------------------------------------- |
| Restricted corridor   | zone scope + schedule              | 🔶 **schedule** — ✅ if restricted at **all** times   |
| Out-of-hours presence | zone scope + schedule              | 🔶 **schedule** ⛔ "out of hours" **is** the schedule |
| Student crowding      | zone + count + threshold           | 🔶 count aggregation                                  |
| Exit-route blockage   | zone + dwell on a non-person class | 🔶 + 🔴                                               |

⚠️ **Education deployments involve minors.** Retention defaults, access control and what is recorded
in an incident's explanation deserve an explicit customer decision before any rule is enabled. The
platform makes those configurable; it does not choose them.

### Traffic

| Capability         | Expressed by                              | Status                                                    |
| ------------------ | ----------------------------------------- | --------------------------------------------------------- |
| Illegal parking    | zone scope + dwell on a **vehicle class** | 🔴 (model) — the rule is otherwise identical to loitering |
| Wrong-way movement | **direction** geometry + track heading    | 🔶 direction primitive                                    |
| Stopped vehicle    | zone + dwell + low displacement           | 🔶 displacement predicate                                 |
| Queue / congestion | zone + count                              | 🔶 count aggregation                                      |

⚠️ **Illegal parking is Retail Loitering with a different model and a different word.** That is the
strongest evidence for the claim in §1 — and also the clearest illustration of §3.

---

## 3 · ⚠️ The uncomfortable summary

**Most of the ✅ rows are the same rule.** Zone scope plus dwell expresses restricted area, loitering,
shelf visit, loading-bay dwell, illegal parking and machine-guard breach. That is a real platform
result and it should be stated plainly rather than presented as six separate capabilities.

⛔ **Corrected 2026-08-07:** this paragraph said "plus a schedule" and listed **out-of-hours presence**
among them. There is no schedule primitive (see the note in §1), so every _timed_ variant of these rows
is 🔶 and out-of-hours presence is 🔶 outright. The untimed rows are unaffected.

What it means commercially: **the first customer capability was expensive and the next six are cheap,
but the seventh is expensive again** — because the seventh is the one that needs a primitive that does
not exist. Planning as though every capability costs the same as the second one is the mistake this
table exists to prevent.

---

## 4 · The gaps, ranked by how many rows they unlock

⛔ **Six, not five — corrected 2026-08-07.** `Schedule` was believed shipped and was never built; it
now sits at rank 2 because it is small and unlocks the timed variant of every ✅ row above.

| #   | Missing primitive                                                 | Unlocks                                                                                                    | Shape of the work                                                                                                                                     |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Count aggregation** — distinct subjects in a zone at an instant | queue length, occupancy, crowding, dock occupancy, congestion (5 rows, 5 verticals)                        | a new stateful stage beside `dwell`, same shape                                                                                                       |
| 2   | ⛔ **Schedule** — when a rule is live                             | out-of-hours presence, unauthorised entry, restricted corridor/aisle, staff presence (5 rows, 4 verticals) | a gate stage on the event's `occurredAt`. ⚠️ **Its real cost is a timezone** — nothing in this platform carries one; follow `JobSchedule`'s precedent |
| 3   | **Line geometry + crossing test**                                 | tailgating, wrong-way, vehicle counting, entry/exit                                                        | `line` is already declared in `ZoneShape` and marked **non-evaluable**; the geometry layer was designed for it                                        |
| 4   | **Non-person classes and attributes**                             | PPE, forklift, vehicle, abandoned object                                                                   | ⚠️ **model work, not platform work** — the registry already supports it                                                                               |
| 5   | **Absence** — "this zone became empty"                            | bed-exit, unattended post, blocked-route clearance                                                         | an inversion the rule engine cannot currently express: rules fire on events, and absence produces none                                                |
| 6   | **Cross-camera identity**                                         | patient wandering, following someone through a building                                                    | ⛔ **research.** Everything above is engineering; this is not                                                                                         |

⚠️ **Gap 5 is subtler than it looks and is worth stating clearly**: a rule engine driven by events can
only react to something happening. "Nobody is at the nurses' station" is the absence of events, and
absence needs a clock the engine owns rather than a message it receives. It is the same trap
[ADR-0039](../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md) records one layer down —
absent is not zero.

---

## 5 · ⚠️ Theft, specifically

Theft is not a detection and it is not a dwell. It is an **inference about intent**, assembled from
weak signals — concealment, unusual dwell at a high-value fixture, an exit without a transaction —
none of which is individually evidence of anything.

Three things follow, and they belong in this document rather than in a sales deck:

1. **The platform can supply the signals.** Zone dwell, restricted-area presence and event
   correlation are all shipped. A composed rule over several of them is the missing piece, and it is
   engineering.
2. **The judgement is not the platform's to make.** An incident that says _"this person spent 90
   seconds at the spirits cabinet and left through the fire door"_ is a fact an operator can act on.
   An incident that says _"suspected theft"_ is an accusation the platform cannot support and should
   not make.
3. **It was explicitly excluded from P-8 Phase 7** by the Architect, and this document does not
   re-open it.

---

## 6 · What a new vertical actually costs

Assuming the capability is a ✅ row:

| Step                                   | Who      | Reuses                               |
| -------------------------------------- | -------- | ------------------------------------ |
| Register cameras, define the hierarchy | customer | Camera + Tenant contexts             |
| Draw and name zones                    | customer | Zone Editor                          |
| Configure the rule from a template     | customer | Rule Management, `RULE_TEMPLATES`    |
| **Dry-run it for a day**               | customer | dry-run reports — ⚠️ never skip this |
| Tune the threshold and the polygon     | customer | Rule Management, zone versioning     |
| Enable                                 | customer | —                                    |
| Verify end to end on the deployment    | us       | the nightly stages, one new row      |

**No new service. No new contract. No new engine.** A new capability that needs one is, by definition,
not a ✅ row — and the honest answer at that point is the table in §4, not a schedule.
