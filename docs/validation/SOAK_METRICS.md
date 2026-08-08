# Release Soak — Metrics

> Generated from the run's own append-only JSONL streams by `node tools/validation/soak-report.mjs .soak`.
> Nothing below is retyped by hand. Regenerate it and you get this or you find out that you cannot.

**Run** 2026-08-07 20:03:02 UTC → 2026-08-08 02:33:41 UTC · **6.51 hours** · 392 metric samples · 728 cycles

## Operations

| Operation | OK | Failed | p50 ms | p95 ms | max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `upload+analyse` | 728 | 0 | 6133 | 33343 | 67214 |
| `timeline` | 644 | 0 | 20 | 25 | 86 |
| `report` | 644 | 0 | 20 | 25 | 110 |
| `playback` | 644 | 0 | 9 | 12 | 38 |
| `playback-fetch` | 644 | 0 | 3 | 5 | 14 |
| `snapshot` | 644 | 0 | 70 | 126 | 298 |
| `events-query` | 644 | 0 | 8 | 11 | 2639 |
| `re-analyse` | 161 | 0 | 6067 | 32752 | 64573 |
| `parallel-upload` | 150 | 0 | 8723 | 39372 | 96735 |

**4903 timed operations · 0 failed · 100 % success**

## Analyses by scene type

| Scene | Runs | Frames analysed | Detections | Detections / frame |
| --- | ---: | ---: | ---: | ---: |
| codec | 63 | 3780 | 3024 | 0.8 |
| crowded | 44 | 2640 | 15840 | 6 |
| angle | 42 | 2520 | 1512 | 0.6 |
| medium | 42 | 15120 | 9198 | 0.61 |
| large | 42 | 37800 | 22995 | 0.61 |
| one-person | 22 | 1320 | 1056 | 0.8 |
| multi-person | 22 | 1320 | 2552 | 1.93 |
| occlusion | 22 | 1320 | 682 | 0.52 |
| dwell | 22 | 2640 | 2618 | 0.99 |
| res-180p | 22 | 1320 | 1056 | 0.8 |
| res-360p | 22 | 1320 | 1056 | 0.8 |
| res-720p | 22 | 1320 | 1056 | 0.8 |
| res-1080p | 22 | 1320 | 1056 | 0.8 |
| night | 22 | 1320 | 1034 | 0.78 |
| weather | 22 | 1320 | 990 | 0.75 |
| blur | 22 | 1320 | 1056 | 0.8 |
| shake | 22 | 1320 | 990 | 0.75 |
| lighting | 21 | 1260 | 1008 | 0.8 |
| fast | 21 | 1260 | 1113 | 0.88 |
| partial | 21 | 1260 | 1260 | 1 |
| low-fps | 21 | 1260 | 1008 | 0.8 |
| high-fps | 21 | 1260 | 1029 | 0.82 |
| portrait-real | 21 | 798 | 504 | 0.63 |
| empty | 21 | 1260 | 0 | 0 |

**644 successful analyses · 87378 frames analysed · 73693 detections · 0 frames dropped**

**Expected refusals honoured:** 84

## Resource drift

| Container | Mem start | Mem end | Δ | Peak mem | Peak CPU % |
| --- | ---: | ---: | ---: | ---: | ---: |
| camera | 113.7 | 109.1 | -4.6 | 114.9 | 16.5 |
| console | 14.6 | 13.6 | -1 | 34.6 | 1.6 |
| events | 109.9 | 109.3 | -0.6 | 113.4 | 5.9 |
| evidence | 99 | 93.7 | -5.3 | 101.8 | 3 |
| gateway | 98.5 | 99.6 | +1.2 | 100.7 | 3.5 |
| identity | 94.8 | 95.3 | +0.5 | 97.1 | 5.8 |
| inference | 101.5 | 104.2 | +2.7 | 117.5 | 856 |
| media | 167.3 | 145.7 | -21.6 | 288.7 | 262.5 |
| minio | 251.6 | 521.2 | +269.6 | 604.1 | 11.6 |
| mongodb | 270.4 | 302.2 | +31.8 | 454.4 | 42.1 |
| nats | 79.8 | 104.2 | +24.4 | 141.3 | 3.9 |
| notify | 111.9 | 112.4 | +0.5 | 114.4 | 6.6 |
| proxy | 42.7 | 35 | -7.8 | 48.7 | 1.1 |
| redis | 1.5 | 2 | +0.5 | 3 | 2.5 |
| rules | 106.6 | 112.1 | +5.5 | 117.7 | 4.4 |
| tenant | 92.5 | 92.3 | -0.2 | 94.6 | 2.2 |
| workflow | 107.5 | 110.9 | +3.4 | 113.7 | 2.3 |

## Runtime and platform

| Series | Min | p50 | p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| API latency (ms) | 7 | 15 | 37 | 136 |
| Runtime fps | 0.3 | 19.7 | 22.4 | 24.1 |
| Inference p95 latency (ms) | 61.6 | 75.7 | 92.1 | 99.6 |
| Runtime queue depth | 0 | 0 | 0 | 0 |
| JetStream max consumer pending | 0 | 0 | 0 | 0 |
| Open fds — media | 37 | 42 | 43 | 50 |
| Open fds — gateway | 35 | 38 | 42 | 45 |
| Open fds — events | 35 | 40 | 40 | 41 |
| Open fds — workflow | 35 | 39 | 39 | 40 |
| Open fds — inference | 14 | 17 | 18 | 21 |

## Container restarts (⚠️ see S-10 — this section is generated from a metric that was broken for the whole run; the real counts are below)

⭐ **No container restarted.** Counts identical at first and last sample across 0 containers.

⭐ **Every container reported `healthy` at the final sample.**

## Disk

Start **297 GB** free → end **296.3 GB** free (min 296.3 GB). Δ **-0.7 GB**.

## Findings

**0**

## Duration

**6.51 hours** · 392 metric samples · 728 cycles

---

## Container restarts — measured directly after the run

⛔ The generated section above is worthless: `restartCounts()` returned `{}` in all 392 samples (S-10).
These come from `docker inspect` after the soak and are compared against [SOAK_BASELINE](SOAK_BASELINE.md).

| Container | Restarts at baseline | Restarts after 6.51 h | Health |
| --- | ---: | ---: | --- |
| media | 0 | 0 | healthy |
| gateway | 0 | 0 | healthy |
| inference | 0 | 0 | healthy |
| events | 0 | 0 | healthy |
| rules | 0 | 0 | healthy |
| workflow | 0 | 0 | healthy |
| identity | 0 | 0 | healthy |
| tenant | 0 | 0 | healthy |
| camera | 0 | 0 | healthy |
| notify | 0 | 0 | healthy |
| evidence | 0 | 0 | healthy |
| console | 0 | 0 | healthy |
| redis | 0 | 0 | healthy |
| nats | 0 | 0 | healthy |
| proxy | 0 | 0 | none (no healthcheck) |
| mongodb | 9 | 9 | healthy |
| minio | 13 | 13 | healthy |

⭐ **Every count is identical to baseline. No container restarted during the soak.**
