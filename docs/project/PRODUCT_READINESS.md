# Product Readiness — what can be sold, shown, piloted and deployed today

**2026-08-07.** Written at the transition from platform engineering to customer-facing product
engineering, immediately after [P-9 Track A closed](P9_TRACK_A_CLOSEOUT.md).

> ⚠️ **This document answers a commercial question with engineering evidence.** Every claim below is
> traceable to the capability matrix, a verification run, a known limitation or the code. Where the
> honest answer is "we do not know", it says so — a readiness review that cannot say _no_ is a
> brochure.

**Basis of assessment**

| Source                                                    | What it contributed                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| [PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md) | 64 capabilities with per-column state                            |
| [KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md)                 | L-1 … L-60, the customer-facing disclosures                      |
| [TECH-DEBT](../../tracking/TECH-DEBT.md)                  | the engineering account behind each gap                          |
| [P9_TRACK_A_CLOSEOUT](P9_TRACK_A_CLOSEOUT.md)             | what hardware validation proved and what it could not            |
| The running deployment                                    | **17 production containers healthy**, checked while writing this |
| The code                                                  | ⭐ two claims in the governance documents were **wrong** — §7    |

---

## 1 · The one-paragraph answer

The platform is **feature-complete for a security operations console and functionally complete for
perception**: a camera can be onboarded, recorded, analysed, tracked, ruled on, turned into an
incident, investigated, played back and downloaded with an intact custody chain — all of it verified
against a production deployment rather than a development topology. What it has never done is **meet a
customer**. No physical camera has ever answered it ([L-1](KNOWN_LIMITATIONS.md)), no real footage has
ever passed through the perception chain, and two things a paying security customer treats as
table stakes — **telling somebody who is not looking at the screen** (email/SMS, C-43) and **handing a
report to a third party** (C-47/C-48) — do not exist at all.

⭐ **The gap between this platform and a sellable product is not perception. It is contact with
reality at one end and the ability to leave the building at the other.**

---

## 2 · Production-ready — deploy it, it will hold

**31 capabilities.** Deployed, exercised under failure, and survive destroy-and-restore. These are safe
to put in front of a paying customer on the platform's own terms.

| Area              | What works                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access**        | C-01 auth/session/refresh · C-02 tenant isolation fail-closed · C-03 user administration · C-05 tenant settings                                                                   |
| **Estate**        | C-07 8-level location hierarchy · C-08 camera registry & onboarding · C-12 camera lifecycle · C-14 media catalogue (API)                                                          |
| **Perception**    | C-16 event pipeline · C-17 detection (ONNX + YOLOX-nano) · C-18 tracking · C-19 media→inference frame bus · C-14a recording · C-14c per-camera AI assignment · C-14e event bridge |
| **Response**      | C-24/C-25/C-26/C-27 rule authoring, editing, versions, scoping · C-29 incident lifecycle (frozen, ADR-0045) · C-30 assignment/SLA/activity                                        |
| **Investigation** | C-31 workspace · C-32 playback · C-33 custody + integrity hashes · C-34 timeline · C-35 bookmarks/comments · C-36 display adjustments · C-49 evidence download + verification     |
| **Communication** | C-41 in-app + webhook delivery · C-42 notification centre · C-45 real-time SSE                                                                                                    |
| **Operations**    | C-52 system health · C-53 deploy/backup/restore/upgrade/rollback · C-54 observability · C-59 white-label branding · C-62 demo reset                                               |

⚠️ **"Production-ready" is a statement about the software, not about the installation.** Every row
above was verified against a synthetic or fixture source. The software will hold; whether it produces
_correct answers about a customer's premises_ is §4.

---

## 3 · Demo-ready — safe to show a prospect today

Everything in §2, plus the following, which are real but carry a caveat that must be said aloud rather
than hidden behind a smooth screen.

| Capability                            | Show it                                     | ⚠️ Say this while showing it                                                         |
| ------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| **C-14g Retail Loitering**            | end to end, incident to evidence            | The zone is drawn on a **picture**, not a floor ([L-58](KNOWN_LIMITATIONS.md))       |
| **C-14d tracking identities**         | Live Tracks, re-entry linking               | Identity does not follow a person **between cameras** ([L-43](KNOWN_LIMITATIONS.md)) |
| **C-14b detections**                  | AI Runtime page, live counts                | There is **no accuracy number** (TD-64). Inference runs; how well is unmeasured      |
| **C-14f zone editor**                 | draw, version, roll back                    | Zone geometry has never met a real lens                                              |
| **C-09/C-10/C-11 discovery & probes** | 13-stage stream probe, health               | ⛔ **No ONVIF device has ever answered this platform**                               |
| **Runtime Preview** (`demo_cli.py`)   | a real webcam through the real ONNX runtime | It is MJPEG on a side channel, **not the product's live path** (TD-28)               |
| **C-51 dashboard tiles**              | counts and status                           | Static tiles — **no trend, no direction** on any number                              |

