# Product roadmap queue — approved in principle, not yet authorised

**Purpose:** the Architect has asked for several contracts to be _frozen before implementation_ and
several modules to be _documented but not built_. This file is where they wait, so that "we agreed
to do this later" is a record rather than a memory.

⚠️ **Nothing here is implemented, and nothing here should be started without explicit
authorisation.** The standing discipline is one milestone at a time, each independently reviewable —
folding these into a slice that is about something else is the failure this file exists to prevent.

Recorded 2026-08-03, from the P-5 architecture review and the P-5.1 authorisation.
**Updated 2026-08-03 (P-5.2.0): Q-1 and Q-2 are discharged; Q-5…Q-9 added.**
**Updated 2026-08-03 (P-5.3): Q-5…Q-9 still untouched, and the reserved list grew — dashboard, notification centre, offline bundle, report preview, branding, profiles, demo mode. ⚠️ All of them now surface in the workspace's health panel as `not-built` with a stated reason, so the gap is visible to an operator rather than only to a reader of this file.**
**Updated 2026-08-03 (P-5.2): Q-5…Q-9 remain untouched — the workspace consumes the frozen
contracts and implements none of them.** ⚠️ The workspace visibly declares Saved Investigations,
Playback and AI Recommendations _unavailable_ rather than empty, so the gap is on the screen rather
than only in this file.

---

> ⚠️ **Regrouped 2026-08-04.** Q-3…Q-9 are unchanged and still unimplemented; what changed is
> where they sit. The roadmap review found that Q-5, Q-6, Q-7, Q-8 and Q-9 have **no consumer
> anywhere in the repository** — no service route, no console call — so a milestone scoped as
> "complete the UI" over them is a back-end milestone wearing a UI label. They are now sequenced
> with the services that must exist first: **Q-7/Q-8 → P-9**, **Q-5/Q-6/Q-9 → P-10**, **Q-4 → P-11**,
> **Q-3 → P-6** (Notify already has the routes). See [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md).

## Queued contract freezes

Each of these was asked for as "define the contract before implementation". They are **their own
milestones**: a contract freeze is a design exercise with a review, not a side-effect of another
slice.

| #       | Contract set                        | Shape asked for                                                                                                                                                                                                                                                                                                                                                | Depends on                                          |
| ------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| ~~Q-1~~ | ~~**Evidence Viewer**~~             | ✅ **Discharged by P-5.2.0.** Playback · bookmarks · annotations · snapshots · markers are frozen in `@vip/contracts` `playback/`; metadata, integrity, downloads and chain of custody already existed in the Evidence contract. ⚠️ **Residual:** AI overlays — no producer (see the AI panel, `availability: deferred`)                                       | —                                                   |
| ~~Q-2~~ | ~~**Offline / recorded playback**~~ | ✅ **Discharged by P-5.2.0.** `PlaybackSession` (derived, not stored) · `PlaybackSegment` · ⚠️ `PlaybackGap` (added — recorded CCTV is not continuous) · `PlaybackMarker` · `PlaybackBookmark` · `PlaybackAnnotation` · `PlaybackCapabilities`. `PlaybackExport` became `JobKind` (`clip.materialise`); `PlaybackFilter` became `PlaybackSessionQuery.include` | —                                                   |
| **Q-3** | **Notification abstraction**        | One transport-agnostic seam; Email · SMS · WhatsApp · Push · Webhook · Slack · Teams plug in without redesign                                                                                                                                                                                                                                                  | Notify context (partially exists: in-app + webhook) |
| **Q-4** | **Dashboards**                      | `DashboardWidget` · `DashboardLayout` · `DashboardMetric` · `DashboardFilter` · `DashboardPreset` · `DashboardPermission`                                                                                                                                                                                                                                      | P-7 Analytics                                       |

**Two constraints that already apply to all four**, so they are not re-litigated later:

- **Evidence stays immutable.** Annotations and bookmarks belong to the **Incident** context and
  reference evidence by id — [CONTEXT_OWNERSHIP](../architecture/CONTEXT_OWNERSHIP.md). Q-1 and Q-2
  must not put a mutable field on an evidence record.
- **The Incident domain publishes events; it does not deliver.** Q-3's transports live entirely
  outside the Incident context. Delivery state is Notify's, not the incident's
  ([INCIDENT_BOUNDARY](../architecture/INCIDENT_BOUNDARY.md), ownership rule 1).

### Added by P-5.2.0 — frozen contracts with no implementation

Each was frozen in `@vip/contracts` on 2026-08-03 and **nothing reads or writes it**. Listed so the
gap between "the shape is settled" and "the feature exists" stays visible.

| #       | Frozen contract                        | What is missing                                                                                                              | Depends on           |
| ------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Q-5** | Saved searches · investigations · pins | No store, no routes. `SEARCH_ENTITIES` declares `investigation` and `saved-search` **unsupported** for this reason           | P-5.2 workspace      |
| **Q-6** | Unified search (`SearchResponse`)      | No federator. ⚠️ Operator search stays unsupported until Identity has an indexed principal search **and** its own permission | Per-context adapters |
| **Q-7** | Background jobs (`Job`, `JobSchedule`) | No worker in any service, no lease reclaimer, no cron evaluator (`JobSchedule.enabled` is `false`)                           | P-5.5 reporting      |
| **Q-8** | Report model (`ReportModel`)           | No generator for any format; theme presets are not defined in configuration yet                                              | Q-7                  |
| **Q-9** | Access audit (`AccessAuditEntry`)      | Nothing writes an entry; no indexes declared, so ⚠️ **no query route may be exposed** until they are (§40)                   | P-5.2 workspace      |

