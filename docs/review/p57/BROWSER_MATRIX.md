# Browser matrix, re-measured — P-5.7

P-5.6 measured browser behaviour against media produced by Chromium's `MediaRecorder`, because no
encoder was available. P-5.7 found `libx264` **and `libx265`** inside the dev stack's own ffmpeg
container, generated properly-encoded MP4s with a real `moov`, and **installed Microsoft Edge**.

Two P-5.6 conclusions did not survive that. They are corrected here rather than quietly amended.

## Engines

| Label      | Build                        | New in P-5.7              |
| ---------- | ---------------------------- | ------------------------- |
| `chromium` | Chromium 151 (Playwright)    |                           |
| `chrome`   | Google Chrome 150 (branded)  |                           |
| `msedge`   | **Microsoft Edge (branded)** | ✅ installed and measured |
| `firefox`  | Firefox 153                  |                           |
| `webkit`   | WebKit 26.5 (Playwright)     |                           |
| `safari`   | Safari 26.5.2 (real)         |                           |

## Fixtures

Generated with `jrottenberg/ffmpeg:6-alpine`: H.264 baseline/main/high, H.265 in **both** `hvc1` and
`hev1` sample entries, 64 kbps low-bitrate, CRF VBR, variable frame rate, a 250-frame GOP (sparse
keyframes), `moov`-at-end (unfaststarted, as an NVR writes it), a **one-hour** clip, plus truncated,
header-only and byte-corrupted variants.

## ⚠️ Correction 1 — a damaged recording **does** raise an error

P-5.6 concluded: _"a truncated or byte-corrupted recording plays with no error event of any kind."_
**That was an artefact of the fixtures**, which were fragmented MP4 with no duration index — a
truncated one simply ran out of data and stopped.

Re-measured against a proper MP4, playing to completion at 16×:

| File              | chromium                         | chrome             | msedge             |
| ----------------- | -------------------------------- | ------------------ | ------------------ |
| intact 10 s       | `ended` at 10.00 s               | `ended` at 10.00 s | `ended` at 10.00 s |
| truncated to 55 % | **`MEDIA_ERR_DECODE` at 3.89 s** | at 3.86 s          | at 3.85 s          |
| byte-corrupted    | **`MEDIA_ERR_DECODE` at 2.25 s** | at 2.25 s          | at 2.25 s          |
| header-only       | `ended` at 10.00 s, **no error** | `ended` at 10.00 s | `ended` at 10.00 s |

So the browser _does_ complain, `classifyFailure` routes it to `decode`, and the operator is told
the file is damaged and to check the integrity hash. The `endedEarly` safety net stays, now for the
one case that is still silent — a file truncated to headers alone, which reports a full duration and
ends normally having decoded nothing.

## ⚠️ Correction 2 — engines **agree** on duration

P-5.6 reported the same intact file as 6.01 s / 3.45 s / 1.19 s across three engines and concluded
duration metadata is unreliable. With a real `moov` every engine reports **10.00 s**, and the
one-hour fixture reports **3600.0 s** everywhere. The disagreement was fragmented MP4, not the
engines.

The design decision it justified — compare the **playhead**, not the reported duration — is
unchanged and still right: duration is a claim the container makes, the playhead is what decoded.

## ⚠️ The most dangerous failure found: video dropped in silence

Chromium 151, handed a real H.265 clip with an AAC track:

```
readyState 4 · duration 10 · currentTime advancing · videoWidth 0 · no error event
```

It played the **audio** and dropped the video. On screen: a black player with a moving scrubber and
no message. An investigator reviewing a night-time corridor concludes the camera recorded darkness.

This is now detected (`videoTrackMissing`) and named. Branded Chrome, Edge and Firefox decode the
same file normally; the divergence is proprietary-codec licensing, not version.

## H.265 across engines

| Probe / file                 | chromium            | chrome   | msedge   | firefox  | webkit   | safari       |
| ---------------------------- | ------------------- | -------- | -------- | -------- | -------- | ------------ |
| `codecs="hvc1.1.6.L93.B0"`   | `''`                | probably | probably | probably | probably | probably     |
| `codecs="hev1.1.6.L93.B0"`   | `''`                | probably | probably | probably | **`''`** | **`''`**     |
| `codecs="hvc1"` (no profile) | `''`                | `''`     | `''`     | `''`     | probably | not measured |
| real `hvc1` file decodes     | **no (audio only)** | yes      | yes      | yes      | —        | —            |

⚠️ Two lessons hold: **both sample entries must be probed** (Safari accepts only `hvc1`), and
**candidates must carry a profile** (every Chromium-family engine and Firefox answer `''` to bare
`hvc1`).

## H.264 across engines

Every H.264 profile — baseline 3.0, main 3.1, high 4.0 — plus low-bitrate, VBR, VFR, sparse
keyframes, `moov`-at-end and the one-hour clip: **played in Chromium, Chrome, Edge and Firefox**,
full duration, correct `videoWidth`.

⚠️ Playwright's WebKit build and **real Safari 26.5.2 refused every MP4 tested**, including
properly-encoded H.264, with `MEDIA_ERR_SRC_NOT_SUPPORTED`, while playing VP8/WebM normally. Both
answer `probably` to the same file's codec string first. Whatever the cause on this machine, the
product-relevant conclusion is the one P-5.6 drew and this run reinforces: **a positive capability
probe is not a guarantee of decode.** It is not evidence that Safari cannot play CCTV in general,
and it is recorded as an unexplained local result rather than a product claim.

## Reproducing

Fixtures: `docker run --rm -v "$PWD:/w" -w /w jrottenberg/ffmpeg:6-alpine …` (the exact argument
lists live in `tools/seed/evidence.ts` for the three demo clips). Drivers were temporary Playwright
scripts; real Safari was driven by hand with the page posting results to a local collector.
