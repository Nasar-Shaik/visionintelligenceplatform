# @vip/permissions

Authorization: an RBAC role→permission catalog + a **Policy Decision Point** (`can`),
**deny-by-default**. Services never hand-roll checks — they ask `principalCan(context, 'user:read')`.

- **Permissions** are `resource:action[:scope]` strings (the `@vip/contracts` `Permission` shape).
- **Roles** grant wildcard-aware patterns: `*` (all), `res:*`, `*:read`. Catalog: `owner`, `admin`,
  `operator`, `viewer`.
- The full **Policy Engine** ([28-POLICY-ENGINE](../../docs/architecture/28-POLICY-ENGINE.md),
  [ADR-0013](../../docs/adr/ADR-0013-policy-engine.md)) plugs in behind this same surface in Phase 3
  without changing call sites.

```ts
import { principalCan, permissionsForRoles, can } from '@vip/permissions';

principalCan({ roles: ['viewer'] }, 'user:read'); // true
principalCan({ roles: ['viewer'] }, 'user:create'); // false (deny-by-default)
principalCan({ roles: ['admin'] }, 'user:create'); // true
```

Design: [phase1/AUTHENTICATION](../../docs/architecture/phase1/AUTHENTICATION.md),
[06-MULTI-TENANT-SAAS §3](../../docs/architecture/06-MULTI-TENANT-SAAS.md). ABAC hierarchical
subtree scopes (`own/zone/site/...`) are a Phase-3 refinement. `pnpm --filter @vip/permissions test`.
