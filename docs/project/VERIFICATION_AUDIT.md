# Verification Audit — can the verifier be trusted?

> **Audited 2026-08-06/07**, at the P-8 Phase 7 freeze, across 34 nightly stages and 31 verification
> scripts. Commissioned after two consecutive full nightly runs found defects in the **verification
> ecosystem** rather than in the runtime.
>
> ⚠️ **The premise:** verification code is production code. A benchmark that measures the wrong thing
> is a product defect, not a tooling defect — it is the number a customer is sized against.

Related: [KNOWN_ISSUES](KNOWN_ISSUES.md) · [DEFINITION_OF_DONE](DEFINITION_OF_DONE.md) ·
[VERIFICATION_MATRIX](../review/p6/VERIFICATION_MATRIX.md)

---

## Method

Every stage and script was read against eight questions:

1. Can it produce a **false green**?
2. Can it produce a **false red**?
3. Can it **silently measure the wrong thing**?
4. Can it **mutate tracked files**?
5. Can it depend on a **previous stage**?
6. Can it depend on a **warmed cache**?
7. Can it depend on **execution order**?
8. Can it **measure one camera while reporting sixteen**?

Question 8 is not hypothetical. It is what the 2026-08-06 nightly found, in the Phase 3 ladder, and it
is the reason this audit exists.

---

## Findings

### ⛔ F-1 · Ladders publish capacity numbers without asserting the rungs scaled

**Question 8. Severity: high. Status: policy written, one ladder instrumented, four outstanding.**

Six ladders publish per-rung numbers. **Only one asserts anything that would notice if the rungs
stopped being different from each other**: `inference.mjs` §8, which checks the frame-accounting
invariant `offered == delivered + dropped + failed`.

| Ladder                       | Records `offered` | Asserts an invariant |
| ---------------------------- | :---------------: | :------------------: |
| `inference.mjs` §7           |        ✅         |          ✅          |
| `hardening.mjs` §3           |        ✅         |          ⛔          |
| `tracking-benchmark.mjs`     |        ✅         |          ⛔          |
| `assignment-benchmark.mjs`   |        ✅         |          ⛔          |
| `event-bridge-benchmark.mjs` |        ✅         |          ⛔          |
| `loitering-benchmark.mjs`    |        ⛔         |          ⛔          |

⚠️ **What this cost, once, measurably.** `inference.mjs` started sixteen streams and never assigned
them; from P-8 Phase 6 an unassigned camera is never analysed, so it measured the **one** camera an
earlier section had assigned and printed `16 cameras · 44 analysed · 65.2ms inference`. Every figure
above rung 1 was a single stream. It reads perfectly plausibly. The invariant is the only reason
anyone knows.

⚠️ **The P-8 Phase 7 ladder's numbers stand, and were checked rather than assumed.** Its recorded
output shows the rungs did scale — events/s 0.03 → 1.37, zones loaded 1 → 16, dwell timers 1 → 32,
detections tested 1716 → 7538 across 1 → 16 cameras. Five independent signals. **But nothing in it
would have said so if they had not**, which is exactly the state `inference.mjs` was in.

### ⛔ F-2 · `rows.every(...)` on an unguarded array is vacuously true

**Question 1. Severity: high. Status: outstanding.**

Six checks across `inference.mjs` §8 and `event-bridge-benchmark.mjs` assert `rows.every(...)` with no
guard that `rows` is non-empty. A ladder that recorded **zero** rungs reports all six **green**.

⚠️ This is the _same_ `[].every(...)` trap found and recorded during P-8 Phase 3 — where six checks
were passing vacuously and a mutation found them. The instance was fixed. The class was not.

### ⛔ F-3 · Two mutation harnesses never prove the restore returns green

**Question 1. Severity: high. Status: outstanding.**

| Harness                      | baseline green | goes red | names the check | **restore → green** |
| ---------------------------- | :------------: | :------: | :-------------: | :-----------------: |
| `mutations.mjs`              |       ✅       |    ✅    |       ✅        |   ✅ per mutation   |
| `tracking-mutations.mjs`     |       ✅       |    ✅    |       ✅        |   ✅ per mutation   |
| `event-bridge-mutations.mjs` |       ✅       |    ✅    |       ✅        |      ✅ final       |
| `loitering-mutations.mjs`    |       ✅       |    ✅    |       ✅        |  ⛔ **tree only**   |
| `assignment-mutations.mjs`   |       ✅       |    ✅    |       ✅        |  ⛔ **tree only**   |

The last two restore from a byte snapshot and then assert that the **source tree** is clean. The
**deployment** is never re-verified.

