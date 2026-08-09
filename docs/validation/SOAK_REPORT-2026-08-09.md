## Run continuity

✅ continuous — 391 samples over 23380.6 s, no gap beyond 180 s.

## Operations

| Operation | OK | Failed | p50 ms | p95 ms | max ms | first ¼ med | last ¼ med | drift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `upload+analyse` | 656 | 0 | 6144 | 36501 | 96749 | 6130 | 3158 | -48 % |
| `timeline` | 580 | 0 | 23 | 37 | 9583 | 21 | 23 | +10 % |
| `report` | 580 | 0 | 21 | 32 | 78 | 21 | 21 | +0 % |
| `playback` | 580 | 0 | 9 | 14 | 80 | 9 | 9 | +0 % |
| `playback-fetch` | 580 | 0 | 3 | 6 | 23 | 3 | 3 | +0 % |
| `snapshot` | 580 | 0 | 72 | 135 | 9942 | 72 | 67 | -7 % |
| `events-query` | 580 | 0 | 8 | 14 | 60 | 8 | 8 | +0 % |
| `invariants` | 580 | 0 | 20 | 31 | 84 | 20 | 19 | -5 % |
| `behaviour-primitives` | 580 | 0 | 82 | 131 | 10225 | 62 | 86 | +39 % |
| `behaviour-timeline` | 580 | 0 | 71 | 86 | 8784 | 57 | 79 | +39 % |
| `re-analyse` | 145 | 0 | 6070 | 32607 | 92482 | 6067 | 3081 | -49 % |
| `parallel-upload` | 134 | 0 | 6233 | 47867 | 114473 | 6233 | 6195 | -1 % |
| `live-burst` | 116 | 0 | 10194 | 20647 | 23419 | 10189 | 10194 | +0 % |

⭐ **No operation grew materially over the run** — every median in the last quarter is within 50 % of the first.

**6271 timed operations · 0 failed · 100 % success**

## Analyses by scene type

| Scene | Runs | Frames analysed | Detections | Detections / frame |
| --- | ---: | ---: | ---: | ---: |
| codec | 57 | 3420 | 2736 | 0.8 |
| crowded | 40 | 2400 | 14400 | 6 |
| angle | 38 | 2280 | 1368 | 0.6 |
| medium | 38 | 13680 | 8322 | 0.61 |
| large | 38 | 34200 | 20805 | 0.61 |
| one-person | 20 | 1200 | 960 | 0.8 |
| multi-person | 20 | 1200 | 2320 | 1.93 |
| occlusion | 20 | 1200 | 620 | 0.52 |
| dwell | 20 | 2400 | 2380 | 0.99 |
| res-180p | 20 | 1200 | 960 | 0.8 |
| res-360p | 20 | 1200 | 960 | 0.8 |
| res-720p | 20 | 1200 | 960 | 0.8 |
| res-1080p | 20 | 1200 | 960 | 0.8 |
| night | 19 | 1140 | 893 | 0.78 |
| weather | 19 | 1140 | 855 | 0.75 |
| blur | 19 | 1140 | 912 | 0.8 |
| shake | 19 | 1140 | 855 | 0.75 |
| lighting | 19 | 1140 | 912 | 0.8 |
| fast | 19 | 1140 | 1007 | 0.88 |
| partial | 19 | 1140 | 1140 | 1 |
| low-fps | 19 | 1140 | 912 | 0.8 |
| high-fps | 19 | 1140 | 931 | 0.82 |
| portrait-real | 19 | 722 | 456 | 0.63 |
| empty | 19 | 1140 | 0 | 0 |

**580 successful analyses · 78902 frames analysed · 66624 detections · 0 frames dropped**

**Expected refusals honoured:** 76

## Resource drift

| Container | Mem start | Mem end | Δ | Peak mem | Peak CPU % |
| --- | ---: | ---: | ---: | ---: | ---: |
| camera | 108.6 | 108.8 | +0.2 | 109.6 | 13.7 |
| console | 21.2 | 16.4 | -4.8 | 37.7 | 2.5 |
| events | 111.3 | 113.6 | +2.3 | 114.3 | 6.6 |
| evidence | 110 | 107.5 | -2.5 | 110.8 | 4.3 |
| gateway | 95.2 | 135 | +39.8 | 141.5 | 30.6 |
| identity | 104.1 | 103.5 | -0.6 | 106.4 | 4.1 |
| inference | 118.4 | 156.9 | +38.5 | 226.5 | 867.2 |
| media | 119.3 | 164.8 | +45.5 | 226.6 | 97.1 |
| minio | 216.5 | 348.1 | +131.6 | 615.1 | 15.9 |
| mongodb | 274.3 | 294.8 | +20.5 | 454.1 | 56.9 |
| nats | 38.3 | 60.8 | +22.5 | 138.4 | 2.9 |
| notify | 119.9 | 123.9 | +4 | 125.4 | 29.4 |
| proxy | 38.3 | 43.4 | +5.1 | 51.4 | 12.3 |
| redis | 2.3 | 1.7 | -0.6 | 2.9 | 2.7 |
| rules | 108.5 | 108.5 | +0 | 110.2 | 3.8 |
| tenant | 101.1 | 103 | +1.9 | 107.6 | 3.9 |
| workflow | 99.4 | 109 | +9.6 | 116.2 | 3.4 |

## Runtime and platform

| Series | Min | p50 | p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| API latency (ms) | 6 | 19 | 41 | 144 |
| Runtime fps | 1.2 | 18.4 | 24.4 | 26.7 |
| Inference p95 latency (ms) | 55.2 | 76.9 | 121.1 | 260.4 |
| Runtime queue depth | 0 | 0 | 0 | 0 |
| JetStream max consumer pending | 0 | 0 | 0 | 0 |
| Open fds — media | 39 | 46 | 47 | 56 |
| Open fds — gateway | 32 | 39 | 45 | 53 |
| Open fds — events | 34 | 40 | 40 | 41 |
| Open fds — workflow | 36 | 42 | 42 | 48 |
| Open fds — inference | 14 | 17 | 18 | 20 |

