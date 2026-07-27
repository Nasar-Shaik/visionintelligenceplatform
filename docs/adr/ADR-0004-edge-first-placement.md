# ADR-0004 — Edge-first capability placement, one codebase

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Architecture, Video/AI
- **Touches:** Principles 9, 10; docs/architecture/04, 05, 14

## Context

Cloud-only inference is expensive (GPU + bandwidth) and cannot meet real-time latency or offline/privacy requirements for many sites. But maintaining a separate "edge product" and "cloud product" would fork the codebase and double cost.

## Decision

Edge and cloud run the **same capability contracts and implementations**; "edge vs cloud" is a **placement decision** made by the scheduler per capability node. Real-time/safety-critical capabilities default to the edge; heavy/batch (embeddings, temporal action, search, training) default to cloud. The edge operates fully offline and reconciles via store-and-forward.

## Alternatives considered

- **Cloud-only.** Simplest ops; but high cost, higher latency, no offline, weaker privacy. Rejected.
- **Separate edge and cloud codebases.** Optimized each; but forks logic, doubles maintenance and test surface, drifts. Rejected.

## Consequences

- Positive: best cost/latency/privacy; resilience during WAN loss; one engineering effort for both.
- Negative/cost: fleet management, OTA, and offline reconciliation complexity (contained in `edge/` + `services/fleet`); a supported-device matrix and per-target model builds.
- Follow-ups: chaos tests must prove no data loss across WAN outage → reconnect.

## Compliance

Implements Principles 9 and 10 and the deploy-anywhere property in docs/architecture/04.
