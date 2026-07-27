# Reference — Model Reference (Datasets, Accuracy Targets, Placement)

> Per-capability model guidance: suggested training datasets, accuracy targets, and edge/cloud placement. This is **reference detail** for the capabilities in [AI-CAPABILITY-CATALOG](AI-CAPABILITY-CATALOG.md). Model families are **swappable** behind the capability contract ([ADR-0002](../adr/ADR-0002-model-agnostic-inference.md)); nothing here is hardcoded — these are starting points for the Model/Dataset Registries ([08](../architecture/08-AI-ML-PLATFORM.md)).

**Accuracy goals** are precision/recall targets at customer sites **after per-site tuning**. Safety-critical capabilities bias toward high precision (fewer false alarms) with tunable sensitivity and **two-stage confirmation**. All person-attribute/recognition models require fairness/bias review; face/LPR are jurisdiction-gated.

## Perception

| Capability                                                 | Model family                             | Suggested datasets                                                    | Accuracy target                                | Edge        |
| ---------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- | ----------- |
| `perception.person-detection`                              | YOLO (v8/v11) + ByteTrack                | COCO(person), CrowdHuman, MOT17/20, site footage (IR/low-light)       | mAP ≥ .90; prec ≥ .92 normal / ≥ .85 low-light | ✅          |
| `perception.vehicle-detection`                             | YOLO                                     | COCO, UA-DETRAC                                                       | mAP ≥ .90                                      | ✅          |
| `perception.object-detection`                              | YOLO / DETR (open-vocab future)          | COCO, LVIS, custom                                                    | mAP ≥ .80                                      | ✅          |
| `perception.animal-detection`                              | YOLO                                     | COCO, iWildCam                                                        | mAP ≥ .85                                      | ✅          |
| `perception.tracking`                                      | ByteTrack / DeepSORT                     | MOT                                                                   | stable IDs; assoc quality                      | ✅          |
| `perception.pose`                                          | MediaPipe / HRNet                        | COCO-Pose                                                             | PCK ≥ .90                                      | ✅          |
| `perception.face-detection`                                | RetinaFace / SCRFD                       | WIDER FACE                                                            | ≥ .95                                          | ✅          |
| `perception.face-recognition`                              | ArcFace / AdaFace + vector match         | MS1M / Glint360K / VGGFace2 (license-checked); anti-spoof: CASIA-SURF | TAR ≥ .99 @ FAR 1e-4 (enrolled)                | ✅          |
| `perception.lpr`                                           | vehicle→plate detect → OCR (CRNN/PARSeq) | CCPD, UFPR-ALPR, OpenALPR, synthetic per-locale                       | ≥ 95% char frontal / ≥ 85% oblique-night       | ✅          |
| `perception.ocr`                                           | CRNN / PARSeq                            | text-recognition sets + synthetic                                     | ≥ 95% char                                     | ✅          |
| `perception.fire-smoke`                                    | YOLO + temporal verifier / CNN-LSTM      | D-Fire, FireNet, FIRESENSE + hard negatives (steam, sunlight)         | recall ≥ .95, prec ≥ .90; alert < 5 s          | ✅          |
| `perception.weapon-detection`                              | YOLO + 2-stage verify                    | Sohas + synthetic + hard negatives (phones, tools)                    | prec ≥ .95; sub-second                         | ✅          |
| `perception.attribute` (PPE/helmet/mask/uniform/age/color) | multi-attr classifier / detector         | SH17/PPE, hardhat sets, FMD (mask), custom uniform                    | ≥ .90–.92 per attribute                        | ✅          |
| `perception.audio-analytics`                               | audio CNN                                | gunshot/glass-break/aggression sets                                   | (per class)                                    | ✅ (future) |
| `perception.scene-classification`                          | CNN / VLM                                | Places + custom                                                       | (per class)                                    | both        |

## Reasoning (temporal — heavier)

| Capability                                                                      | Model family                                     | Suggested datasets                                                                 | Accuracy target                        | Edge                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------- |
| `reasoning.action-recognition`                                                  | SlowFast / VideoMAE / ST-GCN (skeleton)          | Kinetics, NTU-RGBD                                                                 | ≥ .85                                  | ⚠️ skeleton yes; RGB-temporal cloud |
| `reasoning.behavior` (fall/slip, violence/fight, loiter, tailgate, concealment) | pose-temporal + ST-GCN + fusion                  | UR Fall / Le2i / Multicam (fall); RWF-2000 / Hockey / Movies (violence); UCF-Crime | fall recall ≥ .90; violence prec ≥ .85 | ⚠️                                  |
| `reasoning.anomaly`                                                             | autoencoder / optical-flow vs per-scene baseline | UCF-Crime + site baseline                                                          | tuned to alertable rate                | ⚠️/cloud                            |
| `reasoning.correlation` (cross-camera/time re-ID)                               | ReID embeddings + spatiotemporal                 | Market-1501, MSMT17 + site                                                         | —                                      | cloud                               |

## Spatial (rule/geometry-driven — light)

`spatial.zone-detection`, `spatial.line-crossing`, `spatial.speed-estimation`, `spatial.queue-analytics`, `spatial.occupancy`, `spatial.heatmap`, `spatial.parking`, `object.left-behind`, `object.removed` are primarily **geometric/temporal logic over tracks** (homography calibration for speed; per-slot classifiers for parking, e.g. PKLot/CNRPark). Counting/occupancy targets: ≥ 95% vs manual; occupancy ±5%. All edge-friendly. → [10-RULE-ENGINE](../architecture/10-RULE-ENGINE.md)

## Governance (applies to all — see [08 §8](../architecture/08-AI-ML-PLATFORM.md))

- Two-stage confirmation for high-severity (weapon/violence).
- Per-site calibration/thresholds stored per camera; sensitivity sliders for admins.
- **Human-in-the-loop for accusatory detections** (theft/violence/face) — advisory events for review, never automated judgments.
- Continuous learning from field FP/FN; benchmark sets per capability gate promotion in model CI.
- Model cards (metrics, dataset lineage, license, fairness notes) recorded in the registry for every version.

## Cross-references

[AI-CAPABILITY-CATALOG](AI-CAPABILITY-CATALOG.md) · [08-AI-ML-PLATFORM](../architecture/08-AI-ML-PLATFORM.md) · [HARDWARE-SIZING](HARDWARE-SIZING.md)
