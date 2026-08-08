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

| id        | Capability                                              | Contract |           Backend            |          Frontend           | Demo |                                             Pilot                                             | Prod | Milestone       | Dependencies | Owner     |
| --------- | ------------------------------------------------------- | :------: | :--------------------------: | :-------------------------: | :--: | :-------------------------------------------------------------------------------------------: | :--: | --------------- | ------------ | --------- |
| **C-07**  | Location hierarchy (8 levels, skippable)                |    ✅    |              ✅              |             ✅              |  ✅  |                                              ✅                                               |  ✅  | done            | —            | tenant    |
| **C-08**  | Camera registry & onboarding                            |    ✅    |              ✅              |             ✅              |  ✅  |                                              ✅                                               |  ✅  | done            | —            | camera    |
| **C-09**  | Camera discovery (ONVIF)                                |    ✅    |              ✅              |             ✅              |  ✅  |            ⚠️ wired + runs in a deployment (P-9 A1); ⬜ **no device has answered**            |  ✅  | **P-9 Track B** | hardware     | camera    |
| **C-10**  | Camera capabilities & stream probes                     |    ✅    |              ✅              | ⚠️ client calls it; UI thin |  ⚠️  | ⚠️ all 13 stages exercised against a live RTSP transport (P-9 A2/A11); ⬜ never a real device |  ✅  | **P-9 Track B** | hardware     | camera    |
| **C-11**  | Camera health, measured                                 |    ✅    |              ✅              |             ✅              |  ✅  |     ⚠️ 8 of 11 stress scenarios verified synthetically (P-9 A11); ⬜ never a real device      |  ✅  | **P-9 Track B** | hardware     | camera    |
| **C-12**  | Camera lifecycle — retire · reinstate · bulk            |    ✅    |              ✅              |             ✅              |  ✅  |                                              ✅                                               |  ✅  | **P-6**         | —            | camera    |
| **C-13**  | NVR / DVR channel onboarding                            |    ✅    |      ✅ templates exist      |             ✅              |  ⚠️  |                                    ⬜ **never met an NVR**                                    |  ⚠️  | **P-9**         | hardware     | camera    |
| **C-14**  | Media catalogue — clips & recordings                    |    ✅    |              ✅              |  ⛔ **no console client**   |  ⛔  |                                              ⛔                                               |  ✅  | **P-6**         | —            | media     |
| **C-14a** | ⚠️ **Recording — corrected 2026-08-05**                 |    ✅    |              ✅              |             n/a             |  ✅  |                                        ⬜ unvalidated                                         |  ✅  | **P-8 Phase 2** | —            | media     |
| **C-14b** | ⚠️ **AI inference — real detections**                   |    ✅    |              ✅              |  ✅ reporting only (C-14c)  |  ✅  |                                        ⬜ unvalidated                                         |  ✅  | **P-8 Phase 3** | —            | inference |
| **C-14c** | ⚠️ **Camera processing assignment — BUILT**             |    ✅    |              ✅              |         ✅ 6 pages          |  ✅  |                                        ⬜ unvalidated                                         |  ✅  | **P-8 Phase 6** | C-14b        | camera    |
| **C-14d** | ⚠️ **Object tracking — persistent identities**          |    ✅    |              ✅              |    ✅ read-only, 4 pages    |  ✅  |                                        ⬜ unvalidated                                         |  ✅  | **P-8 Phase 4** | C-14b        | inference |
| **C-14f** | 🔒 **Detection zones — polygons on a camera's picture** |    ✅    |              ✅              |    ✅ editor + versions     |  ✅  |                                        ⬜ unvalidated                                         |  ✅  | **P-8 Phase 7** | C-14c        | camera    |
| **C-14g** | 🔒 **Retail Loitering — the first customer workflow**   |    ✅    |              ✅              |         ✅ 5 pages          |  ✅  |                                        ⬜ unvalidated                                         |  ✅  | **P-8 Phase 7** | C-14d, C-14f | rules     |
| **C-14e** | ⚠️ **Event bridge — perception → events**               |    ✅    |              ✅              |    ✅ read-only, 1 page     |  ✅  |                                        ⬜ unvalidated                                         |  ✅  | **P-8 Phase 5** | C-14d        | media     |
| **C-15**  | Camera zone referential integrity                       |    ✅    | ⚠️ shape-checked only (TD-3) |             n/a             |  ✅  |                                              ⚠️                                               |  ⚠️  | **P-6**         | —            | camera    |

