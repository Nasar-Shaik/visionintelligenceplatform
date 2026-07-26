# 16 — Observability

## Purpose
Define metrics, tracing, logging, health checks, dashboards, alerting, and capacity planning so the platform is operable at scale. Operationalizes Principle 13 (observable).

## Responsibilities
- Standardize telemetry emission across all services, capabilities, and edge agents.
- Define SLIs/SLOs, alerting, and capacity signals.

---

## 1. Metrics
- **Standard**: OpenTelemetry metrics → Prometheus-compatible store; Grafana dashboards. Every service exposes `/metrics`.
- **RED** (Rate/Errors/Duration) per service + **USE** (Utilization/Saturation/Errors) per resource (GPU/CPU/mem/disk/queue).
- **Domain SLIs**: frame→event latency, event→alert latency, inference throughput/GPU util per capability, event backlog/consumer lag, notification delivery success, camera-online %, edge-sync lag, model FP/FN proxies.
- All metrics carry `tenantId`/`region`/`capability` labels (bounded cardinality) for per-tenant SLOs.

## 2. Tracing
- **Distributed tracing** (OpenTelemetry) with a **correlation ID** propagated from ingest → event → rule → workflow → notification, and across edge↔cloud sync. Enables end-to-end latency attribution across the async pipeline.

## 3. Logging
- **Structured JSON logs** (level, service, tenantId, correlationId, event refs), shipped to a log store (Loki/ELK). **No PII in logs** (enforced in review/CI). Errors also to an error tracker (Sentry). Audit logs are separate and immutable ([15 §5](15-SECURITY-ARCHITECTURE.md)).

## 4. Health checks
- Every service: `/health` (liveness), `/ready` (readiness incl. backing-service checks). Edge: heartbeat + per-camera health ([14 §4](14-EDGE-PLATFORM.md)). Synthetic probes for critical journeys.

## 5. Dashboards
- Standard dashboards per service (RED/USE), platform dashboards (pipeline latency, GPU fleet, event throughput, notification SLA), **per-tenant** health, **MLOps** dashboards (model metrics/drift), and edge **fleet** dashboards. Industry Packs may ship business dashboards (separate from ops observability). → [13](13-INDUSTRY-PACKS.md)

## 6. Alerting
- **SLO-based alerting** (error budgets) rather than raw-threshold noise; multi-window burn-rate alerts. Alerts route to on-call (paging), with runbooks linked ([docs/runbooks](../runbooks/)). Separate from *customer* event alerts (those are Notifications, [11](11-WORKFLOW-ENGINE.md)).

## 7. Capacity planning
- Continuous capacity signals: cameras/GPU, queue depth vs. worker count, storage growth vs. retention, per-tenant usage vs. plan. Feeds autoscaling policies and a **cost/capacity model** ([19 §3](19-PERFORMANCE-AND-SCALE.md)); budget alerts per environment.

## 8. SLOs (initial targets)
| SLI | SLO |
|---|---|
| Control-plane API availability | 99.9% |
| Frame→event latency (edge, real-time) | p95 < 300 ms |
| Event→critical-alert latency | p95 < 3 s |
| Notification delivery success | > 99% with retry |
| Camera-online ratio | > 99% (excl. customer network) |
| Edge sync lag after reconnect | p95 < 60 s for backlog drain start |

## Design decisions
- **OpenTelemetry everywhere + correlation IDs** make the async, multi-plane pipeline debuggable end-to-end.
- **SLO/error-budget alerting** prevents alert fatigue and ties ops to user-visible reliability.

## Advantages
- Per-tenant observability supports SLAs and troubleshooting at enterprise scale.
- Unified telemetry across cloud and edge fleet.

## Tradeoffs
- Telemetry volume and cardinality cost; controlled via label discipline, sampling for traces, and tiered retention.

## Future expansion
- eBPF-based profiling, anomaly detection on ops metrics, automated capacity forecasting, per-tenant status pages.

## Cross-references
[15-SECURITY-ARCHITECTURE](15-SECURITY-ARCHITECTURE.md) · [17-DEVOPS-AND-INFRA](17-DEVOPS-AND-INFRA.md) · [19-PERFORMANCE-AND-SCALE](19-PERFORMANCE-AND-SCALE.md)
