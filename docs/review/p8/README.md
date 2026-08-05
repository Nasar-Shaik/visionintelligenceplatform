# P-8 review package · Live Video & Real Perception

Architecture: 🔒 [SELECTIVE_AI_PROCESSING](../../architecture/future/SELECTIVE_AI_PROCESSING.md)
(frozen 2026-08-05) — §14 is the ratified phase order and this package follows it.

---

## Phase 1 · Deploy the AI Runtime — ✅ complete, ⏳ awaiting review

**The claim, and it was false until today:** a runtime with 121 Python modules and a green unit-test
suite had **never run in production**. It has no customer-facing effect and it is the milestone's
critical path: every later phase connects to something that is now known to start.

**Deliberately connected to nothing.** No camera, no frame, no gateway route, no published port. Half
the verification therefore asserts an _absence_ — each paired with a positive reading from the same
source, because an absence is the easiest thing in the world to assert accidentally-truthfully.

### What was built

| Artefact                                                                          | Note                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`infra/docker/Dockerfile.inference`](../../../infra/docker/Dockerfile.inference) | ⚠️ **No `apt` layer and no `pip` layer.** The `stub` backend is stdlib-only, so the default image installs nothing at all: `tini` → compose `init: true`, `curl` → the interpreter that is already there. `onnx` is a build arg, and it is Phase 5's to turn on |
| `inference` service in the production compose                                     | Port 8085, unpublished. ⚠️ **Declares no infrastructure dependency** — it comes up when Mongo is down, which is what a perception tier should do                                                                                                                |
| [`runtime-deploy.mjs`](runtime-deploy.mjs)                                        | **30 checks** against the deployment, four mutations                                                                                                                                                                                                            |
| `deployment-integrity.mjs` §6                                                     | Gate 0 now covers the runtime. Python has no build step, so image bytes = tree bytes, compared exactly                                                                                                                                                          |

### Measured, not asserted

| Reading                  | Value                                                                        |
| ------------------------ | ---------------------------------------------------------------------------- |
| Resident memory          | **27.9 MB**                                                                  |
| CPU at rest              | **0.003 %**                                                                  |
| Metrics exposed          | **15 Prometheus series** (frames, latency p50/p95, queue depth, uptime, RSS) |
| Capabilities loaded      | 1 — `perception.person-detection`, exactly the manifest set on disk          |
| Sessions · frames        | **0 · 0** — Phase 1's boundary, asserted rather than assumed                 |
| Survives a MongoDB pause | **yes** — proven by pausing it                                               |
| Restart → healthy        | **26 s**, exit code 0                                                        |
| Runtime bytes vs commit  | **149 files identical**                                                      |

### Three findings

1. ⚠️ **The runtime logs nothing after startup** (TD-60). One line at boot, then silence — five
   requests produced zero log lines, because `log_message` is overridden to return `None`. An
   operator cannot tell a serving runtime from a wedged one without polling it. **Recommended, not
   taken:** the fix touches the frozen AI Runtime, and a deployment phase is the wrong place to
   change a foundation's source.
2. ⚠️ **Admission control believes it has the host's cores** (TD-61). Capacity comes from
   `os.cpu_count()`, which ignores the cgroup quota — correct today only because no CPU limit is set.
   Under `cpus: 2` the scheduler would admit sessions for capacity it may not use. **Must be fixed
   before Phase 4**, harmless until then because nothing is admitted. Found by deploying; invisible
   to every unit test.
3. ⚠️ **The stub backend reports a model identity it invented** — `person-detection v1, family yolo`,
   produced by `FakeModelResolver` with nothing registered. It is why no console surface may exist
   before Phase 5, and the verification pins `executionProvider === 'stub'` so the fabrication can
   never be mistaken for a registered model.

Also recorded: `/ready` is not in the `{success,data}` envelope the ten TypeScript services use, and
the runtime is absent from the System Health page — both correct for a phase that connects nothing,
both due in the phase that makes it load-bearing (TD-62).

