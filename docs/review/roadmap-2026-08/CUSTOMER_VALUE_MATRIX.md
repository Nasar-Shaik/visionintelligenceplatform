# Customer Value Matrix

Every open backlog item, put to one question:

> **Will a paying customer notice this?**

Three answers. **Yes** — it stays on the critical path. **Only at scale / only on failure** — it is
real, it is not urgent, it is scheduled where the pain first appears. **No** — it leaves the critical
path for Technical Debt or Future Enhancement, and it does not get to delay anything.

Sources: [tracking/TECH-DEBT.md](../../../tracking/TECH-DEBT.md) (43 entries),
[PRODUCT_ROADMAP_QUEUE](../../project/PRODUCT_ROADMAP_QUEUE.md) (Q-3…Q-9), and the three
placeholder routes in `apps/console/src/app/router.tsx`. Verified against the repository on
2026-08-04.

---

## Yes — a customer notices, on day one

These are the critical path. Grouped by the capability a customer would name, not by the service
that owns them.

### Live Monitoring

| Item                                                            | Notice                                                                                                                                            | Phase   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **No live camera view** (TD-28) — `/live` is a placeholder page | Immediate. It is a CCTV product; a buyer clicks "Live" first. Not a partial feature: no browser plays RTSP, so this needs a repackager and an ADR | **P-7** |

⚠️ This is the single most visible gap in the product and it is one click from the login screen.

### Perception — the thing that makes it _intelligence_

| Item                                                                      | Notice                                                                                                                                           | Phase   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| **No behaviour analyzer** (TD-14) — loitering, theft, intrusion, crowding | The demo says "suspicious activity". The platform detects `person`. A customer discovers this on their own footage, at the worst possible moment | **P-7** |
| **Media frame sink is null** (TD-4)                                       | Real cameras produce no detections. Everything downstream is unexercised on live input                                                           | **P-7** |
| **Inference default is the `stub` backend** (TD-5)                        | Same                                                                                                                                             | **P-7** |
| **Label → event-type map hardcoded** (TD-13)                              | Only person/vehicle/fire/smoke can ever be reached                                                                                               | **P-7** |
| **Upload a recording and analyse it** (TD-9 G-2)                          | The single most demonstrable capability the product could have, and it does not exist                                                            | **P-7** |
| **Incident evidence extractor is a no-op** (TD-15)                        | An incident is raised with no clip attached. The operator has to go find it                                                                      | **P-7** |

### Rules

| Item                                                                                                                                | Notice                                                                                            | Phase                |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------- |
| **A rule cannot be edited** (TD-21) — the form fails client-side validation on `lifecycle` and `severity`, so the PATCH never fires | Within an hour of a pilot. A customer will change their first rule almost immediately, and cannot | **P-6 — first item** |
| **Incidents not searchable by behaviour** (TD-23)                                                                                   | Only once behaviour detection exists                                                              | P-10                 |

### Evidence & Reporting

| Item                                                                | Notice                                                                                                                                              | Phase   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **No evidence export** (TD-16) — no signed, watermarked bundle      | "Send this to the police / to HR / to the insurer" is why the customer bought it. Needs an ADR: a bundle leaving the platform is a custody boundary | **P-9** |
| **No report generation** (Q-8)                                      | Every enterprise buyer asks in week one                                                                                                             | **P-9** |
| **No background job runner** (Q-7)                                  | Invisible on its own — but nothing above can ship without it                                                                                        | **P-9** |
| **Evidence resolves _current_ ancestry, not point-in-time** (TD-20) | Rarely, and catastrophically: a report states the camera is in the zone it is in now, not where it was                                              | **P-9** |

### Administration & Onboarding

| Item                                                                                                                   | Notice                                                                                                       | Phase   |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------- |
| **`/settings` is a placeholder** — no user, role or tenant management UI                                               | An administrator's second task, after signing in, needs `curl` today                                         | **P-6** |
| **`/health` is a placeholder** — every service already exposes the data                                                | An administrator asks "is it working?" on day one                                                            | **P-6** |
| **Tenant typed by hand at login** (TD-40)                                                                              | Every operator, every sign-in, forever                                                                       | **P-6** |
| **Camera management depth** — 20 camera routes exist and the API client already calls them; the UI surfaces a fraction | An installer onboarding 50 cameras; bulk, probe history and capability refresh are all built and unreachable | **P-6** |
| **`*:read` grants every future read permission** (TD-26)                                                               | A customer's security review, not their operators                                                            | P-13    |

### Search & Collaboration

| Item                                               | Notice                                                                                                             | Phase    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| **No unified search** (Q-6)                        | Real, but second-order: the queue is filterable and an estate of 50 cameras is browsable. It becomes urgent at 500 | **P-10** |
| **No saved investigations** (Q-5)                  | An investigator working a case across shifts                                                                       | **P-10** |
| **Notification centre not surfaced** (Q-3 partial) | Notify already has full CRUD and ack. This one is genuinely a UI job                                               | **P-6**  |

