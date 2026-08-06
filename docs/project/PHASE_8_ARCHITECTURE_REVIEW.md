# Phase 8 Architecture Review

**Written 2026-08-07**, at the P-8 Phase 7 freeze (`647a96e`, evidence `d454928`). Planning only — no
implementation, no runtime change, no frozen milestone touched.

> **The question this review exists to answer:** is the platform genuinely ready for customer
> capability development, or does it only look ready because the last milestone went green?
>
> **The answer is yes for capability development and no for a customer.** Those are two different
> readiness questions and this repository has been conflating them. §1 separates them; everything
> after is the evidence.

Sources read: [MASTER_PROGRESS](../tracker/MASTER_PROGRESS.md) ·
[PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) · [PROJECT_ROADMAP](PROJECT_ROADMAP.md) ·
[PHASE_8_PLAN](PHASE_8_PLAN.md) · [VERIFICATION_AUDIT](VERIFICATION_AUDIT.md) ·
[PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md) ·
[VERIFICATION_MATRIX](../review/p6/VERIFICATION_MATRIX.md) · [ADR index](../adr/README.md) (45) ·
[KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md) (L-1…L-60) · [KNOWN_ISSUES](KNOWN_ISSUES.md) (KI-01…KI-04) ·
[RISK_REGISTER](RISK_REGISTER.md) (R-001…R-032) · [TECH-DEBT](../../tracking/TECH-DEBT.md) (74 rows) ·
[AI_RUNTIME_BENCHMARK](AI_RUNTIME_BENCHMARK.md) · [customer-workflows/](../customer-workflows/) ·
and the source of all eleven services, eight packages, the console and the nightly framework.

---

## ⚠️ 0 · A naming collision that must be settled before this review can be read

**"Phase 8" means two different things in this repository, and "Phase 9" and "Phase 10" mean two
different things each.**

| Number | In [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) | In [PHASE_8_PLAN](PHASE_8_PLAN.md) and MASTER_PROGRESS |
| ------ | ---------------------------------------- | ------------------------------------------------------ |
| **8**  | P-8 · Live Video & Real Perception       | P-8 **Phase 8** — the next capability sub-phase        |
| **9**  | P-9 · Real CCTV & NVR Validation         | P-8 **Phase 9**                                        |
| **10** | P-10 · First Customer Pilot              | P-8 **Phase 10**                                       |

This is not pedantry. **"Real Camera Validation" is P-9 in one scheme and a sub-phase of P-8 in the
other**, and the request that commissioned this review asks for both in the same sentence. A plan
that says "Phase 9" without saying which is a plan that will be executed wrongly by whoever reads it
next.

⚠️ **Recommendation, and §20 assumes it:** retire the sub-phase numbering at Phase 7. P-8 Phase 7 was
the last of a seven-phase perception build; what follows is not an eighth phase of that build, it is
a different kind of work. **Name capabilities, not numbers** — `P-8.C1 Restricted Area`,
`P-8.C2 Count`, and so on — and let P-9 / P-10 / P-11 keep their PRODUCT_ROADMAP meanings unchallenged.
Where this document writes **P-9** or **P-10** unqualified, it means the PRODUCT_ROADMAP milestone.

---

## 1 · Current platform maturity assessment

### The honest scoring

| Dimension                  | Maturity | Evidence                                                                                              |
| -------------------------- | :------: | ----------------------------------------------------------------------------------------------------- |
| **Contracts**              | **4/5**  | 45 ADRs; five frozen perception contracts; additive evolution demonstrated twice under pressure       |
| **Perception pipeline**    | **4/5**  | camera → assignment → inference → tracking → identity → events → rules → incident, all deployed       |
| **Rule engine**            | **4/5**  | scope · condition · window · dwell · schedule · dry-run, replay-deterministic across a restart        |
| **Verification framework** | **4/5**  | 36 nightly stages, 31 scripts, mutation-tested, self-audited — and it found its own defects           |
| **Deployment**             | **4/5**  | 16 containers, destroyed and restored twice, byte-level integrity check against the commit            |
| **Console**                | **3/5**  | 17 feature areas, 131 components, WCAG AA, four render states — but `/live` has no player             |
| **Security**               | **3/5**  | fail-closed tenancy verified 25/25; ⚠️ `*:read` wildcard, shared internal API key, no edge rate limit |
| **Scale**                  | **2/5**  | **2 cameras/host supported.** Single-replica rule engine. No horizontal story                         |
| **Hardware reality**       | **1/5**  | ⛔ **no camera or NVR of any make has ever been connected**                                           |
| **Commercial packaging**   | **1/5**  | no licensing, no entitlements, no per-tenant branding, one capability sellable                        |

### What the scores mean, stated as two separate verdicts

✅ **Ready for customer capability development.** Every primitive the next ten capabilities need is
shipped, deployed and verified. The marginal cost of capability #2 is a template, a workflow document
and a nightly stage — days, not milestones. The infrastructure question is genuinely closed, and
[PHASE_8_PLAN](PHASE_8_PLAN.md)'s Track A/Track B split is the right response to that.

⛔ **Not ready for a customer.** Three gaps, none of which any amount of Track B closes:

1. **No physical camera has ever been connected** (L-1, R-016). Zone geometry — the foundation of
   every capability in every vertical — has been validated only against normalised coordinates from
   synthetic RTSP (L-58, R-031). Lens distortion and mounting angle move where a floor polygon
   actually lies, and the accuracy on real hardware is **unknown**, not "probably fine".
2. **Supported sizing is 2 cameras per host** (4 provisional, three runs disagreeing). A single retail
   store is 20–40 cameras. There is no measured multi-host story.
3. **There is no live video.** `/live` is an honest placeholder with a stream client and no player
   (L-3); the transport ADR named as a P-8 dependency is still undecided. ⚠️ **The milestone is
   literally named "Live Video & Real Perception" and only the second half was built.**

⚠️ **The gap between those two verdicts is the most important thing in this document.** A platform
that can build capabilities quickly and cannot deploy them to a customer will accumulate six
capabilities with the same unvalidated foundation. That is not six times the value; it is six times
the exposure to one measurement nobody has taken.

---

## 2 · Architecture — how every subsystem connects

### 2.1 The whole platform

```
                                     ┌──────────────────────────────────┐
  browser ──── https://localhost ───▶│  Caddy edge (TLS, static, proxy) │
                                     └────────────────┬─────────────────┘
                                        console (SPA) │  /api/*
                                                      ▼
                                     ┌──────────────────────────────────┐
                                     │  gateway :8080                   │  edge-auth · CORS · SSE
                                     │  the ONLY public surface         │  stream hub · system health
                                     └────────────────┬─────────────────┘
                ┌──────────────┬──────────────┬───────┴──────┬──────────────┬──────────────┐
                ▼              ▼              ▼              ▼              ▼              ▼
          identity:8089   tenant:8081    camera:8082    media:8083    events:8084    rules:8086
          auth·users·     hierarchy·     registry·      RTSP·         ingest·        scope·cond·
          sessions        settings       zones·assign   record·frames dedup·persist  window·dwell
                                              │             │              │              │
                ┌──────────────┬──────────────┴─────────────┴──────────────┴──────────────┤
                ▼              ▼                                                          ▼
          workflow:8087   notify:8088                                              evidence:8090
          incident        in-app ·                                                 custody·hash·
          lifecycle       webhook                                                  playback refs
                                                      ▲
                                     ┌────────────────┴─────────────────┐
                                     │  inference :8085  🔒 FROZEN      │  ⚠️ no published port
                                     │  Python · ONNX · yolox-nano      │  ⚠️ not a gateway upstream
                                     │  detection → tracking → identity │  reached ONLY by media
                                     └──────────────────────────────────┘

  infrastructure:  mongodb:8 (standalone)  ·  nats:2.10 JetStream  ·  minio  ·  redis:7 ⚠️ NO CONSUMER
```

### 2.2 The perception data plane — the path a person becomes an incident

