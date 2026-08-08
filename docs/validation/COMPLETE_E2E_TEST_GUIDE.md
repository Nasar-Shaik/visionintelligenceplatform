# Complete E2E Test Guide — Live Video Validation

> **Who this is for.** A new engineer reproducing every automated result in
> [LIVE_WEBCAM_VALIDATION.md](LIVE_WEBCAM_VALIDATION.md) and
> [LIVE_PERFORMANCE_BASELINE.md](LIVE_PERFORMANCE_BASELINE.md) without asking a question. Every
> command is copy-pasteable.

The one thing here that is **not** automatable is the physical camera — that is
[MANUAL_TEST_GUIDE.md](MANUAL_TEST_GUIDE.md), and it is a required part of the validation, not an
optional extra.

---

## 1. Environment

| | |
| --- | --- |
| Node | ≥ 22 |
| pnpm | via corepack |
| Docker | Desktop, ≥ 8 GB |
| Disk | ≥ 25 GB — the Y4M corpus alone is ~3 GB |
| Browser | Chromium via Playwright (`pnpm --filter @vip/e2e-browser exec playwright install chromium`) |
| Base URL | `https://localhost` (override `VIP_BASE_URL`) |
| Tenant | `tnt_demo_retail` (override `VIP_TENANT`) |
| Login | `security.manager@northgate.demo` / `12345678` (override `VIP_EMAIL` / `VIP_PASSWORD`) |
| Role needed | `stream:control` — held by `admin` and `operator` |

⚠️ `SEED_PASSWORD` in `.env.production` does **not** work for the demo tenants.

⚠️ **`NODE_TLS_REJECT_UNAUTHORIZED=0` is set inside the validation tools** because the edge uses
Caddy's internal CA. It is scoped to those files and appears nowhere in the application — the same
reasoning as `ignoreHTTPSErrors` in `playwright.config.ts`.

---

## 2. Deploy and verify

```bash
pnpm install
./infra/docker/prod.sh build
./infra/docker/prod.sh up -d

docker ps --format '{{.Names}}\t{{.Status}}' | grep vip-prod   # 14 containers, all healthy
curl -sk https://localhost/health
curl -skI https://localhost/ | grep -i permissions-policy      # camera=(self), microphone=()
```

⛔ Never bare `docker compose`. Always `./infra/docker/prod.sh`.

---

## 3. Create the live camera (once)

```bash
export VIP_BASE_URL=https://localhost VIP_TENANT=tnt_demo_retail
export VIP_EMAIL=security.manager@northgate.demo VIP_PASSWORD=12345678
```

Through the console: **Cameras → Add camera** (protocol `rtsp`, any URL — it is never dialled), then
**Assignment → Camera Assignment → Enable** with profile `person-tracking`, runtime `inference`.

```bash
export VIP_LIVE_CAMERA=cam_...        # the id from the camera's URL
```

⛔ Without the assignment, every frame is accepted and then skipped at the gate (L-65). The symptom
is `framesSkippedUnassigned` climbing and zero detections.

---

## 4. Unit and integration tests (no deployment needed)

```bash
pnpm turbo lint typecheck test        # 70 tasks — the full repo gate
```

Live-video specific:

```bash
# Browser capture logic — pacing, drop-not-queue, percentiles, clock offset, base64 chunking
pnpm --filter @vip/console exec vitest run src/features/livecam/

# Live ingest — clock ownership, evidence ring, session lifecycle, tenant scoping
pnpm --filter @vip/service-media exec vitest run test/live-ingest.test.ts

# ⭐ The architectural rule, as a test: one inference path, one tracker, one sink
pnpm --filter @vip/service-media exec vitest run test/one-pipeline.test.ts

# Gateway binary forwarding — the regression that corrupted every binary body
pnpm --filter @vip/service-gateway exec vitest run test/http.test.ts
```

⭐ `one-pipeline.test.ts` is the source-agnosticism proof. It reads the source and fails if anyone
adds a second `/infer` call, a second tracker, or gives `LiveIngest` its own sink. A diagram would be
true the day it was drawn; this stays true.

---

## 5. Browser certification and recovery

```bash
cd tools/e2e-browser
pnpm exec playwright install chromium
pnpm exec playwright test livecam.spec.ts --project=chromium
```

⚠️ Chromium only — `--use-fake-device-for-media-stream` is a Chromium switch. The spec **skips**
explicitly on other engines rather than reporting a Chromium pass as a Firefox one.

