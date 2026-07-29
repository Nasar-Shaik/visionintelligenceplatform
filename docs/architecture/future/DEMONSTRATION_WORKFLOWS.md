# Product Demonstration Workflows (Deliverable 11)

_Status: ⏳ Architect Review Pending · These become the **official acceptance criteria for Productization (P2-1)**_

> Four end-to-end customer demonstration workflows. Each step maps to a real service/endpoint (via the
> gateway `/api/:service/*`) and flags the **backend enabler** (G-1…G-6, [PHASE1_EXIT_REVIEW §11]) it
> needs. **A workflow passes only when every step works end-to-end on the demo stack.**

## Workflow 1 — Onboard & Monitor

```
Login → Register Camera → Live Monitoring
```

| Step                            | Backend                              | Enabler      |
| ------------------------------- | ------------------------------------ | ------------ |
| Login                           | `POST /api/identity/auth/login`      | —            |
| Register RTSP camera            | `POST /api/camera/cameras`           | —            |
| (Connect + decode)              | media `StreamSupervisor`             | —            |
| Live video + detection overlays | media live-preview + media→inference | **G-1, G-3** |

**Pass:** operator logs in, adds an RTSP camera, sees live video with live detection boxes + FPS/latency.

## Workflow 2 — Recorded Analysis (primary demo)

```
Upload Video → Analysis → Timeline → Events → Incidents → Alerts
```

| Step                                   | Backend                                | Enabler      |
| -------------------------------------- | -------------------------------------- | ------------ |
| Upload MP4/AVI/MOV                     | media file-source upload → analyze job | **G-2**      |
| Analysis (decode → frames → inference) | media → inference → events             | **G-2, G-3** |
| Timeline + detected events             | `GET /api/events/events` (job-scoped)  | —            |
| Generated incidents                    | `GET /api/workflow/incidents`          | —            |
| Generated alerts                       | `GET /api/notify/notifications`        | —            |

**Pass:** operator uploads a CCTV clip, watches progress, then sees the timeline → events → incidents →
alerts it produced.

## Workflow 3 — Investigate

```
Incident Review → Evidence Viewer → Operator Actions
```

| Step                                                              | Backend                                | Enabler |
| ----------------------------------------------------------------- | -------------------------------------- | ------- |
| Open incident (severity, camera, site, time, rule, correlationId) | `GET /api/workflow/incidents/:id`      | —       |
| Evidence (snapshot, clip, timeline, model, confidence)            | evidence refs → media signed URLs      | **G-4** |
| Actions: acknowledge / assign / resolve / close / comment         | workflow transitions + assign/comments | **G-6** |

**Pass:** operator opens an incident, reviews its evidence package, and acknowledges/assigns/resolves it.

## Workflow 4 — Automation (the vertical, already live-validated)

```
Create Rule → Trigger Detection → Incident → Alert → Acknowledgement
```

| Step              | Backend                                       | Enabler         |
| ----------------- | --------------------------------------------- | --------------- |
| Create rule       | `POST /api/rules/rules` (+ dry-run)           | — (works today) |
| Trigger detection | camera/upload → inference → `event.persisted` | G-3 (live)      |
| Incident raised   | rules → `incident.candidate` → workflow       | — (works today) |
| Alert delivered   | workflow `incident.raised` → notify           | — (works today) |
| Acknowledgement   | `POST /api/notify/notifications/:id/ack`      | — (works today) |

**Pass:** operator writes a rule, a matching detection raises an incident, an alert is delivered and
acknowledged. **The backbone for this was live-validated in P1-8** (candidate → incident → delivered
notification → ack); Productization adds the **UI + live/upload trigger**.

## Acceptance summary (P2-1 Definition of Done)

| #   | Criterion                         | Depends on                           |
| --- | --------------------------------- | ------------------------------------ |
| 1   | Login                             | —                                    |
| 2   | Register an RTSP camera           | —                                    |
| 3   | View live video                   | G-1                                  |
| 4   | Upload a recorded CCTV video      | G-2                                  |
| 5   | Analyze it                        | G-2, G-3                             |
| 6   | Generate events                   | G-3                                  |
| 7   | Generate incidents                | —                                    |
| 8   | Generate alerts                   | —                                    |
| 9   | Review evidence                   | G-4                                  |
| 10  | Demonstrate the complete platform | all + G-5 (live feed), G-6 (actions) |

**Productization is "done" when all four workflows pass on the one-command demo stack** with a bounded
fixture (≤ 8 cameras) and the stated scale envelope (R-005). These criteria are **binding** for P2-1
sign-off.
