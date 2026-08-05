# `scripts/` — unattended verification

**Run one command before you sleep. Read one file in the morning.**

```sh
./scripts/nightly.sh                       # tonight's run  (~2h with the defaults)
```

```sh
scripts/reports/nightly/latest/summary.md          # the morning read — always the newest run
```

`latest` is a symlink that is repointed the moment a run starts, so it never needs a date, and it
points at a run that died half-way just as reliably as one that finished.
`scripts/reports/nightly/INDEX.md` is the one-table history of every run.

---

## What is here

**24 files in total**: 6 commands you run, 5 engine files, 13 stages, 5 profiles and 1 config.

### The 6 commands

| Command                            | What it does                                                                                                             |     Roughly |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------: |
| **`./scripts/nightly.sh`**         | The standard run — gate, deployment, boundary, inference, dashboard, integration, stability, benchmark, mutation, report |    **~2 h** |
| `./scripts/weekly.sh`              | Everything nightly does, with a **4-hour** soak long enough to see a slow leak, plus housekeeping                        |    **~6 h** |
| `./scripts/benchmark.sh`           | Capacity ladder only — for when you changed something that should be faster                                              | **~45 min** |
| `./scripts/pilot.sh`               | Pilot readiness (P-10). ⚠️ Several stages are **not implemented** and say so                                             |        ~3 h |
| `./scripts/hardware-validation.sh` | Real cameras and NVRs (P-9). ⚠️ Almost entirely **not implemented**                                                      |           — |
| `./scripts/cleanup.sh`             | Prune old runs, reclaim the docker build cache, remove leftover fixtures. **Dry by default**                             |     seconds |

Every one accepts:

```sh
./scripts/nightly.sh --dry-run                 # what would run tonight, and what is switched off
./scripts/nightly.sh --resume                  # continue a run that was interrupted
./scripts/nightly.sh --run-id 2026-08-06       # name the run directory
```

### The engine — `scripts/nightly/`

| File          | Role                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `engine.sh`   | The stage runner: order, dependencies, timeouts, resume, restore-on-crash                                |
| `launch.sh`   | Wraps a run in `caffeinate` so a sleeping Mac does not end the night                                     |
| `lib.sh`      | Logging, the run journal, and a portable `timeout` (macOS ships none)                                    |
| `report.mjs`  | Turns the journal, statuses and metrics into `summary.md`, `verification.md`, `benchmark.md`, `INDEX.md` |
| `selftest.sh` | **Tests the runner itself** — 15 checks, no containers. Run it after changing the engine                 |

### The 18 stages — `scripts/nightly/stages/`

Stages are grouped by the **domain** they verify — `platform/`, `runtime/`, `tracking/` — so a new
capability adds a folder and its rows rather than editing a file every other capability depends on.
See [`scripts/nightly/stages/README.md`](nightly/stages/README.md) for the taxonomy and the folders
reserved for rules, incidents, camera assignment, analytics and the verticals.

| Stage                 | What it verifies                                                                                 |            Roughly | Wraps                       |
| --------------------- | ------------------------------------------------------------------------------------------------ | -----------------: | --------------------------- |
| `preflight`           | Docker up, containers healthy, disk, runtime healthy, tree clean. **Aborts the run if it fails** |                2 s | —                           |
| `gate`                | format · typecheck · lint · unit tests · build · python                                          |           2–10 min | `pnpm` + `unittest`         |
| `deployment`          | Every running byte is the committed byte                                                         |              2 min | `deployment-integrity.mjs`  |
| `boundary`            | Contracts, the perception boundary, the import graph                                             |               10 s | `verify:contracts`          |
| `runtime`             | Real inference end to end through a camera                                                       |             10 min | `p8/inference.mjs`          |
| `dashboard`           | The operator page in a real browser                                                              |              5 min | `p8/runtime-ui.mjs`         |
| `integration`         | Cross-service integration tests                                                                  |              5 min | `pnpm test:integration`     |
| `stability`           | Continuous inference — memory, CPU, queue, latency, drops, detection consistency                 | **`SOAK_MINUTES`** | `p8/inference-soak.mjs`     |
| `benchmark`           | Warm-up, reproducibility, the capacity ladder                                                    |             15 min | `p8/hardening.mjs`          |
| `mutation`            | Break the platform 7 ways, confirm each verification goes red for its own reason                 |          45–60 min | `p8/mutations.mjs`          |
| `tracking`            | ⚠️ The five identity properties against **authored** ground truth, over real RTSP                |              4 min | `p8/tracking.mjs`           |
| `tracking-deployment` | The tracking engine is in the running image, reachable, still off the gateway                    |               15 s | `p8/tracking-deploy.mjs`    |
| `tracking-browser`    | The four track pages, every number traced to the payload behind it                               |              3 min | `p8/tracking-ui.mjs`        |
| `tracking-benchmark`  | tracks/s, identity stability, lost, recovered, CPU, RAM at 1→16 cameras                          |              8 min | `p8/tracking-benchmark.mjs` |
| `tracking-mutations`  | Break tracking 5 ways — id, association, occlusion, direction, lifetime                          |          25–35 min | `p8/tracking-mutations.mjs` |
| `cleanup`             | Prune runs, reclaim build cache (weekly only)                                                    |              1 min | `cleanup.sh`                |
| `report`              | The morning summary. **Always runs, even after an abort**                                        |                2 s | `report.mjs`                |
| `_preamble`           | Not a stage — the shared header every stage sources                                              |                  — | —                           |