```
   RTSP                media                       inference (frozen)
  camera ──frames──▶ [ decode ] ──HTTP push──▶ [ detect ]──▶[ track ]──▶[ identity ]
     ▲                    │                                                   │
     │ 5 s poll           │ ◀────────────── DetectionResult + Track ──────────┘
     │                    │
     │              [ zone resolve ]   ⚠️ point-in-polygon on the subject's FEET,
     │                    │               normalised [0,1] image coords, 6–11 µs/frame
     │                    ▼               ONE detection → ONE event PER ZONE occupied
     │              [ publish ] ──NATS──▶ events:8084
     │                                        │  dedup 10 s logical / 2 min transport
     │                                        │  ⚠️ THIS is the resolution floor (L-57)
     │                                        ▼
     │                                   EventEnvelope ──NATS──▶ rules:8086
     │                                                              │
   camera:8082 ◀── assignment plan ──┐                    ┌─────────┴──────────┐
   [ ASSIGNMENT CONTROL PLANE ]      │                    │ scope → condition  │
   which cameras are analysed,       │                    │ → window → DWELL   │  ⚠️ in-memory
   by which runtime, within a        │                    │ → cooldown         │     state (L-59)
   declared capacity — and the       │                    └─────────┬──────────┘
   ZONES ride on the same plan       │                              ▼
   (ADR-0043, ADR-0044)              │                    IncidentCandidate
                                     │                              │
                                     └──── observed state ──▶  workflow:8087
                                           (measured, never                │
                                            inferred)          Incident ──▶ notify:8088
                                                                     │
                                                                evidence:8090
```

### 2.3 The five architectural seams that make this reviewable

| Seam                           | What it guarantees                                                                            | Enforced by                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Events-only boundary**       | No service calls another service's database; perception reaches business logic only as events | `check:imports` · `perception-boundary.mjs`           |
| **Perception boundary**        | Exactly one file may call the runtime; only media knows where it lives                        | `perception-boundary.mjs` §A/§B — a **build** failure |
| **Control plane / data plane** | Assignment declares; the enforcement point reports what it actually did                       | ADR-0043 · `observed.stale` is never inferred         |
| **Two zones, two fields**      | A _place_ (`nodeIds`) can never be matched against a _polygon_ (`detectionZoneIds`)           | ADR-0044 · separate contract fields                   |
| **Event-time discipline**      | Every stateful stage reads `envelope.occurredAt`, never a node clock                          | ADR-0041 · proven by `rule-replay.mjs` (208 fields)   |

⚠️ **The last one is the load-bearing seam for everything in §15.** Replay determinism across a
service restart is what makes a new stateful stage — count, absence, line crossing — a bounded piece
of work rather than a research project. It was measured at this freeze, not assumed.

---

## 3 · Platform strengths

**These are the things that would be expensive to rebuild and are already right.**

1. ⭐ **The pipeline is genuinely domain-neutral.** Eight hops, none of which contains the word
   "retail". Loitering is one template id; the engine has never heard of it. This is the strongest
   result the platform has, and [VERTICALS.md](../customer-workflows/VERTICALS.md) makes it falsifiable
   rather than asserting it — if a vertical needs a ninth hop, the design was wrong.

2. ⭐ **Verification is treated as production code, and it earned that treatment.** Two full nightlies
   at this freeze found 15 defects, **none in the runtime**. 36 stages, 31 scripts, every one running
   against the deployment through `https://localhost` — none imports a component or starts a service
   in-process. Every claim in the verification matrix was witnessed.

3. ⭐ **Honesty is mechanised, not aspirational.** ADR-0039 (absent is `null` with a reason, never `0`);
   the sizing policy enforced by `report.mjs` reading a persistent ledger, so a single good night
   cannot promote a number; `ZONE_EVALUATION` refusing to store a shape nothing can evaluate;
   `FUTURE_WORKFLOW_COVERAGE` naming what is missing per workflow. These are checks, not intentions.

4. ⭐ **Deployment integrity is byte-level.** `deployment-integrity.mjs` proves the running bytes are
   the committed bytes across every service, package, browser bundle and the Python runtime — and it
   has gone red on three real states without needing a mutation.

5. ⭐ **The frozen runtime boundary held under seven phases of pressure.** The inference service
   publishes no port, is not a gateway upstream, and is reachable only by media. Seven phases of
   perception work did not erode it, and a static check makes eroding it a build failure.

6. **Explainability is first-class.** `RuleExplanation`, `StageTrace`, `ConditionTrace`,
   `CandidateTimeline`, `trackFragments`, `longestGapSeconds` — an operator can see why a candidate
   exists and how confident the platform's own measurement is. Most products in this category cannot.

7. **The nightly framework is manifest-driven.** Adding a capability adds a folder and rows; it never
   edits the engine. Five profiles (nightly · weekly · benchmark · pilot · hardware) already exist,
   including a `hardware` profile written before there is hardware.

---

## 4 · Remaining architectural risks

Ranked by what they would cost if unaddressed when a customer arrives.

| #        | Risk                                                                                                                                                                                          | Sev      | Where it bites                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------- |
| **AR-1** | ⛔ **Zone geometry has never met a lens.** Every capability in every vertical is a polygon test; the polygon has only ever been tested against synthetic normalised coordinates (L-58, R-031) | **High** | The first pilot, on day one              |
| **AR-2** | ⛔ **The rule engine cannot be scaled horizontally.** Window state _and_ dwell state are in-process (TD-7, L-59, R-024). A second replica silently under-counts                               | **High** | The first customer above 2 cameras/host  |
| **AR-3** | ⛔ **No live video, and the transport ADR is undecided.** A CCTV product one click from login with no player (L-3)                                                                            | **High** | The first demo                           |
| **AR-4** | ⚠️ **Absence cannot be expressed.** The engine reacts to events; "the zone emptied" produces none. It needs a clock the engine owns — a genuinely new shape, not a new stage                  | **Med**  | Bed-exit, unattended post, blocked route |
| **AR-5** | ⚠️ **Cross-camera identity is research, not engineering.** Identity is within a camera (L-43). Patient wandering and following are not schedulable                                            | **Med**  | Any hospital or campus conversation      |
| **AR-6** | ⚠️ **The dedup window is a floor under every time-based capability.** ~10 s between observations of a continuously present subject (L-57), platform-wide, for one stage's benefit             | **Med**  | Any threshold under ~20 s                |
| **AR-7** | ⚠️ **Five frozen contract families have no server** — search, saved investigations, jobs, reporting, access audit (R-020). A milestone scoped as "UI only" over them is a backend milestone   | **Med**  | P-11 and P-12 estimates                  |
| **AR-8** | ⚠️ **MongoDB is standalone, so there are no transactions.** Bulk assignment validates atomically and writes non-atomically; a fault mid-write yields HTTP 207 (L-51)                          | **Med**  | An operator enabling AI on 50 cameras    |
| **AR-9** | ⚠️ **The nightly is the freeze authority and grows ~5 stages per capability.** 36 today. Ten more capabilities is ~86, and the night is finite                                                | **Med**  | Capability #3 or #4                      |

⚠️ **AR-2 deserves its own sentence.** The platform's answer to load today is _refuse_ — the
assignment control plane declines a camera rather than degrade everything, which is correct and was
verified. But refusing is only a good answer while the ceiling can be raised by adding a host, and
that requires a rule engine that survives being run twice. **Redis is already deployed in the
production compose, `@vip/config` already exposes `REDIS_URL`, and no service consumes it** — the
`RuleStateStore` and `DwellStateStore` ports are unchanged and ready. The fix is a wiring exercise,
not an infrastructure programme, and it is much cheaper than the risk table makes it look.

---

## 5 · Technical debt

74 rows in the register. The ones that touch Phase 8 work:

