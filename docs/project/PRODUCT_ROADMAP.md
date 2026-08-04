# Product Roadmap

**Status:** canonical from 2026-08-04. Supersedes the delivery sequence in
[PROJECT_ROADMAP](PROJECT_ROADMAP.md) (kept as history) and re-groups
[PRODUCT_ROADMAP_QUEUE](PRODUCT_ROADMAP_QUEUE.md) by customer capability rather than by contract.

**Governance unchanged.** This document does not authorise anything. Each phase is authorised at
review, on its merits, in sequence. The [PLATFORM_ROADMAP](PLATFORM_ROADMAP.md) layering still holds
and the six foundations stay frozen.

---

## The P-5.x series is closed

P-5 ran from incident management to customer certification in nine slices. It has finished the job
it existed to do:

| Slice | Delivered                                            |
| ----- | ---------------------------------------------------- |
| P-5.1 | Incident lifecycle                                   |
| P-5.2 | Investigation Workspace + frozen workspace contracts |
| P-5.3 | Workspace panels, code-splitting, health surface     |
| P-5.4 | Timeline                                             |
| P-5.5 | Evidence playback                                    |
| P-5.6 | Playback production verification                     |
| P-5.7 | Production verification                              |
| P-5.8 | Production deployment hardening                      |
| P-5.9 | Customer certification                               |

**Recommendation: close P-5.x permanently and do not open P-5.10.**

The reason is not tidiness. A decimal series signals "more of the same slice", and the remaining
work is not more of the same slice — it is a different question. P-5.x asked _"is what we built
correct, deployable and presentable?"_ The answer is yes. The next question is _"is what we built
enough for someone to pay for?"_, and that question is answered by capability, not by another
verification pass.

**No new architecture milestone is proposed.** Two items below need an ADR before implementation
(live video transport, evidence export packaging), and each carries the ADR inside its phase rather
than as a phase of its own.

---

## What a customer can and cannot do today

Measured against the running production deployment on 2026-08-04, not against the design.

| A customer can                                           | A customer cannot                                         |
| -------------------------------------------------------- | --------------------------------------------------------- |
| Sign in, work a queue, investigate, resolve, close       | **See a live camera** — the page is a placeholder         |
| Play recorded evidence with custody and integrity intact | **Edit an existing rule** — the form cannot be saved      |
| Register cameras, probe them, read real health           | **Detect theft, loitering or intrusion** — no analyzer    |
| Author a new rule and watch it raise an incident         | **Export evidence or generate a report**                  |
| Receive and acknowledge notifications                    | **Search across the platform, or save an investigation**  |
| Be branded, deployed, backed up, restored and upgraded   | **Manage users, roles or tenant settings in the console** |

Everything in the right column is customer-visible. Nothing in the right column is an architecture
problem.

---

## The phases

Ordered by customer value against dependency, not by contract-freeze order. Two changes from the
sequence suggested at review, both argued in
[the roadmap review](../review/roadmap-2026-08/README.md):

1. **Search, reporting and dashboards move later.** All three are back-end-absent today (§ below),
   so "complete the UI" for them is not a UI milestone.
2. **Live video and real perception move earlier**, because they are the two gaps a buyer notices
   in the first ten minutes of a demo of a _CCTV_ product.

```
P-6  Make the Product Whole      ← everything with a real API today
P-7  Live Video & Real Perception ← the two gaps a buyer notices first
P-8  Real CCTV & NVR Validation   ← hardware; nothing above is trustworthy without it
P-9  Reporting & Evidence Export
P-10 Search & Saved Work
P-11 Dashboards & Analytics
P-12 Pilot Customer Release
P-13 General Availability
```

### P-6 · Make the Product Whole

**The test for inclusion: the backend already exists, so this is genuinely a UI milestone.**

| Item                                                                              | Why a customer notices                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Fix rule editing** (TD-21)                                                      | A customer cannot change a rule after creating it. Showstopper.                   |
| **Administration screens** — users, roles, tenant settings                        | `/settings` is a placeholder; today user admin needs `curl`                       |
| **System Health page**                                                            | `/health` is a placeholder; the data exists on every service                      |
| **Notification centre**                                                           | Notify has full CRUD + ack; nothing surfaces it outside the bell                  |
| **Camera management depth** — capabilities, probe history, bulk, retire/reinstate | 20 camera routes exist and the client already calls them; the UI shows a fraction |
| **Investigation Workspace completion**                                            | The remaining panel polish from P-5.3                                             |
| **Tenant discovery at login** (TD-40)                                             | An operator must know a tenant slug to sign in                                    |
| **`shortId` crash on missing field** (TD-33)                                      | A contract-required field arriving absent white-screens a page                    |
| **Touch target on the two sliders** (TD-31)                                       | Scrubber and volume are 24 px on touch, not 44 px                                 |

**Deliberately excluded from P-6 and why:** search federation UI, saved investigations, report
generation, background-job monitoring, evidence export. Each has a frozen contract and **zero
implementation on the server** — see the gap table below. Building screens for them means building
the services, which is P-9 and P-10 work wearing a UI label.

### P-7 · Live Video & Real Perception

The two biggest customer-visible gaps, grouped because they unblock from the same place: the media
service's frame path (TD-4).

