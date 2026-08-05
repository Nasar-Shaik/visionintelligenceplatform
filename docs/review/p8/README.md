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

## Phases 2–7 · not started

The order is ratified and not negotiable inside the milestone:
frame path → intent record → scheduler → inference → measurement → deployed verification. One
recommendation is already on the table for Phase 3 (the operator control belongs with Phase 4, or it
is a toggle that does not yet change what runs).