⭐ **The demo dataset is invented and must be marked as such** (TD-41). Four fictional tenants,
fictional sites, ffmpeg test patterns for recordings. Custody chains and integrity hashes in it are
genuine; AI output and probe measurements are deliberately not fabricated.

---

## 4 · Hardware-gated — built, wired, never met a device

This is the platform's **largest single risk** and it is unchanged by P-9 Track A, which was
deliberately pre-hardware work.

| Capability                    | State                                                                                                 | Gate                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------- |
| **C-09** ONVIF discovery      | Wired, runs in a deployment, spends its probe window, **zero devices ever**                           | A device on the LAN          |
| **C-10** stream probes        | All 13 stages exercised against a live RTSP transport; never a real firmware                          | One camera per vendor family |
| **C-11** camera health        | 8 of 11 stress scenarios verified synthetically                                                       | ⛔ **A managed PoE switch**  |
| **C-13** NVR/DVR channels     | Templates exist; **never met an NVR**                                                                 | One NVR, ≥4 channels         |
| **Certification**             | Harness complete and refuses to be bought; `reconnect-recovery` + `clean-shutdown` are `not-executed` | A human at the device        |
| **C-14f/C-14g zone accuracy** | Validated against normalised coordinates only                                                         | A camera on a wall (**B4**)  |

⛔ **Nothing on this list can be closed by engineering.** Every row is waiting on a purchase order.
The recommendation and the reason it starts with a switch rather than a camera are in
[P9_TRACK_A_CLOSEOUT](P9_TRACK_A_CLOSEOUT.md) §7.

⚠️ **B4 — zone geometry against a real lens — is the expensive unknown.** Six analytics capabilities
are validated only against normalised coordinates. If perspective turns out to matter, the repair is a
calibration step the product does not have, and it lands _underneath_ every configuration-only
capability on the roadmap.

---

## 5 · Verification-only — exercised by scripts, never by a customer

⚠️ **A distinct and under-appreciated category.** These paths work, are covered by tests, and run in a
deployment — but the only thing that has ever driven them is a verification script. There is no
console surface, no runbook step and no customer workflow that reaches them.

| Path                                       | Driven only by                       | What is missing                                                                       |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------- |
| **Media catalogue** (C-14)                 | `docs/review/p8/*.mjs`               | ⛔ **No console client at all** — a whole service, unseen                             |
| **Certification promotion**                | `certify_cli.py` + unit tests        | An operator surface; a writable registry mount                                        |
| **Installer Toolkit** (`installer_cli.py`) | its own run                          | It has never been used at an installation                                             |
| **Stream probe stages**                    | `docs/review/p9/stream-probe.mjs`    | The camera UI calls it; the results are barely surfaced                               |
| **Rule dry-run**                           | tests + the loitering verification   | It is the single most valuable pre-enable safety net and no journey routes through it |
| **Backup / restore**                       | `infra/docker/*.sh` and a P-5.8 pass | Nobody has restored a **customer's** data                                             |

⭐ **The pattern this platform keeps finding lives here.** `CAMERA_DISCOVERY_URL` was unset in every
deployment ever made; `opencv` was in neither requirements file; camera-scoped rules could not be
enabled in any deployment for four milestones ([L-56](KNOWN_LIMITATIONS.md)) — each one a capability
that was configurable, tested, and had never been _switched on by anything_. Everything in this table
is a candidate for the same defect.

---

## 6 · What a customer can actually use today

The honest journey, end to end, with nothing skipped:

```
✅ Sign in (tenant slug typed by hand — TD-40)
✅ Build a location hierarchy, 8 levels
✅ Onboard a camera by RTSP URL (discovery works; no device has answered it)
✅ Record it — segments written, indexed, and never affected by perception
✅ Assign AI to it — explicitly, per camera, audited
✅ Draw detection zones on its picture, versioned
✅ Author a rule from the Loitering template, dry-run it, tune it, enable it
✅ Receive an incident, in-app and by webhook, in real time
✅ Investigate it: timeline, playback, bookmarks, comments, evidence with an intact custody chain
✅ Download the evidence and verify its integrity outside the platform
⛔ Be told about it by email, SMS, Slack or Teams               ← C-43, does not exist
⛔ Hand a report to a manager, an insurer or the police         ← C-47/C-48, no generator
⛔ Watch the camera live in the console                         ← C-22 / TD-28, no transport
⛔ Upload last Tuesday's footage and ask what happened in it    ← C-21, no upload path
⛔ Search across incidents, cameras, evidence and events        ← C-38, no federator
⛔ Dismiss a false positive as false                            ← C-29a, declared, unreachable
```

