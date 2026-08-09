# What to record for object association (Phase 2.4)

`AssociationModule` has been written, unit-tested, deployed, and running on every frame since slice
2.2. It has **never had an object to associate**, and no test could have revealed that, because every
unit test authors its own objects.

⛔ Measured across every piece of media this platform has ever analysed:

| Source | Frames probed | Labels the detector actually returned |
| --- | ---: | --- |
| `.soak-real.mp4` — real phone footage, 19 s, 1080×1920 | 12 | `person: 6`, `tie: 3` |
| `.data/demo-clips/clip-002-hour.mp4` | 15 | **none** |
| P-11 soak corpus — 580 analyses | 78 902 | `person: 4631`, `tie: 320`, `toilet: 1` |

`tie` and `toilet` are false positives on synthetic frames. **There is no bottle, cup, backpack,
handbag, suitcase, chair or laptop in any footage the platform has seen.** The detector supports all
80 COCO classes and the tracker already gives non-person objects their own identities — the gap is
data, not code.

---

## The clip

30–60 seconds, any phone, any resolution, landscape or portrait. Save as
`.data/real/<name>.mp4` (git-ignored — it is real footage of real people).

**It must contain, in this order:**

1. A person enters, fully visible, walking.
2. They **approach** a surface with an object on it.
3. They **pick the object up** — one of: bottle · cup · backpack · handbag · suitcase · laptop.
4. They **carry** it for a few seconds, moving.
5. They **put it down** somewhere else, or into a bag.
6. They **leave** the frame.

⭐ **A second person is worth ten times the effort of the first.** Two people make `handover`,
`follow`, `group_merge`, `group_split` and the ambiguity case all testable from the same clip — and
`AssociationModule`'s own docstring warns that *"two people reaching at once will make the association
alternate, and that alternation is a signal a rule should read as ambiguous"*. That warning has never
been checked against reality.

## What makes a clip usable

- **The object must be recognisable to a photograph-trained model.** A real bottle held upright reads
  as `bottle`; a bottle lying flat on a patterned surface often reads as nothing.
- **Full bodies.** The tracker keys on person boxes; a torso-only frame tracks poorly.
- **Keep the camera still.** A fixed viewpoint is what a real deployment has, and camera motion makes
  every trajectory primitive meaningless.
- **Ordinary lighting.** This is not a robustness test; it is the first proof the path executes.

## What I will do with it

`node tools/validation/object-association.mjs --clip .data/real/<name>.mp4` runs the whole chain on
the **deployed stack** and reports each stage separately, so a failure names its own layer:

1. **Detection** — which COCO labels appear, and how often. ⚠️ Reported before anything else: if the
   object never detects, nothing downstream can be judged, and that is a finding about the clip
   rather than about the platform.
2. **Tracking** — whether the object gets a stable identity, and for how many frames.
3. **Association** — the spans `AssociationModule` produces: which subject, from when to when, and
   with what confidence.
4. **Events** — whether `subjects[].attributes.behaviour.association` reaches the events store.
5. **Behaviour API** — whether the same facts are readable through `/api/behaviour/primitives` and
   `/api/behaviour/timeline`.

⛔ **A negative control runs in the same command.** The same pipeline is run over a clip known to
contain no objects, and association must produce **nothing**. A positive result means little without
it: an association layer that fires on empty footage is worse than one that never fires.
