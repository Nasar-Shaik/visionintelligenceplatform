/**
 * Hierarchy domain tests (P-3) — containment, traversal, movement, archival and scale.
 *
 * All pure: no store, no clock, no network. Every rule the estate enforces is decided by a function
 * in `domain/hierarchy.ts`, which is what lets these run in milliseconds and what will let a future
 * bulk import validate five thousand rows by calling the same functions in a loop.
 */
import { describe, expect, it } from 'vitest';
import { allowedChildTypes, canContain, ORG_NODE_TYPES, type OrgNodeType } from '@vip/contracts';
import {
  archiveError,
  buildTree,
  byId,
  containmentError,
  isActive,
  LABEL_SEPARATOR,
  moveError,
  movedPaths,
  parentsWithChildren,
  pathUnder,
  resolveLocation,
  restoreError,
} from '../src/domain/hierarchy.js';
import type { OrgNodeDoc } from '../src/domain/tenant.js';

const AT = '2026-08-02T00:00:00.000Z';

function node(
  id: string,
  type: OrgNodeType,
  parentId: string | null,
  path: string[],
  overrides: Partial<OrgNodeDoc> = {},
): OrgNodeDoc {
  return {
    _id: id,
    tenantId: 'tnt_1',
    parentId,
    type,
    name: id,
    path,
    depth: path.length,
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** org → region → site → zone, the shape most of these tests operate on. */
function estate(): OrgNodeDoc[] {
  return [
    node('org', 'org', null, []),
    node('emea', 'region', 'org', ['org']),
    node('london', 'site', 'emea', ['org', 'emea']),
    node('lobby', 'zone', 'london', ['org', 'emea', 'london']),
  ];
}

describe('containment', () => {
  it('accepts the canonical order, level by level', () => {
    for (let i = 1; i < ORG_NODE_TYPES.length; i += 1) {
      expect(containmentError(ORG_NODE_TYPES[i - 1]!, ORG_NODE_TYPES[i]!)).toBeNull();
    }
  });

  it('allows levels to be skipped — a one-building customer is not made to invent five', () => {
    expect(containmentError('org', 'site')).toBeNull();
    expect(containmentError('org', 'zone')).toBeNull();
    expect(containmentError('site', 'zone')).toBeNull();
  });

  it('never allows the order to be inverted', () => {
    expect(containmentError('floor', 'region')).toContain('cannot be placed under');
    expect(containmentError('zone', 'building')).toContain('cannot be placed under');
    expect(containmentError('site', 'country')).toContain('cannot be placed under');
  });

  it('refuses to nest a type inside itself — a site inside a site is not a hierarchy', () => {
    for (const type of ORG_NODE_TYPES) {
      expect(canContain(type, type)).toBe(false);
    }
  });

  it('requires the root to be an org, and an org to be a root', () => {
    expect(containmentError(null, 'org')).toBeNull();
    expect(containmentError(null, 'site')).toBe('a site requires a parent');
    expect(containmentError('org', 'org')).toBe('an org root must have a null parent');
  });

  it('names the whole hierarchy when it refuses, so the caller learns the rule', () => {
    expect(containmentError('zone', 'floor')).toContain('org → region → country → branch');
  });

  it('serves the permitted child types so no client re-implements the rule', () => {
    expect(allowedChildTypes('org')).toEqual(ORG_NODE_TYPES.slice(1));
    expect(allowedChildTypes('floor')).toEqual(['zone']);
    expect(allowedChildTypes('zone')).toEqual([]);
  });
});

describe('breadcrumbs', () => {
  it('resolves ancestry, depth and a rendered label from the materialized path', () => {
    const docs = estate();
    const lobby = resolveLocation(docs[3]!, byId(docs), false);

    expect(lobby.breadcrumb.map((c) => c.id)).toEqual(['org', 'emea', 'london']);
    expect(lobby.breadcrumb.map((c) => c.type)).toEqual(['org', 'region', 'site']);
    expect(lobby.depth).toBe(3);
    expect(lobby.label).toBe(['org', 'emea', 'london', 'lobby'].join(LABEL_SEPARATOR));
    expect(lobby.allowedChildTypes).toEqual([]);
    expect(lobby.hasChildren).toBe(false);
  });

  it('gives a root an empty breadcrumb and its own name as the label', () => {
    const docs = estate();
    const root = resolveLocation(docs[0]!, byId(docs), true);
    expect(root.breadcrumb).toEqual([]);
    expect(root.depth).toBe(0);
    expect(root.label).toBe('org');
    expect(root.hasChildren).toBe(true);
  });

  it('leaves a gap rather than inventing a name when an ancestor is missing', () => {
    const docs = estate();
    const partial = byId(docs.filter((d) => d._id !== 'emea'));
    const lobby = resolveLocation(docs[3]!, partial, false);
    expect(lobby.breadcrumb.map((c) => c.id)).toEqual(['org', 'london']);
  });

  it('follows the label after a rename — because the label is derived, never stored', () => {
    const docs = estate();
    docs[1]!.name = 'Europe';
    expect(resolveLocation(docs[3]!, byId(docs), false).label).toContain('Europe');
  });
});

describe('tree', () => {
  it('assembles a forest with children nested under their parents', () => {
    const { roots, nodeCount, orphaned } = buildTree(estate());
    expect(nodeCount).toBe(4);
    expect(orphaned).toEqual([]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe('org');
    expect(roots[0]!.children[0]!.id).toBe('emea');
    expect(roots[0]!.children[0]!.children[0]!.children[0]!.id).toBe('lobby');
  });

  it('reports a node whose parent is absent instead of promoting or dropping it', () => {
    const docs = estate().filter((d) => d._id !== 'emea');
    const { roots, orphaned } = buildTree(docs);
    expect(orphaned).toEqual(['london']);
    expect(roots.map((r) => r.id)).toEqual(['org']);
  });

  it('orders siblings by containment then naturally by name', () => {
    const docs = [
      node('org', 'org', null, []),
      node('z10', 'zone', 'org', ['org'], { name: 'Zone 10' }),
      node('z2', 'zone', 'org', ['org'], { name: 'Zone 2' }),
      node('site', 'site', 'org', ['org'], { name: 'Site' }),
    ];
    const { roots } = buildTree(docs);
    expect(roots[0]!.children.map((c) => c.name)).toEqual(['Site', 'Zone 2', 'Zone 10']);
  });

  it('marks which nodes have children so a tree renders without probing', () => {
    const docs = estate();
    expect(parentsWithChildren(docs)).toEqual(new Set(['org', 'emea', 'london']));
  });

  it('supports more than one root — a forest, not an assumed single org', () => {
    const { roots } = buildTree([node('a', 'org', null, []), node('b', 'org', null, [])]);
    expect(roots).toHaveLength(2);
  });
});

describe('movement', () => {
  it('refuses to move a node under itself', () => {
    const docs = estate();
    expect(moveError(docs[1]!, docs[1]!)).toBe('a node cannot be moved under itself');
  });

  it('refuses to move a node under its own descendant — the cycle case', () => {
    const docs = estate();
    expect(moveError(docs[1]!, docs[3]!)).toContain('its own descendants');
    expect(moveError(docs[0]!, docs[2]!)).toContain('its own descendants');
  });

  it('refuses a move that would invert the hierarchy', () => {
    const docs = estate();
    // A zone in a *different* branch, so containment is what refuses this rather than the cycle check.
    const parisZone = node('paris_zone', 'zone', 'paris', ['org', 'emea', 'paris']);
    expect(moveError(docs[2]!, parisZone)).toContain('cannot be placed under');
  });

  it('refuses to move a live location into an archived one', () => {
    const docs = estate();
    const retired = node('old', 'site', 'emea', ['org', 'emea'], { status: 'archived' });
    expect(moveError(docs[3]!, retired)).toContain('archived');
  });

  it('allows a legal move', () => {
    const docs = estate();
    const paris = node('paris', 'site', 'emea', ['org', 'emea']);
    expect(moveError(docs[3]!, paris)).toBeNull();
  });

  it('rewrites the whole subtree so it travels intact', () => {
    const london = node('london', 'site', 'emea', ['org', 'emea']);
    const floor = node('floor', 'floor', 'london', ['org', 'emea', 'london']);
    const lobby = node('lobby', 'zone', 'floor', ['org', 'emea', 'london', 'floor']);
    const apac = node('apac', 'region', 'org', ['org']);

    const rewrites = movedPaths(london, apac, [floor, lobby]);

    expect(rewrites).toEqual([
      { id: 'london', path: ['org', 'apac'], depth: 2 },
      { id: 'floor', path: ['org', 'apac', 'london'], depth: 3 },
      { id: 'lobby', path: ['org', 'apac', 'london', 'floor'], depth: 4 },
    ]);
  });

  it('keeps depth equal to path length for every rewritten node', () => {
    const london = node('london', 'site', 'emea', ['org', 'emea']);
    const deep = node('deep', 'zone', 'london', ['org', 'emea', 'london', 'x']);
    for (const r of movedPaths(london, node('root2', 'org', null, []), [deep])) {
      expect(r.depth).toBe(r.path.length);
    }
  });

  it('computes a child path from its parent without consulting the store', () => {
    expect(pathUnder(null)).toEqual([]);
    expect(pathUnder({ _id: 'london', path: ['org', 'emea'] })).toEqual(['org', 'emea', 'london']);
  });
});

describe('archival', () => {
  it('refuses to archive the organization root', () => {
    expect(archiveError(node('org', 'org', null, []))).toContain('root cannot be archived');
  });

  it('refuses to archive something already archived', () => {
    const retired = node('x', 'site', 'org', ['org'], { status: 'archived' });
    expect(archiveError(retired)).toContain('already archived');
  });

  it('allows archiving a non-root location', () => {
    expect(archiveError(node('x', 'site', 'org', ['org']))).toBeNull();
  });

  it('refuses to restore under an ancestor that is still archived', () => {
    const child = node('c', 'zone', 'p', ['org', 'p'], { status: 'archived' });
    const parent = node('p', 'site', 'org', ['org'], { status: 'archived', name: 'London' });
    expect(restoreError(child, [parent])).toContain('restore "London" first');
  });

  it('restores when every ancestor is live', () => {
    const child = node('c', 'zone', 'p', ['org', 'p'], { status: 'archived' });
    expect(restoreError(child, [node('p', 'site', 'org', ['org'])])).toBeNull();
  });

  it('refuses to restore something that is not archived', () => {
    expect(restoreError(node('c', 'zone', 'p', ['org', 'p']), [])).toContain('not archived');
  });

  it('treats a document written before P-3 as active rather than invalid', () => {
    const legacy = { ...node('x', 'site', 'org', ['org']) };
    delete legacy.status;
    expect(isActive(legacy)).toBe(true);
    expect(resolveLocation(legacy, byId([legacy]), false).status).toBe('active');
  });
});

describe('scale', () => {
  /**
   * A wide, deep estate assembled once. The assertion that matters is not the elapsed time — that
   * is machine-dependent — but that the work is a **single pass**: a recursive per-node parent walk
   * would be O(n·depth) here and would show up as a suite that quietly got slower, the same signal
   * that caught the runtime dialling real hostnames in AI-5.
   */
  function bigEstate(regions: number, sitesPer: number, zonesPer: number): OrgNodeDoc[] {
    const docs = [node('org', 'org', null, [])];
    for (let r = 0; r < regions; r += 1) {
      const region = `r${r}`;
      docs.push(node(region, 'region', 'org', ['org']));
      for (let s = 0; s < sitesPer; s += 1) {
        const site = `${region}_s${s}`;
        docs.push(node(site, 'site', region, ['org', region]));
        for (let z = 0; z < zonesPer; z += 1) {
          docs.push(node(`${site}_z${z}`, 'zone', site, ['org', region, site]));
        }
      }
    }
    return docs;
  }

  it('builds a 5,000-node estate in one pass', () => {
    const docs = bigEstate(20, 10, 24);
    expect(docs.length).toBeGreaterThan(5_000);

    const started = performance.now();
    const { roots, nodeCount, orphaned } = buildTree(docs);
    const elapsed = performance.now() - started;

    expect(nodeCount).toBe(docs.length);
    expect(orphaned).toEqual([]);
    expect(roots[0]!.children).toHaveLength(20);
    expect(roots[0]!.children[0]!.children[0]!.children).toHaveLength(24);
    // Generous: this exists to catch an accidental O(n²) walk, not to benchmark the host.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('answers "everything under this node" from the materialized path, not a walk', () => {
    const docs = bigEstate(5, 4, 5);
    const under = docs.filter((d) => d.path.includes('r2'));
    expect(under).toHaveLength(4 + 4 * 5);
    // The same predicate the store applies as an indexed multikey lookup on `path`.
    expect(under.every((d) => d._id.startsWith('r2'))).toBe(true);
  });

  it('rewrites a large subtree without recursion', () => {
    const docs = bigEstate(3, 4, 5);
    const region = docs.find((d) => d._id === 'r1')!;
    const descendants = docs.filter((d) => d.path.includes('r1'));
    const target = node('org2', 'org', null, []);

    const rewrites = movedPaths(region, target, descendants);

    expect(rewrites).toHaveLength(descendants.length + 1);
    expect(rewrites.every((r) => r.path[0] === 'org2')).toBe(true);
    expect(rewrites.every((r) => r.depth === r.path.length)).toBe(true);
  });
});

describe('bulk-operation readiness', () => {
  /**
   * No bulk import exists yet (P-3 rec 5). What these assert is that nothing built now *prevents*
   * one: every rule is a pure function of a candidate and its parent, so validating ten thousand
   * rows is a loop over the same functions — no per-row store round-trip, no hidden state, no
   * ordering requirement between rows beyond parents existing first.
   */
  it('validates a whole import in one pass with no store access', () => {
    const rows: Array<{ parent: OrgNodeType | null; child: OrgNodeType }> = [
      { parent: null, child: 'org' },
      { parent: 'org', child: 'region' },
      { parent: 'region', child: 'site' },
      { parent: 'site', child: 'building' },
      { parent: 'zone', child: 'floor' },
    ];
    const errors = rows.map((row) => containmentError(row.parent, row.child));
    expect(errors.filter(Boolean)).toHaveLength(1);
    expect(errors[4]).toContain('cannot be placed under');
  });

  it('computes every path in a bulk create from parents alone', () => {
    const org = node('org', 'org', null, []);
    const region = { _id: 'r', path: pathUnder(org) };
    const site = { _id: 's', path: pathUnder(region) };
    expect(pathUnder(site)).toEqual(['org', 'r', 's']);
  });

  it('produces a bulk move as data, so it can be written in one operation', () => {
    const docs = estate();
    const rewrites = movedPaths(docs[2]!, docs[0]!, [docs[3]!]);
    expect(rewrites.every((r) => typeof r.id === 'string' && Array.isArray(r.path))).toBe(true);
  });
});

describe('subtree reads', () => {
  it('treats a declared root as a root, so a subtree is a tree and not a pile of orphans', () => {
    const docs = estate().filter((d) => d._id !== 'org');
    expect(buildTree(docs).orphaned).toEqual(['emea']);

    const { roots, orphaned } = buildTree(docs, { rootIds: ['emea'] });
    expect(orphaned).toEqual([]);
    expect(roots.map((r) => r.id)).toEqual(['emea']);
    expect(roots[0]!.children[0]!.id).toBe('london');
  });
});