Covers: capture + upload + platform agreement · clock offset reported with uncertainty · stop
releases the session · refresh leaves no duplicate · restart on the same camera · **device-lost stops
capture** · closed tab leaves at most one session · denied permission is an instruction · the edge
permits the camera and denies the microphone.

---

## 6. The scenario matrix (27 scenarios)

### 6.1 Build the Y4M corpus (~3 GB, once)

```bash
node tools/validation/livecam/make-y4m.mjs --out /tmp/vip-y4m --fps 10 --seconds 30
```

Uses ffmpeg **inside the media image**, so no host ffmpeg is needed and it is the same ffmpeg the
platform decodes with.

⛔ **Y4M, not MJPEG**, so the frames reaching `getUserMedia` carry no second generation of
compression. ⛔ **`-pix_fmt yuv420p` is mandatory** — Chrome's fake device reads I420 only, and any
other pixel format produces a **black stream** that looks exactly like an empty scene.

### 6.2 Run

```bash
cd tools/e2e-browser
node livecam-matrix.mjs \
  --y4m /tmp/vip-y4m \
  --camera "$VIP_LIVE_CAMERA" \
  --seconds 15 --fps 4 \
  --out artifacts/livecam
```

~25 minutes. A **fresh browser per scenario** — `--use-file-for-fake-video-capture` is a launch flag
Chrome reads once, so reusing a browser would run every later scenario against the first scenario's
footage while the report named a different file.

### 6.3 Two traps this harness already fell into

⛔ **Chrome loops the Y4M.** A 20 s file under a 20 s capture restarted mid-run; the subject
teleported from one edge to the other and the tracker correctly opened a second track. The matrix
reported "one person, two tracks" and it read as fragmentation. Fixed by building 30 s files and
capturing 15 s; every row carries `looped: false` and `browserLifetimeSeconds` so the margin is
checkable.

⛔ **The event count is not a detection count.** Events are deduplicated per track per 10 s (L-57), so
`events: 0` can mean "detection is working perfectly". The matrix reads
`detectionsPublished` from the event bridge, which is upstream of that dedup. Both are reported.

### 6.4 Reading a row

```
crowd   det=592/74f empty=0 tracks+5 active=8 events=8 incidents=8 expected=8
         │    │      │        │        │                             └ ground truth from the fixture manifest
         │    │      │        │        └ active tracks at the end
         │    │      │        └ tracks created during the window
         │    │      └ frames the publisher suppressed for carrying no detections
         │    └ frames that produced at least one detection
         └ total detections
```

⭐ `592 / 74 = exactly 8.0 per frame` against a ground truth of 8. `empty-room` must read
`det=0/0f empty=73` — a negative control that proves the instrument can read zero.

---

## 7. Stage-by-stage latency

```bash
cd tools/e2e-browser
node livecam-latency.mjs --camera "$VIP_LIVE_CAMERA" --seconds 90 --fps 4 \
  --y4m /tmp/vip-y4m/one-person.y4m \
  --out artifacts/livecam/latency.json
```