### Running it

```sh
node docs/review/p6/deployment-integrity.mjs   # gate 0 — is the deployment the commit?
node docs/review/p8/runtime-deploy.mjs         # ⚠️ pauses MongoDB and restarts the runtime, briefly
```

⚠️ `runtime-deploy.mjs` **breaks the deployment on purpose** — it pauses MongoDB to prove independence
and restarts the container to prove recovery. Both are restored before it exits; neither is safe to
run against a stack somebody is demonstrating on.

---

## Phase 2 · Frames reach the runtime — ✅ complete, ⏳ awaiting review

**Customer question answered: "is the camera being watched?" — the frames now get there.** Media
delivers every decoded frame to the AI runtime over HTTP; the runtime counts them. ⚠️ Nothing is
_analysed_ yet: the backend is `stub`. Transport is the objective; detection is Phase 3.

### ⛔ The defect this phase found first

**The media image contained no `ffmpeg`.** Every stream start in a deployment failed with
`spawn ffmpeg ENOENT` and reconnected forever — **recording had never once run in production**, while
the media catalogue behind it was marked production-verified (now corrected as **C-14a**). Fixed with
one conditional line in `Dockerfile.service`; ffmpeg lands only in the image that needs it.

### Measured — 20 s window per rung, synthetic RTSP source

| cams | offered | delivered | dropped | failed |  fps | deliver | frame age | media cpu/mem | runtime cpu/mem |
| ---: | ------: | --------: | ------: | -----: | ---: | ------: | --------: | ------------: | --------------: |
|    1 |      41 |        41 |       0 |      0 |  2.0 |  3.1 ms |      3 ms |  3 % / 142 MB |     0 % / 18 MB |
|    2 |      81 |        81 |       0 |      0 |  4.0 |  3.1 ms |      3 ms |  5 % / 163 MB |     0 % / 18 MB |
|    4 |     164 |       164 |       0 |      0 |  8.1 |  2.7 ms |      3 ms | 11 % / 243 MB |     1 % / 20 MB |
|    8 |     325 |       325 |       0 |      0 | 16.0 |  2.5 ms |      3 ms | 17 % / 389 MB |    20 % / 20 MB |
|   16 |     649 |       649 |       0 |      0 | 31.9 |  2.4 ms |      2 ms | 28 % / 646 MB |     3 % / 21 MB |

**Zero loss to 16 cameras**, and transport time _falls_ as load rises (connection reuse). ⚠️ The
source is synthetic — mediamtx + `ffmpeg testsrc`. Every number measures the platform's frame path;
none is a claim about vendor compatibility. **L-1 stands until P-9.**

Idle baseline: runtime **18 MB / 0 % CPU**, restart-to-healthy **~10 s**, image **~150 MB**;
media idle ~140 MB. Per-camera cost at 16 cameras: **1.9 % CPU** (media 28 % + runtime 3 %).

### The hard requirement — proven by breaking it

Runtime **paused for 25 s** with 16 cameras streaming:

- **8/8 sampled cameras wrote a new segment during the outage** — evidence outlives perception
- **8/8 streams stayed `connected`** — the decode path never learned the runtime was gone
- **769 frames lost, every one attributed**: 48 failed, 721 dropped
- Delivery **resumed by itself** — no restart, no operator

⚠️ **Frame accounting closes exactly**: `809 offered = 809 accounted`, where a frame is _delivered,
dropped, failed, imageless, waiting or in flight_. The first version of that check knew only four of
those six states and went red at `806 vs 770` — the missing 36 were 32 queued plus 4 in flight. **The
check was short, not the product.**

### Debt paid

- **TD-60** — the runtime now emits structured JSON (pino field names) plus a **30 s heartbeat**
  whose _absence_ is the signal. Frames are deliberately not logged per request.
