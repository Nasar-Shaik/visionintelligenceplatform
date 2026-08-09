# Validation

Measurements taken against a **running deployment**. Nothing in this directory is a plan or a
proposal — every document reports what was observed, on which build, with what left unproved.

> ⚠️ **Simulation never certifies.** A green suite says the code does what its author intended; these
> documents say what the deployed product did. Where a run used synthetic input, each says so in its
> own words rather than in a footnote.

---

## Live video — P-9 (2026-08-08)

| Document | What it answers |
| --- | --- |
| [LIVE_WEBCAM_VALIDATION](LIVE_WEBCAM_VALIDATION.md) | Does live video work through the production pipeline, and what did 28 scenarios find? Includes the source-agnosticism proof, the five instrument failures, and the honest not-validated list |
| [LIVE_PERFORMANCE_BASELINE](LIVE_PERFORMANCE_BASELINE.md) | ⭐ **The permanent comparison baseline for future AI models** — nine latency stages, frame-rate scaling, back-pressure, saturation point |
| [MANUAL_TEST_GUIDE](MANUAL_TEST_GUIDE.md) | The **real camera** run a human must do. Nothing automated has seen a lens |
| [COMPLETE_E2E_TEST_GUIDE](COMPLETE_E2E_TEST_GUIDE.md) | Reproducing every automated result, command by command |
| [livecam-runs/](livecam-runs/) | The raw JSON behind every table, so the reports can be audited rather than believed |

## Detectors — P-10 A2 (2026-08-08)

| Document | What it answers |
| --- | --- |
| [DETECTOR_COMPARISON](DETECTOR_COMPARISON.md) | ⭐ **Two detector families through one unchanged runtime.** Latency, throughput, memory, ONNX operator inventory, licensing — and the cross-model localisation check (mean IoU **0.95**) that verifies the decoder without ground truth |

## Release soaks

| Document | What it answers |
| --- | --- |
| [⭐ OVERNIGHT_SOAK runbook](../runbooks/OVERNIGHT_SOAK.md) | **How to run one so it counts** — pre-flight, the six ways a long run is silently invalidated, and the GO/NO-GO rule |

### Soak runs, newest first

⛔ **Every run keeps its own dated report and nothing is overwritten.** A release soak is the record
of a decision taken on a date, against a named commit; replacing it with the next run's answer
destroys the only account of why the last decision was made. The date in the filename is the run's,
not the file's.

| Run | Verdict | Duration | Report |
| --- | --- | --- | --- |
| **2026-08-09** (P-11, behaviour layer) | ⛔ **NO-GO** — browser certification, delivery accounting | 6.49 h uninterrupted | [SOAK_REPORT-2026-08-09](SOAK_REPORT-2026-08-09.md) · [SOAK_FINDINGS-2026-08-09](SOAK_FINDINGS-2026-08-09.md) · [soak-2026-08-09.json](soak-2026-08-09.json) |
| 2026-08-08 (release soak) | ⭐ GO, with one finding to schedule | 6.51 h uninterrupted | [SOAK_REPORT-2026-08-08](SOAK_REPORT-2026-08-08.md) |
| 2026-08-07 (platform soak) | ⚠️ INTERRUPTED — 5.51 h of 6.5 h, instrument went half-blind | 5.51 h measured | [review/SOAK_REPORT](../review/SOAK_REPORT.md) |

Supporting documents for the **2026-08-08** run:

| Document | What it answers |
| --- | --- |
| [SOAK_BASELINE](SOAK_BASELINE-2026-08-08.md) | The pre-soak state the run started from |
| [SOAK_METRICS](SOAK_METRICS-2026-08-08.md) | What was sampled, and how often |
| [SOAK_FINDINGS](SOAK_FINDINGS-2026-08-08.md) | Every defect and every broken instrument |
| [SOAK_TIMELINE](SOAK_TIMELINE-2026-08-08.md) | What happened, in order |
| [SOAK_REGRESSION_TESTS](SOAK_REGRESSION_TESTS-2026-08-08.md) | The tests added so each finding cannot recur |

⚠️ The 2026-08-09 run is self-contained: its report carries the baseline, metrics, findings, timeline
and acceptance table in one generated file; [SOAK_FINDINGS-2026-08-09](SOAK_FINDINGS-2026-08-09.md) carries the root-cause analysis a generator cannot derive. Raw evidence for it lives in
`.soak-p11/` (and `.soak-p11-aborted-defect{3,4,5}/` for the three runs stopped to fix defects).

---

## ⭐ The rule these documents are written to

**An instrument that cannot fail is not an instrument.** Both the release soak and the live-video
milestone found more defects in their own *measurement* than in the product:

- a metric that read the same value whether the system was healthy or dead;
- a rate that was 70 % of target at every load, because a sampler blocked the sender;
- an event count used as a detection count, when events are deduplicated;
- a fixture that rotated the frame **and the people in it**;
- a soak whose second half sent nothing but 401s, at a healthy run's cadence;
- two sender processes on one camera, producing exactly double the intended load;
- a 966-second host suspension that turned a true 4.000 fps into a recorded 2.6 fps — **while the
  rejection guard and the duplicate-sender guard both passed.**

Every one of those would have put a false statement about the product into a document somebody
quotes. Each fix made the instrument grade itself, and each is written up beside the result it would
have corrupted — because the next reader's real question is not "what did it measure" but "why
should I believe it".
