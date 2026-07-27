# ADR-0002 — Model-agnostic inference via registry selectors

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Architecture, AI/MLOps
- **Touches:** Principle 7; docs/architecture/05, 08

## Context

Vision models churn fast (families, versions, accelerators). Hardcoding a model into a capability creates vendor/generation lock-in and couples capability lifecycle to model lifecycle. Safety-critical detections also require rollback and canary at the model level.

## Decision

Capabilities will reference models by a **registry selector** (`{task, family, version-range, accelerator}`); the inference runtime binds a concrete, immutable, versioned artifact from the Model Registry at load time. Runtimes (ONNX/TensorRT/OpenVINO/CPU/GPU) are pluggable behind a uniform inference contract.

## Alternatives considered

- **Hardcoded model per capability.** Simplest; but no swap, no canary/rollback without code change, vendor lock-in. Rejected.
- **Per-capability bespoke serving.** Flexible per team; but no uniform lifecycle, duplicated ops. Rejected.

## Consequences

- Positive: swap/upgrade/quantize models without touching capability code; canary/shadow/rollback per tenant/camera; edge+cloud from one lineage.
- Negative/cost: a real registry + runtime abstraction + model CI gates are required infrastructure.
- Follow-ups: model CI (benchmark + FP/FN gates) blocks promotion; model cards recorded.

## Compliance

Implements Principle 7 (AI model-agnostic) and supports the safety/compliance posture in docs/architecture/08.
