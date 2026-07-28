# @vip/crypto

**At-rest secret vaulting** shared across the platform. Authenticated **AES-256-GCM** envelope
encryption over a 32-byte key derived from an `.env` app secret ([ADR-0018](../../docs/adr/ADR-0018-env-only-secrets-and-centralized-config.md)
— no external KMS is integrated). **Build-free:** `node:crypto` only, no native modules.

First consumer: camera credential vaulting (P1-3). Reused later for connector secrets and edge
local-storage encryption ([14-EDGE-PLATFORM](../../docs/architecture/14-EDGE-PLATFORM.md)).

## Why

Camera RTSP/RTMP credentials (and other third-party secrets) must be stored so that a database
dump alone never yields plaintext. GCM's authentication tag means a wrong key or any tampering
**fails loudly** (`CryptoError`) rather than returning garbage — the caller treats that as
"secret unusable", never a leak.

## API

```ts
import { SecretBox, seal, open, deriveKey, CryptoError } from '@vip/crypto';

// Derive once at the composition root, inject the box.
const box = SecretBox.fromSecret(process_secret); // scrypt → 32-byte key
const sealed = box.seal(JSON.stringify({ username, password })); // "v1.gcm.<iv>.<tag>.<ct>"
const plaintext = box.open(sealed); // throws CryptoError on wrong key / tamper / malformed

// Or use the free functions with a caller-held key:
const key = deriveKey(secret);
open(seal('x', key), key);
```

- **Envelope:** `v1.gcm.<iv>.<tag>.<ciphertext>` (base64url); the `v1` prefix reserves room for
  key/scheme rotation without ambiguity.
- **Key derivation:** `scrypt(secret, fixed-salt, 32)` — deterministic (existing ciphertext stays
  openable across restarts) and stretched (brute-force resistant). The secret must be ≥16 chars
  (high-entropy; enforced here and by `@vip/config`).
- **IV:** a fresh 12-byte random nonce per `seal`, so identical plaintext yields distinct output.

## Non-goals (Phase 1)

Envelope/DEK-per-record wrapping, key rotation tooling, and asymmetric schemes are future
extensions — the `v1` envelope tag is the seam. This package does **not** manage where the secret
comes from; that is `@vip/config` (`.env` only).

## Test

```bash
pnpm --filter @vip/crypto test    # round-trip, tamper/wrong-key rejection, deterministic KDF
```