⭐ **Four of those six gaps are what a security customer does after the incident**, and the product
currently stops at the moment it is most useful. That is the shape of the remaining work, and it is
why the next milestone is chosen the way it is in
[PRODUCT_IMPLEMENTATION_ORDER](PRODUCT_IMPLEMENTATION_ORDER.md).

---

## 7 · ⛔ Two governance claims that are wrong, found while writing this

Both were found by reading the code rather than the documents, and both change planning decisions.

### 7.1 ⛔ There is no schedule primitive, and the capability map says there is

[VERTICALS.md](../customer-workflows/VERTICALS.md) §1 lists **"Schedule — when a rule is live —
✅ shipped"**. It is not shipped. It does not exist.

```
Rule            → no schedule field (packages/contracts/src/rules/rules.ts:261)
Rules service   → no schedule evaluation anywhere in src/
Contracts       → 'schedule' appears once, as a RuleReferenceKind enum value nothing produces
Console         → 'Schedule' appears once, as a label in RuleValidationPanel
```

⚠️ **Five ✅ rows across four verticals rest on it** — out-of-hours presence, unauthorised entry,
restricted corridor, restricted aisle and staff presence are all marked _expressible with
configuration today_ **because of a primitive that has never been built**. A one-off absolute time
range can be expressed as a condition on `occurredAt` (string comparison, same-typed); a **recurring**
"every night 18:00–06:00" cannot be expressed at all.

⚠️ **And it is not the small feature it looks like.** A schedule needs a timezone, because "9 a.m." is
a local claim — and **no location, node or camera in this platform carries one**. The only timezone
field in the whole contracts package is on `JobSchedule`, which says exactly that in its own comment
and is the precedent to follow.

**Action taken:** the five rows and the primitive table in `VERTICALS.md` are corrected in this commit.
Nothing else is touched. See [RETAIL_CAPABILITY_PACK](RETAIL_CAPABILITY_PACK.md) §5 for what it costs.

### 7.2 ⚠️ Offline analysis will be the first thing to run the rule engine on non-wall-clock time

Not an error, but an unstated assumption that the next milestone breaks. `services/events` uses no
wall clock at all and the dwell stage is explicit that "time comes from the event, not from the node"
— so the **evaluation** is event-time clean. But `InMemoryDwellStateStore` stamps `touchedAtMs` with
`Date.now()` for LRU eviction and sweeping, against a horizon derived from **event-time** durations
(`resetAfterSeconds + cooldownSeconds`), with a single **50,000-entry cap shared by everything the
service evaluates**.

⛔ **Consequence:** an offline analysis of a long recording can evict a live customer's in-progress
dwell, and nothing would report it as anything but `dwellStateEvicted`. Named as a design constraint
in [OFFLINE_VIDEO_PLAN](OFFLINE_VIDEO_PLAN.md) §7 R-2 rather than discovered under load.

---

## 8 · Deployment recommendations

Three deployment shapes. ⚠️ **They are not stages of maturity — they are different promises**, and the
difference is what you are allowed to say while installing.

### 8.1 ✅ Demonstration deployment — do this today

**Promise:** "this is what the product does."

- One host, `./infra/docker/prod.sh build && ./infra/docker/prod.sh up`, then `demo.sh reset`.
- Runs on the invented demo dataset (TD-41), which is **marked as invented** in the seed output.
- ⚠️ Rebuild the seeder image before every demonstration — it rides inside a service image and nothing
  restarts it (TD-55). `deployment-integrity.mjs` §5 checks this and runs first in the gate.
- Add a **Runtime Preview** on a USB webcam for the "is the AI real?" question, and say the sentence
  in §3 while showing it.

**Prerequisites:** none. **Blocked by:** nothing.

### 8.2 ⚠️ Design-partner deployment — supervised, with a written limitations annexe

**Promise:** "this is what the product does **on your cameras**, and we are finding out together."

- ⛔ **An engineer is present.** Not a support arrangement — the [Installer Toolkit](../../ai/inference/installer_cli.py)
  and the [field guide](FIELD_INSTALLATION_GUIDE.md) have never been used at an installation, and
  every instruction in them derives from synthetic runs and convention.
