# P-9 Track A — close-out report

**2026-08-07.** Track A (pre-hardware engineering) is **complete**. Track B is gated on physical
hardware and is not started.

> ⭐ **The milestone's headline is not a feature.** P-9 read like "build a hardware validation
> system". Almost all of it had been built between P-1 and AI-5e and **switched off** — and switching
> it on found eleven defects in code that had passed its own tests for eight milestones.

---

## 1 · Implementation summary

| Task     | Delivered                                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0-1** | [P9_HARDWARE_PROCUREMENT](P9_HARDWARE_PROCUREMENT.md) — customer-grade specification; the requirement is derived from the certification blocker list, not guessed                   |
| **A1**   | `CAMERA_DISCOVERY_URL` wired in production. ⛔ Unset in **every deployment ever made**                                                                                              |
| **A2**   | Staged probing works. Three runtime defects fixed; a credentialed RTSP fixture added                                                                                                |
| **A3**   | `certify_cli` runs in the deployed image against live and simulated sources                                                                                                         |
| **A4**   | Committed **normalised** baseline bundle — the verdict and its reasoning, not a raw artifact that differs from itself every run                                                     |
| **A4.5** | 1 / 2 / 4 cameras, probed **concurrently**                                                                                                                                          |
| **A5**   | Real HEVC fixtures decoded in five engines. **TD-29 closed**                                                                                                                        |
| **A6**   | `promote_from_bundle()` — one guarded path, verdict re-derived. [ADR-0046](../adr/ADR-0046-promotion-only-from-a-bundle.md)                                                         |
| **A7**   | `installer_cli.py` — one command, nine stages, report + snapshot                                                                                                                    |
| **A8**   | `hardware/certification.sh` registered on the nightly `hardware` profile. ⚠️ Registered, not run                                                                                    |
| **A9**   | Real lens → deployed ONNX runtime → detections → tracking → overlays                                                                                                                |
| **A10**  | Customer Demonstration Mode — live video, boxes, ids, FPS, rule/incident panel                                                                                                      |
| **A11**  | 11 stress scenarios specified; 8 executable, all passing                                                                                                                            |
| —        | [GOLDEN_CAMERA_DATASET](GOLDEN_CAMERA_DATASET.md), [FIELD_INSTALLATION_GUIDE](FIELD_INSTALLATION_GUIDE.md), generated [CAMERA_COMPATIBILITY_MATRIX](CAMERA_COMPATIBILITY_MATRIX.md) |

### The eleven product defects, and why they had never fired

Each was invisible until the one before it was fixed. **Nothing in a deployment had ever called
these paths**, because A1's variable was unset.

| #   | Defect                                                                 | What it looked like                                                                                 |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | `CAMERA_DISCOVERY_URL` unset                                           | "Scan network" reported _not configured_ in every deployment                                        |
| 2   | ⛔ `opencv` in **neither** requirements file                           | `/streams/validate` crashed; surfaced as _"the stream validator is unreachable"_                    |
| 3   | No exception handler on device-facing routes                           | The crash reset the socket, so a missing package read as a network fault                            |
| 4   | ⭐ Auth verdict pattern-matched an error string OpenCV never populates | **A wrong password** — the commonest install fault — reported `stream-interrupted`                  |
| 5   | Inline pump on an unbounded source                                     | `certify_cli` against a live camera **hung forever**                                                |
| 6   | ⛔ Decoder released while the pump thread was inside native `read()`   | **SIGSEGV** after printing a complete, correct summary                                              |
| 7   | `ThreadExecutor.join` joining the calling thread                       | Latent `RuntimeError` on a finite source's own teardown                                             |
| 8   | ⛔ Promotion guard mutated, then validated                             | A refused promotion **wrote `certified`/`simulated` to disk** and bricked the registry on next load |
| 9   | Promotion accepted a bare dict                                         | A hand-written summary was indistinguishable from a measured one                                    |
| 10  | `--write-registry` `PermissionError` in the container                  | The exact command a field engineer runs could not work                                              |
| 11  | ⭐ No open/read timeout on the capture                                 | A stalled camera reported _"we could not test"_ — blaming the platform                              |

