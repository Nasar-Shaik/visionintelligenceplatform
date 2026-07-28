/**
 * Password hashing with Node's built-in **scrypt** (a memory-hard KDF) — no native build, no new
 * runtime dependency (consistent with the project's dependency ethos, ED-0022). Hashes are stored
 * as a self-describing PHC-like string so parameters can evolve without a migration:
 *   `scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>`
 * argon2id would be a valid alternative but ships as a native addon; revisit only if required.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 16384; // CPU/memory cost (2^14)
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024; // 64 MiB headroom (scrypt needs ~128*N*r ≈ 16 MiB)

/** Hash a plaintext password. Returns a self-describing PHC-like string safe to persist. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Verify a plaintext password against a stored hash, in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, nStr, rStr, pStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !nStr || !rStr || !pStr || !saltB64 || !hashB64) return false;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
