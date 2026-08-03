# P-5.6 — UI review artifact

Captured from the **real components** playing **real H.264 files** (Chromium 151, 1440 px, 2× DPR,
dark theme). The frames below are not mockups and the video is not a placeholder — the number in the
picture is a frame the browser decoded.

Companion documents:

- [BROWSER_MATRIX.md](BROWSER_MATRIX.md) — every capability figure this milestone acted on, measured
  in Chromium, Chrome, Firefox, WebKit and real Safari.
- [NVR_VALIDATION.md](NVR_VALIDATION.md) — ⚠️ what was **not** tested: no surveillance hardware, and
  RTSP is not a browser format at all.

## The states

| File                    | What it demonstrates                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `playback.png`          | A decoded H.264 frame; the full transport; `ORIGINAL` badge; honest "not measured" dropped-frame readout               |
| `timeline.png`          | 24 hours with two gaps hatched and drawn to scale                                                                      |
| `timeline-dense.png`    | ⚠️ 4,000 bookmarks — culled, clustered, then drawn as a **density band** rather than pins                              |
| `loading.png`           | Shape-matched skeleton                                                                                                 |
| `codec-unsupported.png` | H.265 on a build with no HEVC decoder — names the cause, states the evidence is intact, **and disables the transport** |
| `expired.png`           | An expired signature: "the recording is untouched", with a **Resume playback** action that fetches a fresh signature   |
| `error.png`             | A file whose samples are gone                                                                                          |
| `unavailable.png`       | ⚠️ The fourth state — resolved with no playable media                                                                  |
| `truncated.png`         | A recording that plays and stops early                                                                                 |
| `still.png`             | A snapshot: no scrubber, transport disabled with stated reasons                                                        |
| `touch-ipad.png`        | Coarse-pointer layout: 44 px controls, volume slider permanently visible                                               |
| `touch-pixel.png`       | The same on a phone                                                                                                    |

## ⚠️ Four defects this review caught

Each was invisible to a green test suite and visible in a screenshot or a device emulation.

**1. The player was a black rectangle reading "Resolving media…" forever.** The P-5.6 media-release
teardown ran on ref _cleanup_ — and React runs ref cleanup then ref attach on a node that is **still
mounted** (StrictMode does it on every development mount). So the release cleared `src` on a live
element, and React never restored it, because its virtual DOM saw no change. Now deferred a
microtask and guarded on `node.isConnected`. Pinned by a test that re-renders and asserts `src`
survives.

**2. 4,000 bookmarks clustered correctly and still looked like a smear.** Clustering bounded the DOM
to ~67 elements — the right _number_ — and 67 counted pins abutting each other rendered as a solid
band of icons and numerals hiding the footage, the gaps and the playhead underneath. Past a density
threshold the timeline now draws a density band: one thin bar per cluster, height by count.

**3. An iPad got 32 px controls on 16 of 16 targets.** The sizing used `sm:size-8`, and an iPad Pro
is 834 px wide, so the most touch-driven device in the product matched the "fine pointer" branch.
Screen width was never the question; `pointer-coarse:` is.

**4. The volume slider could not be reached on a tablet at all.** It was revealed on hover, and a
touch device has no hover — measured at 0 px wide with no gesture that could open it.

Two more, found by driving rather than looking:

**5. Pinch-zoom silently did nothing** because `setPointerCapture` throws `InvalidPointerId` for a
pointer the browser no longer considers active, and the uncaught throw aborted the handler before
the gesture was registered. Capture is an optimisation; the gesture is the feature.

**6. The transport stayed fully live under every error overlay.** Press play on a file the browser
cannot decode, nothing happens. The player's own rule about capabilities now applies to its states.

## What the fixtures do and do not show

The video content is a generated colour-cycling counter, not CCTV. It is real H.264 that a browser
really decoded, which is what the player's behaviour depends on; it is not representative of what a
Hikvision camera emits. See [NVR_VALIDATION.md](NVR_VALIDATION.md).

## Reproducing

A temporary Vite harness under `apps/console/.review/` rendered the real components against
locally-generated media, driven by Playwright for the screenshots and for the touch audit. It was
deleted after capture; it is not part of the app, is not built and never shipped.
