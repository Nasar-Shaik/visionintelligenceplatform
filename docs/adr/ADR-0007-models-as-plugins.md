# ADR-0007 — Models as plugins (model provider extension point + marketplace)

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Enterprise Architecture Review, AI/MLOps
- **Touches:** Principle 7; docs/architecture/08, 20

## Context

[ADR-0002](ADR-0002-model-agnostic-inference.md) established model-agnostic inference via registry selectors. The review asks to go further: treat **models themselves as plugins** (YOLO, RT-DETR, Grounding DINO, SAM2, Florence, InternVL, OpenCLIP, Llama-Vision, custom) so first- and third-party models can be published, discovered, and swapped without core changes — enabling a **model marketplace**.

## Decision

Formalize a `model.provider` **extension point** ([20](../architecture/20-EXTENSIBILITY.md)): a model plugin packages weights (referenced in the registry, not the repo), pre/post-processing, an accelerator export matrix (ONNX/TensorRT/OpenVINO), a **model card** (metrics/lineage/license/fairness), and the task/family it satisfies — all behind the existing capability inference contract. The Model Registry ([08](../architecture/08-AI-ML-PLATFORM.md)) gains a marketplace surface with trust tiers (first-party / verified-partner / community) and revenue share.

## Alternatives considered

- **Registry selectors only (status quo).** Sufficient for internal models; but no clean third-party onboarding or marketplace. Rejected as insufficient for ecosystem goals.
- **Per-model bespoke integration.** Flexible; but no uniform contract, no marketplace, ops sprawl. Rejected.

## Consequences

- Positive: any model family becomes pluggable; ecosystem/marketplace enabled; capabilities remain untouched when a model is added/swapped.
- Negative/cost: signing, sandboxing, and validation (model CI gates) for third-party models; trust-tier governance.
- Follow-ups: [08](../architecture/08-AI-ML-PLATFORM.md) §"Models as plugins" and [20](../architecture/20-EXTENSIBILITY.md) `model.provider` added; model CI (benchmark + FP/FN gates) mandatory before any promotion.

## Compliance

Deepens Principle 7 (AI model-agnostic) and Law 4 (contract-first) without changing them; capabilities still bind models by selector.
