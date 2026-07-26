# ai/ — Python AI/ML

Python services implementing **perception/spatial/reasoning capabilities**, the model-agnostic inference runtime, and MLOps. **No industry logic** (Law 1); **no hardcoded models** — reference models by registry selector (Law/Principle 7, [ADR-0002](../docs/adr/ADR-0002-model-agnostic-inference.md)).

## Layout
```
inference/     Model-agnostic runtime: load ONNX/TensorRT/OpenVINO/CPU, batching, GPU scheduling
capabilities/  One module per capability (perception/spatial/reasoning) implementing the capability contract
models/        Model definitions, pre/post-processing, exporters (PyTorch→ONNX→TensorRT/OpenVINO)
pipelines/     Per-camera capability-graph execution helpers
search/        Embeddings (CLIP), captioning, NL query parsing
training/      Training scripts, augmentation, per-site fine-tuning
mlops/         Registry integration, datasets (DVC), CT pipelines, drift/A-B monitoring
serving/       Cloud model servers (Triton/ONNX Runtime), gRPC/HTTP
```

## Conventions
- Every capability implements the uniform contract ([docs/architecture/05](../docs/architecture/05-CAPABILITY-ARCHITECTURE.md)): descriptor + `init/process/health/dispose`; declares inputs/outputs/params/placement/resource-profile.
- Model artifacts live in the registry, not the repo. Model changes run **model CI** (benchmark + FP/FN gates) before promotion.
- Same implementation runs edge and cloud; placement is a scheduler decision.

See [08-AI-ML-PLATFORM](../docs/architecture/08-AI-ML-PLATFORM.md) and [reference/AI-CAPABILITY-CATALOG](../docs/reference/AI-CAPABILITY-CATALOG.md).
