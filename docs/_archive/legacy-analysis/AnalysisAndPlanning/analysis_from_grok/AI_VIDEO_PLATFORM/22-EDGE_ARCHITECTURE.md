# 22-EDGE_ARCHITECTURE.md

## Purpose
Low-latency, bandwidth-efficient, offline capable.

## Components
- Edge Agent on Jetson/NVIDIA devices or x86 with GPU.
- Local model inference.
- Sync queue to cloud on reconnect.

## Offline-first
Store events locally, sync metadata + clips.

## Detailed Edge AI Model Quantization Strategy

### Purpose
Enable real-time inference on resource-constrained edge devices (NVIDIA Jetson series, Intel NUC, Raspberry Pi with Coral/ Hailo accelerators) while maintaining acceptable accuracy for video analytics (object detection, tracking, behavior analysis).

### Why Quantization?
- Reduces model size (4x-8x) and memory footprint.
- Increases inference speed (2-10x) via lower precision arithmetic.
- Lowers power consumption — critical for always-on cameras and battery-powered drones.
- Reduces bandwidth for model updates.

### Supported Techniques & Pipeline

1. **Post-Training Quantization (PTQ)**
   - **INT8 Dynamic/Static**: Default for most models.
   - **INT4 / FP16**: For ultra-light devices.
   - Tools: ONNX Runtime + QuantizeStatic, TensorRT (best for NVIDIA).

2. **Quantization-Aware Training (QAT)**
   - Used for high-accuracy models (e.g., custom behavior classifiers).
   - Simulate lower precision during training to minimize accuracy drop (<2-3%).

3. **Model-Specific Optimizations**
   - **YOLOv8 / RT-DETR**: Export to ONNX → TensorRT engine with FP16/INT8.
     - Calibration dataset: Representative video frames from target environments (retail, warehouse).
   - **SAM2 / GroundingDINO**: Segment anything models — use sparse quantization or distillation into lighter student models.
   - **Tracking (ByteTrack)**: Lightweight MOT — minimal quantization impact.

### Implementation Steps (Edge Agent)

```bash
# Example TensorRT conversion pipeline
python export.py --model yolov8s.pt --format engine --quant int8 --calib-dataset data/calibration_frames/

# ONNX Runtime
onnx_model = onnx.load("model.onnx")
quantized_model = quantize_dynamic(onnx_model, weight_type=QuantType.QUInt8)
```

**Edge Deployment Flow**:
1. Model Registry pushes quantized variants tagged by device profile (Jetson Orin Nano vs Xavier).
2. Edge Agent pulls appropriate engine on boot/update.
3. Runtime: TensorRT / ONNX Runtime with CUDA/cuDNN or OpenVINO.
4. Dynamic fallback: If accuracy degrades (monitored via confidence scores), switch to higher precision or offload to cloud.

### Accuracy vs Performance Tradeoffs
- **Baseline FP32**: 95% mAP, ~30 FPS on Jetson AGX.
- **INT8**: 92-94% mAP, 120+ FPS, 50-70% power reduction.
- Mitigation: Calibration with domain-specific data; selective quantization (quantize backbone, keep head in FP16); ensemble with lightweight models.

### Monitoring & Retraining
- Edge telemetry: Inference latency, memory usage, confidence histograms.
- Drift detection → trigger cloud retraining + re-quantization in MLOps pipeline.
- Versioned models with A/B testing on subset of cameras.

### Security Considerations
- Signed model artifacts (code signing).
- Encrypted storage on edge.
- Runtime integrity checks.

### Future Improvements
- Neural Architecture Search (NAS) for edge-specific models.
- Quantization for newer formats (e.g., FP8, INT4 with NVIDIA Blackwell).
- Hardware-specific (Hailo-8, Google Edge TPU) compilation.

This strategy ensures sub-100ms latency for critical detections on edge while supporting 100+ cameras per gateway node.