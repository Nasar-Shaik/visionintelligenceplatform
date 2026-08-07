# Product Roadmap — the execution plan

**Canonical from 2026-08-04.** Built on [IMPLEMENTATION_READINESS](IMPLEMENTATION_READINESS.md),
which classified every remaining capability against the code rather than the design documents.

Supersedes the delivery sequence in [PROJECT_ROADMAP](PROJECT_ROADMAP.md) (kept as history) and
regroups [PRODUCT_ROADMAP_QUEUE](PRODUCT_ROADMAP_QUEUE.md) by customer capability.

**Governance unchanged.** This authorises nothing. Each milestone is authorised at review, in
sequence. The six foundations stay frozen; the [PLATFORM_ROADMAP](PLATFORM_ROADMAP.md) layering
holds. **No milestone below requires a new service.**

---

## P-5.x is closed

Nine slices answered _"is what we built correct, deployable and presentable?"_ — and the answer is
yes. The remaining work answers _"is it enough for someone to pay for?"_, which is answered by
capability, not by another verification pass. **Do not open P-5.10.**

---

## The sequence

```
P-6   Make the Product Whole            ← everything with a backend today
P-7   Alerting Beyond the Console       ← the smallest high-value gap
P-8   Live Video & Real Perception      ← the two gaps a buyer meets first
P-9   Real CCTV & NVR Validation        ← procurement starts at P-6 kickoff
P-10  First Customer Pilot              ← the gate; everything after is informed by it
P-11  Reporting & Evidence Export
P-12  Search, Saved Work & Access Audit
P-13  Dashboards & Analytics
P-14  General Availability
```

### What dependency analysis changed, and what it did not

**Not reordered.** P-6 first (nothing blocks it), reporting before search (both need jobs, reporting
carries more value), dashboards last of the feature phases (it aggregates what the others produce —
building it earlier means charting the demo dataset).

**Changed — three things, each with its reason:**

1. **Alerting was inserted at P-7.** It was not on the roadmap at all. A security manager's first two
   wants are _"show me"_ and _"tell me when something happens"_; the platform answers the second
   only if the operator is already looking at the screen. It is a small milestone — an additive
   contract extension over a transport seam that already exists — with disproportionate value, and a
   pilot customer asks for it on day one. It must precede the pilot.

2. **The pilot moved from last to P-10.** A pilot is not the end of the roadmap; it is the gate that
   tells you whether the rest of the roadmap is right. Everything after P-10 is deliberately
   sequenced _after_ first contact with a real customer and real cameras.

3. **P-9 runs in parallel, because its dependency is not engineering.** It is gated on hardware
   arriving. Procurement begins at P-6 kickoff. Nothing in P-7 or P-8 depends on P-9, and P-9 does
   not depend on P-8's live transport — validating a camera means probing, onboarding and recording
   it, all of which work today.

**Not split, deliberately:** background jobs stays inside P-11 with reporting and export. On its own
it has no customer value whatsoever, and a milestone whose exit criterion is "a worker loop exists"
is exactly the engineering-only work that must not delay customer-visible value.

**Not merged, deliberately:** the in-app notification centre (P-6) and external notification
transports (P-7) are separate. The centre is UI over a live API; the transports need a contract
extension and integrations. They are not tightly coupled — the centre works without email.

---

## P-6 · Make the Product Whole

**Goal:** a customer can do everything the product claims, on every screen it shows them. **Zero
placeholder pages.**

**Test for inclusion:** the backend already exists, so this is genuinely a UI milestone. Every item
was verified to have a live route.

**Dependencies:** none. This is why it is first.

