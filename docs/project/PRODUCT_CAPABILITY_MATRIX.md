# Product Capability Matrix

> **The single source of truth for implementation progress.** Every capability the product has or
> will have, with its real state. Update it in the same commit as the work — a row that lags the code
> is worse than no row, because it will be trusted.

**Last verified: 2026-08-04** against the repository and the running production deployment.

## How to read a row

| Column        | Meaning                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------ |
| **Contract**  | ✅ frozen in `@vip/contracts` · ⚠️ partial · ⛔ does not exist                                   |
| **Backend**   | ✅ route exists and is exercised · ⚠️ partial · ⛔ nothing implements it                         |
| **Frontend**  | ✅ reachable in the console · ⚠️ partial or client-only · ⛔ nothing                             |
| **Demo**      | Safe to show a prospect **today**, on the demo dataset                                           |
| **Pilot**     | Safe for a real customer on their site                                                           |
| **Prod**      | Verified against a deployment under failure, and survives destroy-and-restore                    |
| **Milestone** | Where the remaining work is scheduled — [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md)                    |
| **Owner**     | The service or context that owns it. **No capability is owned by a service that does not exist** |

⚠️ **Rules for maintaining this file.** A cell goes ✅ only when it is true of the **deployment**, not
of `pnpm dev`. "Demo/Pilot/Prod" are not aspirations — a ✅ there means someone has done it and it
worked. Downgrading a cell requires no ceremony; upgrading one requires evidence.

**Capability ids (`C-nn`) are permanent and never reused.** [PRODUCT_EDITION_MATRIX](PRODUCT_EDITION_MATRIX.md)
references them rather than restating what a capability is.

---

## Platform & access

| id       | Capability                                                   | Contract | Backend |           Frontend            | Demo |             Pilot             | Prod | Milestone  | Dependencies | Owner    |
| -------- | ------------------------------------------------------------ | :------: | :-----: | :---------------------------: | :--: | :---------------------------: | :--: | ---------- | ------------ | -------- |
| **C-01** | Authentication · session · refresh                           |    ✅    |   ✅    |              ✅               |  ✅  |              ✅               |  ✅  | done       | —            | identity |
| **C-02** | Tenant isolation, fail-closed                                |    ✅    |   ✅    |              ✅               |  ✅  |              ✅               |  ✅  | done       | —            | platform |
| **C-03** | **User administration** — create · role · disable · password |    ✅    |   ✅    |              ✅               |  ✅  |              ✅               |  ✅  | done (P-6) | —            | identity |
| **C-04** | Roles & permissions (RBAC)                                   |    ✅    |   ✅    |   ⚠️ enforced, not editable   |  ✅  | ⚠️ `*:read` too broad (TD-26) |  ✅  | P-14       | D-6          | platform |
| **C-05** | Tenant settings                                              |    ✅    |   ✅    |              ✅               |  ✅  |              ✅               |  ✅  | done (P-6) | —            | tenant   |
| **C-06** | Tenant identity at sign-in                                   |    ✅    |   ✅    | ⚠️ slug typed by hand (TD-40) |  ⚠️  |              ⚠️               |  ✅  | **P-6**    | **D-1**      | identity |

## Estate

