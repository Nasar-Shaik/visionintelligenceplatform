# Browser capability matrix — measured, P-5.6

Every figure below was produced by running the probe in the browser named, on macOS 26 (Apple
silicon), 2026-08-03. Nothing here is transcribed from documentation. Where a browser could not be
measured it is listed as **not measured**, never as "assumed to match".

## Engines measured

| Label      | Build                                   | How it was driven                                 |
| ---------- | --------------------------------------- | ------------------------------------------------- |
| `chromium` | Chromium 151.0.7922 (Playwright bundle) | Playwright                                        |
| `chrome`   | Google Chrome 150 (branded channel)     | Playwright, `channel: 'chrome'`                   |
| `firefox`  | Firefox 153.0 (Playwright build)        | Playwright                                        |
| `webkit`   | WebKit 26.5 (Playwright build)          | Playwright                                        |
| `safari`   | **Safari 26.5.2** (the real browser)    | Opened manually; the page posted its results back |

⚠️ **Microsoft Edge was not measured in P-5.6** — it was not installed. **P-5.7 installed it and
measured it**; see [`../p57/BROWSER_MATRIX.md`](../p57/BROWSER_MATRIX.md), which also re-runs the
decode table against properly-encoded MP4s and **corrects two conclusions on this page**.

## `HTMLVideoElement.canPlayType`

`''` = unsupported · `maybe` = container recognised · `probably` = container and codec recognised.

| Type                                    | chromium | chrome   | firefox  | webkit   | safari       |
| --------------------------------------- | -------- | -------- | -------- | -------- | ------------ |
| `video/mp4`                             | maybe    | maybe    | maybe    | maybe    | maybe        |
| `video/mp4; codecs="h264"`              | **''**   | **''**   | **''**   | **''**   | **''**       |
| `video/mp4; codecs="h265"`              | **''**   | **''**   | **''**   | **''**   | **''**       |
| `video/mp4; codecs="avc1.42E01E"`       | probably | probably | probably | probably | probably     |
| `video/mp4; codecs="avc1.4D401E"`       | probably | probably | probably | probably | probably     |
| `video/mp4; codecs="avc1.64001F"`       | probably | probably | probably | probably | probably     |
| `video/mp4; codecs="avc1"` (no profile) | maybe    | maybe    | **''**   | probably | not measured |
| `video/mp4; codecs="hvc1.1.6.L93.B0"`   | **''**   | probably | probably | probably | probably     |
| `video/mp4; codecs="hev1.1.6.L93.B0"`   | **''**   | probably | probably | **''**   | **''**       |
| `video/mp4; codecs="av01.0.04M.08"`     | probably | probably | probably | **''**   | **''**       |
| `video/webm; codecs="vp8"`              | probably | probably | probably | probably | probably     |
| `video/webm; codecs="vp9"`              | probably | probably | probably | probably | probably     |
| `video/quicktime`                       | **''**   | **''**   | maybe    | maybe    | maybe        |
| `video/quicktime; codecs="avc1.42E01E"` | **''**   | **''**   | probably | probably | not measured |
| `video/x-matroska`                      | maybe    | maybe    | maybe    | **''**   | **''**       |
| `application/vnd.apple.mpegurl`         | maybe    | maybe    | **''**   | maybe    | maybe        |

### What this changes in the product

1. **The stored codec name is unusable as a probe.** `CameraCodec` is `'h264' | 'h265'`; every
   engine answers `''` to both. This is the P-5.5 defect (§86) and the reason `codecs.ts` translates.
2. **The container alone can never refuse an MP4.** All five answer `maybe`. A container-only check
   is therefore silent on the format nearly all CCTV arrives in.
3. **H.265 is where engines genuinely disagree, and it is not a version difference.** Chromium 151
   refuses both HEVC sample entries; branded Chrome 150 — _older_, same engine family — accepts
   both. Proprietary decoder support is a build-time licensing decision, which is why the product
   must probe rather than sniff the user agent.
4. **`hvc1` and `hev1` are not interchangeable.** Safari and WebKit accept `hvc1` and refuse `hev1`.
   Probing only `hev1` would report "Safari cannot play H.265", which is false. Both are tried and
   the best answer wins.
5. **QuickTime is a real divergence.** A `.mov` export — ordinary for CCTV — will not open in Chrome
   or Chromium at all, and does open in Firefox and Safari.
6. **Profile-less `avc1` is not a safe shorthand.** Firefox answers `''` to it while accepting every
   profile-qualified form. Candidates always carry a profile.

## `MediaSource.isTypeSupported`

Measured for the same list. Notable: `MediaSource.isTypeSupported('video/mp4')` is `false` in
Chromium and Chrome and `true` in Firefox, WebKit and Safari — MSE is **not** a usable cross-engine
substitute for a bare-container probe. HEVC through MSE tracks `canPlayType` exactly (Chromium
`false`, all others `true`). AV1 is the mirror image: `true` in Chromium/Chrome/Firefox, `false` in
WebKit/Safari.

