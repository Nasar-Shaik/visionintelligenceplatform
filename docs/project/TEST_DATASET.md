# Test Dataset

> **The permanent validation video library.** Built by `node tools/dataset/generate.mjs --verify`,
> measured against the deployed model, and described by
> `infra/docker/fixtures/media/validation/manifest.json`.

**37 clips · 1 negative control · 6 recordings that must be procured and do not exist.**

---

## ⛔ Read this before writing a test against any of these

Every clip here is **real person pixels on authored motion**: crops taken from a CC0 photograph at
the exact boxes the deployed model returns, composited onto a synthetic background along a scripted
path.

That buys exactly one thing — **a known right answer**. On real footage nobody knows the true number
of people in frame 743, so nothing can be asserted, only observed.

It costs something too, and the cost is the whole of **[L-1]**. A composited sprite has no gait, no
perspective change, no rolling shutter, no compression history and no lens. The degraded clips
(`night-footage`, `rain`, `blur`, `camera-shake`) degrade a *clean* frame in a way that is plausible
— not a real one in the way a real sensor does.

> **These prove the platform handles the input** — decode, provenance, tracking, rules, timeline,
> evidence. **They prove nothing about detector accuracy in a real venue.**

The six `procurement` entries at the bottom are the ones that would, and they are listed as unmet
requirements rather than quietly approximated. ⛔ **A synthetic "warehouse" clip would be the most
dangerous file in this repository**: it would turn an open question into a green test.

## ⭐ Ground truth is measured, never declared

`scenarios.mjs` records what the author *intended*. The generator probes the **deployed runtime** and
writes what the model **actually found** into `manifest.json`. Tests read the manifest.

Asserting against intent would produce a suite that fails whenever the model is upgraded, in a way
indistinguishable from a real regression — and would let a fixture the detector cannot see sit in the
repo looking authoritative.

⚠️ Every disagreement is printed. For clips marked `uncertain` it is information; for the others it
is a **fixture defect** and the exit code says so. Two were caught this way during construction:

- `multiple-people` reported *authored 2, model found 1* — the two subjects walk toward each other
  over 30 s and were probed at t=15, the one moment they are at the same x by construction. **The
  midpoint of a crossing scenario is the one point you must not sample.**
- `camera-shake` failed to build: `crop` re-evaluates per frame by default and rejects `eval=frame`.

## Generating

```sh
node tools/dataset/generate.mjs --verify      # 37 clips + measured manifest (~22 MB, ~10 min)
node tools/dataset/generate.mjs --only=crowd  # one clip
node tools/dataset/large.mjs                  # the duration ladder (not committed)
```

⚠️ **Needs the deployment running** — the sprites are cropped at boxes the live model returns, and
`--verify` asks it what it sees. The clips are `.gitignore`d and the **manifest is committed**: the
recipe is reproducible, the measured truth is not regenerable on demand.

---

## Motion and identity

| id | Scene | Duration | Ground truth (measured) | Tests |
| --- | --- | --- | --- | --- |
| `single-person-walking` | One person crosses, always visible | 30 s | **1** @ t=15 | One object → exactly one track id |
| `multiple-people` | Two cross at different depths | 30 s | **2** @ t=5 | No identity swap — each keeps its own row |
| `fast-movement` | Traverses every 4 s | 30 s | **1** @ t=2 | ⚠️ Displacement exceeds subject width at 2 fps. Fragmentation is expected and **reported**, not asserted away |
| `occlusion` | Behind a pillar and out | 30 s | **1** @ t=4 | Identity survives the gap |
| `partial-visibility` | Half outside the frame | 30 s | **1** @ t=15 | ⚠️ Genuinely uncertain — the manifest records what the model did |

## Retail and rules

| id | Scene | Duration | Ground truth | Tests |
| --- | --- | --- | --- | --- |
| `retail-loitering` | Arrives by t=8, never leaves | 60 s | **1** @ t=30 | Dwell ≈ 45 s; a 20 s rule fires **once**, not per frame |
| `restricted-zone` | Walks into a marked area | 30 s | **1** @ t=15 | Entry fires on the transition |
| `counter-monitoring` | Staff behind, customer arrives | 30 s | **2** @ t=20 | "Someone is present" vs "someone approached" |
| `queue-formation` | Four in a line, receding | 30 s | **4** @ t=15 | A queue is a count plus a persistence |
| `crowd` | Eight at mixed depths, overlapping | 30 s | **8** @ t=15 | ⭐ NMS under overlap. Found **8/8** |
| `empty-scene` | Nobody | 30 s | **0** ⭐ | ⭐ **The negative control.** See below |

