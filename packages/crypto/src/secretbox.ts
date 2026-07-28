/**
 * Authenticated symmetric encryption for secrets at rest (camera credentials, connector secrets,
 * edge local storage). AES-256-GCM (confidentiality + integrity) with a per-message random IV,
 * over a 32-byte key derived from an `.env` app secret (ADR-0018 — no external KMS). Build-free:
 * node:crypto only. GCM's auth tag makes tampering and wrong-key decryption fail loudly, never
 * silently — the caller must treat any `CryptoError` as "credential unusable" (never a plaintext
 * leak). See docs/architecture/phase1/CAMERA_ARCHITECTURE.md §Security, 15-SECURITY.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { CryptoError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce size
const TAG_BYTES = 16; // GCM auth tag
const VERSION = 'v1'; // envelope version, for future key/scheme rotation

/**
 * Fixed application salt for key derivation. The app secret is expected to be high-entropy
 * (config enforces a minimum length); the salt only namespaces this derivation from any other
 * use of the same secret. Changing it re-keys everything (would orphan existing ciphertext), so
 * it is a stable constant, not a config value.
 */
const KDF_SALT = 'vip:secretbox:v1';

/**
 * Derive the 32-byte data key from an app secret (deterministic — the same secret always yields
 * the same key, so previously sealed values remain openable across restarts). scrypt stretches
 * the secret to resist brute force. Derive once at startup and reuse via {@link SecretBox}.
 */
export function deriveKey(secret: string): Buffer {
  if (secret.length < 16) {
    throw new CryptoError('encryption secret must be at least 16 characters');
  }
  return scryptSync(secret, KDF_SALT, KEY_BYTES);
}

/** Seal a UTF-8 string into a self-describing envelope: `v1.gcm.<iv>.<tag>.<ciphertext>` (base64url). */
export function seal(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new CryptoError('key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, 'gcm', b64url(iv), b64url(tag), b64url(ciphertext)].join('.');
}

/** Open an envelope produced by {@link seal}. Throws {@link CryptoError} on any failure (never returns garbage). */
export function open(sealed: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new CryptoError('key must be 32 bytes');
  // A 5-segment envelope; the ciphertext segment may legitimately be empty (empty plaintext),
  // so guard on presence (undefined), not falsiness.
  const [version, scheme, ivB64, tagB64, ctB64] = sealed.split('.');
  if (
    version !== VERSION ||
    scheme !== 'gcm' ||
    ivB64 === undefined ||
    tagB64 === undefined ||
    ctB64 === undefined
  ) {
    throw new CryptoError('malformed or unsupported envelope');
  }
  const iv = fromB64url(ivB64);
  const tag = fromB64url(tagB64);
  const ciphertext = fromB64url(ctB64);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError('malformed envelope');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or tampered ciphertext — GCM verification failed. Opaque by design.
    throw new CryptoError('decryption failed');
  }
}

/**
 * A key held in memory, wrapping {@link seal}/{@link open}. Build it once from the app secret at
 * the composition root and inject it, so the secret is derived a single time and never re-read.
 */
export class SecretBox {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  /** Build a box from an app secret (derives the key via scrypt). */
  static fromSecret(secret: string): SecretBox {
    return new SecretBox(deriveKey(secret));
  }

  seal(plaintext: string): string {
    return seal(plaintext, this.#key);
  }

  open(sealed: string): string {
    return open(sealed, this.#key);
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}
