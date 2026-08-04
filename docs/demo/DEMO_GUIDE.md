# Demo Guide

Four scripted demonstrations — retail, warehouse, school, hospital — each runnable end to end from
seeded data, in a browser, with no developer tools.

**Measured:** the retail investigation is **6 clicks and 22 seconds** from the login screen to a
bookmarked moment of evidence. Budget 6–8 minutes per vertical including narration.

---

## Before the room

```sh
infra/docker/demo.sh reset      # ~2 min: wipes demo tenants, re-seeds, registers evidence
infra/docker/demo.sh status     # confirm: 4 tenants · 33 cameras · 18 incidents · 12 evidence
```

Then, in the browser you will present from:

- Sign in once and sign out again, so the session is warm and the bundle is cached.
- Open the console full-screen. **1440×900 or wider.** At 1024 the workspace hides panels to fit —
  honest, but not what you want a prospect's first impression to be.
- Have `demo.sh reset` ready in a terminal you are **not** sharing.

> ⚠️ `demo.sh` only ever touches `tnt_demo_*`. It is safe to run on a deployment that also holds
> real data.

### Sign-in details

| Vertical  | Tenant               | Operator                          |
| --------- | -------------------- | --------------------------------- |
| Retail    | `tnt_demo_retail`    | `security.manager@northgate.demo` |
| Warehouse | `tnt_demo_warehouse` | `site.manager@meridian.demo`      |
| School    | `tnt_demo_school`    | `site.lead@ashford.demo`          |
| Hospital  | `tnt_demo_hospital`  | `security.lead@staldates.demo`    |

Password: whatever `SEED_PASSWORD` is set to in `.env.production`.

> ⚠️ **Say once, early, that the recordings are test patterns.** They are real H.264/H.265 in real
> MP4 containers — the player is genuinely decoding them — but they are not CCTV footage. Saying so
> costs five seconds and protects every other claim you make. See
> [CCTV_READINESS.md](../review/p59/CCTV_READINESS.md).

---

## 1 · Retail — suspected theft, high-value goods

**Northgate Retail Group.** The story: a concealment alert fires, an operator investigates, and the
platform can prove what happened and who looked at it.

| #   | Do                                                                 | Say                                                                                                                                              |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Sign in as `security.manager@northgate.demo`                       | "This is the operator's morning view."                                                                                                           |
| 2   | **Dashboard** — point at _Active incidents_ and _Camera health_    | "Three live incidents; seven of nine cameras online. The trolley-bay camera is offline and the system says so rather than showing a black tile." |
| 3   | **Incidents** in the sidebar                                       | "The queue. Severity, status, camera, age — sorted by what needs attention."                                                                     |
| 4   | Open **"Suspected concealment — Electronics, high-value cabinet"** | "High severity, already under investigation, assigned to loss prevention."                                                                       |
| 5   | **Open investigation**                                             | "This is the investigation workspace. Everything about this incident in one screen."                                                             |
| 6   | Point at **Why this fired**                                        | "The rule that matched, its version, and the event that triggered it. Not a black box — the operator can see the reasoning."                     |
| 7   | Select **Loading bay — east door**, press play                     | "The evidence. Marked ORIGINAL — any brightness or zoom adjustment is labelled and never alters the stored file."                                |
| 8   | Scrub the timeline                                                 | "An hour of recording, scrubbable. Bookmarks and events sit on the same timeline."                                                               |
| 9   | Add a **bookmark**                                                 | "The moment worth returning to."                                                                                                                 |
| 10  | Open **Evidence chain**                                            | "Chain of custody. Every access is recorded — who, when, why. That is what makes this evidence rather than a video file."                        |
| 11  | Read the **operator notes**                                        | "The investigator's own record, appended and immutable."                                                                                         |

**Close with:** "Six clicks from the queue to a bookmarked moment with a full audit trail."

---

## 2 · Warehouse — perimeter intrusion, timeline investigation

**Meridian Logistics.** The story: a line crossing at night, and tracking a subject across cameras.

