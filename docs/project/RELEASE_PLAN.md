# Release Plan

> **What a version number means here, and what has to be true before one is stamped.**

A release is not a milestone. A milestone is a body of work that gets reviewed; a release is a
**claim made to someone outside the team**. Several milestones can pass before a claim changes.

---

## Where the version actually is

Until P-6 the repository had never been versioned as a product: `package.json` at the root said
`1.0.0` — a scaffolding default that never meant anything — while every workspace package said
`0.1.0`. Neither number had ever been changed deliberately.

**Done in P-6.0: the root reads `0.4.0`.** Workspace packages stay `0.1.0`; they are private and not
published, and versioning nineteen packages in lockstep buys nothing. **The product has one version;
the packages do not.**

|           |                                                                   |
| --------- | ----------------------------------------------------------------- |
| **Today** | **0.4 · Demo Ready** — reached 2026-08-04 with the roadmap review |
| **Next**  | **0.5 · Pilot Ready** — P-6 and P-7                               |

---

## The ladder

Six releases were suggested. **Nine are listed**, and the reason is worth stating: collapsing P-8
through P-13 into a single step between "Pilot Ready" and "GA" would hide five milestones behind one
number — including live video, real perception, hardware validation and the pilot itself. Each of
those changes what can honestly be claimed, so each gets a number.

| Version | Name                       | Milestones                     | The claim it licenses                                                                                                        |
| ------- | -------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **0.1** | Internal Architecture      | Phase 0 · P1-1…P1-8            | _"There is a platform."_ Contracts, spine, ten services, camera → alert end to end                                           |
| **0.2** | Foundation Complete        | P-2 · P-3 · P-4 · AI-1…AI-5e   | _"The architecture is frozen."_ Six foundations; AI Runtime v1.0 closed                                                      |
| **0.3** | Investigation Complete     | P-5.1 … P-5.5                  | _"An operator can investigate an incident."_ Workspace, timeline, evidence playback                                          |
| **0.4** | **Demo Ready** ← **today** | P-5.6 … P-5.9 + roadmap review | _"We can show this to a prospect."_ Production deployment verified; four demo verticals; every route renders                 |
| **0.5** | Pilot Ready                | **P-6 · P-7**                  | _"A customer can run this on their site."_ No placeholder pages; users manageable; rules editable; alerts leave the building |
| **0.6** | Perception Complete        | **P-8**                        | _"It sees, and it understands."_ Live video; behaviour analytics on real footage                                             |
| **0.7** | Hardware Validated         | **P-9**                        | _"These camera models are supported."_ The first sentence about vendor compatibility we are entitled to say                  |
| **0.8** | Pilot Proven               | **P-10**                       | _"A real customer runs this."_ Signed acceptance from a site we did not control                                              |
| **0.9** | Feature Complete           | **P-11 · P-12 · P-13**         | _"Nothing on the roadmap is missing."_ Reporting, export, search, audit, dashboards                                          |
| **1.0** | **General Availability**   | **P-14**                       | _"Buy this."_ Licensed, metered, multi-tenant, supportable                                                                   |

### Rules

- ⚠️ **A version is stamped only after the milestone's review is approved.** Never during, never in
  anticipation.
- **A release may slip a milestone; it may not skip a gate.** If P-9 finds that three vendors need
  work, 0.7 waits. It does not ship with an asterisk.
- **Versions only go forward.** A regression found after a stamp is a patch release
  (`0.7.1`), not a retraction.
- **The claim column is load-bearing.** If a version's claim cannot be made honestly, that version
  has not been reached — regardless of how much code landed.

---

## Gates

Every release must pass **all** of these. There is no partial pass, and no gate is waived because a
milestone was "documentation-only" — a documentation-only milestone still deploys.

| #   | Gate                                                    | Evidence                                                                                                                                                                                    |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Typecheck · lint · tests · imports · contracts · format | Full monorepo gate, green                                                                                                                                                                   |
| 2   | Build + bundle budget + **no chunk cycles**             | `check-bundle-budget.mjs`                                                                                                                                                                   |
| 3   | **Production deployment verified**                      | Built image, deployed, exercised. ⚠️ Never `pnpm dev`                                                                                                                                       |
| 4   | **Every route renders**                                 | `verify.mjs` — zero `pageerror`, zero console errors                                                                                                                                        |
| 5   | **Responsive**                                          | `overflow.mjs` — nothing painted off-screen, 390 → 1920                                                                                                                                     |
| 6   | Accessibility                                           | 0 unnamed controls · 0 targets < 24 px · 0 heading skips · every tab stop focus-visible                                                                                                     |
| 7   | Keyboard-only walkthrough                               | The primary operator workflow, no mouse                                                                                                                                                     |
| 8   | **Recovery**                                            | Restart every dependency under a live investigation. No page refresh where avoidable                                                                                                        |
| 9   | **Restore**                                             | Destroy the volumes, rebuild, restore, verify real bytes and intact custody                                                                                                                 |
| 10  | Review package                                          | Delivered and approved                                                                                                                                                                      |
| 11  | **Known limitations recorded**                          | Honestly. ⚠️ An unrecorded limitation is a defect                                                                                                                                           |
| 12  | Governance current                                      | [PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md) · [TECH-DEBT](../../tracking/TECH-DEBT.md) · [RISK_REGISTER](RISK_REGISTER.md) · [MASTER_PROGRESS](../tracker/MASTER_PROGRESS.md) |