- **TD-61** — capacity reads the cgroup quota. Proven under `cpus: 2`: `CPU (2 cores, cgroup-limited
from 10)` where `os.cpu_count()` in the same container still says 10.
- **TD-4** (half) — the null perception sink is gone.
- Also fixed: a client disconnect printed a **Python traceback per abandoned frame**; it is now one
  warning line.

### Mutation-tested

| Mutation                                     | Result                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| media pointed at a runtime that is not there | **7 red** — every "frames reached the runtime" check, and the runtime saw 0 cameras |
| `cpus: 2` on the runtime                     | label changed to cgroup-limited — the only way to prove TD-61                       |
| RTSP source starved mid-run                  | segment-progress check goes red (1/4 advanced, needs 4)                             |
| accounting invariant                         | went red at `806 vs 770` before the six-state fix                                   |

### Recommendation raised, not taken

**TD-63** — the perception tier has no CPU limit and shares a host with recording. Under a real ONNX
backend, inference could starve the decode path that writes evidence. Setting `cpus:` is a deployment
policy and the number should come from Phase 6 benchmarks, not a guess.

### Running it

```sh
node docs/review/p8/frame-path.mjs         # ⚠️ pauses the runtime and creates disposable cameras
node docs/review/p8/frame-path.mjs clean   # if a run was interrupted
```

---

## Phase 3 · real inference

**The objective:** frame → model → real inference → detection → detection metadata. Nothing more —
no tracking, no rules, no incidents, no alerts.

### The one check that makes the others mean anything

A **colour-bar test pattern produces zero detections.** The `stub` backend returned a detection for
any bytes at all: it would satisfy "frames arrive", "detections are produced", "latency is measured"
and "the dashboard is populated" while seeing precisely nothing. Every other assertion below is
evidence only because that one holds — and mutation 2 proves it does, by putting the stub back and
watching the check go red with `person 0.660` on a test pattern.

And the count must be _right_, not merely non-zero. The fixture photograph contains **two** people;
the assertion is `=== 2`. Mutation 3 disabled suppression and the runtime returned **17** boxes of
the same two people — a failure `> 0` would have passed.

### Measured against the deployment

Twenty-second windows, a CC0 photograph looped over RTSP, `yolox-nano` on `CPUExecutionProvider`:

| cams | analysed | detections | dropped |  fps | inference | capture→detection | media cpu/mem | runtime cpu/mem |
| ---: | -------: | ---------: | ------: | ---: | --------: | ----------------: | ------------- | --------------- |
|    1 |       42 |         84 |       0 |  2.1 |   86.3 ms |            153 ms | 3 % / 181 MB  | 96 % / 106 MB   |
|    2 |       82 |        164 |       0 |  4.1 |   61.6 ms |             70 ms | 6 % / 214 MB  | 175 % / 106 MB  |
|    4 |      162 |        324 |       0 |  8.1 |   63.2 ms |             76 ms | 10 % / 278 MB | 358 % / 106 MB  |
|    8 |      282 |        564 |      47 | 14.1 |   97.0 ms |            126 ms | 16 % / 415 MB | 630 % / 112 MB  |
|   16 |      477 |        954 |     177 | 23.9 |  124.0 ms |            323 ms | 39 % / 689 MB | 520 % / 117 MB  |

Two detections per analysed frame at every rung — both people, every frame. **Frame accounting closes
at every rung.** Zero failures. Runtime memory flat at ~110 MB from 1 camera to 16.

⚠️ **CPU inference saturates between 4 and 8 cameras** on this host. Beyond that the queue drops
frames by policy and counts every one — 177 of 654 at 16 cameras. That is the design working, and it
is the number that sizes a deployment: **~8 cameras per host at 2 fps on CPU**, not 16.

⚠️ The source is a looped photograph, not a camera. Every number measures the platform; none is a
claim about vendor compatibility (L-1) or about model accuracy (TD-64).

### Mutation-tested

| Mutation                             | Result                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------- |
| a byte flipped in the model artifact | the runtime **refuses to start**, naming both digests; 20 checks red      |
| the `stub` backend restored          | **11 red** — including a test pattern reporting `person 0.660` in 0.05 ms |
| suppression disabled in the decoder  | **17 detections instead of 2**; the in-image decoder tests fail too       |