| id       | Capability                                   | Contract |           Backend            |          Frontend           | Demo |           Pilot            | Prod | Milestone         | Dependencies | Owner  |
| -------- | -------------------------------------------- | :------: | :--------------------------: | :-------------------------: | :--: | :------------------------: | :--: | ----------------- | ------------ | ------ |
| **C-07** | Location hierarchy (8 levels, skippable)     |    ✅    |              ✅              |             ✅              |  ✅  |             ✅             |  ✅  | done              | —            | tenant |
| **C-08** | Camera registry & onboarding                 |    ✅    |              ✅              |             ✅              |  ✅  |             ✅             |  ✅  | done              | —            | camera |
| **C-09** | Camera discovery (ONVIF)                     |    ✅    |              ✅              |             ✅              |  ✅  | ⬜ never met a real device |  ✅  | **P-9**           | hardware     | camera |
| **C-10** | Camera capabilities & stream probes          |    ✅    |              ✅              | ⚠️ client calls it; UI thin |  ⚠️  |       ⬜ unvalidated       |  ✅  | **P-6** → **P-9** | hardware     | camera |
| **C-11** | Camera health, measured                      |    ✅    |              ✅              |             ✅              |  ✅  |       ⬜ unvalidated       |  ✅  | **P-9**           | hardware     | camera |
| **C-12** | Camera lifecycle — retire · reinstate · bulk |    ✅    |              ✅              |         ⚠️ partial          |  ⚠️  |             ⚠️             |  ✅  | **P-6**           | —            | camera |
| **C-13** | NVR / DVR channel onboarding                 |    ✅    |      ✅ templates exist      |             ✅              |  ⚠️  |  ⬜ **never met an NVR**   |  ⚠️  | **P-9**           | hardware     | camera |
| **C-14** | Media catalogue — clips & recordings         |    ✅    |              ✅              |  ⛔ **no console client**   |  ⛔  |             ⛔             |  ✅  | **P-6**           | —            | media  |
| **C-15** | Camera zone referential integrity            |    ✅    | ⚠️ shape-checked only (TD-3) |             n/a             |  ✅  |             ⚠️             |  ⚠️  | **P-6**           | —            | camera |

## Perception

| id       | Capability                                                 |         Contract         |                   Backend                   |      Frontend       | Demo | Pilot | Prod | Milestone | Dependencies       | Owner        |
| -------- | ---------------------------------------------------------- | :----------------------: | :-----------------------------------------: | :-----------------: | :--: | :---: | :--: | --------- | ------------------ | ------------ |
| **C-16** | Event pipeline — ingest · dedup · persist · replay         |            ✅            |                     ✅                      |         ✅          |  ✅  |  ✅   |  ✅  | done      | —                  | events       |
| **C-17** | Object detection — person · vehicle · fire · smoke         |            ✅            | ⚠️ **`stub` backend is the default** (TD-5) |         ✅          |  ✅  |  ⛔   |  ⚠️  | **P-8**   | ONNX default       | ai/inference |
| **C-18** | Object tracking · zones · counting                         |            ✅            |      ⚠️ runtime only, no frame source       |         ⛔          |  ⛔  |  ⛔   |  ⚠️  | **P-8**   | C-19               | ai/inference |
| **C-19** | **Media → inference frame bus**                            |            ✅            |        ⛔ **`NullFrameSink`** (TD-4)        |         n/a         |  ⛔  |  ⛔   |  ⛔  | **P-8**   | —                  | media        |
| **C-20** | **Behaviour analytics** — loitering · intrusion · crowding |            ✅            |        ⛔ no analyzer wired (TD-14)         |         ⛔          |  ⛔  |  ⛔   |  ⛔  | **P-8**   | C-19 · **D-4**     | ai/inference |
| **C-21** | Upload a recording and analyse it                          |            ⚠️            |                ⛔ (TD-9 G-2)                |         ⛔          |  ⛔  |  ⛔   |  ⛔  | **P-8**   | C-19               | media        |
| **C-22** | **Live video view**                                        | ⛔ no transport contract |                 ⛔ (TD-28)                  | ⛔ placeholder page |  ⛔  |  ⛔   |  ⛔  | **P-8**   | **ADR: transport** | media        |
| **C-23** | Auto-captured evidence from a live incident                |            ✅            |         ⛔ no-op extractor (TD-15)          |         n/a         |  ⛔  |  ⛔   |  ⛔  | **P-8**   | C-19               | evidence     |

## Detection → response

