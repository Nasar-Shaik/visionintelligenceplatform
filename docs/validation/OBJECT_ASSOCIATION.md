# Object association — the verification framework, and why it has no result

`carry_object · pick_object · drop_object · object_missing · object_returned · approach_object ·
leave_object · handover`

## ⛔ Status: PENDING FOOTAGE

Every primitive above is implemented, unit-tested and deployed. **Not one has ever run on an object
this platform detected.** That is a data gap, not a defect, and this document exists so it stays a
stated gap rather than becoming an assumed pass.

| | |
| --- | --- |
| Implemented | ✅ `behaviour_primitives.object_events`, `associations`, `handovers` |
| Unit tested | ✅ `ObjectEventTests` — pick/drop/missing/returned, plus the negative control |
| On the Behaviour API | ✅ timeline kinds `carried`, `picked`, `dropped`, `objectMissing`, `objectReturned`, `handover` |
| Deployed | ✅ `AssociationModule` runs on every frame, and has since slice 2.2 |
| **Verified on real footage** | ⛔ **never — no clip contains an object** |

## What the platform has actually seen

⛔ Measured across every piece of media this deployment has analysed:

| Source | Frames | Labels the detector returned |
| --- | ---: | --- |
| `.soak-real.mp4` — real phone footage, 19 s | 12 probed | `person: 6`, `tie: 3` |
| `.data/demo-clips/clip-002-hour.mp4` | 15 probed | **none** |
| P-11 soak corpus — 580 analyses | 78 902 | `person: 4 631`, `tie: 320`, `toilet: 1` |
| Durable track history, 2026-08-09 | 5 014 records | `person: 4 691`, `tie: 321`, `toilet: 2` |

`tie` and `toilet` are false positives on synthetic frames. **There is no bottle, cup, backpack,
handbag, suitcase, chair or laptop in any footage this platform has ever processed.** The detector
supports all 80 COCO classes and the tracker already gives non-person objects their own identities —
the gap is data.

## The harness

```bash
node tools/validation/object-association.mjs                                    # what is possible today
node tools/validation/object-association.mjs --clip .data/real/x.mp4 \
                                             --control .soak-real.mp4 --out obj.json
```

Five stages, reported separately so a failure names its own layer:

1. **Detection** — which COCO labels appeared. ⚠️ Reported first: if the object never detects,
   nothing downstream can be judged, and that is a finding about the clip.
2. **Tracking** — whether the object got a stable identity, and for at least five frames. ⛔ One
   frame is a detection, not a track; an association built on a single observation is a coincidence
   with a duration attached.
3. **Association** — the spans `AssociationModule` produced, and the pick/drop/missing/returned
   events derived from them.
4. **Events** — whether `subjects[].attributes.behaviour.association` survived four hops and two
   languages into the events store.
5. **Behaviour API** — whether the same facts are readable through `/api/behaviour/primitives` and
   `/api/behaviour/timeline`.

### ⛔ Three verdicts, and `PENDING FOOTAGE` is not a soft failure

| Verdict | Means | Exit |
| --- | --- | ---: |
| `PASS` | a carriable object detected, tracked, associated, and readable end to end | 0 |
| `FAIL` | it detected and something downstream dropped it | 1 |
| `PENDING FOOTAGE` | the platform behaved impeccably; the clip had nothing to associate | 0 |

Calling the third a pass would be fabrication. Calling it a failure would blame the code for the
camera — and a permanent red light on a CI board is a light everybody learns to ignore. Only a run
whose **detector** produced a carried object can yield `PASS` or `FAIL`.

### ⛔ The negative control is what makes a pass mean anything

`--control` runs the same pipeline over a clip known to contain no object, and association must
produce **nothing**. An association layer that fires on empty footage is worse than one that never
fires, and only the pair of runs can tell them apart. A run without a control reports a `coverage`
finding.

## What to record

See [OBJECT_FOOTAGE.md](OBJECT_FOOTAGE.md). In short: 30–60 s, any phone, fixed viewpoint, ordinary
light. A person enters, approaches a surface, **picks up a bottle / cup / backpack / handbag /
suitcase / laptop**, carries it while moving, puts it down, leaves.

⭐ **A second person is worth ten times the effort of the first.** Two people make `handover`,
`follow`, `group_merge`, `group_split` and the ambiguity case all testable from one recording — and
`AssociationModule`'s own docstring warns that *"two people reaching at once will make the
association alternate, and that alternation is a signal a rule should read as ambiguous"*. That
warning has never been checked against reality.

Save to `.data/real/<name>.mp4` — git-ignored, because it is real footage of real people.

## ⚠️ What the unit tests cannot prove

`ObjectEventTests` authors its own objects, so it proves the geometry and nothing about perception.
Specifically it cannot show:

- that the deployed detector returns a `bottle` at the angle, distance and lighting of a real shop;
- that a small object survives tracking while a hand is over it — the case `object_missing` exists
  for and the one most likely to behave differently on real pixels;
- that `nearest-subject-per-frame` picks the right person when two reach at once.

⛔ Every one of those is a property of pixels, and no fixture has any.