⚠️ **The consequence is specific.** Each mutation is scored against a baseline taken once, at the
start. If mutation N's restore leaves the deployment subtly broken, mutation N+1 goes red — and the
harness records that as N+1 correctly turning the verification red. **A failed restore is
indistinguishable from a successful mutation.** Both suites reported 8/8 and 7/8 on the freeze
candidate; those results are believed, but they are believed on the basis of the tree check.

### ⛔ F-4 · A refusal was treated as a fatal error, and one throw took out four stages

**Questions 2, 5, 7. Severity: high. Status: FIXED 2026-08-07 (`93aa0aa`).**

`hardening.mjs` threw when the control plane refused a camera. Two costs:

- Five measured rungs (1, 2, 4, 8, 12 cameras) were **discarded**, and the stage reported
  `no capacity samples were written`.
- The script has no top-level `finally`, so the throw **skipped cleanup**: it left `maxCameras: 24`
  and a dozen assigned cameras behind, and the next three ladders — including the milestone's own —
  failed with 409 at their **first** rung.

⚠️ **And the refusal was the platform working.** At 12 cameras the runtime hit 23.9 % drop and 556 %
CPU, so the control plane declined a 13th with _no registered runtime is healthy enough_. The
assignment engine did exactly its job and the ladder called it a crash.

Fixed by `tryAssignCameras`, shared: a ladder now stops, publishes the rungs it measured, and records
`refusedAt` beside the table.

### ⛔ F-5 · Verifications had not caught up with the assignment gate

**Question 8. Severity: high. Status: FIXED 2026-08-06/07.**