| ID        | What                                                                               | Why it matters now                                          | Sev  |
| --------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---- |
| **TD-7**  | Rule window state in-process; a Mongo `listEnabled` query **per event**            | Blocks horizontal scale (AR-2) _and_ is a per-event DB read | high |
| **TD-4**  | Media stream state in memory; media→camera auth is a **shared `INTERNAL_API_KEY`** | A leaked key authorises any internal caller                 | high |
| **TD-64** | No FP/FN promotion gates against a labelled corpus                                 | The platform can say inference **runs**, never **how well** | high |
| **TD-26** | `*:read` grants every future read permission to every viewer                       | Each new read permission silently widens existing roles     | med  |
| **TD-6**  | Lifecycle producers still log rather than publish (`LoggingEventPublisher`)        | `tenant.*`/`camera.*`/`media.*` are not replayable          | med  |
| **TD-28** | No live transport                                                                  | AR-3                                                        | high |
| **TD-29** | H.265 probed, never decoded                                                        | P-9 will meet it on the first Hikvision                     | med  |
| **TD-38** | Backups per-collection consistent, not point-in-time                               | The only limitation whose impact is unbounded (with L-18)   | med  |
| **TD-39** | No rate limiting at the edge                                                       | An internet-facing deployment has no throttle               | med  |

### ⚠️ Two debts that are not in the register and should be

- **DEBT-A · Redis runs with no consumer.** A container in the production compose, with credentials,
  a healthcheck and a config module, that nothing connects to. Either wire it (TD-7, L-59) or remove
  it — a running dependency nobody uses is an attack surface and an operator's false assumption.
- **DEBT-B · The verification matrix has an acknowledged hole.** P-8 Phase 5 (6 scripts) and Phase 6
  (5 scripts) run nightly and have been red for the right reason, and **their rows were never
  written**. The file says so plainly, which is the right call — but it means the canonical inventory
  covers 20 of 31 scripts.

---

## 6 · Verification debt

From [VERIFICATION_AUDIT](VERIFICATION_AUDIT.md) — 34 stages, 31 scripts, eight questions, nine findings.

| ID      | Finding                                                                                            | Status                   | ⚠️ What it can still hide                                                    |
| ------- | -------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| **F-1** | **Five of six ladders publish capacity numbers without asserting the rungs scaled**                | ⛔ open                  | A ladder measuring one camera and labelling it sixteen. **It happened once** |
| **F-2** | `rows.every(...)` with no non-empty guard — 6 checks in 2 files                                    | ⛔ open                  | A ladder that recorded zero rungs reports six greens                         |
| **F-3** | Two mutation harnesses verify the **tree** after restore, never the deployment                     | ⛔ open                  | A failed restore is indistinguishable from a successful mutation             |
| **F-4** | A refusal treated as fatal; one throw took out four stages                                         | ✅ fixed `93aa0aa`       | —                                                                            |
| **F-5** | Four verifications had not caught up with the assignment gate                                      | ✅ fixed                 | —                                                                            |
| **F-6** | Generated artifacts: timestamps, tracked writes, formatting                                        | ✅ fixed, **KI-04 open** | A run that can delete a tracked file nothing references                      |
| **F-7** | **Stage independence is declared but not enforced** — 3 real ordering constraints live in comments | ⚠️ recorded              | Reordering the manifest breaks a stage for a reason no field records         |
| **F-8** | `rule-replay` waits 20 s for the zone catalogue instead of polling readiness                       | ⚠️ recorded              | Flaky on a slower host, and the failure looks like a determinism defect      |
| **F-9** | **Where nothing is wrong** — 6 properties confirmed sound                                          | ✅                       | —                                                                            |

Plus the four open issues: **KI-01** dashboard red since 2026-08-05 · **KI-02** a vacuous tracking
mutation (6/6 coverage claimed, one check never shown able to fail) · **KI-03** broker-resilience,
counters suggest a settling-time defect in the check, unresolved because _an inference from five
counters is not a measurement_ · **KI-04** an unidentified deleter of a tracked file.

⚠️ **F-1 is the one to pay down before Phase 8, and the reason is specific.** Every new capability
ships a benchmark (deliverable 7). Five of the six ladders that exist cannot notice if their rungs
stop scaling. Adding ten more ladders built on that pattern multiplies a known blind spot by ten —
and this is exactly the "an instance was fixed and the class was left" shape that rule 8 of the
Definition of Done was written against, applied _before_ the instances exist rather than after.

---

## 7 · Runtime limitations

| Limitation                  | Measured value                                            | Consequence                                                                       |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Model class vocabulary**  | `person` (deployed); vehicle/fire/smoke declared          | ⛔ PPE, forklift, vehicle, abandoned object are **model work**, not platform work |
| **Observation interval**    | ~10 s per subject (`EVENTS_DEDUP_WINDOW_MS`)              | L-57 — a floor under every time-based capability                                  |
| **Dwell durability**        | in-memory, swept, evicts under pressure                   | L-59 — a restart forgets a visit in progress; cool-downs too                      |
| **Zone anchor**             | subject's floor contact point, normalised `[0,1]`         | L-58 — no calibration, no ground plane, no perspective correction                 |
| **Identity scope**          | within one camera, geometric, no appearance model         | L-42, L-43 — a duration can span the wrong person (R-030)                         |
| **Assignment confirmation** | up to 2 poll cycles (5 s each)                            | L-50 — a paused camera may show a frame or two behind the pause                   |
| **Delivery semantics**      | at-least-once; 2 min transport / 10 s logical suppression | L-46, ADR-0042 — consumers must key on `EventEnvelope.id`                         |
| **Broker outage**           | 4 events lost across a 20 s outage; **recordings kept**   | L-47, R-025 — deliberate: the bridge trades events for recordings                 |
| **Evaluable geometry**      | polygon, rectangle. `line`/`path`/`direction` refused     | `ZONE_EVALUATION` — declarable, storable, not evaluated                           |
| **Zone catalogue warmth**   | 15 s refresh; a just-created zone resolves by id          | L-60 — closed for restarts 2026-08-06, open for new zones                         |
| **Detection consistency**   | **exactly 2.00/frame at every rung including saturation** | ✅ under pressure the runtime drops whole frames; it does not degrade answers     |

⚠️ **The last row is the one worth carrying into every capability conversation.** A capacity limit
and a correctness bug look identical from a dashboard. This platform measured the difference.

---

## 8 · Physical camera limitations

⛔ **This is the largest single gap between what the platform can demonstrate and what it can be
deployed into, and no amount of capability work closes it.**

| What has never happened                                                        | Consequence                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| No **Hikvision · Dahua · CP Plus · UNV · Axis** device has ever been connected | Every vendor-compatibility statement is a prediction (L-1, R-016) |
| No **NVR/DVR** of any make; `DVR_TEMPLATES` has never met one                  | Channel-path templates are untested against firmware              |
| **H.265 probed, never decoded** (TD-29)                                        | A codec path that has run zero frames                             |
| No lens distortion, mounting angle or field-of-view has ever been in the loop  | **Zone accuracy on real hardware is unknown** (L-58, R-031)       |
| No night vision, IR, variable bitrate, long recording, corrupt clip            | The failure modes real estates actually produce                   |
| ONVIF discovery exercised against synthetic sources only                       | C-09 carries `⬜ never met a real device`                         |

⚠️ **Why this is an architecture risk and not just a test gap.** Ten capabilities are being planned
on a zone primitive whose real-world accuracy is unmeasured. If perspective turns out to matter — and
on a camera looking along a room, equal areas of image are wildly unequal areas of floor — the repair
is a **calibration step the product does not have**, and it lands underneath all ten rather than
inside one. Validating the primitive once costs ~2 engineer-weeks. Discovering it after ten
capabilities costs ten re-validations and a customer's confidence.

---

## 9 · Scalability risks

