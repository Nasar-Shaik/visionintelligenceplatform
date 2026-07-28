/**
 * Secret-vaulting configuration group. Supplies the app secret from which `@vip/crypto` derives
 * the at-rest data key (camera credentials in P1-3; connector secrets later). `.env` is the ONLY
 * source (ADR-0018) — no external KMS. `CREDENTIAL_ENCRYPTION_KEY` has no default: a service that
 * vaults secrets must fail fast if it is missing, and it must be ≥16 chars (high-entropy).
 */
import { z } from 'zod';
import { parseEnv } from './validate.js';

export interface CryptoConfig {
  /** App secret used to derive the at-rest encryption key (scrypt). Keep stable; rotating it orphans existing ciphertext. */
  encryptionKey: string;
}

export function loadCryptoConfig(env: NodeJS.ProcessEnv = process.env): CryptoConfig {
  const c = parseEnv(
    z.object({
      CREDENTIAL_ENCRYPTION_KEY: z
        .string()
        .min(16, 'CREDENTIAL_ENCRYPTION_KEY must be at least 16 characters'),
    }),
    env,
    'crypto',
  );
  return { encryptionKey: c.CREDENTIAL_ENCRYPTION_KEY };
}
