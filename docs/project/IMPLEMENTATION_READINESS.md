# Implementation Readiness Matrix

**Verified against the repository and the running production deployment on 2026-08-04.** Every
classification below was derived by searching for the symbol, the route and the client call — not
from the design documents, which describe intent rather than state.

Method, so a later reader can re-run it:

| Question                          | How it was answered                                                     |
| --------------------------------- | ----------------------------------------------------------------------- |
| Is the contract frozen?           | `grep -rl "export const <Symbol>" packages/contracts/src`               |
| Does the backend exist?           | Route paths extracted from every `services/*/src/transport/routes/*.ts` |
| Is it reachable from the console? | Paths in `apps/console/src/lib/api/*.ts` and the route tree             |
| Does it render?                   | `docs/review/roadmap-2026-08/verify.mjs` against the deployment         |

---

## The four categories

| #     | Category                           | Meaning                                                                 |
| ----- | ---------------------------------- | ----------------------------------------------------------------------- |
| **1** | **Ready to implement immediately** | Contract frozen · service route exists · the UI can be connected today  |
| **2** | **Backend missing**                | Contract frozen · no service implements it · owning service named below |
| **3** | **Contract missing**               | A backend cannot start honestly until something is frozen               |
| **4** | **Product decision required**      | Blocked on a UX or business decision, not on engineering                |

⚠️ **A module appears in exactly one category — its _gating_ constraint.** User administration needs
both a contract and a backend; it is filed under **Contract missing**, because that is what must
happen first and nothing else can start until it does.

---

## The headline

> **No remaining capability requires a new service.** Every gap maps to a service that already
> exists. The "no new services" constraint survives the whole remaining roadmap.

|                                                               | Count |                                                                                                                            |
| ------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| **1 · Ready to implement immediately**                        | 14    | The whole of P-6, and more                                                                                                 |
| **2 · Backend missing** (contracts frozen, no implementation) | 6     | Search · saved work · jobs · reporting · evidence export · access audit                                                    |
| **3 · Contract missing**                                      | 5     | User mutation · live video transport · external notification transports · dashboards · licensing                           |
| **4 · Product decision required**                             | 6     | Tenant identity · per-tenant branding · global search behaviour · behaviour catalogue · light theme · permission narrowing |
| **Already delivered**                                         | 14    | Production-verified; listed for completeness, not re-implementation                                                        |

---

## Category 1 · Ready to implement immediately

Contract frozen, service route live, permission granted. **Nothing on this list needs a decision, a
freeze or a new service.**

