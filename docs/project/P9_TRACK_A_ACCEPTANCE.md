# P-9 Track A — acceptance checklist

**2026-08-07.** Track A closes only when every line below is **verified**, not asserted. Each row
names the evidence and how to re-run it.

> ⚠️ **"Verified" here means a run against the deployed stack, on a clean tree.** A tick with no
> command behind it is the thing this checklist exists to prevent — and the harness marks its own
> output `NOT AUTHORITATIVE` when the working tree is dirty, so a development run can never be filed
> as evidence.

---

## 1 · The checklist

| #   | Item                                      | Verdict                  | Evidence                                                                                                         |
| --- | ----------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 1   | **Discovery working**                     | ✅                       | `docs/review/p9/discovery.mjs` — 16/16. `unavailable` absent, probe window spent, targeted negotiation answers   |
| 2   | **RTSP probing working**                  | ✅                       | `docs/review/p9/stream-probe.mjs` — 40/40. All 13 contract stages named; success reaches `first-frame`           |
| 3   | **ONVIF discovery working**               | ⚠️ **wired, unanswered** | Discovery runs and returns `probedSeconds > 0` with zero devices. ⛔ **No ONVIF device has ever answered** — L-1 |
| 4   | **Certification CLI verified**            | ✅                       | `docs/review/p9/certification.mjs` — 27/27, in the deployed image, simulated **and** live                        |
| 5   | **Certification bundle generated**        | ✅                       | Four artifacts, valid JSON, on both source types; exit code and file count both checked                          |
| 6   | **Bundle promotion verified**             | ✅                       | `promote_from_bundle()`; `test_camera_registry.py::PromotionRefusalTest`                                         |
| 7   | **Promotion refusal test passing**        | ✅                       | 8 refusal tests, incl. ⭐ a refusal leaving entry **and file** untouched                                         |
| 8   | **Multi-camera synthetic validation**     | ✅                       | `docs/review/p9/multi-camera.mjs` — 35/35 at 1 / 2 / 4, probed concurrently                                      |
| 9   | **H.265 validation complete**             | ✅                       | `docs/review/p9/h265.mjs` — 9/9 across 5 engines. **TD-29 closed**                                               |
| 10  | **USB webcam validation**                 | ✅                       | `demo_cli.py --measure` — 308 frames, 143 detections, 1 identity, real lens                                      |
| 11  | **Customer Demonstration Mode**           | ✅                       | `demo_cli.py`; screenshot `docs/review/p9/screens/demo-mode.png`                                                 |
| 12  | **Installer Toolkit working**             | ✅                       | `installer_cli.py` — 7 stages, report + snapshot, verdict GO-WITH-FINDINGS on the fixture                        |
| 13  | **Camera Compatibility Matrix generated** | ✅                       | `CAMERA_COMPATIBILITY_MATRIX.md`, generated; drift-guarded by a unit test                                        |
| 14  | **Golden Camera Dataset specification**   | ✅                       | [GOLDEN_CAMERA_DATASET](GOLDEN_CAMERA_DATASET.md) — 11 scenarios × 4 condition axes                              |
| 15  | **Deployment integrity green**            | ✅                       | Checked at the head of every verification; 17 containers healthy, tree clean                                     |
| 16  | **Hardware nightly stage registered**     | ✅                       | `hardware/certification.sh`; `launch.sh hardware --dry-run` lists it. ⚠️ Registered, not run                     |
| 17  | **Documentation updated**                 | ✅                       | §3 below                                                                                                         |
| +   | **Camera stress validation** _(A11)_      | ✅                       | `docs/review/p9/stress.mjs` — 10/10; 8 of 11 scenarios executable                                                |

**Verdict: Track A is complete.** Row 3 is the one qualified tick, and the qualification is the
milestone's whole point — ⛔ **the wiring is verified, the protocol is not.**

---

## 2 · Re-running the evidence

```bash
# every P-9 verification, against the deployed stack, on a clean tree
for s in discovery stream-probe certification multi-camera stress; do
  node docs/review/p9/$s.mjs || echo "FAILED: $s"
done

# the browser one lives where playwright is installed on this machine
cp docs/review/p9/{_p9.mjs,h265.mjs} /private/tmp/pwrun/
( cd /private/tmp/pwrun && REPO=$PWD node h265.mjs )

# the runtime suite
( cd ai/inference && python3 -m unittest discover -s tests -q )   # 1057 tests
```

⚠️ `P9_ALLOW_DIRTY=1` runs against an uncommitted tree and stamps the summary
**`NOT AUTHORITATIVE`**. Use it while developing; never quote its output.

---

## 3 · Documentation delivered

| Document                                                      | What it is                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [P9_HARDWARE_PROCUREMENT](P9_HARDWARE_PROCUREMENT.md)         | Customer-grade specification — vendors, ONVIF, RTSP, codecs, resolutions, FPS, auth, firmware, network, PoE/WiFi, NVR/DVR, minimums, unsupported configurations |
| [FIELD_INSTALLATION_GUIDE](FIELD_INSTALLATION_GUIDE.md)       | Mounting, angles, distance, lens, lighting, topology, mistakes, deployment + customer acceptance checklists                                                     |
| [GOLDEN_CAMERA_DATASET](GOLDEN_CAMERA_DATASET.md)             | 11 scenarios × 4 condition axes, `capture` metadata, storage and consent                                                                                        |
| [CAMERA_COMPATIBILITY_MATRIX](CAMERA_COMPATIBILITY_MATRIX.md) | ⭐ **Generated** from the registry; a unit test refuses drift                                                                                                   |
| [P9_IMPLEMENTATION_PLAN](P9_IMPLEMENTATION_PLAN.md)           | The plan, with the finding that reshaped it                                                                                                                     |
| [MASTER_PROGRESS](../tracker/MASTER_PROGRESS.md)              | Track A entry                                                                                                                                                   |
| `docs/review/p9/*.mjs`                                        | Five verifications, each carrying the defect it was written to catch                                                                                            |

---

## 4 · What Track A did **not** do, stated plainly

- ⛔ **No device was certified**, and none could be. Every row of the matrix reads `Pending Validation`.
- ⛔ **No ONVIF device has ever answered this platform.** L-1 stands.
- ⛔ **Live video is not a product feature.** TD-28 is open; Customer Demonstration Mode is MJPEG and
  says so on the page.
- ⛔ **Packet loss is not measured anywhere.** The Installer Toolkit reports frame delivery and states
  that it is not packet loss.
- ⚠️ **Zone geometry has never met a real lens.** [B4](P9_IMPLEMENTATION_PLAN.md) is unstarted and it
  sits underneath every configuration-only capability on the roadmap.
- ⚠️ Three stress scenarios — camera reboot, slow network, packet loss — need hardware or link
  shaping and are recorded `not-executed` with the equipment named.
