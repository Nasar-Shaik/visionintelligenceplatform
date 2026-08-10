# Footage acquisition and annotation plan — P3.1

**2026-08-10.** What to record, in what order, and what to annotate — so that the detector benchmark
can eventually answer the question it is built to ask.

> ⛔ **This is the critical path of Phase 3, and it is not a code task.** The benchmark lab is built
> and runs. It cannot produce a detector verdict, because 0 of 31 required scenarios are covered by
> real footage. Every hour spent on models before this is spent measuring rasterisation.

---

## 1. Why the existing corpus cannot answer

| | |
| --- | --- |
| Clips in the fixture library | 38 |
| **Authored** (rendered shapes, not people) | **31** |
| Derived from photographs | 1 |
| Damaged-file transport fixtures | 6 |
| **Video of real people** | ⛔ **0** |
| Cases carrying ground-truth annotations | ⛔ **0** |

⚠️ **The authored fixtures are not waste and must not be deleted.** They are the *right* instrument
for the questions they were built for — "does one subject hold one track id across a full crossing"
has a known answer by construction, which real footage cannot give without annotation. They are the
wrong instrument for "does this detector see a person", because there is no person.

`benchmark_corpus.py` enforces this: a scenario backed only by `AUTHORED`, `SYNTHETIC` or
`PHOTOGRAPH` material is capped at `PARTIAL` and **cannot** reach `AVAILABLE`.

---

> ⭐ **The ingest path is built and executable** — see `REAL_FOOTAGE_INGEST.md`. A clip is declared
> with `real_footage_cli.py --register`, which refuses to proceed without a consent record, a capture
> device and a date. Nothing below is blocked on tooling.

## 1b. The controlled capability list (2026-08-11)

The required initial controlled footage, as scenarios the corpus reports. ⚠️ All 41 are enumerated by
`benchmark_corpus.SCENARIOS`; these are the ones the Architect named for the first shoot.

| Group | Scenarios |
| --- | --- |
| Orientation | `front-facing-person` · `side-facing-person` · `rear-facing-person` |
| Posture | `person-standing` · `person-sitting` · `person-bending` · `hands-raised` |
| Movement | `normal-person` (walking) · `person-entering-frame` · `person-leaving-frame` · `approach-recede` |
| Occlusion | `partially-occluded-person` |
| Objects | `backpack` · `bottle` · `cup` |
| Handling | `object-pickup` · `object-putdown` · `person-carrying-object` |
| Interaction | `two-person-interaction` · `handover` |
| Geometry | `zone-crossing` · `line-crossing` |

⛔ **The posture group is footage to record now and score later.** No pose model is authorised, and
declaring these scenarios does not authorise one. They are observations of body configuration —
never intent — and recording them before the model exists is what makes the eventual model
measurable on day one rather than six weeks after it lands.

⭐ Many collapse into one shoot: a single continuous take of a person walking in, standing, sitting,
bending to pick up a bottle, carrying it across a marked line and out of frame covers eleven of them
with consistent lighting and one consent record.

## 2. Acquisition checklist — priority order

Ordered by **how many dormant capabilities each unblocks**, not by how easy it is to film.

| # | Clip | Unblocks | Notes |
| --- | --- | --- | --- |
| 1 | **Person carrying a bag / bottle / backpack** | ⭐ 4 primitives that have never had real input (`dropped`, `objectMissing`, `objectReturned`, `handover`) + 7 object scenarios | The single highest-value recording. 30–60 s, one person, one clearly visible object |
| 2 | **Two-person handover** | `handover`, `two-person-interaction`, `object-pickup`, `object-return` | Person A carries an object, hands it to B, B walks away with it |
| 3 | **Two people reaching for one object** | `two-people-one-object` | ⚠️ The documented ambiguity case `AssociationModule` has warned about since it was written and which has never been checked against reality |
| 4 | **Person partially occluded behind a shelf** | `shelf-occlusion`, `partially-occluded-person` | The retail-specific occlusion; a pillar or doorway is not the same geometry |
| 5 | **Person walking, real camera** | `normal-person`, `person-leaving-frame`, `re-entry` | The baseline every other measurement is relative to |
| 6 | **Multiple people, independent paths** | `multiple-people`, `two-person-interaction` | 3–5 people, crossing paths |
| 7 | **Person at 2 m, 5 m, 10 m, 20 m** | `distant-person`, `close-person` | ⭐ One continuous walk toward the camera gives all four in one clip |
| 8 | **Side-facing and rear-facing person** | `side-facing-person`, `rear-facing-person` | A person who never faces the lens — the common CCTV case and a known detector weakness |
| 9 | **CCTV-like framing** | `low-resolution-cctv`, `top-down-view`, `low-angle-view` | High mount, wide angle, downsampled to 640×360 and 320×180 |
| 10 | **Backlighting** | `backlighting` | Subject against a window or doorway — the classic false-negative condition |
| 11 | **Low light** | `poor-lighting` | Real sensor noise, which rendering cannot imitate |
| 12 | **Portrait video** | `portrait-video` | Phone held vertically; the aspect ratio the letterbox path handles least |
| 13 | **4K** | `4k` | The corpus tops out at 1080p; downscaling behaviour is untested |
| 14 | **Small merchandise** | `small-merchandise` | Items smaller than a handbag — where the 3.7 MB detector is expected to fail, and that failure needs to be *measured* rather than assumed |

