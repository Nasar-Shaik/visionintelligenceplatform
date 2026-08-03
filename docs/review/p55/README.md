# P-5.5 — UI review artifact

Captured from the **real components** rendered with fixture data (Chromium, 1680 px, dark theme), not
from mockups. Two defects were found by looking at these and fixed before the milestone closed.

## `playback-states.png`

Eight surfaces, left to right, top to bottom:

| Panel                      | What it demonstrates                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Player — Original          | The quiet `ORIGINAL` badge; every transport control derived from `session.capabilities` |
| Player — Redacted copy     | ⚠️ `REDACTED COPY` in warning amber with an icon — provenance outranks adjustment (§82) |
| Player — unsupported codec | The evidence is intact; only this browser lacks the decoder                             |
| Player — still image       | Zero duration: no scrubber, seek controls disabled with a stated reason                 |
| Timeline — gaps to scale   | Two holes in ten minutes, hatched, sized to real elapsed time                           |
| Timeline — continuous      | "continuous" appears only when there genuinely are no gaps                              |
| Empty state                | Nothing was captured                                                                    |
| Unavailable state          | ⚠️ The fourth state — the server's own sentence, verbatim                               |

The "Playback failed" overlays in the first, second and fourth panels are **correct behaviour**: the
fixtures carry a fake media URL, so the error overlay is what should render.

## Two defects this review caught

⚠️ **1. Every H.264 clip was declared undecodable.** The player probed
`canPlayType('video/mp4; codecs="h264"')`. That parameter is RFC 6381 (`avc1.42E01E`), and this
platform's manifests store the _friendly_ name because `CameraCodec` is `'h264' | 'h265'`. Measured
in the browser: the friendly form answers `''`, the RFC form answers `probably`. Every real clip
would have shown "This browser cannot decode this file". Now the **container alone** is probed, and
a genuine decode failure surfaces through the error overlay instead.

⚠️ **2. The timeline axis was an unreadable smear.** `MAX_TICKS` was 24; at a realistic panel width a
ten-minute range picked a 30-second step and put twenty `02:31 PM` labels across ~700 px at 35 px
each. Now 10, with edge labels dropped rather than clipped — a centred label at 0 % renders as a
truncated time, which is worse than no label.

Both are pinned by tests, so neither can come back quietly.

## `timeline-gaps.png`

The gap band at working size: hatched, bounded by the recorded footage either side, with the reason
on hover.

## Not pictured

The full workspace, the multi-camera wall and the bookmark strip in situ are **not** here: those need
a running backend and seeded data, which arrives with Demo Readiness v1. Multi-camera walls are
contract-frozen and not implemented in this milestone.
