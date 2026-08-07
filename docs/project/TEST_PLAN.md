# Test Plan

> **The permanent regression strategy.** Its purpose is that every future milestone can be validated
> without rebuilding any of this — the dataset, the harnesses and the categories below are fixtures
> of the project, not of P-8.5.

**Last executed: 2026-08-07** against the deployed production stack.

---

## The layers, and what each can and cannot prove

⛔ **The single most important idea in this document.** Each layer is fast and cheap in inverse
proportion to what it can prove, and confusing the two is how a platform ships 1 700 passing tests
with four critical defects in it — which is exactly what P-8.5 found.

| Layer | Runs against | Proves | ⛔ Cannot prove | Count |
| --- | --- | --- | --- | --- |
| **Unit / integration** | Doubles, in-process | The code is right | That it is wired to anything | ~1 700 TS |
| **Runtime (Python)** | In-process, stdlib | Tracking, association, contracts | That media reaches it | 1 057 |
| **Deployment harness** | The real stack, via API | The **joins** work | What a browser does with it | 37 clips |
| **Browser (Playwright)** | Real Chromium/Edge/Firefox/WebKit over TLS | The **product** works | Anything about real footage | 20 specs |
| **Real footage** | ⛔ Does not exist | — | — | 0 |

> Every serious defect P-8 and P-8.5 found lived in a **join**: a URL presigned for the wrong
> audience, a dedup key a rerun collided with, a `msgId` the broker discarded, a tracker keyed on the
> camera rather than the stream. Not one was visible to the layer above it.

## Running everything

```sh
pnpm turbo lint typecheck test                                  # the repo gate (69 tasks)
docker exec vip-prod-inference-1 sh -c \
  'cd /app && PYTHONPATH=/app python -m unittest discover -s /app/tests -p "test_*.py" -t /app/tests'
node tools/validation/verify-deployment.mjs                     # 31 deployment checks
node tools/dataset/generate.mjs --verify                        # rebuild + re-measure the dataset
node tools/validation/validate.mjs --all                        # 37 journeys through the real stack
pnpm --filter @vip/e2e-browser certify                          # browser certification, 4 engines
```

⚠️ The last three **need the deployment up** (`./infra/docker/prod.sh up -d`). They are not part of
the repo gate and must not be: a gate that needs Docker is a gate that gets skipped.

---

## Test IDs

`VIP-<CATEGORY>-<nnn>`. Categories map to the request that commissioned this plan.

### Pass/Fail criteria — global

| | |
| --- | --- |
| **Pass** | Every assertion holds **and** the run reached a terminal state |
| **Fail** | Any assertion fails, **or** a session never terminates, **or** a result is reported that was not measured |
| ⛔ **Also fail** | A run reports `succeeded` having analysed nothing. This presented as a *pass* during P-8.5 and is the most misleading state the platform can reach |

---

### VIP-UNIT · Unit

| ID | Subject | Where | Automated | Pass |
| --- | --- | --- | --- | --- |
| UNIT-001 | Contract schemas round-trip | `packages/contracts` (29 files) | ✅ | `pnpm turbo test` |
| UNIT-002 | Tenant scope fails closed | `packages/tenancy` | ✅ | No cross-tenant read possible |
| UNIT-003 | Object store presign audiences | `packages/storage` | ✅ | Internal ≠ browser URL |
| UNIT-004 | Timeline arithmetic | `services/media/test/analysis-timeline` | ✅ | Offsets clamped, never NaN |
| UNIT-005 | Dwell / loiter domain | `services/rules/test/dwell,loitering` | ✅ | 279 rules tests |
| UNIT-006 | Incident lifecycle (ADR-0045) | `services/workflow` | ✅ | Illegal transitions refused |
| UNIT-007 | ⛔ **`redactUrls` strips a signed URL, keeps the reason** | `services/media/test/analysis-snapshot` | ✅ | **[V-5]** |

### VIP-INT · Integration

| ID | Subject | Where | Automated | Pass |
| --- | --- | --- | --- | --- |
| INT-001 | events → rules → workflow → notify spine | `tools/e2e` (7 files) | ✅ | Broker-free, deterministic |
| INT-002 | Mongo repositories under a real driver | `*/mongo-integration.test.ts` | ✅ | `pnpm turbo test:integration` |
| INT-003 | ⛔ **Live dedup keys byte-identical after ADR-0047** | `services/events`, `services/rules` | ✅ | Shape unchanged when the field is absent |