| id       | Capability                                         | Contract |         Backend          |  Frontend  | Demo |       Pilot       | Prod | Milestone  | Dependencies | Owner    |
| -------- | -------------------------------------------------- | :------: | :----------------------: | :--------: | :--: | :---------------: | :--: | ---------- | ------------ | -------- |
| **C-24** | Rule authoring (create)                            |    ✅    |            ✅            |     ✅     |  ✅  |        ✅         |  ✅  | done       | —            | rules    |
| **C-25** | Rule editing                                       |    ✅    |            ✅            |     ✅     |  ✅  |        ✅         |  ✅  | done (P-6) | —            | rules    |
| **C-26** | Rule versions · diff · rollback · dry-run · audit  |    ✅    |            ✅            | ⚠️ partial |  ⚠️  |        ⚠️         |  ✅  | **P-6**    | C-25         | rules    |
| **C-27** | Rule scoping to hierarchy nodes                    |    ✅    |            ✅            |     ✅     |  ✅  |        ✅         |  ✅  | done       | —            | rules    |
| **C-28** | Rule state at scale (windowed thresholds)          |    ✅    | ⚠️ **in-process** (TD-7) |    n/a     |  ✅  | ✅ single replica |  ⚠️  | P-14       | Redis        | rules    |
| **C-29** | Incident lifecycle — raise → ack → resolve → close |    ✅    |            ✅            |     ✅     |  ✅  |        ✅         |  ✅  | done       | —            | workflow |
| **C-30** | Incident assignment · SLA · activity               |    ✅    |            ✅            |     ✅     |  ✅  |        ✅         |  ✅  | done       | —            | workflow |

## Investigation

| id       | Capability                                 | Contract |            Backend             |            Frontend            |      Demo      | Pilot | Prod | Milestone      | Dependencies              | Owner              |
| -------- | ------------------------------------------ | :------: | :----------------------------: | :----------------------------: | :------------: | :---: | :--: | -------------- | ------------------------- | ------------------ |
| **C-31** | Investigation workspace                    |    ✅    |               ✅               |               ✅               |       ✅       |  ✅   |  ✅  | **P-6** polish | —                         | workflow           |
| **C-32** | Evidence playback                          |    ✅    |               ✅               |               ✅               |       ✅       |  ✅   |  ✅  | done           | —                         | evidence           |
| **C-33** | Chain of custody · integrity hashes        |    ✅    |               ✅               |               ✅               |       ✅       |  ✅   |  ✅  | done           | —                         | evidence           |
| **C-34** | Incident timeline                          |    ✅    |               ✅               |               ✅               |       ✅       |  ✅   |  ✅  | done           | —                         | workflow           |
| **C-35** | Bookmarks · comments · annotations         |    ✅    |               ✅               |               ✅               |       ✅       |  ✅   |  ✅  | done           | —                         | workflow           |
| **C-36** | Display adjustments, visibly marked        |    ✅    |              n/a               |               ✅               |       ✅       |  ✅   |  ✅  | done           | —                         | console            |
| **C-37** | **Saved investigations · searches · pins** |    ✅    |   ⛔ **no store, no routes**   | ⚠️ declares itself `not-built` |       ⛔       |  ⛔   |  ⛔  | **P-12**       | —                         | workflow           |
| **C-38** | **Unified search federation**              |    ✅    |      ⛔ **no federator**       |      ⛔ inert box (TD-46)      |       ⛔       |  ⛔   |  ⛔  | **P-12**       | **ADR: placement**        | gateway + contexts |
| **C-39** | **Access audit**                           |    ✅    | ⛔ **nothing writes an entry** |               ⛔               |       ⛔       |  ⛔   |  ⛔  | **P-12**       | ⚠️ covering indexes (§40) | evidence           |
| **C-40** | Point-in-time evidence ancestry            |    ⚠️    | ⛔ resolves _current_ (TD-20)  |              n/a               | ✅ looks right |  ⚠️   |  ⚠️  | **P-11**       | —                         | evidence           |

## Communication