- Live view transport — **needs an ADR** (HLS / LL-HLS / WebRTC / fMP4-over-WebSocket). TD-28.
- Media → inference frame bus. TD-4, TD-5.
- Upload a recording and analyse it. TD-9 G-2.
- Manifest-driven label → event-type mapping. TD-13.
- Behaviour analyzer — loitering, theft, intrusion, crowding. TD-14.
- Auto-captured evidence from a live incident. TD-15.

⚠️ Until TD-14 ships, the phrase "suspicious activity" is a demo caption, not a product capability.
That is the single largest gap between what the platform is sold as and what it does.

### P-8 · Real CCTV & NVR Validation

No camera or NVR has ever been connected. Plan and minimum hardware:
[CCTV_READINESS](../review/p59/CCTV_READINESS.md), refreshed in
[the roadmap review](../review/roadmap-2026-08/README.md#6--cctv-readiness).

### P-9 · Reporting & Evidence Export

Q-7 (background jobs) → Q-8 (report model) → TD-16 (signed, watermarked export bundles). The job
runner is the prerequisite: a report is a long-running job, and there is no worker in any service.
Evidence export **needs an ADR** — a signed bundle leaving the platform is a custody boundary.

### P-10 · Search & Saved Work

Q-6 (federator) and Q-5 (saved searches, investigations, pins), plus TD-23 (incidents are not
searchable by behaviour). ⚠️ Q-9's access audit lands here and carries the sharpest constraint in
the backlog: **no query route may be exposed until covering indexes are declared** — it will be the
highest-volume collection in the product.

### P-11 · Dashboards & Analytics

Q-4 contracts, then read models. Sequenced last of the feature phases deliberately: a dashboard
aggregates what the other phases produce, and building it first means charting the demo dataset.

### P-12 · Pilot Customer Release

[PILOT_INSTALLATION_CHECKLIST](../runbooks/PILOT_INSTALLATION_CHECKLIST.md) executed against a real
customer, on their hardware. Findings feed back into P-8.

### P-13 · General Availability

Licensing and entitlements · per-tenant branding (TD-42) · rate limiting (TD-39) · retention sweeps
(TD-18) · point-in-time backup (TD-38) · distributed rule state (TD-7) · permission model tightening
(TD-26).

---

## The gap that reshaped this roadmap

Five contract families were frozen during P-5 and **have no consumer anywhere in the repository** —
not in a service, not in the console. Verified 2026-08-04 by searching every service and the console
for the exported type names:

| Frozen contract                      | Server implementation | Console consumer | Phase |
| ------------------------------------ | --------------------- | ---------------- | ----- |
| `SearchResponse` (Q-6)               | none                  | none             | P-10  |
| `SavedSearch` / investigations (Q-5) | none                  | none             | P-10  |
| `Job` / `JobSchedule` (Q-7)          | none                  | none             | P-9   |
| `ReportModel` (Q-8)                  | none                  | none             | P-9   |
| `AccessAuditEntry` (Q-9)             | none                  | none             | P-10  |

No route exists under `/search`, `/jobs`, `/reports`, `/saved-searches` or `/audit` on any of the
ten services.

This is not a defect — it is exactly what "freeze the contract before implementing" was meant to
produce, and the workspace already declares these dependencies `not-built` to the operator rather
than showing an empty panel. It is recorded here because it is the fact that determines what a
UI-completion milestone can honestly contain.

---

## Deferred, with the reason stated

Moved out of the critical path by the "will a paying customer notice this?" test. Full reasoning in
[CUSTOMER_VALUE_MATRIX](../review/roadmap-2026-08/CUSTOMER_VALUE_MATRIX.md).

| Item                                          | Where it went                                    |
| --------------------------------------------- | ------------------------------------------------ |
| TypeScript 7 upgrade (TD-1)                   | Technical debt — no customer-visible effect      |
| Event upcaster, dedup, ordering (TD-10/11/12) | Technical debt — correct today at current scale  |
| Pruned service images (TD-35)                 | Technical debt — deployment size only            |
| CSP `unsafe-inline`, Zod JIT probe (TD-36/37) | Technical debt — recorded, no exposure           |
| Light theme (TD-43)                           | **Product decision required** — see below        |
| Face recognition · LPR · PTZ · audio · GIS    | Post-GA. Biometrics need a DPIA before a schema. |

### One requirement that contradicts a recorded decision

The review asked to "verify dark mode and light mode consistency". **There is no light mode.**
TD-43 records dark-only as a deliberate choice for a SOC product; the token layer would support a
light palette but no light palette exists, so this is a decision to take rather than a check to run.
Recommendation: **stay dark-only through P-8**, and revisit if a pilot customer asks. Building and
maintaining a second palette costs every future component twice.

---

## Related

- [Roadmap review](../review/roadmap-2026-08/README.md) — the analysis behind this document, with Go/No-Go
- [CUSTOMER_VALUE_MATRIX](../review/roadmap-2026-08/CUSTOMER_VALUE_MATRIX.md)
- [PILOT_READINESS_MATRIX](../review/roadmap-2026-08/PILOT_READINESS_MATRIX.md)
- [PRODUCTION_READINESS_MATRIX](../review/p59/PRODUCTION_READINESS_MATRIX.md) · [KNOWN_LIMITATIONS](../review/p59/KNOWN_LIMITATIONS.md)
- [TECH-DEBT](../../tracking/TECH-DEBT.md) · [RISK_REGISTER](RISK_REGISTER.md) · [MASTER_PROGRESS](../tracker/MASTER_PROGRESS.md)
