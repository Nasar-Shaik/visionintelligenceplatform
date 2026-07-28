import { describe, expect, it } from 'vitest';
import {
  CreateOrgNodeInput,
  CreateTenantInput,
  OrgNode,
  OrgNodeType,
  Tenant,
  TenantSlug,
  TenantStatus,
  UpdateTenantInput,
} from '../src/tenant/tenant.js';
import { EVENT_CATALOG, isKnownEventType } from '../src/events/catalog.js';

const now = '2026-07-28T00:00:00.000Z';

describe('TenantSlug', () => {
  it('accepts dns-safe slugs', () => {
    for (const s of ['acme', 'acme-corp', 'a1b2', 'shop-42-west'])
      expect(() => TenantSlug.parse(s)).not.toThrow();
  });

  it('rejects invalid slugs', () => {
    for (const s of ['Ac', 'ab', '-lead', 'trail-', 'has_underscore', 'UPPER', 'a'.repeat(41)])
      expect(() => TenantSlug.parse(s)).toThrow();
  });
});

describe('Tenant', () => {
  const valid = {
    id: 'tnt_1',
    slug: 'acme',
    name: 'Acme Corp',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  it('accepts a valid tenant', () => {
    expect(() => Tenant.parse(valid)).not.toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() => Tenant.parse({ ...valid, status: 'archived' })).toThrow();
  });

  it('status enum matches the documented lifecycle', () => {
    expect(TenantStatus.options).toEqual(['provisioning', 'active', 'suspended', 'deprovisioning']);
  });
});

describe('CreateTenantInput', () => {
  it('accepts slug + name only', () => {
    expect(() => CreateTenantInput.parse({ slug: 'acme', name: 'Acme' })).not.toThrow();
  });

  it('rejects an empty name', () => {
    expect(() => CreateTenantInput.parse({ slug: 'acme', name: '' })).toThrow();
  });
});

describe('UpdateTenantInput', () => {
  it('requires at least one field', () => {
    expect(() => UpdateTenantInput.parse({})).toThrow();
    expect(() => UpdateTenantInput.parse({ name: 'New' })).not.toThrow();
    expect(() => UpdateTenantInput.parse({ status: 'suspended' })).not.toThrow();
  });
});

describe('OrgNode', () => {
  const root = {
    id: 'org_root',
    tenantId: 'tnt_1',
    parentId: null,
    type: 'org',
    name: 'Acme',
    path: [],
    createdAt: now,
    updatedAt: now,
  };

  it('accepts an org root with null parent', () => {
    expect(() => OrgNode.parse(root)).not.toThrow();
  });

  it('accepts a child with a materialized path', () => {
    expect(() =>
      OrgNode.parse({
        ...root,
        id: 'site_1',
        parentId: 'org_root',
        type: 'site',
        path: ['org_root'],
      }),
    ).not.toThrow();
  });

  it('org node types cover the documented hierarchy (excluding camera leaf)', () => {
    expect(OrgNodeType.options).toEqual([
      'org',
      'region',
      'country',
      'branch',
      'site',
      'building',
      'floor',
      'zone',
    ]);
  });

  it('CreateOrgNodeInput allows a null parent for the root', () => {
    expect(() =>
      CreateOrgNodeInput.parse({ type: 'org', name: 'Acme', parentId: null }),
    ).not.toThrow();
  });
});

describe('tenant lifecycle events are catalogued', () => {
  it('registers tenant + org lifecycle types', () => {
    for (const t of [
      'tenant.created',
      'tenant.activated',
      'tenant.suspended',
      'tenant.deprovisioned',
      'org.node.created',
    ])
      expect(isKnownEventType(t)).toBe(true);
  });

  it('tenant.created is high priority', () => {
    expect(EVENT_CATALOG.find((e) => e.type === 'tenant.created')?.defaultPriority).toBe('high');
  });
});
