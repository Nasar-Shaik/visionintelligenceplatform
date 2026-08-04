# Roadmap Review — 2026-08-04

Requested after P-5.9 approval: review the platform as a product owner rather than an architect,
regroup the backlog by customer capability, and produce a roadmap that reads like a commercial
product.

It did that. It also opened the product in the deployment that had just been certified, and found
the Cameras page white-screening.

---

## The finding that comes first

**`/cameras` was rendering the route error boundary in the production deployment**, for every
operator in three of the four demo tenants:

```
TypeError: Cannot read properties of undefined (reading 'label')
```

A committed screenshot in the P-5.9 review package shows it. **P-5.9 reported 0 high · 0 medium ·
0 low.**

### Why the audit could not have caught it

The P-5.9 audit measured overflow, tap targets, focus rings, heading order and contrast across
eleven pages.

> **A page that has crashed has no overflow, no unlabelled controls and no contrast failures.
> It scores perfectly.**

The audit was not sloppy. It was measuring something adjacent to the question. That is the theme of
this review, and it recurred: **"zero horizontal overflow across 11 pages × 5 viewports"** was also
wrong, because it compared `document.scrollWidth` with `clientWidth` — and the workspace was painting
its right column 24 px past its parent at 1280 px and 1440 px, clipped by an `overflow-hidden`
ancestor. A container that clips its children reports no page overflow while cutting content off.

Both checks are now scripts that fail: [`verify.mjs`](verify.mjs) asserts every route _renders_
before anything else is measured; [`overflow.mjs`](overflow.mjs) measures painted boxes and excludes
legitimately scrollable containers. Recorded as CONSTRAINTS §111–§115 and [ED-0072](../../project/ENGINEERING_DECISION_LOG.md).

### The chain

Four things were true at once, each individually reasonable:

1. `tools/seed/demo.ts` declared camera health as a **local string union** containing `'degraded'` —
   a _lifecycle_ word, not a member of `CameraHealthStatus`. It never imported the contract.
2. The seed **writes straight to Mongo**, so nothing validated it.
3. The camera service **served the record unchanged** — reads are not re-validated.
4. `HEALTH_KIND['degraded']` → `undefined` → `statusTokens(undefined)` → `undefined` → `.label`
   **threw inside a design-system primitive**, taking the whole page with it.

Fixed at both ends, and re-verified in the deployment.

---

## What was fixed — proven by running software, in the deployment

| Defect                                        | Fix                                                                                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/cameras` white screen                       | Seed types its enums from `@vip/contracts`; `statusTokens` returns `idle` rather than `undefined`; `StatusIndicator` normalises an unknown status; camera health and lifecycle read through presentation helpers that render an unmapped value as itself |
| Workspace clipped at 1280 px and 1440 px      | The `xl:` step enlarged both side columns **and** imposed a 480 px centre minimum at once — 1448 px of hard minimum inside 1280 px. Moved to `2xl`, where it fits                                                                                        |
| Raw camera ids under a column headed "Camera" | **P-5.9 fixed two of six surfaces.** Events, workspace details, incident detail sheet and evidence metadata still showed `cam_retail_electronics2`                                                                                                       |
| `Ai`                                          | The health panel title-cased the `ai` dependency with CSS. Named explicitly, like every other identifier→word mapping                                                                                                                                    |

Verified after the fixes, against the running deployment:

```
✓ ok  dashboard   ✓ ok  live      ✓ ok  cameras    ✓ ok  locations
✓ ok  events      ✓ ok  incidents ✓ ok  workspace  ✓ ok  alerts
✓ ok  rules       ✓ ok  health    ✓ ok  settings
── errors ── none