| id       | Capability                                            |             Contract              | Backend |   Frontend   | Demo | Pilot | Prod | Milestone | Dependencies           | Owner   |
| -------- | ----------------------------------------------------- | :-------------------------------: | :-----: | :----------: | :--: | :---: | :--: | --------- | ---------------------- | ------- |
| **C-41** | In-app notifications · webhook delivery               |                ✅                 |   ✅    | ⚠️ bell only |  ⚠️  |  ⚠️   |  ✅  | **P-6**   | —                      | notify  |
| **C-42** | Notification centre UI                                |                ✅                 |   ✅    |      ⛔      |  ⛔  |  ⛔   |  ⛔  | **P-6**   | —                      | console |
| **C-43** | **External transports** — email · SMS · Slack · Teams | ⛔ enum is `['in-app','webhook']` |   ⛔    |      ⛔      |  ⛔  |  ⛔   |  ⛔  | **P-7**   | Q-3 additive extension | notify  |
| **C-44** | Notification policies · escalation                    |                ⚠️                 |   ⛔    |      ⛔      |  ⛔  |  ⛔   |  ⛔  | **P-7**   | C-43                   | notify  |
| **C-45** | Real-time delivery (SSE)                              |                ✅                 |   ✅    |      ✅      |  ✅  |  ✅   |  ✅  | done      | —                      | gateway |

## Reporting & analytics

| id       | Capability                                         |     Contract      |          Backend          |           Frontend            | Demo | Pilot | Prod | Milestone | Dependencies            | Owner                          |
| -------- | -------------------------------------------------- | :---------------: | :-----------------------: | :---------------------------: | :--: | :---: | :--: | --------- | ----------------------- | ------------------------------ |
| **C-46** | **Background jobs**                                |        ✅         | ⛔ **no worker anywhere** |              ⛔               |  ⛔  |  ⛔   |  ⛔  | **P-11**  | —                       | `@vip/jobs` pkg + each service |
| **C-47** | **Report generation**                              |        ✅         |    ⛔ **no generator**    |              ⛔               |  ⛔  |  ⛔   |  ⛔  | **P-11**  | C-46                    | workflow                       |
| **C-48** | **Evidence export bundles** (signed · watermarked) |        ✅         |        ⛔ (TD-16)         |              ⛔               |  ⛔  |  ⛔   |  ⛔  | **P-11**  | C-46 · **ADR: custody** | evidence                       |
| **C-49** | Evidence download + integrity verification         |        ✅         |            ✅             |              ✅               |  ✅  |  ✅   |  ✅  | done      | —                       | evidence                       |
| **C-50** | Background job monitoring UI                       |        ✅         |            ⛔             |              ⛔               |  ⛔  |  ⛔   |  ⛔  | **P-11**  | C-46                    | console                        |
| **C-51** | **Dashboards & analytics**                         | ⛔ Q-4 not frozen |            ⛔             | ⚠️ static tiles, **no trend** |  ⚠️  |  ⚠️   |  ⚠️  | **P-13**  | Q-4 freeze              | workflow                       |

## Operations & commercial

