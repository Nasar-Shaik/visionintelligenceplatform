# AI Runtime Benchmark

> **The reference every future optimisation is measured against.** Numbers here come from the
> deployed Docker stack and nowhere else. When a change claims to make inference faster, it is
> claiming to beat this page.

**Last measured: 2026-08-05** · P-8 Phase 3H (production hardening) · commit recorded per run.

---

## ⚠️ Read this before quoting any number

**This is a developer workstation, not a server.** Every figure below is what an Apple M1 Pro inside
a Docker VM produced. It is a _reference point for comparison_, not a capacity promise to a customer:
a Xeon with AVX-512 and a GPU will behave differently in kind, not only in degree.

**The source is a looped photograph, not a camera.** Frames are H.264-encoded by `mediamtx`,
decoded by `ffmpeg`, re-encoded as JPEG, and posted to the runtime — the full production path — but
the pixels come from one CC0 still image. Nothing here is a claim about vendor compatibility
([L-1](KNOWN_LIMITATIONS.md)) or about model accuracy ([TD-64](../../tracking/TECH-DEBT.md)).

**No sizing number is published until three clean runs agree on it** (standing policy, 2026-08-05).
A single ladder is a measurement; a recommendation is a claim that the measurement repeats, and those
are different assertions. The first version of this page conflated them and published a
four-camera recommendation that two later runs contradicted — see the sizing section. Every rung is
now re-measured on every nightly run, so a number that stops reproducing is caught here rather than
in a customer's deployment.

**Some windows were shared with local builds, and those are labelled.** The sizing ladder, warm-up
and reproducibility figures were taken on a **quiet host** — only the platform's own containers. Part
of the stability run overlapped image builds and test runs, and those figures are reported as a
**range against the clean ones** in the section below, never averaged into them. No number here is
quoted to more precision than it deserves.

---

## What was measured

|                        |                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| **Hardware**           | Apple M1 Pro · 10 cores (10 physical) · 32 GB                                                             |
| **Docker**             | Engine 29.5.3 on macOS 26.5.2 · VM allocated **10 CPUs / 7.75 GB**                                        |
| **Runtime image**      | `vip/inference:local` · **479 MB** · `python:3.12-slim` + onnxruntime 1.19.2, numpy 2.0.2, pillow 11.3.0  |
| **Runtime version**    | `0.1.0` · `DetectionResult` schema **1.1** · model source `local` (in-image catalogue, not MLflow)        |
| **Media image**        | `vip/media:local` · 904 MB · `node:22-alpine` + ffmpeg                                                    |
| **Model**              | `yolox-nano` v1.0.0 · Apache-2.0 (Megvii) · 3 659 407 bytes · sha256 `c789161ed43c…`                      |
| **Model input**        | 416×416 NCHW float32 BGR, letterbox pad 114 — fingerprint `1.0/letterbox-416x416-NCHW-float32-BGR-pad114` |
| **Execution provider** | `CPUExecutionProvider` · intra-op threads from the cgroup quota (10) · inter-op 1                         |
| **Capability**         | `perception.person-detection` v0.1.0 · confidence floor **0.50**                                          |
| **Scene**              | One CC0 photograph containing **exactly two people**, looped at 15 fps over RTSP                          |
| **Sampling**           | Media requests **2 fps per camera**; each rung is a 25 s window after 10 s of warm-up                     |

⚠️ **The runtime container has no CPU limit** ([TD-63](../../tracking/TECH-DEBT.md)). It is free to
take the whole VM, and at the top of the ladder it takes most of it. Every CPU figure below should be
read as "what it took when nothing stopped it", not "what it needs".

---

## ⚠️ Clean benchmark vs shared-host benchmark

Two kinds of number appear below and they must not be averaged together.

|                        | **Clean**                          | **Shared host**                                  |
| ---------------------- | ---------------------------------- | ------------------------------------------------ |
| What was running       | Only the platform's own containers | The platform **plus** image builds and test runs |
| Single-frame inference | **35–41 ms**                       | not measured in this state                       |
| 4-camera p95           | **98–116 ms**                      | **118–168 ms**                                   |
| 4-camera runtime CPU   | **137–210 %**                      | **292–347 %**                                    |

The shared-host figures are not noise to be discarded — they are the honest answer to "what happens
when this host is also doing something else", and a deployment that shares a box with anything will
see them. They are reported as a **range**, never folded into a mean with the clean figures.

The distinction was measured, not assumed: the stability run's p95 fell from 168 ms to ~100 ms and
its CPU from 292 % to 137 % at the exact point local builds stopped, with the workload unchanged.

---

## Stability run — 4 cameras, 53 minutes continuous

⚠️ **Ended deliberately at 53 minutes, not completed at 120.** The Architect's execution policy of
2026-08-05 replaced routine multi-hour soaks with a 10–15 minute stability run, reserving long soaks
for a suspected leak, a release candidate, real-hardware validation (P-9), pilot readiness (P-10) or
GA. This run was already past four times the new standard when the policy landed, so it was stopped
and its evidence kept. Raw log: [`docs/review/p8/soak-53min.txt`](../review/p8/soak-53min.txt).

