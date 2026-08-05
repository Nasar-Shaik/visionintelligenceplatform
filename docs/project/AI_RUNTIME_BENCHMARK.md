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

| Cameras | Analysed fps | Dropped | Identities (truth = cameras) | Extra | Tracking cost/frame | Runtime CPU / RAM |
| ------: | -----------: | ------: | ---------------------------: | ----: | ------------------: | ----------------: |
|   **1** |          2.0 |   0.0 % |                        **1** | **0** |            0.118 ms |    109 % / 101 MB |
|   **2** |          4.0 |   0.0 % |                        **3** | **1** |            0.106 ms |    197 % / 133 MB |
|   **4** |          8.1 |   0.0 % |                        **4** | **0** |            0.133 ms |    397 % / 133 MB |
|   **8** |         16.0 |   0.2 % |                       **11** | **3** |            0.131 ms |    538 % / 139 MB |
|  **16** |         31.9 |   0.9 % |                       **21** | **5** |            0.157 ms |    928 % / 120 MB |

⚠️ **Tracking is a rounding error beside inference.** 0.11–0.16 ms per frame against ~50 ms of
inference — about **0.3 %**, and it grows only slightly with load. Identity is not what limits camera
count.

⚠️ **Identity fragments under load, and the number is the honest one.** One walking person per camera
means the right answer is exactly `cameras`. Up to four cameras the engine returns it (one rung
produced one extra). At eight it produced 11 for 8, and at sixteen **21 for 16** — a ~31 % overhead.
This is the expected consequence of frames being analysed less often per camera as the host
saturates: a bigger gap between observations is a harder association, and past the engine's tolerance
it is correctly a new identity rather than a wrong one. **It is fragmentation, not swapping** — no
scenario in this ladder can distinguish those, which is why identity _swaps_ are proved separately
against authored crossings rather than inferred from this table.

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
