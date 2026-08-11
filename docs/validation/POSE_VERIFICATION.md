# Pose — P3.3b closure report

**Closed 2026-08-12.** RTMPose runs in the deployed runtime, on real frames, and the resulting
17-keypoint skeleton reaches the operator's screen. The primary acceptance criterion — *"I stand in
front of the laptop webcam and VIP shows my REAL 17-keypoint skeleton"* — was met and confirmed by
the Architect in person.

Artifact provenance: `POSE_ARTIFACT.md` (P3.3a). Seam design: `POSE_SEAM.md` (P3.2c).

---

## 0. ⛔ Three evidence states, deliberately never merged

Everything below is filed under exactly one of these. The distinction is not pedantry: each state
answers a question the others cannot, and a milestone that reports the strongest one for work that
only reached the weakest is how a demo starts proving itself.

| State | What it means | What it cannot show |
| --- | --- | --- |
| **IMPLEMENTED** | The code exists and its unit tests pass, on the host, against doubles | That it runs in a container, on a real frame, or at all |
| **VERIFIED ON RECORDED FOOTAGE** | Real `movie101` frames through the **deployed** `/infer`, real ONNX, real artifact | That a camera, a browser and a person can produce the same result live |
| **VERIFIED ON PHYSICAL WEBCAM** | The Architect stood in front of the laptop camera and saw their own skeleton | Nothing further — it is the terminal claim |

⛔ **No accuracy claim exists in any state.** There are zero human keypoint annotations, so PCK is
not computable and is not quoted anywhere. See §10.

---

## 1. Artifact identity

| Field | Value |
| --- | --- |
| Catalogue id | `rtmpose-tiny` |
| Artifact | `rtmpose-tiny-aic-coco-1.0.0.onnx` |
| **sha256** | `38b1d4724f679639fbe3f2ba4679b87d99b737eda01d7bc0e0666700df461a68` |
| Size | 13 374 614 bytes |
| Task / family / engine | `pose-estimation` · `rtmpose` · `onnx` |
| Capability | `perception.pose-estimation` |
| Execution provider | `CPUExecutionProvider`, onnxruntime 1.19.2 |
| Input | `image [1,3,256,192]` NCHW float32 (W=192, H=256) |
| Outputs | `simcc_x [1,17,384]` · `simcc_y [1,17,512]` |
| Verified | at image build **and** again at process start |

## 2. Licence and provenance

| Field | Value |
| --- | --- |
| Licence | **Apache-2.0** (OpenMMLab / MMPose) |
| Trained on | AI Challenger + COCO 2017 |
| `source` in catalogue | **`null`** — produced by VIP, not downloaded |
| `exportedBy` | `ai/mlops/export_rtmpose_onnx.py` |
| `sourceModel` | `open-mmlab/mmpose rtmpose-tiny_simcc-aic-coco_pt-aic-coco_420e-256x192-cfc8f33d_20230126.pth` |

⭐ **Exported in-house because every published RTMPose ONNX is a `body7` model** — trained on a
seven-dataset mixture whose licence terms VIP cannot accept for a commercial product. The AIC+COCO
checkpoint is Apache-2.0; the ONNX export of it did not exist, so it was produced under a pinned
toolchain (numpy 1.26.4 · torch 2.1.0+cpu · mmcv 2.1.0 · mmpose 1.3.2 · linux/amd64).

⚠️ Because `source` is `null`, the artifact is **staged into the image** from
`infra/docker/models-staged/` before `fetch_models.py` runs. This is not a checksum bypass: the
fetcher returns early only when the file is present *and* its sha256 matches the catalogue, so a
staged artifact is verified on exactly the same path as a downloaded one. Build line:
`✓ rtmpose-tiny: already present and verified`.

## 3. Preprocessing and decode

**IMPLEMENTED**, `ai/inference/pose.py` — frozen at commit `2bda38c` by the Architect's order.

- Letterbox crop with 10 % margin around the detector's box; pad value 114; aspect preserved
- Normalisation `MEAN=(123.675, 116.28, 103.53)`, `STD=(58.395, 57.12, 57.375)`, BGR→RGB
- SimCC decode, `SPLIT_RATIO = 2.0`: `px = (ix / 2.0 − pad_x) / scale`, then `fx = (crop.x + px) / frame_w`
- `confidence = min(simcc_x_peak, simcc_y_peak)` — the weaker axis, never the stronger
- `visible = confidence ≥ 0.30 AND not saturated at an edge bin AND inside the frame`

⛔ **Three coordinate spaces, and the output is always frame-normalized.** A keypoint normalized to
the *crop* would look correct in isolation and land on the wrong part of the picture the moment two
people are in frame.

⛔ **An out-of-range keypoint is never clamped to the crop border.** Clamping converts "the model
does not know" into a specific claim about where a joint is.

## 4. Runtime integration

**IMPLEMENTED + VERIFIED ON RECORDED FOOTAGE.**

