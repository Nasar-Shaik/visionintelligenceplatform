# 03 — AI Detection Catalog

60+ detection models. Each has **Purpose · Input · Output · Training Dataset Suggestions · Inference Pipeline · Accuracy Goals · Hardware · Edge/Cloud · Future**.

The catalog is delivered in two forms:
1. **Detailed model cards** for the marquee/complex detections (Section A).
2. A **complete specification matrix** covering every requested detection with all required fields as columns (Section B).

**Common conventions**
- **Input** is normally decoded frames (RGB tensors, often 640×640) plus tracking context; models consume single frames, short clips (temporal), or track sequences.
- **Output** is a normalized event: `{ type, bbox(es), trackId, confidence, zone, timestamp, attributes, thumbnail }` fed to the Behaviour/Event/Rule engines.
- **Edge** = runs on Jetson/OpenVINO mini-PC via TensorRT/ONNX INT8; **Cloud** = runs on GPU workers for heavier/batch models.
- Accuracy goals are **precision/recall targets at customer sites** after per-site tuning; safety-critical models bias toward high precision (fewer false alarms) with tunable sensitivity.

---

# Section A — Detailed Model Cards

## A1. Person / Human Detection (foundation)
- **Purpose:** Detect and localize people in every frame; foundation for counting, tracking, behaviour, safety.
- **Input:** RGB frame 640×640 (letterboxed), FP16/INT8 tensor.
- **Output:** person bounding boxes + confidence + feature crop for downstream (pose, face, ReID).
- **Datasets:** COCO (person), CrowdHuman, MOT17/20, custom site footage (CCTV angles, low light, IR).
- **Inference pipeline:** frame sampler → YOLO (v8/v11) detector (TensorRT) → NMS → ByteTrack IDs → publish detections.
- **Accuracy goals:** mAP ≥ 0.90 person; ≥ 0.92 precision in normal light, ≥ 0.85 in low light/IR.
- **Hardware:** Jetson Orin Nano handles 4–8 cams @ 10 fps; Orin NX 16–24; A2/T4 for cloud fan-out.
- **Edge:** ✅ core edge model. **Cloud:** ✅ for overflow/batch.
- **Future:** domain-adaptive fine-tuning per site, crowd-dense refinement, thermal-camera support.

## A2. Face Detection & Face Recognition (Employee vs Unknown)
- **Purpose:** Detect faces, generate embeddings, match against enrolled galleries (employees/VIP/watchlist) → identify Known vs Unknown; power tailgating, access, attendance.
- **Input:** person crops → aligned face chips (112×112).
- **Output:** face bbox, 512-d embedding, identity match `{personId, name, score}` or `unknown`, liveness flag.
- **Datasets:** WIDER FACE (detection), MS1M/Glint360K/VGGFace2 (recognition, licensing-checked), site enrollment sets; anti-spoof: CASIA-SURF.
- **Inference pipeline:** face detector (RetinaFace/SCRFD) → alignment → ArcFace/AdaFace embedding → vector match (cosine) against per-tenant gallery → threshold → identity event. Optional liveness/anti-spoof.
- **Accuracy goals:** detection ≥ 0.95; recognition TAR ≥ 0.99 @ FAR 1e-4 on enrolled; unknown-rejection tuned to minimize false accept.
- **Hardware:** Orin NX / RTX for gallery search; embeddings in tenant vector namespace.
- **Edge:** ✅ (detection+embedding on edge, match local or cloud). **Cloud:** ✅ large galleries.
- **Future:** masked-face recognition, aging robustness, on-device privacy blurring, consent-gated enrollment, federated gallery.
- **Privacy note:** FR is an opt-in add-on, region-gated (some jurisdictions restrict); default face-blur for non-consented.

