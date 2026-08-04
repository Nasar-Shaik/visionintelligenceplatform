# Capacity and sizing

## What is measured and what is arithmetic

Everything in §1–§3 was **measured**, on this host, against the running production deployment. §4 is
**arithmetic on those measurements** — a projection, clearly labelled, because there are not 500
cameras to point at this and presenting a projection as a measurement is the thing this project has
spent five milestones refusing to do (CONSTRAINTS §51).

Host: macOS arm64, 4 cores and 7.75 GB available to Docker, single node, everything on one machine.
A production host with dedicated disks will differ, generally favourably.

---

## 1. Idle footprint — measured

16 containers, no load.

| Container                          | CPU       | Memory         |
| ---------------------------------- | --------- | -------------- |
| mongodb                            | 0.62 %    | 242 MiB        |
| evidence                           | 0.62 %    | 89 MiB         |
| media                              | 0.59 %    | 85 MiB         |
| minio                              | 0.00 %    | 85 MiB         |
| workflow / rules / events / notify | 0.5–0.8 % | 82–83 MiB each |
| camera / identity / tenant         | 0.7–0.8 % | 80–81 MiB each |
| gateway                            | 0.31 %    | 75 MiB         |
| proxy (Caddy)                      | 0.00 %    | 28 MiB         |
| console (Caddy)                    | 0.00 %    | 12 MiB         |
| nats                               | 0.16 %    | 6.7 MiB        |
| redis                              | 0.75 %    | 6.7 MiB        |
| **total**                          | **~7 %**  | **1,204 MiB**  |

A Node service idles at ~80 MiB. Ten of them are ~800 MiB before any work — the dominant fixed cost,
and it does not vary with camera count.

## 2. Under load — measured

3,000 detections published to `t.<tenant>.capability.output.…` and carried through the **real**
pipeline: events → rules → workflow → notify.

|                     | Measured                                                   |
| ------------------- | ---------------------------------------------------------- |
| Publish to NATS     | 3,000 in 0.2 s (14,634 msg/s)                              |
| Persisted as events | 3,000 / 3,000                                              |
| Incidents raised    | 27 (dedup window collapsing them)                          |
| Notifications       | 27                                                         |
| End-to-end ingest   | ≥ 600 events/s — fully drained before the first 5 s sample |
| Peak memory         | 1,350 MiB (+146 MiB over idle)                             |
| CPU during ingest   | 7–10 %, one 43 % sample                                    |

The 3,000 → 27 collapse is `RULES_CANDIDATE_DEDUP_WINDOW_MS` working, not loss.

## 3. Storage per unit — measured

Deltas across 3,000 real events.

| Document     | Body  | Index    | **Total**   |
| ------------ | ----- | -------- | ----------- |
| Event        | 845 B | 464 B    | **1,309 B** |
| Incident     | 986 B | ~8 KB*   | ~9 KB*      |
| Notification | 575 B | ~2.5 KB* | ~3 KB*      |

\* Incident and notification index costs are inflated by small-sample amortisation — 26 documents
across index pages that are mostly empty. The **event** figure, from 3,000 documents, is the one to
plan with. Treat incidents as ~1 KB of body plus index overhead that amortises with volume.

### Recordings — measured from the demo clips

| Clip                      | Duration | Size   | Effective bitrate |
| ------------------------- | -------- | ------ | ----------------- |
| H.264 720p25 test pattern | 10 s     | 121 KB | ~97 kbps          |
| H.264 720p1 (1 hour)      | 3,600 s  | 11 MB  | ~24 kbps          |
| H.265 720p25 `hvc1`       | 10 s     | 57 KB  | ~46 kbps          |

> ⚠️ **Do not size a customer from these.** ffmpeg test patterns compress far better than real
> scenes. Real CCTV is typically **2–4 Mbps** for 1080p H.264 and **1–2 Mbps** for H.265. The table
> below uses those industry figures, not the numbers above, and says so.