```
Detection[label="person"] ──▶ crop ──▶ [rtmpose ONNX] ──▶ decode ──▶ attributes["pose"]
```

Placed **after post-processing, before tracking**, in the single `Capability.process` path that
serves `/infer` (`ai/inference/server.py`). The order is the integration: the tracker copies a
detection's attributes onto the track, and the console overlay reads *tracks*.

- One shared estimator across every capability — one 13 MB session, not one per capability
- Injectable at `CapabilityRegistry`, so the seam can be asserted without onnxruntime
- `INFERENCE_POSE_ENABLED` (default `1`) switches the stage off; a runtime without it detects,
  tracks and publishes exactly as before P3.3
- ⛔ **The detector gate is structural, not thresholded.** RTMPose is told a person is in the crop
  and answers regardless — measured on an empty room in P3.3a it returned all 17 joints at 0.21–0.57,
  with a hallucinated left shoulder (0.489) beating a real person's (0.383). Presence is therefore
  never pose's answer: `estimate()` only ever runs on labels the detector called `person`
- A per-frame pose failure is caught, counted and logged; it never deletes a detection

## 5. Detection → Track → API propagation

**VERIFIED ON RECORDED FOOTAGE.** Live query against the deployed runtime:

```
trk_cam_conf_live-t_live-cam_conf_2  state=confirmed  label=person  keypoints=17  visible=9
  nose         x=0.9802 y=0.3282 conf=0.887 visible=True
  left_ankle   x=0.7570 y=0.9984 conf=0.096 visible=False
  right_ankle  x=0.7653 y=0.9984 conf=0.122 visible=False
```

⭐ The ankles are the interesting line: scored 0.096 and 0.122, reported with their coordinates and
`visible=false` — not dropped, not clamped, not silently promoted.

Track attribute semantics (`track_manager.py`): attributes are **replaced** on a match and
**cleared** on a miss. A `lost` track therefore carries no skeleton, which is why every stale-pose
question has a structural answer rather than a timeout.

## 6. Negative controls

**VERIFIED ON RECORDED FOOTAGE**, end to end against the deployed runtime.

| Control | Result |
| --- | --- |
| Empty frame (no detections) | 0 pose inferences, 0 detections — **PASS** |
| Non-person only (`tie`) | 0 posed non-persons, `skippedNotPerson` incremented — **PASS** |
| Frame with no person at all | **never decoded** (see §11) — **PASS** |
| Missed track | attributes cleared, no stale skeleton — **PASS** |
| Multi-person | one inference per person, keypoints land in their own box — **PASS** |
| Runtime with pose disabled | detection and tracking byte-identical to pre-P3.3 — **PASS** |

## 7. Recorded-video verification

**VERIFIED ON RECORDED FOOTAGE.** `movie101` (consented, sha256 `e6f1448f5482…`, 1080×1920,
27.001 fps, 19.037 s), 37 frames extracted at the effective benchmark rate.

| Measure | Result |
| --- | --- |
| Person detections | 36 (across 3 passes) |
| Person detections carrying a pose | **36 — none missed** |
| Keypoints per person | 17 |
| Pose inferences, `/runtime` counter | 0 → 48 over the measured passes |
| Failures / frame failures | 0 / 0 |

## 8. Live webcam verification

**VERIFIED ON PHYSICAL WEBCAM — 2026-08-12.**

The Architect opened Live Capture with the actual laptop webcam and confirmed a real skeleton
rendered on their own body:

```
real webcam ──▶ person detection ──▶ RTMPose ──▶ 17 keypoints
            ──▶ Detection.attributes["pose"] ──▶ Track ──▶ /tracking/tracks
            ──▶ console skeleton ──▶ visually confirmed by the operator
```

⛔ **This claim rests on the operator's own eyes and nothing else.** It was not derived from the
synthetic frame sender, from recorded footage, from an API-only test, or from a mocked browser
response — all four were explicitly excluded, and each was used elsewhere in this report under its
own, weaker heading.

The browser certification specs (`tools/e2e-browser/test/livecam.spec.ts`) assert that the deployed
console bundle *draws* a known skeleton payload correctly. That is a **rendering** claim: Chrome's
fake device shows a rolling test pattern with nobody in it, and no model runs.

## 9. Performance

**VERIFIED ON RECORDED FOOTAGE**, deployed container, 111 frames × 3 passes per arm, one variable
(`INFERENCE_POSE_ENABLED`), first pass discarded as warm-up.

| Measure | pose off | pose on |
| --- | --- | --- |
| Person detections / posed | 36 / 0 | 36 / **36** |
| Frames **with** a person, median | 92.4 ms | 153.8 ms |
| Frames **with** a person, p95 | 110.3 ms | 189.6 ms |
| Frames **without** a person, median | 96.8 ms | 99.2 ms |
| Pose model, per person | — | ~18–21 ms |
| CPU peak | 481 % | 439 % |
| RSS peak | 201 MiB | 230 MiB |

