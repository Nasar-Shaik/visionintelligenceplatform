# Customer Journeys

> **The canonical end-to-end workflows.** One per supported vertical, from the thing that happens in
> the world to the outcome the customer bought the product for.

These are the reference for **QA · customer demonstrations · pilot validation · acceptance testing**.
When any of those four disagree with each other, this file is right and they are wrong.

| Related                                                   | Difference                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [DEMO_GUIDE](../demo/DEMO_GUIDE.md)                       | **How to present** — talk track, timing, what to say when. This file is **what happens** |
| [OPERATOR_GUIDE](../runbooks/OPERATOR_GUIDE.md)           | How one operator uses one screen. This file is the whole arc                             |
| [PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md) | Per-capability state. This file is how capabilities combine into value                   |

---

## ⚠️ Read this before using any journey as evidence

Every journey below is **runnable today** against the demo dataset, end to end, in the deployment.
But the eight stages are not all real in the same way, and the difference decides what may be
claimed.

| Stage             | Today                                                                                                                                                                                                              | From    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| **Trigger**       | The real-world event. Seeded as a description                                                                                                                                                                      | —       |
| **Detection**     | ⚠️ **Seeded.** The event record is real and flows through the real pipeline — but **no camera produced it**. `NullFrameSink` means no frame ever reaches inference (C-19), and no behaviour analyzer exists (C-20) | **P-8** |
| **Incident**      | ✅ **Real.** Raised by the real rule engine from the real event, with the real rule version                                                                                                                        | now     |
| **Investigation** | ✅ **Real.** Workspace, assignment, SLA, activity, comments                                                                                                                                                        | now     |
| **Playback**      | ✅ **Real.** Real media bytes, HTTP 206, signed URLs                                                                                                                                                               | now     |
| **Evidence**      | ✅ **Real.** Custody opened through the real API; integrity hash computed from stored bytes                                                                                                                        | now     |
| **Resolution**    | ✅ **Real.** Lifecycle transitions, immutable history                                                                                                                                                              | now     |
| **Outcome**       | The customer's business result                                                                                                                                                                                     | —       |

**So: six of eight stages are the product. One is the demo dataset. One is the world.**

> **What to say in a demonstration:** _"The detection is from our demonstration dataset — we have not
> connected your cameras yet. Everything after it is the product doing the work."_ Say it once, at the
> start. It costs ten seconds and it is the difference between a demonstration and a
> misrepresentation.

⚠️ **Never claim a behaviour is detected.** The platform detects `person`, `vehicle`, `fire` and
`smoke` — and today not even those from a live camera. Theft, loitering, intrusion, falls, fights and
PPE violations are **seeded event types**, not capabilities, until P-8 closes C-20.

---

## Journey 1 · Retail — suspected theft of high-value goods

**Customer:** Northgate Retail Group · `tnt_demo_retail` · security.manager@northgate.demo
**Vertical value:** shrinkage is 1–2% of turnover, and most of it is never seen.

| Stage             | What happens                                                                                                                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**       | A customer spends four minutes at the high-value cabinet in Electronics, handles an item, and moves toward the exit without passing a checkout                                                                                                                                                                                          |
| **Detection**     | `behavior.theft.suspected` on **Electronics — High Value Cabinet**, confidence 0.87. ⚠️ Seeded — see the table above                                                                                                                                                                                                                    |
| **Incident**      | Rule **"Suspected theft — high-value goods"** matches and raises **"Suspected concealment — Electronics, high-value cabinet"** · severity **high**. The incident names the camera, the zone and the rule _version_ that fired                                                                                                           |
| **Alert**         | The **Inbox** shows one entry — _Suspected concealment_ — however many channels it reached, with a bell in the top bar carrying the waiting count on every screen. The store's own webhook to head-office loss prevention is listed underneath, and if it did not arrive the reason is on the row. ⚠️ It will **not** be retried (L-32) |
| **Investigation** | Security manager acknowledges, opens the workspace. **Why this fired** shows the rule and the triggering event. The timeline shows the preceding `person.detected` events on the same camera — the approach, before the behaviour                                                                                                       |
| **Playback**      | The attached clip plays. Scrub back 40 s to the approach; step frame by frame at the cabinet. **Brightness raised to see into the shelf shadow — the badge changes from ORIGINAL and the stored file is untouched**                                                                                                                     |
| **Evidence**      | Bookmark at the concealment moment, labelled. The **Evidence Chain** panel shows who opened the clip, when, and the reason given. Integrity hash verifies against stored bytes                                                                                                                                                          |
| **Resolution**    | Comment written for the next shift: _"Checkout footage for the same window shows no corresponding transaction. Escalating to the duty manager."_ → **Escalate** to Loss Prevention                                                                                                                                                      |
| **Outcome**       | A loss-prevention case with **defensible evidence** — an unaltered original, a hash, and a custody log naming every person who has opened it. Enough for a disciplinary, an insurance claim or the police                                                                                                                               |

