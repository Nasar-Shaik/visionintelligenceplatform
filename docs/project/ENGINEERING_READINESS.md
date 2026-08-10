# Engineering readiness — before Professional Perception

**Date:** 2026-08-10 · **Branch:** `feature/v1` · **Head:** `f8bd47b`

The eleven confirmations required before Behaviour Intelligence is officially closed. ⚠️ Two are
qualified rather than ticked, and the qualification is the point of asking.

| # | Confirmation | State |
| --- | --- | --- |
| 1 | Evidence durability solved | ⭐ **Yes**, with one stated exception — see § A |
| 2 | Behaviour graph stable | ✓ Yes |
| 3 | Investigation console stable | ✓ Yes |
| 4 | Reasoning engine stable | ✓ Yes |
| 5 | Replay verification passes | ⭐ **Yes** — byte-identical ×5 conditions; +1 h pending, § B |
| 6 | Long-term storage verified | ⚠️ **Qualified** — see § C |
| 7 | Regression suite green | ✓ **1 540** Python · 636 console · 384 media |
| 8 | Deployment verification green | ✓ 17/17 containers, built images, never `pnpm dev` |
| 9 | Browser verification green | ✓ **212 passed, 0 failed** across four engines |
| 10 | Repository gate green | ✓ **70/70** · contracts 70 schemas · boundary §A–§L |
| 11 | Production behaviour platform complete | ⭐ **Yes** — the ceiling is now the detector |

---

## § A — Evidence durability: what is solved, and the one thing that is not

**Solved.** A completed run's evidence does not change after the run completes. Four root causes were
found, each measured before it was fixed: shutdown discarded open evidence; one fact was held at two
precisions; nothing closed a run when it ended (28 identities across 12 finished runs lost to a single
`SIGKILL`); and a torn write destroyed the record appended after it.

Proven on built images: a run's identities are durable the instant it ends, and an ungraceful
`docker kill -s KILL` then costs **nothing** — `records 5263 → 5263`.

⛔ **Not solved: power loss.** `write()` returns when the data reaches the kernel, not the platter.
There is no `fsync`. The platform survives *process* death; it does not survive *power* death. This
was a deliberate decision, not an oversight — the cost was never measured, and it lands on the
shutdown burst. It is recorded in `EVIDENCE_INTEGRITY_REPORT.md` § 9 and should be closed before a
customer deployment on hardware without a UPS.

## § B — Replay

Byte-identical across five conditions: immediately, after a service restart, after a runtime restart,
after a deployment `--force-recreate`, and after an ungraceful `SIGKILL`. Every difference is one
documented provenance field (`retentionHorizonAt`, which is `now − 72 h`).

⚠️ **The +1 hour replay was launched and has not yet reported.** The concern it tests — live records
expiring between reads — is now structurally impossible, because a run holds nothing live once it
ends. ⛔ That is an argument, not a measurement, and it stays marked pending until the check returns.

⚠️ **Host reboot: not performed.** It requires restarting the developer machine. What it would add
over the deployment restart already proven is the loss of the page cache, which matters *only*
because of § A.

## § C — Long-term storage: why this is qualified

**What is verified:** records survive process death, service restarts, deployment recreation and
ungraceful kills; 5 259 records written by the previous implementation were re-read by the new one
with **zero** parse failures; the store is bounded by three independent limits; and corruption is now
counted and reported rather than silently skipped.

⚠️ **What is not verified:** a record has never been observed being **expired by retention on the
deployment**. `RetentionPolicy`, `purge()` and the `expired` read state are implemented and
unit-tested, but the 72-hour horizon has not elapsed under observation, so the end-to-end path
"record ages out → read reports `expired` rather than `absent`" is proven in tests and not in
production. ⛔ Calling that "verified" would be exactly the kind of claim this project refuses.

**To close it:** run one analysis with `INFERENCE_TRACK_HISTORY_RETENTION_HOURS` set low (minutes),
let it age, and confirm the read moves `present → expired` and never `present → absent`. That is a
bounded piece of work and belongs before the first customer deployment, not before Phase 3.

---

## Recommendation

⭐ **Behaviour Intelligence can be closed, and Professional Perception can begin**, with § A's
power-loss gap and § C's retention observation carried as named items rather than forgotten.

⚠️ **Two decisions are still outstanding and can invalidate unstarted Phase 3 work**, both flagged in
`WORKTRACK.md` § 8 and unchanged by this milestone:

- **YOLO11 is AGPL-3.0.** Every model in the catalogue today is Apache-2.0. This is a product
  licensing decision, not an engineering one.
- **Re-identification is biometric processing.** It needs a governance decision and an ADR before any
  code is written.

Neither is a blocker for the **Detector Benchmark Lab**, which is first in the approved order and
depends on neither.
