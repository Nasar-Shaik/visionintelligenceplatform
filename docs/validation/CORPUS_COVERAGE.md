# Detector benchmark — corpus coverage

**Corpus `detector-corpus-2026-08-10`** · 19 declared case(s)

**11 AVAILABLE · 13 PARTIAL · 17 MISSING** of 41 required scenarios.

> ⛔ **Real footage is declared, and no winner may be declared from it.** 11 scenario(s) are now covered by footage of real people, which is what makes them *observable* — but no real clip carries human annotations, so nothing makes them **measurable**. Precision, recall and IoU about people remain uncomputable, and the numbers below any real clip are observational only: detections per frame, latency, track counts. ⚠️ A detector that leads on those has not been shown to be more accurate; it has been shown to emit more boxes.

## Footage held

| Kind | Cases | Can establish a scenario alone? |
| --- | ---: | --- |
| `REAL_FOOTAGE` | 1 | ⭐ yes |
| `AUTHORED` | 17 | ⛔ no — caps a scenario at PARTIAL |
| `PHOTOGRAPH` | 1 | ⛔ no — caps a scenario at PARTIAL |

⚠️ **`AUTHORED` is provenance, not a verdict on quality.** An authored clip is the *right* instrument for "does the tracker hold one id across a full crossing", because its intent is known by construction. It is the wrong instrument for "does this detector see a person", because there is no person.

## Scenario coverage

| Scenario | State | Evidence | Kinds | Ground truth |
| --- | --- | --- | --- | --- |
| `normal-person` | ⭐ AVAILABLE | `single-person-walking`, `retail-loitering`, `walk-tracking`, `movie101` | AUTHORED, REAL_FOOTAGE | ✓ |
| `multiple-people` | ⚠️ PARTIAL | `multiple-people`, `queue-formation` | AUTHORED | — |
| `crowd` | ⚠️ PARTIAL | `crowd` | AUTHORED | — |
| `distant-person` | ⛔ MISSING | — | — | — |
| `close-person` | ⭐ AVAILABLE | `res-1080p`, `movie101` | AUTHORED, REAL_FOOTAGE | — |
| `front-facing-person` | ⭐ AVAILABLE | `movie101` | REAL_FOOTAGE | — |
| `side-facing-person` | ⭐ AVAILABLE | `movie101` | REAL_FOOTAGE | — |
| `rear-facing-person` | ⛔ MISSING | — | — | — |
| `person-standing` | ⭐ AVAILABLE | `movie101` | REAL_FOOTAGE | — |
| `person-sitting` | ⛔ MISSING | — | — | — |
| `person-bending` | ⛔ MISSING | — | — | — |
| `hands-raised` | ⛔ MISSING | — | — | — |
| `partially-occluded-person` | ⭐ AVAILABLE | `occlusion`, `partial-visibility`, `movie101` | AUTHORED, REAL_FOOTAGE | — |
| `shelf-occlusion` | ⛔ MISSING | — | — | — |
| `top-down-view` | ⚠️ PARTIAL | `angle-overhead` | AUTHORED | — |
| `low-angle-view` | ⚠️ PARTIAL | `angle-wide` | AUTHORED | — |
| `portrait-video` | ⭐ AVAILABLE | `movie101` | REAL_FOOTAGE | — |
| `4k` | ⛔ MISSING | — | — | — |
| `low-resolution-cctv` | ⚠️ PARTIAL | `res-180p` | AUTHORED | — |
| `backlighting` | ⛔ MISSING | — | — | — |
| `poor-lighting` | ⚠️ PARTIAL | `night-footage`, `lighting-changes` | AUTHORED | — |
| `motion-blur` | ⭐ AVAILABLE | `fast-movement`, `blur`, `movie101` | AUTHORED, REAL_FOOTAGE | — |
| `bottle` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `backpack` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `handbag` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `suitcase` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `cup` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `small-merchandise` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `person-carrying-object` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `object-pickup` | ⛔ MISSING | — | — | — |
| `object-putdown` | ⛔ MISSING | — | — | — |
| `object-return` | ⛔ MISSING | — | — | — |
| `two-person-interaction` | ⛔ MISSING | — | — | — |
| `handover` | ⛔ MISSING | — | — | — |
| `two-people-one-object` | ⛔ MISSING | — | — | — |
| `person-entering-frame` | ⭐ AVAILABLE | `walk-tracking`, `movie101` | AUTHORED, REAL_FOOTAGE | ✓ |
| `person-leaving-frame` | ⭐ AVAILABLE | `single-person-walking`, `walk-tracking`, `movie101` | AUTHORED, REAL_FOOTAGE | ✓ |
| `re-entry` | ⭐ AVAILABLE | `occlusion`, `movie101` | AUTHORED, REAL_FOOTAGE | — |
| `approach-recede` | ⛔ MISSING | — | — | — |
| `zone-crossing` | ⛔ MISSING | — | — | — |
| `line-crossing` | ⛔ MISSING | — | — | — |

## What to record next

17 scenario(s) have **no evidence of any kind**. See `FOOTAGE_ACQUISITION.md` for the acquisition checklist and the annotation plan.

- `distant-person`
- `rear-facing-person`
- `person-sitting`
- `person-bending`
- `hands-raised`
- `shelf-occlusion`
- `4k`
- `backlighting`
- `object-pickup`
- `object-putdown`
- `object-return`
- `two-person-interaction`
- `handover`
- `two-people-one-object`
- `approach-recede`
- `zone-crossing`
- `line-crossing`

