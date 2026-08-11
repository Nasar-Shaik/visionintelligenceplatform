# Controlled recording protocol — P3.2c

**2026-08-11.** The smallest session that covers the twenty required capabilities. ⭐ **One planned
recording, not twenty unrelated ones**: a single setup keeps lighting, lens, mounting and consent
constant, so a difference between two clips is a difference in *behaviour* rather than in the camera.

> ⛔ **Nothing here is blocked on code.** The ingest, verification and scoring path is built and
> tested (`REAL_FOOTAGE_INGEST.md`). This document is what somebody takes to the room.

---

## 1. Capture settings — record once, downscale later

| Setting | Value | Why |
| --- | --- | --- |
| **Resolution** | **3840×2160 (4K)** master | ⭐ One master yields the 4K, 1080p, 640×360 and 320×180 cases by downscaling. Re-shooting for resolution is the most avoidable waste in the plan |
| **Frame rate** | **30 fps**, fixed | The benchmark samples at 2 fps; a variable rate makes `frameIndex` mean different instants in different clips |
| **Orientation** | **Landscape** for takes 1–7, **portrait** for take 8 | Portrait is a real deployment case (phone-mounted) and the aspect the letterbox path handles least |
| **Camera** | **Fixed. Tripod, no pan, no zoom, no autofocus hunting** | ⛔ Camera motion confounds tracking with detection and makes every trajectory primitive meaningless |
| **Height / angle** | 2.2–2.5 m, angled down ~15–20° | The CCTV geometry the platform is for. ⚠️ Eye-level footage is the one thing that will *not* transfer |
| **Lighting** | Ordinary indoor, lights on, blinds open | This is a *function* test, not a robustness test. Backlighting and low light are separate later takes |
| **Exposure / WB** | **Locked** | Auto-exposure re-metering mid-take changes apparent contrast and silently changes detector behaviour |
| **Duration** | 45–90 s per take, no cuts | Long enough for tracking to establish and for a subject to leave and re-enter |
| **Audio** | Off | Not used, and it is personal data with no purpose — collecting it would be gratuitous |

**Recorded per take, at capture time:** device and lens, height, angle, distance markers, who is in
frame, what objects, and the wall-clock start. ⭐ Reconstructing this from the footage later costs
many times more than saying it out loud while filming.

---

## 2. The room

```
        ┌─────────────────────────── 6 m ───────────────────────────┐
        │                                                            │
        │   [TABLE]                              ░░ ZONE A ░░        │   ← shelf/table with
        │      ▲                                  (taped floor)      │     bottle + backpack
        │      │                                                     │
        │  ════╪══════════════ LINE L (taped) ══════════════════     │   ← the counting line
        │      │                                                     │
        │   entry ►                                        ◄ exit    │
        └────────────────────────────────────────────────────────────┘
                                  ▲
                             CAMERA (2.2–2.5 m, ~15–20° down)
```

⚠️ **Tape the zone and the line before recording, and photograph the layout.** `zone-crossing` and
`line-crossing` are only meaningful if the geometry configured in the platform matches the floor —
otherwise the ground truth is a guess about where the line "was".

Mark distances at **2 m, 5 m, 10 m** from the camera for the `distant-person` / `close-person` pair.

---

## 3. The takes

Eight takes cover all twenty capabilities. **Take 1 alone covers eleven.**

### Take 1 — the spine (one person, ~90 s, continuous)

| # | Action | Hold | Covers |
| --- | --- | --- | --- |
| 1 | Walk in from the left edge | — | `person-entering-frame`, `normal-person` |
| 2 | Stop mid-frame, face the camera | 5 s | `front-facing-person`, `person-standing` |
| 3 | Turn 90° left, still | 5 s | `side-facing-person` |
| 4 | Turn 90° again, back to camera | 5 s | `rear-facing-person` |
| 5 | Walk toward the camera to the 2 m mark, then back to 10 m | — | `approach-recede`, `close-person`, `distant-person` |
| 6 | Raise one hand, then both, above the head | 5 s | `hands-raised` |
| 7 | Sit on a chair, facing camera | 8 s | `person-sitting` |
| 8 | Stand, walk to the table, **bend** to the bottle | 5 s | `person-bending` |
| 9 | **Pick up** the bottle | — | `object-pickup`, `bottle` |
| 10 | Carry it across **LINE L** into **ZONE A** | — | `person-carrying-object`, `line-crossing`, `zone-crossing` |
| 11 | **Put it down** in Zone A | — | `object-putdown` |
| 12 | Walk out of the right edge | — | `person-leaving-frame` |

### Takes 2–8

| Take | Content | Covers |
| --- | --- | --- |
| **2** | Same spine with a **backpack** worn, then removed and set down | `backpack`, `object-pickup`, `object-putdown` |
| **3** | **Two people**: A carries the bottle, meets B mid-frame, **hands it over**, B carries it out | `two-person-interaction`, `handover` |
| **4** | Person walks behind the table so the **lower body is hidden**, pauses, continues | `partially-occluded-person`, `shelf-occlusion` |
| **5** | Person **leaves the frame and returns** after 5 s | `re-entry` |
| **6** | 3–5 people crossing independently | `multiple-people`, `crowd` |
| **7** | ⚠️ **Both people reach for the same bottle at once** | `two-people-one-object` — the ambiguity `AssociationModule` has warned about since it was written and which has never been checked against reality |
| **8** | Take 1's spine again, **phone held portrait** | `portrait-video` |

⭐ Takes 1, 3 and 4 are the three that matter most. If the session is cut short, record those.

---

## 4. ⛔ Before anyone is recorded

1. **Written consent from every person in frame**, naming: what is recorded, that it is used for
   testing a detection system, where it is stored, how long it is kept, and how to withdraw it.
2. Store the consent record at `docs/validation/consent/<date>-<session>.md` — ⚠️ the *record*, not
   the signatures or anyone's contact details.
3. `--consent` on registration references that file. The tool refuses to register without it.
4. **A closed room with participating colleagues only.** Anyone incidentally in frame has not
   consented, which makes the clip unusable rather than merely awkward.
5. ⛔ The footage never enters the repository. `.data/real/` is git-ignored.

---

## 5. After the session

```
python3 real_footage_cli.py --register .data/real/take-01.mp4 \
    --clip-id take-01-spine \
    --scenarios normal-person,front-facing-person,side-facing-person,rear-facing-person,\
person-standing,person-sitting,person-bending,hands-raised,person-entering-frame,\
person-leaving-frame,approach-recede,close-person,distant-person,bottle,object-pickup,\
object-putdown,person-carrying-object,line-crossing,zone-crossing \
    --consent docs/validation/consent/2026-08-12-session-1.md \
    --device "iPhone 15 Pro, tripod 2.3 m, ~18° down" \
    --captured-at 2026-08-12 --write

python3 real_footage_cli.py --verify
```

Then annotate **take 1, 3 and 4 first** at **2 fps** — the benchmark's sampling rate, so `frameIndex`
means the same instant on both sides. See `ANNOTATION_SCHEMA.md`.

⚠️ At 90 s and 2 fps a take is **180 annotated frames**. Budget ~2 hours per take for Tier-1 boxes.
⛔ That cost is the reason the protocol is eight takes and not twenty.
