# tests/ — Cross-Service & Platform Test Suites

Per-service unit/contract/integration tests live **with their code**. This directory holds **cross-cutting** suites that span services or the whole platform.

## Layout
```
isolation/   Cross-tenant access attempts on EVERY endpoint/stream — MUST fail-closed (milestones M3)
e2e/         Critical journeys: onboard camera → capability DAG → event → rule → alert → evidence → search
load/        k6/Locust: API/WS throughput, stream fan-out
stress/      Camera simulators: N-camera GPU saturation, backpressure, graceful degradation
chaos/       Node/GPU/worker/storage/WAN-outage failures; edge offline→sync no-data-loss (M6)
model/       Model validation harness: benchmark + FP/FN gates per capability (feeds model CI)
scale/       1,000-camera load + 10,000-camera fleet simulation (M17)
```

## Rules
- Isolation and safety-critical model gates are **release blockers**, not optional.
- New data path → an isolation test. New capability → a contract + model-validation test. New rule/workflow primitive → an evaluator test.

See [03-ARCHITECTURE-PRINCIPLES §Testing](../docs/architecture/03-ARCHITECTURE-PRINCIPLES.md), [19-PERFORMANCE-AND-SCALE](../docs/architecture/19-PERFORMANCE-AND-SCALE.md), [MILESTONES](../tracking/MILESTONES.md).
