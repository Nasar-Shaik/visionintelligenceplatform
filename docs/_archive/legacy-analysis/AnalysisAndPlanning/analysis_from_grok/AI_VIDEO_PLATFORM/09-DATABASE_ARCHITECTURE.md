# 09-DATABASE_ARCHITECTURE.md

## Choices
MongoDB for events (flexible JSON with video metadata).
Redis for sessions/caches.
TimescaleDB/Postgres extension for time-series if needed.

## Schemas
Detailed JSON schemas for cameras, events, tenants.
Sharding strategy by tenant_id + timestamp.