Reports nine stages, each tagged **measured**, **reported** (the component's own clock) or
**derived** (a remainder after subtraction).

⚠️ A derived stage inherits the error of everything subtracted from it and **may be negative**. That
is information, not a bug to clamp — a negative remainder printed as `0` would be a silent claim that
the stage is instant.

---

## 8. Back-pressure

```bash
mkdir -p /tmp/vip-jpg
docker run --rm \
  -v "$PWD/infra/docker/fixtures/media/validation:/in" -v /tmp/vip-jpg:/out \
  --entrypoint ffmpeg vip/media:local \
  -nostdin -y -i /in/single-person-walking.mp4 -r 10 -q:v 3 /out/%03d.jpg

node tools/validation/livecam/bench.mjs pressure \
  --camera "$VIP_LIVE_CAMERA" --frames /tmp/vip-jpg \
  --out /tmp/livecam-pressure.json
```

Four minutes: **baseline** (4 fps, 1 in flight, 60 s) → **overload** (25 fps, 12 in flight, 90 s) →
**recovery** (4 fps, 1 in flight, 90 s).

⚠️ The middle phase is *meant* to hurt. The claim under test is not "it never drops" — `FrameSink`
drops by design and says so. The claim is that it drops the right frames, keeps serving, and
**recovers**, which only the third phase can show.

⚠️ Driven by a script rather than the page, because the page deliberately keeps **one** upload in
flight so `uploadMs` means "how long the network took". Everything downstream of the POST is
identical.

---

## 9. Frame-rate benchmark

```bash
node tools/validation/livecam/bench.mjs fps \
  --camera "$VIP_LIVE_CAMERA" --frames /tmp/vip-jpg --seconds 60 \
  --out /tmp/livecam-fps.json
```

1, 2, 4, 8, 15 fps, 60 s each, with CPU and memory per service.

⚠️ A **15 s gap** between rates, longer than the tracker's `reentryGapSeconds` (12 s). Without it the
last subject of one rate is linked as a re-entry of the first subject of the next, and the recovery
counts become a property of the benchmark rather than of the footage.

---

## 10. Long-running soak

```bash
caffeinate -dimsu node tools/validation/livecam/bench.mjs soak \
  --camera "$VIP_LIVE_CAMERA" --frames /tmp/vip-jpg --seconds 1800 \
  --out /tmp/livecam-soak.json
```

30 minutes. Watches **drift**, not throughput: memory that only rises, a queue that never returns to
zero, a latency worse in the last tenth than the first. It reports first-tenth vs last-tenth
explicitly, because a single average over 30 minutes hides a monotone rise completely.

⛔ **`caffeinate` is not decoration.** A host that sleeps freezes the process while `Date.now()` runs
on, so the run divides its frames by a clock nobody was awake for. This happened: 966 s of
suspension turned a true 4.000 fps into a recorded **2.6 fps**, past both the rejection guard and the
duplicate-sender guard. The run now checks its own sampler heartbeat and **exits non-zero** if the
process was awake for less than 90 % of the requested duration; `report.mjs` prints the suspension
above the tables rather than as a footnote. The three ways to invalidate this run, in order of how
easily each is missed:

| | Symptom | Guard |
| --- | --- | --- |
| A second sender | Ingest at a clean multiple of the target rate | Pre-flight session check; `framesAccepted` vs `sent` |
| Token expiry | Rejections at a perfectly healthy cadence | 401 refresh; >1 % refused → exit 1 |
| Host suspension | Frame count that contradicts the elapsed time | Sampler-heartbeat continuity → exit 1 |

⚠️ **30 minutes is a daytime stability check, not a release soak.** The run that certifies a build is
6–7 hours: [OVERNIGHT_SOAK](../runbooks/OVERNIGHT_SOAK.md).

---

## 11. Offline / live parity

```bash
node tools/validation/livecam/parity.mjs \
  --camera "$VIP_LIVE_CAMERA" --clip single-person-walking \
  --live tools/e2e-browser/artifacts/livecam/matrix.json --live-scenario one-person \
  --out /tmp/livecam-parity.json
```

Runs the **same footage** through the offline analysis path and compares against its live run.

⚠️ The counts differ **by design** — offline delivers every frame losslessly (`deliver` waits), live
samples and drops (`push`). What must match is the execution path (model id, model version, runtime
version, execution provider, capability, event types) and the per-frame detection **rate**.

---

## 12. Pass criteria

| # | Criterion |
| --- | --- |
| 1 | `pnpm turbo lint typecheck test` — 70/70 tasks pass |
| 2 | `one-pipeline.test.ts` passes — one inference path, one tracker, one shared sink |
| 3 | `livecam.spec.ts` passes on Chromium, including `device-lost` |
| 4 | Matrix: `empty-room` reports **0** detections; `crowd` reports its ground-truth count per frame |
| 5 | Matrix: every row `looped: false` |
| 6 | Latency: all nine stages report, none silently as `0` |
| 7 | Back-pressure: queue rises under overload and **returns to 0** in recovery; failures 0 |
| 8 | FPS: achieved within 10 % of target at 1/2/4; deviation at 8/15 recorded, not hidden |
| 9 | Soak: last-tenth memory within 10 % of first-tenth; queue max bounded; latency drift < 20 % |
| 10 | Parity: identical model id, model version, runtime version, execution provider, event types |
| 11 | Manual guide completed on a real camera, screenshots saved |

⛔ **Criterion 11 is not optional.** Every automated step above substitutes Chrome's fake device for
the camera. Nothing in this file has ever seen a lens.

---

## 13. Clean up

```bash
rm -rf /tmp/vip-y4m /tmp/vip-jpg          # ~3 GB
./infra/docker/prod.sh down                # keep volumes
```

⚠️ The demo tenant accumulates cameras, analyses and incidents across runs. Reset with
`./infra/docker/prod.sh down -v && ./infra/docker/prod.sh up -d && pnpm seed:demo` — which **destroys
all data**.