**Acceptance criteria** — all must hold:

- [ ] The incident names **"Electronics — High Value Cabinet"**, never `cam_retail_electronics2`
- [ ] "Why this fired" names the rule **and the version**
- [ ] The ORIGINAL badge changes when brightness is adjusted, and the download still matches the hash
- [ ] The evidence chain records **this operator's** access, with their stated reason
- [ ] After Escalate, the history is append-only — no entry can be edited or removed

---

## Journey 2 · Warehouse — perimeter intrusion, out of hours

**Customer:** Meridian Logistics · `tnt_demo_warehouse` · site.manager@meridian.demo
**Vertical value:** a perimeter breach at 02:00 is either nothing or a theft in progress, and the
difference is minutes.

| Stage             | What happens                                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**       | Movement at the North Fence line at 02:14, outside any scheduled delivery window                                                                                                                                                                                                                                                  |
| **Detection**     | `security.intrusion.detected` on **Perimeter — North Fence**. ⚠️ Seeded                                                                                                                                                                                                                                                           |
| **Incident**      | Rule **"Perimeter intrusion — out of hours"**, scoped to the **Perimeter zone** and to a schedule — not to a list of camera ids · severity **critical**                                                                                                                                                                           |
| **Alert**         | Nobody is on the floor at 02:14, so the **Inbox** is the whole of the first response: one entry, critical, unacknowledged and emphasised, with the waiting count visible from whichever screen the night operator is on. Acknowledging it says _somebody has this_ — and deliberately does not clear the failed webhook beside it |
| **Investigation** | Night operator acknowledges within the SLA. The **timeline** is the centre of this journey: it places the intrusion event, the neighbouring fence cameras' events and the evidence clips on **one time axis**, so the path across the site reads in order                                                                         |
| **Playback**      | Clip from the North Fence, then the East Fence clip from four minutes later — the direction of travel is the finding, and it is visible only because the timeline put them in sequence                                                                                                                                            |
| **Evidence**      | Two clips bookmarked, each labelled with the fence line and timestamp. Both carry independent custody records                                                                                                                                                                                                                     |
| **Resolution**    | Assigned to the day shift with a comment naming the entry point and the direction. → **Resolve** with a stated reason, which is what stops the next person re-investigating it                                                                                                                                                    |
| **Outcome**       | A defensible after-hours security record, a specific fence section to repair, and a pattern that will be visible if it recurs                                                                                                                                                                                                     |

**Acceptance criteria:**

- [ ] The rule is scoped to a **zone**, and a camera added to that zone later is covered without editing the rule
- [ ] The timeline orders events and evidence from **two cameras** on one axis
- [ ] The SLA panel shows time-to-acknowledge against target
- [ ] Resolve **requires** a reason and records it in the immutable history

---

## Journey 3 · School — restricted area entry

**Customer:** Ashford Academy Trust · `tnt_demo_school` · site.lead@ashford.demo
**Vertical value:** safeguarding. The record matters as much as the response.

| Stage             | What happens                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**       | The Chemical Store door opens during a lesson period. Only three staff are authorised                                                                                                                                                                                                                               |
| **Detection**     | `security.intrusion.detected` on **Chemical Store — Door**. ⚠️ Seeded                                                                                                                                                                                                                                               |
| **Incident**      | Rule **"Restricted area entry — Chemical Store"** · severity **critical**. ⚠️ Deliberately critical while the Plant Room equivalent is **high** — the same event type, different severity, because the _zone_ differs. **That is the hierarchy earning its place**                                                  |
| **Alert**         | The **Inbox** carries one entry for the restricted-area entry. The site lead takes it, and the record names **them** — the acknowledger is the authenticated principal, not a string the caller chose. ⚠️ If a colleague reached it first, the second person is told _who_ has it rather than that something failed |
| **Investigation** | Site lead acknowledges immediately. The workspace shows the zone's position in the estate — Site › Building › Floor › Zone — so a governor reading it later knows exactly which door in which building                                                                                                              |
| **Playback**      | Short clip. Zoom to identify uniform and lanyard; the ORIGINAL badge marks the zoom as a display adjustment                                                                                                                                                                                                         |
| **Evidence**      | Bookmarked and commented in **safeguarding language**, written to be read by a designated safeguarding lead who was not there                                                                                                                                                                                       |
| **Resolution**    | → **Resolve**: _"Identified as Year 11 pupil retrieving equipment for a supervised practical. Supervising teacher confirmed. No safeguarding concern; door closer to be repaired."_                                                                                                                                 |
| **Outcome**       | A complete, timestamped, unalterable safeguarding record — the thing an inspection asks for and the thing a paper logbook cannot provide                                                                                                                                                                            |

