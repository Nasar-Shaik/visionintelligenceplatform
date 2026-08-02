import { describe, expect, it } from 'vitest';
import {
  allowedChildTypes,
  canContain,
  CreateOrgNodeInput,
  CreateTenantInput,
  ORG_NODE_PAGE_LIMIT,
  ORG_NODE_TYPES,
  orgNodeRank,
  OrgLocation,
  OrgNode,
  OrgNodeQuery,
  OrgNodeType,
  OrgTree,
  Tenant,
  TenantSlug,
  TenantStatus,
  UpdateOrgNodeInput,
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

describe('org hierarchy containment (P-3)', () => {
  it('orders the eight levels outermost-first', () => {
    expect(ORG_NODE_TYPES).toEqual([
      'org',
      'region',
      'country',
      'branch',
      'site',
      'building',
      'floor',
      'zone',
    ]);
    expect(ORG_NODE_TYPES.map(orgNodeRank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('covers exactly the enum — a new level cannot be added without an order for it', () => {
    expect([...ORG_NODE_TYPES].sort()).toEqual([...OrgNodeType.options].sort());
  });

  it('permits skipping levels but never inverting them', () => {
    expect(canContain('org', 'zone')).toBe(true);
    expect(canContain('site', 'zone')).toBe(true);
    expect(canContain('zone', 'site')).toBe(false);
    expect(canContain('site', 'site')).toBe(false);
  });

  it('derives the permitted children of every level', () => {
    expect(allowedChildTypes('branch')).toEqual(['site', 'building', 'floor', 'zone']);
    expect(allowedChildTypes('zone')).toEqual([]);
  });
});

describe('org node evolution (P-3, additive)', () => {
  it('defaults a node written before P-3 to active rather than rejecting it', () => {
    const legacy = {
      id: 'on_1',
      tenantId: 'tnt_1',
      parentId: null,
      type: 'org',
      name: 'Acme',
      path: [],
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    const parsed = OrgNode.parse(legacy);
    expect(parsed.status).toBe('active');
    expect(parsed.archivedAt).toBeUndefined();
  });

  it('refuses a type change through the update input — type is immutable', () => {
    expect(UpdateOrgNodeInput.safeParse({ name: 'London City' }).success).toBe(true);
    expect(UpdateOrgNodeInput.safeParse({ parentId: 'on_2' }).success).toBe(true);
    expect(UpdateOrgNodeInput.safeParse({}).success).toBe(false);
    // `type` is simply not a field here; a payload carrying it changes nothing.
    expect(UpdateOrgNodeInput.parse({ name: 'x', type: 'region' })).toEqual({ name: 'x' });
  });

  it('bounds every list request', () => {
    expect(OrgNodeQuery.parse({}).limit).toBe(ORG_NODE_PAGE_LIMIT);
    expect(OrgNodeQuery.safeParse({ limit: ORG_NODE_PAGE_LIMIT + 1 }).success).toBe(false);
    expect(OrgNodeQuery.parse({}).includeArchived).toBe(false);
  });
});

describe('resolved locations (P-3)', () => {
  const base = {
    id: 'on_9',
    tenantId: 'tnt_1',
    parentId: 'on_8',
    type: 'zone' as const,
    name: 'Lobby',
    path: ['on_1', 'on_8'],
    status: 'active' as const,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  };

  it('carries the ancestry the backend resolved', () => {
    const parsed = OrgLocation.parse({
      ...base,
      breadcrumb: [
        { id: 'on_1', type: 'org', name: 'Acme' },
        { id: 'on_8', type: 'site', name: 'London' },
      ],
      depth: 2,
      label: 'Acme › London › Lobby',
      allowedChildTypes: [],
      hasChildren: false,
    });
    expect(parsed.breadcrumb).toHaveLength(2);
    expect(parsed.label).toContain('Lobby');
  });

  it('describes places, never their occupants — the hierarchy holds no camera count', () => {
    const keys = Object.keys(OrgLocation.shape);
    for (const forbidden of ['cameraCount', 'cameras', 'deviceCount', 'assetCount']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('nests recursively into a tree', () => {
    const leaf = {
      ...base,
      breadcrumb: [],
      depth: 0,
      label: 'Lobby',
      allowedChildTypes: [],
      hasChildren: false,
      children: [],
    };
    const parsed = OrgTree.parse({
      roots: [{ ...leaf, hasChildren: true, children: [leaf] }],
      nodeCount: 2,
      orphaned: [],
      truncated: false,
    });
    expect(parsed.roots[0]?.children[0]?.id).toBe('on_9');
  });
});
