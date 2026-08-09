# Soak Findings — 2026-08-09 (P-11, behaviour layer)

Companion to [SOAK_REPORT-2026-08-09](SOAK_REPORT-2026-08-09.md), which is generated from the run's
own append-only streams and contains every measurement. This file carries what a generator cannot
derive: root cause, provenance, and what each finding means for the release.

⛔ **Nothing here restates a number that is not in the report.** Where a figure appears, it was
measured; where a judgement appears, it is labelled as one.

---

## Verdict

# ⛔ NO-GO

**Stated criteria 9/10 · added checks 4/5.** The run itself was clean — 6.49 h uninterrupted, 656
cycles, 580 analyses, **6 271 timed operations with 0 failed, 0 findings raised by the harness, 0
container restarts, 0 dropped frames, 0 invariant problems**. Two things block the release, and
neither was produced by the soak workload.

| | Blocker | Origin |
| --- | --- | --- |
| **C10** | Browser certification fails: 4 failures, all the same test | Pre-existing since 2026-08-08 12:25 |
| **C5b** | 58 frames offered and named by no counter; 1 frame seen out of order | Found by this run |

---

## Blocker 1 — a security assertion and the shipped product disagree

`tools/e2e-browser/test/security.spec.ts:17` fails identically on chromium, edge, firefox and webkit.
146 tests passed, 18 skipped, 4 failed — all four are this one test.

```
Expected substring: "camera=()"
Received string:    "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
```

**Both sides are deliberate, and they were written by different milestones.**

| | Set | When |
| --- | --- | --- |
| `Permissions-Policy: camera=(self)` in `infra/docker/Caddyfile` | P-9 slice 1, `12e8853` | 2026-08-08 12:25 |
| `expect(h['permissions-policy']).toContain('camera=()')` | P-8.5, `6e5e93e` | 2026-08-07 20:59 |

The test's stated reason still reads well: *"A surveillance console asking for the operator's own
camera would be indistinguishable, to a browser, from one that had been compromised into doing so."*
That was written when the console had no live capture. P-9 then shipped browser-side webcam capture,
which the browser will not permit unless the origin is allowed — so `camera=(self)` is not a
regression, it is the feature's requirement. The test was not revisited.

⛔ **Deliberately not fixed here.** Two changes would turn this green — relax the assertion, or
remove `(self)` from the header — and each is a decision about what this product's security posture
*is*, not a repair. Making either to obtain a GO would be the exact failure this report exists to
prevent. It is escalated, not resolved.

⭐ **The larger finding is that nothing caught it for a day.** The browser suite is not part of
`pnpm turbo lint typecheck test`, so the repository gate passed today — and on every commit since
2026-08-08 12:25 — with a security assertion broken. A gate that cannot see a security test is worth
scheduling regardless of how the assertion above is settled.

---

## Blocker 2 — a fourth outcome that no counter names

Across the run, media offered **121 852** frames and delivered **121 794**. The 58-frame difference
is not a trend: it is 0 for the first ~100 minutes, steps once, and stays flat for the remaining four
hours. At the final sample `framesDropped`, `framesFailed`, `queueDepth` and `inflight` are all 0.

So 58 frames were offered and then neither delivered, dropped, failed, nor left in flight.

⚠️ **No data was lost, and that is why this needs stating separately.** All 580 analyses decoded and
analysed exactly the same number of frames — **78 902 each way, 0 dropped** — and 580 invariant
checks found 0 problems. The gap is on the live path, where shedding a stale frame is reasonable
behaviour; the defect is that the shedding is *unnamed*, so a real loss and a deliberate drop would
look identical to every dashboard.

Separately, `inference_tracking_out_of_order_total` moved 0 → 1 at minute 76.5 — one frame in 121 852
reached the tracker out of sequence.