| Measurement                     | Result over 53 minutes                                                     |
| ------------------------------- | -------------------------------------------------------------------------- |
| **Detection consistency**       | **exactly 2.00 detections/frame in every sample** — the check that matters |
| **Memory**                      | **111 → 118 MB**, oscillating in a band; no monotone climb                 |
| **Queue depth**                 | **0 in every sample**                                                      |
| **Runtime-side dropped frames** | **0**                                                                      |
| **Frames analysed**             | 452–499 per minute (≈ 488 mean, 8 fps offered across 4 cameras)            |
| **p95 inference latency**       | 98–116 ms clean · 118–168 ms while builds ran                              |
| **Runtime CPU**                 | 137–210 % clean · 292–347 % while builds ran                               |
| **Cumulative**                  | 25 868 frames → 51 739 detections = **2.0001 per frame**                   |

⚠️ **What 53 minutes cannot tell you.** It cannot rule out a slow arena leak. Memory moved within a
±3 MB band with no trend, which is evidence against a _fast_ leak and no evidence at all about a slow
one. That question is deferred to P-9 real-hardware validation, not answered here.

---

## 📐 Deployment sizing reference — the permanent table

**Clean host.** 25 s window per rung after 10 s warm-up, media requesting **2 fps per camera**,
`yolox-nano` on `CPUExecutionProvider`. Raw samples:
[`docs/review/p8/capacity-samples.json`](../review/p8/capacity-samples.json).

| Cameras | Offered fps | **Analysed fps** | Detections/s | Avg latency | p95 latency | Capture→detection | Dropped |        Drop % | Queue peak (media/runtime) | Runtime CPU / RAM | Media CPU / RAM |
| ------: | ----------: | ---------------: | -----------: | ----------: | ----------: | ----------------: | ------: | ------------: | :------------------------: | ----------------: | --------------: |
|   **1** |         2.3 |          **2.3** |          4.6 |     45.0 ms |     68.2 ms |             80 ms |       0 |     **0.0 %** |           0 / 0            |     114 % / 73 MB |    2 % / 194 MB |
|   **2** |         4.4 |          **4.4** |          8.9 |     47.4 ms |     88.6 ms |             57 ms |       0 |     **0.0 %** |           0 / 0            |    197 % / 100 MB |    4 % / 226 MB |
|   **4** |         9.3 |          **9.2** |         18.4 |     57.2 ms |    122.4 ms |             77 ms |       1 |  **0.4 %** ✅ |           0 / 0            |    298 % / 112 MB |    8 % / 297 MB |
|   **8** |        18.4 |         **16.9** |         33.8 |     70.7 ms |    131.4 ms |            119 ms |      37 |  **8.0 %** ⚠️ |           0 / 0            |    526 % / 113 MB |   13 % / 427 MB |
|  **12** |        28.4 |         **23.8** |         47.7 |     82.3 ms |    181.9 ms |            152 ms |     105 | **14.8 %** ⚠️ |           6 / 0            |    515 % / 114 MB |   15 % / 568 MB |
|  **16** |        38.9 |         **31.6** |         63.3 |     93.6 ms |    188.7 ms |            272 ms |     184 | **18.9 %** ⚠️ |           8 / 0            |    797 % / 122 MB |   36 % / 697 MB |

⚠️ **Detection consistency held at exactly 2.00 per frame at every rung, including saturation.** The
runtime under pressure drops whole frames; it does not quietly return worse answers on the frames it
keeps. That distinction is the difference between a capacity limit and a correctness bug.

### 🔒 FROZEN SIZING POLICY (P-8 Phase 4 freeze, 2026-08-05)

| Status          | Cameras per host | May be quoted to a customer?                   |
| --------------- | ---------------: | ---------------------------------------------- |
| **Supported**   |            **2** | ✅ yes — 0.0 % loss in every run ever measured |
| **Provisional** |            **4** | ❌ no — three runs disagree at this rung       |
| Above 4         |                — | ❌ no — measured, never recommended            |

**The rule: no sizing recommendation is published until three independent benchmark runs agree.**

⚠️ **This policy is enforced by the framework, not by memory.** `scripts/nightly/report.mjs` reads
the persistent ledger (`scripts/reports/history/benchmark.jsonl`), counts the last three recorded
runs, and prints `Sizing: PROVISIONAL` unless all three agree on the same sustainable camera count.
A single good night cannot promote a number, and a night that disagrees demotes it automatically. A
policy nothing checks is a sentence in a document that a confident summary quietly contradicts.

⚠️ **The ledger is deliberately outside the run root.** Run directories are pruned after `KEEP_RUNS`
days, so a trend built by walking them has a one-month memory however long the platform has run.
`scripts/reports/history/` is a sibling of `scripts/reports/nightly/`, which is what puts it beyond
the pruner's reach — see [`scripts/nightly/history.mjs`](../../scripts/nightly/history.mjs).

### 🎯 Recommendation: **2 cameras** per host at 2 fps, CPU-only

**⚠️ This number was lowered from 4 after the fourth rung failed to reproduce.** The ladder above is
a single run. Three runs of the **same commit** on the **same host** disagree at four cameras and
agree everywhere below it:

| Run                            | Host condition    | 1 cam | 2 cams |   **4 cams** | 8 cams | 16 cams |
| ------------------------------ | ----------------- | ----: | -----: | -----------: | -----: | ------: |
| Morning (the table above)      | quiet             | 0.0 % |  0.0 % | **0.4 %** ✅ |  8.0 % |  18.9 % |
| Evening, same day, same commit | quiet             | 0.0 % |  0.0 % | **4.4 %** ❌ |  9.0 % |  20.7 % |
| Nightly framework, 2026-08-05  | quiet, unattended | 0.0 % |  0.0 % | **4.7 %** ❌ | 14.2 % |  24.4 % |

Two independent later measurements agree with each other to within 0.3 points and disagree with the
morning by a **factor of ten**. That makes the morning figure the outlier, not the baseline — and 4
cameras sits directly on the 2 % budget line, where a factor of ten decides the answer. One and two
cameras are 0.0 % in **every** run, so two is the number this page publishes.

⚠️ **The four-camera rung is now `provisional` and must not be quoted to a customer** until three
clean runs agree, per the standing benchmark policy. What differs between morning and evening has not
been isolated; the most likely cause is host thermal state — the evening ladders reached the same
throughput at **lower** CPU with ~20 % higher latency, which is what throttling looks like — but that
is a hypothesis, not a measurement, and it is recorded as one.

- **This is why the number moved, and the mechanism matters more than the number.** Nothing regressed
  and no code changed. A single benchmark run was published as a permanent reference, and repeating
  it is what showed that it could not carry that weight. Every rung on this page is now re-measured on
  every nightly run ([`scripts/nightly.sh`](../../scripts/README.md)), so a sizing claim that stops
  reproducing is caught by the framework rather than by a customer.
- **Frames first exceed the budget at 8 cameras** (8.0 %). Eight to sixteen cameras still _work_ and
  still detect correctly — they analyse a **sample** of the stream rather than all of it. Whether
  that is acceptable is a product decision, not an engineering limit; at 16 cameras the platform
  still sustains 31.6 analysed fps and 63 detections/s.
- **CPU is the binding constraint, and it is not close.** Runtime CPU reached **797 % (~8 of 10
  cores)** at sixteen cameras while media held 36 %. ⚠️ Nothing in the deployment stops inference
  from taking the cores the decode path needs ([TD-63](../../tracking/TECH-DEBT.md)) — and recording
  is the contractual obligation, inference is advisory.
- **Plan RAM around media, not the runtime.** The runtime is nearly flat across the whole ladder
  (**73 → 122 MB**, and only 112 → 122 MB from 4 to 16 cameras). Media grows ~31 MB per camera
  (**194 → 697 MB**) — that is the decode path, and it is what a host runs out of first.
- **Latency degrades gracefully; throughput does not.** p95 moved only 122 → 189 ms between 4 and 16
  cameras. ⚠️ **A reviewer watching latency alone would conclude sixteen cameras were fine.** The
  cost appears almost entirely as dropped frames, which is why the drop rate — not latency — defines
  the sizing recommendation.
- **The runtime's own queue never built** (peak 0 at every rung); back-pressure surfaced as slower
  responses and media discarded frames it could not dispatch. Sizing must therefore be read from
  media's drop counter, and a dashboard showing only the runtime queue would look healthy at 18.9 %
  loss.

⚠️ **Inference is far below the frame path.** Phase 2 measured the transport carrying **16 cameras
with zero loss**. Perception sustains **2** repeatably (4 provisionally). The camera count a
deployment advertises is set by the AI tier, not by the video tier.

---

## 🧭 Object tracking — what identity costs (P-8 Phase 4)

**Clean host.** One walking person per camera, each on its own RTSP path, 20 s window after 8 s
warm-up. Raw samples: [`docs/review/p8/tracking-capacity.json`](../review/p8/tracking-capacity.json).

⚠️ **The source is a motion clip, not the still photograph the ladder above uses.** A stationary
subject produces one track that never has to be re-associated, so identity stability against it is
100 % by construction and measures nothing.

| Cameras | Analysed fps |   Dropped | Identities (truth = cameras) | Extra: run 1 / run 2 | Tracking cost/frame | Runtime CPU / RAM |
| ------: | -----------: | --------: | ---------------------------: | -------------------: | ------------------: | ----------------: |
|   **1** |    2.0 · 2.0 |     0.0 % |                        1 · 1 |            **0 / 0** |    0.118 · 0.144 ms |    109 % / 101 MB |
|   **2** |    4.0 · 3.9 |     0.0 % |                        3 · 2 |            **1 / 0** |    0.106 · 0.128 ms |    197 % / 133 MB |
|   **4** |    8.1 · 8.1 |     0.0 % |                        4 · 4 |            **0 / 0** |    0.133 · 0.123 ms |    397 % / 133 MB |
|   **8** |  16.0 · 15.9 | 0.2–0.3 % |                       11 · 9 |            **3 / 1** |    0.131 · 0.148 ms |    538 % / 113 MB |
|  **16** |  31.9 · 32.0 | 0.8–0.9 % |                      21 · 17 |            **5 / 1** |    0.157 · 0.179 ms |    928 % / 116 MB |