| #        | Risk                                                                                                                                   | Ceiling today                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **SR-1** | ⛔ **2 cameras per host supported, 4 provisional.** A single retail store is 20–40 cameras. There is no measured multi-host deployment | 2 (supported) / 4 (provisional, not quotable) |
| **SR-2** | ⛔ **The rule engine cannot run twice.** Window and dwell state are in-process; a second replica silently under-counts (TD-7, R-024)   | 1 replica                                     |
| **SR-3** | ⚠️ **A Mongo `listEnabled` query per event.** Fine at 1.37 events/s; it is a per-event database read at any real volume                | untested above ~1.4 events/s                  |
| **SR-4** | ⚠️ **Standalone MongoDB.** No transactions, no failover, no read replicas (L-17, L-51, AR-8)                                           | single node                                   |
| **SR-5** | ⚠️ **Sizing above ~100 cameras is arithmetic** (L-20) — extrapolated, never measured                                                   | 16 measured, 100+ arithmetic                  |
| **SR-6** | ⚠️ **Camera names resolve from the first 200** (L-40); health filters the rows loaded, not the estate (L-39)                           | ~200 in several console paths                 |
| **SR-7** | ⚠️ **The nightly grows ~5 stages per capability** — 36 today, ~86 at ten more capabilities, on a finite night                          | the wall clock                                |

⚠️ **SR-1 and SR-2 compound, and that is the real finding.** Adding a host raises the camera ceiling
only if the rule engine can be replicated; replicating the rule engine today silently under-counts
threshold rules. **The scale story is not "we have not measured it yet" — it is "the design has a
known single-replica constraint that has not been removed."** That is a small, well-understood piece
of work (the ports exist, Redis is deployed) and it is the difference between a 2-camera demo and a
40-camera store.

---

## 10 · Performance risks

**Measured at the freeze** ([AI_RUNTIME_BENCHMARK](AI_RUNTIME_BENCHMARK.md)):

| Cameras | Analysed fps | Drop % | Runtime CPU | event→rule | rule→candidate | end to end |
| ------: | -----------: | -----: | ----------: | ---------: | -------------: | ---------: |
|       1 |          2.3 |  0.0 % |       114 % |   66–68 ms |     4.4–4.9 ms |   69–72 ms |
|       2 |          4.4 |  0.0 % |       197 % |   86–91 ms |     3.3–4.9 ms |   89–95 ms |
|       4 |          9.2 |  0.4 % |       298 % | 115–125 ms |     3.8–4.0 ms | 118–128 ms |
|       8 |         16.9 |  8.0 % |       526 % |     196 ms |         4.5 ms |     186 ms |
|      16 |         31.6 | 18.9 % |       797 % |     848 ms |         7.6 ms |     866 ms |

| #        | Risk                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PR-1** | ⚠️ **The same ladder moved 38 % between two runs 90 minutes apart with nothing but documentation changed.** Both tables are in the record. This is why sizing needs three agreeing runs |
| **PR-2** | ⛔ **CPU saturates before anything else.** 797 % at 16 cameras on a CPU-only `yolox-nano`. There is no GPU path, and no measurement of one                                              |
| **PR-3** | ✅ **The rule engine is not the bottleneck and this is measured, not assumed.** event→rule rises 13× across the ladder; rule→candidate rises 1.7× at ~1 % CPU / 105 MB                  |
| **PR-4** | ✅ **Zone geometry is free** — 10.6 µs/frame at one camera, _falling_ to 6.3 µs at sixteen. Per-frame cost does not grow with the estate                                                |
| **PR-5** | ⚠️ **Every latency above is from synthetic RTSP at 2 fps.** Real cameras at 15–25 fps with variable bitrate are a different offered load entirely                                       |
| **PR-6** | ⚠️ **Model warm-up earns less than expected** and identity fragmentation under load is **provisional** — two runs disagree by a factor of five                                          |

⚠️ **PR-3 is the good news and it should shape Phase 8 directly.** Every capability in §15 that is
"zone + a stateful stage" lands in the half of the pipeline that costs almost nothing. **Capability
work is cheap; the transport half is where the money goes.** Ten more rule templates will not move
these numbers. Six more cameras will.

---

## 11 · Security review

### What is verified

| Control                   | State                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Tenant isolation**      | ✅ fail-closed, 25/25 checks in P-5.8 — including a token whose tenant header was ignored in favour of its claim |
| **Single public surface** | ✅ the gateway. The inference runtime publishes **no port** and is **not** an upstream — asserted every night    |
| **Authn**                 | ✅ OIDC/JWT + refresh; sessions end immediately on disable, and the count is reported                            |
| **Authz**                 | ✅ RBAC/ABAC via the policy engine; every panel and route independently fail-closed                              |
| **Secrets**               | ✅ `.env`-only, none committed; gitleaks + semgrep in CI                                                         |
| **Evidence custody**      | ✅ integrity hash + custody record; immutable evidence package (ADR-0020)                                        |
| **Deployment integrity**  | ✅ byte-level, every service · package · browser bundle · Python runtime                                         |

### ⚠️ What is open

| #         | Finding                                                                                                                                                                      | Sev      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **SEC-1** | ⛔ **`*:read` grants every future read permission to every viewer** (TD-26, R-022). Each new read permission silently widens existing roles — and Phase 8 adds read surfaces | **High** |
| **SEC-2** | ⛔ **Service-to-service auth is a shared `INTERNAL_API_KEY`** (TD-4), not a per-service machine principal. One leaked key authorises any internal caller                     | **High** |
| **SEC-3** | ⚠️ **No rate limiting at the edge** (TD-39, L-19). An internet-facing deployment has no throttle                                                                             | Med      |
| **SEC-4** | ⚠️ **A disabled account's access token stays valid up to 15 minutes** (L-23). Belongs in the customer's security review                                                      | Med      |
| **SEC-5** | ⚠️ **Suspending a tenant does not lock anyone out** (L-24)                                                                                                                   | Med      |
| **SEC-6** | ⚠️ **Settings changes are audited to the log, not to a queryable trail** (L-25). The access audit (Q-9) has no server                                                        | Med      |
| **SEC-7** | ⚠️ **Runtime occupancy is visible across tenants** (L-52) — a count only, deliberately, with the reasoning recorded                                                          | Low      |
| **SEC-8** | ⚠️ **Redis runs with credentials and no consumer** (DEBT-A). Unused attack surface                                                                                           | Low      |

⚠️ **SEC-1 interacts with Phase 8 directly and should gate it.** Every capability adds read
endpoints. Under a `*:read` wildcard, **each new capability silently widens every existing viewer
role at the moment it ships** — nobody grants the permission, and nobody reviews it. Ten capabilities
is ten silent widenings. This is small work (enumerate read permissions per role) currently scheduled
at P-14, and §15 recommends pulling it forward.

⚠️ **Two things a customer conversation must not skip:** education deployments involve **minors**, and
healthcare deployments carry **clinical-safety and consent duties** the platform does not address. It
makes retention, access and explanation content configurable; it does not choose them, and it provides
no regulatory position. Also stated in [VERTICALS.md](../customer-workflows/VERTICALS.md), and it
belongs in the first meeting rather than the security review.

---

## 12 · Deployment review

**16 containers.** 11 services (10 Node/Fastify + 1 Python), 4 infrastructure (mongodb:8 standalone ·
nats:2.10 JetStream · minio · redis:7), Caddy edge, console SPA, plus three seeders.

| Property               | State                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| **Reproducibility**    | ✅ destroyed and restored **twice**; every verification enters through `https://localhost`     |
| **Integrity**          | ✅ running bytes == committed bytes, proven per service and per package                        |
| **Health / readiness** | ✅ `/health` + `/ready` on every service; readiness reports _why_, not just a boolean          |
| **Observability**      | ✅ Prometheus per service; ADR-0039 — absent is `null` with a reason, never `0`                |
| **Build discipline**   | ⚠️ `./infra/docker/prod.sh` is required; plain `docker compose` is missing `MONGO_USER`        |
| **Single host**        | ⛔ no failover, no HA, no multi-region (L-17)                                                  |
| **Backups**            | ⚠️ per-collection consistent, not point-in-time (L-18, TD-38). **Restore itself is proven**    |
| **Retention**          | ⛔ no automated sweeps or tier transitions (TD-18)                                             |
| **Unused dependency**  | ⚠️ **Redis has no consumer** (DEBT-A)                                                          |
| **Install path**       | ⚠️ [DEPLOYMENT.md](../runbooks/DEPLOYMENT.md) has never been executed by anyone but its author |