## Container restarts

⭐ **No container restarted.** Counts identical at first and last sample across 18 containers.

⛔ **Unhealthy at final sample:** createbuckets, proxy

## Disk

Start **287.3 GB** free → end **287.2 GB** free (min 284.8 GB). Δ **-0.1 GB**.

## Findings

**0**

## Duration

**6.49 hours** · 391 metric samples · 656 cycles

## Shape of the run

FPS and CPU follow whichever fixture is being analysed, so no trend verdict is offered for them.

| Series | Min | p50 | Max | Final | Trend | Shape (start → end) |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Runtime fps | 1.15 | 18.43 | 26.67 | 18.52 | — | `▂▇▆▄▅▅▄▆▆▆▃▅▁▄▇▆▄▄▄▆▂▄▄▄▅▆▄▂▄▄▄▃▄▃▃▄▄▇▆▅▅▇▅▄▆▅▅▆▇██▅▅▅▄▅` |
| Inference latency avg | 41.42 ms | 46.74 ms | 58.67 ms | 46.13 ms | stable | `▆▁▁▁▁▁▁▁▁▁▁▂▂▃▄▄▄▄▅▅▅▆▆▇▇▇▇▇▇▇████████████▇▇▇▇▆▆▆▆▆▅▅▅▅▅` |
| Inference latency p95 | 55.2 ms | 76.88 ms | 260.38 ms | 82.04 ms | stable | `▃▂▂▁▂▂▂▂▃▂▂▅█▅▃▂▄▃▆▃▇▆▃▄▄▃▃▃▇▄▅▆▄▄▄▅▅▃▁▁▁▁▁▁▁▁▂▁▁▁▁▂▁▃▃▁` |
| Inference queue depth | 0 | 0 | 0 | 0 | stable | `▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ (flat)` |
| Media deliver avg | 42.33 ms | 52.85 ms | 97.51 ms | 50.52 ms | stable | `▃▁▂▁▂▂▂▂▂▂▄▅▇▄▃▃▅▄▅▃▆▅▃▄▃▄▃▄█▅▄▅▄▄▄▆▆▃▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂▃▃▁` |
| Media frame age avg | 63.33 ms | 70 ms | 106 ms | 65.14 ms | stable | `▂▁▁▁▁▁▁▁▁▁▂▇█▄▄▂▂▂▂▂▂▂▃▃▃▃▃▃▃▄▃▃▄▅▃▄▅▄▃▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂▁` |
| Media queue depth | 0 | 0 | 0 | 0 | stable | `▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ (flat)` |
| Media inflight | 0 | 0 | 0 | 0 | stable | `▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ (flat)` |
| Gateway API round-trip | 6 ms | 19 ms | 144 ms | 19 ms | stable | `▂▂▁▁▂▂▂▁▁▁▃▄▁▃▄▄▃█▄▇▂▇▂▇▃▆▃▆▂▂▆▂▇▃█▄▂▄▇▃▆▂█▃▄▃▁▁▃█▂▇▄▅▂▃` |
| Identity fragmentation | 1.45 | 150.44 | 2178 | 76.93 | unbounded | `▁▁▁▁▁▁▁▁▁▁▂▁▁▁▁▁▃▁▁▁▁▃▄▁▂▃▁▂▃▁▂▁▁▂▄▂▂▄▁▂▃▂▄▅▂▅▄▃▃▃▂█▂▄▆▁` |

### Memory — plateau versus slope

