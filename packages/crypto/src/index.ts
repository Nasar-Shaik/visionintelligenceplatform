/**
 * @vip/crypto — at-rest secret vaulting shared across services (camera credentials in P1-3;
 * connector secrets and edge storage later). Authenticated AES-256-GCM envelopes over a key
 * derived from an `.env` app secret (ADR-0018 — no external KMS integrated). Build-free
 * (node:crypto only). See docs/architecture/phase1/CAMERA_ARCHITECTURE.md §Security.
 */
export { CryptoError } from './errors.js';
export { SecretBox, seal, open, deriveKey } from './secretbox.js';

/** Package version — bump per Constitution §7. */
export const CRYPTO_VERSION = '0.1.0';
