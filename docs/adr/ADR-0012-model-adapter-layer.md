# ADR-0012 — Model Adapter Layer between capabilities and models

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Final Architecture Enhancement (v1.0), AI/MLOps
- **Touches:** Principle 7; docs/architecture/08, 05, 20

## Context
[ADR-0002](ADR-0002-model-agnostic-inference.md) (selectors) and [ADR-0007](ADR-0007-models-as-plugins.md) (models as plugins) make models swappable, but the *shape* of a model (pre/post-processing, tensor layout, class maps, decode) still differs per family. Without a normalizing layer, a capability would leak model-specific glue. We need `Capability → Model Adapter → AI Model` so a capability is **completely** model-independent.

## Decision
Introduce a **Model Adapter Layer**: every model is wrapped by an adapter implementing a uniform `ModelAdapter` contract (load/warm, preprocess, infer, postprocess→normalized output, health, metrics, dispose, version). A capability calls only the adapter contract via its selector; it never knows whether YOLO11, RT-DETR, or Grounding DINO is underneath. Adapters are the concrete implementation behind the `model.provider` plugin ([20](../architecture/20-EXTENSIBILITY.md)).

## Alternatives considered
- **Selectors only (status quo).** Chooses the artifact; but per-family glue still lands in the capability or runtime. Insufficient for full independence.
- **Per-capability model code.** Flexible; but couples capability to model shape, defeating agnosticism. Rejected.

## Consequences
- Positive: capabilities are truly model-agnostic; new model families (Florence, SAM2, InternVL, Llama-Vision, custom) added as adapters with no capability change; uniform metrics/health across models.
- Negative/cost: an adapter per model family; adapter conformance tests (contract tests) required.
- Follow-ups: [08 §Model Adapter Layer](../architecture/08-AI-ML-PLATFORM.md) documents the contract; adapters pass contract testing ([03](../architecture/03-ARCHITECTURE-PRINCIPLES.md)) and certification ([20](../architecture/20-EXTENSIBILITY.md)) before production.

## Compliance
Deepens Principle 7 without changing it; capabilities keep binding models by selector, now normalized through adapters.