| Series | Min | p50 | Max | Final | Trend | Shape (start → end) |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| inference | 106.6 MB | 161.7 MB | 226.5 MB | 156.9 MB | plateau | `▁▁▂▂▂▂▂▂▂▂▃▇▇▇▆▆▇▆▇▇▇▇▇▇▇▇▇█▇▇██▇█▇▇█▇▇█▇▇██▇███▇█▇▇▇▇▇▇` |
| media | 116.7 MB | 166.4 MB | 226.6 MB | 164.8 MB | stable | `▁▄█▆▄▃▂▄▆▅▄▅▅▅▇▄▂▅▄▅▄▇▅▄▂▆▇▄▆▅▁██▃▄▄▂▆▆▅▆▄▄▂▄█▅▂▂▆▄▄▃▅█▅` |
| gateway | 95.04 MB | 132.8 MB | 141.5 MB | 135 MB | plateau | `▁▃▃▃▄▄▄▄▄▄▄▄██▅▅▅▅▆▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇██████▇██▇████▇` |
| notify | 103.7 MB | 120 MB | 125.4 MB | 123.9 MB | stable | `▄▃▃▄▃▃▃▄▃▃▄▃█▃▁▄▅▅▅▆▆▆▆▇▆▆▆▇▅▆▆▇▆▆▇▇▆▆▆▇▇▆▆▇█▆▆▇▆▆▆▇▆▆▆█` |
| evidence | 107 MB | 108.2 MB | 110.8 MB | 107.5 MB | stable | `█▆▆▆▆▅▆▆▅▆▄▄▆▆▄▅▅▅▅▄▆███▇▄▁▂▁▃▁▂▃▃▃▃▃▂▃▄▅▄▄▆▅▅▂▃▁▂▁▁▁▃▁▁` |
| tenant | 100.8 MB | 101.6 MB | 107.6 MB | 103 MB | stable | `▁▂▂▁▁▁▁▁▁▁▁▁▂▁▁▁▁▁▁▁█▇▄▃▃▂▂▂▂▂▂▂▂▂▂▂▂▂▂▃▃▃▃▄▄▃▄▄▄▄▄▄▄▅▅▅` |
| identity | 102.3 MB | 103.4 MB | 106.4 MB | 103.5 MB | stable | `▇▅▃▁▆▇▅▄▅▃▁▁▂▃▂▄▂▆▃▆▄▅▄▅▄▆█▅▇▅▆▁▅▂▅▃▄▃▆▅▂▃▁▃▂▃▃▅▄▅▄▄▆▇▅▃` |
| camera | 107.3 MB | 108.2 MB | 109.6 MB | 108.8 MB | stable | `█▅▁▄▂▂▅▃▃▅▂▅▄▆▅▃▄▃▅▂▃▄▁▃▄▃▅▂▄▅▅▇▅▆█▅▆▆▅█▆▅▇▅▆▇▅█▅▅█▅▆█▅▇` |
| events | 111.3 MB | 113 MB | 114.3 MB | 113.6 MB | stable | `▂▁▂▃▃▂▄▃▄▅▄▃▃▄▆█▆▅▅▅█▆▆▇▇▆█▇▆▆▇▇▆▇▆▇▇▆▆▆▆▇▇▆▇▇█▆▆▆▆▇████` |
| rules | 107.7 MB | 108.3 MB | 110.2 MB | 108.5 MB | stable | `▆▅▅▃▂▂▃▄▅▃▂▁▃▄▆▄▂▄▃▃▄▂▁▁▁▃▃▇▅▂▁▄▅▇▃▁▁▁▄▅▃▅▅▄▅▇▆▆▆▇▇▆▇█▅▆` |
| console | 15.31 MB | 16.46 MB | 37.68 MB | 16.37 MB | stable | `▂▁▁▁▁▁▁▁▁▁▁▁█▁▁▁▁▁▁▁▆▃▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁` |
| workflow | 98.71 MB | 108 MB | 116.2 MB | 109 MB | stable | `▁▁▁▁▁▁▁▂▄▄▄▄▄▄▅▅▅▅▅▅▆█▇▇▇▇▇▇▇▇▇▇▇▇████▃▂▃▃▄▅▅▅▆▆▆▆▆▆▆▆▆▆` |
| proxy | 29.25 MB | 39.21 MB | 51.42 MB | 43.43 MB | stable | `▄▂▁▂▃▂▂▂▄▅▂▄▆▆▆▆▅▆▅▅█▂▂▂▂▂▄▃▁▁▃▂▃▃▃▂▂▃▂▃▂▂▄▁▁▂▁▂▂▁▂▂▄▃▁▄` |
| redis | 1.46 MB | 1.79 MB | 2.94 MB | 1.69 MB | stable | `▅▅▃▃▁▂▃▄▃▄▁▃▃▅▂▃▃▄▂█▅▃▆▂▂▃▂▂▄▆▃▂▂▅▄▁▆▃▃▄▄▄▃▄▆▃▃▄▂▄▄▄▁▄▅▇` |
| nats | 38.34 MB | 84.82 MB | 138.4 MB | 60.83 MB | stable | `▂▆▄▅▃▅▄▄▃▄▄▆█▄▆▅▁▃▆▃▄▃▅▆▆▄▆▄▅▆▅▄▆▄▃▄▅▃▄▃▄▅▅▃▄▃▄▄▆▅▄▂▄▂▁▂` |
| mongodb | 232.2 MB | 277.4 MB | 454.1 MB | 294.8 MB | stable | `▄▂▄▂▁▃▁▁▁▁▁▁▁▁▂▁▃▂▂▂▃▆▄▄▄▅▄▅▄▅▆█▅█▅▄▅▄▄▅▇▅▅▆▅▅▄▄▅▅▅▄▅▄▅▆` |
| minio | 201.1 MB | 315.8 MB | 615.1 MB | 348.1 MB | stable | `▆▇▆████▇▆▅▇▂▄▂▅▄▇▄▅▆▄▃▆▃▄▄▂▆▂▅▅▂▁▂▅▂▄▅▁▄▂▁▂▂▂▄▇▂▂▁▁▃▁▄▂▂` |
| inference self-reported | 369.65 MB | 369.65 MB | 369.65 MB | 369.65 MB | stable | `▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ (flat)` |

⭐ **No container shows linear growth after warm-up** (first 10 min excluded).

⚠️ Rose over the run but without a linear shape, so reported rather than flagged: **redis** (+5.5 %, but R²=0.011 — a band, not a line)

### Inference memory beside the structures it holds

| Elapsed min | Container RSS MB | Runtime self-reported MB | Records on disk | Live identities | Live streams | Pending writes | Retired |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.3 | 118.4 | 369.6 | 2745 | 2 | 1 | 0 | 0 |
| 32.5 | 120.7 | 369.6 | 2906 | 18 | 14 | 0 | 161 |
| 64.5 | 121.3 | 369.6 | 3093 | 21 | 16 | 0 | 348 |
| 96.5 | 157.5 | 369.6 | 3278 | 8 | 3 | 0 | 533 |
| 128.5 | 161.7 | 369.6 | 3439 | 21 | 16 | 0 | 694 |
| 160.5 | 162.2 | 369.6 | 3632 | 5 | 2 | 0 | 887 |
| 192.5 | 163.4 | 369.6 | 3796 | 19 | 15 | 0 | 1051 |
| 224.5 | 173.2 | 369.6 | 3959 | 32 | 8 | 0 | 1214 |
| 256.5 | 162.1 | 369.6 | 4133 | 17 | 14 | 0 | 1388 |
| 288.5 | 159.2 | 369.6 | 4302 | 24 | 10 | 0 | 1557 |
| 320.5 | 160.4 | 369.6 | 4496 | 8 | 6 | 0 | 1751 |
| 352.5 | 164.2 | 369.6 | 4657 | 22 | 16 | 0 | 1912 |
| 384.5 | 158.3 | 369.6 | 4844 | 5 | 3 | 0 | 2099 |
| 390 | 156.9 | 369.6 | 4851 | 42 | 17 | 0 | 2106 |

Bounds in force: **72 h retention · 4096 records per tenant · 512 points per record**. "Records on disk" is the durable store; the three live columns are the in-memory structures, published only from attempt 2 onward — attempt 1 could not attribute its own memory growth because they did not exist as metrics.