| Module                                      | Backend                                                                                                                                                          | Frontend                                                     | Contract                        | Dependencies            | Order  | Customer value                                   | Demo value   | Pilot blocker |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------- | ----------------------- | ------ | ------------------------------------------------ | ------------ | ------------- |
| **Rule editing**                            | ✅ `PATCH /rules/:id` + versions · diff · rollback · dry-run · audit                                                                                             | ⛔ **form cannot submit** (TD-21)                            | ✅ frozen                       | none                    | **1**  | **Critical** — a customer cannot change a rule   | High         | **YES**       |
| **User administration**                     | ⛔ see Cat 3                                                                                                                                                     | ⛔ none                                                      | ⛔ see Cat 3                    | _filed in Cat 3_        | —      | Critical                                         | Low          | **YES**       |
| **Tenant settings**                         | ✅ `PATCH /tenants/:tenantId`                                                                                                                                    | ⛔ `/settings` is a placeholder                              | ✅ frozen                       | none                    | **2**  | High                                             | Med          | No            |
| **System health page**                      | ✅ `/health` + `/ready` on all 10 services; `/cameras/:id/health/summary`; `/streams/health`                                                                     | ⛔ `/health` is a placeholder                                | ✅ frozen                       | none                    | **3**  | High — first question an admin asks              | High         | No            |
| **Notification centre (in-app)**            | ✅ `GET/POST /notifications`, `/notifications/:id/ack`, `/notification-channels`                                                                                 | ⚠️ bell only; no centre                                      | ✅ frozen (`in-app`, `webhook`) | none                    | **4**  | High                                             | High         | No            |
| **Camera management depth**                 | ✅ **20 routes** — probe · probes history · capabilities · refresh · bulk · discover · retire · reinstate · enable · disable · confidence · decisions · evidence | ⚠️ client calls all of them; UI surfaces a fraction          | ✅ frozen                       | none                    | **5**  | High — an installer onboarding 50 cameras        | High         | No            |
| **Investigation workspace completion**      | ✅ incidents · timeline · chain · sla · activity · bookmarks · notes · assign                                                                                    | ⚠️ panels complete, empty-state UX poor                      | ✅ frozen                       | none                    | **6**  | High                                             | **Critical** | No            |
| **Media catalogue (clips & recordings)**    | ✅ `/clips`, `/recordings`, `/streams`, `+/playback`                                                                                                             | ⛔ **no console client at all**                              | ✅ frozen                       | none                    | **7**  | High — "show me everything this camera recorded" | High         | No            |
| **Global search box**                       | n/a — client-side over loaded data                                                                                                                               | ⛔ **inert input** (TD-46)                                   | n/a                             | Cat 4 decision on scope | **8**  | Med — but it _lies_ today                        | High         | No            |
| **Command palette in the shell**            | n/a                                                                                                                                                              | ⚠️ exists in the workspace only                              | n/a                             | none                    | **9**  | Med                                              | High         | No            |
| **Responsive shell below `md`**             | n/a                                                                                                                                                              | ⛔ sidebar 240 px at 390 px; **Sign out off-screen** (TD-45) | n/a                             | none                    | **10** | Med                                              | Low          | No            |
| **Table affordances** (sort · count · bulk) | ✅ keyset pagination exists                                                                                                                                      | ⛔ none (TD-47)                                              | ✅ frozen                       | none                    | **11** | High **at 600 rows**, invisible at 6             | Low          | No            |
| **Camera zone existence check**             | ⚠️ shape-validated only (TD-3)                                                                                                                                   | n/a                                                          | ✅ frozen                       | none                    | **12** | Low–Med                                          | Low          | No            |
| **Touch targets on the two sliders**        | n/a                                                                                                                                                              | ⛔ 24 px, not 44 px (TD-31)                                  | n/a                             | none                    | **13** | Low                                              | Low          | No            |

## Category 2 · Backend missing — contracts frozen, nothing implements them

⚠️ **These five contract families have zero consumers anywhere in the repository.** No service route
exists under `/search`, `/jobs`, `/reports`, `/saved-searches` or `/audit` on any of the ten
services. This is the fact that makes a "UI-only" milestone over them impossible.

| Module                                     | Owning service                                                                              | Backend                                                                                | Frontend                             | Contract                                                                                                        | Dependencies                                         | Order | Customer value                                             | Demo value | Pilot blocker |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----- | ---------------------------------------------------------- | ---------- | ------------- |
| **Background jobs**                        | **shared `@vip/jobs` package + a worker loop in each owning service** — _not a new service_ | ⛔ no worker, no lease reclaimer, no cron evaluator (`JobSchedule.enabled` is `false`) | ⛔ none                              | ✅ `Job`, `JobSchedule` frozen                                                                                  | none                                                 | **1** | **Nil on its own** — and nothing below ships without it    | Nil        | No            |
| **Report generation**                      | **workflow** (reporting is incident-shaped; P-5.5 scoped it there)                          | ⛔ no generator for any format; theme presets undefined                                | ⛔ none                              | ✅ `ReportModel`, `RenderedReport`, `ReportRequest`, `ReportFormat`, `ReportSection`, `ReportProvenance` frozen | jobs                                                 | **2** | **High** — every enterprise buyer asks in week one         | High       | No            |
| **Evidence export bundles**                | **evidence**                                                                                | ⛔ not implemented (TD-16)                                                             | ⛔ none                              | ✅ `EvidenceExportProfile`, `ExportProfileId` frozen; `watermark` is a derived kind                             | jobs · **ADR (custody boundary)**                    | **3** | **High** — "send this to the police" is why they bought it | High       | No            |
| **Saved investigations · searches · pins** | **workflow** (the Incident context owns investigations — CONTEXT_OWNERSHIP)                 | ⛔ no store, no routes                                                                 | ⚠️ panel declares itself `not-built` | ✅ `SavedSearch`, `SavedInvestigation`, `PinnedItem`, `RecentItems`, `SavedWorkspaceLayout` frozen              | none                                                 | **4** | Med–High — an investigator working a case across shifts    | Med        | No            |
| **Unified search federation**              | **gateway** (holds caller permissions, already fans out) **+ `/search` on each context**    | ⛔ no federator                                                                        | ⛔ inert box                         | ✅ `SearchQuery`, `SearchResponse`, `SEARCH_ENTITIES` frozen                                                    | saved work · **ADR (where federation lives)**        | **5** | Med at 50 cameras, **High at 500**                         | Med        | No            |
| **Access audit**                           | **evidence** (audit is an evidence family — PLATFORM_ROADMAP)                               | ⛔ nothing writes an entry                                                             | ⛔ none                              | ✅ `AccessAuditEntry` frozen                                                                                    | ⚠️ **covering indexes before any query route** (§40) | **6** | Med — compliance and enterprise security review            | Low        | No            |

