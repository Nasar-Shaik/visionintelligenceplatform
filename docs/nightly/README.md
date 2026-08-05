# The unattended verification framework — design

> **How to use it** is [`scripts/README.md`](../../scripts/README.md). This page is why it is shaped
> the way it is, and what you need to know to extend it.

**This is not CI.** It is a local productivity tool with one job: convert hours you are asleep into
evidence you can read in a minute. It requires no cloud, no scheduler, no runner, no Kubernetes, and
it never talks to a network service the platform does not already use.

---

## The shape

```
scripts/nightly.sh ─┐
scripts/weekly.sh   ├─→ launch.sh ─→ engine.sh ─→ stages/<id>.sh  ──→ metrics/*.json
scripts/pilot.sh   ─┘   (caffeinate)  (the loop)   (the work)          status/<id>
                                          │                            logs/<id>.log
                                          └──────────────────────→ report.mjs → summary.md
```

**Profiles are data; the engine is the only code that executes them.** A profile is a text file where
one line is one stage:

```
id | title | script | enable-var | requires | on-fail | timeout-var
```

That is the entire extension mechanism. Hardware validation, ONVIF, tracking benchmarks and pilot
journeys all land as one script plus one line, with no change to the engine — which is the property
the brief asked for and the reason the manifest is a file rather than a `case` statement.

---

## The stage contract

A stage is a bash script that:

1. sources `_preamble.sh` (which re-reads config, provides `ok` / `bad` / `note` / `warn`);
2. does its work, writing freely to stdout — everything is captured to `logs/<id>.log`;
3. optionally writes `metrics/<id>.json` for the report to interpret;
4. optionally calls `headline "…"` — the one line the morning summary shows beside it;
5. optionally calls `guard "<undo command>"` before doing anything destructive, and `unguard` after;
6. ends with `finish`, which exits 0 if no `bad` was recorded.

Stages run as **child processes**, never sourced. A stage that crashes, calls `exit`, or corrupts its
shell cannot take the night down with it.

### ⚠️ Stages produce data; only the report interprets it

No stage decides whether a number is a regression. That lives in `report.mjs` against thresholds in
one config file. The alternative — each stage grading its own homework — scatters the thresholds
across thirteen shell scripts and guarantees two of them disagree.

---

## Failure semantics, which are the whole point

A green run exercises almost none of this.

| Outcome           | Means                                | Reported as                                                                        |
| ----------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| `passed`          | exit 0                               | ✅                                                                                 |
| `failed`          | non-zero exit                        | ❌                                                                                 |
| `timeout`         | exceeded its timeout and was killed  | ⏱️ — **deliberately not `failed`**: a hang and a wrong answer need different fixes |
| `skipped`         | something in `requires` did not pass | ⏭️                                                                                 |
| `disabled`        | its `RUN_*` switch is false          | ⚪                                                                                 |
| `not-implemented` | **no script exists at that path**    | 🚧 — never a pass                                                                  |

Three rules follow from those:

**A failure does not end the night.** You came for evidence, and one broken thing should not cost you
the other six answers. Only a stage declared `abort` stops the run, and only pre-flight is — because
measuring a stack that is not up produces a _confident_ wrong number, which is worse than none.

**A dependency that was disabled or skipped is not a pass.** The evidence it would have produced does
not exist, so anything downstream cannot be trusted either. `deps_satisfied` requires the literal
status `passed`.

**A missing script is never a pass.** The pilot and hardware profiles deliberately reference scripts
that do not exist. A framework that silently skipped them would show a green pilot-readiness run for
a pilot nobody has verified — and L-1 still stands: no real camera has ever been connected to this
platform.

### The `always` token

`requires: always` means "run even if the run aborted". Exactly one stage uses it — the report. The
first version of the loop skipped everything after an abort, so the night most in need of a written
explanation produced none.

---

## Not losing your work

The mutation stage edits real source files and rebuilds real images. Three independent protections,
because the failure mode is not "a test fails", it is "you wake up to a mutated repository":

1. **Pre-flight refuses a dirty tree.** With uncommitted work present, a restore that goes wrong is
   indistinguishable from work you did yesterday, and you find out by losing it.
