# Reference — AI Capability Catalog

> The inventory of **reusable, model-agnostic vision capabilities**. These are building blocks ([05-CAPABILITY-ARCHITECTURE](../architecture/05-CAPABILITY-ARCHITECTURE.md)), **not features and not products**. "Shoplifting detection," "fall response," "PPE compliance" are _compositions_ of these via events + rules + workflows + Industry Packs — they are **not** entries here.

Each capability satisfies the uniform capability contract: it references models by **registry selector** (never a hardcoded model), declares inputs/outputs/parameters/placement/resource-profile, and emits normalized events. Model families are **suggestions**, swappable behind the contract ([08-AI-ML-PLATFORM](../architecture/08-AI-ML-PLATFORM.md)).

> For per-capability **datasets, accuracy targets, and hardware placement**, see [MODEL-REFERENCE](MODEL-REFERENCE.md). For **sizing** per deployment scale, see [HARDWARE-SIZING](HARDWARE-SIZING.md).

## Conventions

- **In**: decoded frames (RGB tensors, typically 640×640) + context (tracks/zones). **Out**: normalized detections/events `{type, bbox(es), trackId, confidence, zone, ts, attributes, evidenceRef}`.
- **Edge** = Jetson/OpenVINO via TensorRT/ONNX INT8. **Cloud** = GPU workers for heavier/batch.
- Accuracy goals are precision/recall targets after per-site tuning; safety-critical bias to high precision with tunable sensitivity + two-stage confirm.

---

## A. Media capabilities

| Capability            | Purpose                                        | Out            | Edge/Cloud |
| --------------------- | ---------------------------------------------- | -------------- | ---------- |
| `media.ingestion`     | Pull/accept RTSP/RTMP; session mgmt, reconnect | frames/stream  | both       |
| `media.streaming`     | WebRTC (live) + HLS (playback) renditions      | signed streams | both       |
| `media.recording`     | Segment recording (optional/on-prem)           | segments       | both       |
| `media.frame-extract` | Adaptive sampling + motion gating + batching   | frames         | both       |

## B. Perception capabilities

| Capability                        | Model family (swappable)        | Out                                           | Accuracy goal   | Edge        |
| --------------------------------- | ------------------------------- | --------------------------------------------- | --------------- | ----------- |
| `perception.object-detection`     | YOLO / DETR (open-vocab future) | bboxes+class                                  | mAP≥.80         | ✅          |
| `perception.person-detection`     | YOLO+ByteTrack                  | person bboxes                                 | mAP≥.90         | ✅          |
| `perception.vehicle-detection`    | YOLO                            | vehicle bbox/type                             | mAP≥.90         | ✅          |
| `perception.animal-detection`     | YOLO                            | animal bbox                                   | mAP≥.85         | ✅          |
| `perception.tracking`             | ByteTrack/DeepSORT              | stable track IDs, trajectory, velocity, dwell | —               | ✅          |
| `perception.reid`                 | ReID embeddings                 | cross-frame/camera identity link              | —               | ⚠️/cloud    |
| `perception.pose`                 | MediaPipe/HRNet                 | keypoints (17–33)                             | PCK≥.90         | ✅          |
| `perception.face-detection`       | RetinaFace/SCRFD                | face bbox                                     | ≥.95            | ✅          |
| `perception.face-recognition`     | ArcFace/AdaFace + vector match  | identity/embedding, known/unknown             | TAR≥.99@FAR1e-4 | ✅          |
| `perception.ocr`                  | CRNN/PARSeq                     | text                                          | ≥95% char       | ✅          |
| `perception.lpr`                  | vehicle→plate→OCR               | plate text/region                             | ≥95% frontal    | ✅          |
| `perception.fire-smoke`           | YOLO+temporal / CNN-LSTM        | fire/smoke region+growth                      | recall≥.95      | ✅          |
| `perception.weapon-detection`     | YOLO + 2-stage verify           | weapon bbox/type/holder                       | prec≥.95        | ✅          |
| `perception.audio-analytics`      | audio CNN                       | gunshot/glass-break/aggression event          | —               | ✅ (future) |
| `perception.scene-classification` | CNN/VLM                         | scene label                                   | —               | both        |
| `perception.attribute`            | multi-attr classifier           | PPE/helmet/mask/uniform/age/color per subject | ≥.90            | ✅          |

