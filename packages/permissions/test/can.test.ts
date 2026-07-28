import { describe, expect, it } from 'vitest';
import { can, patternMatches, permissionsForRoles, principalCan } from '../src/can.js';
import { ROLES, isRole } from '../src/model.js';

describe('patternMatches (wildcards)', () => {
  it('exact + global wildcard', () => {
    expect(patternMatches('user:read', 'user:read')).toBe(true);
    expect(patternMatches('*', 'anything:goes')).toBe(true);
  });

  it('resource wildcard covers any action on that resource', () => {
    expect(patternMatches('user:*', 'user:read')).toBe(true);
    expect(patternMatches('user:*', 'user:delete')).toBe(true);
    expect(patternMatches('user:*', 'camera:read')).toBe(false);
  });

  it('action wildcard covers any resource for that action', () => {
    expect(patternMatches('*:read', 'camera:read')).toBe(true);
    expect(patternMatches('*:read', 'camera:write')).toBe(false);
  });

  it('a scopeless grant covers a scoped requirement, not vice-versa', () => {
    expect(patternMatches('user:read', 'user:read:tenant')).toBe(true);
    expect(patternMatches('user:read:tenant', 'user:read')).toBe(false);
  });
});

describe('can (deny-by-default)', () => {
  it('grants only what a pattern covers', () => {
    expect(can(['user:*', 'camera:read'], 'user:delete')).toBe(true);
    expect(can(['user:*', 'camera:read'], 'camera:delete')).toBe(false);
    expect(can([], 'user:read')).toBe(false);
  });
});

describe('roles', () => {
  it('the catalog is well-formed', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'operator', 'viewer']);
    expect(isRole('admin')).toBe(true);
    expect(isRole('wizard')).toBe(false);
  });

  it('viewer reads but cannot write; owner does everything', () => {
    expect(can(permissionsForRoles(['viewer']), 'camera:read')).toBe(true);
    expect(can(permissionsForRoles(['viewer']), 'camera:delete')).toBe(false);
    expect(can(permissionsForRoles(['owner']), 'anything:goes')).toBe(true);
  });

  it('operator can ack incidents but not manage users', () => {
    expect(can(permissionsForRoles(['operator']), 'incident:ack')).toBe(true);
    expect(can(permissionsForRoles(['operator']), 'user:create')).toBe(false);
  });

  it('admin manages users', () => {
    expect(can(permissionsForRoles(['admin']), 'user:create')).toBe(true);
  });

  it('stream control: admin + operator can control; viewer only reads', () => {
    expect(can(permissionsForRoles(['admin']), 'stream:control')).toBe(true);
    expect(can(permissionsForRoles(['operator']), 'stream:control')).toBe(true);
    expect(can(permissionsForRoles(['operator']), 'stream:read')).toBe(true);
    expect(can(permissionsForRoles(['viewer']), 'stream:read')).toBe(true);
    expect(can(permissionsForRoles(['viewer']), 'stream:control')).toBe(false);
  });

  it('unknown roles contribute nothing', () => {
    expect(permissionsForRoles(['wizard'])).toEqual([]);
  });
});

describe('principalCan', () => {
  it('combines role-derived and explicit permissions', () => {
    expect(principalCan({ roles: ['viewer'] }, 'user:read')).toBe(true);
    expect(principalCan({ roles: ['viewer'] }, 'user:create')).toBe(false);
    expect(principalCan({ roles: ['viewer'], permissions: ['user:create'] }, 'user:create')).toBe(
      true,
    );
    expect(principalCan({}, 'user:read')).toBe(false);
  });
});