⭐ **Defects 6 and 11 are one root cause reached from opposite directions**, and neither looked like
the other. That is recorded in [VERIFICATION_AUDIT](VERIFICATION_AUDIT.md) as the milestone's most
transferable lesson.

---

## 2 · Verification summary

**138/138 checks, authoritative, on a clean tree against the deployed stack.**

| Verification                |   Checks | Findings |
| --------------------------- | -------: | -------: |
| `discovery.mjs` (A1)        |    16/16 |        1 |
| `stream-probe.mjs` (A2)     |    40/40 |        3 |
| `certification.mjs` (A3+A4) |    27/27 |        1 |
| `multi-camera.mjs` (A4.5)   |    35/35 |        1 |
| `stress.mjs` (A11)          |    11/11 |        3 |
| `h265.mjs` (A5)             |      9/9 |        1 |
| **Runtime unit tests**      | **1057** |        — |

⚠️ **Ten defects were in the verifications themselves**, and three would have produced confident
wrong conclusions: a fixture that never started reported as `0/4 cameras decoded`; a missing
range-request handler reported as "no engine decodes HEVC"; a hand-copied contract subset reported as
contract violations. **The H.264 control case is what exposed the second**, and it is the reason a
control belongs in every measurement suite.

⭐ **Findings are not failures and are never suppressed.** The superlinear concurrent-probe cost
(4 cameras = 5.19× one camera) is reported, not asserted — it was measured on a laptop under load,
so the shape is meaningful and the magnitude is not quotable.

---

## 3 · Acceptance checklist

See [P9_TRACK_A_ACCEPTANCE](P9_TRACK_A_ACCEPTANCE.md). **17 of 17 items verified**, one qualified:
ONVIF discovery is **wired and exercised**; no ONVIF device has ever answered.

---

## 4 · Remaining Track B tasks

| Task                                                           | Needs                            | Effort |
| -------------------------------------------------------------- | -------------------------------- | -----: |
| **B1** One camera onboarded, probed, capability-refreshed      | 1 camera + managed PoE switch    |    2 d |
| ⭐ **B4** Zone geometry at three mounting angles               | B1 + tape measure + inclinometer |    1 d |
| **B2** NVR + real exported recordings incl. a stop/restart gap | NVR ≥4ch, ≥72 h                  |    3 d |
| **B5** H.265 **from a camera**                                 | any H.265 camera                 |  0.5 d |
| **B3** Repeat across five vendor families                      | 5 cameras                        |    4 d |
| **S9/S10/S11** reboot · slow network · packet loss             | managed switch / netem           |    1 d |
| **Golden Camera Dataset** capture (T1–T4)                      | certified cameras + consent      |    2 d |
| **C1–C3** `CCTV_READINESS` becomes a supported-hardware list   | B1–B3 complete                   |    1 d |

**~2 engineer-weeks once hardware is present.** Critical path: `procurement → B1 → B2 → B3 → C1`.

⭐ **B4 goes second, immediately after B1** — a deliberate reordering. Every configuration-only
capability on the roadmap is the same polygon test, validated only against synthetic coordinates. It
is one afternoon and it invalidates the most if it fails.

---

## 5 · Procurement readiness

✅ **Ready to order today.** [P9_HARDWARE_PROCUREMENT](P9_HARDWARE_PROCUREMENT.md) §2 is a complete
line-item specification. Nothing else in Track B is blocked on engineering.

⛔ **One line decides whether anything can be certified at all: the managed PoE switch.**
`reconnect-recovery` requires a deliberate, repeatable link interruption at a known moment. Five
cameras without it produce five devices that connect and **not one that can be certified**.

---

## 6 · Risks

