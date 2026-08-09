# Release Soak — Regression Tests

Every defect fixed in this session carries a test that fails without the fix. This file states what
each one asserts and, more importantly, **why the existing suite did not already assert it** — a
regression test that could have been written at any time is a test nobody needed.

> ⛔ The three product defects were found by the Architect using the product, not by the ~1 700 tests
> that were green at the time. That is the fact this file exists to answer.

---

## V-15 · the incident dedup key carried no subject

**`services/rules/test/loitering.test.ts`** — four tests.

| Test | Asserts | Fails without the fix? |
| --- | --- | --- |
| `⛔ gives three appearances by three tracked subjects three dedup keys` | Three distinct `trackId`s in one 60 s bucket produce **3** distinct keys | **Yes** — produced 1 |
| `still collapses one subject seen twice inside the window` | The same `trackId` twice in one bucket is still **one** key | No — guards the fix from over-correcting |
| `⭐ leaves a subjectless candidate key byte-identical` | An envelope with no subject keeps the exact pre-V-15 four-part key | **Yes, in the other direction** — catches a shape change that would make every live rule miss its window once on rollout |
| `does not key on the class when there is no track id` | Two subjects differing only by `identityId` still share a key, and the key stays four parts | **Yes** — a `class` fallback would look like the subject had been accounted for while bucketing every person together |

### ⚠️ Why the suite missed it

`loitering.test.ts` already contained **`gives two subjects two dedup keys`** — the exact assertion,
written when the dwell branch was built. It only ever exercised the **dwell** path. The bucketed
branch, which every ordinary match rule uses, had no equivalent. The file's own docstring stated the
invariant in prose (*"two different people … would share a dedup key and the second candidate would
be silently collapsed"*) and the code applied it to one of two branches.

⛔ **And the corpus agreed.** All 37 validation clips are ≤ 30 s, so every one of them fits inside a
single 60 s candidate-dedup bucket and produced exactly one incident — which read as correct. The
defect was invisible to the dataset for the same structural reason [L-63] describes for V-11.

---

## V-16 · "Play from here" seeked and did not play

**`apps/console/src/features/investigations/investigation-surface.test.tsx`** — three tests against
the exported `revealAndPlay`.

| Test | Asserts |
| --- | --- |
| `scrolls the player into view and starts it` | Both calls are made, in order |
| `swallows a refused autoplay rather than failing the seek` | A rejected `play()` promise does not propagate — the seek that already happened is still correct |
| `survives an environment that implements neither call` | jsdom throws from both; neither may take the seek down with it |

### ⚠️ Why the suite missed it, and what these tests still cannot prove

**jsdom implements no media element and no layout.** It has no `play()`, and
`getBoundingClientRect()` returns zeros — so the two halves of this defect (never playing, and the
player sitting ~1000 px above the viewport) are *both* invisible to a component test by construction.
The logic is exported and asserted directly because that is the most a jsdom test can honestly do.

⛔ **The proof is `tools/e2e-browser/test/surface.spec.ts` in a real browser**, and the measurement
that found it — `getBoundingClientRect().top === -1031` — could only ever come from one.

---

## V-17 · the overlay was a strobe

**`apps/console/src/features/investigations/overlay.test.ts`** — six tests.

| Test | Asserts |
| --- | --- |
| `fits at least eight samples inside the narrowest tolerance window` | `OVERLAY_SAMPLE_MS` divides the 500 ms window enough times that a paint cannot be skipped |
| `stays coarser than a display frame` | And is not so fine that it costs 60 renders a second for nothing |
| `names the nearest stored frame and how far ahead it is` | The badge is actionable, not a dead end |
| `says back when the nearest stored frame is behind the playhead` | Direction is stated |
| `distinguishes a run with nothing stored from a gap` | Two different facts get two different sentences |
| `counts what it is drawing when the playhead is on an analysed frame` | The in-frame case is unchanged |

### ⚠️ Why the suite missed it

The tolerance logic was correct and fully covered — `boxesAt` had 14 passing tests. **The defect was
in the sampling rate that drives it**, which lived in the component, in a browser API (`timeupdate`)
that jsdom never fires. No unit test could observe that Chrome ticks every 266 ms against a 500 ms
window.

⭐ The first test above is the durable guard: it ties the sample interval to the tolerance window as
a **ratio**, so changing either one without the other fails.

---

## Harness defects — fixed, not tested

Two bugs in the soak harness itself, found in its own smoke run before the soak began. They carry no
unit tests because the harness is a measuring instrument, not shipped code; they are recorded because
**a broken instrument reads as a healthy product.**

| Bug | Why it mattered |
| --- | --- |
| `/proc/1/fd` reported a flat `3` for every service | A metric that cannot move reads as "no fd leak" for six hours and would have done so through one |
| The snapshot probe used `/analyses/{id}/snapshot`; the route is `/snapshots` | It recorded a 404 as a failed operation instead of exercising evidence generation at all |
| The API latency probe ran concurrently with a `docker exec … python` in the same sampler ([S-4]) | Produced plausible 77–107 ms outliers that described the measurement, not the platform |

---

## Gate at the time of the soak

`pnpm turbo lint typecheck test` → **70/70 tasks**, including **527** console tests and **283** rules
tests. Verified on the deployment and in Chrome before the soak started.

---

## Related

- [SOAK_REPORT](SOAK_REPORT-2026-08-08.md) · [SOAK_FINDINGS](SOAK_FINDINGS-2026-08-08.md) · [SOAK_BASELINE](SOAK_BASELINE-2026-08-08.md)
- [KNOWN_LIMITATIONS](../project/KNOWN_LIMITATIONS.md) — L-69, L-70, L-71 added by this session