⚠️ **The last row is the deployment risk that matters for a pilot**, and it is the one nobody has
tested. P-10's own exit criterion is _"installed from DEPLOYMENT.md alone, no improvisation — if a
step is wrong, fix the guide."_ Until someone follows it cold, the platform's install story is a
document, not a procedure. The gap between "16 containers come up on the machine that built them" and
"16 containers come up on a customer's machine" contains the `prod.sh`/`MONGO_USER` class of surprise,
and the only way to find those is to have someone else try.

---

## 13 · Customer workflow review

**One workflow exists**: [Retail-Loitering.md](../customer-workflows/Retail-Loitering.md).

| Criterion                     | Verdict                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| States the business problem   | ✅ and states what it is **not** — not theft, not intent, not a judgement about a person    |
| Traces the full flow          | ✅ eight hops, each mapped to the subsystem that owns it                                    |
| Names operator actions        | ✅ the six configuration steps, five of which are the customer's                            |
| Records limitations honestly  | ✅ L-57, L-58, L-59 in the customer's language, not the engineer's                          |
| Every number measured         | ✅ zone geometry, dwell, latency — from the deployment, never projected                     |
| ⚠️ **Reusable as a template** | ⚠️ **partially.** It is an excellent document and there is no stated shape for the next one |

### ⚠️ Findings

1. **⛔ Ten capabilities are already expressible with configuration and have no workflow document.**
   Restricted area, shelf visit, staff presence, unauthorised entry, restricted aisle, loading-bay
   dwell, restricted zone, machine-guard breach, restricted corridor, out-of-hours presence — across
   five verticals. This is the highest value-per-hour work available. ⚠️ **And the risk is the exact one
   this platform keeps finding: a capability that is configurable and unverified.** Camera-scoped
   rules were enablable in the contract and unusable in every deployment for four milestones, because
   nothing had tried (L-56). Five templates nobody has run are five of those waiting.

2. **⚠️ `RULE_TEMPLATES` contains exactly one entry.** The template mechanism is built and carries a
   population of one. A customer's self-service story is "configure the loitering template, or write a
   rule from primitives."

3. **⚠️ Machine-guard breach is expressible and must carry a warning.** A video pipeline with
   in-memory state and a documented restart gap (L-59) must **never** be the only thing between a
   person and a machine. VERTICALS.md says so; a per-capability workflow document must repeat it
   rather than assume the reader found it there.

4. **✅ The exclusion of theft is correct and should stay.** Theft is an inference about intent
   assembled from weak signals. The platform can supply the signals; _"this person spent 90 seconds at
   the spirits cabinet and left through the fire door"_ is a fact an operator can act on, and
   _"suspected theft"_ is an accusation the platform cannot support.

---

## 14 · Capability dependency graph

**What can be implemented without changing infrastructure.**

```
                        ┌─────────────────────────────────────────────┐
                        │  SHIPPED PRIMITIVES — no change required    │
                        │  zone · scope · condition · window · dwell  │
                        │  identity · schedule · dry-run · evidence   │
                        │  model registry · assignment · templates    │
                        └──────────────────────┬──────────────────────┘
                                               │
        ┌──────────────────────────────────────┼───────────────────────────────┐
        │                                      │                               │
   ✅ ZERO ENGINE WORK                    🔶 ONE NEW STAGE               🔴 MODEL WORK
   (template + doc + verification)        (beside `dwell`)               (not platform work)
        │                                      │                               │
        ├─ Restricted area        (retail)     ├─ COUNT ─────┬─ Queue length   ├─ PPE detection
        ├─ Shelf visit            (retail)     │  (distinct  ├─ Corridor       ├─ Forklift class
        ├─ Staff presence         (retail)     │   subjects) ├─ Dock occupancy ├─ Vehicle class
        ├─ Unauthorised entry     (hospital)   │             ├─ Student crowd  ├─ Abandoned object
        ├─ Restricted aisle       (warehouse)  │             └─ Traffic queue  └─ Fall / pose
        ├─ Loading-bay dwell      (warehouse)  │
        ├─ Restricted zone        (factory)    ├─ LINE GEOMETRY ─┬─ Tailgating
        ├─ Machine-guard breach ⚠️ (factory)   │  (`line` declared,│─ Wrong-way (+direction)
        ├─ Restricted corridor    (education)  │   non-evaluable) └─ Vehicle counting
        └─ Out-of-hours presence  (education)  │
                                               │
                                               ├─ ABSENCE ⚠️ ─────┬─ Bed-exit
                                               │  needs a clock   └─ Unattended post
                                               │  the engine owns
                                               │
                                               └─ DISPLACEMENT ── Stopped vehicle

                        ┌─────────────────────────────────────────────┐
                        │  ⛔ RESEARCH — do not schedule as engineering│
                        │  Cross-camera identity → patient wandering, │
                        │  following through a building, and theft    │
                        └─────────────────────────────────────────────┘
```

### Reading the graph

- ✅ **Ten capabilities need no engine change at all**, across five of the six verticals. They need a
  template, a customer workflow document and a verification. This is the whole of the immediate
  opportunity, and it is larger than it looks because **most of the ten are the same rule** — zone
  scope plus dwell plus a schedule, with different numbers and a different word.
- 🔶 **One primitive — `count` — unlocks five capabilities across five verticals.** It is the highest
  leverage single piece of engineering available.
- 🔴 **Four rows are model work.** The runtime is model-agnostic and the registry supports it; the
  model is not a platform capability and no row pretends otherwise.
- ⛔ **Two rows are research.** Cross-camera identity has no appearance model and no plan for one.

⚠️ **The cost curve is not flat and planning as though it is will hurt.** The first capability was
expensive. The next ten are cheap. The eleventh is expensive again — because the eleventh is the one
that needs a primitive that does not exist. ⚠️ [VERTICALS.md](../customer-workflows/VERTICALS.md) §3
says "the next six"; the full classification in §16 puts it at ten, which strengthens rather than
changes its point.

---

## 15 · Recommended implementation order

**Ordered by evidence and dependency, not by which vertical asked.**

| Order | Work                              | Track | Why here                                                                                                                                                                   | Size        |
| ----: | --------------------------------- | :---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **1** | ⭐ **Real Camera Validation**     |  A/B  | ⛔ Everything below is built on a zone primitive that has never met a lens. Validating once costs ~2 weeks; discovering it after ten capabilities costs ten re-validations | ~2 wks      |
| **2** | **Retail capability pack**        |   B   | 3 ✅ rows, zero engine work, and the only vertical with a shipped workflow to copy. **It defines the shape every later pack reuses**, which is most of its value           | days        |
| **3** | **Warehouse capability pack**     |   B   | 2 ✅ rows — restricted aisle and loading-bay dwell are the same rule with different numbers. Nearly free once #2 defines the shape                                         | days        |
| **4** | **Education capability pack**     |   B   | 2 ✅ rows — pure schedule work. ⚠️ Carries the **minors** decision, so its document matters more than its code                                                             | days        |
| **5** | **Aggregation primitive (count)** |   A   | The one primitive worth building next: 5 capabilities × 5 verticals, one new stateful stage beside `dwell`, no new service                                                 | 1 milestone |
| **6** | **Factory capability pack**       |   B   | 2 ✅ rows; PPE and forklift are 🔴 model work. ⚠️ Ships with the safety-rating warning or not at all                                                                       | days + 🔴   |
| **7** | **Hospital capability pack**      |   B   | 1 ✅ row; corridor congestion needs #5; bed-exit needs **absence**; wandering is ⛔ research. Also the heaviest regulatory load                                            | partial     |
| **8** | **Traffic capability pack**       |   B   | ⚠️ Illegal parking is Retail Loitering with a different model — and the model is the gate. Mostly 🔴, last on evidence                                                     | 🔴 gated    |

### Why Real Camera Validation is first, stated plainly

⚠️ **It is not first because hardware is exciting. It is first because it is the only item on the list
whose finding invalidates the others.**