> ⚠️ **The sharpest constraint in the backlog.** The access audit will be the highest-volume
> collection in the product. A query without a covering index there is not a slow page — it is the
> query that takes the cluster down.

## Category 3 · Contract missing — a backend cannot start honestly

| Module                               | What must be frozen first                                                                                                                                                                                                                                  | Size of the freeze                                                                                            | Owning service             | Order | Customer value                                                                                            | Demo value   | Pilot blocker                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- | ----- | --------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------- |
| **User mutation & deactivation**     | `UpdateUserInput` — which fields are mutable, and whether deactivation is a status transition or a delete. `CreateUserInput` exists; its sibling does not                                                                                                  | **Trivial.** One input schema, ~30 lines. No design exercise — but nothing can be written until it is decided | **identity**               | **1** | **Critical** — an offboarded employee keeps access to a security product                                  | Low          | **YES**                                   |
| **External notification transports** | `NotificationChannelType` is `z.enum(['in-app','webhook'])`. Email · SMS · push · Slack · Teams · WhatsApp need the **additive** enum extension plus per-transport config and delivery-state shapes (Q-3)                                                  | **Moderate.** Additive; no ADR. The transport-agnostic seam already exists in `channel-sender.ts`             | **notify**                 | **2** | **High** — "tell me when something happens" is the second thing a security manager wants, after "show me" | High         | No — but a pilot customer asks on day one |
| **Live video transport**             | No contract describes a browser-playable live stream. `/streams/:cameraId/start` is _ingestion control_, not delivery. Needs the transport decision (HLS · LL-HLS · WebRTC · fMP4-over-WebSocket), the session/authorization shape, and the latency budget | **Large — and it needs an ADR.** This is a service-sized decision, not a milestone task (TD-28)               | **media**                  | **3** | **Critical** — `/live` is one click from the login screen of a CCTV product                               | **Critical** | No (if stated up front)                   |
| **Dashboards & analytics**           | `DashboardWidget` · `DashboardLayout` · `DashboardMetric` · `DashboardFilter` · `DashboardPreset` · `DashboardPermission` (Q-4). **None exist**                                                                                                            | **Moderate.** A design exercise with a review, not a side effect of a UI slice                                | **workflow** (read models) | **4** | Med — impressive, rarely the reason to buy                                                                | High         | No                                        |
| **Licensing & entitlements**         | Nothing exists: no entitlement, no camera-count enforcement, no feature gate, no plan                                                                                                                                                                      | **Large.** A commercial model decision before a schema                                                        | **tenant**                 | **5** | Nil to the operator, **essential to the business**                                                        | Nil          | No                                        |

## Category 4 · Product decision required

Engineering is blocked on an answer, not on code. **Each of these has a recommendation** — the
decision still has to be taken.