| id       | Capability                                                  |     Contract      |          Backend          |             Frontend              | Demo | Pilot | Prod | Milestone | Dependencies      | Owner    |
| -------- | ----------------------------------------------------------- | :---------------: | :-----------------------: | :-------------------------------: | :--: | :---: | :--: | --------- | ----------------- | -------- |
| **C-52** | System health page                                          |        ✅         |            ✅             |                ✅                 |  ✅  |  ✅   |  ✅  | done      | —                 | console  |
| **C-53** | Deployment · backup · restore · upgrade · rollback          |        n/a        |            ✅             |                n/a                |  ✅  |  ✅   |  ✅  | done      | —                 | infra    |
| **C-54** | Observability — structured logs · correlation ids · metrics |        ✅         |            ✅             |                n/a                |  ✅  |  ✅   |  ✅  | done      | —                 | platform |
| **C-55** | Point-in-time backup                                        |        n/a        | ⚠️ per-collection (TD-38) |                n/a                |  ✅  |  ⚠️   |  ⚠️  | P-14      | —                 | infra    |
| **C-56** | Retention sweeps · tier transitions                         |        ✅         |        ⛔ (TD-18)         |                ⛔                 |  ✅  |  ⚠️   |  ⛔  | P-14      | C-46              | evidence |
| **C-57** | Legal hold · redaction workflow                             |        ⚠️         |   ⚠️ flag only (TD-17)    |                ⛔                 |  ⚠️  |  ⚠️   |  ⚠️  | P-14      | —                 | evidence |
| **C-58** | Rate limiting at the edge                                   |        n/a        |        ⛔ (TD-39)         |                n/a                |  ✅  |  ⚠️   |  ⛔  | P-14      | —                 | infra    |
| **C-59** | Runtime white-label branding                                |        n/a        |            ✅             |                ✅                 |  ✅  |  ✅   |  ✅  | done      | —                 | console  |
| **C-60** | **Per-tenant** branding                                     |        ⛔         | ⛔ per-deployment (TD-42) |                ⛔                 |  ⛔  |  ⛔   |  ⛔  | P-14      | **D-2** ← **D-1** | console  |
| **C-61** | **Licensing & entitlements**                                | ⛔ nothing exists |            ⛔             |                ⛔                 |  ⛔  |  ⛔   |  ⛔  | P-14      | commercial model  | tenant   |
| **C-62** | Demo Mode (`demo.sh reset`)                                 |        n/a        |            ✅             |                n/a                |  ✅  |  ✅   |  ✅  | done      | —                 | infra    |
| **C-63** | Responsive shell (phone · tablet)                           |        n/a        |            n/a            |       ⛔ below `md` (TD-45)       |  ⚠️  |  ⚠️   |  ⛔  | **P-6**   | —                 | console  |
| **C-64** | Accessibility — WCAG AA · keyboard · screen reader          |        n/a        |            n/a            | ⚠️ 0 findings desktop; TD-31 open |  ✅  |  ✅   |  ✅  | **P-6**   | —                 | console  |

---

## Roll-up

|                                                        | Count |                                                                 |
| ------------------------------------------------------ | ----- | --------------------------------------------------------------- |
| **Production-verified**                                | 29    | Deployed, exercised under failure, survives destroy-and-restore |
| **Demo-ready**                                         | 31    | Safe to show today, on the demo dataset                         |
| **Pilot-ready**                                        | 29    | ✅ **No capability is short of pilot-ready any more**           |
| **Architecture-only** (contract frozen, nothing built) | 6     | C-37 · C-38 · C-39 · C-46 · C-47 · C-48                         |
| **Contract missing**                                   | 4     | C-22 · C-43 · C-51 · C-61                                       |
| **Blocked on a product decision**                      | 4     | C-06 (D-1) · C-20 (D-4) · C-38 (D-3) · C-60 (D-2)               |
| **Blocked by a missing service**                       | **0** | Every capability has an owner that exists                       |
| **Never met real hardware**                            | 4     | C-09 · C-11 · C-13 and, through them, C-10                      |

### ✅ Both pilot blockers are closed

**C-25** — a rule can be edited (P-6.1). **C-03** — a user can be re-roled, disabled, re-enabled and
given a new password, and disabling **ends every open session immediately** (P-6.2). Both were
verified against the production deployment rather than the test suite.

⚠️ Closed does not mean finished: P-6 still owes the notification centre, camera management depth,
the media catalogue, a responsive shell and `/live`. **Pilot-ready is a floor, not a ceiling.**

⚠️ **C-52 was marked production-verified before the page existed**, on the strength of the services'
`/health` and `/ready` probes — and the route walk agreed, because the edge answers `/health` with
`{"status":"ok"}` and JSON logs no errors. The backend column was true; the frontend column was a
placeholder nobody could reach. P-6.4 built the page, moved it to `/system`, and made the route walk
assert that the **console** rendered rather than that nothing crashed.

---

## Related

- [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) — when each gap closes, and why in that order
- [PRODUCT_EDITION_MATRIX](PRODUCT_EDITION_MATRIX.md) — which edition each `C-nn` belongs to
- [RELEASE_PLAN](RELEASE_PLAN.md) — which release each milestone produces
- [IMPLEMENTATION_READINESS](IMPLEMENTATION_READINESS.md) — the dated dependency analysis this matrix was derived from, with the verification method
- [TECH-DEBT](../../tracking/TECH-DEBT.md) · [RISK_REGISTER](RISK_REGISTER.md)