- Every capability in packs 2–8 is a polygon test. If perspective turns out to matter, the repair is a
  calibration step the product does not have, and it lands **underneath** all of them.
- It is the only work whose start date is not under engineering control — procurement is the gate, so
  it must start now regardless of what is built alongside it.
- It closes the **highest-severity open risk** in the register (R-016, High/High) and the one open
  High risk from this milestone (R-031).
- ✅ **It parallelises perfectly.** Packs 2–4 need no hardware. Procurement and pack work run
  simultaneously; the validation run itself is ~2 engineer-weeks _once hardware is present_.

### Three items that are not capability packs and must not be lost

| Work                                             | Track | Why it cannot wait for P-14                                                                                                         |
| ------------------------------------------------ | :---: | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Enumerate read permissions (SEC-1, TD-26)**    |   A   | ⛔ **Every capability shipped under a `*:read` wildcard silently widens every viewer role.** Ten capabilities, ten silent widenings |
| **Redis-backed rule + dwell state (TD-7, L-59)** |   A   | The single-replica ceiling (AR-2, SR-2). Ports exist, Redis is deployed and unused. Small work, large risk                          |
| **Ladder invariants (F-1)**                      |   A   | Every capability ships a benchmark. Fix the pattern **before** ten more instances of it exist                                       |

All three pass Track A's admission test: each is blocking a Track B capability or was surfaced by
something measured.

---

## 16 · Capability classification

**Legend** — **C** configuration only · **R** rule only (template + defaults) · **I** existing
infrastructure · **E** requires new engine work · **M** requires AI model work.

### Retail

| Capability        | Class       | What it actually needs                                                              |
| ----------------- | ----------- | ----------------------------------------------------------------------------------- |
| Loitering         | ✅ shipped  | —                                                                                   |
| Restricted area   | **R + I**   | template + doc + verification. Zone scope + short/zero dwell                        |
| Shelf visit       | **R + I**   | ⚠️ short thresholds meet the ~10 s sampling floor (L-57) — its doc must say so      |
| Staff presence    | **R + I**   | ⚠️ _presence_, not _identification_ — the platform cannot tell staff from customers |
| Queue length      | **E**       | count aggregation                                                                   |
| Queue abandonment | **E**       | count + exit detection                                                              |
| Tailgating        | **E**       | line geometry + crossing + inter-arrival                                            |
| Theft attempt     | ⛔ research | composition of weak signals across rules and cameras                                |

### Hospital

| Capability          | Class       | Needs                                                                |
| ------------------- | ----------- | -------------------------------------------------------------------- |
| Unauthorised entry  | **R + I**   | zone scope + schedule                                                |
| Corridor congestion | **E**       | count aggregation                                                    |
| Bed-exit            | **E**       | ⚠️ **absence** — an inversion the event-driven engine cannot express |
| Fall detection      | **M**       | a pose/action model                                                  |
| Patient wandering   | ⛔ research | cross-camera identity                                                |

### Warehouse

| Capability        | Class     | Needs                                                       |
| ----------------- | --------- | ----------------------------------------------------------- |
| Restricted aisle  | **R + I** | zone scope + schedule                                       |
| Loading-bay dwell | **R + I** | zone scope + long dwell — the shipped template, retimed     |
| Dock occupancy    | **E**     | count aggregation                                           |
| Abandoned object  | **E + M** | ⚠️ `groupBy: track` exists for this; the **model** does not |
| Vehicle movement  | **E + M** | vehicle class + line crossing                               |

### Factory

| Capability               | Class     | Needs                                                                               |
| ------------------------ | --------- | ----------------------------------------------------------------------------------- |
| Restricted zone          | **R + I** | zone scope + immediate or dwell                                                     |
| Machine-guard breach     | **R + I** | ⚠️ **not a safety-rated interlock** — supervisory beside a rated one, never instead |
| PPE detection            | **M**     | a helmet/vest **attribute** on the detection                                        |
| Forklift safety          | **M + E** | forklift class + proximity                                                          |
| Person-vehicle proximity | **E**     | spatial relation between two subjects                                               |

### Education

| Capability            | Class     | Needs                                                                                       |
| --------------------- | --------- | ------------------------------------------------------------------------------------------- |
| Restricted corridor   | **R + I** | zone scope + schedule                                                                       |
| Out-of-hours presence | **R + I** | zone scope + schedule. ⚠️ retention and access are the customer's decision, made explicitly |
| Student crowding      | **E**     | count aggregation                                                                           |
| Exit-route blockage   | **E + M** | dwell on a non-person class                                                                 |

### Traffic

| Capability         | Class     | Needs                                                              |
| ------------------ | --------- | ------------------------------------------------------------------ |
| Illegal parking    | **M**     | ⚠️ **the rule is identical to loitering** — only the model differs |
| Queue / congestion | **E**     | count aggregation                                                  |
| Stopped vehicle    | **E + M** | displacement predicate + vehicle class                             |
| Wrong-way movement | **E + M** | direction geometry + track heading                                 |

### The summary that matters

**31 capability rows across six verticals**, each counted once by its hardest requirement:

| Class                                     |  Count | Cost                             |
| ----------------------------------------- | -----: | -------------------------------- |
| ✅ **Shipped**                            |  **1** | —                                |
| **R + I** — template + doc + verification | **10** | days each, **no engine change**  |
| **E only** — new engine work              |  **9** | 4 primitives cover all nine      |
| **E + M** — engine _and_ model            |  **6** | ⚠️ gated on the model, not on us |
| **M only** — model work                   |  **3** | ⚠️ not platform work             |
| ⛔ **Research**                           |  **2** | not schedulable                  |

⚠️ **Ten capabilities are a template, a document and a verification away.** Four primitives — count,
line geometry, absence, displacement — cover all nine engine-only rows, and **count alone covers five
of them across five verticals**. Nine of the thirty-one rows are gated on a model the platform does
not ship, which is a procurement or training question rather than an architecture one. Two rows are
research and should never appear on a schedule.

---

## 17 · Capability SDK — the reusable template

**Every future capability is built this way.** Not a framework to write; a shape to follow, derived
from what Retail Loitering actually needed.

### 17.1 The eleven artifacts

```
packages/contracts/src/rules/templates.ts       1 ▸ RuleTemplate + FUTURE_WORKFLOW_COVERAGE row
docs/customer-workflows/<Capability>.md         2 ▸ the customer-facing reference architecture
docs/review/p8/<capability>.mjs                 3 ▸ end-to-end verification, incl. NEGATIVE controls
docs/review/p8/<capability>-mutations.mjs       4 ▸ mutation harness — ≥6 breaks, each named
docs/review/p8/<capability>-benchmark.mjs       5 ▸ ladder WITH A SCALING INVARIANT (F-1)
docs/review/p8/<capability>-ui.mjs              6 ▸ browser verification, every number traced
scripts/nightly/stages/<domain>/*.sh            7 ▸ nightly stages, in EVERY applicable profile
services/rules/src/application/metrics.ts       8 ▸ Prometheus counters — absent is null, never 0
apps/console/src/features/<capability>/         9 ▸ operator surfaces (only if new ones are needed)
docs/adr/ADR-nnnn-*.md                         10 ▸ only if a decision was made; index row SAME COMMIT
governance                                     11 ▸ capability matrix · limitations · MASTER_PROGRESS
```

⚠️ **All eleven ship in one commit or the capability is not shipped.** A capability with seven of them
has shipped something nobody can operate, and the missing one is always the one that would have caught
the defect.

### 17.2 The build sequence