### CPU

| Series | Min | p50 | Max | Final | Trend | Shape (start → end) |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| inference | 0.01 % | 0.03 % | 867.24 % | 0.03 % | — | `▂▄▂▅▂▂▂▅▁▂▇▁▅▃▁▂▃▂▂▂▃▅█▁▁▄▂▂▅▂▁▅▃▂▆▁▁▅▂▂▆▁▅▄▂█▃▂▅▁▁▅▂▁█▁` |
| media | 0.28 % | 0.91 % | 97.09 % | 0.62 % | — | `▁▃▄▁▁▁▂▂▁▃▇▁▄█▁▁▁▃▄▁▃▃▂▁▁▄▁▁▂▁▁▃▂▁▃▁▁▁▁▂▇▁▂▂▁▃▅▁▂▁▁▃▁▁▅▁` |
| gateway | 0.17 % | 0.34 % | 30.65 % | 0.47 % | — | `▁▁▁▁▁▁▁▁▂▁▁▁█▁▁▂▂▁▂▁▂▂▁▁▁▁▁▁▁▁▁▁▂▂▁▁▁▁▁▁▁▁▁▁▂▂▁▁▁▁▁▁▁▁▁▁` |
| notify | 0.22 % | 0.49 % | 29.45 % | 0.52 % | — | `▁▁▁▁▁▁▁▁▃▁▁▁█▁▁▂▂▁▂▂▂▁▁▁▁▁▁▁▁▁▁▂▂▁▁▁▁▁▁▁▂▂▂▁▁▁▁▁▁▁▁▁▁▁▂▁` |
| evidence | 0.21 % | 0.47 % | 4.29 % | 0.7 % | — | `▂▁▂▁▁▁▁▁▇▃▁▂▁▁▁▁▃▃▃▁▃▇▂▂▂▂▂▃▂▂▂▂▄█▁▄▃▁▁▁▁▁▁▁▆▄▂▁▁▁▁▁▂▃▁▂` |
| tenant | 0.2 % | 0.47 % | 3.86 % | 0.6 % | — | `▃▃▁▁▁▁▁▁▇▃▁▂▂▃▂▂▂▂▂▆█▂▂▂▃▂▂▂▃▂▅▇▂▂▃▃▃▂▂▂▂▄▅▁▁▁▁▁▁▁▂▁▂▆▅▃` |
| identity | 0.19 % | 0.46 % | 4.14 % | 0.49 % | — | `▂▁▁▁▁▁▁▁█▂▁▂▂▂▂▂▃▃▂▂▃▇▁▂▃▃▃▃▄▃▅▂▄█▂▃▂▁▁▁▁▁▂▁▅▃▁▁▁▂▁▁▂▂▁▂` |
| camera | 0.24 % | 0.56 % | 13.67 % | 0.59 % | — | `▂▁▁▁▁▁▁▁▃▂▁▁▂▂▁▁▁▂▁▃▃▁▁▁▁▁▁▁▁▁▃▃▁▁▁▂▁▂▂▃▃▄█▄▃▃▄▃▂▁▁▁▁▁▂▁` |
| events | 0.24 % | 0.55 % | 6.58 % | 0.47 % | — | `▃▁▃▃▂▃▃▂▆▄▇▁▆▄▁▂▄▃▃▃▆▂▂▁▁▄▃▂▅▃▃█▇▃▆▂▁▄▃▂▄▄▅▂▂▃▇▂▃▁▁▁▁▂█▁` |
| rules | 0.22 % | 0.49 % | 3.78 % | 0.82 % | — | `▂▁▁▁▁▁▁▂▇▄▁▂▂▂▂▂▂▂▂▅▆▂▁▂▁▂▂▂▃▂▄█▄▂▂▃▂▂▁▁▂▅▅▂▁▁▂▁▁▁▁▁▁▄▇▃` |
| console | 0 % | 0 % | 2.54 % | 0 % | — | `▂▁▁▁▁▁▁▁█▂▁▁▁▁▁▁▁▁▁▁▄▇▁▁▁▁▁▁▁▁▁▁▂▆▁▁▁▁▁▁▁▁▁▁▄▄▁▁▁▁▁▁▁▁▁▁` |
| workflow | 0.22 % | 0.5 % | 3.38 % | 0.73 % | — | `▂▁▂▁▁▂▁▂▇▃▂▃▂▂▂▃▄▄▃▅█▂▁▁▂▂▅▃▃▃▄█▂▃▂▃▃▂▂▁▄▇▇▂▂▁▂▂▁▂▂▁▂▄▇▃` |
| proxy | 0 % | 0 % | 12.25 % | 0 % | — | `▁▁▁▁▁▁▁▁▁▁▁▁█▁▁▂▂▁▂▁▃▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁` |
| redis | 0.31 % | 0.64 % | 2.74 % | 0.73 % | — | `█▄▂▁▂▃█▂▂▃▂▄▄▅▂▃▂▃▅▂▂▁▁▅▃▁▂▁▁▇▃▁▁▁▃▁▁▁▁▃▂▂▁▁▂▄▃▃▂▂▂▃▄▂▁▃` |
| nats | 0.1 % | 0.34 % | 2.89 % | 0.33 % | — | `█▄▃▃▂▃▇▄▁▂▅▁█▆▁▂▅▂█▁▃▂▂▄▂▄▃▁▅▇▂▄▅▂▇▁▁▃▂▄▆▁▂▂▂▇▆▂▂▁▁▃▃▂▆▂` |
| mongodb | 0.4 % | 1.18 % | 56.93 % | 1.35 % | — | `▃▄▃▂▄▅▁▄▃▄▁▁▄█▁▄█▁▅▇▁▄▁▄▄▃▁▅▁▂▃▄▄▇▂▆▄▂▄▁▄▄▇▃▁▁▂▁▂▇▄▃▁▅▁▃` |
| minio | 0 % | 0.5 % | 15.95 % | 0.11 % | — | `▁▁▂▁▂▁▁▁▂▂▂▃▂██▄▁▁▁▂▁▁▂▄▄▇██▇▃▂▂▃▅▇█▃▂▁▂▂▇▆▃▁▂▃▄▆▇▃▁▁▂▂▂` |