**Cost of pose ≈ 60 ms per person-frame**, of which only ~21 ms is the model. Persons/frame in this
footage is ~1.1; the stage is linear in persons/frame (§10).

⚠️ **A defect the A/B exposed, since fixed.** Before it, frames containing *no person* cost **+25 ms**
with pose enabled — a full 1080×1920 decode performed so that every detection could then be skipped,
because the detector gate ran per-detection *after* the decode. The gate now decides before it, and
non-person frames returned to baseline (121.9 ms → 99.2 ms, against 96.8 ms with pose off). It was
invisible until the cost was measured against a switched-off arm.

## 10. Known limitations

⛔ Preserved deliberately. Each one is a claim the platform must not be read as making.

1. **RTMPose is top-down and requires a person detection.** No detection, no pose. It cannot find
   people; it can only describe a box it was handed.
2. **Model confidence is not physical occlusion visibility.** `visible: true` means "localized above
   0.30", nothing more. The payload carries this sentence and the console prints it beside the
   skeleton.
3. **Keypoints outside the supported crop can saturate** at an edge bin. Saturated joints are marked
   not-visible rather than clamped to the border.
4. **No PCK or accuracy claim exists.** None may be quoted from this milestone.
5. **No human keypoint ground truth exists.** Until annotations exist, accuracy is not measurable —
   and detector output must never be promoted into ground truth.
6. **Multi-person performance scales with persons/frame.** One inference per person, ~21 ms each,
   plus one frame decode. A frame with eight people costs roughly eight times the model time.
7. **Re-ID is not used and identity is not established across time.** Track identity is the tracker's
   short-horizon association only (ADR-0038/0041). A skeleton is attributed to a *track*, never to a
   person across a gap. Re-ID remains gated behind ADR-0055.

## 11. Known performance debt

⚠️ **The frame is decoded twice per person-frame** — once by the detector adapter for its own
preprocessing, and again by `PoseEstimator._decode`. At 1080×1920 that is roughly 25 ms of duplicated
work on every frame containing a person.

**Optimization candidate: shared decoded pixels through `FrameContext`.** A stage that has already
decoded the frame would publish the decoded array on the frame-scoped context, and later stages would
reuse it instead of decoding again.

⛔ **Not implemented, not scheduled, and not claimed.** It changes a frozen contract (`FrameContext`
carries `image: bytes` today) and touches every stage that consumes a frame, so it is an
architectural change rather than a tuning pass — and correctness came first by explicit instruction.

## 12. Tests, gates and certification

| Gate | Result |
| --- | --- |
| `tests/test_pose.py` — decode core, artifact anchors | 27 |
| `tests/test_pose_estimator.py` — detector gate, payload, pre-decode gate | 15 |
| `tests/test_pose_wiring.py` — registry seam, pipeline order, observability | 12 |
| `tests/test_runtime_tracking.py::ObservationAttributeTests` | 6 |
| **Python runtime suite** | **1810 OK** (skipped 50) |
| `apps/console` pose renderer + parser | 13 |
| `apps/console` LiveCamPage (2 pose) | 8 |
| **Repo gate** `pnpm turbo lint typecheck test` | **70/70 tasks** |
| `pnpm verify:contracts` (schemas + perception boundary §A–§L) | OK |
| `node tools/validation/verify-deployment.mjs` | **17/17** |
| **Browser certification** `livecam.spec.ts` (chromium, real HTTPS, deployed bundle) | **11/11** |

⭐ **Six of the twelve wiring tests fail against the implementation that shipped**, verified by
reverting the fix and re-running. A regression test that passes against the broken code is a
regression test for nothing.

## 13. Commits

| SHA | What |
| --- | --- |
| `f9b9a45` | P3.3a — the pose artifact, exported in-house and verified; not catalogued |
| `2bda38c` | P3.3b(1/n) — the pose decode core; three coordinate spaces, and what `visible` means |
| `0d52755` | P3.3b(2/n) — the observation gap: `Detection.attributes` now reaches `Track` |
| `d401849` | P3.3b — pose reaches the console, and the counter that made it look like it never ran |

---

## 14. ⛔ The defect worth remembering

`poseInferences` read **0** after a run in which pose had executed correctly on every person. Two
rebuild-and-redeploy cycles went into "pose never runs". The pipeline had been correct throughout.

Both readings that said otherwise were measurement defects:

- The counter was published in exactly one place — `stats()` logged at model **load**, where it is
  zero by construction. Re-read after a run it is not weak evidence; it is *no* evidence, and it was
  the only number that existed.
- The diagnostic read `payload["detections"]` where the API answers `{success, data:{detections}}`,
  and printed `detections: 0` for 37 frames the runtime had found people in.

**The rule:** before believing a zero, prove the reader can report non-zero against a case known to
be positive. `Capability.health()` now reports pose counters and `/runtime` surfaces them at
`loadedModels[].pose`, so the next person to ask "is pose running?" has a number that can move.
