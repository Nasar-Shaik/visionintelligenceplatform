# Release Soak — Timeline

**2026-08-07 20:03:02 UTC → 2026-08-08 02:33:41 UTC · 6.51 hours, uninterrupted.**

> ⭐ The soak was never restarted. No failure required it, and nothing was changed in the product
> while it ran — a mid-run change would mean [SOAK_BASELINE](SOAK_BASELINE-2026-08-08.md) no longer described
> what was deployed.

| Time (UTC) | Elapsed | Kind | Event |
| --- | ---: | --- | --- |
| 20:03:02 | 0m | phase | soak starting |
| 20:20:30 | 17m | observation | S-1 · A refused upload is indistinguishable from an un-analysed one |
| 20:20:30 | 17m | browser | pass 1 — duration-10min.mp4 |
| 20:33:00 | 30m | observation | S-2 · The runtime fps gauge reads near-zero when idle and cannot be used as a health signal |
| 20:33:00 | 30m | observation | S-3 · Negative control holds |
| 20:52:00 | 49m | observation | S-4 · The API latency probe measured its own contention, not the platform |
| 21:03:08 | 60m | milestone | 1 h — 115 cycles, 0 failed ops |
| 21:05:00 | 62m | observation | S-5 · Now that 'Play from here' plays, the detection you seeked to is on screen for 0.5s before playback carries you past it |
| 21:35:00 | 92m | observation | S-6 · MinIO memory growth is cache warming, not a leak |
| 21:50:00 | 107m | observation | S-6-update · MinIO RSS is still climbing at 2h and has not plateaued |
| 21:50:00 | 107m | observation | S-7 · Mid-soak deployment verification green |
| 22:03:08 | 120m | milestone | 2 h — 228 cycles, 0 failed ops |
| 22:20:00 | 137m | observation | S-8 · Perception is deterministic across 277 analyses |
| 23:03:08 | 180m | milestone | 3 h — 340 cycles, 0 failed ops |
| 23:05:00 | 182m | browser | pass 2 — crowd.mp4 |
| 00:03:08 | 240m | milestone | 4 h — 449 cycles, 0 failed ops |
| 00:20:00 | 257m | observation | S-9 · One continuous appearance raises two incidents when the footage crosses a wall-clock minute |
| 01:03:09 | 300m | milestone | 5 h — 559 cycles, 0 failed ops |
| 01:06:00 | 303m | browser | pass 3 — export download through the UI button |
| 02:03:09 | 360m | milestone | 6 h — 671 cycles, 0 failed ops |
| 02:33:41 | 391m | phase | soak complete |

---

## What ran, continuously

Each cycle: upload → confirm → analyse → poll to a terminal state → timeline → report → playback URL →
**ranged fetch of that URL from the object store** → snapshot → events query. Every 4th cycle also
re-analysed an earlier recording; every 8th ran a parallel pair. 20 s between cycles, 60 s between
metric samples.

| | |
| --- | ---: |
| Cycles | **728** |
| Analyses that reached `succeeded` | **644** |
| Re-analysis runs of earlier recordings | **161** |
| Parallel uploads | **150** |
| Corrupt files correctly refused | **84** |
| Timed operations | **4 903** |
| Failed operations | **0** |
| Metric samples | **392** |
| Browser passes (manual, by the agent) | **3** |

## Related

- [SOAK_REPORT](SOAK_REPORT-2026-08-08.md) · [SOAK_METRICS](SOAK_METRICS-2026-08-08.md) · [SOAK_FINDINGS](SOAK_FINDINGS-2026-08-08.md)
- [SOAK_BASELINE](SOAK_BASELINE-2026-08-08.md) · [SOAK_REGRESSION_TESTS](SOAK_REGRESSION_TESTS-2026-08-08.md)