### VIP-API · API

| ID | Subject | Automated | Pass |
| --- | --- | --- | --- |
| API-001 | Every route requires auth | ✅ `security.spec.ts` | 401 unauthenticated |
| API-002 | Cross-tenant read refused | ✅ `security.spec.ts` | Tenant from token, never header |
| API-003 | Analysis CRUD + confirm + sessions + timeline + report + snapshot + playback | ✅ `validate.mjs` | All stages 2xx |
| API-004 | ⛔ **No signed URL in any error body** | ✅ `security.spec.ts` | **[V-5]** |
| API-005 | Size ceiling refused before upload | ✅ `performance.spec.ts` | 400 naming the limit |

### VIP-RT · Runtime

| ID | Subject | Automated | Pass |
| --- | --- | --- | --- |
| RT-001 | Two people in the reference frame | ✅ `generate.mjs --verify` | Exactly 2 — not "> 0" |
| RT-002 | ⭐ Empty background → zero detections | ✅ `generate.mjs --verify` | 0. **The negative control** |
| RT-003 | ⛔ **Two runs of one recording do not silence each other** | ✅ `test_runtime_tracking.py` | **[V-2]** `outOfOrderFrames: 0` |
| RT-004 | ⛔ **Two runs mint different track ids** | ✅ `test_runtime_tracking.py` | ADR-0047 for identities |
| RT-005 | ⭐ **A live camera is unchanged when no run is named** | ✅ `test_runtime_tracking.py` | Backward compatibility |
| RT-006 | ⛔ **An offline run cannot stall the live camera it analyses** | ✅ `test_runtime_tracking.py` | Future-dated footage |

### VIP-WRK · Worker · VIP-UP · Upload · VIP-ST · Storage · VIP-FF · FFmpeg

| ID | Subject | Automated | Pass |
| --- | --- | --- | --- |
| WRK-001 | Session reaches a terminal state | ✅ `validate.mjs` | Never stuck in `running` |
| WRK-002 | Progress observed moving mid-run | ✅ `journey.spec.ts` | Not 0 → 100 |
| WRK-003 | Queue serialises under load | ✅ `--concurrent=10` | 10/10, identical results |
| WRK-004 | ⛔ **Assignment recovers on a full runtime** | ✅ `assignment.test.ts` | **[V-1]** |
| UP-001 | Presigned PUT direct to storage | ✅ `validate.mjs` | Never through the gateway |
| UP-002 | Declared vs actual byte mismatch refused | ✅ | Named reason |
| UP-003 | Multiple uploads stay separate | ✅ `performance.spec.ts` | 3 distinct ids |
| ST-001 | Tenant prefixing on every key | ✅ unit + `validate.mjs` | `tnt_*/…` |
| ST-002 | Evidence origin reachable **through the edge** | ✅ `security.spec.ts` | Same origin, no CORS |
| ST-003 | Storage growth measured | ✅ `validate.mjs` | Recorded, not estimated |
| FF-001 | Chunked decode: `-ss` **before** `-i` | ✅ unit | Fast seek |
| FF-002 | Snapshot: `-ss` **after** `-i` | ✅ unit | ⭐ Accurate seek — evidence must show the moment, not a GOP earlier |
| FF-003 | Probe rejects a container with no video | ✅ `security.spec.ts` | `corrupt-audio-only` |
| FF-004 | Decimation to the requested rate | ✅ `high-fps`, `low-fps` | Exact frame count |

### VIP-OFF · Offline analysis · VIP-TRK · Tracking · VIP-RULE · Rules · VIP-EVT · Events

