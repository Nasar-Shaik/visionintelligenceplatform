# P-8 Phase 8 and beyond — customer capabilities, on two tracks

**Written 2026-08-06**, at the approval of P-8 Phase 7 (Retail Loitering — the first complete customer
workflow). This plans work; it authorises none of it. Each milestone is still authorised at review, in
sequence.

Related: [Retail-Loitering.md](../customer-workflows/Retail-Loitering.md) ·
[VERTICALS.md](../customer-workflows/VERTICALS.md) · [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) ·
[DEFINITION_OF_DONE](DEFINITION_OF_DONE.md)

---

## 1 · The transition

Seven phases of P-8 built the perception stack: runtime, frame path, real inference, tracking, the
event bridge, camera assignment, and the rule engine that turns all of it into an incident. **Phase 7
is where it became a product a customer can buy something with.**

The platform is now sufficiently mature that the next set of improvements should come from **building
real customer features**, not from adding infrastructure speculatively. Infrastructure built ahead of
a customer need is infrastructure built against a guess.

⚠️ **This is a change of default, not a ban.** A capability that genuinely needs a platform primitive
gets one — see §4. What stops is building the primitive _first_ and looking for a use afterwards.

---

## 2 · Two tracks

| Track                       | Share | What belongs in it                                                                                    |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| **A — Platform**            | ~20 % | shared infrastructure · performance · verification · the nightly framework · architecture · contracts |
| **B — Customer capability** | ~80 % | retail · hospital · manufacturing · warehouse · education · traffic analytics                         |

**Track A's admission test:** a platform change earns its place when a **capability in Track B is
blocked without it**, or when something measured says it is needed — a benchmark that regressed, a
limitation a customer met, a verification that could not fail. Not when it would be nice to have.

⚠️ **The 20 % is not a budget to spend; it is a ceiling not to exceed.** A quarter where Track A came
in under 20 % because nothing was blocked is a good quarter, not an under-delivery.

⚠️ **Verification is Track A, and it is not optional.** The eight deliverables
([DEFINITION_OF_DONE](DEFINITION_OF_DONE.md)) apply to every Track B capability. A capability shipped
without its mutation test and its nightly stage is not 80 % of a capability; it is a demo.

---

## 3 · ⚠️ The cost curve is not flat, and planning as though it is will hurt

From the capability map in [VERTICALS.md](../customer-workflows/VERTICALS.md) §3:

> **Zone scope + dwell + a schedule** already expresses restricted area, loitering, shelf visit,
> out-of-hours presence, loading-bay dwell, illegal parking and machine-guard breach.

Those are **configuration, a template and a verification** — days, not milestones. The rest need a
primitive that does not exist, and those are milestones.

**The first customer capability was expensive. The next six are cheap. The seventh is expensive
again.** A plan that prices every capability at the cost of the second one will miss by the width of
the seventh.

---

## 4 · What Phase 8 should actually be

Ordered by evidence, not by the order a customer asked:

### 4.1 Package what already works · Track B · ⚠️ do this first

**Restricted Area · Shelf Visit · Staff Presence · Out-of-hours Presence · Loading-bay Dwell.**

These need **no engine change at all**. What they need is what Retail Loitering got and they have
not: a **rule template** with sane defaults, a **customer workflow document**, and a **verification**
that the configuration does what the template claims.

⚠️ **The risk here is exactly the one this platform keeps finding: a capability that is configurable
and unverified.** Camera-scoped rules were enablable in the contract and unusable in every deployment
for four milestones, because nothing had tried ([L-56](KNOWN_LIMITATIONS.md)). Five templates nobody
has run are five of those waiting.

**Cost:** small. **Value:** it turns one sellable capability into six.

### 4.2 Count aggregation · Track A · the one primitive worth building next

`RuleCount` — distinct subjects present in a zone at an instant — is a new stateful stage beside
`dwell`, with the same shape and the same event-time discipline.

It unlocks, in five different verticals: **queue length** (retail), **corridor congestion**
(hospital), **dock occupancy** (warehouse), **student crowding** (education) and **traffic
congestion**. One primitive, five capabilities, no new service.

⚠️ **It has a trap that dwell also had, and it must be designed against it from the start.** Dwell
would have been silently frame-rate-dependent if it had counted events instead of measuring time. A
count over a _dedup-collapsed_ event stream is not "how many people are here" — it is "how many
distinct subject keys the platform observed in the last bucket". The primitive must state which of
those it reports and be verified against a scene with a **known** number of people.

### 4.3 Then, and only on evidence

| Next                             | Unlocks                                         | Precondition                                                  |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| **Line geometry + crossing**     | tailgating, wrong-way, vehicle counting         | `line` already exists in `ZoneShape`, declared non-evaluable  |
| **Incident dismissal** (C-29a)   | honest false-positive statistics                | the state is declared; the action is not (ADR-0045)           |
| **Durable dwell state**          | closes [L-59](KNOWN_LIMITATIONS.md)             | the `DwellStateStore` port is unchanged and ready             |
| **Non-person classes**           | PPE, forklift, vehicle, abandoned object        | ⚠️ **model work, not platform work**                          |
| **Absence** ("the zone emptied") | bed-exit, unattended post                       | an inversion the event-driven engine cannot currently express |
| **Cross-camera identity**        | patient wandering, following through a building | ⛔ **research.** Do not schedule it as engineering            |

### 4.4 ⚠️ Not Phase 8

- **Theft detection.** Excluded by the Architect at Phase 7 and still excluded. The platform can
  supply the signals; the accusation is not the platform's to make
  ([VERTICALS.md](../customer-workflows/VERTICALS.md) §5).
- **New services.** The standing guardrail is unchanged.
- **Anything that would change a frozen contract** without a verification proving a real
  architectural issue first — which is now a demonstrated route, not a hypothetical one: the
  zone-catalogue defect ([L-60](KNOWN_LIMITATIONS.md)) was found exactly that way.

---

## 5 · ⚠️ Two things that must not be dropped in the shift to Track B

**Hardware.** Every P-8 phase carries `⬜ unvalidated` for pilot readiness, and Retail Loitering's
reason is specific: zone geometry has **never been measured against a physical camera**
([L-58](KNOWN_LIMITATIONS.md)). Lens distortion, mounting angle and field of view all move where a
floor polygon actually lies. Six analytics capabilities validated only against normalised coordinates
are six capabilities with the same unknown. **This is the largest gap between what the platform can
demonstrate and what it can be deployed into**, and no amount of Track B closes it.

**The dedup window.** ~10 s between observations of a continuously present subject
([L-57](KNOWN_LIMITATIONS.md)) is a floor under _every_ time-based capability, not just loitering. Any
new capability with a threshold under ~20 seconds inherits it, and each one should say so in its own
document rather than assume the reader found this one.

---

## 6 · The definition of done does not change

Every Track B capability ships all eight deliverables **together**: runtime · metrics · browser ·
deployment verification · mutation · nightly · benchmark · governance. Every long verification
registers itself as a nightly stage **in the commit that introduces it**.

⚠️ The mutation test is the one that will be tempting to skip on a capability that is "just
configuration". It is also the one that found that two of Phase 7's eight mutations were **vacuous**,
and that camera-scoped rules had never worked. A capability assembled from existing primitives is
exactly the kind that fails silently, because every component test passes.
