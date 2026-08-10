# Object association — the verification, and the one number that had switched it off

`carry_object · pick_object · drop_object · object_missing · object_returned · approach_object ·
leave_object · handover`

Measured against the deployed stack at `https://localhost`, 2026-08-10. Every number below came from
the built images and real pixels. **Nothing was simulated.**

---

## ⭐ Status: EXECUTED — and the reason it never had been is not what this document used to say

Two milestones of this document said **PENDING FOOTAGE**: *"no clip contains an object."* That was
one of four possible explanations for an absence, and it was **wrong**.

| candidate explanation | how it was tested | result |
| --- | --- | --- |
| no footage contains a carriable object | 30 real photographs that plainly do | ⛔ **false** |
| the object is too few pixels at CCTV scale | the same photographs at 1920 px, and cropped to the person | ⛔ **false** — cropped so a hiker fills the frame, still nothing |
| the model cannot do these classes | the same weights, floor dropped to 0.02 | ⛔ **false** — every class scores |
| **the confidence floor discards them** | compare the scores against the floor | ⭐ **this was it** |

⛔ **`minConfidence: 0.5` was chosen for `person` and applied to all eighty COCO classes.** The
deployed detector scores a person up to **0.919** and a real suitcase at **0.456**. Four of the five
carriable classes had **zero** detections admitted, ever — and that renders identically to a world in
which nobody has ever carried anything past a camera.

---

## 1. Measured: what the detector actually scores

`ai/mlops/probe_classes.py` against the pinned corpus in [`object-corpus.json`](object-corpus.json) —
30 CC0/public-domain photographs chosen for a carried object, and 42 frames of authored fixture
footage as the negative control. ⭐ It calls `model_formats.preprocess()` and `get_decoder()`, the same
two functions the ONNX adapter calls in production, so it cannot disagree with the runtime about what
the model saw.

| class | seen | strongest score | old floor | admitted, old | **new floor** | admitted, new |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `cup` | 5 | 0.8652 | 0.50 | 3 | **0.20** | 5 |
| `suitcase` | 8 | 0.4558 | 0.50 | **0** | **0.20** | 4 |
| `bottle` | 3 | 0.4456 | 0.50 | **0** | **0.20** | 2 |
| `handbag` | 11 | 0.4079 | 0.50 | **0** | **0.20** | 4 |
| `backpack` | 10 | 0.3376 | 0.50 | **0** | **0.20** | 5 |
| `person` | 40 | 0.9194 | 0.50 | 34 | 0.50 — *unchanged* | 34 |

### ⛔ Why 0.20, and what it costs

The floor is a claim about a measurement, so the measurement decided it. Against 42 frames of
**authored** footage, where no carriable object exists by construction:

| floor | on-target photographs recovered | false positives on object-free footage |
| --- | ---: | ---: |
| 0.15 | 11 / 30 | **1** ⛔ a `backpack` on footage containing no object |
| **0.20** | **9 / 30** | **0** |
| 0.25 | 6 / 30 | 0 |
| 0.30 | 5 / 30 | 0 |

**0.20 is the highest recall at zero observed false positives**, sitting 0.045 above the strongest
false positive measured (`backpack` 0.1554).

⚠️ **Recall is poor and is stated as poor.** Nine of thirty. This recovers the capability from zero;
it does not make `yolox-nano` a carried-object detector, and the other twenty-one remain invisible.
That remainder is a detector problem and it is Phase 3 work.

⚠️ **Real crowd photographs are not valid negative controls, and were not used as one.** A control
image scored `handbag` at 0.4079; inspection found a real white shopping bag in it. Crowds carry
things, so a real-world scene can never bound a false-positive rate for a carried object. Only
authored footage can.

### ⚠️ The fix is per-class calibration, not "lower the floor"

`minConfidenceByLabel` in the capability manifest. **Absent by default, and an empty map behaves
exactly as before** — a deployment that never declares one keeps the floor it was certified with.
`person` is untouched, so no existing person-based capability changes behaviour. The field raises a
floor as readily as it lowers one: a deployment drowning in false `tie` detections raises that one
and nothing else. A malformed entry **raises** rather than being skipped, because an entry silently
dropped would leave the class on the default and reproduce this exact defect.

---

## 2. Measured: the association path, end to end, on real detections

`infra/docker/fixtures/media/validation/carried-objects.mp4` — a slow pan across a **CC0 photograph**
of a person carrying shopping bags through a car park.

⛔ **The pixels are real and the motion is authored.** Nobody picks anything up in a photograph. This
certifies the *chain* on real multi-class detections. It does **not** certify pick-then-drop on real
human motion, and that remains **PENDING FOOTAGE** — see § 5.

### The controlled before-and-after

Identical footage, identical code, identical everything except the manifest floors. The runtime was
rebuilt to the pre-slice-2.10 manifest, the clip re-analysed, and the reads compared with
`tools/validation/association-replay.mjs`.