| #   | Work                                                                                                                                                       | Why                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | **Fix rule editing** (TD-21)                                                                                                                               | A customer cannot change a rule after creating it. Shortest path from broken to working |
| 2   | **User administration** — freeze `UpdateUserInput`, add `PATCH /users/:id`, `POST /users/:id/disable`, `POST /users/:id/password`, plus the screen (TD-44) | An offboarded employee keeps access to a security product                               |
| 3   | **Tenant settings screen** over the existing `PATCH /tenants/:tenantId`                                                                                    | `/settings` is a placeholder                                                            |
| 4   | **System Health page** over `/health`, `/ready`, `/streams/health`, `/cameras/:id/health/summary`                                                          | `/health` is a placeholder and the data already exists                                  |
| 5   | **Notification centre** (in-app)                                                                                                                           | Notify has full CRUD and ack; nothing surfaces it beyond the bell                       |
| 6   | **Camera management depth**                                                                                                                                | 20 routes exist, the client already calls them, the UI shows a fraction                 |
| 7   | **Media catalogue** — clips and recordings per camera                                                                                                      | A whole service with no console client                                                  |
| 8   | **Investigation workspace completion**                                                                                                                     | Empty-state UX; six identical "No incident selected" panels                             |
| 9   | **`/live` tells the truth**                                                                                                                                | Not a fake player. An honest statement of what arrives in P-8                           |
| 10  | **Global search box wired or disabled** (TD-46, D-3)                                                                                                       | It currently eats keystrokes and undermines every honest empty state                    |
| 11  | **Command palette promoted to the shell**                                                                                                                  | It already exists inside the workspace                                                  |
| 12  | **Responsive shell below `md`** (TD-45)                                                                                                                    | Sign out is off-screen on a phone                                                       |
| 13  | **Table sort + result count** (TD-47)                                                                                                                      | Invisible at 6 rows; it is the product at 600                                           |
| 14  | **TD-40 · TD-31 · TD-3**                                                                                                                                   | Tenant discovery at login (needs **D-1**), 44 px sliders, zone existence check          |

**Exit criteria**

- [ ] `verify.mjs` — every route renders, zero console errors, **and no route is a placeholder**
- [ ] `overflow.mjs` — nothing painted off-screen at **390 → 1920**, phone included
- [ ] A rule can be created, edited, versioned and rolled back entirely in the console
- [ ] A user can be created, have their role changed, and be **disabled** entirely in the console
- [ ] No string containing an internal slice number (`P2-1.13`) is reachable by a customer
- [ ] **D-1 decided** (tenant identity at sign-in)
- [ ] Full gate green; bundle budget green; no chunk cycles
- [ ] Screenshots of every screen against the **deployment**

**Explicitly out of scope:** search federation, saved investigations, report generation,
background-job monitoring, evidence export. All five have frozen contracts and **no server**.

---

## P-7 · Alerting Beyond the Console

**Goal:** an incident reaches a human who is not looking at the screen.

**Dependencies:** Q-3 contract extension — `NotificationChannelType` is `['in-app','webhook']`
today. The extension is **additive; no ADR**. The transport-agnostic seam already exists in
`channel-sender.ts`.

- Extend the channel contract: email · SMS · Slack · Teams (+ per-transport config and delivery
  state).
- Implement the transports behind the existing sender port.
- **Notification policies** — who is told what, through which channel, under what conditions,
  scoped to a hierarchy node.
- **Escalation** — unacknowledged after _n_ minutes goes further up.
- Delivery state, retry and failure surfaced in the console. ⚠️ A notification that silently failed
  to send is worse than one never configured.
- ⚠️ **Retry with backoff (TD-53 · L-32).** Promoted from debt at the P-6.5 freeze: every delivery is
  attempted exactly **once**, measured, and a redelivered incident skips a channel that already has a
  record — so a customer's webhook that blips for thirty seconds loses those alerts permanently. It
  is visible in the Inbox with its reason, and visibility is not delivery. This is customer-facing
  behaviour, not an internal shortcut, and it belongs to the milestone that owns delivery.
- ⚠️ **An acknowledgement claims the incident, not one delivery (L-36).** Promoted from the P-6.5
  freeze: each delivery is exclusive, but two operators pressing together on an incident that reached
  two channels take one each and both are told it is theirs (the console now names the other person).
  Stopping the second operator needs an owner on the incident and a conditional write — a design
  change, which is why it is here and not in a freeze.

**Exit criteria**

- [ ] A critical incident on a demo camera delivers an email and an SMS to a real address and number
- [ ] A failed delivery is **visible in the console**, with the reason
- [ ] Escalation fires on a genuinely unacknowledged incident, proven by waiting
- [ ] A delivery that failed is **re-sent** and the attempt count on the record proves it (TD-53)
- [ ] Two operators cannot both come away owning the same incident (L-36)
- [ ] Delivery is scoped by hierarchy node, not by a list of camera ids
- [ ] Contract change is additive — no existing consumer changes

---

## P-8 · Live Video & Real Perception

**Goal:** the product does the two things a buyer assumes it already does.