⚠️ **Tracking is a rounding error beside inference.** 0.11–0.18 ms per frame against ~50 ms of
inference — about **0.3 %**, and it grows only slightly with load. Identity is not what limits camera
count. ✅ This is the one figure on the table that reproduces: both runs agree to within 0.03 ms at
every rung.

### ⚠️ Identity fragmentation under load is PROVISIONAL — two runs disagree by a factor of five

One walking person per camera means the right answer is exactly `cameras`, so anything above it is
overhead. Two runs of the same commit on the same host:

| Rung   | Run 1 (2026-08-05) | Run 2 (2026-08-06) | Overhead        |
| ------ | -----------------: | -----------------: | --------------- |
| 8 cam  |           11 for 8 |        **9 for 8** | 38 % → **13 %** |
| 16 cam |          21 for 16 |      **17 for 16** | 31 % → **6 %**  |

**Neither number is published as the answer.** The mechanism is not in doubt — fewer analysed frames
per camera means a bigger gap between observations, and past the engine's tolerance a new identity is
the correct response rather than a wrong one. The _magnitude_ is, and by enough that a customer-facing
statement built on either figure would be wrong.

⚠️ **This is the second time this ladder has produced a number that did not reproduce**, after the
four-camera sizing rung. The pattern is the same and so is the response: state the range, name it
provisional, and let the nightly framework accumulate runs until three agree
([the sizing policy above](#-frozen-sizing-policy-p-8-phase-4-freeze-2026-08-05) enforces exactly this
for the camera count, and `scripts/reports/history/tracking.jsonl` accumulates the same evidence for
this one). What differs between the runs has not been isolated; host thermal state is the same
hypothesis as before and is recorded as a hypothesis.

**It is fragmentation, not swapping** — no scenario in this ladder can distinguish those, which is
why identity _swaps_ are proved separately against authored crossings rather than inferred from this
table. Both runs measured **0 identity switches** against the crossing clip.

⚠️ **Do NOT compare this table's drop rate with the sizing ladder above.** The source differs: this
one plays a synthetic 640×360 clip with a plain background, which is markedly cheaper to encode and
decode than the photograph, so media reaches sixteen cameras at 0.9 % loss where the sizing ladder
measured 18.9–24.4 %. That is a property of the fixture, not a revision of the sizing. **The
published camera count remains 2** ([L-41](KNOWN_LIMITATIONS.md)); this ladder measures what tracking
costs, not how many cameras a host carries.

### Identity behaviour, measured against authored ground truth

Not a benchmark — a set of assertions, each with a written-down right answer. See
[`docs/review/p8/tracking.mjs`](../review/p8/tracking.mjs).

| Property                           | Measured                                                            |
| ---------------------------------- | ------------------------------------------------------------------- |
| Continuously visible → one id      | **1 id**, heading reported as the authored direction                |
| Survives occlusion                 | **1 id** across a **3.0 s** blind window (engine holds 4 s)         |
| Survives a disappearance           | frame genuinely empties; **6.5 s** absence measured                 |
| Terminates, and a return is linked | **new** id, `precededBy` + `identityId` on the old, `recoveries=1`  |
| Two people crossing                | **2 ids**, vertical spread **0.004** and **0.006** — no lane change |

⚠️ **Composited sprites on a plain background, not real CCTV.** No motion blur, no lighting change,
no perspective, no gait. [L-1](KNOWN_LIMITATIONS.md) stands. These prove the tracking logic on known
input; tracker performance on real video is P-9's question.

#### The six accuracy metrics, and why they exist only here

The Phase 4 freeze made these machine-readable. Each run writes
[`docs/review/p8/tracking-truth.json`](../review/p8/tracking-truth.json), the nightly report renders
it in its own section, and `scripts/reports/history/tracking-truth.jsonl` keeps it indefinitely.

| Metric                    | Scenario  | 1.0 means                                              |
| ------------------------- | --------- | ------------------------------------------------------ |
| `identityStability`       | walk      | one authored person produced exactly one identity      |
| `occlusionRecovery`       | occlusion | the identity survived an **observed** gap              |
| `reidentificationSuccess` | reentry   | the return was linked to the correct predecessor       |
| `terminationCorrectness`  | reentry   | the departed identity was retired                      |
| `crossingCorrectness`     | crossing  | both tracked, neither changed lane                     |
| `identitySwitches`        | crossing  | _a count_ — 0 means no identity took the other's place |
| `falseRecoveries`         | crossing  | _a count_ — 0 means no link was invented               |

⚠️ **`identitySwitches` and `falseRecoveries` are the two `/tracking` reports as `null`**, and the
crossing scenario is the only place on this platform they can be counted. It authors two people into
two vertical lanes and states that nobody leaves — so a track that changes lane has taken the other
person's identity, and any re-entry link formed is wrong by construction. On a live camera both
events are invisible. See [ADR-0039](../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md).

⚠️ **A metric whose scenario did not run stays `null`, never 0.** The mutation harness runs subsets,
and a subset scoring 1.0 on something it never exercised would be the exact failure this measures
against.

---

## 📡 Event bridge — what publishing costs (P-8 Phase 5)

**Clean host.** One walking person per camera, each on its own RTSP path, 20 s window after 8 s
warm-up. Raw samples:
[`docs/review/p8/event-bridge-capacity.json`](../review/p8/event-bridge-capacity.json).

⚠️ **Both ends are measured, and they are not the same number.** "Published" is what a broker
accepted. "Persisted" is how many events exist. The events service collapses repeats inside its
dedup window, so the gap below is **normal and large** — not loss.

| Cameras | Offered/s | Published/s | Persisted/s | Deduped/s | Publish time | Queue peak / bound | Dropped | Retries | Failed | media CPU / RAM | events CPU / RAM |
| ------: | --------: | ----------: | ----------: | --------: | -----------: | -----------------: | ------: | ------: | -----: | --------------: | ---------------: |
|   **1** |      1.99 |        1.99 |        0.12 |      1.87 |      0.69 ms |             0 / 16 |       0 |       0 |      0 |  2.7 % / 154 MB |    0.6 % / 90 MB |
|   **2** |      4.01 |        3.08 |        0.19 |      2.89 |      0.73 ms |             0 / 16 |       0 |       0 |      0 |  7.4 % / 189 MB |    0.5 % / 90 MB |
|   **4** |      8.07 |        7.03 |        0.44 |      6.63 |      0.83 ms |             0 / 16 |       0 |       0 |      0 | 10.6 % / 260 MB |    1.4 % / 90 MB |
|   **8** |     16.03 |       13.15 |        0.84 |     11.46 |      0.86 ms |             0 / 16 |       0 |       0 |      0 | 24.3 % / 397 MB |    2.2 % / 93 MB |
|  **16** |     31.09 |       27.55 |        1.59 |     25.81 |      1.78 ms |             0 / 16 |       0 |       0 |      0 | 35.7 % / 667 MB |    3.9 % / 92 MB |

⚠️ **Publishing is not what limits camera count, and it is not close.** 0.69–1.78 ms per publish
against ~50 ms of inference — roughly **2–3 %** at the top rung, and the whole bridge costs the media
service a few percent of a core. The bridge shed **nothing** at any rung, retried nothing, and failed
nothing. Throughput scaled to **87 %** of linear from 1 to 16 cameras, and the shortfall is upstream:
`offered` itself only reaches 31/s against a nominal 32.

⚠️ **The queue peak of 0 is real but weakly measured.** It is sampled every five seconds, so a
transient depth between samples is invisible. What it does establish is that the publisher drains
faster than results arrive at every rung tested — 27.55 publishes/s × 1.78 ms is about 49 ms of work
per second. The bound is exercised properly by the resilience run, where a 20-second broker outage
fills it to exactly 16 and sheds 16 more.

### ⚠️ Published is ~17× persisted, and that is the dedup window working

At 16 cameras: **27.55 published/s → 1.59 persisted/s**, with 25.81/s collapsing as duplicates. One
walking person per camera produces one continuous track, and the events service's dedup key is
`type + camera + zone + track + 10-second bucket` — so one camera's continuous presence is **one
event per bucket**, not one per frame.

That is the intended behaviour and it is the reason a rule fires once for a loitering person rather
than a hundred times. ⚠️ **It also means "events per second" is a meaningless capacity metric for this
platform.** What scales with cameras is publishes; what scales with _distinct situations_ is events.
Quoting the first as the second would describe a firehose that mostly evaporates.

### ⚠️ Sizing is unchanged: 2 supported, 4 provisional

The ladder shows the bridge comfortable at sixteen cameras. **That is not a capacity revision**, for
the same two reasons the tracking ladder is not one: the source is a synthetic clip far cheaper to
decode than a real scene, and the constraint is inference, not publishing. The standing policy holds
— **2 supported, 4 provisional, no recommendation published until three independent runs agree** —
and this is run one.

---

## 🎛 Camera assignment — what orchestration costs (P-8 Phase 6)

Measured 2026-08-06 on the production deployment, `docs/review/p8/assignment-benchmark.mjs`, 20-second
windows, Apple Silicon, CPU-only. ⚠️ **Every rung assigns the cameras it creates** — a ladder that
started cameras without assigning them would measure the _skip_ path (one map lookup per frame) and
report it as the cost of the subsystem.

| cameras | assign latency | runtime probe | fps / camera | queue peak | utilisation | dropped | media CPU | media RSS | control plane CPU |
| ------: | -------------: | ------------: | -----------: | ---------: | ----------: | ------: | --------: | --------: | ----------------: |
|       1 |       3 521 ms |          4 ms |         1.99 |          0 |          4% |       0 |     3.4 % |    189 MB |             7.6 % |
|       2 |       1 882 ms |          2 ms |         1.99 |          0 |          8% |       0 |     5.9 % |    192 MB |             4.2 % |
|       4 |       2 086 ms |          2 ms |         2.01 |          0 |         17% |       0 |    10.4 % |    290 MB |             6.4 % |
|       8 |       2 384 ms |          1 ms |         2.01 |          0 |         33% |       0 |    16.7 % |    440 MB |             4.9 % |
|      16 |       2 700 ms |          4 ms |         1.82 |         28 |         67% |      96 |    35.4 % |    673 MB |             0.7 % |

**Nothing was shed up to 8 cameras. Shedding begins at 16**, where per-camera frame rate falls from
2.01 to 1.82 and 96 frames are dropped — the perception queue doing exactly what it is bounded to do.
No assignment was refused and no assignment failed at any rung.

### ⚠️ Assignment latency rises with load, and two earlier versions of this metric fell

`assignmentLatencyMs` is the **control plane's own** measurement of _accepted change → enforcement
point reports it applied_. At a 5-second poll interval a correct value sits near half that plus a
report cycle, and it should get _worse_ under load. It does: 1.9 s → 2.7 s.

Two wrong versions shipped before this one, and the ladder caught both — each produced a plausible
number that **fell as load rose**, which is the signature of a metric measuring the wrong quantity:

| version                               |     1 camera |   16 cameras | what it actually measured                          |
| ------------------------------------- | -----------: | -----------: | -------------------------------------------------- |
| sampled on every up-to-date report    |   588 859 ms |   196 104 ms | time since the last change, not time to apply one  |
| sampled once per version, from the DB |    89 588 ms |    17 832 ms | after a restart: the age of the last change _ever_ |
| **sampled once per accepted change**  | **3 521 ms** | **2 700 ms** | accepted → confirmed applied                       |

> ⚠️ **A plausible number moving in the wrong direction is more dangerous than an absent one.** Nobody
> questions a latency until it is impossible — 588 seconds was, 89 was not. The second version would
> have shipped. A restarted control plane now reports `null` until it accepts a change, because a
> change made by a previous process is one this process cannot honestly time (ADR-0039).

### The runtime probe is not the frame path

`runtimeLatencyMs` (1–4 ms) is the health probe media sends to the runtime, not the time to analyse a
frame. It stays flat because it is a `/health` round trip on a local network; frame cost is the
tracking ladder above. ⚠️ It is `null`, never a number, when the runtime cannot be reached — a timeout
is not a slow round trip.

### ⚠️ Sizing is unchanged: 2 supported, 4 provisional

This ladder measures the **orchestration** cost, which is small: the control plane stayed under 8 %
CPU at every rung and the enforcement point's poll-and-report cycle runs about five times a minute
regardless of estate size. It does **not** raise the camera ceiling — the 16-camera rung sheds frames
for the same reason the tracking and publisher ladders do, and one run recommends nothing.

The seeded runtime declares **4** cameras, which is the provisional figure. ⚠️ The ladder raises that
declared capacity for the run and restores it afterwards; a ladder that stopped at 4 would have
measured the refusal path instead of the cost of sixteen cameras.

---

## 🕒 Retail loitering — where the time actually goes (P-8 Phase 7)

`docs/review/p8/loitering-benchmark.mjs`, 45 s steady-state window per rung, 20 s dwell threshold,
one rule covering every camera on the rung. Every latency is the **platform's own histogram**,
differenced over that window — never this harness's stopwatch, and `null` rather than `0` when
nothing was observed.

| cameras | event → rule | rule → candidate | end to end | events/s | zone geometry | media CPU | rules CPU / RSS |
| ------: | -----------: | ---------------: | ---------: | -------: | ------------: | --------: | --------------: |
|       1 |      66.0 ms |           4.4 ms |    69.3 ms |     0.03 |       10.6 µs |     3.8 % |  0.8 % / 105 MB |
|       2 |      86.0 ms |           3.3 ms |    89.1 ms |     0.09 |       10.2 µs |     8.0 % |  1.0 % / 105 MB |
|       4 |     124.8 ms |           4.0 ms |   128.0 ms |     0.13 |        4.4 µs |    12.4 % |  0.8 % / 105 MB |
|       8 |     195.9 ms |           4.5 ms |   185.6 ms |     0.31 |        5.5 µs |    27.5 % |  0.9 % / 105 MB |
|      16 |     847.8 ms |           7.6 ms |   865.6 ms |     1.37 |        6.3 µs |    48.3 % |  1.3 % / 114 MB |

### ⚠️ The separation earned its keep on the first run

**Event → rule rises 13× from 1 to 16 cameras. Rule → candidate rises 1.7×.** The rule engine is not
the bottleneck and never comes close: it holds ~1 % CPU and 105 MB across the whole ladder while
media climbs to 48 %. What grows is the **transport half** — media's frame path, the broker, the
events service, and the broker again.

That is the entire point of Architect rec 6. A single end-to-end figure going from 69 ms to 866 ms
says _something got slower_; these three say _the rule set did not, and do not go looking there_.

⚠️ The two halves are internally consistent at every rung — 66.0 + 4.4 ≈ 69.3, 196 + 4.5 ≈ 186 (the
small inversions are two independent histograms sampled over one window, not an error). A
decomposition that did **not** add up would be the first sign one of the three was measuring
something other than what it claims.

### ⚠️ Throughput is small, and the reason is the dedup window rather than the platform

1.37 events/s at 16 cameras looks low against 2 fps × 16 = 32 frames/s. It is not frame loss: the
events service collapses repeated detections of one subject into one event per dedup bucket
(`EVENTS_DEDUP_WINDOW_MS`, 10 s), so a stationary person contributes about one event per bucket
however many frames they appear in. **32 dwell clocks were running at the 16-camera rung**, all of
them accumulating, and **not one evaluation was skipped for want of an identity**.

This is also why a dwell threshold under ~20 s is measuring the platform's sampling as much as the
customer's policy — recorded as [L-57](KNOWN_LIMITATIONS.md).

### Zone geometry is free

10.6 µs per frame at one camera, **falling to 6.3 µs at sixteen** — the per-frame cost does not grow
with the estate because each frame is tested against its own camera's zones only. Point-in-polygon on
the recording path is not a cost worth optimising, and this is the measurement that says so rather
than the assumption.

### ⚠️ Sizing is unchanged: 2 supported, 4 provisional

This ladder measures what **rule evaluation** costs, which is almost nothing. It does **not** raise
the camera ceiling: the 16-camera rung is media-bound exactly as the tracking, publisher and
assignment ladders are, and one run recommends nothing.

⚠️ The ladder raises the seeded runtime's declared capacity for the run and restores it afterwards. A
ladder that stopped at 4 would have measured the control plane's refusal path and reported it as the
cost of eight cameras.

### ⚠️ This ladder runs nightly, not in the working day

Registered as `loitering/rule-benchmark.sh` in the nightly, weekly, benchmark and hardware profiles.
Per the execution policy of 2026-08-06, a verification expected to exceed ~10–15 minutes belongs to
the Nightly Framework; daytime work runs one or two rungs to prove correctness. The table above is a
full local run, kept because it is the first one and establishes the shape.

---

## Model warm-up — measured, and it earns less than expected

|                          | Unwarmed (`INFERENCE_ONNX_WARMUP=0`) | Warmed (committed default) |
| ------------------------ | ------------------------------------ | -------------------------- |
| Container start → READY  | 1.5 s                                | 1.5 s                      |
| Warm-up inference itself | —                                    | **29 ms**                  |
| **First real frame**     | **40.9 ms**                          | **37.0 ms**                |
| Steady-state frame       | 35.3 ms                              | 35.3 ms                    |

⚠️ **Finding: warm-up buys ~9.5 %, not the order of magnitude the practice implies.** It moves cost
from the first frame to load rather than removing it, and on this runtime the first unwarmed frame
was never an outlier worth engineering around — 40.9 ms against a 35.3 ms steady state. It is kept
on because 29 ms at load is free and it makes the first frame's latency honest, but it is **not** a
load-bearing optimisation and should not be cited as one. Recorded because measuring it was the only
way to find out.

---

## Reproducibility — the same frame, twenty times

| Field on every `DetectionResult` | Value                                           |
| -------------------------------- | ----------------------------------------------- |
| `schemaVersion`                  | `1.1`                                           |
| `model.id` · `model.version`     | `yolox-nano` · `1.0.0`                          |
| `executionProvider`              | `CPUExecutionProvider`                          |
| `preprocessingVersion`           | `1.0/letterbox-416x416-NCHW-float32-BGR-pad114` |
| `confidenceThreshold`            | `0.5`                                           |
| `inferenceMs` · `frameLatencyMs` | measured per frame, never fabricated            |

**Twenty runs of one frame produced one distinct result.** Detection count, labels, confidences,
bounding boxes, detection ids and all metadata were byte-identical; the only field that moved was
the clock (30.1–46.7 ms, mean 37.4 ms). Confidences were the identical double every time —
`0.924996` and `0.872955`, one distinct value each across twenty runs.

⚠️ **A note on "zero variance", because the first version of this check was wrong.** It asserted a
computed variance of exactly `0` and went red at `1.2e-32`. That is not runtime wobble: √1.2e-32 ≈
1.1e-16, one ULP of a double near 0.92. Summing twenty copies of the same number and dividing lands
the mean a rounding step away from the value they all equal, and squaring that gap produces the
1e-32. The check now counts **distinct values**, which has no such artefact. The product was
reproducible throughout; the arithmetic in the verification was not.

⚠️ The `preprocessingVersion` is the full resolved input spec, not a bare `1.0`. A version number
alone cannot reproduce an inference — the size, layout, dtype, colour order and pad value have to
travel with the result, or identical weights on an identical frame can disagree and nothing on the
document would show why.

---

## Reproducing this page

```sh
node docs/review/p8/hardening.mjs        # warm-up · reproducibility · capacity ladder · truthfulness
node docs/review/p8/inference-soak.mjs   # 15 min, 4 cameras (MINUTES= to extend — see its header)
node docs/review/p8/mutations.mjs        # breaks the platform 7 ways, asserts each verification
```

They write their raw samples beside this document so a future run can be diffed against this one
rather than argued about: [`capacity-samples.json`](../review/p8/capacity-samples.json) holds every
ladder rung plus the warm-up and reproducibility measurements.

⚠️ The stability run's `soak-samples.json` is **absent by design, not by oversight** — the script
writes it only on completion, and this run was stopped at 53 minutes under the policy change. Its
per-sample evidence is the console log, [`soak-53min.txt`](../review/p8/soak-53min.txt), which is why
that file is committed rather than left in a temp directory.

---

## P-8 Phase 7 freeze — the ladder as it stands at the freeze commit (2026-08-07)

Re-run on the freeze candidate after the verification repairs of 2026-08-06/07, not carried over from
development. `LADDER=1,2,4`, 45-second steady-state window per rung, 20-second dwell threshold. Every
latency is the **platform's own** measurement read from `/metrics`, never timed by the harness.

| cameras | event → rule | rule → candidate | end to end | zones | dwell timers | rules CPU / RSS | zone geometry |
| ------: | -----------: | ---------------: | ---------: | ----: | -----------: | --------------- | ------------: |
|       1 |       111 ms |           9.0 ms |     117 ms |     1 |            1 | 0.5 % / 113 MB  |       12.9 µs |
|       2 |        85 ms |           3.0 ms |      88 ms |     2 |            4 | 0.5 % / 111 MB  |       13.0 µs |
|       4 |       147 ms |           3.4 ms |     150 ms |     4 |            4 | 0.5 % / 113 MB  |        9.7 µs |

**`refusedAt: null`** — the ladder ran to its configured top and was not truncated by the control
plane. (A truncated ladder now records the rung it was refused at and why; see below.)

### What this says, and what it does not

- **The rule engine is not the bottleneck and is not close to being one.** Rule → candidate is 3–9 ms
  against an end-to-end of 88–150 ms, and rules CPU sits at **0.5 %** across every rung. Nearly all of
  the end-to-end figure is transport: media, the broker and the events service.
- **Zone geometry is free** — ~10–13 µs per frame, and it does not grow with camera count.
- ⚠️ **Rung 2 is faster than rung 1.** 88 ms against 117 ms is host noise, not a scaling result. It is
  printed rather than smoothed because a ladder that hides its own variance invites a reader to
  believe a 30 ms difference at the bottom of the range.
- ⚠️ **Three rungs is not a scaling curve.** An earlier development run climbed to 16 cameras and
  showed end-to-end rising to ~866 ms; that number is **not** republished here, because it was
  measured on a different day under a different load and the two cannot be put in one table.

### Assumptions, stated because a capacity table is unreadable without them

|                          |                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Hardware**             | the reference development host — Apple Silicon, CPU inference (`CPUExecutionProvider`), no GPU                |
| **Runtime limits**       | one registered runtime, `ASSIGNMENT_RUNTIME_MAX_CAMERAS=4`, **raised for the ladder and restored afterwards** |
| **Camera assignment**    | every camera in every rung is explicitly assigned; from P-8 Phase 6 an unassigned camera is never analysed    |
| **Fixture**              | synthetic RTSP walkers, one per camera. **Not real CCTV** — L-1 and L-58 stand                                |
| **Observation interval** | ~10 s, set by the event dedup window, not by the frame rate (L-57)                                            |
| **Confidence**           | ⚠️ **one run.** Nothing here is a sizing recommendation                                                       |
| **Sizing**               | **unchanged: 2 supported, 4 provisional.** No figure is published until three independent runs agree          |

### ⚠️ What the freeze night changed about how every ladder reports

Two repairs, both from defects found by the nightly rather than by review:

1. **A ladder no longer throws when the control plane refuses a camera.** It stops, publishes the
   rungs it measured, and records `refusedAt` beside the table. On 2026-08-06 a throw here discarded
   five measured rungs _and_, in a script with no top-level `finally`, leaked a raised capacity
   declaration and a dozen assigned cameras into the next three ladders — which then failed at their
   first rung. One unhandled throw cost four stages.
2. **The runtime ladder was measuring one camera and labelling it sixteen.** `inference.mjs` started
   sixteen streams and assigned none of them, so every rung above the first reported a single stream's
   throughput. ⚠️ It was caught by the **frame-accounting invariant** (`offered == delivered + dropped
   - failed`), not by anyone reading the numbers — they looked entirely reasonable. That invariant is
     currently asserted by one ladder out of six; see [VERIFICATION_AUDIT](VERIFICATION_AUDIT.md) F-1.

### The other ladders on the same night, for context

| Ladder                | Result                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `benchmark` (runtime) | 16 cameras, 27.3 % dropped at the top rung; computed sizing **4 cameras** at p95 126 ms / 192 % CPU |
| `tracking-benchmark`  | 16 cameras, 25.8 % dropped, 6 extra identities, tracking 0.51 ms/frame                              |
| `publisher-benchmark` | 16 cameras, 19.93 published/s, 1.65 persisted/s, publish ≤1.67 ms, no shedding                      |

⚠️ **The runtime ladder's computed "4 cameras" does not change the sizing policy.** It is one run, and
the standing rule is three agreeing runs before a recommendation moves. **2 supported, 4 provisional.**