| #   | Do                                                      | Say                                                                                                                                                                     |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sign in as `site.manager@meridian.demo`                 |                                                                                                                                                                         |
| 2   | **Incidents** → **"Perimeter intrusion — North Fence"** | "Critical. 23:47, outside operating hours."                                                                                                                             |
| 3   | **Open investigation**                                  |                                                                                                                                                                         |
| 4   | Read the operator notes                                 | "The gatehouse already tracked the subject: north fence, then the yard ninety seconds later, heading for Bay 3. Police notified."                                       |
| 5   | **Timeline** panel                                      | "The events around the incident, in order — the intrusion, then the detections that followed it."                                                                       |
| 6   | Switch evidence clips                                   | "Different cameras, same investigation, one timeline."                                                                                                                  |
| 7   | Sidebar → **Locations**                                 | "The estate: perimeter, yard, warehouse, racking, dispatch. Cameras hang off the hierarchy, so a rule can be scoped to _the perimeter_ rather than to nine camera ids." |
| 8   | Sidebar → **Rules** → open _Perimeter intrusion_        | "Rules are versioned. Editing creates a new version; the old one still explains every incident it raised."                                                              |

**Close with:** "The estate is the unit of configuration, not the camera."

---

## 3 · School — restricted area entry

**Ashford Academy Trust.** The story: safeguarding — a restricted area, out of hours, and a
proportionate response.

| #   | Do                                                                     | Say                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sign in as `site.lead@ashford.demo`                                    |                                                                                                                                                                                              |
| 2   | **Incidents** → **"Restricted area entry — Chemical Store door"**      | "Critical, and correctly so — a chemical store in a school."                                                                                                                                 |
| 3   | **Open investigation** → read the notes                                | "16:41, twenty minutes after the science block should have been locked. The corridor camera shows the same person arriving from reception; the site lead is checking the signing-in record." |
| 4   | Show the **resolved** incident _"Restricted area entry — Plant Room"_  | "The same rule, three weeks earlier: a heating engineer, confirmed against the works order, resolved with the reason recorded."                                                              |
| 5   | Show the **closed** incident _"Out-of-hours presence — Playing Field"_ | "A community football letting. The resolution says the letting hours were added to the rule — the system learns by configuration, not by being ignored."                                     |

**Close with:** "Most alerts are explainable. What matters is that the explanation is recorded
against the alert, so the next person does not re-investigate it."

---

## 4 · Hospital — emergency incident review

**St Aldate's Hospital.** The story: patient safety, and evidence retained for a police request.

| #   | Do                                                    | Say                                                                                                                                                                          |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sign in as `security.lead@staldates.demo`             |                                                                                                                                                                              |
| 2   | **Incidents** → **"Patient fall — Ward 4, Corridor"** | "Critical, escalated, nine minutes old."                                                                                                                                     |
| 3   | **Open investigation** → notes                        | "Detected at 03:12, the nurse call raised at the same moment, clinical team attending within forty seconds. Escalated for the incident report."                              |
| 4   | Open **"Aggression — ED Waiting Area"**               | "A different kind of critical."                                                                                                                                              |
| 5   | Read the second note                                  | "_Clip retained for the police request; do not purge before the retention review._ The investigator's instruction lives on the incident, where the next person will see it." |
| 6   | **Evidence chain**                                    | "Every access recorded. If this reaches a court, the question is who saw it and when — and that is answerable."                                                              |

**Close with:** "Safety and security in one queue, with the same custody guarantees."

---

## If something goes wrong

| Symptom                                            | Do this                                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data looks wrong or a previous demo left changes   | `infra/docker/demo.sh reset` — 2 minutes, back to a known state                                                                                                                                      |
| A clip will not play                               | You are probably on the H.265 clip in Chromium. **Show it deliberately** — the console explains that HEVC is a browser licensing decision and the evidence is intact. It demonstrates honest failure |
| A panel shows "not configured for this deployment" | A service is down. `infra/docker/prod.sh ps`                                                                                                                                                         |
| Anything else                                      | [TROUBLESHOOTING.md](../runbooks/TROUBLESHOOTING.md)                                                                                                                                                 |

---

## What not to claim

Be precise about these. Every one of them is written down in
[KNOWN_LIMITATIONS.md](../review/p59/KNOWN_LIMITATIONS.md), and a prospect who discovers one after
you glossed over it will discount everything else you said.

- **No real camera has ever been connected.** The clips are ffmpeg test patterns.
- **No live streaming.** No browser plays RTSP; live view is not built.
- **Reports, exports, dashboards and notifications beyond in-app** are not built. The workspace says
  so on the panels themselves rather than showing an empty box.
- **AI is advisory and nothing has analysed these incidents.** The workspace says "No AI advisor is
  configured. This is not 'no recommendations' — nothing has analysed this incident."
- **Single host, no failover.** Fine for a pilot; say so.
