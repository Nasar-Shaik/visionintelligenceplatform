# Runbook — Overnight release soak

**The run that certifies a build.** Six to seven hours of representative customer workload against
the deployed production stack, uninterrupted, on a host nobody is using.

> ⛔ **A soak is a claim about *duration*.** Every other suite in this repository can be re-run in
> minutes; this one cannot, which is why most of this runbook is about the ways a long run gets
> silently invalidated rather than about how to start it. Seven instrument failures were found during
> P-9 ([LIVE_WEBCAM_VALIDATION](../validation/LIVE_WEBCAM_VALIDATION.md), §9); four of them would have
> invalidated a soak while leaving a complete, plausible set of files behind.

---

## 1 · Pre-flight

Run every one of these. They take about ten minutes and each has cost a run at least once.

| # | Check | Command | Why |
| --- | --- | --- | --- |
| 1 | Clean tree, and record the SHA | `git status --short && git rev-parse HEAD` | A soak certifies a **commit**. An uncommitted change makes the result unattributable |
| 2 | Stack is up and healthy | `./infra/docker/prod.sh ps` | All 17 `vip-prod-*` containers `healthy`, not merely `running` |
| 3 | Deployment verification green | `node tools/validation/verify-deployment.mjs` | The pre-soak baseline. Re-run it after, and compare |
| 4 | ⛔ No live session already open | `curl -sk https://localhost/api/media/live/sessions -H "$AUTH"` | A leftover session means a **second sender**. This invalidated a P-9 run at exactly double the intended rate, with every other signal healthy |
| 5 | ⛔ Host will not sleep | `caffeinate -dimsu …` (macOS) — see §2 | A suspended process does not slow a soak down; it deletes the hours that had not happened yet |
| 6 | Disk headroom | `df -h` | The 2026-08-07 soak consumed 0.7 GB in 6.5 h. Leave 20× that |
| 7 | Token lifetime exceeds the run | — | Two P-9 runs died of expiry mid-flight and kept a healthy cadence while sending nothing but 401s. Both harnesses now refresh on 401; confirm any *new* tool does |

---

## 2 · Starting the run

⭐ **`caffeinate` is not optional on macOS.** `-d` display, `-i` idle, `-m` disk, `-s` on AC, `-u`
declares user activity. Without it the laptop sleeps and the run's own clock keeps counting.

```bash
# Primary leg — representative customer workload (uploads, analysis, timeline, export, playback)
caffeinate -dimsu node tools/validation/soak.mjs --hours 6.5 --out .soak
```

### The live-capture leg

P-9 added a live ingest path that no previous soak has exercised for hours. Run it **concurrently**,
against the live camera, for the same duration:

```bash
caffeinate -dimsu node tools/validation/livecam/bench.mjs soak \
  --camera cam_4b8cbcbab9ec4685821b35a01c52efd2 \
  --frames <dir of jpg> --seconds 23400 --out .soak/livecam-soak.json
```

⚠️ **2 fps, not 4, if the two legs run together.** The 30-minute run measured inference at ~172 % CPU
average at 4 fps on a 10-core box, and the platform leg needs inference for every analysis. The
question tonight is stability over hours, not throughput — and a soak that saturates the host is a
load test wearing a soak's name.

Stop either leg early by touching `.soak/STOP`; the loop finishes its cycle and finalises cleanly.

---

## 3 · What invalidates a run

⛔ **Any of these means the run does not certify anything.** Each is now checked automatically, and
each is here because it happened.

| Failure | The signal | Automatic guard |
| --- | --- | --- |
| Host suspended or slept | A gap in the sampler's own timestamps of several sampling intervals | `analyseContinuity` in `soak.mjs` and `soak-report.mjs` → non-zero exit |
| Clock stepped backwards (NTP) | A negative gap; every rate improves | Same guard, reported separately |
| A second sender on one camera | Ingest at a clean multiple of the target rate | Pre-flight session check + `framesAccepted` vs `sent` |
| Auth expired mid-run | Rejections at a healthy cadence; drift analysis compares load against no-load | 401 refresh; >1 % refused → non-zero exit |
| Sampler blocking the driver | Achieved rate a constant fraction of target at *every* rate | `docker stats` is async everywhere; `skipRatio` / `harnessBound` reported |
| The run died before finalising | No `SUMMARY.json` | `soak-report.mjs` recomputes continuity from `metrics.jsonl` independently |

⭐ **The rule behind all six: an instrument that cannot fail is not an instrument.** If a check
reports an absence — zero errors, zero drops, zero drift — ask what else produces that reading
before recording it as good news.

---

## 4 · After the run

```bash
node tools/validation/soak-report.mjs .soak                       # tables, findings, continuity
node tools/validation/livecam/report.mjs --soak .soak/livecam-soak.json
node tools/validation/verify-deployment.mjs                       # post-soak, compare with pre
```

**Read the `## Run continuity` section first.** If it is not `✅ continuous`, stop — the run is
evidence about a laptop, not about a build.

### The verdict

| | |
| --- | --- |
| ⭐ **GO** | Continuity intact for the requested hours · 0 failed operations (or every failure explained and expected) · 0 container restarts · no consumer backlog · queue returns to 0 · memory flat between first and last decile · post-soak verification matches pre-soak |
| ⛔ **NO-GO** | Anything above unmet, **or** any guard in §3 fired |

### If it fails

Per standing instruction: **fix the defect, add a regression test that would have caught it, and
restart the soak.** A run is not certified until an uninterrupted one passes end to end. Record the
failed run rather than deleting it — the P-9 evidence rule is that a discarded run is a fact nobody
can re-examine.

Write the result up in `docs/validation/` following the existing set: `SOAK_REPORT`,
`SOAK_BASELINE`, `SOAK_METRICS`, `SOAK_FINDINGS`, `SOAK_TIMELINE`, `SOAK_REGRESSION_TESTS`.

---

## 5 · Scope — what a soak never proves

⚠️ One host, no GPU, a synthetic corpus, and a fake camera device. It does not speak to real CCTV
optics, RTSP or ONVIF cameras, multi-camera load, multi-day operation, or a customer's network. Those
are listed as unvalidated in
[LIVE_WEBCAM_VALIDATION §10](../validation/LIVE_WEBCAM_VALIDATION.md) and must not be implied by a
GO verdict here.