| #       | Decision needed                                                                                                                                                                  | Why it blocks                                                                                                                                            | Recommendation                                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-1** | **How is a tenant identified at sign-in?** Today an operator types a slug from memory (TD-40). Options: email-domain lookup · subdomain per tenant · a tenant picker after email | Blocks the login redesign **and D-2** — branding is fetched _before_ sign-in, so per-tenant branding is impossible until the tenant is knowable pre-auth | **Email-domain lookup**, falling back to a picker. It needs no DNS work, no per-tenant deployment, and it makes D-2 solvable                                                                                                       |
| **D-2** | **Per-tenant branding, or per-deployment?** (TD-42)                                                                                                                              | A reseller serving several brands needs several installations today                                                                                      | **Depends on D-1 — decide them together.** With domain lookup, `/branding.json?tenant=…` becomes possible at GA                                                                                                                    |
| **D-3** | **What does the global search box search before federation exists?** (TD-46)                                                                                                     | It currently eats keystrokes                                                                                                                             | **Wire it to filter the loaded queue and estate now** — both are already client-side — and replace it with the federated search at P-12. Never ship an inert input                                                                 |
| **D-4** | **Which behaviours ship first?** The catalog names loitering · theft · fight · fall · intrusion · crowding                                                                       | Determines the P-8 perception scope and what the product may be sold as                                                                                  | **Loitering · intrusion · crowding first.** All three are geometric and time-windowed — provable from track data. Theft is inferential and will produce false positives on a customer's real footage, which costs more than a miss |
| **D-5** | **Does a light theme ship?** (TD-43)                                                                                                                                             | The token layer supports it; no palette exists                                                                                                           | **No, through P-9.** Dark is right for a control room, no pilot has asked, and a second palette costs every future component twice. Revisit on a customer requirement                                                              |
| **D-6** | **Narrow `*:read`?** `operator` and `viewer` both hold it, so every future read permission is granted retroactively to the least privileged role (TD-26)                         | Every new read permission silently widens two roles                                                                                                      | **Enumerate read permissions per role at P-14**, before GA and before a customer's security review                                                                                                                                 |

---

## Already delivered — production-verified

Listed so nothing here is re-planned. Each was verified against a deployment, not a dev server.

| Module                                                 | Evidence                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Authentication · session · refresh · logout            | Sign-out clears investigative residue; verified                                                                     |
| **Tenant isolation, fail-closed**                      | 25/25 security checks (P-5.8). A tenant header was ignored in favour of the token claim — re-confirmed this session |
| Location hierarchy                                     | 101,001 nodes in one tenant; frozen P-3                                                                             |
| Camera registry · onboarding · discovery · bulk        | 20 routes; real health, never assumed                                                                               |
| Event pipeline                                         | 3,000 detections → 3,000 events → 27 incidents, ≥600 events/s, 1,309 B/event                                        |
| Rule engine · versions · rollback · dry-run            | Complete server-side; **authoring blocked by TD-21**                                                                |
| Incident lifecycle · assignment · SLA · activity       | P-5.1                                                                                                               |
| Investigation workspace · timeline · bookmarks         | P-5.2–P-5.4                                                                                                         |
| **Evidence playback · custody · integrity**            | HTTP 206 real media bytes and 7 intact custody entries after a full restore                                         |
| In-app notifications · webhook delivery                | P1-8                                                                                                                |
| **Deployment · backup · restore · upgrade · rollback** | Volumes destroyed, stack rebuilt, restore verified **twice**                                                        |
| Runtime white-label branding                           | Proven by re-branding a **running** container                                                                       |
| Demo Mode                                              | `demo.sh reset`, one command, scoped to `tnt_demo_*`                                                                |
| Real-time delivery (SSE)                               | Bounded fan-out, per-tenant subject filter                                                                          |

---

## The explicit classifications requested

### Everything production-ready

The fourteen rows immediately above. All are deployed, exercised under failure, and survive a
destroy-and-restore.

### Everything demo-ready

**All fourteen, plus the demo dataset** — four tenants, 33 cameras, 126 events, 18 incidents across
the full lifecycle. Every one of the eleven routes renders with zero console errors.

