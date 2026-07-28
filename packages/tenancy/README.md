# @vip/tenancy

Fail-closed multi-tenant **data-layer guard** (Law 5). Tenant isolation is enforced
_structurally_ — not by remembering to add `where tenantId` — so a forgotten filter
cannot leak data across tenants.

Design: [docs/architecture/phase1/TENANT_ARCHITECTURE.md](../../docs/architecture/phase1/TENANT_ARCHITECTURE.md)
· [06-MULTI-TENANT-SAAS](../../docs/architecture/06-MULTI-TENANT-SAAS.md)
· [ADR-0003](../../docs/adr/ADR-0003-tenant-isolation-strategy.md).

## The rule

Every service touches tenant data **only** through a `TenantRepository`, holding a
`TenantScope`. There is no way to build a scope without a non-empty `tenantId`, and no
repository method runs without one — both fail closed with a `TenancyError`.

```ts
import { TenantScope, TenantRepository, type TenantScoped } from '@vip/tenancy';

interface TenantDoc extends TenantScoped {
  _id: string;
  slug: string;
}

const scope = TenantScope.fromContext(request.tenantContext); // throws if no context
const tenants = new TenantRepository<TenantDoc>(db.collection<TenantDoc>('tenants'));

await tenants.insertOne(scope, { _id, slug }); // tenantId stamped + enforced
await tenants.findMany(scope, { slug }); // tenantId injected — never cross-tenant
```

## What it guarantees

| Operation              | Guard behaviour                                                    |
| ---------------------- | ------------------------------------------------------------------ |
| build a scope          | requires a non-empty `tenantId`; else `TenancyError` (fail-closed) |
| `insertOne`            | stamps `tenantId`; refuses a doc pre-stamped for another tenant    |
| `findOne` / `findMany` | injects `tenantId`; refuses a filter targeting another tenant      |
| `updateOne`            | injects `tenantId`; refuses any update that reassigns/removes it   |
| `deleteOne` / `count`  | injects `tenantId`                                                 |
| `aggregate`            | prepends a leading tenant `$match` so stages can't widen scope     |
| `assertOwned`          | re-checks a loaded record's owner before it is returned            |

## Building blocks

- **`TenantScope`** — a validated, non-empty tenant identity; the single fail-closed choke point.
- **Pure guard** (`scopedFilter`, `scopedInsert`, `guardUpdate`, `scopedPipeline`, `assertOwned`) —
  storage-agnostic transforms, fully unit-tested without a database.
- **`TenantRepository<T>`** — applies the guard to a MongoDB `Collection<T>`.

## Testing

`pnpm --filter @vip/tenancy test` — pure-guard + repository isolation units (in-memory fake).
Real-driver isolation is proven by the tenant service's Testcontainers integration suite.