## 4. Sizing — DERIVED, not measured

Assumptions stated so they can be argued with:

- 1080p H.264 at **3 Mbps** continuous, 24×7 (H.265 roughly halves it)
- **50 events per camera per day** (motion/perception primitives, not raw frames)
- **30-day** recording retention
- One Node service ≈ 80 MiB idle + headroom

### Recording storage — the dominant term

Per camera at 3 Mbps continuous: **32.4 GB/day**, **972 GB/30 days**.

| Cameras | 30-day recordings @3 Mbps | With H.265 @1.5 Mbps |
| ------- | ------------------------- | -------------------- |
| 10      | ~9.7 TB                   | ~4.9 TB              |
| 50      | ~48.6 TB                  | ~24.3 TB             |
| 100     | ~97.2 TB                  | ~48.6 TB             |
| 500     | ~486 TB                   | ~243 TB              |

Motion-triggered rather than continuous recording changes this by an order of magnitude, and is how
most deployments actually run. **This is the number that decides the hardware budget** — everything
else on this page is rounding error beside it.

### Database growth

At 50 events/camera/day and 1,309 B/event:

| Cameras | Events/day | Events/30 days | Mongo (events) |
| ------- | ---------- | -------------- | -------------- |
| 10      | 500        | 15,000         | ~20 MB         |
| 50      | 2,500      | 75,000         | ~98 MB         |
| 100     | 5,000      | 150,000        | ~196 MB        |
| 500     | 25,000     | 750,000        | ~982 MB        |

Under 1 GB/month even at 500 cameras. The database is not the constraint; storage is.

### Compute

Measured ingest is ≥ 600 events/s on 4 cores. 500 cameras at 50 events/day is **0.3 events/s** —
three orders of magnitude of headroom. Sizing is driven by concurrent **operators** and by object
storage throughput, not by event volume.

| Cameras | Recommended host                                                 | Rationale                                                                                 |
| ------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **10**  | 4 vCPU · 8 GB · 10 TB                                            | measured idle 1.2 GB + headroom; single host                                              |
| **50**  | 8 vCPU · 16 GB · 50 TB                                           | more concurrent operators; storage I/O begins to matter                                   |
| **100** | 8–16 vCPU · 32 GB · 100 TB                                       | separate object storage onto its own disks/host                                           |
| **500** | 16+ vCPU · 64 GB · 500 TB, **object storage on dedicated nodes** | beyond a single-host deployment; needs a Mongo replica set and horizontal gateway scaling |

> ⚠️ **The 500-camera row is beyond what this architecture has been verified to do.** Nothing here
> has been run above one host, one Mongo node and one MinIO node. Treat 100 cameras as the verified
> ceiling for the current deployment shape and the rest as a planning aid.

## 5. Read latency — measured

With 3,001 events stored:

| Query                         | p50    | p95    | max    |
| ----------------------------- | ------ | ------ | ------ |
| Events page (keyset, 50)      | 9 ms   | 11 ms  | 13 ms  |
| Incident list (25)            | 9 ms   | 13 ms  | 13 ms  |
| Evidence list (25)            | 8 ms   | 11 ms  | 13 ms  |
| 100 concurrent incident lists | 117 ms | 184 ms | 191 ms |

Keyset pagination means page latency does not grow with collection size — that is the design intent,
and 3,001 events is too small to prove it. It is consistent with it.

## 6. What would change these numbers

- **Continuous vs motion-triggered recording** — an order of magnitude on storage, the only term
  that matters at scale.
- **H.265 instead of H.264** — roughly halves storage; costs browser compatibility (open-source
  Chromium builds refuse HEVC).
- **Retention** — linear. 90 days triples the storage table.
- **Real scene complexity** — the measured clip bitrates are optimistic by design; §4 already uses
  industry figures instead.
- **Real cameras** — every ingest number here comes from synthetic detections. What actual
  perception load does to CPU is unmeasured (TD-27).