⚠️ **Q-9 carries the sharpest constraint:** the access audit will be the highest-volume collection in
the product. A query without a covering index there is not a slow page — it is the query that takes
the cluster down.

---

## Queued modules — documented, not built

Roadmap items until explicitly approved. Listed so the architecture can be checked against them,
not so they can be started.

| Module                         | Note                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Executive dashboard            | Q-4 contracts first                                                                                              |
| Analytics                      | P-7                                                                                                              |
| Reporting                      | P-5.5 covers incident-shaped reporting only; platform reporting is P-7                                           |
| Notification centre            | Q-3 contracts first                                                                                              |
| License management             | no contract yet                                                                                                  |
| Device health dashboard        | consumes Camera Foundation `CameraHealth`; ⚠️ `Camera.health` is still stored rather than derived (ED-0050/0051) |
| Rule marketplace               | consumes the frozen Rule Designer export/import (P-4.1)                                                          |
| AI model management            | consumes the AI Runtime capability registry; **no structural expansion** (no AI-6)                               |
| Customer administration portal | Platform Core                                                                                                    |
| Installer portal               | carries the deferred installer diagnostics report (P-1 rec 6)                                                    |
| Remote edge management         | no contract yet                                                                                                  |

---

## Demo Readiness v1 — after P-5, before P-6

Explicitly **not a production feature**: a customer demonstration workflow over recorded CCTV, which
is the stated immediate priority. It requires **no live camera**.

The end-to-end path it must show:

```
upload MP4 → playback → AI analysis → events (person · fire · theft · intrusion)
  → incident raised → investigation workspace → evidence viewer → timeline
  → comments → assignment → exported investigation report
```

⚠️ **What this milestone will surface, recorded now rather than discovered on stage.** The demo
crosses every deferred item in the platform at once, and three of them are load-bearing:

| Needed by the demo                          | Current state                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Upload a recorded file and analyse it       | **TD-9 G-2** — the upload→analyse job does not exist                                                                                       |
| Media → inference frame bus                 | **TD-4 / TD-5 / TD-9 G-3** — media has a null frame sink, and the ONNX path is integration-only                                            |
| Detect fire · theft · intrusion             | **TD-13 / TD-14** — the label→event-type map is hardcoded and there is no behaviour analyzer; only person/vehicle/fire/smoke are reachable |
| Auto-captured evidence from a live incident | **TD-15** — the extractor is a no-op pending the media frame source                                                                        |
| Export an investigation report              | **TD-16** — export packaging is not built; P-5.5 would add the incident half                                                               |

Sequencing that honestly: **Demo Readiness v1 is not a thin slice over P-5.** It is the first
milestone that requires the perception path to be real end to end, and it should be scoped with that
stated up front rather than discovered halfway through.

---

## After Demo Readiness v1

### P-6 — Production Polish (Architect, 2026-08-03)

**No new capability.** Entirely about making the product feel like commercial software: UI/UX
refinement across every page · micro-interactions and animations · an accessibility audit ·
responsive optimisation for laptop, ultrawide and 4K security-monitor layouts · performance and
bundle-size work · a review of every empty / error / loading / unavailable state · end-to-end
workflow testing · white-label branding completion · demo script and sample-data polish.

⚠️ Sequenced **after** Demo Readiness v1 deliberately: polishing screens whose data path is still a
no-op (TD-4/5/9/13/14/15) polishes the wrong thing. The demo is what makes the workflows real enough
to be worth refining.

### Long-term reservations — recorded, and deliberately **not** contracts

Face Recognition · License Plate Recognition · PTZ · Audio Analytics · GIS Maps · Drone Cameras ·
Cloud Sync · Edge Synchronization. All post-first-production-release.

⚠️ **These are listed here rather than reserved as schemas, and the distinction is not stylistic.**
A type carrying no producer is already a cost; a `face-recognition` type is more than that. Face
recognition and LPR are **biometric and regulated processing** under GDPR Art. 9 and equivalent
regimes: they need a lawful basis, a DPIA, a retention position and a subject-rights path _before_
there is a schema to store a faceprint in, not after. Freezing the vocabulary first is how a
platform acquires the capability by accident and the compliance obligation by surprise.

PTZ is different in kind — it is the platform's **first camera-control write path**, and every
camera contract to date is read-only. That is a security boundary decision (who may move a camera,
and what the audit record of a moved camera looks like) and deserves its own ADR rather than an
enum.

---

## Related

- [P-5 architecture](../architecture/P-5-INCIDENT-MANAGEMENT.md) · [INCIDENT_BOUNDARY](../architecture/INCIDENT_BOUNDARY.md) · [CONTEXT_OWNERSHIP](../architecture/CONTEXT_OWNERSHIP.md)
- [PLATFORM_ROADMAP](PLATFORM_ROADMAP.md) · [TECH-DEBT](../../tracking/TECH-DEBT.md) · [MASTER_PROGRESS](../tracker/MASTER_PROGRESS.md)
