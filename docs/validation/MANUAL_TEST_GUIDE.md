# Manual Test Guide — Live Webcam Capture

> **Who this is for.** An engineer who has never seen this repository, with a laptop that has a
> camera. Everything needed is below; nothing requires asking a question. If a step here cannot be
> followed as written, that is a defect in this document — report it as one.

**What this validates that automation cannot:** a **real camera**, real optics, real auto-exposure,
real lighting, and a real human moving. Every automated run in
[COMPLETE_E2E_TEST_GUIDE.md](COMPLETE_E2E_TEST_GUIDE.md) substitutes Chrome's fake video device for
the camera hardware. This guide is the only thing that exercises the physical device.

---

## 1. Prerequisites

| | Requirement |
| --- | --- |
| OS | macOS 13+, Windows 11, or Linux with a working V4L2 camera |
| Browser | **Chrome or Edge 120+**. ⚠️ Firefox and Safari work for the page but are *not* certified for capture (see §8) |
| Camera | Built-in or USB. Nothing else may be holding it — close Zoom, Teams, Photo Booth |
| Docker | Docker Desktop running, ≥ 8 GB allocated |
| Node | ≥ 22 (`node -v`) |
| pnpm | `corepack enable && corepack prepare pnpm@latest --activate` |
| Disk | ≥ 20 GB free |

⛔ **Docker Desktop on macOS cannot pass the Mac camera through to a container.** The browser is the
only capture path on this platform, which is why the capture page exists rather than a container-side
capture agent.

---

## 2. Bring the platform up

```bash
git clone <repo> && cd VisionIntelligencePlatform
pnpm install
./infra/docker/prod.sh build          # first run: 10–20 minutes
./infra/docker/prod.sh up -d
```

⚠️ **Always `./infra/docker/prod.sh`, never bare `docker compose`.** The script supplies the env file
and project name; a bare compose command starts a *second, differently configured* deployment beside
the first, and the symptom is services that cannot see each other.

Wait for health, then verify:

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep vip-prod   # all (healthy)
curl -sk https://localhost/health                              # {"status":"ok"}
curl -skI https://localhost/ | grep -i permissions-policy      # camera=(self), microphone=()
```

⛔ **If `Permissions-Policy` does not contain `camera=(self)`, stop.** The browser will refuse
`getUserMedia` and report it as *"permission denied"* — which reads as your choice, not the edge's.
Reload the proxy: `docker restart vip-prod-proxy-1`.

### Trust the certificate (once)

The edge uses Caddy's internal CA, so the browser will warn. Either accept the warning, or:

```bash
docker cp vip-prod-proxy-1:/data/caddy/pki/authorities/local/root.crt /tmp/vip-root.crt
# macOS:
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/vip-root.crt
```

⚠️ **Chrome will not offer a camera prompt on a page whose certificate it distrusts.** If Start
appears to do nothing, this is why.

---

## 3. Sign in

| | |
| --- | --- |
| URL | `https://localhost` |
| Tenant | `tnt_demo_retail` |
| Email | `security.manager@northgate.demo` |
| Password | `12345678` |

⚠️ **Not** `SEED_PASSWORD` from `.env.production` — that value does not work for the demo tenants.
This is a local demo tenant only; a real deployment changes it before first login.

**Required permission: `stream:control`.** Held by `admin` and `operator`. A `viewer`
(`loss.prevention@northgate.demo` / `12345678`) will not see **Live Capture** in the sidebar at all —
which is the correct behaviour and worth confirming in §6.

---

## 4. Prepare a camera

Live Capture ingests into a real camera record, and that camera must have an **AI processing
assignment** or its frames are accepted and then skipped at the gate.

1. **Cameras → Add camera.** Any name; protocol `rtsp`; the stream URL is never dialled for live
   capture, so `rtsp://127.0.0.1:554/unused` is fine.
2. **Assignment → Camera Assignment → your camera → Enable**, profile **`person-tracking`**, runtime
   **`inference`**.
3. Confirm the row reads **running**.

⛔ **If you skip step 2** the page will show `Skipped (unassigned)` climbing and zero detections.
That is L-65 and it is the single most common reason a first attempt appears to do nothing.

---

## 5. The capture run

Navigate to **Monitor → Live Capture** (`https://localhost/live/webcam`).

| Step | Do | Expect |
| --- | --- | --- |
| 5.1 | Choose your camera in **Ingest into camera** | — |
| 5.2 | Leave **Capture device** on System default | — |
| 5.3 | Frame rate **4 fps**, longest edge **640** | — |
| 5.4 | Press **Start capture** | Browser prompts for camera. **Allow.** |
| 5.5 | — | Preview appears; camera indicator light on; button becomes **Stop capture** |
| 5.6 | Stand in front of the camera | Within ~2 s a green box appears around you with a track id |
| 5.7 | Watch **Browser stages** | Four rows populate with n / min / avg / p95 / max |
| 5.8 | Watch **Platform stages** | State `running`, Processing fps ≈ 4.00, Queue depth 0 |
| 5.9 | Walk out of frame, wait 5 s, walk back | A **new** track id appears; §7 explains why |
| 5.10 | Let it run 60 s | Achieved fps stays ≈ 4.0; Skipped/Rejected/Failed stay 0 |
| 5.11 | Press **Stop capture** | Camera light goes out **immediately** |

### Screenshots to capture

