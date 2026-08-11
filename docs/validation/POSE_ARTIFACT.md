# Pose artifact — provenance and verification (P3.3a)

⛔ **This artifact is NOT catalogued and NOT enabled.** `models/registry.json` is unchanged, the
runtime is unchanged, and no pose inference runs anywhere in the platform. This records what was
produced and what was checked, for review before integration.

---

## 1. Provenance

| Field | Value |
| --- | --- |
| Artifact | `rtmpose-tiny-aic-coco-1.0.0.onnx` |
| **sha256** | `38b1d4724f679639fbe3f2ba4679b87d99b737eda01d7bc0e0666700df461a68` |
| Size | 13 374 614 bytes |
| Upstream model | RTMPose-t (body, 17 keypoints, 256×192), OpenMMLab |
| Upstream checkpoint | `https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/rtmpose-tiny_simcc-aic-coco_pt-aic-coco_420e-256x192-cfc8f33d_20230126.pth` (13 439 631 bytes, asserted) |
| Trained on | **AI Challenger + COCO 2017** |
| Licence | Apache-2.0 · OpenMMLab (MMPose / RTMPose) |
| Export tool | `ai/mlops/export_rtmpose_onnx.py` + `ai/mlops/Dockerfile.rtmpose-export` |
| Opset / IR | 17 / 8 · producer `pytorch 2.1.0` · 190 nodes |
| Input | `image` `[1,3,256,192]` NCHW float32 (W=192, H=256) |
| Outputs | `simcc_x [1,17,384]` · `simcc_y [1,17,512]` |
| Execution provider | `CPUExecutionProvider`, onnxruntime 1.19.2 |
| `source` in catalogue | **`null`** — produced, not downloaded |

**Export toolchain, pinned:** numpy 1.26.4 · torch 2.1.0+cpu · torchvision 0.16.0+cpu · cv2 4.10.0 ·
mmcv 2.1.0 · mmengine 0.10.7 · mmpose 1.3.2 · mmdet 3.3.0 · onnx 1.22.0 · linux/amd64.

### ⭐ Why exported rather than downloaded

Every RTMPose ONNX OpenMMLab publishes is a **`body7`** model — AI Challenger, COCO, CrowdPose, MPII,
sub-JHMDB, Halpe and PoseTrack18. Apache-2.0 covers MMPose's *code*; it does not by itself clear
weights derived from datasets whose own terms are research-oriented. The narrowest published
provenance for a 17-keypoint RTMPose is **AIC+COCO**, and it exists only as a PyTorch checkpoint —
so VIP converts it, exactly as it already does for `rtdetr-r18vd`. `source` is `null` and the
provenance is this document, the export tool, and a checksum the platform verifies twice.

---

## 2. Verification

| Gate | Result |
| --- | --- |
| 1 · export completes, exit verified explicitly | ✓ `EXPORT_EXIT=0` |
| 2 · mmcv/mmpose usable in the final image | ✓ `--selftest` builds the network from config at build time |
| 3 · OpenCV without GUI/X11 | ✓ `opencv-python-headless` 4.10.0 |
| 4 · artifact exists and is readable | ✓ 13 374 614 bytes |
| 5 · ONNX graph validation | ✓ `onnx.checker.check_model` passed |
| 6 · runs on a known input | ✓ see §3 |
| 7 · checksum from the actual file | ✓ `shasum -a 256` on disk == the tool's declared digest |
| 8 · provenance recorded | ✓ §1 |
| 9 · catalogued | ⛔ **not done, deliberately** |
| 10 · runtime modified | ⛔ **not done, deliberately** |

**Latency**, 200 runs, CPU, one person crop: **mean 22.72 ms · p50 19.34 · p95 37.55 · max 132.03**.
⚠️ Per *person*, not per frame — top-down cost scales with the number of people in shot.

---

## 3. ⛔ What gate 6 established, and it changes the integration design

### 3.1 Decode convention, read off the graph

`simcc_x` is 384 = 192 × 2 and `simcc_y` is 512 = 256 × 2, so the SimCC split ratio is **2.0** on both
axes. Decode is `argmax / 2.0` → pixel in the letterboxed 192×256 input → undo letterbox → crop
pixels → normalized frame coordinates. ⚠️ These widths were read from the traced graph, never assumed
from the paper.

On a real person (movie101 frame 32) the head is confidently and correctly placed — nose 0.939, eyes
0.949 / 0.930 — and `nose above shoulders` and `shoulders above hips` both hold.

### 3.2 ⛔ The model emits CONFIDENCE ONLY. There is no visibility output.

The graph has two outputs and neither is a visibility flag. COCO *ground truth* carries `v ∈ {0,1,2}`;
the SimCC head does not reproduce it. Therefore `perception.Keypoint.visible` **cannot be populated
from the model** and must be a derived, documented rule.

⚠️ `Keypoint.visible` currently defaults to `True`. For pose that default is unsafe: a joint the model
failed to find would arrive marked visible.

### 3.3 ⛔ A top-down model always returns a full skeleton — including from an empty room

The negative control is the important result. Run on movie101's empty-room frames, with **no person
present at all**, the model still emits all 17 joints:

| | real person, frame 32 | **empty room, frame 0** |
| --- | --- | --- |
| left_shoulder confidence | 0.383 | **0.489** |
| confidence range | 0.054 – 0.949 | **0.211 – 0.565** |

**The hallucinated shoulder is more confident than the real one.** This is inherent to top-down pose:
the model is *told* there is a person and answers accordingly. ⛔ **Per-joint confidence therefore
cannot be used to decide whether a person is present**, and any threshold that tried would either
suppress real joints or admit invented ones.

⭐ **The mitigation is architectural, and the existing design already provides it**: pose runs only on
crops the *detector* asserts are people. Negative controls "empty frame → no skeleton" and "no person
detection → no pose instance" are satisfied by the detector gate, not by the pose model — and that
holds only if pose is never run on anything but a person box.

### 3.4 Joints the model could not find saturate at the crop boundary

On frame 32 the subject is framed from the chest up. All eight lower-body joints decoded to
**y = 0.958** — the bottom edge of the crop — with confidence 0.054 – 0.337. The argmax saturates at
the last bin rather than reporting failure, producing a **plausible coordinate for a joint that is not
in the image**. Any consumer that reads position without reading confidence gets a real-looking lie.

---

## 4. What this means for P3.3b

1. Pose runs **only** on detector person boxes. Never on a frame, never speculatively.
2. `visible` is **derived and documented**, never defaulted for pose, and never equal to confidence.
   ⚠️ The honest reading of a derived flag is *"the model localised this joint above threshold t"* —
   which is **not** the same claim as *"this joint is not occluded"*, and the two must not be conflated
   in any consumer.
3. Boundary saturation is a detectable signal and should be treated as *not found*, not as a position.
4. ⛔ No accuracy claim of any kind. There is no human keypoint ground truth, so PCK is not computable
   and none of the numbers above is an accuracy result — they are observations of behaviour.
