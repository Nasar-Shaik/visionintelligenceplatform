# 08 — AI / ML Platform

## Purpose

Define the model-agnostic AI platform: how models and datasets are registered, trained, evaluated, versioned, deployed, monitored, and continuously improved — serving every perception capability without any model being hardcoded. Operationalizes Principle 7 (AI model-agnostic).

## Responsibilities

- Own the **Model Registry** and **Dataset Registry** (the source of truth for AI artifacts).
- Own the inference runtime abstraction (ONNX/TensorRT/OpenVINO/CPU/GPU/edge/cloud).
- Own the MLOps lifecycle: train → evaluate → version → deploy (canary/A-B/shadow) → monitor → continuous-learning → rollback.
- Guarantee capabilities reference models by **selector**, never by file/vendor.

---

## 1. Model-agnosticism (the central rule)

A capability declares a **model selector** (`{task, family, version-range, accelerator}`), and the runtime binds a concrete, versioned artifact from the registry. Consequences:

- Swapping YOLO→DETR, or v8→v11, or FP16→INT8-edge, is a **registry + config** change; capability code is untouched.
- Foundation models (open-vocabulary detection, VLM captioning, CLIP embeddings) and custom fine-tuned models are equal citizens — both are registry artifacts behind the same contract.
- Per-tenant/per-camera/per-site model assignment and overrides are configuration.

## 2. Model Registry

- Every model is an **immutable, versioned artifact** with: task, family, training config, **dataset lineage**, metrics (precision/recall/mAP/latency), fairness/bias notes, license, and **multi-target exports** (PyTorch → ONNX → TensorRT/OpenVINO INT8 for edge).
- Semantic model versions; **staged promotion**: `dev → shadow → canary → prod`, each gated by metric thresholds.
- Per-tenant/per-camera assignment (`modelAssignments`); a version is **instantly re-pinnable** (rollback) per tenant/camera.
- Backed by an MLflow-class registry + object storage for artifacts. → [18](18-DATA-ARCHITECTURE.md)

## 3. Dataset Registry

- Versioned datasets (DVC/lakeFS) with lineage raw → labeled → splits; **consent/licensing metadata** per source; PII handling/anonymization recorded.
- Curated, versioned **benchmark sets per capability** for regression testing; synthetic generation where data is scarce (fire, weapons, plates).
- Auto-labeling + **human-in-the-loop** correction; active-learning prioritizes uncertain/false cases fed back from the field.

## 4. Inference runtime

- Uniform runtime (`ai/inference`) loads models by target: **ONNX Runtime**, **TensorRT** (NVIDIA/Jetson), **OpenVINO** (Intel CPU/iGPU), plain **CPU**. Optional **Triton** for cloud model serving.
- Features: batching across streams, GPU scheduling, ROI masking, warmup, quantization (INT8) for edge, adaptive precision.
- **Placement** decided by the scheduler ([05 §4](05-CAPABILITY-ARCHITECTURE.md)): edge for real-time/safety-critical; cloud for heavy/batch (temporal action, embeddings, search, training).

## 5. Training & evaluation

- Reproducible training (PyTorch/TF), mixed precision, multi-GPU (DDP); base models + **per-site/per-vertical fine-tuning** on consented data.
- CCTV-realism augmentation: low-light/IR, motion blur, weather, angle, occlusion, resolution jitter.
- **Evaluation gates in model CI**: precision/recall thresholds per capability; **false-positive** hard-negative sets (steam vs smoke, phone vs gun); **false-negative** budgets for safety-critical recall (fire/weapon/fall must never regress); fairness audits for person/face models; jurisdiction gating for face/LPR.

## 6. Deployment strategies

- **Shadow**: new model runs alongside prod on live streams, logs predictions without acting → compare quality.
- **Canary / A-B**: route a % of cameras/tenants to the new model; compare event quality + operator feedback; **auto-rollback** on regression.
- **Edge OTA**: quantize → package → staged rollout to edge fleet with health checks and rollback. → [14](14-EDGE-PLATFORM.md)
- Every model change runs the benchmark + FP/FN gates in CI **before** registry promotion.

## 7. Monitoring & continuous learning

- Per-model precision/recall proxies, FP/FN rates (from acknowledgments + operator flags), confidence distributions, **data drift** (input distribution shift per site), latency/throughput, accelerator utilization.
- Alerts on accuracy degradation/drift/latency SLO breach → trigger investigation/retrain.
- **Continuous-training loop:**

```
field data → flag FP/FN → auto-label + human review → dataset version →
train → validate (benchmarks + FP/FN gates) → register →
shadow → canary/A-B → promote → OTA to edge → monitor → (drift) → repeat
```

## 8. Models as plugins & the Model Marketplace

Models are **plugins** ([ADR-0007](../adr/ADR-0007-models-as-plugins.md)), implemented against a `model.provider` extension point ([20](20-EXTENSIBILITY.md)) so first- and third-party models are published, discovered, and swapped without core changes.