> ⚠️ **C-14a is a correction, and it is the reason the row exists.** Until 2026-08-05 the media image
> **contained no `ffmpeg`**, so every stream start in a deployment failed with `spawn ffmpeg ENOENT`
> and reconnected forever: **recording had never once run in production**, while the catalogue behind
> it was marked production-verified. The unit tests could not see it (they drive the supervisor
> through a decoder fake) and no verification had ever started a stream against a source that exists.
> Fixed in P-8 Phase 2 and **measured**: 16 cameras recording concurrently, segments written and
> indexed, and segments continuing to be written while the perception tier was paused. ⬜ Pilot stays
> unvalidated — the source was synthetic (L-1 stands until P-9).
>
> ⚠️ **C-14b is inference, and only inference.** The deployed runtime runs YOLOX-nano (Apache-2.0) on
> ONNX Runtime and produces real `Detection` objects — verified against the deployment by streaming a
> CC0 photograph of **two** people over RTSP and asserting **exactly two** person detections, and by
> streaming a colour-bar test pattern and asserting **zero**. Nothing consumes those detections: no
> tracking, no rules, no incidents, no alerts, no storage. Frontend is ✅ for **reporting** — the
> AI Runtime page shows what the runtime is doing and configures nothing.
>
> ⚠️ **Hardened and sized, P-8 Phase 3H (2026-08-05).** Results are **reproducible** — twenty runs of
> one frame gave one distinct result, the same two confidences to the last bit, across a container
> recreation. The sizing answer is **2 cameras per host at 2 fps on a 10-core CPU-only box**, computed
> from a 2 % frame-loss budget and reproduced at 0.0 % in three runs; 8 cameras loses 8.0–14.2 %, 16
> loses 18.9–24.4 % ([L-41](KNOWN_LIMITATIONS.md), [AI_RUNTIME_BENCHMARK](AI_RUNTIME_BENCHMARK.md)).
> ⚠️ **4 cameras was published first and withdrawn**: it reproduced at 0.4 %, 4.4 % and 4.7 % on the
> same commit, so it straddles the budget line and is marked provisional rather than quoted. ⚠️ **Detection consistency held at exactly 2.00
> per frame at every rung including saturation** — under pressure the runtime drops whole frames
> rather than returning worse answers, which is a capacity limit and not a correctness bug.
>
> ⚠️ **C-14d — tracking, P-8 Phase 4 (2026-08-05).** Detections became **identities**: the runtime now
> holds tracking state per (tenant, camera) and answers "where did object X move?". Verified against
> **authored ground truth** rather than observation — four clips with written-down trajectories played
> through real RTSP — because "was the answer right?" is only askable when the right answer is known.
> All five identity properties hold on the deployment: one id while continuously visible; the id
> survives a 3.0 s occlusion; the frame genuinely empties on departure; a return gets a **new** id
> linked to the old one (`identityId`, `precededBy`, `recoveries=1`); and two people crossing keep
> their own lanes (vertical spread 0.004 and 0.006) rather than swapping. Tracking costs **≤0.11 ms
> per frame** against ~50 ms of inference.
>
> ⚠️ **The frozen id policy was NOT relaxed to do it.** A returning object never gets its old id back —
> that would break "ids are never reused" silently, for every consumer already holding one. Re-entry is
> a link ([ADR-0038](../adr/ADR-0038-track-identity-across-gaps.md)).
>
> ⚠️ **Frontend is ✅ for reporting and nothing else.** Live Tracks, Track Detail, Track Timeline and
> Runtime Track Statistics are read-only: no rule editing, no incident generation, no acknowledgement,
> and no control that configures the engine. ⬜ Pilot stays unvalidated — the fixtures are composited
> sprites on authored paths, not real CCTV, and [L-1](KNOWN_LIMITATIONS.md) stands. Limits disclosed as
> [L-42](KNOWN_LIMITATIONS.md) (appearance-blind re-entry), [L-43](KNOWN_LIMITATIONS.md) (no
> cross-camera identity) and [L-44](KNOWN_LIMITATIONS.md) (frame widths, not metres).
>
> ⚠️ **Frozen 2026-08-05 with eleven permanent metrics, three of which report "not measurable".**
> `identitySwitches`, `reidentificationSuccessRate` and `falseRecoveries` ask whether the tracker was
> _right_, which needs ground truth a live camera does not carry — so they are `null` with the reason
> attached, never `0`
> ([ADR-0039](../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md)). ⚠️ **This bounds what
> may be claimed for C-14d**: there is no live accuracy number, no tracking health score and no
> accuracy SLA, and none can be computed from runtime statistics. The six accuracy metrics that do
> exist are measured against **authored** clips and certify the tracking logic, not the platform
> against real footage. Per-camera metrics (`/tracking/cameras`) are read-only and tenant-scoped; the
> per-camera enable switch they suggest is **C-14c**, which is not built.
>
> ⚠️ **C-14f / C-14g — detection zones and Retail Loitering, P-8 Phase 7 (2026-08-06).** The first
> **complete customer feature** the platform can demonstrate end to end: a person observed in a named
> area of a camera's picture for longer than a configured time becomes an incident candidate carrying
> the identity, the zone, the duration, an ordered timeline and references to the footage.
>
> ⚠️ **C-14g is a capability of the RULE ENGINE, not a loitering feature.** The word "loitering"
> appears in the id of one template and nowhere in the evaluation path. What was added is a dwell
> stage and a zone scope; intrusion, queue monitoring and abandoned object are the same primitives
> with different parameters. `FUTURE_WORKFLOW_COVERAGE` records, per workflow, which primitive
> expresses it and — for line crossing, occupancy, PPE and theft — exactly what is still missing.
>
> ⚠️ **Hardware validation is ⬜ for both, and the reason is specific rather than procedural.** Zone
> geometry is validated against normalised coordinates; a real camera's lens distortion, mounting
> angle and field of view all change where a floor polygon actually lies. Nothing in this milestone
> was measured against a physical camera, and the accuracy of "was this person inside that area" on
> real hardware is unknown. See KNOWN_LIMITATIONS.
>
> ⚠️ **C-14c — camera processing assignment, P-8 Phase 6 (2026-08-06). This row said ⛔ across every
> column until today.** A customer can now choose which cameras are analysed: a control plane in the
> camera service decides, an enforcement point in media obeys at the perception seam, and recording is
> structurally untouched by the decision. Verified on the deployment with its **negative half** —
> three cameras recording, one assigned, the other two analysing zero frames while writing every
> segment. Profiles, runtimes, capacity, failover, an immutable audit trail and six operator pages;
> ADR-0043.
>
> ⚠️ **What C-14c does NOT include, so nobody reads the ✅ as more than it is.** No auto-balancing
> between runtimes (deliberately deferred — the seam exists, the behaviour does not, and the
> permission for it deliberately does not exist). No licensing enforcement (the limits contract and
> its check exist and answer "no limit configured" on every deployment). Camera groups are stored and
> listed but **no bulk operation targets one**. Four of the six seeded profiles name capabilities the
> deployed runtime does not advertise and are reported as unsupported rather than hidden.
>
> ⬜ Pilot for C-14b stays unvalidated: two photographs are a smoke test
> of the deployed path, **not an accuracy evaluation** — no mAP, no labelled corpus, no claim about
> how this model behaves on a customer's cameras (L-1).
>
> ⚠️ **C-14e — the event bridge, P-8 Phase 5 (2026-08-06).** What perception observes now reaches the
> event platform. Everything downstream of a published `DetectionResult` had existed and been frozen
> since P1-5 — normalize, dedup, persist, republish, evaluate, raise a candidate — and **nothing
> published**, so a platform with a working rule engine could not raise an incident from a camera and
> no test failed, because every part in isolation was correct. Verified on the deployment as one
> chain: frame → inference → tracking → publisher → `capability.output` → events → `event.*` → rules
> → `IncidentCandidate` → workflow → a persisted `Incident` carrying the frame's correlation id.
> ⚠️ **What this does NOT add is business meaning.** No rules ship, no loitering, no intrusion, no
> theft detection; the verification creates one trivial rule as an instrument and deletes it.
>
> ⚠️ **Three limits bound what may be claimed for C-14e.** Delivery is **at-least-once**, not
> exactly-once — suppression holds inside two windows and a replay outside them produces a second
> event ([L-46](KNOWN_LIMITATIONS.md#l-46--event-delivery-is-at-least-once-and-duplicate-suppression-is-a-window)).
> Events are **dropped under pressure by design**, and the ones lost during a broker outage are gone —
> the bridge trades events for recordings, always
> ([L-47](KNOWN_LIMITATIONS.md#l-47--events-are-dropped-under-pressure-deliberately-and-recording-is-not)).
> An incident names the **first** frame in its dedup bucket, not every frame that contributed
> ([L-48](KNOWN_LIMITATIONS.md#l-48--an-incident-names-one-frame-not-every-frame-that-contributed)).
> The page is read-only: publishing is a consequence of frames arriving, and per-camera enable is
> **C-14c**, which is still not built.
>
> ⚠️ **C-14e found a C-14c blocker before C-14c exists.** A stream that stops and starts begins its
> frame sequence at 1 again, and the publisher's ordering gate read every event from the restarted
> camera as stale — measured: 0 published, 32 dropped, indefinitely, silently. That is what Camera
> Processing Assignment does on every enable. Fixed with a capture-time discriminator and guarded by
> a mutation.

## Perception

| id       | Capability                                                 |         Contract         |           Backend            |      Frontend       | Demo | Pilot | Prod | Milestone       | Dependencies       | Owner        |
| -------- | ---------------------------------------------------------- | :----------------------: | :--------------------------: | :-----------------: | :--: | :---: | :--: | --------------- | ------------------ | ------------ |
| **C-16** | Event pipeline — ingest · dedup · persist · replay         |            ✅            |              ✅              |         ✅          |  ✅  |  ✅   |  ✅  | done            | —                  | events       |
| **C-17** | Object detection — person · vehicle · fire · smoke         |            ✅            | ✅ ONNX + YOLOX-nano (C-14b) |         ✅          |  ✅  |  ⬜   |  ✅  | **P-8 Phase 3** | —                  | ai/inference |
| **C-18** | Object tracking (⚠️ zones · counting NOT built)            |            ✅            |   ✅ tracking only (C-14d)   |         ✅          |  ✅  |  ⬜   |  ✅  | **P-8 Phase 4** | C-19               | ai/inference |
| **C-19** | **Media → inference frame bus**                            |            ✅            |  ✅ `HttpFrameSink` (C-14b)  |         n/a         |  ✅  |  ⬜   |  ✅  | **P-8 Phase 2** | —                  | media        |
| **C-20** | **Behaviour analytics** — loitering · intrusion · crowding |            ✅            | ⛔ no analyzer wired (TD-14) |         ⛔          |  ⛔  |  ⛔   |  ⛔  | **P-8**         | C-19 · **D-4**     | ai/inference |
| **C-21** | Upload a recording and analyse it                          |            ✅            |  ✅ timeline + incidents    |         ⛔          |  ✅  |  ✅   |  ⛔  | **P-8 Phase 8** | C-19               | media        |
| **C-22** | **Live video view**                                        | ⛔ no transport contract |          ⛔ (TD-28)          | ⛔ placeholder page |  ⛔  |  ⛔   |  ⛔  | **P-8**         | **ADR: transport** | media        |
| **C-23** | Auto-captured evidence from a live incident                |            ✅            |  ⛔ no-op extractor (TD-15)  |         n/a         |  ⛔  |  ⛔   |  ⛔  | **P-8**         | C-19               | evidence     |
| **C-50** | **Live frame ingest from a browser camera**                |            ✅            |   ✅ `LiveIngest` → the SAME `FrameSink`   |    ✅ Live Capture page    |  ✅  |  ⚠️   |  ⚠️  | **P-9**         | C-19               | media        |
| **C-51** | **Interchangeable detectors** — one runtime, many families |            ✅            | ✅ `register_decoder`: `yolox` · `rtdetr` · `yolo11` |         n/a         |  ✅  |  ⚠️   |  ⚠️  | **P-10 A2**     | C-19 · **ADR-0050** | ai/inference |
| **C-52** | **Multi-modal perception contract** — pose · masks · re-id · OCR · action |            ✅            | ⚠️ contract + registry only; **no such model runs** |         ⛔          |  ✅  |  ⛔   |  ⛔  | **P-10 A1**     | C-51               | ai/inference |
| **C-53** | **Detector benchmark matrix** — one corpus, every detector |            ✅            | ⚠️ framework + 21 tests; **no run executed, no CLI** |         ⛔          |  ✅  |  ⛔   |  ⛔  | **P-10 B**      | C-51               | ai/inference |
| **C-54** | **Behaviour primitives** — motion · zones · relational · object association |            ✅            | ✅ 4 modules on the live path; ✅ **zone primitives execute — membership returns as an observation (ADR-0053)** |    ⚠️ `GET /api/behaviour`    |  ✅  |  ✅   |  ⚠️  | **P-11 slice 2.3** | C-52 · **ADR-0051/0052/0053** | ai/inference |
| **C-56** | **Durable track history** — trajectory per identity, zone membership, retention, erasure |            ✅            | ✅ JSONL store, tenant-scoped, resume verified across a restart |  ⚠️ `GET /api/track-history`  |  ✅  |  ✅   |  ⚠️  | **P-11 slice 2.3** | C-54 · **ADR-0051/0053** | ai/inference |
| **C-65** | **Behaviour API & Timeline** — every primitive of an analysis, inspectable |            ✅            | ✅ recomputed from track history; closed, intent-free vocabulary |  ⚠️ `GET /api/behaviour/{primitives,timeline}` — **no console surface** |  ✅  |  ✅   |  ⚠️  | **P-11 slice 2.3** | C-56 · **ADR-0054** | ai/inference |
| **C-55** | **Retail reasoning** — shelf interaction · concealment · no-checkout |            ⛔ design only            | ⛔ nothing implemented — ships as **rules**, not runtime |         ⛔          |  ⛔  |  ⛔   |  ⛔  | **P-11 (planned)** | C-54 · C-56        | rules        |

> ⭐ **C-50 (P-9) is a producer, not a pipeline, and the ⚠️ in Pilot/Prod is deliberate.** The live
> path runs through the identical runtime, tracker, publisher, rule engine and incident pipeline as
> offline analysis — proved by measurement (identical model id, runtime version, execution provider,
> capability and event types) and guarded by a structural test that fails if a second `/infer` call,
> a second tracker or a second sink ever appears. What is **not** proved is the optics: every frame
> in that validation came from an authored clip or Chrome's fake video device, so C-50 is production
> *code* on validated *synthetic* input. A real camera has never been connected (L-1), and the
> browser is a demonstration path rather than an unattended one (L-72).

> ⭐ **C-51 (P-10 A2) is measured, not asserted.** Two detector families were added as decoder
> registrations with zero changes above `adapters/model_formats.py`, and verified against **real
> artifacts**: RT-DETR and YOLOX put their person boxes in the same place to a **mean IoU of 0.95**
> over the same 40 frames — two models sharing no code path, which is the strongest check on the
> coordinate transform available without ground truth.
> ⚠️ **The ⚠️ in Pilot/Prod is the honest half.** `yolox-nano` remains the only `enabled` entry;
> `rtdetr-r18vd` is registered `disabled` because at **950 ms per frame on CPU** it cannot serve the
> live path, and **YOLO11 has a decoder but deliberately no catalogue entry** — it is AGPL-3.0, which
> a commercial multi-tenant deployment cannot serve over a network, and its `sha256` cannot be filled
> honestly by anyone who has never obtained the artifact.
> ⛔ **Precision and recall are unmeasured** for every detector: that needs the annotated corpus in
> DATASET_STRATEGY, and an accuracy figure from unlabelled frames is exactly the instrument failure
> this project keeps catching. See [DETECTOR_COMPARISON](../validation/DETECTOR_COMPARISON.md).

> ⭐ **C-54, C-56 and C-65 shipped in P-11 slices 2.2–2.3 and run on the deployed stack; C-55
> remains DESIGN ONLY.** The behaviour layer is composed into the existing tracker slot via
> `StageChain` — a structural `Tracker` — so no pipeline stage or configuration channel was added, and
> both the live and recorded paths execute it because both reach the runtime through the one `/infer`.
> ⭐ **The zone gap is closed** ([ADR-0053](../adr/ADR-0053-zone-membership-returns-as-an-observation.md)).
> Membership is still resolved once, in media — there is exactly one point-in-polygon engine in the
> platform — and it returns to the runtime as an *observation* on the next frame. Verified on the
> deployed stack with two operator-drawn zones, over an uploaded recording **and** over the live
> `FrameSink.push` path: `zoneMembership: present` on both, 0 and 1 memberships missed of 23 and 25,
> dwell of 15.0 s and a two-visit 6.5 s, three entries and two exits.
> ⭐ **Scene-level statements now leave on the frame**: `DetectionResult.scene`
> ([ADR-0054](../adr/ADR-0054-a-scene-observation-is-not-a-detection.md), schema **1.2**) — an
> optional additive field, which is the path that contract's own version note sanctions.
> ⚠️ **The remaining ⚠️ is the console.** Every read is an API and no screen shows any of it: an
> investigator today reads behaviour with `curl`, not with the product. That is the next surface, and
> it is named here rather than implied by a green cell.
> ⭐ **C-55 sits in `rules`, not `ai/inference`, and that placement is the architectural decision**
> ([ADR-0052](../adr/ADR-0052-behaviour-reasoning-is-not-perception.md)): the runtime emits
> observations, a rule names an intent. A concealment heuristic inside the runtime would have to be
> duplicated and diverged for hospital, warehouse, school and factory.
> ⚠️ **A correction, recorded rather than quietly edited**: this note previously said C-55 was
> blocked because "no COCO class means merchandise". **That was wrong.** The shipped detector
> already sees `bottle` (39), `backpack` (24), `handbag` (26) and `suitcase` (28) — a takeable object
> and a container — and `shelf` is an operator-drawn zone, not a detection. The pick → conceal →
> leave chain is buildable today. ⚠️ **What is genuinely missing is merchandise *variety* and
> accuracy on it**: a cereal box is not a COCO class, and `yolox-nano` at 25.8 COCO AP faces its
> hardest case in a small object held in a hand under CCTV optics. See
> [PHASE2_PLAN §5](../architecture/PHASE2_PLAN.md).

> ⚠️ **C-53 is a framework with no result, and the ⛔ columns say so.** The matrix runner, the
> uneven-aggregate guard and the summary generator are built and tested; **no benchmark has been
> run**. The host was contended at measurement time (VS Code's renderer alone at 496 % CPU), and a
> latency table produced then would describe an editor. The scene taxonomy in DATASET_STRATEGY is
> specified and **unpopulated** — that footage does not exist.

> ⚠️ **C-52 is a contract, and a contract is not a capability.** `perception.py` can express
> keypoints, masks, embeddings, text and frame-level labels, and the registry can hold a module for
> any of them — but **no pose, segmentation, re-id, OCR or action model exists or runs**. It is
> listed so the boundary is visible rather than implied, and it must never be read as a feature.

> ⚠️ **C-17, C-18 and C-19 are a CORRECTION, made 2026-08-06, and the drift is the point.** They read
> `⛔ NullFrameSink (TD-4)`, `⚠️ stub backend is the default (TD-5)` and `⚠️ runtime only, no frame
source` — describing the platform as it was before P-8 Phase 2. TD-4 and TD-5 were both closed and
> marked resolved in their own register; the P-8 work was recorded against **C-14a/b/d** in the
> Cameras section and these rows were never revisited.
>
> ⚠️ **A matrix that says a shipped capability is ⛔ is exactly as wrong as one saying an unshipped
> capability is ✅**, and it is more dangerous, because it is the document used to decide what to
> build next — someone reading this table would have scheduled a frame bus that has been carrying
> production traffic since Phase 2. The rule that a cell goes ✅ only with deployment evidence has a
> mirror: a cell must come **off** ⛔ when the evidence arrives, in the same slice.
>
> ⚠️ **C-18 was renamed rather than promoted wholesale.** It bundled three capabilities and only one
> of them was built. Tracking is real (C-14d); **zones and counting are not built at all**, and the
> row now says so in its title rather than hiding a ⛔ inside a ✅. ⬜ Pilot stays unvalidated across
> all three — no camera has ever been connected ([L-1](KNOWN_LIMITATIONS.md#l-1--no-camera-has-ever-been-connected)),
> and there are no accuracy gates on the registered model (TD-64).

## Detection → response

| id        | Capability                                          | Contract |         Backend          |  Frontend  | Demo |       Pilot       | Prod | Milestone   | Dependencies | Owner    |
| --------- | --------------------------------------------------- | :------: | :----------------------: | :--------: | :--: | :---------------: | :--: | ----------- | ------------ | -------- |
| **C-24**  | Rule authoring (create)                             |    ✅    |            ✅            |     ✅     |  ✅  |        ✅         |  ✅  | done        | —            | rules    |
| **C-25**  | Rule editing                                        |    ✅    |            ✅            |     ✅     |  ✅  |        ✅         |  ✅  | done (P-6)  | —            | rules    |
| **C-26**  | Rule versions · diff · rollback · dry-run · audit   |    ✅    |            ✅            | ⚠️ partial |  ⚠️  |        ⚠️         |  ✅  | **P-6**     | C-25         | rules    |
| **C-27**  | Rule scoping to hierarchy nodes                     |    ✅    |            ✅            |     ✅     |  ✅  |        ✅         |  ✅  | done        | —            | rules    |
| **C-28**  | Rule state at scale (windowed thresholds)           |    ✅    | ⚠️ **in-process** (TD-7) |    n/a     |  ✅  | ✅ single replica |  ⚠️  | P-14        | Redis        | rules    |
| **C-29**  | Incident lifecycle — **frozen** (ADR-0045)          |    ✅    |            ✅            |     ✅     |  ✅  |        ✅         |  ✅  | done        | —            | workflow |
| **C-29a** | ⚠️ Dismissal · archival — **declared, unreachable** |    ✅    |            ⛔            |     ⛔     |  ⛔  |        ⛔         |  ⛔  | unscheduled | C-29         | workflow |
| **C-30**  | Incident assignment · SLA · activity                |    ✅    |            ✅            |     ✅     |  ✅  |        ✅         |  ✅  | done        | —            | workflow |

> ⚠️ **C-29 — the lifecycle is FROZEN as of 2026-08-06 ([ADR-0045](../adr/ADR-0045-the-incident-lifecycle-is-frozen.md)).**
> `raised · acknowledged · investigating · escalated · resolved · closed`, plus two states that are
> **declared and unreachable** (C-29a). `INCIDENT_LIFECYCLE` in `@vip/contracts` is the single
> declaration of which transitions exist; the workflow service and the console derive from it rather
> than keeping copies. There were **four** copies before the freeze, all agreeing, none checked.
>
> ⚠️ **C-29a is a contract, not a feature, and the row is ⛔ across the board on purpose.** `dismissed`
> and `archived` exist in the enum and no action targets either, so nothing can produce one. The gap
> `dismissed` will close is real and worth naming: today a false positive must be **resolved**, so
> every resolution count and every mean-time-to-resolve mixes "handled" with "wasn't real" — which
> matters now that a customer has a rule to tune. `archived` is **custody**, not an outcome: a
> retention policy moving a record out of the working set, never an operator decision. Neither is
> scheduled, and until one is, the honest answer to "can we dismiss a false positive" is **no**.

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

| id       | Capability                                            |             Contract              | Backend | Frontend | Demo | Pilot | Prod | Milestone | Dependencies           | Owner   |
| -------- | ----------------------------------------------------- | :-------------------------------: | :-----: | :------: | :--: | :---: | :--: | --------- | ---------------------- | ------- |
| **C-41** | In-app notifications · webhook delivery               |                ✅                 |   ✅    |    ✅    |  ✅  |  ✅   |  ✅  | done      | —                      | notify  |
| **C-42** | Notification centre UI                                |                ✅                 |   ✅    |    ✅    |  ✅  |  ✅   |  ✅  | done      | —                      | console |
| **C-43** | **External transports** — email · SMS · Slack · Teams | ⛔ enum is `['in-app','webhook']` |   ⛔    |    ⛔    |  ⛔  |  ⛔   |  ⛔  | **P-7**   | Q-3 additive extension | notify  |
| **C-44** | Notification policies · escalation                    |                ⚠️                 |   ⛔    |    ⛔    |  ⛔  |  ⛔   |  ⛔  | **P-7**   | C-43                   | notify  |
| **C-45** | Real-time delivery (SSE)                              |                ✅                 |   ✅    |    ✅    |  ✅  |  ✅   |  ✅  | done      | —                      | gateway |

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
| **Production-verified**                                | 31    | Deployed, exercised under failure, survives destroy-and-restore |
| **Demo-ready**                                         | 33    | Safe to show today, on the demo dataset                         |
| **Pilot-ready**                                        | 31    | ✅ **No capability is short of pilot-ready any more**           |
| **Architecture-only** (contract frozen, nothing built) | 6     | C-37 · C-38 · C-39 · C-46 · C-47 · C-48                         |
| **Contract missing**                                   | 4     | C-22 · C-43 · C-51 · C-61                                       |
| **Blocked on a product decision**                      | 4     | C-06 (D-1) · C-20 (D-4) · C-38 (D-3) · C-60 (D-2)               |
| **Blocked by a missing service**                       | **0** | Every capability has an owner that exists                       |
| **Never met real hardware**                            | 4     | C-09 · C-11 · C-13 and, through them, C-10                      |

### ✅ Both pilot blockers are closed

**C-25** — a rule can be edited (P-6.1). **C-03** — a user can be re-roled, disabled, re-enabled and
given a new password, and disabling **ends every open session immediately** (P-6.2). Both were
verified against the production deployment rather than the test suite.

⚠️ Closed does not mean finished: P-6 still owes camera management depth, the media catalogue, a
responsive shell and `/live`. **Pilot-ready is a floor, not a ceiling.**

⚠️ **C-41's demo column was ⚠️ for a reason nobody had looked at: the demo dataset contained no
notifications at all.** The seed wrote incidents and no alerts, so the one screen that answers "what
does an operator do when something happens" showed a prospect nothing while the incident queue beside
it was full. P-6.5 seeds the channels and the deliveries the Alert Engine would have produced —
including one webhook failure per vertical, because a product that can only be shown succeeding has
not been shown.

⚠️ **C-12 is ✅ for what the backend has, and the gaps are named rather than shaded.** P-6.6 audited
all 26 camera routes: every one now has a console surface, a camera has an address (`/cameras/:id`),
and the list is answered by the **server** — search across seven fields, location subtree, exact
lifecycle, keyset paging, and an estate count that is the server's rather than a page length.
Measured at 100 · 500 · 1 000 · 5 000 cameras: a page of fifty stays **10–11 ms p95** and page ten
costs what page one costs, so **no virtualization is justified** — the browser holds one page.
⚠️ Three things are recorded rather than ticked: filtering by health and by "not retired" narrow the
rows loaded and not the estate (**L-39 · TD-57**); camera names resolve from a bounded page
(**L-40 · TD-58**); and **no camera is analysed at all** — the media service discards every frame, so
per-camera AI assignment has no source of truth and is **P-8** (**L-37**). ⚠️ A camera edit could
**silently overwrite** another administrator's until this milestone; measured, fixed with a
conditional write, and pinned by a regression written red first.

⚠️ **C-42 acknowledges a delivery, not an incident — and two operators can split one.** Measured at
the P-6.5 freeze: each delivery is exclusive (13 rounds, one winner every time), but an incident that
reached two channels can be taken one channel each by two operators pressing together, and both
acknowledgements are genuine. The console now tells each of them the other is there; nothing yet
**stops** the second. **L-36 → P-7.** ⚠️ The cell stays ✅: what C-42 claims — an operator can see and
clear the queue — is true, and the limitation is disclosed rather than folded into a tick.

⚠️ **C-41's demo column was ✅ on a dataset that was quietly wrong again.** The seeder runs from a
service image nothing rebuilds, so `demo.sh reset` restored the fabricated `attempts: 3` after the
milestone had removed it. Found by the check that asserts the measured truth; fixed by rebuilding;
guarded by `deployment-integrity.mjs` (**TD-55**). A capability matrix cell is a claim about the
**deployment**, and the deployment now has to prove it is the commit before any cell is read.

⚠️ **C-41 delivers once, and that is the whole of it.** The P-6.5 freeze pass drove the real Alert
Engine over four real transports and measured `attempts: 1` on every delivery, successful or failed.
There is no retry, and the fan-out's idempotency guard means a redelivered incident **skips** a
channel that already has a record — so a webhook that was down for thirty seconds loses those alerts
permanently. The console shows the failure with its reason, which is the whole of what the platform
offers here; visibility is not delivery. **L-32**, **TD-53** (high). ⚠️ The demo dataset used to say
`attempts: 3`, describing a mechanism that does not exist; corrected.

⚠️ **C-42's queue is bounded at 500 deliveries**, deliberately and visibly. The screen polls every
page it has loaded, so its background cost grew with each "Load more" — 29 KB per tick at one page,
610 KB at twenty, measured at 5,000 deliveries. **L-34**, **TD-54**.

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
