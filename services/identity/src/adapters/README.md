# adapters/

Outbound-facing implementations: repositories (MongoDB), and clients (NATS, Redis,
MinIO, external IdPs). They implement ports defined by the `application`/`domain`
layers and are the **only** place I/O lives.

**Empty in the Phase 0 scaffold** — the Identity context owns no data yet. When the
first dependency is wired (P1), its client registers a readiness check with the
`ReadinessRegistry` (`../application/readiness.ts`) so `/ready` reflects real health.

Rules: adapters may import `application`/`domain` and `@vip/contracts`; nothing here is
imported by `domain`. See docs/architecture/23 (identity ownership) and the service
README.