| ID | Subject | Clip | Pass |
| --- | --- | --- | --- |
| OFF-001 | 1× vs 8× analytical parity | any | Byte-identical events; only wall clock differs |
| OFF-002 | ⛔ **Rerun reproducibility** | `duration-5min` | **[V-4]** Both runs: 20 events, 5 tracks, 10 incidents |
| OFF-003 | Provenance complete on every frame | any | frame no., PTS (nullable), offset, session, chunk, decoder |
| OFF-004 | ⭐ Source rate below analysis rate stays honest | `low-fps` | `ptsSeconds` may be null; offset never is |
| TRK-001 | One object → one identity | `single-person-walking` | 1 track |
| TRK-002 | Identity survives occlusion | `occlusion` | 1 track |
| TRK-003 | No swap when two cross | `multiple-people` | Each keeps its row |
| TRK-004 | ⭐ Crowd produces distinct identities | `crowd` | **8** tracks — 0 before [V-2] |
| TRK-005 | ⚠️ Fast movement fragments — reported, not asserted away | `fast-movement` | Recorded in the manifest |
| RULE-001 | Dwell fires once, not per frame | `retail-loitering` | 1 candidate per visit |
| RULE-002 | Zone entry fires on the transition | `restricted-zone` | 1 entry |
| RULE-003 | Two subjects → two dedup keys | unit | Neither vanishes |
| EVT-001 | Events scale linearly with duration | ladder | 4/min, 1 track/min |
| EVT-002 | ⛔ **Offline events never in the live feed** | ✅ `performance.spec.ts` | 0 leaked |
| EVT-003 | ⭐ **Empty scene → 0 events** | `empty-scene` | **The negative control** |

### VIP-TL · Timeline · VIP-INC · Incidents · VIP-EV · Evidence · VIP-EX · Export

| ID | Subject | Pass |
| --- | --- | --- |
| TL-001 | Derived from events, never stored | Re-derivable after a rerun |
| TL-002 | Truncation says so | "the first N of a longer run" |
| TL-003 | Query time scales sub-linearly | 21 ms @ 30 s → 74 ms @ 30 min |
| TL-004 | ⚠️ **Track spans are real, not zero-width** | **0 of 8** zero-width after [V-2] — closes [L-62] |
| INC-001 | ⛔ **Offline incidents never in the live queue** | 0 leaked, `includeAnalyses` defaults false |
| INC-002 | Reproducible across runs | 10 each, both runs |
| INC-003 | Live incident on an analysed camera still found | Isolation must not swallow live work |
| EV-001 | A real JPEG at a footage offset | SOI bytes checked; URL **fetched** |
| EV-002 | ⭐ Dated by the **footage**, not by capture time | Otherwise last Tuesday's incident happened today |
| EV-003 | Offset past the end refused before ffmpeg | ⛔ A zero-byte object is not evidence |
| EV-004 | ⚠️ `registeredAsEvidence: false` stated plainly | [TD-15] — the honest half |
| EX-001 | ⛔ Report never contradicts itself | Counts derived from contents |
| EX-002 | Report reflects the caller's permissions | Caller's token forwarded, never a service key |

### VIP-UI · Investigation UI · VIP-DEMO · Demonstration Mode · VIP-E2E · Browser

| ID | Subject | Engines | Pass |
| --- | --- | --- | --- |
| UI-001 | Login → nav → upload → run → timeline → evidence → export | 4 | Full journey |
| UI-002 | ⛔ Upload disabled until a camera is chosen | 4 | The camera carries zones and rules |
| UI-003 | Limits stated **before** a file is picked | 4 | Not after a rejection |
| UI-004 | ⭐ Empty scene says *"Nothing was detected"* | 4 | Not a blank panel |
| UI-005 | ⛔ *"Incidents could not be looked up"* absent | 4 | The fourth state, not an empty list |
| UI-006 | Survives refresh + cold deep link | 4 | A bookmark works tomorrow |
| UI-007 | ⛔ **No two nav items share a label or route** | unit | **[V-6]** |
| UI-008 | A viewer is not shown a control they cannot use | 4 | Disabled or absent |
| UI-009 | 404 renders a page, not a stack trace | 4 | No `TypeError:` in the body |
| DEMO-001 | Real-time pacing is measurably slower | 4 | Still running after 10 s |
| DEMO-002 | Same pipeline, one parameter | — | No second code path |

### VIP-PERF · VIP-CONC · VIP-REC · VIP-FAIL · VIP-SEC