Grouped because both unblock from the same place: the media service's frame path (TD-4). Splitting
them would mean building the frame bus twice.

**Dependencies:** **an ADR for the live transport** (HLS · LL-HLS · WebRTC · fMP4-over-WebSocket) —
a service-sized decision, not a milestone task. **D-4** decides the behaviour set.

**Design: 🔒 [SELECTIVE_AI_PROCESSING](../architecture/future/SELECTIVE_AI_PROCESSING.md) — frozen
2026-08-05**, and it is the authority on the order of this milestone (§14, seven phases). ⚠️ One
correction to the rows below, measured rather than assumed: **packaging and deploying the AI runtime
was missing from this table and is the critical path** — it has no container image and is absent from
the production compose. It is now the first row and the first phase. **ADR-A is decided:** media
pushes frames to the runtime.

| Work                                                                           | Debt     |
| ------------------------------------------------------------------------------ | -------- |
| **Package and deploy the runtime** — nothing else in P-8 runs first            | ⛔ new   |
| Live view transport + the player                                               | TD-28    |
| Frame path — **ADR-A decided: media pushes frames** (replaces `NullFrameSink`) | TD-4     |
| Real ONNX backend as the default, not `stub`                                   | TD-5     |
| **Per-camera processing intent** — record, gate, audit (**ADR-B**)             | ⛔ new   |
| Upload a recording and analyse it                                              | TD-9 G-2 |
| Manifest-driven label → event-type mapping                                     | TD-13    |
| **Behaviour analyzer** — loitering · intrusion · crowding (**D-4**)            | TD-14    |
| Auto-captured evidence from a live incident                                    | TD-15    |

⚠️ **Until TD-14 ships, "suspicious activity" is a demo caption, not a product capability.** This is
the largest gap between what the platform is sold as and what it does. The analyzers themselves are
**built** — they have never been fed a frame, which is a connection problem, not a modelling one.

**Exit criteria**

- [ ] A live camera renders in Chrome, Edge, Firefox and Safari against the **deployment**
- [ ] An uploaded MP4 produces detections → events → an incident → attached evidence, unaided
- [ ] Loitering, intrusion and crowding each fire on recorded footage a **human** labelled first
- [ ] At least one **negative** case per behaviour — a false positive costs a deployment more than a miss
- [ ] Latency budget measured and recorded, not asserted
- [ ] The AI Playground artifact of record accompanies every perception change (§22)

---

## P-9 · Real CCTV & NVR Validation

**Goal:** stop saying "unverified".

⚠️ **Procurement starts at P-6 kickoff.** This is the only milestone gated on something that is not
engineering, and the only one whose start date is not under our control.

**Minimum hardware:** one camera per vendor family — **Hikvision · Dahua · CP Plus · UNV · Axis** —
each exercised in **H.264 and H.265**, plus **one NVR with at least four channels**. A DVR/NVR is a
different integration from a camera, and the channel-path templates in `DVR_TEMPLATES` have never met
one. Roughly two engineer-weeks once hardware is present.

**Coverage:** RTSP against real firmware · ONVIF discovery · NVR channel playback · exported
recordings · H.265 **decode** (probed only today, never decoded — TD-29) · night vision · IR ·
variable bitrate · long recordings · missing frames · corrupted clips.

**Exit criteria**

- [ ] Every camera reaches `first-frame`; codec, resolution and frame rate **measured** per model
- [ ] A deliberately wrong password fails at `authentication`; an unplugged camera fails at `tcp`/`dns`
- [ ] **Every deviation recorded** — vendor, model, firmware, what happened
- [ ] `profiles/cameras/*.json` gains a certified entry per validated model (§21)
- [ ] `CCTV_READINESS.md` becomes a **supported-hardware list** rather than a plan
- [ ] ⚠️ **Nothing is marked certified without hardware evidence** (§18) — no simulation promotes a status

---

## P-10 · First Customer Pilot

**Goal:** a real customer, their cameras, their site, their staff.

**Dependencies:** P-6 blockers cleared · P-7 alerting · P-8 perception · P-9 findings.

Execute [PILOT_INSTALLATION_CHECKLIST](../runbooks/PILOT_INSTALLATION_CHECKLIST.md). Read
[KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md) **with** the customer, not at them. Test the
restore — do not merely run the backup.

**Exit criteria**