| Risk                                                     | Severity | Position                                                                                                                                               |
| -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ⛔ **Hardware does not arrive**                          | High     | Track A is done and delivers standalone value. Track B stalls entirely                                                                                 |
| ⚠️ **Managed switch cut from the order**                 | High     | Nothing certifies. The cameras become a demo                                                                                                           |
| ⚠️ **Zone geometry fails against a real lens (B4)**      | High     | ⭐ Repair is a calibration step the product does not have, landing _underneath_ every capability. This is why B4 is second                             |
| ⚠️ **Routed network on site**                            | Medium   | ONVIF discovery finds nothing by design. B1 still runs by direct endpoint; discovery must then be reported **untested**, not failing                   |
| ⚠️ Concurrent probing is superlinear                     | Medium   | "Test all" on a large estate will be slow. Measured on a laptop; re-measure on the deployment target                                                   |
| ⚠️ Codec is never measured off the wire                  | Medium   | An H.265-only camera onboards with no TD-29 warning. `CAP_PROP_FOURCC` would answer it                                                                 |
| ⚠️ Bundles are not signed                                | Low      | Fine while every bundle comes from this repository. Revisit when installers produce them ([ADR-0046](../adr/ADR-0046-promotion-only-from-a-bundle.md)) |
| ⚠️ Teardown's decoder release is bounded, not eliminated | Low      | If the 3 s join expires the decoder is released anyway. Needs a real stalling device to justify more                                                   |

---

## 7 · ⭐ First physical camera purchase — recommendation

**Buy four things, and buy them together:**

|     | Item                                                                     | Why this one                                                                                |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1   | **Hikvision DS-2CD2xxx**, PoE, dual-stream (main H.265 + sub H.264)      | Largest installed base; unblocks B1, B4, B5 and TD-29's hardware half in a single device    |
| 2   | ⭐ **Managed PoE switch**, ≥8 ports, **per-port power control**          | ⛔ Without it nothing certifies. It is the instrument, not an accessory                     |
| 3   | **NVR, ≥4 channels, ≥1 TB**, HTTP/RTSP export                            | A DVR/NVR is a _different integration_; `generic-nvr` has never met one                     |
| 4   | Cat6 leads, 2 adjustable mounts, tripod, **inclinometer + tape measure** | B4 is a measurement, and without the angle and the distances it degrades into an impression |

**Approximate spend: one camera, one switch, one NVR, cabling.** That set completes **B1, B2, B4 and
B5** — first camera, recordings, zone geometry against a real lens, and H.265 from a device.

⚠️ **Buy the Hikvision _first_, alone, if the budget must be staged.** One camera plus the switch
answers the question that invalidates the most work if the answer is bad. Cameras 2–5 only add
vendor breadth (B3), and vendor breadth is worth nothing if B4 says perspective matters.

---

## 8 · Customer demonstration readiness

✅ **Ready.** `python demo_cli.py --source rtsp --uri <camera> --port 8099` shows live video,
detection boxes, tracked identities, FPS, inference latency, detection counts, and a rule/incident
panel. Verified against a real lens: 18 fps, ~80 ms inference, boxes on every frame.

⚠️ **Three things must be said out loud in front of a customer**, and the page says the first:

1. ⛔ **This is a demonstration transport (MJPEG), not the product's live-video path.** TD-28 is open.
   A demo mistaken for the shipping feature is an expectation the roadmap has to pay for.
2. ⛔ **No camera is certified.** Every matrix row reads `Pending Validation`.
3. ⚠️ Rules and incidents fire in the platform against published events; the demo analyses frames
   directly, so it shows **perception**. Attach the camera in the console to demonstrate incidents.

---

## 9 · Installer readiness

✅ **Ready for a supervised first deployment.** `installer_cli.py` runs network diagnostics, ONVIF
discovery and negotiation, the staged probe, latency, frame delivery and a snapshot, and writes
`INSTALLATION_REPORT.md` with a GO / GO-WITH-FINDINGS / NO-GO verdict.
[FIELD_INSTALLATION_GUIDE](FIELD_INSTALLATION_GUIDE.md) covers mounting, angles, lens, lighting,
topology, the ten commonest mistakes, and both checklists.

⚠️ **Not yet ready for an unsupervised installer**, for reasons that are honest rather than
technical:

- ⛔ **No step has ever been performed against a real camera.** Every instruction is derived from
  synthetic runs and industry convention.
- ⚠️ Mounting heights and angles are convention until B4 measures them.
- ⚠️ The toolkit has never met a device that lies about its capabilities, which is what vendor
  firmware does.

⭐ **The right first deployment is an engineer running the toolkit beside someone who knows the
platform**, with every report kept. That is also how the first certification bundles get produced —
and a bundle nobody observed is a bundle nobody can defend.

---

## Stop

Track B does not begin until physical hardware is available **and** explicitly approved.