| ID | Subject | Pass |
| --- | --- | --- |
| PERF-001 | Speed factor stable across duration | ×8.8–×9.1 over 30× |
| PERF-002 | Evidence still is O(1) in length | ~130 ms at 1 min and 30 min |
| PERF-003 | Memory bounded | media 141 → 173 MiB over 30× |
| CONC-001 | 1 · 2 · 5 · 10 simultaneous uploads | All complete |
| CONC-002 | ⭐ **Results identical under concurrency** | One distinct tuple across 10 |
| REC-001 | ⛔ **Recovers from a runtime restart** | **[V-1]** — was a permanent deadlock |
| REC-002 | Rerun after a rule change | New session, history preserved |
| FAIL-001 | Zero-byte / header-only / not-a-video / audio-only refused | Named reason each |
| FAIL-002 | ⭐ **Truncated tail ends honestly** | 28 real frames, not the 60 the header claimed |
| FAIL-003 | Bit-flips decode or fail — never silently nothing | 60 frames + artefacts |
| SEC-001 | HSTS · CSP · X-Frame-Options · nosniff · Permissions-Policy · no `Server` | All present |
| SEC-002 | Plaintext **redirects**, not resets | 308 |
| SEC-003 | ⛔ **No credential in any error body** | **[V-5]** |
| SEC-004 | Cross-tenant read refused | Token is authoritative |

---

## Required fixtures

| Fixture | Source | Committed |
| --- | --- | --- |
| `scene-people.jpg` | Wikimedia, **CC0** — two officers, 640×360 | ✅ |
| 37 validation clips | `tools/dataset/generate.mjs --verify` | ❌ recipe only (~22 MB) |
| `manifest.json` | ⭐ Measured ground truth | ✅ **committed** — a suite whose expectations regenerate itself can never fail |
| Duration ladder | `tools/dataset/large.mjs` | ❌ on demand |
| Demo tenant | `pnpm seed:demo` | ✅ |

## Sample videos required

See **[TEST_DATASET.md](TEST_DATASET.md)**. 37 exist. ⛔ **Six do not**: `real-shop`,
`mall-concourse`, `warehouse`, `hospital-corridor`, `factory-floor`, `parking-area`. Every claim
about detector accuracy in a real venue is blocked behind them.

---

## ⛔ Future hardware tests — none of this has been executed

**[L-1] has not moved.** No camera has ever been connected to this platform.

| ID | Test | Needs | Blocks |
| --- | --- | --- | --- |
| HW-001 | RTSP from a real IP camera (H.264 + H.265) | One camera per vendor family: Hikvision, Dahua, CP Plus, UNV, Axis | Every vendor-compatibility statement |
| HW-002 | ONVIF Profile S discovery | The same devices | Auto-onboarding |
| HW-003 | RTSP over Wi-Fi, degraded link | Camera + controllable AP | Packet loss, reconnect, frame-drop honesty |
| HW-004 | NVR multi-channel pull | A 4-channel NVR | NVR-backed deployments |
| HW-005 | 24 h continuous soak on real hardware | Any certified camera | Memory growth, reconnect, clock drift |
| HW-006 | PTZ move during analysis | A PTZ camera | Whether tracking survives the world moving — `camera-shake` only approximates it |
| HW-007 | Real low-light day→dusk | Outdoor camera | The honest version of `night-footage` |
| HW-008 | USB webcam capture | A UVC device | ⚠️ Currently **not** a certification path |

⚠️ **The `FrameSource` seam is the reason these are additive.** Stored media, RTSP, USB and ONVIF are
all one abstraction, so HW-001…008 add sources — they do not change the pipeline they feed.

---

## Automation status

| Category | Automated | Manual | Not possible yet |
| --- | --- | --- | --- |
| Unit · Integration · API · Runtime · Worker · Upload · Storage · FFmpeg | ✅ | — | — |
| Offline · Tracking · Rules · Events · Timeline · Incidents · Evidence · Export | ✅ | — | — |
| UI · Demonstration · Browser E2E | ✅ 4 engines | — | — |
| Performance · Concurrency · Recovery · Failure paths · Security | ✅ | — | — |
| **Large files ≥ 2 GB** | ⚠️ boundary only | real transfer | **[L-66]** |
| **Real-footage accuracy** | ❌ | ❌ | ⛔ **[L-1], [L-63], [L-64]** |
| **Hardware (HW-001…008)** | ❌ | ❌ | ⛔ **P-9 — no hardware exists** |

---

## Related

- [TEST_DATASET.md](TEST_DATASET.md) · [END_TO_END_TEST_GUIDE.md](END_TO_END_TEST_GUIDE.md)
- [FIRST_PRODUCT_VALIDATION.md](FIRST_PRODUCT_VALIDATION.md) · [PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md)
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)