## Storage and log growth

| Store | Start | End | Δ | Per hour | Counter resets |
| --- | ---: | ---: | ---: | ---: | ---: |
| mongodb /data (KB) | 369080 | 392892 | +23812 | 3666.4 | 112 |
| redis /data (KB) | 20 | 20 | +0 | 0 | 0 |
| minio /data (KB) | 12718792 | 13697676 | +978884 | 150722.8 | 45 |
| JetStream messages | 646743 | 770834 | +124091 | 19106.8 | 0 |
| JetStream bytes | 974626691 | 1248403405 | +273776714 | 42154518.7 | 0 |

| Container log | Start B | End B | Δ B | B / hour |
| --- | ---: | ---: | ---: | ---: |
| media | 3168 | 19758 | +16590 | 2554.4 |
| inference | 2322 | 2684 | +362 | 55.7 |
| events | 1802 | 46101 | +44299 | 6820.9 |
| gateway | 6021 | 19402 | +13381 | 2060.3 |
| workflow | 1801 | 5506 | +3705 | 570.5 |
| rules | 1799 | 6255 | +4456 | 686.1 |

## Evidence and incidents

| | |
| --- | ---: |
| Analyses cross-checked | 580 |
| Events produced | 7536 |
| Incidents produced | 1747 |
| **Invariant problems** | **0** |
| Samples with orphan sessions | 0 |

Invariants re-checked on every analysis: no duplicate incident, no event present in the analysis but missing from the events store, no timeline corruption, identity continuity across the run.

**Live ingest:** 116 burst(s) · 4640 frames accepted · 0 refused — through the same runtime as the recorded path.


## Behaviour, track history and scene observation

| Counter | Start | End | Δ | Per hour | Resets |
| --- | ---: | ---: | ---: | ---: | ---: |
| runtime frames processed | 38 | 121832 | +121794 | 18753.1 | 0 |
| runtime frames dropped | 0 | 0 | +0 | 0 | 0 |
| media frames offered | 140000 | 261852 | +121852 | 18762.1 | 0 |
| media frames delivered | 140000 | 261794 | +121794 | 18753.1 | 0 |
| media frames dropped | 0 | 0 | +0 | 0 | 0 |
| media frames failed | 0 | 0 | +0 | 0 | 0 |
| zone echoes sent | 139991 | 261777 | +121786 | 18751.9 | 0 |
| zone echoes dropped | 2 | 9 | +7 | 1.1 | 0 |
| zone annotations applied | 23 | 105282 | +105259 | 16207.2 | 0 |
| zone annotations missed | 0 | 716 | +716 | 110.2 | 0 |
| scene observations | 100 | 309052 | +308952 | 47570.6 | 0 |
| scene observations dropped | 0 | 0 | +0 | 0 | 0 |
| behaviour streams tracked | 1 | 256 | +255 | 39.3 | 0 |
| behaviour streams evicted | 0 | 605 | +605 | 93.2 | 0 |
| behaviour module failures | 0 | 0 | +0 | 0 | 0 |
| history points | 24 | 106001 | +105977 | 16317.7 | 0 |
| history live identities | 2 | 42 | +40 | 6.2 | 183 |
| history live streams | 1 | 17 | +16 | 2.5 | 155 |
| history pending writes | 0 | 0 | +0 | 0 | 0 |
| history write failures | 0 | 0 | +0 | 0 | 0 |
| history undated dropped | 0 | 0 | +0 | 0 | 0 |
| tracks created | 5 | 2231 | +2226 | 342.7 | 0 |
| occlusions | 4 | 2209 | +2205 | 339.5 | 0 |
| frames out of order | 0 | 1 | +1 | 0.2 | 0 |

**Zone-echo miss rate 0.68 %** (716 of 105975). ADR-0053 accepts a bounded tail: the echo describes the *previous* frame, so the final frames of a stream are never answered. What matters is that the tail is counted and published rather than silently absorbed — an unanswered frame must not read as "in no zone".


## Post-soak verification

### Deployment verification — **PASS**

```
PASS  Deployment verification
command: node tools/validation/verify-deployment.mjs
duration: 1s


VIP deployment verification

containers
  ✓ proxy      — Up 28 hours
  ✓ console    — Up 15 hours (healthy)
  ✓ gateway    — Up 15 hours (healthy)
  ✓ identity   — Up 15 hours (healthy)
  ✓ tenant     — Up 15 hours (healthy)
  ✓ camera     — Up 15 hours (healthy)
  ✓ media      — Up 15 hours (healthy)
  ✓ events     — Up 15 hours (healthy)
  ✓ inference  — Up 7 hours (healthy)
  ✓ rules      — Up 15 hours (healthy)
  ✓ workflow   — Up 15 hours (healthy)
  ✓ notify     — Up 15 hours (healthy)
  ✓ evidence   — Up 15 hours (healthy)
  ✓ mongodb    — Up 16 hours (healthy)
  ✓ nats       — Up 2 days (healthy)
  ✓ minio      — Up 16 hours (healthy)
  ✓ redis      — Up 5 days (healthy)

edge (TLS, headers, the single origin)
(node:39767) Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.
(Use `node --trace-warnings ...` to show where the warning was created)
  ✓ console served over HTTPS — HTTP 200
  ✓ HSTS present — max-age=63072000; includeSubDomains
  ✓ CSP locks the origin down — default-src 'self'; script-src 'self'; style-src 'self' 'uns
  ✓ no version banner — absent
  ✓ plaintext redirects to HTTPS — HTTP 308

gateway and identity
  ✓ unauthenticated API call refused — HTTP 401
  ✓ login issues a token — HTTP 200

services (reached through the gateway, with a real token)
  ✓ camera     — HTTP 200
  ✓ media      — HTTP 200
  ✓ events     — HTTP 200
  ✓ workflow   — HTTP 200
  ✓ rules      — HTTP 200
  ✓ evidence   — HTTP 200
  ✓ tenant     — HTTP 403
  ✓ notify     — HTTP 200

AI runtime (a real frame, not a health endpoint)
  ✓ inference reports healthy — ok
  ✓ frame probe — ⓘ not measured here — `tools/dataset/generate.mjs --verify` is the real measurement

object storage
  ✓ MinIO has buckets — vip-recordings
  ✓ object storage reachable through the edge — HTTP 200

console
  ✓ index.html references a hashed entry bundle — /assets/index-CprEEimd.js
  ✓ entry bundle downloads — HTTP 200 text/javascript; charset=utf-8

messaging
  ✓ JetStream has streams — 5 stream(s), 770834 message(s)

─────────────────────────────────────────
  ✓ containers   17/17
  ✓ edge         5/5
  ✓ gateway      2/2
  ✓ services     8/8
  ✓ runtime      2/2
  ✓ storage      2/2
  ✓ console      2/2
  ✓ messaging    1/1
─────────────────────────────────────────

✓ the deployment is online
```