- Read [KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md) **with** the customer, not at them. The six lines in
  §6 marked ⛔ go in the contract as exclusions.
- ⚠️ **Sizing is 2 cameras per host at 2 fps** on a 10-core CPU-only box ([L-41](KNOWN_LIMITATIONS.md),
  [AI_RUNTIME_BENCHMARK](AI_RUNTIME_BENCHMARK.md)). 4 straddles the budget and was withdrawn after it
  reproduced at 0.4 %, 4.4 % and 4.7 % on one commit. **Do not quote 4.**
- Set an explicit `cpus:` limit on the inference service (TD-63, **high**) before a shared host —
  today nothing stops inference taking the cores the decode path needs, and recording is the
  contractual obligation.
- Alerting is **in-app and webhook only**. If the customer needs email or SMS, the deployment waits
  for P-7; there is no workaround and a webhook-to-email bridge is somebody else's product.
- ⚠️ **Every delivery is attempted exactly once** ([L-32](KNOWN_LIMITATIONS.md)). A customer's SOC
  webhook that blips for thirty seconds loses those alerts permanently and the console shows the
  failure. Visibility is not delivery — say so before it happens, not after.

**Prerequisites:** the hardware in [P9_TRACK_A_CLOSEOUT](P9_TRACK_A_CLOSEOUT.md) §7, and Track B run
against it. **Blocked by:** a purchase order.

### 8.3 ⛔ Production deployment for a paying customer — not yet, and the list is short

Five things, none of them perception:

| #   | Blocker                               | Why it is a blocker                                                                               | Where           |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------- |
| 1   | **Off-console alerting** (C-43/C-44)  | A security product that only alerts the screen someone is already watching has not alerted anyone | **P-7**         |
| 2   | **Delivery retry** (TD-53, **high**)  | A thirty-second webhook outage loses alerts permanently, silently, for ever                       | **P-7**         |
| 3   | **Reports & export** (C-47/C-48)      | Nothing can be handed to police, an insurer, HR or a regulator                                    | **P-11**        |
| 4   | **Rate limiting at the edge** (TD-39) | ⛔ Never expose `/api/identity/auth/login` to the internet without it                             | **P-14**        |
| 5   | **Hardware certification** (L-1)      | Every compatibility claim is currently `Pending Validation`                                       | **P-9 Track B** |

⚠️ **Two more before a _multi-customer_ deployment:** distributed rule state (TD-7 — a second replica
silently under-counts threshold rules) and licensing/entitlements (C-61, nothing exists). Neither
blocks a single-customer installation.

⚠️ **Not on this list, deliberately:** live video (C-22). A buyer assumes it exists and it does not,
but a security _operations_ product is bought for the incident queue and the investigation, and every
customer already owns a VMS that plays live video. It is a demo objection, not a deployment blocker.

---

## 9 · What must be said out loud, every time

Six sentences. They are not disclaimers; they are the difference between a pilot that succeeds and one
that ends in an argument about what was promised.

1. **No physical camera has ever been connected to this platform.** ([L-1](KNOWN_LIMITATIONS.md))
2. **A detection zone is drawn on a picture, not on a floor** — no calibration, no ground plane, no
   perspective correction. ([L-58](KNOWN_LIMITATIONS.md))
3. **There is no accuracy number for detection or tracking**, and none can be computed from runtime
   statistics. (TD-64, TD-68, [ADR-0039](../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md))
4. **A dwell threshold under ~20 seconds measures our sampling as much as your policy** — the event
   dedup window is 10 s. ([L-57](KNOWN_LIMITATIONS.md))
5. **Alerts go to the console and to a webhook, once, with no retry.** ([L-32](KNOWN_LIMITATIONS.md))
6. **A false positive is resolved, not dismissed** — so every resolution count mixes "handled" with
   "wasn't real". (C-29a)

---

## Related

- [PRODUCT_IMPLEMENTATION_ORDER](PRODUCT_IMPLEMENTATION_ORDER.md) — ⭐ **what to build next, and why in that order**
- [OFFLINE_VIDEO_PLAN](OFFLINE_VIDEO_PLAN.md) · [RETAIL_CAPABILITY_PACK](RETAIL_CAPABILITY_PACK.md) · [DEMO_MODE_PLAN](DEMO_MODE_PLAN.md)
- [PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md) — the per-capability source of truth
- [KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md) — the customer-facing disclosures
- [P9_TRACK_A_CLOSEOUT](P9_TRACK_A_CLOSEOUT.md) — hardware readiness and the purchase recommendation