The artifact mutation found a defect **in the verification**: six checks passed vacuously against a
dead runtime, because `[].every(...)` is `true`. A check that cannot fail when the product is dead is
decoration; all six now require a non-empty result first.

### Discovered defects

- **The RTSP fixture's loop flag was wrong.** `-stream_loop -1` restarts the demuxer, so timestamps
  restart with it and the stream ends in under a second — media reported `ffmpeg exited (code 0)` and
  every camera reconnected forever. `-loop 1` is the image demuxer's own loop.
- **The ONNX adapter hard-coded a 640×640 stretch, `/255` normalisation and one assumed row layout** —
  wrong for the model this platform actually registers. It is now driven entirely by the catalogue.
- **`scrape()` in this suite rejected labelled metrics**, so a working pipeline printed five rungs of
  zeros. Mine, not the product's.
- **The detection id ignored which model produced it** — the same frame under two models gave the
  same ids for entirely different detections. Found by running two models over one probe frame.

### Debt

- **TD-5 resolved** — the deployed runtime runs the real backend with a registered, checksum-verified
  model, resolved from the image rather than from MLflow.
- **TD-63 escalated to high** — the speculative case is now measured: the runtime takes **6–8 cores**
  at 16 cameras where the stub took 3 %. Nothing in the deployment stops it starving recording.
- **TD-64 opened** — no accuracy gates. The platform can say inference _runs_ and must not say how
  well it works.

### Running it

```sh
node docs/review/p8/inference.mjs          # integrity → real inference → end-to-end → ladder
node docs/review/p8/inference.mjs clean    # if a run was interrupted

cp docs/review/p8/runtime-ui.mjs /private/tmp/pwrun/ && cd /private/tmp/pwrun \
  && OUT=<repo>/docs/review/p8/screens node runtime-ui.mjs
```

---

## Phase 3H · production hardening — ✅ complete, ⏳ awaiting review

Phase 3 proved inference is **real**. This phase asks whether it is **sellable**: does it stay
correct under load, does it give the same answer twice, how many cameras does one host actually
analyse, and is every number on the operator's page a measurement rather than a guess.

**No new capability was built.** No tracking, no zones, no rules, no customer configuration.

### Measured — sizing, on a quiet host

| Cameras | Analysed fps | Detections/s |   Avg / p95 latency |       Dropped |  Runtime CPU / RAM |
| ------: | -----------: | -----------: | ------------------: | ------------: | -----------------: |
|       1 |          2.3 |          4.6 |      45.0 / 68.2 ms |     **0.0 %** |      114 % / 73 MB |
|       2 |          4.4 |          8.9 |      47.4 / 88.6 ms |     **0.0 %** |     197 % / 100 MB |
|   **4** |      **9.2** |     **18.4** | **57.2 / 122.4 ms** |  **0.4 %** ✅ | **298 % / 112 MB** |
|       8 |         16.9 |         33.8 |     70.7 / 131.4 ms |  **8.0 %** ⚠️ |     526 % / 113 MB |
|      12 |         23.8 |         47.7 |     82.3 / 181.9 ms | **14.8 %** ⚠️ |     515 % / 114 MB |
|      16 |         31.6 |         63.3 |     93.6 / 188.7 ms | **18.9 %** ⚠️ |     797 % / 122 MB |

🎯 **4 cameras per host at 2 fps, CPU-only** — computed as the largest rung inside a 2 % loss budget,
not chosen. Full table and deployment guidance: [AI_RUNTIME_BENCHMARK](../../project/AI_RUNTIME_BENCHMARK.md).

⚠️ **p95 moved only 122 → 189 ms between 4 and 16 cameras.** A reviewer watching latency would
conclude sixteen cameras were fine; the cost appears almost entirely as dropped frames. Sizing is
read from the drop counter, and **the runtime's own queue peaked at 0 at every rung** — back-pressure
surfaces as slower responses, and media discards what it cannot dispatch. A dashboard showing only
the runtime queue would look healthy at 18.9 % loss. The page shows media's "Dropped (queue full)"
counter, which does move.