> ### ⭐ `empty-scene` is the most important clip in the library
>
> Every other scenario asserts the platform finds something; only this one asserts it does not
> invent. A model that hallucinated a person would pass every other fixture here and fail exactly
> one — and a customer's first false alarm on an empty shop is the fastest way to lose their trust.
>
> Verified end to end: **0 detections, 0 tracks, 0 events, 0 incidents**, and the UI says *"Nothing
> was detected in this recording"* rather than rendering a blank panel.

## Degraded capture

⚠️ These degrade a **clean synthetic frame**. A real sensor degrades differently — real low light
brings sensor-specific chroma noise and a slower shutter that smears moving subjects together; real
rain occludes in coherent streaks the compressor then mangles.

| id | Degradation | Measured | Honest limit |
| --- | --- | --- | --- |
| `lighting-changes` | Brightness ±0.35 over a 10 s cycle | **1** | Confidence moves with it |
| `night-footage` | Gamma to ~25 % luminance + temporal noise | **1** | Not a real low-light sensor |
| `rain` | Temporal noise + contrast loss + light blur | **1** | ⚠️ Named honestly: what rain does to an *encoded frame*, not what rain is |
| `blur` | Gaussian σ 3.5 | **1** | A dirty dome — the commonest real camera fault |
| `camera-shake` | Whole frame ±10 px | **1** | ⭐ Moves the **world**, not the subject: static geometry jitters, which is what wind does to a pole mount |

## Capture rate and length

| id | Property | Measured | Tests |
| --- | --- | --- | --- |
| `low-fps` | Source **1 fps**, analysis asks 2 | **1** | ⭐ Asked for more frames than exist. `ptsSeconds` may be null; `mediaOffsetSeconds` never is (ADR-0039) |
| `high-fps` | Source **30 fps** | **1** | Decimation to exactly the requested rate — an off-by-one doubles every bill |
| `long-recording` | 300 s, walks a lap every 60 s | **1** | Crosses a decode chunk boundary; the timeline buckets rather than lists |

## Transport variants

One axis at a time, from the same measured scene — so a failure says *which* property was
unsupported.

| Axis | ids | All measured |
| --- | --- | --- |
| **Resolution** | `res-180p` 320×180 · `res-360p` · `res-720p` · `res-1080p` | **1** each |
| **Codec** | `codec-h264`/avc1 · `codec-h265-hvc1` · `codec-h265-hev1` · `codec-mpeg4`/mp4v | **1** each |
| **Angle** | `angle-eye-level` · `angle-high` · `angle-overhead` · `angle-wide` | **1** each |

> ⛔ **`hev1` vs `hvc1` is not pedantry.** [TD-29] is open because WebKit refuses `hev1` in MSE while
> Chromium accepts it. Both tags exist so the browser-playback regression can be written at all.
>
> ⚠️ `angle-overhead` is a steep down-angle, **not true overhead**. A real overhead camera sees the
> top of a head, which is a different object to a detector than a foreshortened figure.

## Corrupted and hostile input

⛔ **These have no expected detections — they have an expected refusal.** Each is a file a customer
will eventually upload. The only acceptable outcomes are a clear rejection or a completed analysis.
What must never happen is the third thing: a session stuck in `running`, or one reporting `succeeded`
having analysed nothing.

| id | Damage | ffprobe says | Measured product behaviour |
| --- | --- | --- | --- |
| `corrupt-zero-bytes` | Truncated to 0 | refuses | ✅ Refused at **create** — `bytes >= 1` |
| `corrupt-truncated-header` | First 200 B | "no video stream" | ✅ Refused at **confirm**, with the reason |
| `corrupt-not-a-video` | Text renamed `.mp4` | refuses | ✅ Refused at confirm. ⛔ **This file found [V-5]** — the error body carried a presigned credential |
| `corrupt-audio-only` | Valid MP4, audio only | probes OK, no video | ✅ Refused — ⚠️ a valid container is not a video, and a probe checking only "did ffprobe exit 0" accepts this |
| `corrupt-truncated-tail` | Last 40 % cut | probes OK, **misreports 30 s** | ⭐ **Analysed 28 of a claimed 60 frames and ended honestly.** It did not fabricate the frames the header promised |
| `corrupt-bitflips` | 64 deterministic byte flips | probes OK | ✅ Decoded with artefacts: 60 frames, 4 events, 3 tracks (fragmentation from corruption) |