1. `01-idle.png` — the page before Start, showing all four stage rows as **— not measured yet**
2. `02-live-overlay.png` — you in frame with a box and track id
3. `03-stages.png` — Browser stages populated, with the clock-offset line visible
4. `04-platform.png` — Platform stages panel
5. `05-two-people.png` — a colleague joins; **two** boxes, **two** track ids
6. `06-stopped.png` — after Stop, camera light off

### Pass criteria

- [ ] A box appears around a person within 3 s of them entering frame
- [ ] The box **follows** you — it is not a static rectangle
- [ ] Two people produce two boxes with two distinct track ids
- [ ] An empty scene produces **no** boxes (stand aside for 10 s and confirm)
- [ ] Achieved fps within 10 % of the selected rate
- [ ] Skipped / Rejected / Failed all 0 over 60 s
- [ ] Queue depth stays 0
- [ ] The camera indicator light goes out **immediately** on Stop
- [ ] **Events** page shows `perception.person.detected` for your camera
- [ ] **Incidents** page shows an incident raised from your appearance

---

## 6. Failure and recovery — do all of these

| # | Do | Expect |
| --- | --- | --- |
| 6.1 | Press Start, then **Block** at the browser prompt | Red banner `permission-denied` explaining the page cannot re-prompt. Not a stack trace. |
| 6.2 | Re-allow in site settings, reload, Start | Capture works |
| 6.3 | Open Zoom (grab the camera), then Start | `device-busy`, naming the cause |
| 6.4 | Start, then **unplug the USB camera** (or disable the built-in one) | ⛔ **Within ~2 s: `device-lost` and capture STOPS.** The preview must not freeze and keep uploading — see §7 |
| 6.5 | Start, then **reload the page** | Page returns to idle; at most one session on the camera |
| 6.6 | Start, then **close the tab**; reopen and go to Live Capture | The stale session disappears within **60 s** (the idle reaper) |
| 6.7 | Start, Stop, Start again | Works — a second capture on the same camera must be possible |
| 6.8 | With two cameras: Start, Stop, switch device, Start | The new device's label appears in the geometry line |
| 6.9 | Sign in as the viewer, look at the sidebar | **Live Capture is absent** |
| 6.10 | As viewer, browse to `/live/webcam` directly | The page loads but the API refuses; no frames are ingested |

⛔ **6.4 is the most important test in this guide.** Without the `ended` handler the video element
freezes on its last frame and the page keeps posting that still image — the platform then records a
person standing perfectly motionless until the tab closes. That is a *fabricated observation*, which
an evidence platform must never produce.

---

## 7. Known limitations — expected behaviour, not defects

| Observation | Why |
| --- | --- |
| Leaving and re-entering gives a **new** track id | ADR-0038 forbids id reuse. The subject keeps its `identityId` and the new track carries `precededBy`. Group by `identityId`, never by `trackId`. |
| Boxes lag the preview by ~0.5–2 s | Tracks are polled every 2 s. The page prints the lag rather than pretending it is instant. |
| A closed tab leaves a session for up to 60 s | A closed tab sends nothing; the platform cannot know. The reaper is the backstop. |
| One event per person per 10 s, not per frame | L-57 — event dedup. A 30 s appearance yields ~3 events, not 120. |
| Detection degrades badly in strong backlight | Measured: ~30 % of frames. See [LIVE_WEBCAM_VALIDATION.md](LIVE_WEBCAM_VALIDATION.md). |
| A camera mounted 90° wrong detects **nothing** | The detector has not been trained on people lying sideways. Measured; recorded as a limitation. |
| Frames are stamped with the **platform's** clock | The browser's `capturedAt` is used only to measure latency, never as the frame's time. A client-supplied evidentiary timestamp would be a forgery surface. |

---

## 8. What this guide does **not** validate

- **Firefox / Safari capture.** The page loads; capture is uncertified. Chrome and Edge only.
- **Mobile browsers.** Untested.
- **RTSP, ONVIF, NVR, DVR, or any real CCTV camera.** No IP camera has been connected.
- **Multi-camera concurrency.** One capture at a time has been exercised.
- **GPU.** `CPUExecutionProvider` only.
- **Detector accuracy on real CCTV optics.** A webcam is not a CCTV camera: different lens, different
  mounting height, different depression angle, different sensor.

---

## 9. If something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| Start does nothing, no prompt | Certificate untrusted | §2, trust the root cert |
| `permission-denied` immediately | Site permission blocked | Chrome → site settings → Camera → Allow |
| `insecure-context` | Not on HTTPS, or the edge denies the camera | Use `https://localhost`; check `Permissions-Policy` |
| Frames upload, no boxes ever | No AI assignment | §4 step 2. Platform panel shows `Skipped (unassigned)` climbing |
| Queue depth climbing, drops rising | Runtime cannot keep up | Lower fps or edge size; see the back-pressure section of LIVE_WEBCAM_VALIDATION |
| Achieved fps far below target | Tab in the background | Browsers throttle hidden tabs. Keep it foreground |
| Preview black, stages counting | Another app holds the camera | Close it, press Stop then Start |
| "no live ingest session is open" | The reaper took an idle session | Press Start again |

Logs: `docker logs vip-prod-media-1 --tail 200` (ingest), `vip-prod-inference-1` (runtime),
`vip-prod-events-1` (events), `vip-prod-rules-1` (incidents).

---

## 10. Recording the result

Save screenshots and this checklist under `docs/validation/manual/<date>-<operator>/`. ⚠️ A manual
run that is not written down did not happen: the next person cannot tell whether a behaviour is a
regression or has always been that way.