**Acceptance criteria:**

- [ ] Two rules of the **same event type** carry different severities by zone, and both fire correctly
- [ ] The incident displays the **full location path**, not a zone id
- [ ] Comments are append-only and **cannot be edited after Close**
- [ ] Zoom is marked as a display adjustment and the original is unmodified

---

## Journey 4 · Hospital — patient fall, emergency review

**Customer:** St Aldate's Hospital · `tnt_demo_hospital` · security.lead@staldates.demo
**Vertical value:** a fall is a clinical incident, a duty-of-candour obligation and potentially a
claim. All three need the same record.

| Stage             | What happens                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**       | A patient falls in the Ward 4 corridor at 03:40, unwitnessed                                                                                                                                                                                                                                                                                    |
| **Detection**     | `behavior.fall.detected` on **Ward 4 — Corridor**. ⚠️ Seeded                                                                                                                                                                                                                                                                                    |
| **Incident**      | Rule **"Patient fall detected — Ward 4"** · severity **critical** · **escalated**                                                                                                                                                                                                                                                               |
| **Alert**         | Severity **critical**, so the entry is separated out as one that should not wait for a shift change. ⚠️ The clinical escalation is **not** part of delivery: the platform tells the security lead, and the security lead tells the ward. Email and SMS do not exist yet (L-4), which is the sentence to say before a hospital assumes otherwise |
| **Investigation** | Security lead opens it and immediately **escalates** to the clinical team. The workspace is used as a shared record: assignment, comments and the timeline are the handover between two teams that do not share a system                                                                                                                        |
| **Playback**      | The clip establishes the **time of the fall** and the **time of the response** — the two facts the incident report needs and the two a retrospective account gets wrong                                                                                                                                                                         |
| **Evidence**      | Bookmarks at fall and at first attendance. Custody records every clinical and security viewer, which matters more here than anywhere else in the product                                                                                                                                                                                        |
| **Resolution**    | → **Escalate** to the clinical governance process. The security record is complete; the clinical record continues elsewhere                                                                                                                                                                                                                     |
| **Outcome**       | An objective, timestamped account of an unwitnessed fall and the response interval — for the patient's record, the duty-of-candour conversation, and any subsequent claim                                                                                                                                                                       |

⚠️ **Two things must never be claimed in a hospital demonstration.** The platform does **not**
diagnose, and it does **not** replace clinical observation. It records what a camera saw, with a
custody chain. Say so.

**Acceptance criteria:**

- [ ] Escalate preserves the full history and assignment trail across teams
- [ ] Every viewer of the clip appears in the evidence chain, with a reason
- [ ] Two bookmarks on one clip render distinctly on the timeline
- [ ] Nothing in the UI implies a clinical judgement

---

## What every journey exercises

The four are chosen so that between them they cover the product, not so that there are four of them.

| Capability                                  |    Retail     | Warehouse | School  | Hospital |
| ------------------------------------------- | :-----------: | :-------: | :-----: | :------: |
| Rule scoped to a zone (C-27)                |      ✅       |    ✅     |   ✅    |    ✅    |
| Same event type, different severity by zone |               |           |   ✅    |          |
| Schedule-aware rule                         |               |    ✅     |         |    ✅    |
| Multi-camera timeline (C-34)                |               |    ✅     |         |          |
| Display adjustment, marked (C-36)           | ✅ brightness |           | ✅ zoom |          |
| Multiple bookmarks on one clip (C-35)       |               |    ✅     |         |    ✅    |
| Chain of custody across teams (C-33)        |      ✅       |           |         |    ✅    |
| Escalate                                    |      ✅       |           |         |    ✅    |
| Resolve with reason                         |               |    ✅     |   ✅    |          |
| Close (comments locked)                     |               |           |   ✅    |          |

---

## Running them

```sh
infra/docker/demo.sh reset     # ~2 min · scoped to tnt_demo_* · safe beside real data
```

Every journey is reproducible because the dataset is deterministic — the same seed produces the same
incidents, so a screenshot taken today matches the demo given next week
([DEMO_DATASET](../demo/DEMO_DATASET.md)).

⚠️ **Every organisation, site, camera, operator and incident is invented.** Tenant ids are prefixed
`tnt_demo_` and the names are obviously fictional, because a demo dataset that looks like a real
customer's estate is one screenshot away from being mistaken for one (TD-41).

---

## Adding a vertical

A new vertical is **configuration, not code** — behaviour profiles, rule templates, zone templates,
schedules. No industry noun ever enters a type name
([Product Principle 3](PRODUCT_PRINCIPLES.md)). If a vertical cannot be expressed as configuration,
the generic model is missing a knob, and **adding the knob is the work** — not adding the vertical.

A journey is only added here once it runs end to end in the deployment. A journey that has never been
executed is a script, and this file is not for scripts.