### Browser certification — **FAIL**

```
FAIL  Browser certification (exit 1)
command: pnpm --filter @vip/e2e-browser certify
duration: 677s

  ✓   85 [firefox] › test/journey.spec.ts:27:3 › the investigation journey › signs in, uploads a recording, and analyses it end to end (8.8s)
  ✓   86 [firefox] › test/journey.spec.ts:172:3 › the investigation journey › an empty recording produces no events, and says so rather than rendering blank (6.5s)
  ✓   87 [firefox] › test/journey.spec.ts:201:3 › the investigation journey › demonstration mode paces the same pipeline at real time (12.2s)
  ✓   88 [firefox] › test/journey.spec.ts:229:3 › the investigation journey › survives a refresh and a direct deep link (3.6s)
  ✓   89 [firefox] › test/performance.spec.ts:27:3 › declared limits › refuses a file larger than the stated ceiling before any bytes move (80ms)
  ✓   90 [firefox] › test/performance.spec.ts:45:3 › declared limits › states the limits on the upload form (1.0s)
  ✓   91 [firefox] › test/performance.spec.ts:55:3 › declared limits › accepts only mp4 in the file picker (1.5s)
  ✓   92 [firefox] › test/performance.spec.ts:74:3 › large recordings › uploads a 30-minute recording and starts analysing it (2.2s)
  ✓   93 [firefox] › test/performance.spec.ts:120:3 › multiple uploads › keeps three uploads separate and independently queryable (6.0s)
  ✓   94 [firefox] › test/performance.spec.ts:159:3 › live isolation › offline incidents never appear in the live queue (131ms)
  ✓   95 [firefox] › test/performance.spec.ts:171:3 › live isolation › offline events never appear in an unfiltered event read (95ms)
  ✘   96 [firefox] › test/security.spec.ts:17:3 › the edge › serves the console over HTTPS with the security headers that were specified (13ms)
  ✓   97 [firefox] › test/security.spec.ts:39:3 › the edge › redirects plaintext to HTTPS rather than refusing it (25ms)
  ✓   98 [firefox] › test/security.spec.ts:47:3 › authorisation › refuses an unauthenticated read of customer data (30ms)
  ✓   99 [firefox] › test/security.spec.ts:54:3 › authorisation › refuses a cross-tenant read (96ms)
  ✓  100 [firefox] › test/security.spec.ts:73:3 › authorisation › hides the upload control from a viewer (1.5s)
  ✓  101 [firefox] › test/security.spec.ts:93:3 › error paths › ⛔ never returns a signed url in an error message (131ms)
  ✓  102 [firefox] › test/security.spec.ts:129:3 › error paths › refuses each kind of unusable upload with a reason (184ms)
  ✓  103 [firefox] › test/security.spec.ts:162:3 › error paths › renders a real page for an analysis that does not exist (737ms)
  ✓  104 [firefox] › test/security.spec.ts:180:3 › object storage › is reachable through the edge, not on a second origin (6ms)
  ✓  105 [firefox] › test/surface.spec.ts:67:3 › the recording is on the page › plays the uploaded recording, and the browser really decoded it (7.2s)
  ✓  106 [firefox] › test/surface.spec.ts:86:3 › the recording is on the page › seeks to the exact footage offset a timeline row names (8.0s)
  ✓  107 [firefox] › test/surface.spec.ts:131:3 › the overlay draws what is stored, and nothing else › every drawn box matches the stored bbox for that frame (7.3s)
  ✓  108 [firefox] › test/surface.spec.ts:188:3 › the overlay draws what is stored, and nothing else › draws no box at an instant with no analysed frame (7.1s)
  ✓  109 [firefox] › test/surface.spec.ts:229:3 › the overlay draws what is stored, and nothing else › turns the overlay off and on (7.2s)
  ✓  110 [firefox] › test/surface.spec.ts:242:3 › the lanes agree with the payload › renders incidents, events, tracks and density with the payload’s own counts (7.4s)
  ✓  111 [firefox] › test/surface.spec.ts:271:3 › the lanes agree with the payload › every offset is exactly its distance from the footage start (7.3s)
  ✓  112 [firefox] › test/surface.spec.ts:290:3 › the lanes agree with the payload › reports confidences inside [0, 1] (8.0s)
  ✓  113 [firefox] › test/surface.spec.ts:311:3 › the lanes agree with the payload › every event’s track appears
```

### Repository gate — **PASS**