- [ ] Installed from [DEPLOYMENT.md](../runbooks/DEPLOYMENT.md) alone, no improvisation. **If a step is wrong, fix the guide**
- [ ] The customer's own operators work a real incident **unaided**
- [ ] A restore is performed and **verified** on their host
- [ ] Every camera deviation fed back against TD-27
- [ ] [CUSTOMER_ACCEPTANCE_CHECKLIST](../review/p59/CUSTOMER_ACCEPTANCE_CHECKLIST.md) signed
- [ ] ⚠️ **The pilot's findings re-open this roadmap.** P-11 onward is provisional until then

---

## P-11 · Reporting & Evidence Export

**Goal:** something a customer can hand to a third party — police, insurer, HR, a regulator.

**Dependencies:** jobs → reports → export, strictly in that order. **An ADR for evidence export**: a
signed bundle leaving the platform is a custody boundary.

- **Background jobs** — a shared `@vip/jobs` package (lease/claim protocol) with the worker loop
  inside each owning service. ⚠️ **Not a new service:** a job runner needs the data of the context it
  serves, and a central job service would need read access to every context — [§5](CONSTRAINTS.md)
  violated by construction.
- Report generation over the frozen `ReportModel` · theme presets in configuration.
- **Signed, watermarked evidence export bundles** (TD-16).
- Background-job monitoring UI.
- **Point-in-time evidence ancestry** (TD-20) — ⚠️ a report currently states the camera is in the
  zone it is in _now_, not where it was when the incident happened. Rarely wrong, catastrophically
  so.

**Exit criteria**

- [ ] A report generates asynchronously, survives a service restart mid-job, and is downloadable
- [ ] An export bundle verifies its own integrity **outside** the platform
- [ ] The custody chain records the export, naming who exported and why
- [ ] A report about a historical incident names the location **as it was**
- [ ] A stuck job is visible and can be retried by an administrator

---

## P-12 · Search, Saved Work & Access Audit

**Goal:** find anything; keep your work; know who looked at what.

**Dependencies:** **an ADR for where federation lives** (gateway vs per-context vs client).

- Per-context `/search` routes; federation holding the caller's permissions.
- Saved searches · saved investigations · pins · recents.
- Incidents searchable by behaviour (TD-23).
- **Access audit** (Q-9).

> ⚠️ **The sharpest constraint in the backlog.** The access audit will be the highest-volume
> collection in the product. **No query route may be exposed until covering indexes are declared**
> ([§40](CONSTRAINTS.md)). A query without one there is not a slow page — it is the query that takes
> the cluster down.

**Exit criteria**

- [ ] Search returns results from ≥4 contexts in one response, permission-filtered per context
- [ ] An entity the caller may not read **never appears**, not even as a count
- [ ] Every audit query is index-covered — proven by `explain`, not by timing
- [ ] Benchmarked at realistic volume before the route is exposed
- [ ] An investigation survives a shift change and reopens exactly as it was left

---

## P-13 · Dashboards & Analytics

**Goal:** answer _"is this getting worse?"_ — the question the current dashboard cannot.

**Dependencies:** Q-4 contract freeze (`DashboardWidget` · `DashboardLayout` · `DashboardMetric` ·
`DashboardFilter` · `DashboardPreset` · `DashboardPermission` — **none exist**), and the data the
earlier phases produce.

- Read models · trends and deltas on every stat · estate-level and executive views · scheduled
  reports over the P-11 job runner.

**Exit criteria**

- [ ] **No number appears without direction** — a sparkline or a delta
- [ ] Every widget is permission-scoped independently
- [ ] Aggregates derive; nothing is a second source of truth ([§46](CONSTRAINTS.md))
- [ ] Zero per-event queries; benchmarked before optimised

---

## P-14 · General Availability

**Goal:** sellable, supportable, multi-customer.

| Work                                                           | Debt / decision                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Licensing & entitlements — camera counts, feature gates, plans | contract missing                                                       |
| **Per-tenant branding**                                        | TD-42, **D-2** (depends on **D-1**)                                    |
| Rate limiting at the edge                                      | TD-39                                                                  |
| Automated retention sweeps and tier transitions                | TD-18                                                                  |
| Point-in-time backup                                           | TD-38                                                                  |
| Distributed rule state (Redis)                                 | TD-7 — ⚠️ a second replica silently under-counts threshold rules today |
| **Narrow `*:read`**                                            | TD-26, **D-6**                                                         |
| Legal hold approval + redaction                                | TD-17 — regulated customers                                            |
| Real-time delivery hardening                                   | TD-19                                                                  |