| | before — one 0.50 floor | after — per-class 0.20 |
| --- | ---: | ---: |
| object records tracked | **0** | 2 (`suitcase`, `backpack`) |
| carriable objects reaching the association layer | **0** | 3 |
| association spans | **0** | **3** |
| `carried` timeline entries | **0** | **3** |
| `picked` timeline entries | **0** | **3** |
| graph `carried` / `picked` edges | **0 / 0** | **3 / 3** |
| rule *"carried something"* | **0 candidates** | **1 candidate** |
| rule *"carried nothing"* (the control) | 1 candidate | **0 candidates** |
| `person` identities | 1 | **1 — unchanged** |

⭐ **`person` unchanged is half the evidence.** A run in which both moved would have meant the floor
had leaked into the class it was never meant to touch.

⛔ **What the pre-fix platform said, verbatim:** *"carried did not happen — 0 fact(s) of that kind
were examined."* Completely honest, completely correct, and indistinguishable from a shop where
nobody carried anything for three milestones.

### The chain, named at each hop

```
real photograph ─▶ detector: suitcase 0.34 · backpack 0.34 · person 0.87
                └▶ tracker: object identities, 7–8 points each
                 └▶ associations(): 3 spans, heldBy a real person identity
                  └▶ object_events(): picked ×3
                   └▶ timeline: carried 3 · picked 3
                    └▶ graph: object nodes 4 · carried edges 3 · picked edges 3
                     └▶ reasoning: "carried — suitcase … at 0 s for 1.75 s"
                      └▶ console: 3 rows, the runtime's own sentence, verbatim
```

⚠️ **The detector labels the shopping bags `suitcase` and `backpack`.** They are neither. The
mislabelling is recorded rather than corrected: the association primitive asks only whether the thing
is carriable, and a platform that renamed a detector's output to suit the scene would be inventing
perception it does not have.

---

## 3. ⭐ The diagnostic: silence with a reason attached

`associationDiagnostic`, published on every `/api/behaviour/primitives` read, exists because **four
completely different situations render identically as "no association"**:

| `reason` | what happened | who should act |
| --- | --- | --- |
| *(absent)* | a span was produced | — |
| `no-objects-detected` | the detector returned nothing carriable | the detector, or the footage |
| `no-carriable-objects` | objects were tracked and nobody carries one (a car, a bench) | nobody — this is correct |
| `never-observed-together` | object and person never share a frame timestamp | ⚠️ a **timing** fault, not a distance one |
| `never-close-enough` | they shared frames and never came within reach | nobody — a fact about the scene |
| `no-span-formed` | they were near and no span appeared | ⛔ a defect; report the run |

It also publishes `closestNormalized` — how far the scene was from associating, which is the one
number that separates *nearly* from *not remotely*. ⛔ It is **omitted rather than zeroed** when
nothing was ever observed together: `0.0` is the one value that means "touching" (ADR-0039).

`tools/contracts/perception-boundary.mjs` **§K** asserts every reason the runtime can produce is one
the contract accepts, across the two languages — because a reason the console cannot render puts the
operator back in front of silence, which is the failure the field exists to end.

### The narrowing that came with it

