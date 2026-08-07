# Performance Baseline

> **Measured 2026-08-07** against the deployed production stack. These numbers are the reference a
> future regression is compared against — so the hardware is recorded with them, because a figure
> without its machine is not a baseline.

---

## ⚠️ The machine

| | |
| --- | --- |
| **Host** | Apple M1 Pro · 10 cores · 32 GB · macOS 26.5.2 |
| **Docker** | 10 CPUs, 8.32 GB allocated to the VM |
| **Runtime** | ONNX Runtime, `CPUExecutionProvider`, `yolox-nano` @ 416×416 |
| **Analysis rate** | 2 fps of footage (the deployment default) |
| **Concurrency** | `maxConcurrent: 1` — [L-41] |

⛔ **Do not quote these to a customer as production figures.** This is a developer laptop running
seventeen containers, a browser and a build toolchain. A dedicated host with a GPU would differ by an
order of magnitude in one direction; a shared VM with two vCPUs would differ in the other. They are a
**regression reference**, not a capacity plan.

⚠️ **CPU and memory are sampled at stage boundaries**, not continuously — `docker stats --no-stream`
costs about a second. Enough for a baseline; not enough to catch a transient spike, and this document
says so rather than implying otherwise.

---

## ⭐ The headline

| | |
| --- | --- |
| **Analysis speed factor** | **×8.8 – ×9.1** of real time, and **flat across a 30× range in recording length** |
| **Effective throughput** | ~18–20 analysed frames/second end to end |
| **Evidence still** | **~130 ms regardless of recording length** — accurate seek is O(1) |
| **Timeline query** | 21 ms at 30 s · 74 ms at 30 min |
| **Queue wait** | ~3.5 s, constant — the runner's poll interval, not load |

> ⭐ **Flat speed factor is the important one.** A pipeline that degrades with length would make the
> 30-minute recording a customer actually cares about the one case nobody measured.

---

## The duration ladder

`node tools/dataset/large.mjs` then `node tools/validation/validate.mjs --clips=duration-*`

| Recording | Size | Upload | Probe | Queue | **Analysis** | Frames | **Speed** | Timeline | Still | Report |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 min | 0.15 MB | 9 ms | 51 ms | 3.52 s | **4.1 s** | 121 | **×8.8** | 22 ms | 130 ms | 21 ms |
| 5 min | 0.75 MB | 12 ms | 47 ms | 3.53 s | **29.6 s** | 600 | **×9.1** | 21 ms | 128 ms | 24 ms |
| 10 min | 1.50 MB | 28 ms | 45 ms | 3.55 s | **63.2 s** | 1 200 | **×9.0** | 26 ms | 127 ms | 24 ms |
| 30 min | 4.51 MB | 82 ms | 47 ms | 3.52 s | **197.1 s** | 3 600 | **×9.0** | 74 ms | 136 ms | 36 ms |

**Frames per wall-clock second:** 29.5 → 20.3 → 19.0 → 18.3. ⚠️ A mild decline with length, and the
reported speed factor stays flat because it excludes fixed startup — both numbers are true and they
answer different questions. The customer-facing one is the wall clock.

### Memory, measured at the end of each run

| Recording | media | inference | events | mongodb |
| --- | --- | --- | --- | --- |
| 1 min | 141 MiB | 100 MiB | 107 MiB | 182 MiB |
| 5 min | 151 MiB | 101 MiB | 98 MiB | 183 MiB |
| 10 min | 160 MiB | 103 MiB | 99 MiB | 195 MiB |
| 30 min | **173 MiB** | **94 MiB** | 101 MiB | 211 MiB |

⭐ **Bounded.** media grows ~32 MiB across a 30× increase in work — the decoder is streaming, not
buffering. Inference is flat (the model is resident and the frame is transient). Mongo grows with
persisted events, which is data, not leak.

---

## Per-stage latency

`node tools/validation/validate.mjs` — 8 standard clips.

| Stage | Median | Range | Notes |
| --- | --- | --- | --- |
| Create analysis | 41 ms | 28–95 ms | Presign + insert |
| **Upload** | 8 ms | 4–18 ms | ⚠️ Loopback. 4–48 MB/s — dominated by latency at these sizes |
| Probe (confirm) | 44 ms | 41–95 ms | ffprobe over an **internal** signed URL |
| Queue wait | 3.5 s | constant | Poll interval |
| Timeline | 21 ms | 17–26 ms | Derived, never stored |
| Incidents | 8 ms | 7–12 ms | Indexed on `analysisSessionId` |
| **Evidence still** | 130 ms | 125–183 ms | ⭐ Includes a real ffmpeg spawn and a GOP decode |
| Report | 20 ms | 17–25 ms | Assembles timeline + incidents |
| Playback URL | 9 ms | 8–14 ms | Presign only |