## A3. License Plate Recognition (LPR/ANPR)
- **Purpose:** Detect vehicles, localize plates, OCR plate text; power parking, access, watchlists, speed pairing.
- **Input:** vehicle crops from detector.
- **Output:** `{plateText, region, confidence, vehicleType, color, trackId, timestamp}`.
- **Datasets:** CCPD, OpenALPR benchmark, UFPR-ALPR, regional plate datasets, synthetic plate generation for locale coverage.
- **Inference pipeline:** vehicle detect → plate detect → rectify/deskew → OCR (CRNN/CTC or PARSeq) → post-correct against region format → dedupe per track.
- **Accuracy goals:** ≥ 95% character accuracy on frontal plates in good conditions; ≥ 85% oblique/night.
- **Hardware:** Orin NX / T4; benefits from dedicated plate-zone camera.
- **Edge:** ✅. **Cloud:** ✅.
- **Future:** multi-country auto-detect, toll/speed integration, make/model recognition, dirty/damaged-plate robustness.

## A4. Fire & Smoke Detection
- **Purpose:** Early visual detection of flame and smoke for safety alerting.
- **Input:** frames (temporal window improves smoke detection).
- **Output:** fire/smoke region, confidence, growth trend, zone.
- **Datasets:** FireNet, D-Fire, FIRESENSE, custom industrial/kitchen footage; negatives (steam, sunlight, red objects) to cut false positives.
- **Inference pipeline:** detector (YOLO fire/smoke) + temporal verifier (flicker/growth over N frames) → severity → event. Optional multi-frame CNN-LSTM.
- **Accuracy goals:** recall ≥ 0.95 (miss = catastrophic), precision ≥ 0.90 after temporal filtering; alert < 5s.
- **Hardware:** edge-first (latency-critical); Orin.
- **Edge:** ✅ (must run offline). **Cloud:** ✅ verification.
- **Future:** thermal-camera fusion, sensor fusion (smoke detectors), early-smoulder detection.

## A5. Weapon Detection (gun/knife)
- **Purpose:** Detect visible firearms/knives for active-threat alerting.
- **Input:** frames + person context.
- **Output:** weapon bbox, type, holder trackId, confidence.
- **Datasets:** weapon datasets (Sohas, guns/knives), synthetic augmentation, hard negatives (phones, tools, umbrellas).
- **Inference pipeline:** detector → temporal + pose context (hand region) verification → high-severity event with escalation.
- **Accuracy goals:** precision ≥ 0.95 (false alarms erode trust), recall tuned per risk; sub-second alert.
- **Hardware:** edge GPU; cloud second-stage verification for confirmation.
- **Edge:** ✅. **Cloud:** ✅ (2-stage confirm to cut FPs).
- **Future:** concealed-weapon cues, human-in-the-loop confirm workflow, multi-camera corroboration.

## A6. Violence / Fight / Abnormal Behaviour
- **Purpose:** Detect physical aggression, fights, and statistically abnormal motion patterns.
- **Input:** short clips (16–32 frames) + tracks/poses.
- **Output:** behaviour event `{type, participants, severity, clip window}`.
- **Datasets:** RWF-2000, Hockey Fight, Movies Fight, UCF-Crime, custom CCTV; abnormal via unsupervised motion baselines.
- **Inference pipeline:** track+pose → temporal action model (SlowFast/VideoMAE/ST-GCN on skeletons) → aggression classifier; abnormal via autoencoder/optical-flow anomaly scoring per scene baseline.
- **Accuracy goals:** precision ≥ 0.85, recall ≥ 0.80; abnormal tuned to alertable rate.
- **Hardware:** cloud/edge GPU (temporal models heavier); ST-GCN on skeletons is edge-friendly.
- **Edge:** ⚠️ skeleton-based yes; RGB-temporal cloud-preferred. **Cloud:** ✅.
- **Future:** self-supervised per-site normal modeling, multi-cam scene reasoning, reduced-FP with pose priors.