```
PASS  Repository gate (turbo lint typecheck test)
command: pnpm turbo lint typecheck test
duration: 1s

@vip/console:test: 
@vip/console:test: This ensures that you're testing the behavior the user would see in the browser. Learn more at https://react.dev/link/wrap-tests-with-act
@vip/console:test: An update to ForwardRef(SelectItemText) inside a test was not wrapped in act(...).
@vip/console:test: 
@vip/console:test: When testing, code that causes React state updates should be wrapped into act(...):
@vip/console:test: 
@vip/console:test: act(() => {
@vip/console:test:   /* fire events that update state */
@vip/console:test: });
@vip/console:test: /* assert on the output */
@vip/console:test: 
@vip/console:test: This ensures that you're testing the behavior the user would see in the browser. Learn more at https://react.dev/link/wrap-tests-with-act
@vip/console:test: An update to ForwardRef(SelectItem) inside a test was not wrapped in act(...).
@vip/console:test: 
@vip/console:test: When testing, code that causes React state updates should be wrapped into act(...):
@vip/console:test: 
@vip/console:test: act(() => {
@vip/console:test:   /* fire events that update state */
@vip/console:test: });
@vip/console:test: /* assert on the output */
@vip/console:test: 
@vip/console:test: This ensures that you're testing the behavior the user would see in the browser. Learn more at https://react.dev/link/wrap-tests-with-act
@vip/console:test: An update to SelectProvider inside a test was not wrapped in act(...).
@vip/console:test: 
@vip/console:test: When testing, code that causes React state updates should be wrapped into act(...):
@vip/console:test: 
@vip/console:test: act(() => {
@vip/console:test:   /* fire events that update state */
@vip/console:test: });
@vip/console:test: /* assert on the output */
@vip/console:test: 
@vip/console:test: This ensures that you're testing the behavior the user would see in the browser. Learn more at https://react.dev/link/wrap-tests-with-act
@vip/console:test: An update to ForwardRef(SelectItemText) inside a test was not wrapped in act(...).
@vip/console:test: 
@vip/console:test: When testing, code that causes React state updates should be wrapped into act(...):
@vip/console:test: 
@vip/console:test: act(() => {
@vip/console:test:   /* fire events that update state */
@vip/console:test: });
@vip/console:test: /* assert on the output */
@vip/console:test: 
@vip/console:test: This ensures that you're testing the behavior the user would see in the browser. Learn more at https://react.dev/link/wrap-tests-with-act
@vip/console:test: An update to ForwardRef(SelectItem) inside a test was not wrapped in act(...).
@vip/console:test: 
@vip/console:test: When testing, code that causes React state updates should be wrapped into act(...):
@vip/console:test: 
@vip/console:test: act(() => {
@vip/console:test:   /* fire events that update state */
@vip/console:test: });
@vip/console:test: /* assert on the output */
@vip/console:test: 
@vip/console:test: This ensures that you're testing the behavior the user would see in the browser. Learn more at https://react.dev/link/wrap-tests-with-act
@vip/console:test: An update to SelectProvider inside a test was not wrapped in act(...).
@vip/console:test: 
@vip/console:test: When testing, code that causes React state updates should be wrapped into act(...):
@vip/console:test: 
@vip/console:test: act(() => {
@vip/console:test:   /* fire events that update state */
@vip/console:test: });
@vip/console:test: /* assert on the output */
@vip/console:test: 
@vip/console:test: This ensures that you're testing the behavior the user would see in the browser. Learn more at https://react.dev/link/wrap-tests-with-act
@vip/console:test: An update to ForwardRef(SelectItemText) inside a test was not wrapped in act(...).
@vip/console:test: 
@vip/console:test: When testing, code that causes React state updates should be wrapped into act(...):
@vip/console:test: 
@vip/console:test: act(() => {
@
```

### Behaviour / track-history / scene module tests — **PASS**

```
PASS  Runtime module tests (behaviour, track history, scene)
command: bash -c cd '/Users/mac/projects/VisionIntelligencePlatform/ai/inference' && python3 -B -m unittest discover -s tests -p 'test_*.py' -v 2>&1
duration: 14s

test_one_identity_across_two_track_ids_is_one_record (test_track_history.RecorderTests)
⛔ The single most likely defect in the phase. A briefly occluded person returns with a ... ok
test_retire_stale_closes_only_identities_past_the_reentry_window (test_track_history.RecorderTests) ... ok
test_retiring_a_stream_closes_every_open_identity_on_it (test_track_history.RecorderTests) ... ok
test_stats_report_the_store_so_an_operator_can_see_whether_anything_is_durable (test_track_history.RecorderTests) ... ok
test_the_identity_buffer_is_bounded_and_the_overflow_is_kept_not_dropped (test_track_history.RecorderTests) ... ok
test_two_analyses_of_one_recording_do_not_share_a_history (test_track_history.RecorderTests)
⚠️ ADR-0047: runs are independently queryable. Keyed by stream, not only by camera. ... ok
test_a_record_with_no_receipt_time_is_not_expired (test_track_history.RetentionTests)
⚠️ Missing metadata is a bug in the writer. Deleting data because of it fails in the ... ok
test_points_are_trimmed_from_the_oldest_end (test_track_history.RetentionTests) ... ok
test_retention_counts_wall_clock_receipt_time_not_footage_time (test_track_history.RetentionTests)
⛔ The defect this exists to prevent: purging by footage time erases a 2019 archive the ... ok
test_a_write_failure_does_not_requeue_and_grow_without_bound (test_track_history.UnwritableStoreTests)
⚠️ Dropped rather than retried. An unbounded retry queue on a permanently unwritable ... ok
test_a_write_failure_is_contained_counted_and_reported (test_track_history.UnwritableStoreTests)
⛔ Keeping movement paths is a secondary duty. A secondary duty that can stop the primary ... ok
test_an_unwritable_directory_is_refused_at_construction (test_track_history.UnwritableStoreTests)
⛔ Fail fast. An operator who configured a history location asked for paths to be kept; ... ok
test_a_recording_replays_to_identical_identities (test_track_replay.ReplayTests) ... ok
test_a_truncated_recording_still_replays_up_to_the_cut (test_track_replay.ReplayTests)
A recording is usually stopped by killing the runtime, so a half-written last line is the ... ok
test_a_tuning_change_that_breaks_identity_shows_as_a_difference (test_track_replay.ReplayTests)
The regression case. An engine that can no longer coast splits the identity, and the ... ok
test_an_occlusion_replays_identically (test_track_replay.ReplayTests) ... ok
test_an_unknown_format_version_is_refused_not_guessed (test_track_replay.ReplayTests) ... ok
test_comparison_ignores_the_literal_id_and_compares_the_identity_shape (test_track_replay.ReplayTests)
⚠️ Track ids embed a session id, so two runs of the same input give different strings for ... ok
test_nothing_is_recorded_unless_a_recorder_is_attached (test_track_replay.ReplayTests)
⚠️ A recording holds bounding boxes, camera ids and a tenant id. It is never on by ... ok
test_recording_is_bounded_and_says_when_it_stopped (test_track_replay.ReplayTests) ... ok
test_replay_needs_no_video_model_or_camera (test_track_replay.ReplayTests)
The whole point: the recording IS the tracker's input, so nothing else is required. ... ok
test_stopping_a_recording_stops_it (test_track_replay.ReplayTests) ... ok
test_the_recording_carries_the_engine_it_was_made_with (test_track_replay.ReplayTests)
Replaying against different tuning and calling the difference a regression would be an ... ok
test_two_cameras_replay_independently (test_track_replay.ReplayTests) ... ok
test_track_ids_carry_camera_identity (test_tracking.AnalyzerIntegrationTests) ... ok
test_tracking_can_be_disabled (test_tracking.AnalyzerIntegrationTests) ... ok
test_tracks_and_zone_counting_flow_end_to_end (test_tracking.AnalyzerIntegrationTests) ... ok
test_iou_and_greedy_association (test_tracking.AssociatorTests) ... ok
test_la
```