### The three questions, answered

- **Does it stay correct under load?** Detection consistency held at **exactly 2.00 per frame at
  every rung including saturation**. Under pressure the runtime drops whole frames rather than
  returning worse answers on the ones it keeps — a capacity limit, not a correctness bug.
- **Does it give the same answer twice?** Twenty runs of one frame → **one distinct result**.
  Detections, ids, boxes, confidences and all metadata byte-identical; only the clock varied
  (30.1–46.7 ms). The same two confidences reappeared after a container recreation.
- **Is the dashboard honest?** Every rendered number traced to the producer that measured it,
  **exactly** — `framesProcessed` 3319 = 3319, `detectionsTotal` 6631 = 6631, p95 188.702 = 188.702.
  GPU renders "none in this deployment" rather than 0 %.

### Stability run — 53 minutes, 4 cameras

Memory **111 → 118 MB** in a band with no trend, queue 0 throughout, zero runtime-side failures,
2.00 detections/frame in every sample, 25 868 frames → 51 739 detections.

⚠️ **Stopped at 53 minutes rather than the planned 120**, under the Architect's execution policy of
2026-08-05 replacing routine multi-hour soaks with short stability runs. It was already four times
the new standard. **A 53-minute run cannot rule out a slow arena leak** — that question is deferred
to P-9, not answered here. Raw log: [`soak-53min.txt`](soak-53min.txt).

### Findings

1. ⚠️ **Warm-up earns ~9.5 %, not an order of magnitude.** Unwarmed first frame 40.9 ms, warmed
   37.0 ms, steady 35.3 ms. It moves cost to load rather than removing it. Kept on — 29 ms at load is
   free — but it is not a load-bearing optimisation and must not be cited as one.
2. ⚠️ **Inference capacity is a quarter of the frame path.** Phase 2 carried 16 cameras with zero
   loss; perception sustains 4. The camera count a deployment advertises is set by the AI tier.
3. ⚠️ **Three different faults produce a near-identical red signature.** A corrupt artifact, an
   unknown model id and an unregistered decoder each fail capability load and turn 33 checks red;
   only artifact corruption additionally names the sha256 check. The suite **detects** all three and
   does not fully **discriminate** between them — an engineer still needs the runtime log.

### Mutation-tested — seven ways, each red at the check that names it

| Mutation      | What it breaks                                                 | Checks red | Named the fault                                            |
| ------------- | -------------------------------------------------------------- | ---------: | ---------------------------------------------------------- |
| **model**     | a byte flipped inside the registered ONNX artifact             |         33 | `every registered artifact matches its recorded sha256`    |
| **registry**  | the catalogue asked for a model that is not registered         |         33 | `the model bound is the catalogue default`                 |
| **decoder**   | an `outputFormat` no decoder is registered for                 |         33 | `health is derived from the capabilities`                  |
| **runtime**   | the container is stopped                                       |         33 | `the running container is configured for the real backend` |
| **metrics**   | a Prometheus series renamed out from under the page            |      **2** | `detectionsTotal is the runtime's own number`              |
| **gateway**   | `MEDIA_URL` pointed at a host that does not exist              |          3 | `an administrator can read the runtime view`               |
| **dashboard** | the page renders a fabricated `0 %` where nothing was measured |          4 | `⚠️ GPU says "none in this deployment", not "0%"`          |

Every one restored to green afterwards.

⚠️ **The `metrics` row is the one to read.** Two checks red, not thirty-three — because that mutation
is verified by running the **shipped** truthfulness check (`hardening.mjs §5`) rather than a copy of
it inside the harness. A narrow, diagnostic failure is worth more than a blanket one.

