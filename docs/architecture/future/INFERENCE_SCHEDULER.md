# Future Inference Scheduler — Proposal (Deliverable 10)

_Status: ⏳ Architect Review Pending · Documentation-only · Formalizes [05 §4 Execution Scheduler](../05-CAPABILITY-ARCHITECTURE.md) + [19-PERFORMANCE-AND-SCALE](../19-PERFORMANCE-AND-SCALE.md)_

> A future scalability component that decouples **frame production** (media) from **inference
> execution** (GPU workers) via a scheduler + queue — introduced **without changing existing APIs**.
> The frozen architecture **already anticipates this**: the `CapabilityDescriptor` carries a
> `ResourceProfile` "used by the Execution Scheduler ([05 §4b])", and placement is scheduler-decided.
> This is a **capacity component behind a stable interface**, not a redesign.

## Current architecture (Phase 1)

```
Media ──(frame)──▶ Inference runtime (/infer, batch=1, single capability) ──▶ capability.output.* ──▶ Events
```

Simple, correct, demo-ready. Its limits (R-005, [TD-4]/[TD-5]): one process, batch=1, no GPU pooling,
no cross-stream batching, in-proc media→inference not yet wired.

## Future architecture (scale-out)

```
Media ──▶ [Inference Scheduler] ──▶ GPU Queue(s) ──▶ Inference Workers (pool) ──▶ Event Pipeline
              │  (priority, batching-within-tenant, placement, backpressure)
              └─ decides WHERE (edge/cloud/GPU) using ResourceProfile + capability priority
```

- **Scheduler:** consumes frame/inference requests, applies **priority** (critical capabilities get
  reserved lanes — [09 §4]), **batches within a tenant/model** to fill GPUs, respects **placement**
  (edge vs cloud) and **backpressure** (drop-to-latest for live, queue for recorded).
- **GPU Queue:** durable work queue (NATS subjects or a broker) partitioned by model/hardware.
- **Workers:** a horizontally-scaled pool; each pulls work, runs the model (the existing
  `ModelAdapter`), emits `capability.output.*` — **the exact output contract as today**.

## Why existing APIs don't change (the key property)

- **Producers unchanged:** media still produces frames; the **subject/contract is identical**
  (`capability.output.*` → events). Media doesn't know a scheduler exists.
- **Consumers unchanged:** events/rules/incidents consume `capability.output.*` as today.
- **The `/infer` HTTP path stays** for synchronous/single-frame use (recorded analysis, tests); the
  scheduler is the **async, batched** path for live scale. Same `InferenceRequest`/`DetectionResult`
  contracts.
- **Model adapter + selector + registry unchanged** (ADR-0002/0012) — workers reuse them.

So the scheduler slots **between** media and workers **on the existing subjects**, an internal capacity
change — no service's public API moves.

## Scaling properties gained

Horizontal GPU scale (add workers), cross-stream batching (GPU efficiency), priority lanes
(safety-critical never starved), placement optimization (edge offload), graceful degradation
(load-shed non-critical), observability (queue depth, GPU util, per-model throughput — [16]).

## Proposal status & prerequisites

- **Phase 4** (Production & Scaling). **Prerequisite:** a **load harness** (camera-simulator) to prove
  assumptions (R-005) — build the harness + prototype the scheduler **behind the unchanged interface**
  before committing (AR-5).
- Keep **batch=1, single-process** as the default until scale pressure is demonstrated. Do **not**
  introduce the scheduler for the demo — it adds complexity the product doesn't yet need.

## Not built now

Documentation-only. The current simple path is correct for Productization; the scheduler is the
**documented scale path** whose interface-stability is guaranteed by the frozen capability/output
contracts.
