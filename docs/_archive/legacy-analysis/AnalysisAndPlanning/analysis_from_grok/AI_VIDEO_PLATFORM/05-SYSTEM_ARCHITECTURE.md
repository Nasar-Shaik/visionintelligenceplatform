# 05-SYSTEM_ARCHITECTURE.md

## Purpose
High-level system overview.

## Architecture Style
Event-driven microservices on Kubernetes. CQRS for reads/writes. Saga for distributed transactions.

## Components
- Ingestion Layer
- Processing Layer (AI workers)
- Storage Layer
- API Gateway
- Edge Agents

## Technology Choices
- Kubernetes for orchestration
- Kafka for events
- gRPC for internal comms
- React frontend

## Why
Scalability, fault isolation.

## Tradeoffs
Complexity vs simplicity (monolith for MVP? No, microservices from start for modularity).

## Scaling
Auto-scale GPU pods based on load.