## Feature availability

| Feature                                      | chromium | chrome | firefox | webkit | safari |
| -------------------------------------------- | -------- | ------ | ------- | ------ | ------ |
| `requestPictureInPicture`                    | ✅       | ✅     | ✅      | ✅     | ✅     |
| `getVideoPlaybackQuality`                    | ✅       | ✅     | ✅      | ✅     | ✅     |
| `requestVideoFrameCallback`                  | ✅       | ✅     | ✅      | ✅     | ✅     |
| `Element.requestFullscreen`                  | ✅       | ✅     | ✅      | ✅     | ✅     |
| `webkitEnterFullscreen` (media-element only) | —        | —      | —       | ✅     | ✅     |
| `ManagedMediaSource`                         | —        | —      | —       | ✅     | ✅     |
| `preservesPitch`                             | ✅       | ✅     | ✅      | ✅     | ✅     |
| `PointerEvent`                               | ✅       | ✅     | ✅      | ✅     | ✅     |

The player calls `requestFullscreen` on the container and falls back to `webkitEnterFullscreen` on
the media element, which is the only fullscreen iOS Safari offers.

## Decoding real files

Generated with Chromium's `MediaRecorder` (no system ffmpeg is available on this machine): a 6 s
640×360 H.264-in-MP4 clip, plus low-bitrate (24 kbps), variable-frame-rate, truncated (first 55 % of
bytes), header-only (first 2 KB) and byte-corrupted (bytes 40–60 % XORed) variants.

| File                  | chromium                     | chrome                       | firefox              | webkit         | safari         |
| --------------------- | ---------------------------- | ---------------------------- | -------------------- | -------------- | -------------- |
| `h264.mp4` (intact)   | played, 3.45 s               | played, 6.01 s               | played, 1.19 s       | ERR 4          | ERR 4          |
| `h264-lowbitrate.mp4` | played                       | played                       | played               | ERR 4          | ERR 4          |
| `h264-vfr.mp4`        | played                       | played                       | played               | ERR 4          | ERR 4          |
| `h264-truncated.mp4`  | **played, 3.28 s, no error** | **played, 3.31 s, no error** | **played, no error** | ERR 4          | ERR 4          |
| `h264-corrupt.mp4`    | **played, 3.28 s, no error** | **played, 3.31 s, no error** | **played, no error** | ERR 4          | ERR 4          |
| `h264-headeronly.mp4` | ERR 3 (decode)               | played, 1.09 s               | ERR 3 (decode)       | ERR 4          | ERR 4          |
| `vp8.webm`            | played, 3.98 s               | played, 3.98 s               | played, 3.98 s       | played, 4.02 s | played, 4.02 s |

### ⚠️ Two findings, and one thing this table does **not** prove

**Finding 1 — a truncated recording plays silently.** Chromium, Chrome and Firefox all played the
truncated and byte-corrupted files without a single error event, reporting roughly half the
duration of the intact original. There is no signal an operator would notice. This drives
CONSTRAINTS §88 and the shortfall band in the player.

**Finding 2 — `probably` is not a promise.** WebKit and Safari answered `probably` to
`avc1.42E01E` and then refused every actual H.264 file with `MEDIA_ERR_SRC_NOT_SUPPORTED`. Whatever
the cause, the product-relevant conclusion holds: a positive probe cannot be relied on, only a
negative one. This drives §87 and the `refused` failure classification.

> ⚠️ **Superseded by P-5.7.** The decode table below was produced with Chromium-`MediaRecorder`
> fragmented MP4. Re-measured against `libx264`/`libx265` files with a real `moov`, two of its
> conclusions do not hold: damaged files **do** raise `MEDIA_ERR_DECODE`, and engines **agree** on
> duration. See [`../p57/BROWSER_MATRIX.md`](../p57/BROWSER_MATRIX.md).

**What this does not prove:** that Safari cannot play H.264 CCTV footage. These fixtures are
Chromium-`MediaRecorder` fragmented MP4, which is not what an NVR exports, and Safari plays ordinary
H.264 MP4 across the web every day. The honest reading is _this fixture family is rejected by
WebKit/Safari_, not _Safari lacks H.264_. Duration disagreement on the **intact** file (6.01 s /
3.45 s / 1.19 s across three engines) is likewise a property of fragmented-MP4 duration metadata —
which is precisely why §88 compares the **playhead**, not the reported duration.

## Reproducing

The probe pages, the media generator and the drivers were temporary and are not committed. They are
described here in enough detail to rebuild: a detached `<video>`, `canPlayType` over the type list
above, `MediaSource.isTypeSupported` over the same, feature detection by `typeof`, and — for real
Safari, which Playwright cannot drive — the same page opened by hand with `fetch('/collect')`
posting its result to a local server.