### Reliability a customer feels

| Item                                                      | Notice                                                        | Phase   |
| --------------------------------------------------------- | ------------------------------------------------------------- | ------- |
| **`shortId` crashes on a missing required field** (TD-33) | A white page. Rare, total, and unexplainable to the customer  | **P-6** |
| **Two sliders are 24 px on touch** (TD-31)                | An operator on a tablet, missing the scrubber                 | **P-6** |
| **H.265 never actually decoded** (TD-29)                  | The moment their cameras are H.265, which is most new estates | **P-8** |
| **No hardware has ever been connected** (TD-27)           | This is the whole of P-8                                      | **P-8** |

---

## Only at scale, or only on failure

Real, scheduled where the pain first appears, and **not allowed to delay anything above**.

| Item                                                  | First felt when                                                  | Phase       |
| ----------------------------------------------------- | ---------------------------------------------------------------- | ----------- |
| Rule windowed state is in-process (TD-7)              | A second replica is started — threshold rules then under-count   | P-13        |
| No retention sweeps (TD-18)                           | The disk fills. Predictable and dateable from the capacity model | P-13        |
| Backups are per-collection, not point-in-time (TD-38) | A restore, once — and then it matters a great deal               | P-13        |
| No rate limiting at the edge (TD-39)                  | A security review, or an incident                                | P-13        |
| Real-time delivery hardening (TD-19)                  | Beyond the bounded SSE fan-out                                   | P-13        |
| Branding is per-deployment, not per-tenant (TD-42)    | The first reseller, or the first multi-brand customer            | P-13        |
| Camera `zoneId` not confirmed to exist (TD-3)         | A camera assigned to a deleted zone vanishes from the tree       | P-6 (cheap) |
| Legal hold approval + redaction (TD-17)               | A regulated customer — hospital, school                          | P-13        |
| Access token expiry mid-playback unforced (TD-34)     | A long investigation crossing the token lifetime                 | P-9         |

---

## No — off the critical path

Recorded, not scheduled. **None of these may delay customer-visible value**, and none should be
raised as a reason to defer a phase.

| Item                                                | Why it does not compete for a slot                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| TypeScript 5.9.3 rather than 7.x (TD-1)             | Zero customer-visible effect. Blocked on `typescript-eslint` regardless      |
| Tracker doc consolidation (TD-2)                    | Internal documentation layout                                                |
| No cross-major event upcaster (TD-10)               | One major version exists. Build it when there are two                        |
| Dedup is layered and identity-based (TD-11)         | Correct today; documented; measured at 3,000 events                          |
| Ordering guarantees documented not enforced (TD-12) | Same                                                                         |
| Flaky timing assertion under parallel load (TD-24)  | CI noise. Annoying to us, invisible to them                                  |
| Service images carry the whole workspace (TD-35)    | Image size. `pnpm deploy` would prune it; nobody is paying for the megabytes |
| CSP needs `style-src 'unsafe-inline'` (TD-36)       | Recorded, understood, no exposure                                            |
| Zod v4 JIT probe trips CSP (TD-37)                  | Caught and handled; a console line in dev                                    |
| Demo dataset is invented (TD-41)                    | Process discipline, not a defect                                             |

### Future enhancement — deliberately not contracts

Face Recognition · Licence Plate Recognition · PTZ · Audio Analytics · GIS Maps · Drone · Cloud Sync
· Edge Sync.

⚠️ Two of these are not simply "later". Face recognition and LPR are **biometric processing** under
GDPR Art. 9 and equivalents: they need a lawful basis, a DPIA, a retention position and a
subject-rights path _before_ there is a schema to store a faceprint in. PTZ is the platform's first
camera-**control** write path and is a security-boundary decision. Both need an ADR, not an enum.

---

## The one that is a decision, not a task

**Light theme (TD-43).** The review asked to verify light and dark mode consistency. Dark-only is a
recorded, deliberate choice for a SOC product; the token layer would support a light palette, but no
light palette exists — so there is nothing to verify.

Put to the question: _would a paying customer notice?_ Only if they asked for it. No pilot has.
A second palette costs every future component twice, forever.

**Recommendation: stay dark-only through P-8. Revisit when a customer asks, not before.**

---

## What this matrix changed

Three things, each of which would otherwise have consumed a milestone:

1. **Search, reporting and dashboards were scheduled first and are now scheduled later** — they are
   back-end-absent, so a "complete the UI" milestone for them is a back-end milestone in disguise.
2. **Live view and behaviour detection moved earlier** — they are the two gaps a buyer notices in
   the first ten minutes, and neither was on the near roadmap at all.
3. **Ten items left the critical path entirely.** None of them was ever going to be the reason a
   customer signed or did not sign.