⚠️ **And the honest limit: three faults share a signature.** A corrupt artifact, an unknown model id
and an unregistered decoder each prevent capability load and turn the same 33 checks red; only
artifact corruption additionally names the sha256 check. The suite **detects** all three and does not
fully **discriminate** between them — an engineer still needs the runtime log to tell them apart.

### ⚠️ Five defects found **in the verification**, not in the product

Mutation-testing a verification suite is only worth doing if you are willing to publish what it finds
about the suite. Every one of these was green-looking beforehand.

1. **The mutation harness destroyed uncommitted work.** Restore was `git checkout -- <path>`, which
   reverts to HEAD — so an uncommitted fix to `AiRuntimePage.tsx` was silently deleted while the
   harness reported success. It surfaced only because the _post-restore_ verification went red for a
   reason the mutation could not explain. Restore is now a **byte snapshot** taken before the edit,
   and the interrupted-run path reverses the exact substitution instead of touching git.
2. **A mutation that mutated nothing looked like a verification gap.** `String.replace` with a string
   argument replaces the **first** match, and the first `none in this deployment` in the page is
   inside the comment explaining why the phrase is there. The shipped page was identical; the harness
   reported "red, but not at the named check". It now targets the JSX text node `>…<`.
3. **The gateway mutation was broken twice over, and each fault alone produced the same silence.**
   It turned the verification red at **zero** checks. First cause: `FAST=1` stopped after section 4,
   while the route check lives in section 6 — and a comment in that file asserted the opposite, that
   "a broken route is already decided by sections 0–4". Second cause, only visible once the first was
   fixed: the mutation exported `MEDIA_URL` into the environment, but `docker-compose.prod.yml` sets
   it as a **literal** under `environment:`, which beats the process environment. The gateway came up
   healthy pointing at the right service. It now rewrites the compose value itself.
   ⚠️ Two independent bugs with an identical symptom is the case that defeats a single fix — the
   harness only kept reporting failure because it demands red _at the named check_, not merely red.
4. **The dashboard's number-tracing check had never passed.** Written during this phase, first run
   inside a mutation. It regex-matched every digit in the page text and called the version string
   `0.1.0` and the pieces of a rendered date (`2026`, `54`, `11`) fabrications. It now reads
   `<dt>`/`<dd>` cells and explains each against payload numbers, payload strings or a parsed
   timestamp — **28 cells, all traced**. Its companion check banned any `0 %` on a page mentioning
   GPU, which would fire on a truthful 0 % drop rate; it is now scoped to the GPU row.
   ⚠️ It also compared the DOM against a **separately fetched** payload — a race against the page's
   own 5-second poll. It now captures the response the page actually received.
5. **"Confidence variance is exactly zero" failed at `1.2e-32`.** Not runtime wobble: √1.2e-32 ≈ one
   ULP of a double near 0.92, produced by summing twenty identical values and dividing. The
   assertion now counts **distinct values**, which has no such artefact.

Findings 1–3 were found _by_ the mutation suite. That is the argument for running one.

### Governance

- **[L-41](../../project/KNOWN_LIMITATIONS.md) opened** — one host analyses ~4 cameras, not 16.
- **[TD-63](../../../tracking/TECH-DEBT.md) sharpened** — the re-measurement it asked for is done;
  797 % CPU at 16 cameras, budget first exceeded at 8. Remaining work is the `cpus:` limit itself.
- **[ADR-0037](../../adr/ADR-0037-model-agnostic-runtime-and-registry-driven-loading.md)** records the
  model-agnostic runtime and registry-driven loading.

### Running it

```sh
node docs/review/p8/hardening.mjs          # warm-up · reproducibility · capacity ladder · truthfulness
SECTIONS=5 node docs/review/p8/hardening.mjs   # one section — what the mutation harness runs
node docs/review/p8/hardening.mjs clean    # if a run was interrupted

node docs/review/p8/inference-soak.mjs     # 15 min, 4 cameras (MINUTES= to extend — see its header)
node docs/review/p8/mutations.mjs          # all seven; `<name>` for one; `restore` after an interrupt

pnpm verify:contracts                      # includes tools/contracts/perception-boundary.mjs
```