⚠️ **`tracking` is the only stage that asks whether the answer was RIGHT.** Every other stage asks
whether the platform produced one. It can ask the harder question because its input is authored: four
clips whose trajectories are written down before the run. The clips are **generated on every run**
from the boxes the deployed model returns, so a model change that moves the crops moves the fixtures
with it.

---

## Timing — what is configured, and how to change it

**The only setting that meaningfully changes how long a night takes is `SOAK_MINUTES`.** Everything
else is roughly fixed by how much work it does.

| Profile        | `SOAK_MINUTES` | Whole run |
| -------------- | -------------: | --------: |
| `nightly.sh`   |         **30** |      ~2 h |
| `weekly.sh`    |        **240** |      ~6 h |
| `benchmark.sh` |             30 |   ~45 min |
| `pilot.sh`     |            120 |      ~3 h |

### Change it for one run

Nothing to edit — anything in the environment wins over the config file:

```sh
SOAK_MINUTES=15 ./scripts/nightly.sh                      # a quick night
SOAK_MINUTES=120 SOAK_REASON="chasing the memory drift" ./scripts/nightly.sh
RUN_MUTATION=false ./scripts/nightly.sh                   # skip the hour-long stage
```

### Change it permanently

Edit `scripts/nightly.config`, or — for settings you do not want to commit — create
`scripts/nightly.config.local`, which is git-ignored and sourced last.

### ⚠️ A soak over 60 minutes must state a reason

Pre-flight **refuses to start** if `SOAK_MINUTES > 60` and `SOAK_REASON` is empty. Per the execution
policy of 2026-08-05, a long soak is justified by a suspected memory/resource leak, a suspected
concurrency or scheduling issue, a release candidate, hardware validation (P-9), pilot readiness
(P-10), or GA. Otherwise 15–30 minutes is the standard and the hours belong to features.
`weekly.sh` supplies its own reason.

### Timeouts

Every stage has one, in seconds, in `nightly.config` — `TIMEOUT_GATE`, `TIMEOUT_MUTATION`, and so on.
`0` means no limit. A stage that exceeds its timeout is **killed and reported as `timeout`**, which
is deliberately distinguished from `failed`: a hang and a wrong answer need different fixes.
`TIMEOUT_SOAK` is computed from `SOAK_MINUTES` plus 15 minutes for setup and teardown.

---

## Turning stages on and off

Every stage has a `RUN_*` switch in `nightly.config`. All default to `true`:

```
RUN_PREFLIGHT  RUN_GATE     RUN_SOAK       RUN_BENCHMARK  RUN_MUTATION  RUN_DEPLOYMENT
RUN_RUNTIME    RUN_DASHBOARD  RUN_BOUNDARY  RUN_INTEGRATION  RUN_CLEANUP  RUN_REPORT
```

`RUN_COMMIT` is the exception — it is `false` and should stay that way. A machine that commits while
you sleep can carry a broken tree into the morning with nobody having read it.

A disabled stage is reported as **disabled**, never quietly omitted. So is a stage that was skipped
because something it depends on failed, and so is a stage whose script does not exist yet
(**not-implemented** — the pilot and hardware profiles are full of those on purpose).

---

## What you get in the morning

```
scripts/reports/nightly/2026-08-06/
├── summary.md         ← read this
├── verification.md    ← what each stage asserted
├── benchmark.md       ← the measured ladder, if the benchmark ran
├── metrics/           ← raw JSON samples, for trends
├── logs/              ← full output of every stage
└── journal.jsonl      ← append-only event log; survives a killed run
```

`summary.md` gives **GREEN / AMBER / RED**, a table of every stage, the resource and performance
trend against the previous run, any regression that crossed a threshold, and a numbered list of
recommended actions.

**AMBER** means nothing failed but something was skipped — worth knowing, because a green tick on a
run where half the stages never executed is the failure this framework exists to prevent.

---

## Safety

⚠️ **The mutation stage edits real source files and rebuilds real images.** It restores from a byte
snapshot, the engine runs a second restore if a stage is killed, and every run compares the working
tree before and after and reports **RED** if it changed. Pre-flight refuses to start with
uncommitted work in the tree (`REQUIRE_CLEAN_TREE=true`) — commit or stash first, or run with
`RUN_MUTATION=false` if you only want measurements.

⚠️ **`caffeinate` is not optional.** Without it macOS sleeps and the run stops mid-stage.
`KEEP_AWAKE=true` wraps every run in it. A lid close still stops the machine — that is a deliberate
escape hatch, not an oversight.

---

## Changing the framework

Run the self-test after touching the engine:

```sh
./scripts/nightly/selftest.sh      # 15 checks against synthetic stages, no containers, ~30 s
```

To add a stage: write `scripts/nightly/stages/<id>.sh`, source `_preamble.sh`, use `ok`/`bad`, end
with `finish`, and add one line to the profile. Nothing else changes — see
[`docs/nightly/README.md`](../docs/nightly/README.md) for the contract and the design reasoning.