⛔ On the first real multi-class run the association layer's input was `["backpack", "car",
"suitcase"]`. "Object" had meant *any label that is not a subject* since slice 2.2, so a **parked
car** was sitting in the population `associations()` scans, one proximity away from the sentence
*"this person carried a car."*

⚠️ **It did not produce that span, and the distinction is the honest one.** The car never came within
`NEAR_THRESHOLD` of the walker. What was wrong is that only the geometry stood between the platform
and the claim — and in a car park, a walker passing close to a car is not an unusual event, it is the
whole scene. `DEFAULT_CARRIABLE_LABELS` removes the possibility rather than an observation, and the
car remains a tracked object for every primitive that is about proximity.

---

## 4. ⛔ BLOCKER: a subject still in shot when a run ends is never stored

**Found by this slice, pre-existing, and larger than it.**

| | |
| --- | --- |
| Symptom | the same run answers `carried: 3, picked: 3` at one minute and `observed: 2` at ten |
| Measured | across **three** separate runs of the same clip, the person identity was **never** present in durable track history |
| The read at the time | `sources: { durable: 2, live: 3 }` — the subject was only ever live |
| The read later | `sources: { durable: 2, live: 0 }` — the subject is gone from every read |
| Was it a write failure? | ⛔ **no.** `inference_track_history_write_failures_total 0`. Nothing failed; nothing was ever attempted |
| Does a later run rescue it? | ⛔ no — a subsequent analysis on the same camera did not retire it |

⚠️ **The likely mechanism, stated as a hypothesis rather than a finding.** Retirement has two paths,
`retire_stale` (footage-time ageing) and `_sweep`/`_close_history` (wall-clock idle), and *both run on
the frame path* — `"Runs on the update path — no timer, no thread."` A stream that has stopped
sending frames is exactly the stream whose subjects need retiring, and it is the one case nothing
drives. Confirming that is the first task of the slice that fixes it.

⛔ **Why this matters more than the defect it was found beside.** It is not a perception problem, it
is an **evidence-integrity** problem: an investigation opened an hour after an incident shows fewer
facts than the same investigation opened immediately, and nothing on the screen says anything was
lost. A subject continuously visible to the last frame — the most present person in the footage — is
the one most likely to disappear.

⚠️ It also shapes the test suite: `tools/e2e-browser/test/association.spec.ts` analyses **per test**
rather than once, and the comment there says why. A suite that analysed once would fail on whichever
test ran last, and the failure would look like a console defect.

---

## 5. What is still PENDING FOOTAGE, precisely

⭐ The list is much shorter than it was, and each line now names a *specific* uncertainty rather than
"we have no footage".

| capability | state |
| --- | --- |
| a carriable class detected, tracked, associated, and readable end to end | ⭐ **executed on real detections** |
| `picked` | ⭐ executed — an object began travelling with a person |
| `carried` | ⭐ executed |
| `handover` between two people | ⛔ **PENDING FOOTAGE** — needs two people and one object |
| `dropped` on real human motion | ⛔ **PENDING FOOTAGE** — a photograph cannot put something down |
| `object_missing` / `object_returned` | ⛔ **PENDING FOOTAGE** — needs a real occlusion of a real object |
| the ambiguity case — two people reaching at once | ⛔ **PENDING FOOTAGE**, and `AssociationModule`'s own docstring has warned about it since slice 2.2 |

⚠️ **What a single 30–60 s recording would settle.** One person enters, picks a bottle off a surface,
carries it while walking, hands it to a second person, who puts it down and leaves. That one clip
closes every row above. See [OBJECT_FOOTAGE.md](OBJECT_FOOTAGE.md); save to `.data/real/<name>.mp4`,
which is git-ignored because it is real footage of real people.

---

## 6. The harness

```bash
# the corpus: fetch and verify against the checksums the published numbers were measured on
node tools/validation/object-corpus.mjs
node tools/validation/object-corpus.mjs --verify          # ⛔ a mismatch fails; it never re-fetches

# per-class detector scores, inside the image where the weights live
docker cp ai/mlops/probe_classes.py vip-prod-inference-1:/tmp/probe_classes.py
docker cp .data/corpus/. vip-prod-inference-1:/tmp/corpus/
docker exec vip-prod-inference-1 python3 /tmp/probe_classes.py --images /tmp/corpus

# capture a run's reads, then diff a later read against them byte for byte
node tools/validation/association-replay.mjs --stream ases_… --out before.json
node tools/validation/association-replay.mjs --stream ases_… --against before.json

# the five-stage staged verification, unchanged, with its three verdicts
node tools/validation/object-association.mjs --clip .data/real/x.mp4 --control .soak-real.mp4
```

⛔ **`PENDING FOOTAGE` still exits 0.** The platform is not broken; the recording does not exist yet.
A permanent red light on a CI board is a light everybody learns to ignore.

---

## 7. Regression suite

| suite | count | what it holds |
| --- | ---: | --- |
| `ai/inference/tests/test_confidence_floors.py` | 12 | the floor is applied by **label**, only to the label it names, never to `person`; the measured separation is asserted so a recalibration that moves 0.20 without moving the evidence fails |
| `ai/inference/tests/test_manifest.py` — `PerLabelFloorTests` | 7 | absent map ⇒ unchanged behaviour; malformed entries raise; the **deployed** manifest declares the five classes |
| `test_behaviour_primitives.py` — `AssociationDiagnosticTests` | 11 | all six reasons; a car is not carried; narrowing does not hide an empty detector |
| `behaviour-surface.test.tsx` — the association diagnostic | 6 | every reason renders a sentence; a successful run still names an excluded object; a clean run says nothing |
| `tools/e2e-browser/test/association.spec.ts` | 5 | real browser, real deployment, with the object-free negative control |

⭐ **Mutation-proved, not assumed.** Reverting `ConfidencePostprocessor` to ignore the per-label map
fails 5 of the 12 floor tests; renaming one reason in the runtime fails boundary §K. Both were run
with `python3 -B`, because an `identity_id` ↔ `tracking_id`-sized edit survives the `.pyc` cache.

---

## 8. ⚠️ What these measurements do not cover

- **One detector, one corpus.** Every score is `yolox-nano` at 416×416 on 30 photographs. A different
  model, a different lens, a different shop produces different numbers, and the floors are a property
  of *this* deployment.
- **The corpus is small.** Nine recovered images out of thirty is a rate with a wide interval on it.
- **The negative control is authored footage**, which is cleaner than the world and therefore
  optimistic about false positives. A real shop floor will contain more things that look like bags.
- **No pick-then-drop on real motion**, per § 5.
- **The durability blocker in § 4 is unfixed**, so any of these numbers read late will be lower.
