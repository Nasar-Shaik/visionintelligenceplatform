import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';
import { signAccessToken, verifyAccessToken } from '../src/jwt.js';
import { generateRefreshToken, hashRefreshToken } from '../src/refresh.js';
import { parseDurationSeconds } from '../src/duration.js';
import { AuthError } from '../src/errors.js';

const opts = { secret: 'test-secret-at-least-16-chars', accessTtl: '15m' };
const claims = { principalId: 'usr_1', tenantId: 'tnt_1', email: 'a@b.com', roles: ['admin'] };

describe('password (scrypt)', () => {
  it('hashes to a self-describing string and verifies', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('salts — same password hashes differently each time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects a malformed stored hash without throwing', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false);
  });
});

describe('access token (jose HS256)', () => {
  it('round-trips claims', async () => {
    const { token, expiresIn } = await signAccessToken(claims, opts);
    expect(expiresIn).toBe(900);
    const decoded = await verifyAccessToken(token, opts);
    expect(decoded).toMatchObject({ principalId: 'usr_1', tenantId: 'tnt_1', email: 'a@b.com' });
    expect(decoded.roles).toEqual(['admin']);
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await signAccessToken(claims, opts);
    await expect(
      verifyAccessToken(token, { ...opts, secret: 'another-secret-16chars' }),
    ).rejects.toThrow(AuthError);
  });

  it('rejects an expired token', async () => {
    const { token } = await signAccessToken(claims, { ...opts, accessTtl: '0s' });
    await new Promise((r) => setTimeout(r, 1100));
    await expect(verifyAccessToken(token, opts)).rejects.toThrow(AuthError);
  });

  it('rejects garbage', async () => {
    await expect(verifyAccessToken('not.a.jwt', opts)).rejects.toThrow(AuthError);
  });
});

describe('refresh tokens', () => {
  it('are unique and stored only as a hash', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(hashRefreshToken(a)).toHaveLength(64); // sha256 hex
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a)); // deterministic
    expect(hashRefreshToken(a)).not.toBe(hashRefreshToken(b));
  });
});

describe('parseDurationSeconds', () => {
  it('parses units and bare seconds', () => {
    expect(parseDurationSeconds('900s')).toBe(900);
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('1h')).toBe(3600);
    expect(parseDurationSeconds('7d')).toBe(604800);
    expect(parseDurationSeconds('30')).toBe(30);
  });

  it('throws on nonsense', () => {
    expect(() => parseDurationSeconds('soon')).toThrow();
  });
});