⚠️ **`mutations.mjs` edits real source files and rebuilds real images.** It restores from a byte
snapshot in a `finally`, and `restore` reverses the exact substitutions if a run is killed — but it
is the one script here that writes to the working tree, and it should not be run with unrelated
work in flight.

## P-8 Phase 4 — object tracking

Detections became **identities**. The scripts below are the evidence.

| Script                   | Asks                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `tracking-fixtures.mjs`  | can the deployed model see the clips at all, and is the background empty?    |
| `tracking.mjs`           | do the five identity properties hold, against **authored** ground truth?     |
| `tracking-deploy.mjs`    | is the engine in the running image, reachable, and still off the gateway?    |
| `tracking-ui.mjs`        | does every number on the four pages trace to a payload the browser received? |
| `tracking-benchmark.mjs` | what does tracking cost, and does identity survive load?                     |
| `tracking-mutations.mjs` | does each verification fail at the check that **names** the fault?           |

### Phase 4 freeze — where each metric is allowed to come from

The freeze added eleven permanent tracking metrics and, with them, a rule about their provenance
([ADR-0039](../../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md)). Three sources, and
mixing them is the failure the rule prevents:

| Source                                     | Produces                                         | Can it answer "was it right?" |
| ------------------------------------------ | ------------------------------------------------ | ----------------------------- |
| **Live runtime** — `/tracking`, `/metrics` | counts, timings, gauges, per-camera rows         | ❌ never                      |
| **Capacity ladder** — `tracking-benchmark` | the same counts under load, at 1→16 cameras      | ❌ as blind as production     |
| **Authored scenarios** — `tracking.mjs`    | the six accuracy metrics → `tracking-truth.json` | ✅ the only place             |

⚠️ **The ladder is the tempting one.** It runs one walking person per camera, so "identities minus
cameras" looks like a switch count. It is not — it is fragmentation, and at sixteen cameras it is
driven almost entirely by frame loss. The ladder therefore emits `identitySwitches: null` on every
rung rather than a number it cannot justify.

⚠️ **A metric whose scenario did not run stays `null`.** `tracking-mutations.mjs` runs subsets, and a
subset scoring 1.0 on something it never exercised would be exactly the lie this is built against.

### ⚠️ This is the first verification here that asks whether the answer was RIGHT

Everything else in this directory asks whether the platform produced an answer. Identity questions
cannot be asked that way: "did this person keep the same id?" has no answer unless you already know
it was the same person. So the input is four clips with **written-down trajectories** — real person
pixels cropped at the boxes the deployed model returns, composited on a plain background, played
through the same `mediamtx → ffmpeg → JPEG → runtime` path production uses.

⚠️ **They are not real CCTV footage.** No motion blur, no lighting change, no perspective, no gait.
[L-1](../../project/KNOWN_LIMITATIONS.md) stands. They prove the tracking **logic** on known input;
tracker performance on real video is P-9's question. That is exactly why the ground truth is
authored — on real footage nobody knows the right answer, so nothing can be asserted, only observed.

### The clips are generated, not committed

`ground-truth.json` is committed because it is the contract the assertions are written against and
must be reviewable in a diff. The `.mp4` and `.png` files are not: they are derived binary that any
machine rebuilds in twenty seconds, and a committed video is a thing that silently stops matching the
generator that claims to produce it.

Regenerate before running anything:

```sh
node docs/review/p8/tracking-fixtures.mjs --verify
```

### ⚠️ The crossing scenario, and why the two people walk at different heights

An identity **swap** is the failure that costs nothing visible: both people still have an id, the
counts still add up, the dashboard is still green. It is only wrong at "who was that?". After two
people cross, left and right have exchanged places — so position alone cannot distinguish a correct
tracker from one that swapped them. Height does not swap. Without that, the scenario would look
rigorous and assert nothing.