## C. Spatial / temporal capabilities

| Capability                 | Purpose                          | Out                    | Edge |
| -------------------------- | -------------------------------- | ---------------------- | ---- |
| `spatial.zone-detection`   | Enter/exit/inside polygon ROI    | zone events            | ✅   |
| `spatial.line-crossing`    | Cross line + direction; counting | count/cross events     | ✅   |
| `spatial.speed-estimation` | Track speed via homography       | speed value            | ✅   |
| `spatial.queue-analytics`  | Queue length + wait time         | queue metrics          | ✅   |
| `spatial.occupancy`        | Live headcount per zone          | occupancy count        | ✅   |
| `spatial.heatmap`          | Spatial density accumulation     | heatmap grid           | ✅   |
| `spatial.trajectory`       | Path analysis over tracks        | trajectory/path events | ✅   |
| `object.left-behind`       | Static object + owner gone       | abandoned event        | ✅   |
| `object.removed`           | Background diff removal          | removal event          | ✅   |
| `spatial.parking`          | Slot occupancy                   | slot state             | ✅   |

## D. Reasoning capabilities

| Capability                     | Purpose                                                                                         | Out               | Edge                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------- |
| `reasoning.behavior`           | Fuse detections/tracks/poses into behaviors (dwell/loiter/tailgate/proximity/gesture) over time | behavior events   | ⚠️ (skeleton yes; RGB-temporal cloud) |
| `reasoning.action-recognition` | Temporal action classification (SlowFast/ST-GCN/VideoMAE)                                       | action label      | ⚠️/cloud                              |
| `reasoning.anomaly`            | Statistical anomaly vs per-scene baseline                                                       | anomaly score     | ⚠️/cloud                              |
| `reasoning.correlation`        | Cross-camera/time actor + situation linking                                                     | correlated events | cloud                                 |

## E. Platform capabilities (non-vision building blocks)

`platform.event` · `platform.rule-engine` · `platform.workflow` · `platform.evidence` · `platform.notification` · `platform.analytics` · `platform.report` · `platform.search` (structured+semantic/NL) · `platform.model-registry` · `platform.dataset-registry` · `platform.deployment` · `platform.monitoring`. See sections [09](../architecture/09-EVENT-PLATFORM.md)–[12](../architecture/12-EVIDENCE-MANAGEMENT.md), [08](../architecture/08-AI-ML-PLATFORM.md), [16](../architecture/16-OBSERVABILITY.md).

---

## How verticals map to capabilities (illustrative — these are compositions, NOT capabilities)

| Vertical need                   | Capabilities used                                                     | Composed by                              |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| Retail loss prevention          | person-detection, tracking, pose, zone, object.left/removed, ocr(POS) | rule + workflow in Retail Pack           |
| Hospital fall response          | person-detection, pose, reasoning.behavior, zone                      | rule + workflow in Hospital Pack         |
| Warehouse PPE + forklift safety | person/vehicle-detection, attribute(PPE), tracking, spatial.proximity | rules in Warehouse Pack                  |
| Smart-city traffic              | vehicle-detection, tracking, lpr, line-crossing, speed                | rules in Smart-City Pack                 |
| Bank threat response            | weapon-detection, face-recognition, tailgating(behavior+zone)         | rules + escalation workflow in Bank Pack |

> **Governance** ([08](../architecture/08-AI-ML-PLATFORM.md)): two-stage confirm for high-severity; per-site calibration; human-in-the-loop for accusatory detections (theft/violence/face) — advisory only; fairness/bias review; jurisdictional gating for face/LPR; continuous learning from field FP/FN.

## Cross-references

[05-CAPABILITY-ARCHITECTURE](../architecture/05-CAPABILITY-ARCHITECTURE.md) · [08-AI-ML-PLATFORM](../architecture/08-AI-ML-PLATFORM.md) · [09-EVENT-PLATFORM](../architecture/09-EVENT-PLATFORM.md) · [13-INDUSTRY-PACKS](../architecture/13-INDUSTRY-PACKS.md)
