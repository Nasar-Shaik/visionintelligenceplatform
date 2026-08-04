import { describe, expect, it } from 'vitest';
import {
  applyTenantUpdate,
  newOrgNode,
  newOrgRoot,
  newTenant,
  toOrgNode,
  toTenant,
} from '../src/domain/tenant.js';

const at = new Date('2026-07-28T00:00:00.000Z');
const later = new Date('2026-07-28T01:00:00.000Z');

describe('newTenant', () => {
  it('starts in provisioning with tenantId mirroring the id (Law 5)', () => {
    const t = newTenant({ slug: 'acme', name: 'Acme' }, 'tnt_1', at);
    expect(t).toMatchObject({
      _id: 'tnt_1',
      tenantId: 'tnt_1',
      status: 'provisioning',
      slug: 'acme',
    });
    expect(t.createdAt).toBe(at.toISOString());
  });
});

describe('newOrgRoot / newOrgNode', () => {
  it('root has a null parent and empty path', () => {
    const r = newOrgRoot('tnt_1', 'Acme', 'on_root', at);
    expect(r).toMatchObject({
      _id: 'on_root',
      tenantId: 'tnt_1',
      parentId: null,
      type: 'org',
      path: [],
    });
  });

  it('child materializes path = parent.path + parent id', () => {
    const root = newOrgRoot('tnt_1', 'Acme', 'on_root', at);
    const site = newOrgNode(
      'tnt_1',
      { type: 'site', name: 'HQ', parentId: 'on_root' },
      root,
      'on_site',
      at,
    );
    expect(site.path).toEqual(['on_root']);
    const floor = newOrgNode(
      'tnt_1',
      { type: 'floor', name: 'L1', parentId: 'on_site' },
      site,
      'on_floor',
      at,
    );
    expect(floor.path).toEqual(['on_root', 'on_site']);
  });
});

describe('applyTenantUpdate', () => {
  it('applies name/status and bumps updatedAt', () => {
    const t = newTenant({ slug: 'acme', name: 'Acme' }, 'tnt_1', at);
    const updated = applyTenantUpdate(t, { name: 'Acme Inc', status: 'suspended' }, later);
    expect(updated.name).toBe('Acme Inc');
    expect(updated.status).toBe('suspended');
    expect(updated.updatedAt).toBe(later.toISOString());
    expect(updated.createdAt).toBe(at.toISOString());
  });

  /**
   * ⚠️ **`updatedAt` must strictly increase, because P-6.3 made it the concurrency token.**
   *
   * Found by a frozen clock: every write produced an identical timestamp, so a stale
   * `expectedUpdatedAt` still matched and the second administrator silently overwrote the first —
   * the exact failure the check exists to prevent. In production the window is one millisecond
   * rather than always, which makes it rarer and no less real.
   */
  it('advances updatedAt even when the clock has not moved', () => {
    const t = newTenant({ slug: 'acme', name: 'Acme' }, 'tnt_1', at);
    const first = applyTenantUpdate(t, { name: 'One' }, at);
    expect(first.updatedAt).not.toBe(t.updatedAt);

    const second = applyTenantUpdate(first, { name: 'Two' }, at);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
  });

  it('uses the wall clock when it has moved on, rather than drifting forward forever', () => {
    // The nudge is a floor, not an increment — it must not make `updatedAt` run away from real time.
    const t = newTenant({ slug: 'acme', name: 'Acme' }, 'tnt_1', at);
    const updated = applyTenantUpdate(t, { name: 'Later' }, later);
    expect(updated.updatedAt).toBe(later.toISOString());
  });
});

describe('mappers', () => {
  it('toTenant exposes id (no _id/tenantId leak)', () => {
    const t = toTenant(newTenant({ slug: 'acme', name: 'Acme' }, 'tnt_1', at));
    expect(t).toEqual({
      id: 'tnt_1',
      slug: 'acme',
      name: 'Acme',
      status: 'provisioning',
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    });
    expect('_id' in t).toBe(false);
  });

  it('toOrgNode exposes id + tenantId', () => {
    const n = toOrgNode(newOrgRoot('tnt_1', 'Acme', 'on_root', at));
    expect(n.id).toBe('on_root');
    expect(n.tenantId).toBe('tnt_1');
  });
});