**Not demo-ready:** `/live`, `/settings` and `/health` are placeholder pages, and one of them says
"coming in P2-1.13" to a customer.

### Everything pilot-ready

Everything production-ready **except** the two blockers:

- **TD-21** — a rule cannot be edited.
- **TD-44** — a user account cannot be disabled.

Both are P-6. Neither is architectural.

### Everything still architecture-only

Contracts frozen, **nothing built, nothing reads or writes them**:

`SearchQuery`/`SearchResponse` · `SavedSearch`/`SavedInvestigation`/`PinnedItem` ·
`Job`/`JobSchedule` · `ReportModel`/`RenderedReport` · `AccessAuditEntry` ·
`EvidenceExportProfile`.

This is not a defect. It is what "freeze the contract before implementing" was meant to produce, and
the workspace already declares these dependencies `not-built` to the operator rather than showing an
empty panel. It is recorded because it determines what a UI milestone can honestly contain.

### Everything blocked by a missing service

> **Nothing.**

Every remaining capability maps to a service that already exists:

| Capability                                      | Owner                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| User mutation                                   | identity                                                              |
| Tenant settings · licensing                     | tenant                                                                |
| Live video transport · media catalogue UI       | media                                                                 |
| Perception · behaviour · upload-and-analyse     | media → `ai/inference` (existing runtime)                             |
| Reporting · saved work · dashboards read models | workflow                                                              |
| Evidence export · access audit                  | evidence                                                              |
| External notification transports                | notify                                                                |
| Search federation                               | gateway + per-context routes                                          |
| Background jobs                                 | a shared **package**, with the worker loop inside each owning service |

**Background jobs is the one that could have justified a new service, and must not.** A job runner
is owned by the service that executes the job; the shared part is the lease-and-claim protocol,
which is a package. A "job service" would need read access to every other context's data to do the
work — which is [CONSTRAINTS §5](CONSTRAINTS.md), the golden rule, violated by construction.

---

## Dependency graph

```
P-6  Make the Product Whole ──────────────┐  (no dependencies)
      │                                    │
      ├── D-1 tenant identity ─── D-2 per-tenant branding ──────────► P-14
      │
P-7  Alerting Beyond the Console           │  needs: Q-3 contract extension (additive)
      │                                    │
P-8  Live Video & Real Perception          │  needs: ADR (live transport) · D-4 (behaviour set)
      │                                    │
P-9  Real CCTV & NVR Validation ◄──────────┘  needs: HARDWARE (procurement, not engineering)
      │
P-10 First Customer Pilot                     needs: P-6 blockers cleared · P-9 findings
      │
P-11 Reporting & Evidence Export              needs: jobs → reports → export · ADR (custody)
      │
P-12 Search, Saved Work & Access Audit        needs: covering indexes · ADR (federation)
      │
P-13 Dashboards & Analytics                   needs: Q-4 freeze · the data the phases above produce
      │
P-14 General Availability                     needs: licensing freeze · D-2 · D-6
```

**Only one dependency is not an engineering dependency**, and it is the one that most needs starting
early: **P-9 is gated on hardware arriving.** Procurement should begin at P-6 kickoff and run in
parallel with P-7 and P-8. Nothing in P-7 or P-8 depends on P-9, and P-9 does not depend on the live
transport built in P-8 — validating a camera means probing, onboarding and recording it, all of which
work today.

---

## Related

- [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) — the execution plan built on this matrix
- [Roadmap review](../review/roadmap-2026-08/README.md) · [CUSTOMER_VALUE_MATRIX](../review/roadmap-2026-08/CUSTOMER_VALUE_MATRIX.md) · [PILOT_READINESS_MATRIX](../review/roadmap-2026-08/PILOT_READINESS_MATRIX.md)
- [TECH-DEBT](../../tracking/TECH-DEBT.md) · [RISK_REGISTER](RISK_REGISTER.md) · [PRODUCT_ROADMAP_QUEUE](PRODUCT_ROADMAP_QUEUE.md)