- **Any family qualifies** — YOLO, RT-DETR, Grounding DINO, SAM2, Florence, InternVL, OpenCLIP, Llama-Vision, and custom fine-tuned models — as long as it satisfies the task's inference contract.
- A model plugin packages: weights (referenced in the registry, not the repo), pre/post-processing, an **accelerator export matrix** (ONNX/TensorRT/OpenVINO), and a **model card** (metrics, dataset lineage, license, fairness). Capabilities still bind models by **selector** ([ADR-0002](../adr/ADR-0002-model-agnostic-inference.md)) — the plugin just widens the pool of what a selector can resolve.
- **Marketplace:** the registry exposes a marketplace surface with **trust tiers** (first-party / verified-partner / community), signing, model-CI gating before promotion, and revenue share. This keeps the platform strictly **AI-model independent** while enabling an ecosystem.

## 8a. Model Adapter Layer

To make capabilities **completely** model-independent, every model is wrapped by a **Model Adapter** ([ADR-0012](../adr/ADR-0012-model-adapter-layer.md)):

```
Capability ─▶ Model Adapter ─▶ AI Model
person-detection ─▶ YOLO adapter      ─▶ YOLO11
person-detection ─▶ RT-DETR adapter   ─▶ RT-DETR
person-detection ─▶ GroundingDINO adapter ─▶ Grounding DINO
```

The capability calls **only the adapter contract** (resolved via its selector); it never knows which model is underneath. Adapters are the concrete implementation behind the `model.provider` plugin ([20](20-EXTENSIBILITY.md)).

**`ModelAdapter` contract (uniform for every model):**

```typescript
interface ModelAdapter<Out> {
  descriptor: { task; family; version; accelerators: [] }; // versioning
  load(ctx): Promise<void>; // lifecycle: load + warm
  preprocess(input): Tensor; // model-specific input shaping
  infer(t: Tensor): RawOutput; // runtime call
  postprocess(r: RawOutput): Out; // → NORMALIZED capability output
  health(): HealthStatus; // health
  metrics(): { latency; throughput; confidenceDist }; // metrics
  dispose(): Promise<void>;
}
```

- **Interface:** all pre/post-processing, tensor layout, class maps, and decode logic live in the adapter, not the capability.
- **Lifecycle:** `load/warm → infer → dispose`, managed by the inference runtime; hot-swappable per selector.
- **Configuration:** adapter params (thresholds, input size, class map) come from the config hierarchy ([06 §6](06-MULTI-TENANT-SAAS.md)).
- **Metrics & health:** uniform across models, feeding monitoring ([16](16-OBSERVABILITY.md)) and the capability registry ([05 §3](05-CAPABILITY-ARCHITECTURE.md)).
- **Error handling:** adapter faults are isolated (fallback to a compatible model version or graceful degradation), never crash the capability DAG.
- **Versioning:** adapters are semver'd and bound to a model version; **future models** (Florence, SAM2, InternVL, Llama-Vision, custom) ship as new adapters with zero capability change.
- Adapters must pass **contract testing** ([03](03-ARCHITECTURE-PRINCIPLES.md)) and **certification** ([20](20-EXTENSIBILITY.md)) before production.

## 9. Model lifecycle governance

- Two-stage confirmation for high-severity detections; per-site calibration/thresholds; **human-in-the-loop for accusatory detections** (theft/violence/face) — advisory events for review, never automated judgments.
- Full model lineage and metrics retained; **model cards** in `docs/reference`. Bias/fairness review required for any person-attribute or recognition model.
- Third-party/community model plugins run under trust-tier restrictions and must pass the same model-CI benchmark + FP/FN gates before any tenant promotion.

## Design decisions

- **Selector-based binding** ([ADR-0002](../adr/ADR-0002-model-agnostic-inference.md)) is what prevents vendor/model lock-in and lets capability and model lifecycles evolve independently.
- **Multi-target export in the registry** means the same logical model runs cloud-GPU and Jetson-edge without re-authoring.
- **Gates in model CI** make safety-critical regression a build failure, not a field incident.

## Advantages

- Never trapped by a model generation or vendor; continuous improvement without redeploys of capability code.
- Edge and cloud inference from one artifact lineage.

## Tradeoffs

- The runtime abstraction + registry + MLOps pipelines are substantial infrastructure; justified by decade-scale model churn and the safety/compliance stakes.

## Future expansion

- Open-vocabulary detection and VLM-driven capabilities; on-device federated fine-tuning; a **model marketplace** for partner-published, revenue-shared models; sensor-fusion models (thermal/radar).

## Cross-references

[05-CAPABILITY-ARCHITECTURE](05-CAPABILITY-ARCHITECTURE.md) · [14-EDGE-PLATFORM](14-EDGE-PLATFORM.md) · [18-DATA-ARCHITECTURE](18-DATA-ARCHITECTURE.md) · [reference/AI-CAPABILITY-CATALOG](../reference/AI-CAPABILITY-CATALOG.md) · [ADR-0002](../adr/ADR-0002-model-agnostic-inference.md)