| #   | Step                              | ⚠️ The trap it avoids                                                                                       |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | **Write the workflow doc first**  | Writing it after the code produces a description of what was built, not of what a customer needs            |
| 2   | **Classify honestly** (§16)       | An **M** row sold as an **R** row is a research project with a delivery date                                |
| 3   | **Name the limitations up front** | Dwell had three (L-57/58/59). A capability that claims none has not looked                                  |
| 4   | **Author the template**           | Sane defaults. ⚠️ `cooldownSeconds: 0` produced five candidates for one stationary person                   |
| 5   | **Verify with both halves**       | A positive that fires **and** a negative that must not, **on the same deployment at the same moment**       |
| 6   | **Mutate before believing**       | ⚠️ Two of Phase 7's eight mutations were **vacuous** and only running them found it                         |
| 7   | **Benchmark with an invariant**   | ⛔ F-1. `offered == delivered + dropped + failed`, or a per-rung scaling signal. **No invariant, no table** |
| 8   | **Register nightly, same commit** | A verification that ran once                                                                                |
| 9   | **Read the green run**            | ⚠️ Phase 7 went green and _then_ produced two defects, found by reading the numbers rather than the ticks   |

### 17.3 The invariants a new stateful stage must satisfy

Any stage added beside `dwell` — count, absence, displacement — must hold all six:

| #   | Invariant                                                                                     | Why                                                                                  |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | **All time comes from `envelope.occurredAt`, never a node clock**                             | ADR-0041. It is what makes replay deterministic — proven, 208 fields                 |
| 2   | **Pure, total, deterministic: `(record, observation) → record`**                              | Testable without a broker, a camera or a wall clock                                  |
| 3   | **State is bounded and swept, and eviction is a visible metric**                              | `dwellStateEvicted` exists because silent eviction is indistinguishable from silence |
| 4   | **State is behind a port with an in-memory adapter**                                          | `DwellStateStore` is why L-59's fix is a wiring change                               |
| 5   | ⚠️ **The stage states what it measures, in the customer's words, including what it does NOT** | "Elapsed span between first and most recent sighting" ≠ "continuous presence"        |
| 6   | ⚠️ **The stage declares its interaction with the ~10 s dedup window**                         | Dwell would have been silently frame-rate-dependent if it had counted events         |

⚠️ **Invariant 6 is the one `count` will get wrong if nobody writes it down now.** A count over a
dedup-collapsed event stream is **not** "how many people are here" — it is "how many distinct subject
keys the platform observed in the last bucket". Those diverge exactly when a customer cares: a busy
queue. **The primitive must state which of the two it reports, and be verified against a scene with a
known number of people**, or it will ship a plausible number that is quietly wrong.

### 17.4 Definition of done for a capability

- [ ] All eleven artifacts, one commit
- [ ] The eight subsystem deliverables — runtime · metrics · browser · deployment · mutation · nightly · benchmark · governance
- [ ] Both halves verified on the deployment at the same moment
- [ ] Every mutation red **at the check that names the fault**, then green again
- [ ] The ladder asserts its rungs scaled **before** publishing a number
- [ ] Limitations recorded with an owner and a tracker id
- [ ] Capability matrix ✅ only where it is true of the **deployment**
- [ ] The green run's samples file **read**, not just its exit code

---

## 18 · Verification framework — mandatory vs nightly-only

**36 stages today.** At ~5 stages per capability, ten more capabilities is ~86 on a finite night (SR-7).
Tiering is not a velocity optimisation; it is what stops the nightly becoming unrunnable.

### Tier 1 — MANDATORY, every commit (target < 10 min)

| Verification                                  | Why it can never move                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm format` · `typecheck` · `lint` · `test` | The gate. ⚠️ Run it **after** the last file changes, not before                    |
| `pnpm build` · python unittest (1036)         | A broken build is not a nightly finding                                            |
| `pnpm verify:contracts` · `check:imports`     | Boundary violations are **build** failures, not review items                       |
| `perception-boundary.mjs`                     | One file may call the runtime. Cheap, static, absolute                             |
| **`deployment-integrity.mjs`**                | ⛔ **Nothing else means anything until the running bytes are the committed bytes** |

### Tier 2 — MANDATORY for the milestone that changes the subsystem (< 15 min)

The end-to-end run · the UI run · the deployment verification for **the subsystem being changed
only**. This is the existing verification-economy policy — _verify what changed_ — and it stays.

### Tier 3 — NIGHTLY (> 15 min, or needs an idle machine)

| Category               | Stages                                                 | Why nightly                                               |
| ---------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| **Capacity ladders**   | runtime · tracking · assignment · rule · publisher (5) | 6–15 min each; need an idle host to mean anything         |
| **Mutation harnesses** | runtime · tracking · assignment · rule · bridge (5)    | 25–50 min each; rebuild images                            |
| **Soak / stability**   | stability · inference-soak                             | 15–40 min by definition                                   |
| **Replay determinism** | `rule-replay`                                          | ⚠️ waits out the broker's duplicate window **twice**      |
| **Timing suites**      | `nightly-tests`                                        | Timing assertions need an idle machine                    |
| **Broker resilience**  | `broker-resilience`                                    | ⚠️ Stops the broker every service shares. **Always last** |

### Tier 4 — WEEKLY (recommended change)

⚠️ **Move the four _unchanged-subsystem_ mutation harnesses to weekly.** A mutation harness proves a
verification can fail; that property does not decay nightly, it decays when someone edits the
verification or the code it covers. Running all five every night costs **2–4 hours** to re-prove four
properties nobody touched.

**The rule:** a subsystem's mutation harness runs **nightly in the milestone that changes it**, and
**weekly** otherwise. This is the single largest recoverable block of night, and it recovers it
without weakening any claim — the `weekly` profile already exists.

### ⚠️ Three framework changes that should precede Phase 8

| #        | Change                                                                                                                                                        | Finding |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **VF-1** | **A scaling invariant in every ladder.** Fix the pattern before ten more ladders inherit the blind spot                                                       | F-1     |
| **VF-2** | **Encode the three ordering constraints in the manifest**, not in comments — `broker-resilience` last, `deployment` before any rebuild, `rule-replay` alone   | F-7     |
| **VF-3** | **Mutation harnesses re-verify the deployment after restore**, not only the tree — otherwise a failed restore is indistinguishable from a successful mutation | F-3     |

⚠️ **And one thing that must not be tiered away.** `deployment-integrity.mjs` stays in Tier 1
whatever the cost. Every other verification's meaning is conditional on it, and a fast suite that
measured the wrong build is worse than a slow suite that measured the right one.

---

## 19 · From development platform to deployable commercial product

**Six things stand between this repository and a product someone can buy. None is perception work.**

| #        | Gap                               | State today                                                                | What "commercial" needs                                                                         |
| -------- | --------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **CP-1** | ⛔ **Hardware compatibility**     | No camera has ever been connected                                          | A supported-hardware list built from evidence, not a plan (P-9)                                 |
| **CP-2** | ⛔ **Scale**                      | 2 cameras/host supported; single-replica rule engine                       | A measured multi-host story. A store is 20–40 cameras                                           |
| **CP-3** | ⛔ **Live video**                 | `/live` is honest and empty; the transport ADR is undecided                | A player in Chrome, Edge, Firefox and Safari against the deployment                             |
| **CP-4** | ⛔ **Licensing and entitlements** | No contract exists                                                         | Camera counts, feature gates, plans — refused at the boundary, not warned in a log              |
| **CP-5** | ⚠️ **Install and operate**        | DEPLOYMENT.md has never been executed by anyone but its author             | A cold install by someone else, and every wrong step fixed in the guide                         |
| **CP-6** | ⚠️ **Support surface**            | Excellent internal governance; no customer-facing docs beyond one workflow | One workflow document per sellable capability, plus a limitations pack read _with_ the customer |

### The three-stage commercialisation path

```
  STAGE 1 · SELLABLE DEMONSTRATION            ← ~1 milestone away
     Retail + warehouse + education packs · real camera validation started
     Honest limitation pack · one vertical's workflow documents complete
     ⚠️ Sell the investigation workflow. Never sell camera compatibility

  STAGE 2 · PILOT-READY                       ← the P-10 gate
     Real cameras validated · live video · 2 replicas measured
     Read permissions enumerated · DEPLOYMENT.md executed cold by someone else
     Alerting beyond the console (P-7) · restore verified ON THE CUSTOMER'S HOST

  STAGE 3 · COMMERCIALLY DEPLOYABLE           ← post-pilot, informed by it
     Licensing · entitlements · per-tenant branding · rate limiting
     Retention sweeps · point-in-time backup · HA/failover
     ⚠️ The pilot's findings re-open this list. Everything here is provisional until then