⚠️ The corruption is **deterministic** (fixed seed). A corruption test that cannot be reproduced is
an anecdote.

## The duration ladder

Built on demand by `tools/dataset/large.mjs`, **not committed**. Duration and size are separate axes
and conflating them makes a failure uninterpretable: duration decides analysis time, size decides
upload time.

| id | Length | Size | Frames @ 2 fps | Measured analysis |
| --- | --- | --- | --- | --- |
| `duration-1min` | 60 s | 0.15 MB | 121 | 4.1 s (×8.8) |
| `duration-5min` | 300 s | 0.75 MB | 600 | 29.6 s (×9.1) |
| `duration-10min` | 600 s | 1.50 MB | 1 200 | 63.2 s (×9.0) |
| `duration-30min` | 1 800 s | 4.51 MB | 3 600 | 197.1 s (×9.0) |
| `duration-60min` | 3 600 s | ~9 MB | 7 200 | not run |

⛔ **2 GB and 5 GB are not generated.** The ceiling is checked against the *declared* size before a
byte moves, so the boundary is tested in milliseconds. What that does not test is a real
multi-gigabyte transfer — multipart behaviour, proxy body limits, token expiry mid-upload. Recorded
as **[L-66]**, not claimed on a 30 MB file's behalf.

---

## ⛔ Required and missing: six real-venue recordings

Everything about detector accuracy is blocked behind these. They are listed as **unmet
requirements**; approximating any of them would be worse than not having it.

| id | What | Why it cannot be synthesised | What it unblocks | Consent |
| --- | --- | --- | --- | --- |
| `real-shop` | Retail floor, fixed overhead, 10 min business hours | Real subjects at real scale; glass and polished-floor reflections | Retail accuracy; loitering false-positive rate | Store footage-use agreement; faces blurred or a private fixture repo |
| `mall-concourse` | Concourse, wide, heavy footfall, 10 min peak | Genuine crowd density and mutual occlusion — what `crowd` only gestures at | Crowd counting; the NMS question | Centre management; public-space signage |
| `warehouse` | Aisle with forklift + pedestrians, 15 min | Vehicle/person discrimination; high-ceiling perspective | Any pedestrian–vehicle safety claim | Site operator; works-council notice where required |
| `hospital-corridor` | Mixed staff and public, 10 min | Uniform-heavy scenes, trolleys, long thin geometry | Healthcare deployment claims | ⛔ **Highest bar — patient privacy.** Likely a staged re-enactment on a real ward, not live footage |
| `factory-floor` | Production line, machinery in motion, 15 min | Persistent non-human motion — the largest false-positive source in industrial installs | Industrial claims; moving-machinery FP rate | Site operator |
| `parking-area` | Outdoor, day→dusk, 30 min | Real low-light transition, headlights, weather | Outdoor/overnight claims — the honest version of `night-footage` and `rain` | Site operator; ANPR rules in some jurisdictions |

### Acceptance for a procured recording

1. Consent on file **before** the bytes enter the repository or any bucket.
2. `.mp4`, H.264 or H.265, ≥ 640×360, ≥ 5 fps.
3. **Ground truth by human annotation** — per-frame person counts for at least a 60 s sample. Without
   it the clip can be *observed* but nothing can be *asserted*, which is the whole reason the
   synthetic library exists.
4. Recorded in [DEMO_VIDEO_LIBRARY.md](DEMO_VIDEO_LIBRARY.md) with duration, resolution, fps, ground
   truth and known limitations.
5. ⚠️ Stored **outside this repository** if it contains identifiable people.

---

## Related

- [TEST_PLAN.md](TEST_PLAN.md) — which test uses which clip
- [DEMO_VIDEO_LIBRARY.md](DEMO_VIDEO_LIBRARY.md) — the same clips organised for a customer demo
- [FIRST_PRODUCT_VALIDATION.md](FIRST_PRODUCT_VALIDATION.md) — what they found
- `tools/dataset/scenarios.mjs` — the catalogue; `generate.mjs` — the generator
