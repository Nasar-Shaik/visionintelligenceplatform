# 08-MICROSERVICES.md

## List of Services
1. camera-service: Manages cameras, streams.
2. ingestion-service: Handles video intake.
3. ai-inference-service: GPU workers for models.
4. tracking-service.
5. rule-service.
6. alert-service.
7. dashboard-service.
8. tenant-service for multi-tenancy.

## Responsibilities
Each service is stateless where possible, uses Kafka for events.

## Communication
Async events + synchronous gRPC for low-latency.

## Deployment
Helm charts per service.