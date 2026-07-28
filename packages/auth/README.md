# @vip/auth

Authentication primitives shared by the identity service and the gateway. **Build-free crypto**
(no native addons, consistent with the project's dependency policy):

- **Passwords** — `hashPassword` / `verifyPassword` via Node's built-in **scrypt** (memory-hard KDF).
  Stored as a self-describing PHC-like string `scrypt$N$r$p$salt$hash`; constant-time compare.
- **Access tokens** — `signAccessToken` / `verifyAccessToken` via **jose** (pure-JS), HS256, short TTL.
  Claims: `sub` (principal), `tid` (tenant), `email`, `roles` — they mint the downstream `TenantContext`.
- **Refresh tokens** — `generateRefreshToken` (opaque, 256-bit) + `hashRefreshToken` (SHA-256). Only
  the hash is persisted; rotation + reuse-detection state live in the identity service.

Authorization is separate ([@vip/permissions](../permissions/README.md)). Design:
[phase1/AUTHENTICATION](../../docs/architecture/phase1/AUTHENTICATION.md),
[15-SECURITY](../../docs/architecture/15-SECURITY-ARCHITECTURE.md).

```ts
const hash = await hashPassword(plaintext);
const ok = await verifyPassword(plaintext, hash);
const { token, expiresIn } = await signAccessToken(claims, { secret, accessTtl: '15m' });
const claims = await verifyAccessToken(token, { secret }); // throws AuthError if invalid/expired
```

**Future:** RS256/JWKS split (identity signs with a private key, gateway verifies with the public
key) — swap the key material, not the call sites. argon2id is a valid password-hash alternative but
ships as a native addon; revisit only if required. `pnpm --filter @vip/auth test`.
