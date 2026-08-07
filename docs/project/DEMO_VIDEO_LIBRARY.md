# Demo Video Library

> **The recordings to demonstrate with, organised by the story they tell.** Every figure below was
> measured against the deployed stack on 2026-08-07 — not estimated, and not aspirational.

Generate with `node tools/dataset/generate.mjs --verify`. Technical detail:
[TEST_DATASET.md](TEST_DATASET.md).

---

## ⛔ What to say before you play anything

Every clip here is **real person pixels on authored motion** — crops from a CC0 photograph,
composited onto a synthetic background along a scripted path.

> **"These are synthetic recordings. They prove the platform handles video correctly end to end.
> They do not tell you how well it will detect people in *your* building — that is what the pilot
> is for."**

⛔ Saying this **first** costs nothing. Being asked it later, after a customer has assumed otherwise,
costs the relationship. And there is a second reason it is honest: the platform genuinely performs
better on these than it will on real footage, because a composited sprite is easier to detect than a
person under a real lens.

The venue-specific footage that *would* answer the accuracy question does not exist —
[six recordings are required and unmet](#-what-this-library-cannot-do).

---

## Retail

| Clip | Duration | Res | FPS | Ground truth | Measured result | Use it to show |
| --- | --- | --- | --- | --- | --- | --- |
| `retail-loitering` | 60 s | 640×360 | 15 | 1 person, dwell ≈ 45 s | 120 frames · 6 events · 1 track · 2 incidents | ⭐ **The strongest retail story.** Somebody arrives and does not leave; a dwell rule fires **once**, not once per frame |
| `counter-monitoring` | 30 s | 640×360 | 15 | 2 (staff + customer) | 60 frames · 6 events · 2 tracks | "Someone is present" vs "someone approached" — different questions |
| `queue-formation` | 30 s | 640×360 | 15 | 4 people | 60 frames · 12 events · **4 tracks** | Counting plus persistence |
| `multiple-people` | 30 s | 640×360 | 15 | 2 crossing | 60 frames · 6 events · **2 tracks** | Identities survive a crossing — no swap |

**Known limitations:** ⛔ Detects *a person dwelling*, not *theft*. Loitering is geometry and time,
never intent ([L-2]).

## Warehouse · Factory · Hospital · Office

⛔ **There is no footage for any of these.** The four venue recordings that would support them are
[unmet requirements](#-what-this-library-cannot-do).

The nearest honest substitutes, and you must say they are substitutes:

| Story | Substitute | Ground truth | ⛔ What it does not show |
| --- | --- | --- | --- |
| Warehouse aisle safety | `restricted-zone` | 1 person entering a marked area | No forklift, no vehicle/person discrimination, no high-ceiling perspective |
| Factory floor | `camera-shake` | 1 person, frame ±10 px | ⛔ **No machinery.** Persistent non-human motion is the largest false-positive source in industrial installs and nothing here contains any |
| Hospital corridor | `queue-formation` | 4 people receding | No trolleys, no uniforms, no corridor perspective |
| Office / after hours | `night-footage` | 1 person, low light | Not a real low-light sensor |

## Theft · Loitering · Restricted area

| Clip | Ground truth | Measured | ⛔ Say this |
| --- | --- | --- | --- |
| `retail-loitering` | 1 person, 45 s dwell | 2 incidents | Dwell is **not** intent |
| `restricted-zone` | 1 person crossing into a marked area | 60 frames · 3 events · 1 track | The zone is configured on the camera; the red rectangle is only drawn so you can see it |
| — theft — | ⛔ **No clip, and there will not be one** | — | ⛔ **The platform does not detect theft** ([L-2]). Any demo suggesting it does is a misrepresentation |

## Crowd

| Clip | Ground truth | Measured | Use it to show |
| --- | --- | --- | --- |
| `crowd` | 8 people, overlapping, mixed depth | 60 frames · **24 events · 8 tracks** | ⭐ **The best "it really is tracking" demo.** Eight distinct identities, each with its own span |

> ⭐ **The story worth telling here.** Before P-8.5 this clip produced **3 events and 0 tracks** —
> the same as a single person walking. Eight people were indistinguishable from one. Two defects
> ([V-2], [V-4]) were found by running exactly this and asking why the number looked wrong.

**Known limitation:** eight overlapping sprites is not a real crowd. Genuine mutual occlusion at
mall density is `mall-concourse`, which does not exist.

## Fire · Smoke · Violence

| Story | Status |
| --- | --- |
| Fire, smoke | ⚠️ The runtime **detects** these classes; there is **no clip** in this library. Do not improvise one |
| Violence, fights, falls, PPE | ⛔ **Not detected at all** ([L-2]). There is no demo and there should not be one |

## Camera and capture conditions

Use these when a customer asks *"what about our cameras?"*

| Clip | Property | Measured | Shows |
| --- | --- | --- | --- |
| `res-180p` … `res-1080p` | 320×180 → 1920×1080 | 1 person each | Resolution independence |
| `codec-h264` / `codec-h265-hvc1` | avc1 / hvc1 | 1 each | Codec support |
| `codec-h265-hev1` | hev1 tag | 1 | ⛔ **Do not demo in Safari** — WebKit cannot play it ([TD-29]) |
| `low-fps` | 1 fps source | 1 | ⭐ Asked for more frames than exist; provenance stays honest rather than interpolating |
| `high-fps` | 30 fps source | 1 | Decimation to exactly the requested rate |
| `blur` | σ 3.5 | 1 | A dirty dome — the commonest real camera fault |
| `angle-wide` | Barrel distortion | 1 | Wide-angle lens |

## ⭐ Honesty and robustness

**These are the most valuable clips in the library for winning a serious buyer**, because anyone can
demo a system finding something.

| Clip | Measured | Why it matters |
| --- | --- | --- |
| `empty-scene` | **0 detections · 0 events · 0 incidents**, and the UI says *"Nothing was detected in this recording"* | ⭐ **The one to lead with.** It proves the platform does not invent. A false alarm on an empty shop destroys trust permanently, and no accuracy elsewhere buys it back |
| `corrupt-not-a-video` | Refused, reason named, **no credential leaked** | Bad input is refused with something an operator can act on |
| `corrupt-truncated-tail` | Header claims 30 s; **28 real frames analysed**, ended honestly | ⭐ It did not fabricate the frames the header promised |
| Rerun any clip twice | Identical: 20 events · 5 tracks · 10 incidents both times | Reproducible — a rule change next month can be compared against today, not overwrite it |

---

## Suggested 15-minute demonstration

| # | Clip | Minutes | Say |
| --- | --- | --- | --- |
| 1 | — | 2 | The limitations above. **First.** |
| 2 | `retail-loitering` | 3 | Upload → analyse → incident → **Capture still**. The whole product in one pass |
| 3 | `crowd` | 2 | Eight people, eight identities |
| 4 | `empty-scene` | 2 | ⭐ Nothing found, and it says so |
| 5 | rerun #2 | 2 | Identical, independent, non-destructive |
| 6 | `corrupt-not-a-video` | 2 | Refused with a real reason |
| 7 | Demonstrate at real time | 2 | Same pipeline, one parameter |

⚠️ **Do not** improvise with the customer's own footage on a first demo. You will not know the ground
truth, so you cannot tell a miss from a correct absence — and neither can they.

---

## ⛔ What this library cannot do

Six recordings are required and do not exist. **Every claim about detection accuracy in a real venue
is blocked behind them** — see [TEST_DATASET.md](TEST_DATASET.md#-required-and-missing-six-real-venue-recordings).

| Missing | Blocks |
| --- | --- |
| `real-shop` | Retail accuracy; loitering false-positive rate |
| `mall-concourse` | Crowd counting at real density |
| `warehouse` | Any pedestrian–vehicle safety claim |
| `hospital-corridor` | Healthcare deployment claims |
| `factory-floor` | Industrial claims; moving-machinery false positives |
| `parking-area` | Outdoor and overnight claims |

Until they exist, the honest sentence is: **"The pilot is the validation."**

---

## Related

- [TEST_DATASET.md](TEST_DATASET.md) · [CUSTOMER_ACCEPTANCE_CHECKLIST.md](CUSTOMER_ACCEPTANCE_CHECKLIST.md)
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) · [CUSTOMER_JOURNEYS.md](CUSTOMER_JOURNEYS.md)
