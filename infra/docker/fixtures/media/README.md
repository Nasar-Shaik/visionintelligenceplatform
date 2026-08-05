# Verification imagery

**Not part of any deployment.** These files exist so `docs/review/p8/inference.mjs` can prove that
real frames produce real detections against the deployed runtime.

## Why a photograph and not `testsrc`

P-8 Phase 2 measured the frame path with mediamtx's synthetic `testsrc` pattern, which is the right
source for counting frames and the wrong one for verifying inference: a real detector correctly finds
**nothing** in a colour-bar pattern, so a run against it cannot distinguish "the model works" from
"the model is broken". Verifying detection needs frames with something in them.

## `scene-people.jpg`

|            |                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Source     | [Wikimedia Commons — `!Policistky 17 10 2012.jpg`](https://commons.wikimedia.org/wiki/File:!Policistky_17_10_2012.jpg) |
| Licence    | **CC0 1.0** — Creative Commons Zero, public domain dedication                                                          |
| Content    | Two police officers, outdoors, full-length — two `person` instances                                                    |
| Processing | Downscaled to 640×360 (a CCTV-plausible frame size), JPEG q88                                                          |

CC0 imposes no attribution requirement; the provenance is recorded here anyway, because "where did
this file come from?" is a question a customer's legal review is entitled to ask about every byte in
the repository.

⚠️ **Two people is the measurement.** The verification asserts the runtime finds _exactly the people
who are there_ — a run that reports three has a defect, and so does a run that reports one. A count
that is merely "greater than zero" would pass with a model that hallucinated.
