import { describe, expect, it } from 'vitest';
import { TenancyError } from '../src/errors.js';
import { TenantScope } from '../src/scope.js';
import {
  assertOwned,
  guardUpdate,
  scopedFilter,
  scopedInsert,
  scopedPipeline,
} from '../src/guard.js';

const A = TenantScope.fromTenantId('tenant-a');
const B = TenantScope.fromTenantId('tenant-b');

describe('TenantScope (fail-closed construction)', () => {
  it('rejects missing/blank tenant ids', () => {
    for (const bad of [undefined, null, '', '   ']) {
      expect(() => TenantScope.fromTenantId(bad as string)).toThrow(TenancyError);
    }
  });

  it('rejects a context without a tenantId', () => {
    expect(() => TenantScope.fromContext(null)).toThrow(TenancyError);
    expect(() => TenantScope.fromContext({ tenantId: '' })).toThrow(TenancyError);
  });

  it('accepts a valid context', () => {
    expect(TenantScope.fromContext({ tenantId: 'tenant-a' }).tenantId).toBe('tenant-a');
  });
});

describe('scopedFilter', () => {
  it('injects tenantId into an empty filter', () => {
    expect(scopedFilter(A)).toEqual({ tenantId: 'tenant-a' });
  });

  it('preserves other predicates and adds tenantId', () => {
    expect(scopedFilter(A, { status: 'active' })).toEqual({
      status: 'active',
      tenantId: 'tenant-a',
    });
  });

  it('allows a matching tenantId', () => {
    expect(scopedFilter(A, { tenantId: 'tenant-a' })).toEqual({ tenantId: 'tenant-a' });
  });

  it('refuses a filter targeting another tenant (fail-closed)', () => {
    expect(() => scopedFilter(A, { tenantId: 'tenant-b' })).toThrow(TenancyError);
  });
});

describe('scopedInsert', () => {
  it('stamps tenantId onto a new document', () => {
    expect(scopedInsert(A, { name: 'x' })).toEqual({ name: 'x', tenantId: 'tenant-a' });
  });

  it('allows a document already stamped with the same tenant', () => {
    expect(scopedInsert(A, { name: 'x', tenantId: 'tenant-a' })).toEqual({
      name: 'x',
      tenantId: 'tenant-a',
    });
  });

  it('refuses a document belonging to another tenant (fail-closed)', () => {
    expect(() => scopedInsert(A, { name: 'x', tenantId: 'tenant-b' })).toThrow(TenancyError);
  });
});

describe('guardUpdate', () => {
  it('allows updates that do not touch tenantId', () => {
    expect(() => guardUpdate(A, { $set: { name: 'y' } })).not.toThrow();
  });

  it('allows $set of the same tenantId', () => {
    expect(() => guardUpdate(A, { $set: { tenantId: 'tenant-a' } })).not.toThrow();
  });

  it('refuses reassigning tenantId via $set', () => {
    expect(() => guardUpdate(A, { $set: { tenantId: 'tenant-b' } })).toThrow(TenancyError);
  });

  it('refuses reassigning tenantId via $setOnInsert', () => {
    expect(() => guardUpdate(A, { $setOnInsert: { tenantId: 'tenant-b' } })).toThrow(TenancyError);
  });

  it('refuses removing tenantId via $unset', () => {
    expect(() => guardUpdate(A, { $unset: { tenantId: '' } })).toThrow(TenancyError);
  });

  it('refuses a replacement-style update that changes tenantId', () => {
    expect(() => guardUpdate(A, { tenantId: 'tenant-b', name: 'y' })).toThrow(TenancyError);
  });
});

describe('assertOwned', () => {
  it('passes for a record of the same tenant and ignores null', () => {
    expect(() => assertOwned(A, { tenantId: 'tenant-a' })).not.toThrow();
    expect(() => assertOwned(A, null)).not.toThrow();
  });

  it('refuses a record of another tenant (fail-closed)', () => {
    expect(() => assertOwned(A, { tenantId: 'tenant-b' })).toThrow(TenancyError);
  });
});

describe('scopedPipeline', () => {
  it('prepends a leading tenant $match', () => {
    expect(scopedPipeline(B, [{ $group: { _id: '$type' } }])).toEqual([
      { $match: { tenantId: 'tenant-b' } },
      { $group: { _id: '$type' } },
    ]);
  });
});