---

## Concurrency

`--concurrent=N`, N identical uploads issued simultaneously.

| N | Wall clock | Fastest | Slowest | Storage Δ | Findings | Results identical? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 3.5 s | — | — | 0.13 MB | 0 | — |
| 2 | 12.7 s | 1.0 s | 4.6 s | 0.24 MB | 0 | ✅ |
| 5 | 25.4 s | 1.9 s | 8.6 s | 0.61 MB | 0 | ✅ |
| 10 | **50.7 s** | 1.9 s | 39.5 s | 1.33 MB | **0** | ✅ **one distinct tuple** |

> ⭐ **Ten simultaneous uploads produced ten identical results** — 60 frames, 3 events, 1 track,
> 2 incidents, every time. That is the assertion that matters; "they all finished" is not.
>
> ⛔ Before [V-2] and [V-4] this was impossible: runs 2–10 would have collided on the tracker's
> out-of-order gate and the incident dedup key, produced no tracks and no incidents, and **still
> reported `succeeded`**.

⚠️ **The queue serialises; it does not parallelise.** `maxConcurrent: 1` ([L-41]). Ten 30-second
clips take ~50 s wall, close to the ~35 s serial floor plus overhead. The spread (1.9 s → 39.5 s)
**is** the queue, working correctly. Do not read the slowest figure as a latency regression.

---

## Storage growth

| What | Measured |
| --- | --- |
| Per journey (0.15 MB clip + 1 still) | ~0.13 MB |
| 10 concurrent journeys | 1.33 MB |
| ⚠️ Analysis stage alone | **0 bytes** — offline analysis writes only its session document |

⭐ What consumes a customer's disk is the **recording** and the **stills**, not the analysis. A
rerun of an existing recording costs almost nothing.

---

## Browser

| Engine | Full journey | Suite |
| --- | --- | --- |
| **Chromium** | 9.7 s – 2.1 m | ✅ 20/20 |
| **Edge** | 11.0 s | ✅ 4/4 |
| **Firefox** | 8.2 s | ✅ 4/4 |
| **WebKit** | **18.3 s** | ✅ 4/4 |

⚠️ WebKit is roughly **2× slower** on the full journey than Firefox or Chromium. Consistent across
runs. Not a defect — worth knowing before a Safari-based demo. The Chromium spread (9.7 s → 2.1 m) is
queue contention from concurrent analyses, not the browser.

---

## ⛔ Not measured

| Gap | Why | Ref |
| --- | --- | --- |
| **2 GB / 5 GB uploads** | The ceiling is enforced and tested before bytes move; a real multi-gigabyte transfer — multipart, proxy body limits, token expiry mid-upload — is not | [L-66] |
| **60-minute analysis** | Ladder generates it; not executed. Extrapolates to ~6.5 min at ×9 | — |
| **GPU throughput** | CPU only on this host | — |
| **Multi-camera live + offline together** | No camera has ever been connected | [L-1] |
| **Sustained 24 h soak** | Nightly territory, not a validation phase | — |
| **Real-footage decode cost** | Real H.265 from a real encoder differs from these fixtures | [L-63] |

---

## Regression thresholds

Compare a future run against this table. ⚠️ These are **investigation triggers**, not gates — the
host varies.

| Metric | Baseline | Investigate if |
| --- | --- | --- |
| Speed factor | ×9.0 | < ×6 or > ×15 |
| Frames/s (30 min) | 18.3 | < 12 |
| media RSS after 30 min | 173 MiB | > 400 MiB |
| Timeline @ 30 min | 74 ms | > 500 ms |
| Evidence still | 130 ms | > 1 s, **or scaling with length** |
| Concurrency-10 identical | ✅ | ⛔ **any divergence is a defect, not a slowdown** |

---

## Related

- [FIRST_PRODUCT_VALIDATION.md](FIRST_PRODUCT_VALIDATION.md) · [TEST_PLAN.md](TEST_PLAN.md)
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) · [AI_RUNTIME_BENCHMARK.md](AI_RUNTIME_BENCHMARK.md)