2. **Guards.** A stage registers an undo command before doing anything destructive. If the stage
   dies without calling `unguard`, the engine runs that command **immediately** — so later stages
   measure a restored deployment — and again from the exit trap if the whole run is killed.
   ⚠️ The first version deleted the guard as soon as the stage finished, on the assumption that a
   finished stage had tidied up. That threw the undo instruction away in exactly the case it was
   written for. The self-test caught it.
3. **A before/after tree comparison.** Any difference is reported as RED with a diff in
   `logs/tree-drift.log`.

---

## Where output lives, and the constraint on moving it

Everything about unattended verification sits under `scripts/` — the commands, the engine, and the
evidence:

```
scripts/reports/nightly/<run>/     the run: summary, metrics, logs
scripts/reports/nightly/latest     symlink → the newest run
scripts/reports/nightly/INDEX.md   every run, one table
scripts/logs/nightly/current       symlink → the running run's logs (git-ignored)
```

⚠️ **`REPORT_ROOT` and `LOG_ROOT` must point at directories used for nothing else.**
`cleanup.sh --prune` deletes whole run directories by age. Pointed at a folder that also holds
source, it would delete source. The dedicated `scripts/reports/` and `scripts/logs/` subdirectories
are what make living under `scripts/` safe — the isolation is in the _subdirectory_, not in the
distance from the code.

Both are config values; nothing hard-codes a path.

---

## Why the benchmark is not promoted automatically

The brief asks for a generated `AI_RUNTIME_BENCHMARK.md`, and it also says never to modify
architecture documents automatically. Both are right. The freshly measured document is written into
the run as `benchmark.md`; copying it over the committed reference is an explicit act:

```sh
./scripts/benchmark.sh --promote          # prompts, and tells you to review the diff first
```

A permanent reference a machine can silently rewrite at 03:00 is not a reference. The value of that
page is that a person stood behind the numbers on it.

---

## Testing the tester

```sh
./scripts/nightly/selftest.sh
```

15 checks against synthetic stages in a temp directory — no containers, no real verification, about
30 seconds. It covers every row of the outcome table above plus resume, dry-run cleanliness, and
guard restoration. **Run it after any change to `engine.sh` or `lib.sh`.** It has already found one
real bug in the engine that a green run would never have surfaced.

---

## macOS specifics

- **bash 3.2.** No associative arrays, no `mapfile`, no `${var^^}`. The engine is written to that
  level deliberately — this runs on the machine it was written for, and a bash-4 idiom would fail at
  02:00.
- **No `timeout(1)`.** `lib.sh` implements a watchdog returning 124 on kill, matching GNU `timeout`.
- **`caffeinate`.** Wrapped around every run by `launch.sh`. Without it the machine sleeps and the
  night ends early with a directory of half-finished evidence.

---

## Extending it

To add a verification for a future milestone — ONVIF discovery, tracking accuracy, behaviour
benchmarks:

1. Write `scripts/nightly/stages/<domain>/<id>.sh` following the contract above — the folder is the
   domain it verifies, not the kind of check it is. `runtime/benchmark.sh` and `tracking/benchmark.sh`
   are both benchmarks and are deliberately separate files, because what they measure diverges:
   frames per second on one side, identity stability on the other. Grouping by check type instead
   would produce one `benchmark.sh` that grows a branch per capability, and the first thing a new
   capability would have to do is edit a file every other capability depends on.
2. Add a `RUN_<ID>` switch and a `TIMEOUT_<ID>` to `nightly.config`.
3. Add one line to the profiles that should include it.
4. If it produces numbers worth trending, write `metrics/<id>.json` and teach `report.mjs` to read it.

Until step 1 exists, the manifest line reports **not-implemented** — which is a useful state to ship
deliberately, because it turns a roadmap item into something a run tells you about.

### ⚠️ A stage may not write to a tracked file

Every underlying script takes `OUT=` and is pointed into the run directory. This was found the hard
way: three stages overwrote committed evidence, so every night rewrote the repository it was
verifying and tripped the deployment-integrity check that asserts the tree is clean.

### What P-8 Phase 4 added, as a worked example

Object tracking arrived as **five stages in one new folder** (`tracking/`) plus five rows per
profile. The engine was not touched, `report.mjs` was not touched, and no existing stage changed.
That is the property the domain layout exists to preserve — and the reason the folders for rules,
incidents, camera assignment, analytics and the verticals are named in
[`stages/README.md`](../../scripts/nightly/stages/README.md) before anything fills them.