**Exit criteria**

- [ ] A tenant exceeding its camera entitlement is refused at the boundary, not warned in a log
- [ ] Two replicas produce the same threshold-rule results as one — **measured**
- [ ] A retention sweep deletes on schedule and **respects legal hold**, proven
- [ ] No role holds a wildcard read
- [ ] A restore from a point-in-time backup is verified

---

## Off the critical path

Recorded, not scheduled. **None of these may delay a milestone above.**

TypeScript 7 (TD-1) · tracker doc consolidation (TD-2) · event upcaster (TD-10) · dedup and ordering
notes (TD-11/12) · CI flake (TD-24) · pruned images (TD-35) · CSP notes (TD-36/37) · light theme
(TD-43, **D-5**).

**Post-GA, deliberately not contracts:** Face Recognition · LPR · PTZ · Audio · GIS · Drone · Cloud
Sync · Edge Sync.

⚠️ Face recognition and LPR are **biometric processing** under GDPR Art. 9 and equivalents: a lawful
basis, a DPIA, a retention position and a subject-rights path come _before_ there is a schema to
store a faceprint in. PTZ is the platform's first camera-**control** write path — a security-boundary
decision. Both need an ADR, not an enum.

---

## The three ADRs this roadmap will need

Named now so they are not discovered mid-milestone. Each is carried **inside** its phase; none
justifies an architecture milestone of its own.

| ADR                              | Phase    | Decision                                                                                       |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| Live video transport             | **P-8**  | HLS · LL-HLS · WebRTC · fMP4-over-WebSocket; session authorization; latency budget             |
| Evidence export custody boundary | **P-11** | What a signed bundle asserts once it has left the platform, and what the custody chain records |
| Search federation placement      | **P-12** | Gateway vs per-context vs client, and where permission filtering happens                       |

---

## Related

- ⭐ **[PRODUCT_IMPLEMENTATION_ORDER](PRODUCT_IMPLEMENTATION_ORDER.md) — the sequencing decision of
  2026-08-07**, taken at the close of P-9 Track A. It changes **three** things below and nothing else:
  **C-46 background jobs moves from P-11 to now** (it acquires a demanded consumer instead of being
  built speculatively, so P-11 gets shorter); **C-21 "upload a recording and analyse it" is promoted
  out of the P-8 table into a milestone of its own** ([OFFLINE_VIDEO_PLAN](OFFLINE_VIDEO_PLAN.md)); and
  **PHASE_8_PLAN §4.1/§4.2 are swapped**, because the capability pack's own stated risk — a capability
  that is configurable and unverified — is closed by the offline path and by nothing else. P-7 through
  P-14 keep their order and their reasons.
- [PRODUCT_READINESS](PRODUCT_READINESS.md) — what can be sold, shown, piloted and deployed today, and
  the five things that block a paid production deployment
- [RETAIL_CAPABILITY_PACK](RETAIL_CAPABILITY_PACK.md) · [DEMO_MODE_PLAN](DEMO_MODE_PLAN.md)
- [PHASE_8_PLAN](PHASE_8_PLAN.md) — ⚠️ **what follows P-8 Phase 7**: customer capabilities on two
  tracks (~20 % platform / ~80 % capability), and why the cost curve across capabilities is not flat
- [customer-workflows/](../customer-workflows/) — the customer-facing reference architecture, one
  document per shipped capability
- [IMPLEMENTATION_READINESS](IMPLEMENTATION_READINESS.md) — the matrix this plan is built on
- [Roadmap review](../review/roadmap-2026-08/README.md) · [CUSTOMER_VALUE_MATRIX](../review/roadmap-2026-08/CUSTOMER_VALUE_MATRIX.md) · [PILOT_READINESS_MATRIX](../review/roadmap-2026-08/PILOT_READINESS_MATRIX.md) · [UI_BENCHMARK](../review/roadmap-2026-08/UI_BENCHMARK.md)
- [TECH-DEBT](../../tracking/TECH-DEBT.md) · [RISK_REGISTER](RISK_REGISTER.md) · [MASTER_PROGRESS](../tracker/MASTER_PROGRESS.md)
