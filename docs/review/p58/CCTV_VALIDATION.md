# Real CCTV and NVR validation — status

## The short version

**No CCTV camera and no NVR was involved in any part of this milestone, or any milestone before it.**

No Hikvision, Dahua, CP Plus, UNV or Axis device. No NVR of any make. No RTSP stream from real
hardware. No exported NVR clip.

This is stated plainly because the instruction was explicit — _"If hardware is unavailable, clearly
state this rather than simulating vendor behaviour"_ and _"Do not simulate vendor behaviour"_ — and
because a hedged answer here would be worse than useless. Anyone reading this to decide whether the
platform is ready for a customer site needs to know that this area is **unverified**, not
_partially_ verified.

---

## What the test media actually is

Three clips generated with ffmpeg and registered through the real evidence API:

| File                | Codec                | Container      | Duration |
| ------------------- | -------------------- | -------------- | -------- |
| `clip-001.mp4`      | H.264 Main, `avc1`   | MP4, faststart | 10 s     |
| `clip-002-hour.mp4` | H.264, 1 fps, GOP 30 | MP4, faststart | 3,600 s  |
| `clip-003-h265.mp4` | H.265, `hvc1` tag    | MP4, faststart | 10 s     |

These are **genuine H.264 and H.265 elementary streams in genuine MP4 containers**. A browser decodes
them with the same code path it uses for a camera's recording, so they exercise the player honestly:
container parsing, codec negotiation, Range requests, seeking, buffering, and the "this browser has no
HEVC decoder" path.

They are **not** CCTV, and the seed script says so every time it runs.

---

## What is genuinely verified by them

- H.264 in MP4 decodes and plays in Chromium, Firefox and WebKit against the production deployment.
- H.265 (`hvc1`) is correctly refused by an open-source Chromium build, and the console explains why
  rather than showing a black rectangle.
- Seeking within a 1-hour recording issues fresh Range requests and works across a signed URL.
- A timeline spanning an hour renders, zooms and scrubs.
- The player recovers honestly when the bytes stop arriving mid-stream.

## What remains completely unknown

Everything that is specific to real recording hardware:

| Unverified                           | Why it matters                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Vendor MP4/MKV muxing quirks         | Vendors write non-standard atoms, unusual `hvc1`/`hev1` choices, and edit lists browsers interpret differently |
| **Variable bitrate** recordings      | Real cameras vary bitrate with scene activity; seeking accuracy depends on it                                  |
| **Long-duration** vendor recordings  | 8–24 hour files from an NVR, not a 1-hour test pattern                                                         |
| **Recording gaps**                   | What an NVR writes when recording stops and restarts — the gap model has never seen a real one                 |
| **Camera clock drift / DST**         | Timeline correctness depends on camera timestamps that no real camera has supplied                             |
| Night vision / infrared              | Different encoder behaviour, often different resolution and frame rate                                         |
| Corrupted or truncated clips         | A real power loss mid-write, not a file truncated deliberately                                                 |
| Missing frames / damaged GOPs        | Real transmission loss, not synthetic damage                                                                   |
| NVR export formats                   | Proprietary wrappers and player-specific containers                                                            |
| **RTSP live streams**                | No browser plays RTSP natively — this needs a transcode path that does not exist yet (TD-28)                   |
| ONVIF discovery against real devices | The camera service implements it; nothing has answered                                                         |

---

## Why this was not solved by simulation

Writing a "Hikvision-like" file would produce a test that passes against my idea of Hikvision. The
value of vendor validation is entirely in the parts nobody predicted — which is exactly the class of
thing this milestone found by _deploying_ rather than by reasoning: a URL pointing at
`minio:9000`, a chunk cycle blanking the console, a health endpoint returning HTML. None of those
were guessable, and none would have been caught by a simulation of themselves.

The same argument applies here, and it cuts against simulating: a green test named
`hikvision-h265-vbr.test.ts` would actively **remove** the pressure to get hardware, while proving
nothing about a Hikvision camera.

---

## What it would take

1. One camera per vendor family — Hikvision, Dahua, CP Plus, UNV, Axis — reachable on the network.
2. One NVR (Hikvision or Dahua) with a few days of recordings, including at least one stop/restart
   gap.
3. A day of doing exactly what P-5.8 did: register real recordings through the real API, play them in
   four browsers, seek across gaps, and write down what breaks.

Everything else in this milestone was found by deploying the platform and using it. **This one will
only be found by connecting a camera**, and it has now been carried, honestly and unresolved, since
P-5.5.

---

**Tracked as:** TD-27 (no CCTV hardware), TD-28 (no browser plays RTSP; needs a transcode path).
**Recommendation:** treat this as the highest-priority gap before any production installation. It is
the single largest unverified area in the platform.