### Recording notes

- ⚠️ **Consent and lawful basis before anything else.** These are recordings of identifiable people.
  Filming colleagues who have agreed in writing is the simple path; anything in a public place is a
  data-protection question, not a technical one.
- Fixed camera, 30 s–2 min per clip, no cuts. A moving camera confounds tracking with detection.
- Record at the highest quality available and **downscale in post** — a 4K master gives the 4K,
  1080p, 640×360 and 320×180 cases from one shoot.
- Note the ground truth **while filming**: how many people, what objects, when the handover happens.
  ⭐ Reconstructing that later from the footage costs many times more than saying it at the time.

---

## 3. Annotation plan

Ground truth is what unlocks **precision, recall, false positives/negatives and IoU** — none of which
may be reported without it. ⛔ Annotating everything is not proposed: it is expensive and most of it
would not change a decision.

### Tier 1 — box-level, per frame (annotate first)

Only clips **1, 2, 5, 7, 8** above. These are what a detector comparison turns on.

```
{ "caseId": "...", "fps": 2.0,
  "frames": [ { "frameIndex": 0,
                "boxes": [ { "label": "person", "bbox": [x, y, w, h], "occluded": false } ] } ] }
```

- Normalised `[x, y, w, h]`, matching `HistoryPoint.bbox` — ⚠️ the same convention as the runtime,
  so a comparison needs no transform that could itself be wrong.
- `occluded` per box, because recall on occluded subjects is a different question from recall.
- **Annotate at the benchmark's sampling rate (2 fps)**, not at native frame rate. At 30 s that is 60
  frames per clip — about 45 minutes of careful work each, and it is the honest denominator.

### Tier 2 — event-level (cheap, high value)

Every clip. A handful of timestamps rather than boxes:

```
{ "caseId": "...", "events": [ { "atSeconds": 12.5, "kind": "handover",
                                 "from": "person-a", "to": "person-b", "object": "backpack" } ] }
```

⭐ This is what scores the **behaviour** layer rather than the detector — "did the platform report a
handover within ±2 s of the real one" — and it is the measurement that answers *"did this improve
VIP"* rather than *"did this model run"*. It costs minutes per clip.

### Tier 3 — not planned

Segmentation masks and pose keypoints. ⚠️ No consumer exists in the platform yet, and P3.1's
acceptance criteria require a consumer before a model is added. Revisit at P3.3/P3.4.

---

## 4. When footage arrives

1. Add each clip to `infra/docker/fixtures/media/validation/` with its licence and provenance.
2. Declare it in `ai/inference/benchmarks/detector-corpus.json` with `"footageKind": "REAL_FOOTAGE"`
   and the scenarios it genuinely exercises.
3. ⛔ `tests/test_benchmark_corpus.py::test_no_case_is_real_footage_today` **will fail** — that is
   deliberate. It is the tripwire that says the corpus has changed character, and the signal to
   re-run the benchmark and revisit every conclusion drawn from the authored one.
4. Run the **identical** command. ⚠️ No methodology change, or the before and after are not
   comparable:

   ```
   docker run --rm -v <fixtures>:/opt/vip/fixtures/media:ro -v <models>:/opt/vip/models:ro \
     -v <out>:/out vip/inference:local \
     python /app/detector_benchmark_cli.py --models yolox-nano,rtdetr-r18vd --out /out
   ```

5. Only then may a detector conversation begin — and only for scenarios the report marks
   `AVAILABLE`.
