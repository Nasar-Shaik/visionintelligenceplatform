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

## Phases 3–7 · not started

The order is ratified and not negotiable inside the milestone:
frame path → intent record → scheduler → inference → measurement → deployed verification. One
recommendation is already on the table for Phase 3 (the operator control belongs with Phase 4, or it
is a toggle that does not yet change what runs).