Gates 3–5 exist because each was learned the hard way. Gate 3: P-5.8 found evidence playback had
never worked outside `pnpm dev`. Gate 4: P-5.9 certified the UI with zero findings while `/cameras`
was white-screening. Gate 5: the same milestone reported zero horizontal overflow while the workspace
clipped 44 elements at 1280 px.

> **A check that could not fail is not a check.** For every gate, ask what result would have turned
> it red. If there isn't one, the gate is decoration.

---

## Release-specific exit criteria

Beyond the twelve gates. These are the things that make each _claim_ true.

### 0.5 · Pilot Ready — P-6 · P-7

- [ ] **Zero placeholder pages.** `/settings` (P-6.3) and System Health (P-6.4) are done; **`/live`
      alone remains**. ⚠️ P-6.4 found that the System Health placeholder had never been reachable in
      a deployment at all — the edge owns `/health` for the gateway's liveness probe — so the page
      lives at `/system`, and the route walk now asserts the console rendered rather than that
      nothing crashed
- [x] A user can be created, re-roled and **disabled** in the console (C-03 — was a pilot blocker; P-6.2)
- [x] A rule can be created, **edited**, versioned and rolled back in the console (C-25 — was a pilot blocker; P-6.1)
- [ ] A critical incident delivers an **email and an SMS** to a real address and number
- [x] A **failed** delivery is visible in the console, with the reason (P-6.5 — called out above the
      queue, with the transport error and the attempt count on the entry). ⚠️ The **delivery** half is
      done; the transports it can fail on are still in-app and webhook only
- [ ] The console is usable on a phone — including Sign out (C-63)
- [ ] **D-1 decided** (tenant identity at sign-in)

### 0.6 · Perception Complete — P-8

- [ ] A live camera renders in Chrome, Edge, Firefox and Safari **against the deployment**
- [ ] An uploaded MP4 produces detections → events → incident → attached evidence, unaided
- [ ] Loitering, intrusion and crowding each fire on footage a **human** labelled first
- [ ] At least one **negative** case per behaviour — a false positive costs more than a miss
- [ ] Latency budget measured, not asserted
- [ ] ADR: live video transport

### 0.7 · Hardware Validated — P-9

- [ ] One camera per vendor family reaches `first-frame`; codec, resolution and frame rate **measured**
- [ ] **H.265 decoded**, not merely probed (TD-29)
- [ ] One NVR onboarded by channel
- [ ] Wrong password fails at `authentication`; unplugged camera fails at `tcp`/`dns`
- [ ] Every deviation recorded — vendor, model, firmware, what happened
- [ ] ⚠️ **Nothing marked certified without hardware evidence** (§18). No simulation promotes a status
- [ ] `CCTV_READINESS.md` becomes a supported-hardware list rather than a plan

### 0.8 · Pilot Proven — P-10

- [ ] Installed from [DEPLOYMENT.md](../runbooks/DEPLOYMENT.md) alone. **If a step is wrong, fix the guide**
- [ ] The customer's own operators work a real incident **unaided**
- [ ] A restore performed and verified **on their host**
- [ ] Acceptance checklist signed
- [ ] ⚠️ **Pilot findings re-open the roadmap.** 0.9 is provisional until they are in

### 0.9 · Feature Complete — P-11 · P-12 · P-13

- [ ] A report survives a service restart mid-job and is downloadable
- [ ] An export bundle verifies its integrity **outside** the platform
- [ ] Search returns results from ≥4 contexts, permission-filtered; an unreadable entity never appears, not even as a count
- [ ] Every audit query index-covered — proven by `explain`, not by timing
- [ ] **No dashboard number appears without direction** (a delta or a sparkline)

### 1.0 · General Availability — P-14

- [ ] A tenant over its camera entitlement is refused **at the boundary**, not warned in a log
- [ ] Two replicas produce the same threshold-rule results as one — **measured**
- [ ] A retention sweep deletes on schedule and **respects legal hold**, proven
- [ ] No role holds a wildcard read (D-6)
- [ ] Restore from a point-in-time backup verified
- [ ] Every 🕒 in [PRODUCT_EDITION_MATRIX](PRODUCT_EDITION_MATRIX.md) is ✅ or has moved to post-GA

---

## After 1.0

**Semantic versioning against the frozen contracts**, which is where the freeze finally pays for
itself:

- **Patch** (`1.0.x`) — defect fixes. No contract change.
- **Minor** (`1.x.0`) — additive capability. New optional fields, new routes, new enum members. **An
  existing consumer keeps working, untouched.** This is where almost everything lands.
- **Major** (`x.0.0`) — a breaking contract change. **Requires an ADR, architectural review and
  approval.** Not one of the three is optional; the first exception granted is the one that ends the
  freeze ([CONSTRAINTS §33](CONSTRAINTS.md)).

Post-GA candidates, none of them contracts yet: SSO/OIDC federation · air-gapped install · custom
roles · PTZ (first camera-**control** write path — a security-boundary ADR) · Face Recognition and
LPR (⚠️ **biometric processing** under GDPR Art. 9 — a lawful basis, a DPIA, a retention position and
a subject-rights path come _before_ there is a schema to store a faceprint in) · audio analytics ·
GIS maps · cloud and edge sync.

---

## Related

- [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) — the milestones each release contains
- [PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md) — per-capability state
- [PRODUCT_EDITION_MATRIX](PRODUCT_EDITION_MATRIX.md) — what each release makes sellable
- [DEFINITION_OF_DONE](DEFINITION_OF_DONE.md) — the per-milestone checklist behind the gates
