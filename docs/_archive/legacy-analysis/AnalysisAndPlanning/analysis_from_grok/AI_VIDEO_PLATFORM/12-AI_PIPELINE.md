# 12-AI_PIPELINE.md

## Architecture
Modular: Detection -> Tracking -> Behavior -> Classification.

## Models
- Object: YOLOv8/v10 or RT-DETR for speed/accuracy.
- Segmentation: SAM2.
- Tracking: ByteTrack (fast) vs DeepSORT (accurate).

## Why TensorRT/ONNX
Optimized inference on edge/GPU.

## MLOps
Model serving with Triton or custom.