1920px ✓   1536px ✓   1440px ✓ (was 25 clipped)   1280px ✓ (was 44 clipped)   1024px ✓
```

Gate: 25/25 console test files, 298 tests, typecheck clean, lint 0 errors, bundle budget OK, no
chunk cycles.

---

## 1 · Should P-5.x close? Yes

Nine slices took the platform from incident management to customer certification. They answered
_"is what we built correct, deployable and presentable?"_ — and the answer is yes.

The remaining work answers a different question: _"is it enough for someone to pay for?"_ That is
answered by capability, not by another verification pass. A decimal series signals more of the same
slice; this is not more of the same slice.

**Close P-5.x. Do not open P-5.10. No new architecture milestone is proposed** — two items need an
ADR (live video transport, evidence export packaging) and each carries it inside its phase.

Full reasoning and the phase definitions: [PRODUCT_ROADMAP](../../project/PRODUCT_ROADMAP.md).

## 2 · The backlog, regrouped

Forty-seven debt items, seven queued contract sets and three placeholder routes, grouped by the
capability a customer would name: [CUSTOMER_VALUE_MATRIX](CUSTOMER_VALUE_MATRIX.md).

## 3 · "Will a paying customer notice this?"

Ten items left the critical path. None of them was ever going to be why a customer signed or did
not sign: the TypeScript version, the event upcaster, image size, CSP notes, CI flake, tracker doc
layout.

**One item is a decision rather than a task.** The review asked to verify light and dark mode
consistency. _There is no light mode_ (TD-43) — dark-only is deliberate for a control room, the
token layer would support a light palette, but none exists. Recommendation: **stay dark-only through
P-8**; a second palette costs every future component twice, and no pilot has asked.

## 4 · The UI, against Linear / Notion / Vercel / Supabase / Datadog / Grafana

[UI_BENCHMARK](UI_BENCHMARK.md). The token discipline, restraint, typography and — uniquely — the
honesty of the `not-built` states would survive a design review at any of them.

Ten gaps, the first three of which a buyer meets in the first minute:

- **The global search box does nothing.** No `value`, no `onChange`, no handler, in the centre of
  the top bar on every screen. It also undermines every honest empty state the product shows.
- **No command palette outside the workspace**, where one already exists.
- **The shell does not respond below `md`.** The sidebar is 240 px at 390 px, leaving 150 px for the
  application — **an operator cannot reach Sign out on a phone.**

Then: no trend or direction on any dashboard number; tables with no sort, count or bulk selection;
internal slice numbers shown to customers ("coming in P2-1.13"); two encodings for two similar
enums; vertical dead space on half the pages; six identical empty panels in an empty workspace.

## 5 · Pilot readiness

[PILOT_READINESS_MATRIX](PILOT_READINESS_MATRIX.md). Installation, restore, upgrade, rollback,
monitoring and troubleshooting are proven by execution. Operator workflow is 6 clicks / 21.6 s.

**Two blockers**, neither architectural:

- **B-1 · A user account cannot be disabled.** Identity has `POST /users` and `GET /users` and
  nothing else. For a security product this is the sharpest gap in the platform, and it makes
  checklist item 3.3 unachievable as written. (TD-44)
- **B-2 · A rule cannot be edited.** A client-side form defect standing in front of a complete,
  versioned rule engine. (TD-21)

## 6 · CCTV readiness

Unchanged and unsimulated: [CCTV_READINESS](../p59/CCTV_READINESS.md).

|                      |                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Verified**         | Nothing. No camera or NVR of any make has ever been connected                                                                                                                            |
| **Not yet verified** | Hikvision · Dahua · CP Plus · UNV · Axis · RTSP against real firmware · ONVIF discovery · NVR channel playback · exported recordings · H.265 decode (probed only, never decoded — TD-29) |
| **Unsupported**      | Live view in a browser (no RTSP decoder exists; needs a repackager and an ADR — TD-28) · PTZ control · audio · biometrics                                                                |
| **Future roadmap**   | Face recognition and LPR — **biometric processing**, needing a lawful basis, a DPIA and a subject-rights path _before_ a schema, not after                                               |

**Minimum hardware to validate:** one camera per vendor family — Hikvision, Dahua, CP Plus, UNV,
Axis — each in H.264 and H.265, plus **one NVR with at least four channels** (a DVR/NVR is a
different integration from a camera, and the channel-path templates in `DVR_TEMPLATES` have never met
one). Roughly two engineer-weeks. **P-8.**

## 7 · Commercial readiness

|                                  |                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| White-label branding             | ✅ Runtime `branding.json`, proven by re-branding a **running** container                                                                                                                      |
| Favicon · login · shell branding | ✅ Including a WCAG contrast check that refuses a colour it cannot make readable                                                                                                               |
| Report branding                  | ⬜ No reports exist yet (P-9)                                                                                                                                                                  |
| Tenant branding                  | ⚠️ Per-**deployment**, not per-tenant (TD-42) — branding is read before sign-in, which is what makes the login screen brandable. A reseller serving several brands needs several installations |
| Licensing                        | ⛔ No entitlements, no camera-count enforcement, no feature gating. **P-13**                                                                                                                   |
| Documentation                    | ✅ Fourteen documents; deployment, upgrade, rollback and restore each executed rather than described                                                                                           |

## 8 · The roadmap

```
P-6  Make the Product Whole       ← everything with a real API today
P-7  Live Video & Real Perception ← the two gaps a buyer notices first
P-8  Real CCTV & NVR Validation
P-9  Reporting & Evidence Export
P-10 Search & Saved Work
P-11 Dashboards & Analytics
P-12 Pilot Customer Release
P-13 General Availability
```

**Two deliberate departures from the sequence suggested at review**, and the evidence for both:

**Search, reporting, dashboards and background jobs moved later.** Five contract families frozen
during P-5 — `SearchResponse`, `SavedSearch`, `Job`/`JobSchedule`, `ReportModel`, `AccessAuditEntry`
— have **no consumer anywhere in the repository**, and no route exists under `/search`, `/jobs`,
`/reports`, `/saved-searches` or `/audit` on any of the ten services. Verified by searching every
service and the console for the exported type names. "Complete the search federation UI" is not a UI
task; it is building the federator.

**Live video and real perception moved earlier.** Neither was on the near roadmap, and they are the
two gaps a buyer meets in the first ten minutes of a demo of a _CCTV_ product: `/live` is a
placeholder page, and the platform detects `person` while the demo says "suspicious activity".

## 9 · Deliverables

| Deliverable                 | Where                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Updated Product Roadmap     | [PRODUCT_ROADMAP](../../project/PRODUCT_ROADMAP.md)                                                      |
| Customer Value Matrix       | [CUSTOMER_VALUE_MATRIX](CUSTOMER_VALUE_MATRIX.md)                                                        |
| Pilot Readiness Matrix      | [PILOT_READINESS_MATRIX](PILOT_READINESS_MATRIX.md)                                                      |
| Production Readiness Matrix | [p59/PRODUCTION_READINESS_MATRIX](../p59/PRODUCTION_READINESS_MATRIX.md) — still current; not duplicated |
| Remaining Technical Debt    | [tracking/TECH-DEBT.md](../../../tracking/TECH-DEBT.md) — TD-44…TD-47 added, TD-33 half paid             |
| Known Limitations           | [p59/KNOWN_LIMITATIONS](../p59/KNOWN_LIMITATIONS.md) — still current                                     |
| Risk Register               | [RISK_REGISTER](../../project/RISK_REGISTER.md) — **re-scored; it had not been touched since Phase 0**   |
| UI benchmark                | [UI_BENCHMARK](UI_BENCHMARK.md)                                                                          |
| Go / No-Go                  | below                                                                                                    |

---

## Go / No-Go

|                                                          |                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Demonstrations**                                       | ✅ **GO**, unconditional. Every route renders, the dataset is populated and plausible, `demo.sh reset` restores it in one command                                                                                              |
| **Single-host pilot**                                    | ⚠️ **CONDITIONAL GO** — on **TD-44** (disable a user) and **TD-21** (edit a rule). Both are P-6, both small, neither architectural. Known Limitations must be read _with_ the customer, and the restore _tested_, not just run |
| **Production sold on camera compatibility**              | ⛔ **NO-GO**, unchanged. No camera or NVR has ever been connected                                                                                                                                                              |
| **Production sold on "AI detects suspicious behaviour"** | ⛔ **NO-GO.** The platform detects `person`, `vehicle`, `fire` and `smoke`. There is no behaviour analyzer. This is the largest gap between what the product is sold as and what it does                                       |

---

## Recommendation

**P-6 as scoped is not deliverable as a UI-only milestone**, and that is the single most important
output of this review. Five of its thirteen objectives — search federation UI, saved investigations,
report generation, background-job monitoring, evidence export — have no server to connect to.

**Recommended P-6: "Make the Product Whole" — everything that has a real API today.**

1. **TD-21** — a rule can be edited. First, because it is the shortest path from broken to working.
2. **TD-44** — users can be managed and disabled. Additive Identity routes plus the screen.
3. **Zero placeholder pages** — `/settings`, `/health`, `/live` (with an honest statement, not a
   fake player).
4. **Notification centre** — Notify already has full CRUD and ack. Genuinely a UI job.
5. **Camera management depth** — twenty camera routes exist and the API client already calls them;
   the UI surfaces a fraction.
6. **TD-46** — the global search box gets wired or disabled. Not left lying.
7. **TD-45** — the shell responds below `md`.
8. **TD-47** — tables get sort and a result count.
9. **TD-40, TD-31, TD-3** — tenant discovery at login, 44 px touch targets on the two sliders, zone
   existence check.

Everything on that list has a working server behind it. Nothing on it needs an ADR.

**Then P-7 — live video and real perception — before reporting, search or dashboards.** Those three
are worth building on top of a validated ingestion path and worth very little on top of a null frame
sink.

---

## Running the checks

```sh
npm i playwright        # not a repo dependency; browsers are cached
BASE=https://localhost SEED_PASSWORD=… node verify.mjs     # every route renders
BASE=https://localhost SEED_PASSWORD=… node overflow.mjs   # nothing painted off-screen
```

Both must be run from a directory where `playwright` resolves, against a **deployment** — never
`pnpm dev`. Screenshots land in [`screens/`](screens/).
