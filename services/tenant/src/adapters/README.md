# adapters/

Outbound-facing implementations: the **MongoDB** connection + collections (`mongo.ts`),
and later clients (NATS, Redis). They implement the ports the `application`/`domain`
layers expect and are the **only** place I/O lives.

- `mongo.ts` — connects, owns the `tenants` + `org_nodes` collections, creates the
  tenant-leading indexes (Law 5) and the unique-slug registry index, and exposes a
  readiness `ping()`. The collections are handed to `@vip/tenancy` `TenantRepository`
  by the composition root (`../index.ts`) — no other module talks to the driver.

Rules: adapters may import `application`/`domain`, `@vip/contracts`, `@vip/tenancy`;
nothing here is imported by `domain`. See docs/architecture/23 (service ownership),
docs/architecture/phase1/TENANT_ARCHITECTURE.md, and the service README.