```

⚠️ **The commercial risk is not that the platform is weak. It is that it is strong in a way that is
hard to sell and untested in the way buyers evaluate.** Replay determinism, mutation-tested
verification, and byte-level deployment integrity are genuinely rare and no buyer will ask about any
of them. They will ask _"can I see my camera?"_ (CP-3), _"will it work with my Hikvisions?"_ (CP-1)
and _"how many cameras per box?"_ (CP-2) — and today the honest answers are no, unknown, and two.

⚠️ **The corollary, and it is a discipline rather than a slogan.** L-1 is still the most important
sentence in the limitation register: _do not sell on camera compatibility; sell on the investigation
workflow, and let the pilot answer the compatibility question honestly._

---

## 20 · Updated roadmap

⚠️ **Using PRODUCT_ROADMAP numbering throughout, per §0.** The P-8 sub-phase numbering ends at Phase 7.

### P-8 completion — capability packs + the platform's three blockers

**Goal:** turn one sellable capability into eleven, and remove the three things that would make all
eleven unsellable.

| Track | Work                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Ladder invariants (F-1) · read-permission enumeration (SEC-1) · Redis rule + dwell state (TD-7, L-59) · manifest ordering (F-7)                                                     |
| **B** | Retail pack (3) · warehouse pack (2) · education pack (2) · factory pack (2, with the safety warning) · hospital unauthorised entry (1) — **10 new capabilities, zero engine work** |
| **A** | **Count aggregation** — one stateful stage, five capabilities, five verticals                                                                                                       |
| ⛔    | **Not in scope:** theft · new services · cross-camera identity · any frozen-contract change without a verification proving a real architectural issue first                         |

**Exit:** ten new capabilities each with a template, a workflow document, a mutation test and a
nightly stage · the rule engine measured running **twice** with identical results · no viewer role
widened by a capability shipping.

⚠️ **P-8 does not close without live video (CP-3, AR-3), and this must be decided explicitly.** The
milestone is named "Live Video & Real Perception" and only perception was built. Either the transport
ADR is taken and the player built inside P-8, or **P-8 is renamed** and live video becomes its own
milestone. What must not happen is P-8 being marked complete with half its title unbuilt.

### P-9 · Real CCTV & NVR Validation ⭐ **starts now, in parallel**

**Goal:** stop saying "unverified". Unchanged from PRODUCT_ROADMAP, with one addition.

⚠️ **Procurement starts immediately** — it is the only gate not under engineering control.
Hikvision · Dahua · CP Plus · UNV · Axis, each in H.264 and H.265, plus one four-channel NVR.
~2 engineer-weeks once hardware is present. The `hardware` nightly profile already exists.

⚠️ **The addition this review makes: zone geometry against a real lens is a P-9 exit criterion.**
Draw a polygon on a floor, stand a person in it, and measure whether the platform agrees — at three
mounting angles. It is the measurement that turns L-58 and R-031 from unknown into known, and it is
the one thing every capability in §16 depends on.

### P-10 · First Customer Pilot — **the gate**

Unchanged, plus: a **cold install** from DEPLOYMENT.md by someone who did not write it, and a restore
**verified on the customer's host**. ⚠️ Everything after P-10 stays provisional until the pilot's
findings re-open it.

### MVP release

**Definition — the smallest thing worth money:** eleven configurable analytics capabilities ·
validated hardware for **at least two vendor families** · live video · alerting beyond the console
(P-7) · 2 replicas measured · read permissions enumerated · a limitations pack read _with_ the
customer.

⚠️ **Explicitly not in the MVP:** count aggregation (valuable, not required), reporting, export,
search, saved investigations, dashboards, licensing. **A customer will pay for eleven working
capabilities on their own cameras before they pay for a report generator.**

### Pilot customer

The P-10 gate, run as written. ⚠️ **Read KNOWN_LIMITATIONS _with_ the customer before they sign** —
every row in L-1…L-7 is something they would otherwise discover in week one, and a limitation a
customer discovers for themselves is a defect that has already cost something.

### Production release (P-14 / GA)

Licensing · entitlements · per-tenant branding · rate limiting · retention sweeps · point-in-time
backup · HA and failover · narrowed `*:read` · legal hold and redaction. Reordered by the pilot.

### The sequence

```
  NOW ─┬─▶ P-9 procurement ────────────▶ P-9 hardware validation ──┐
       │   (not under our control)        ⭐ zone geometry vs lens  │
       │                                                            ▼
       ├─▶ Retail · warehouse · education packs ──▶ factory ──▶ P-10 PILOT ──▶ MVP ──▶ P-14 GA
       │   (no hardware needed)                                     ▲              ▲
       ├─▶ Track A: F-1 · SEC-1 · TD-7/L-59 ──────────────────────┘              │
       │                                                                           │
       ├─▶ Live video transport ADR + player (CP-3) ──────────────────────────────┘
       │
       └─▶ Count aggregation ──▶ queue · congestion · occupancy · crowding (5 verticals)
```

---

## ⭐ 21 · The single highest-value next milestone

# **Real Camera Validation (P-9), started immediately and run in parallel with the retail capability pack.**

### Why it is first

**1 · It is the only work whose finding invalidates everything else.** All ten
configuration-only capabilities in §16 — and the shipped one — are a polygon test on a camera's
picture. That polygon has been validated **only against synthetic RTSP in normalised coordinates**. If
lens distortion or mounting angle turns out to move where a floor polygon lies — and on a camera
looking along a room, equal areas of image are wildly unequal areas of floor — the repair is a
calibration step the product does not have, and it lands **underneath all eleven rather than inside
one**.

**2 · The cost of finding out late is multiplicative.** Validating the primitive once is ~2
engineer-weeks. Discovering it after five capability packs is five re-validations, ten workflow
documents rewritten, and a customer conversation that starts with a correction.

**3 · It is the only milestone whose start date is not under engineering control.** Procurement is
the gate. Every day it does not start is a day added to the critical path, and no amount of capability
velocity buys it back.

**4 · It closes the highest-severity open risks.** R-016 (High/High, open since the roadmap review)
and R-031 (High, raised by this milestone and explicitly _"open until P-9 — do not quote zone accuracy
to a customer before then"_).

**5 · It does not compete with capability work.** ⭐ Procurement is a purchase order; the packs need
no hardware. **Both proceed at once**, which is why the recommendation is _"P-9 started, retail pack
built"_ rather than a choice between them.

**6 · It is what makes the platform's own honesty discipline pay.** L-1 has been _"the most important
sentence in this document"_ since it was written. Every milestone since has carried `⬜ unvalidated`
for pilot readiness. The platform has been scrupulously honest about a gap it has not yet closed —
and there is a point at which continuing to record a limitation becomes a substitute for removing it.

### ⚠️ What would make this recommendation wrong

Stated so it can be argued against rather than accepted:

- **If hardware cannot be procured in this quarter**, then P-9 cannot start and the ranking collapses
  to the retail pack first — but the procurement request should still be raised **today**.
- **If a specific customer is already committed to a specific vertical**, their vertical's pack
  outranks the generic retail pack. It does **not** outrank P-9, because their cameras are the ones
  the zone primitive will meet.
- **If the platform intends to demo before it pilots**, live video (CP-3) outranks everything,
  because _"can I see my camera?"_ is the first question in every first meeting and today the answer
  is no.

---

## Related

[PHASE_8_PLAN](PHASE_8_PLAN.md) · [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) ·
[VERIFICATION_AUDIT](VERIFICATION_AUDIT.md) · [DEFINITION_OF_DONE](DEFINITION_OF_DONE.md) ·
[KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md) · [KNOWN_ISSUES](KNOWN_ISSUES.md) ·
[RISK_REGISTER](RISK_REGISTER.md) · [customer-workflows/](../customer-workflows/) ·
[VERTICALS](../customer-workflows/VERTICALS.md) · [ADR index](../adr/README.md)