P-8 Phase 6 made an unassigned camera never analysed. Four places had not been told: the
`inference.mjs` ladder (F-1's example) and three ladders that never raised the declared capacity.
`_assign.mjs` existed for exactly this purpose and was not used consistently.

⚠️ **The class was visible a day before it bit.** The P-8 Phase 7 loitering ladder hit the same 409
and the repair was made inside that one file. `raiseRuntimeCapacity` now lives beside `assignCameras`.

### ⚠️ F-6 · Generated artifacts

**Question 4. Severity: medium. Status: FIXED, with one unresolved.**

| Artifact                            | Was                                                                    | Now                                   |
| ----------------------------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| `ground-truth.json`                 | stamped `generatedAt`, so a deterministic file always looked changed   | timestamp removed                     |
| `event-bridge-mutations.json`       | written straight into a tracked path                                   | redirected to the run directory       |
| `*-samples.json`, `*-capacity.json` | rejected by prettier, so running a verification turned the gate red    | `.prettierignore`                     |
| `scripts.zip`                       | **deleted during an unattended run; the deleter was never identified** | removed deliberately — **KI-04 open** |

⚠️ **A `generatedAt` on a deterministic artifact is worse than useless.** It dirties the tree after
every run — which blocks the next one, because mutation stages refuse a dirty tree — and it destroys
the one question tracking the file exists to answer: _did the fixtures actually move?_ A field that
always changes reports nothing.

### ⚠️ F-7 · Stage independence is declared but not enforced

**Questions 5, 7. Severity: medium. Status: recorded.**

All 32 non-report stages declare `requires: preflight` only — the framework asserts no inter-stage
dependency. **Three real ordering constraints exist in comments rather than in the manifest:**

1. `broker-resilience` must be **last** — it stops the broker every service shares.
2. `deployment` must run **before** anything rebuilds an image, or a legitimate rebuild reads as drift.
3. `rule-replay` **restarts the rules service** — anything concurrent would measure the restart.

And two shared-state observations:

- ⚠️ **The declared runtime capacity is shared, mutable deployment state.** Four ladders raise and
  restore it. F-4 is what happens when one fails to restore. Each now restores in a `finally`, but a
  **killed** stage still leaks it: the `clean` subcommands do not restore the declaration, and they
  cannot honestly guess the original value.
- Five browser stages share `/private/tmp/pwrun`; each copies its own script in, none cleans up. Not
  currently harmful.
- The report deliberately reads the **previous successful run** for regression thresholds. By design —
  but it means a report is not reproducible from one run directory alone.

### ⚠️ F-8 · Cache-warmth dependence

**Question 6. Severity: low. Status: recorded.**

`rule-replay` waits 20 s for the zone catalogue rather than polling a readiness signal. It passes on
this machine by **margin, not by measurement** — a slower host would make it flaky, and the failure
would look like a determinism defect rather than a warm-up race. `hardening` §1 measures warm-up
deliberately and is correct.

### ✅ F-9 · Where nothing is wrong

Said explicitly, because an audit that only lists problems is not an audit:

- **No remaining script writes to a tracked path.** All 31 audited; every surviving
  `writeFileSync(join(ROOT, …))` is a mutation harness _restoring_ a byte snapshot.
- **Every stage runs against the deployment**, through `https://localhost` — the edge, the gateway,
  the services. None imports a component, mounts a test renderer, or starts a service in-process.
- **Every mutation harness refuses to run on a red baseline**, so a mutation can never be credited for
  a failure that was already there.
- **Every mutation restores from a byte snapshot in a `finally`, never from git.** That rule exists
  because `git checkout --` destroyed uncommitted work once.
- **The engine's guard mechanism runs each stage's undo command if the stage is killed**, verified by
  `selftest.sh` (15 checks).
- **`nightly-tests` reports a finding when it finds no `*.nightly.test.ts` files** — a convention with
  no files is one somebody has stopped using.

---

## What becomes permanent policy

| #   | Policy                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **A ladder asserts its rungs differ before publishing.** `offered == delivered + dropped + failed`, or a scaling signal, per rung. No invariant, no table |
| 2   | **A refusal is a measurement.** Ladders truncate and record `refusedAt`; they never throw away rungs they measured                                        |
| 3   | **Assertions are written against invariants, not expected values.** The invariant caught a defect it was not written for; an expected value could not     |
| 4   | **`array.every(...)` requires a non-empty guard.** `[].every()` is `true`                                                                                 |
| 5   | **A mutation harness re-verifies the deployment after restore**, not only the source tree                                                                 |
| 6   | **A verification's report of what it sent is not evidence of delivery.** Measure at the receiver                                                          |
| 7   | **No stage writes a tracked file.** No generated artifact carries a timestamp. No evidence file is formatted                                              |
| 8   | **A shared deployment declaration raised by a stage is restored in a `finally`**, and the raise is a shared helper, never a per-script repair             |

⚠️ **The recurring pattern across every finding above is the same one: an instance was fixed and the
class was left.** The `[].every()` trap, the capacity refusal, the assignment gate — each was found,
repaired in one file, and met again somewhere else within days. Policy 8 is the general form: when a
verification needs a repair, the repair belongs in the shared helper.

---

## P-9 Track A — four more, and two of them are the same rule from opposite ends

**2026-08-07.** Five new verifications; every one of them found a defect in the product, and three
found defects in themselves first.

| #   | Policy                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | ⭐ **A verification asserts the ABSENCE of "we could not measure", never the presence of a result it cannot control.** A1 asserts `unavailable` is absent, not that devices were found — the other way round it would be red forever on correct behaviour and green only once a camera existed, which is green exactly when it had stopped being needed                    |
| 10  | ⭐ **Read the exit code, not the output.** A live certification printed a complete, correct summary and then died with SIGSEGV while writing its bundle. Every human reading stdout called it a pass                                                                                                                                                                       |
| 11  | ⚠️ **A control case is not optional in a measurement suite.** A5's first run reported every engine failing to decode HEVC. It also reported every engine failing to decode **H.264**, which all five demonstrably play — and only that impossible result exposed two harness defects. Without the control it would have been published, because it matched the expectation |
| 12  | ⚠️ **Assert the fixture came up, not that the command to start it returned.** `docker run -d` exits 0 for a container that started and immediately died on a bad config. A4.5 reported `0/4 cameras decoded` against a fixture that had never existed                                                                                                                      |
| 13  | ⚠️ **A verification whose outcome depends on someone else's allocator is not a verification.** A11's first S6 restarted a container and hoped Docker would hand out a different IP. It did not, so the scenario reported `not-executed` — and would have reported `pass` on a different day for no reason connected to the platform                                        |

⭐ **Two independent findings pointed at one missing property.** A3 hit it from teardown — the decoder
was released while a pump thread sat inside a native `read()` that never returned. A11 hit it from the
probe — a device that accepted TCP and stalled held the capture past every budget above it. Neither
looked like the other; both were `cv2.VideoCapture` having no open or read timeout. **When two
unrelated verifications fail for reasons that both bottom out in the same absent bound, the bound is
the finding** — fixing either symptom alone would have left the other live.

⚠️ And the P-8.7 lesson recurred in a new place. A6 found a guard that **fired correctly and caused
the damage it existed to prevent**: `certify()` refused a `certified`-on-`simulated` promotion, and
left the entry mutated to exactly that, so `save()` wrote it to disk and the next `load()` refused the
whole registry. **A refusal must leave the world as it found it**, or the correct-looking report is
what stops anyone looking further.