## A7. Fall / Slip Detection
- **Purpose:** Detect people falling/slipping (elderly care, hospitals, workplace safety).
- **Input:** pose keypoints + track over time.
- **Output:** fall event, person trackId, location, confidence.
- **Datasets:** UR Fall, Le2i Fall, Multicam Fall, custom; synthetic pose sequences.
- **Inference pipeline:** person → pose (MediaPipe/HRNet) → temporal fall classifier (velocity of keypoints, aspect-ratio change, on-ground dwell) → confirm → event.
- **Accuracy goals:** recall ≥ 0.90 (care-critical), precision ≥ 0.88.
- **Hardware:** edge-friendly (pose + light temporal).
- **Edge:** ✅. **Cloud:** ✅.
- **Future:** privacy-preserving pose-only mode (no RGB stored), bed-exit prediction, gait-instability early warning.

## A8. Shoplifting / Employee Theft / Suspicious Behaviour
- **Purpose:** Flag concealment, high-risk gestures, cash-counter anomalies, sweethearting, unusual dwell near merchandise.
- **Input:** tracks + pose + zone/shelf context + (optional) POS correlation.
- **Output:** suspicion event with score, actor track, zone, clip, POS-mismatch flag.
- **Datasets:** UCF-Crime (shoplifting), custom retail footage, POS-paired data; heavy per-site tuning.
- **Inference pipeline:** person track + pose (hand-to-body/bag concealment gestures) + shelf interaction (item pick without scan) + dwell/loiter + POS event correlation → risk scoring (ensemble) → analyst-review event (not auto-accusation).
- **Accuracy goals:** optimized for **high precision / low false accusation**; treated as *lead generation* for human review, not verdict.
- **Hardware:** edge for gestures, cloud for correlation/scoring.
- **Edge:** ⚠️ partial. **Cloud:** ✅ (fusion + POS).
- **Future:** multi-cam re-ID trajectory, self-checkout scan-avoidance, weekly loss-prevention reports.
- **Ethics note:** advisory only; audited; configurable to avoid biased/unfair targeting.

## A9. PPE / Helmet / Mask / Uniform Detection
- **Purpose:** Verify safety compliance (hardhat, vest, gloves, goggles, mask) and uniform/dress-code adherence.
- **Input:** person crops.
- **Output:** per-person compliance `{helmet:0/1, vest, mask, gloves, uniform}`, violation event + zone.
- **Datasets:** SH17/PPE datasets, hardhat datasets, mask datasets (FMD), custom site uniform sets.
- **Inference pipeline:** person detect → attribute/PPE classifier or multi-class detector on person region → zone rule (e.g., "helmet required in Zone A") → violation event.
- **Accuracy goals:** ≥ 0.92 per attribute; tuned per PPE class.
- **Hardware:** edge-friendly.
- **Edge:** ✅. **Cloud:** ✅.
- **Future:** fine-grained PPE (harness, ear protection), correct-wear vs present (mask below nose), color/uniform matching per role.

## A10. People / Vehicle Counting, Occupancy, Heatmaps, Queue Analysis
- **Purpose:** Retail/ops analytics — footfall, line-crossing counts, live occupancy, dwell heatmaps, queue length/wait.
- **Input:** tracks + zones/lines.
- **Output:** counts (in/out), occupancy, heatmap grid, queue length & wait-time series.
- **Datasets:** MOT, site calibration; homography for floor mapping.
- **Inference pipeline:** detect+track → line-crossing counter / zone occupancy / spatial accumulation heatmap / queue zone dwell → time-series aggregates → analytics engine.
- **Accuracy goals:** counting ≥ 95% vs manual; occupancy ±5%.
- **Hardware:** edge-friendly (lightweight aggregation).
- **Edge:** ✅. **Cloud:** ✅ (aggregation/reporting).
- **Future:** demographic-free footfall, multi-cam de-dup across overlaps, conversion-funnel analytics.

---

# Section B — Complete Detection Specification Matrix

> Every requested detection. Columns: **Purpose · Input · Output · Datasets · Pipeline (model family) · Accuracy goal · HW/Edge · Cloud · Future**. (Marquee ones detailed above are summarized here for completeness.)

