import { describe, expect, it } from 'vitest';
import {
  CreateUserInput,
  LoginInput,
  Principal,
  TokenPair,
  User,
  UserStatus,
} from '../src/auth/auth.js';
import { isKnownEventType } from '../src/events/catalog.js';

const now = '2026-07-28T00:00:00.000Z';

describe('User', () => {
  const valid = {
    id: 'usr_1',
    tenantId: 'tnt_1',
    email: 'a@b.com',
    roles: ['admin'],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  it('accepts a valid user and rejects a bad email', () => {
    expect(() => User.parse(valid)).not.toThrow();
    expect(() => User.parse({ ...valid, email: 'nope' })).toThrow();
  });

  it('status enum covers the account lifecycle', () => {
    expect(UserStatus.options).toEqual(['active', 'disabled', 'invited']);
  });
});

describe('CreateUserInput', () => {
  it('requires an 8+ char password', () => {
    expect(() => CreateUserInput.parse({ email: 'a@b.com', password: 'short' })).toThrow();
    expect(() => CreateUserInput.parse({ email: 'a@b.com', password: 'longenough' })).not.toThrow();
  });

  it('defaults roles to empty', () => {
    expect(CreateUserInput.parse({ email: 'a@b.com', password: 'longenough' }).roles).toEqual([]);
  });
});

describe('LoginInput', () => {
  it('requires a valid email + non-empty password', () => {
    expect(() => LoginInput.parse({ email: 'a@b.com', password: 'x' })).not.toThrow();
    expect(() => LoginInput.parse({ email: 'bad', password: 'x' })).toThrow();
    expect(() => LoginInput.parse({ email: 'a@b.com', password: '' })).toThrow();
  });
});

describe('TokenPair', () => {
  it('defaults tokenType Bearer and requires a positive expiresIn', () => {
    const p = TokenPair.parse({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
    expect(p.tokenType).toBe('Bearer');
    expect(() => TokenPair.parse({ accessToken: 'a', refreshToken: 'r', expiresIn: -1 })).toThrow();
  });
});

describe('Principal', () => {
  it('accepts a resolved principal', () => {
    expect(() =>
      Principal.parse({
        principalId: 'usr_1',
        tenantId: 'tnt_1',
        email: 'a@b.com',
        roles: ['admin'],
        permissions: ['user:read'],
        scopes: ['tenant'],
      }),
    ).not.toThrow();
  });
});

describe('auth events catalogued', () => {
  it('registers the auth lifecycle types', () => {
    for (const t of [
      'user.created',
      'auth.login.succeeded',
      'auth.token.refreshed',
      'auth.refresh.reused',
      'auth.logout',
    ])
      expect(isKnownEventType(t)).toBe(true);
  });
});
