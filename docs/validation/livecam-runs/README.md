# Live capture — run artefacts (P-9, 2026-08-08)

The raw JSON behind every table in [../LIVE_WEBCAM_VALIDATION.md](../LIVE_WEBCAM_VALIDATION.md) and
[../LIVE_PERFORMANCE_BASELINE.md](../LIVE_PERFORMANCE_BASELINE.md).

⭐ **Committed so the reports can be audited rather than believed.** Every table in those documents
is regenerated from these files by `tools/validation/livecam/report.mjs` — nothing is transcribed by
hand, and a reader who doubts a number can recompute it.

| File | Produced by | Contains |
| --- | --- | --- |
| `matrix-final.json` | `tools/e2e-browser/livecam-matrix.mjs` | 28 scenarios: detections, tracks, events, incidents, ground truth, loop guard |
| `latency.json` | `tools/e2e-browser/livecam-latency.mjs` | Nine stages, each tagged measured / reported / derived |
| `pressure.json` | `tools/validation/livecam/bench.mjs pressure` | Baseline → overload → recovery, with the continuous sampler series |
| `fps.json` | `tools/validation/livecam/bench.mjs fps` | 1, 2, 4, 8, 15 fps with CPU and memory per service |
| `parity.json` | `tools/validation/livecam/parity.mjs` | The same clip offline and live, execution path compared |
| `soak.json` | `tools/validation/livecam/bench.mjs soak` | 30 minutes continuous, first-tenth vs last-tenth drift |

## ⛔ `soak.json` contains two numbers that are wrong, on purpose

`phase.seconds: 2761.2` and `phase.achievedFps: 2.6` are left exactly as the harness recorded them.
The host suspended for 966 s after the sender had finished its 1800 s, and the harness divided 7181
frames by a clock that kept running. The true rate is **4.000 fps**.

⭐ **The file is not corrected, because evidence that is edited to match a later understanding stops
being evidence.** `report.mjs` recomputes from the complete `series` and `resources` arrays — both
committed in full — and prints the suspension above the tables rather than as a footnote. The
detector lives in `tools/validation/lib/continuity.mjs` and every soak in the repository now runs it.

## ⚠️ Reading these honestly

**`matrix-final.json` is a merge of two runs.** Twenty-two rows come from the first full run; six were
re-run after a harness fix (its access token expired mid-run and every platform read returned `null`);
one is manual-only and marked `NOT EXECUTED`. The `note` field in the file says so. The alternative —
publishing rows whose instrument did not read — is the thing the merge exists to avoid.

**Per-sample arrays are truncated at 200 entries.** These are evidence for the tables, not a data
lake; the full series lives in the run's scratch output and is not worth a repository's weight.

**`cpuSamples` is stripped from matrix rows.** The matrix samples `docker stats` synchronously
between browser waits, which is safe there (the browser paces itself out of process) but produces a
noisy series that would invite comparison with `fps.json`, where the sampler is asynchronous and the
numbers are sound. The two are not comparable and the ambiguity is removed rather than footnoted.

## Reproducing

Every command is in [../COMPLETE_E2E_TEST_GUIDE.md](../COMPLETE_E2E_TEST_GUIDE.md) §6–§11.

⚠️ **These are single-camera, CPU-only, authored-footage measurements on one 10-core laptop.** They
are a baseline to compare future runs against, not a statement about a customer's deployment.
