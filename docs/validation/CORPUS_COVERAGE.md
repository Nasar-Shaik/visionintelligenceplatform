# Detector benchmark — corpus coverage

**Corpus `detector-corpus-2026-08-10`** · 17 declared case(s)

**0 AVAILABLE · 19 PARTIAL · 12 MISSING** of 31 required scenarios.

> ⛔ **No scenario is covered by real footage.** Every row below is either authored material or absent. A detector comparison over this corpus measures how detectors handle *this corpus* — it does not measure how they handle people, and no winner may be declared from it.

## Footage held

| Kind | Cases | Can establish a scenario alone? |
| --- | ---: | --- |
| `AUTHORED` | 16 | ⛔ no — caps a scenario at PARTIAL |
| `PHOTOGRAPH` | 1 | ⛔ no — caps a scenario at PARTIAL |

⚠️ **`AUTHORED` is provenance, not a verdict on quality.** An authored clip is the *right* instrument for "does the tracker hold one id across a full crossing", because its intent is known by construction. It is the wrong instrument for "does this detector see a person", because there is no person.

## Scenario coverage

| Scenario | State | Evidence | Kinds | Ground truth |
| --- | --- | --- | --- | --- |
| `normal-person` | ⚠️ PARTIAL | `single-person-walking`, `retail-loitering` | AUTHORED | — |
| `multiple-people` | ⚠️ PARTIAL | `multiple-people`, `queue-formation` | AUTHORED | — |
| `crowd` | ⚠️ PARTIAL | `crowd` | AUTHORED | — |
| `distant-person` | ⛔ MISSING | — | — | — |
| `close-person` | ⚠️ PARTIAL | `res-1080p` | AUTHORED | — |
| `side-facing-person` | ⛔ MISSING | — | — | — |
| `rear-facing-person` | ⛔ MISSING | — | — | — |
| `partially-occluded-person` | ⚠️ PARTIAL | `occlusion`, `partial-visibility` | AUTHORED | — |
| `shelf-occlusion` | ⛔ MISSING | — | — | — |
| `top-down-view` | ⚠️ PARTIAL | `angle-overhead` | AUTHORED | — |
| `low-angle-view` | ⚠️ PARTIAL | `angle-wide` | AUTHORED | — |
| `portrait-video` | ⛔ MISSING | — | — | — |
| `4k` | ⛔ MISSING | — | — | — |
| `low-resolution-cctv` | ⚠️ PARTIAL | `res-180p` | AUTHORED | — |
| `backlighting` | ⛔ MISSING | — | — | — |
| `poor-lighting` | ⚠️ PARTIAL | `night-footage`, `lighting-changes` | AUTHORED | — |
| `motion-blur` | ⚠️ PARTIAL | `fast-movement`, `blur` | AUTHORED | — |
| `bottle` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `backpack` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `handbag` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `suitcase` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `cup` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `small-merchandise` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `person-carrying-object` | ⚠️ PARTIAL | `carried-objects` | PHOTOGRAPH | — |
| `object-pickup` | ⛔ MISSING | — | — | — |
| `object-return` | ⛔ MISSING | — | — | — |
| `two-person-interaction` | ⛔ MISSING | — | — | — |
| `handover` | ⛔ MISSING | — | — | — |
| `two-people-one-object` | ⛔ MISSING | — | — | — |
| `person-leaving-frame` | ⚠️ PARTIAL | `single-person-walking` | AUTHORED | — |
| `re-entry` | ⚠️ PARTIAL | `occlusion` | AUTHORED | — |

## ⛔ No ground truth exists

Not one case carries per-frame annotations, so **precision, recall, false-positive and false-negative rates, IoU and mAP cannot be computed for anything** and are absent from every report rather than estimated. What the benchmark reports instead is **observational**: latency, FPS, CPU, memory, detections per frame, confidence distribution and class coverage.

⚠️ A detection count is not an accuracy. A detector with more detections per frame may be finding people or may be finding coat racks, and no number in this corpus distinguishes them.

## What to record next

12 scenario(s) have **no evidence of any kind**. See `FOOTAGE_ACQUISITION.md` for the acquisition checklist and the annotation plan.

- `distant-person`
- `side-facing-person`
- `rear-facing-person`
- `shelf-occlusion`
- `portrait-video`
- `4k`
- `backlighting`
- `object-pickup`
- `object-return`
- `two-person-interaction`
- `handover`
- `two-people-one-object`