### Contract and perception-boundary checks — **PASS**

```
PASS  Contract and perception-boundary checks
command: pnpm verify:contracts
duration: 2s

$ node tools/contracts/verify-schemas.mjs && node tools/contracts/perception-boundary.mjs
contracts: OK — 70 schema(s) present, valid JSON, draft 2020-12.

perception boundary · 852 TypeScript source(s) outside ai/

  ✓ §A the runtime is called from exactly one place — services/media/src/adapters/http-frame-sink.ts
  ✓ §B only media knows where the runtime lives — services/media/src/config/env.ts, services/media/test/one-pipeline.test.ts, services/media/test/tracking.test.ts
  ✓ §C no service, app or package names a model implementation concept in code — clean
  ✓ §D the detection-result parse was found and has fields — 6 field(s)
  ✓ §D every field read off a detection result exists in the frozen contract — detections, inferenceMs, frameLatencyMs, executionProvider, runtimeVersion, model
  ✓ §E Track schema version agrees across TypeScript and Python — 1.1
  ✓ §E TrackingStats schema version agrees across TypeScript and Python — 1.0
  ✓ §F the zone attribute key agrees across media, events and the runtime — 'zoneIds' in 3 places
  ✓ §G 'zoneMembership' is named on both sides of the zone membership echo — contracts · media · runtime
  ✓ §G 'frameSeq' is named on both sides of the zone membership echo — contracts · media · runtime
  ✓ §G the runtime stores the caller's frame sequence, not its own counter — runtime_tracking.py records frame_index=ctx.frame_number

perception boundary: OK — the runtime is the only thing that knows how a model works.
```


## Acceptance criteria

| | Origin | Criterion | Met | Evidence |
| --- | --- | --- | :-: | --- |
| C1 | stated | Ran 6–7 h uninterrupted | ⭐ | continuity intact=true, awake 6.49 h of 6.5 h requested |
| C2 | stated | No service restarted | ⭐ | no restart counter moved; 18 containers healthy at the final sample |
| C3 | stated | No linear memory growth after warm-up | ⭐ | no container grows linearly after the first 10 min; 1 rose without a linear shape (reported in §Memory) |
| C4 | stated | No queue growth or backpressure | ⭐ | runtime queue max 0, media queue max 0 |
| C5 | stated | No frame or evidence loss | ⭐ | 580 analyses decoded 78902 frames and analysed 78902, 0 dropped; runtime dropped 0, media dropped 0 / failed 0, history write failures 0, invariant problems 0 |
| C5b | added | Delivery accounting: every frame accounted for, none reordered | ⛔ | offered +121852, delivered +121794, unaccounted 58 (dropped 0, failed 0, inflight at end 0); frames seen out of order 1 |
| C6 | stated | No invariant violation or orphaned work | ⭐ | 0 invariant problems across 580 analyses (no duplicate incident, no event lost, no timeline corruption, identity continuity), 0 samples with orphan sessions |
| C7b | added | No operation degrades as data accumulates | ⭐ | every operation's last-quarter median is within 50 % of its first |
| C7 | stated | Every operation succeeded, no findings | ⭐ | 6271 timed operations, 0 failed; 0 finding(s) |
| C8 | added | Behaviour / history / scene exercised and clean | ⭐ | zone annotations +105259, scene observations +308952, history points +105977, module failures 0, scene dropped 0, undated history dropped 0 |
| C9 | stated | Deployment verification | ⭐ | PASS |
| C10 | stated | Browser certification | ⛔ | FAIL |
| C11 | stated | Repository gate | ⭐ | PASS |
| C12 | added | Module tests (behaviour, history, scene) | ⭐ | PASS |
| C13 | added | Contract and perception-boundary checks | ⭐ | PASS |

**Stated criteria: 9/10 met · Added checks: 4/5 met**


## Decision

# NO-GO

Not met: **C5b** Delivery accounting: every frame accounted for, none reordered · **C10** Browser certification