| # | Detection | Purpose | Input | Output | Datasets | Model family / pipeline | Accuracy goal | Edge | Cloud | Future |
|---|-----------|---------|-------|--------|----------|-------------------------|---------------|------|-------|--------|
| 1 | Human/Person Detection | Locate people | frame | person bboxes | COCO, CrowdHuman, MOT | YOLO+ByteTrack | mAP≥.90 | ✅ Jetson | ✅ | domain adapt |
| 2 | Face Detection | Find faces | person crop | face bbox | WIDER FACE | RetinaFace/SCRFD | ≥.95 | ✅ | ✅ | masked faces |
| 3 | Face Recognition | Identify person | face chip | identity/embed | MS1M/VGGFace2 | ArcFace + vector match | TAR≥.99@FAR1e-4 | ✅ | ✅ | aging, federated |
| 4 | Employee Recognition | Known staff | face embed | employeeId | enrolled gallery | gallery match | ≥.98 | ✅ | ✅ | attendance auto |
| 5 | Unknown Person | Flag non-enrolled | face embed | unknown event | gallery + threshold | rejection threshold | low false-accept | ✅ | ✅ | watchlist tiers |
| 6 | Crowd Detection | Density/gathering | frame | crowd count/density map | CrowdHuman, ShanghaiTech | density CNN (CSRNet) | ±10% | ✅ | ✅ | stampede predict |
| 7 | Child Detection | Detect children | person crop | child attribute | age datasets | person+age classifier | ≥.85 | ✅ | ✅ | safeguarding zones |
| 8 | Elderly Detection | Detect elderly | person crop | elderly attribute | age datasets | age classifier | ≥.85 | ✅ | ✅ | fall-risk link |
| 9 | Animal Detection | Detect animals | frame | animal bbox/species | COCO, iWildCam | YOLO | mAP≥.85 | ✅ | ✅ | pest/livestock |
| 10 | Vehicle Detection | Detect vehicles | frame | vehicle bbox/type | COCO, UA-DETRAC | YOLO+track | mAP≥.90 | ✅ | ✅ | make/model |
| 11 | Object Detection (generic) | Detect items | frame | object bboxes | COCO, LVIS, custom | YOLO/DETR | mAP≥.80 | ✅ | ✅ | open-vocab (CLIP) |
| 12 | Pose Detection | Body keypoints | person crop | 17-33 keypoints | COCO-Pose | MediaPipe/HRNet | PCK≥.90 | ✅ | ✅ | 3D pose |
| 13 | Action Recognition | Classify actions | clip/skeleton | action label | Kinetics, NTU-RGBD | SlowFast/ST-GCN/VideoMAE | ≥.85 | ⚠️ | ✅ | few-shot actions |
| 14 | Abnormal Behaviour | Anomaly vs baseline | clip/tracks | anomaly score | UCF-Crime, site baseline | autoencoder/optical-flow | alertable rate | ⚠️ | ✅ | self-supervised |
| 15 | Fire Detection | Detect flame | frames | fire region | D-Fire, FireNet | YOLO+temporal | recall≥.95 | ✅ | ✅ | thermal fusion |
| 16 | Smoke Detection | Detect smoke | frames(temporal) | smoke region | D-Fire, FIRESENSE | CNN-LSTM | recall≥.93 | ✅ | ✅ | early smoulder |
| 17 | Weapon Detection | Guns/knives | frame+person | weapon bbox | Sohas, custom | YOLO+2-stage verify | prec≥.95 | ✅ | ✅ | concealed cues |
| 18 | Violence Detection | Aggression | clip | violence event | RWF-2000, Hockey | temporal net | prec≥.85 | ⚠️ | ✅ | scene reasoning |
| 19 | Fight Detection | Physical fights | clip+pose | fight event | Fight datasets | ST-GCN/SlowFast | prec≥.85 | ⚠️ | ✅ | multi-cam |
| 20 | Slip Detection | Slipping | pose+temporal | slip event | Fall datasets | pose temporal | recall≥.88 | ✅ | ✅ | floor-hazard |
| 21 | Fall Detection | Falls | pose+temporal | fall event | UR Fall, Le2i | pose temporal classifier | recall≥.90 | ✅ | ✅ | pose-only privacy |
| 22 | Loitering | Excess dwell | tracks+zone | loiter event | site-tuned | track dwell timer | tunable | ✅ | ✅ | intent scoring |
| 23 | Trespassing | Enter forbidden area | tracks+zone | intrusion event | site-tuned | zone intrusion rule | ≥.95 | ✅ | ✅ | perimeter fusion |
| 24 | Tailgating | Follow through door | tracks+door zone+count | tailgate event | site-tuned | multi-person door-cross | ≥.90 | ✅ | ✅ | access-control link |
| 25 | Restricted Area Entry | Zone violation | tracks+zone | event | site-tuned | zone+identity rule | ≥.95 | ✅ | ✅ | time-based zones |
| 26 | Running | Fast motion | tracks | running event | site-tuned | speed threshold on track | tunable | ✅ | ✅ | panic detection |
| 27 | Sleeping Employee | Inactivity/posture | pose+dwell | event | posture datasets | pose+immobility timer | ≥.85 | ✅ | ✅ | shift-context |
| 28 | Mobile Phone Usage | Phone-in-hand | pose+object | event | phone-use datasets | hand-region object+pose | ≥.85 | ✅ | ✅ | driver/cashier ctx |
| 29 | Smoking | Detect smoking | pose+object | event | smoking datasets | cigarette+gesture | ≥.85 | ✅ | ✅ | vape detection |
| 30 | Helmet Detection | Hardhat presence | person crop | helmet 0/1 | hardhat datasets | attr classifier | ≥.92 | ✅ | ✅ | correct-wear |
| 31 | Mask Detection | Face mask | face crop | mask 0/1 | FMD | classifier | ≥.92 | ✅ | ✅ | wear-correctness |
| 32 | PPE Detection | Full PPE suite | person crop | per-item compliance | SH17/PPE | multi-attr detector | ≥.90 | ✅ | ✅ | harness/ear-pro |
| 33 | Uniform Detection | Dress-code | person crop | uniform match | custom per site | color/appearance classifier | ≥.88 | ✅ | ✅ | role-based |
| 34 | Bag Detection | Bags/luggage | frame | bag bbox+owner | COCO, custom | YOLO+association | mAP≥.85 | ✅ | ✅ | ownership track |
| 35 | Cash Detection | Cash on counter | counter zone | cash event | custom retail | object+zone | ≥.85 | ⚠️ | ✅ | denomination |
| 36 | Shelf Monitoring | Stock/planogram | shelf zone | empty-shelf/OOS | retail shelf datasets | segmentation+diff | ≥.88 | ⚠️ | ✅ | planogram compliance |
| 37 | Queue Analysis | Line length/wait | zone+tracks | queue metrics | site-tuned | zone dwell+count | ≥.90 | ✅ | ✅ | predictive staffing |
| 38 | Vehicle Counting | Count vehicles | tracks+line | in/out counts | UA-DETRAC | line-cross counter | ≥.95 | ✅ | ✅ | classified counts |
| 39 | People Counting | Count people | tracks+line | in/out counts | MOT | line-cross counter | ≥.95 | ✅ | ✅ | multi-cam dedup |
| 40 | Heat Maps | Spatial density | tracks | heatmap grid | site calib | accumulation | qualitative | ✅ | ✅ | temporal heatmap |
| 41 | Occupancy | Live headcount | zone+tracks | occupancy count | site-tuned | zone occupancy | ±5% | ✅ | ✅ | capacity alerts |
| 42 | Parking Detection | Slot occupancy | parking zones | slot state | PKLot, CNRPark | per-slot classifier/detect | ≥.95 | ✅ | ✅ | guidance/booking |
| 43 | License Plate Recog | Read plates | vehicle crop | plate text | CCPD, UFPR | detect+OCR (PARSeq) | ≥95% char | ✅ | ✅ | multi-country |
| 44 | Speed Detection | Estimate speed | tracks+calib | speed value | site calib | homography+track speed | ±10% | ✅ | ✅ | radar fusion |
| 45 | Abandoned Objects | Left items | frame+temporal | abandoned event | ABODA, AVSS | static-object+owner-gone | prec≥.85 | ✅ | ✅ | threat scoring |
| 46 | Removed Objects | Taken items | frame+temporal | removal event | custom | background diff | prec≥.85 | ✅ | ✅ | asset protection |
| 47 | Suspicious Behaviour | Risk gestures/dwell | tracks+pose | suspicion score | UCF-Crime, site | ensemble scoring | high precision | ⚠️ | ✅ | multi-cam re-ID |
| 48 | Shoplifting | Concealment | tracks+pose+zone | suspicion+clip | retail custom | gesture+shelf+POS fusion | high precision | ⚠️ | ✅ | scan-avoidance |
| 49 | Employee Theft | Staff theft | tracks+POS+cash zone | event | custom+POS | behaviour+POS correlation | high precision | ⚠️ | ✅ | sweethearting |
| 50 | Cash Counter Monitoring | POS anomalies | counter cam+POS | event | custom | zone+POS mismatch | tunable | ⚠️ | ✅ | void/refund fraud |
| 51 | Inventory Theft | Stock removal | warehouse zones | event | custom | object+zone+track | tunable | ⚠️ | ✅ | asset tagging |
| 52 | Warehouse Monitoring | Ops+safety | multi-detection | composite events | custom | forklift/PPE/zone bundle | per-model | ✅ | ✅ | forklift-pedestrian |
| 53 | Hospital Monitoring | Patient safety | fall/ppe/restricted | composite | care datasets | fall+hygiene+intrusion bundle | per-model | ✅ | ✅ | bed-exit, hygiene |
| 54 | School Monitoring | Safety | intrusion/violence/crowd | composite | custom | bundle | per-model | ✅ | ✅ | bullying cues |
| 55 | Factory Safety | Compliance | PPE/zone/machine | composite | industrial | PPE+zone+proximity | per-model | ✅ | ✅ | machine-guard |
| 56 | Construction Safety | Site safety | helmet/vest/zone/height | composite | construction datasets | PPE+danger-zone+height | per-model | ✅ | ✅ | fall-from-height |
| 57 | Restaurant Monitoring | Hygiene/ops | mask/glove/queue | composite | custom | PPE+queue+dwell | per-model | ✅ | ✅ | food-safety |
| 58 | Office Monitoring | Access/occupancy | tailgate/occupancy/asset | composite | custom | bundle | per-model | ✅ | ✅ | desk analytics |
| 59 | Bank Monitoring | Security | weapon/loiter/mask/tailgate | composite | custom | high-severity bundle | high precision | ✅ | ✅ | ATM skimming |
| 60 | Apartment/Residential | Perimeter/visitor | intrusion/face/vehicle/package | composite | custom | perimeter bundle | per-model | ✅ | ✅ | package-theft |

**Composite "industry" detectors (52–60)** are curated bundles of atomic models (1–51) + rules, packaged per vertical — see [Doc 04](./04-INDUSTRY-SOLUTIONS.md).

---

## Model Governance (applies to all)
- **Two-stage confirmation** for high-severity (weapon/violence) to cut false positives.
- **Per-site calibration & thresholds** stored per camera; sensitivity sliders exposed to admins.
- **Human-in-the-loop** for accusatory detections (theft/violence/FR) — advisory events for review, never automated judgments.
- **Continuous learning** from customer-flagged FP/FN (see MLOps, [Doc 09](./09-MLOPS-SECURITY-PERFORMANCE.md)).
- **Bias & fairness review** for any person-attribute or recognition model; jurisdictional gating for FR/LPR.
- **Model registry** versions every model with metrics, dataset lineage, and edge/cloud artifacts (ONNX/TensorRT/OpenVINO).