**Recommended fix (not applied):** count the discard path in `http-frame-sink.ts` so that
`offered = delivered + dropped + failed + inflight` holds as an identity, and assert that identity in
a test. This is the same class as ["No" versus "not yet"](../adr/ADR-0053-zone-membership-returns-as-an-observation.md) —
an outcome that exists but has no name.

---

## What this run proved, that three earlier attempts could not

Three soaks were stopped deliberately, each on a verified defect that invalidated the measurement.
Their evidence is preserved unmodified in `.soak-p11-aborted-defect{3,4,5}/`, each with an
`ABORTED.md` recording why.

| | Defect | Found by | Fix |
| --- | --- | --- | --- |
| **3** | `/metrics` deserialised the entire durable history to call `len()` on it — 148 ms per scrape, ~36 k objects, growing with retained data | Attempt 1's own memory slope | Count `\n` in 1 MiB chunks: **148 → 10.1 ms**, nothing allocated |
| **4** | The behaviour stage kept five per-stream caches whose only eviction path was a GDPR erasure — ~148 KB per analysis, unbounded | Attempt 2, after DEFECT-3 stopped masking it | LRU bound of 256 streams; attempt 3 then *proved* it: cap at 107.5 min, pinned thereafter |
| **5** | `stream_id` — the most selective filter a Behaviour API read has — was the one filter the store could not apply, so answering about one analysis materialised 2 310 records and 135 569 points to return 2 | Attempt 3's operation-latency drift | Filter while scanning: **558 → 139 ms**, 2 310 → 2 records built |

⭐ **DEFECT-3 and DEFECT-5 are one class**: the store materialised everything for every question asked
of it — `stats()` to count, `records()` to filter. Both now ask the file only for what was asked of it.

Effect on the runtime, same window and same method, only the build differing:

| | slope after warm-up | R² | shape |
| --- | --- | --- | --- |
| attempt 3 (DEFECT-5 present) | 35.92 MB/h | 0.667 | a line |
| **attempt 4 (this run)** | **2.66 MB/h** | **0.010** | a cloud |

The Behaviour API, on a store that *started* this run at 39.9 MB — larger than attempt 3 ever
reached: `behaviour-primitives` **58 ms**, `behaviour-timeline` **55 ms**, against 330 → 608 ms and
323 → 589 ms before.

---

## Limitations of this result

- **One host, one night, one synthetic corpus** plus a single real phone recording. Not a substitute
  for real cameras in a real building.
- **Memory shows one step, not a slope.** Bucket medians hold ~120 MB for 80 minutes, step once to
  ~160 MB as the corpus reaches its 5- and 10-minute fixtures, then hold ~163 MB for the remaining
  4.5 hours (post-step fit 2.65 MB/h at R² 0.056). Read as a CPython allocator high-water mark. It is
  a **judgement**, supported by the shape and by the absence of any accumulating structure —
  `streamsTracked` pinned at its bound, `liveStreams` and `liveIdentities` oscillating,
  `pendingWrites` flat at 0 — not by a heap profile.
- **The Behaviour API's cost still grows with retained history**, now as an O(bytes scanned) file
  walk rather than O(records materialised). Bounded by the 72 h retention window, projecting to
  roughly 700 ms at steady state. `max_records_per_tenant` is **not** enforced by the JSONL store,
  which only appends — worth confirming that is intended.
- **`inference_tracking_fragmentation` is not usable as a drift signal.** It is computed as
  `created / confirmed`: a lifetime counter over an instantaneous gauge, so it grows without bound
  and read 2 055 at one point in this run. `recovered / occlusions` is the ratio that would actually
  detect identity drift.
- **18 browser tests skipped** — the live-capture specs need a real camera device.

---

- [SOAK_REPORT-2026-08-09](SOAK_REPORT-2026-08-09.md) — every measurement · [soak-2026-08-09.json](soak-2026-08-09.json) — the same, machine-readable
- Raw evidence: `.soak-p11/{metrics,ops,events}.jsonl`, `SUMMARY.json`, `post/`
