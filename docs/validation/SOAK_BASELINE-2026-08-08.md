# Release Soak — Baseline

**Captured** 2026-08-07 20:03 UTC, immediately before the soak began.
**Commit** `9b5a672` · branch `feature/v1` · **working tree clean**.

> ⚠️ A baseline is only useful if it was measured on the thing that is about to be exercised. Every
> number here comes from the deployed production stack, not from a test double, and every one of
> them is re-measured at the end so a drift has something to be a drift *from*.

---

## 1 · Abort gate

The soak was not permitted to start until all of the following held. They did.

| Gate | Result |
| --- | --- |
| Containers running and healthy | **17 / 17** |
| Edge — TLS, HSTS, CSP, no version banner, plaintext redirect | **5 / 5** |
| Gateway + identity — unauthenticated call refused, login issues a token | **2 / 2** |
| Services through the gateway with a real token | **8 / 8** |
| AI runtime healthy, model loaded | **2 / 2** |
| Object storage — buckets present, reachable through the edge | **2 / 2** |
| Console — hashed entry bundle referenced and downloadable | **2 / 2** |
| Messaging — JetStream streams present | **1 / 1** |
| **Total** | **39 checks, 0 failures** |

Evidence: `tools/validation/verify-deployment.mjs --json` → `.soak/preflight.json`.

### ⛔ One stale job was found and cleared

`ases_9a2c3bf382cf4540afed0768a4bfbbb8` (analysis `ana_0a43b31e7f1a4bdab50cddb2ca0e6ece`) sat in
`retrying` since 18:28 UTC. It is the Architect's first `movie101.mp4` upload, wedged by **V-11**
before that fix was deployed — a pre-existing casualty, not a live fault. Cancelled through the
product's own endpoint (the one V-13 added a button for). Re-checked: **60 analyses, 0 non-terminal
sessions.**

---

## 2 · Deployment identity

| | |
| --- | --- |
| Runtime version | `0.1.0` |
| Model | `yolox-nano` v1.0.0, family `yolox`, task `object-detection` |
| Capability | `perception.person-detection` — state `READY` |
| Execution provider | `CPUExecutionProvider` — ⚠️ **no GPU on this host** |
| Pipeline version | `1.0.0` |
| Console bundle | `/assets/index-Cpf3g_iD.js` |
| Host | Darwin 25.5.0, Docker limit **7.75 GiB** per container |

---

## 3 · Resource baseline

Disk: **297 GB available**, 4 % used. Docker: 40.6 GB images, 13.26 GB volumes, 29.11 GB build cache.

| Container | CPU % | Memory |
| --- | ---: | ---: |
| mongodb | 1.06 | 270.4 MiB |
| minio | 0.00 | 251.6 MiB |
| media | 0.39 | 167.3 MiB |
| camera | 0.59 | 113.7 MiB |
| notify | 0.48 | 111.9 MiB |
| events | 0.52 | 109.9 MiB |
| workflow | 0.47 | 107.5 MiB |
| rules | 0.51 | 106.5 MiB |
| inference | 0.02 | 101.5 MiB |
| evidence | 1.67 | 99.01 MiB |
| gateway | 0.53 | 98.47 MiB |
| identity | 1.61 | 94.8 MiB |
| tenant | 0.42 | 92.54 MiB |
| nats | 0.28 | 79.77 MiB |
| proxy | 0.00 | 42.7 MiB |
| console | 0.00 | 14.63 MiB |
| redis | 0.67 | 1.535 MiB |

**Total resident ≈ 1.86 GiB** across seventeen containers, host effectively idle.

### Restart counts at t=0

⚠️ Recorded as a **starting value, not a target**. `mongodb: 9` and `minio: 13` are historical, from
days of development restarts; both have current uptimes of 7 h and 24 h. What the soak asserts is
that these numbers **do not increase**.

| media | gateway | inference | events | rules | workflow | mongodb | nats | minio |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 0 | 0 | 0 | 9 | 0 | 13 |

### Queues and descriptors

| | |
| --- | --- |
| JetStream | 5 streams · 346 891 messages · **max consumer pending: 0 on every stream** |
| Open file descriptors | media 39 · gateway 39 · events 38 · workflow 38 · inference 17 |
| API latency probe (`GET /media/analyses?limit=5`) | **9–21 ms** |
| Runtime throughput, idle | 12.9–18.0 fps · p95 latency 82–112 ms · **queue depth 0** |

---

## 4 · Workload the soak will apply

33 fixtures plus one real portrait recording, rotating, one analysis at a time with a 20 s gap, a
parallel pair every 8th cycle and a re-analysis of an earlier recording every 4th.

| Group | Fixtures |
| --- | --- |
| Scene content | empty-scene · single-person-walking · multiple-people · crowd · queue-formation · occlusion · retail-loitering |
| Resolution ladder | 180p · 360p · 720p · 1080p |
| Conditions | night · rain · blur · camera-shake · lighting-changes · fast-movement · partial-visibility |
| Frame rate and angle | low-fps · high-fps · angle-overhead · angle-wide |
| Codecs | h264 · h265-hvc1 · h265-hev1 |
| Duration ladder | long-recording · 1 min · 5 min · 10 min |
| ⛔ Expected refusals | corrupt-zero-bytes · corrupt-not-a-video · corrupt-truncated-header · corrupt-audio-only |
| ⭐ Real footage | `movie101.mp4` — 1080×1920 portrait, **19.04 s**, 27.0005 fps, a real person |

Each finished analysis then exercises timeline, report/export, playback URL, a **ranged fetch of
that URL from the object store**, snapshot capture and an events query.

> ⭐ The real recording is in the corpus deliberately. Every generated fixture is exactly 30.000 s
> and landscape; that uniformity is what hid **V-11** for 37 clips ([L-63]) and what made **V-15**
> look like correct behaviour. A soak made only of fixtures would agree with itself again.

---

## 5 · What this baseline does not cover

- ⛔ **No GPU.** Every throughput figure is CPU-bound and says nothing about accelerated hardware.
- ⛔ **No real CCTV.** Synthetic fixtures plus one phone recording; no RTSP, no IP camera, no
  multi-day continuous stream ([L-64]).
- ⛔ **No multi-gigabyte upload** ([L-66]). The largest file exercised is 15.25 MB (`rain.mp4`) and
  the longest recording is 10 minutes.
- ⛔ **Single tenant.** `tnt_demo_retail` only; no cross-tenant contention.

---

## Related

- [SOAK_REPORT](SOAK_REPORT-2026-08-08.md) — the run and its verdict
- [SOAK_METRICS](SOAK_METRICS-2026-08-08.md) — measured series
- [SOAK_FINDINGS](SOAK_FINDINGS-2026-08-08.md) — every issue found
- [KNOWN_LIMITATIONS](../project/KNOWN_LIMITATIONS.md)
