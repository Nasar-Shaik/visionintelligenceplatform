/**
 * Hierarchy invariants and structural guarantees (Architect recommendations 3, 4, 5, 7, 11, 13).
 *
 * These are the **architectural laws** of the location hierarchy, written as tests because a law
 * recorded only in prose is a law nobody finds out has been broken. Each `describe` below is one
 * invariant, stated in the terms it would be violated in.
 */
import { describe, expect, it } from 'vitest';
import { ORG_NODE_TYPES, canContain, orgNodeRank, type OrgNodeType } from '@vip/contracts';
import {
  buildTree,
  byId,
  containmentError,
  movedPaths,
  moveError,
  pathUnder,
  resolveLocation,
} from '../src/domain/hierarchy.js';
import * as hierarchy from '../src/domain/hierarchy.js';
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

/** A full eight-level estate — the deepest the containment rules permit. */
function fullDepthEstate(): OrgNodeDoc[] {
  const docs: OrgNodeDoc[] = [];
  const path: string[] = [];
  let parent: string | null = null;
  for (const type of ORG_NODE_TYPES) {
    docs.push(node(type, type, parent, [...path]));
    path.push(type);
    parent = type;
  }
  return docs;
}

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * Recommendation 5 — the structural traversal guarantee.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe('traversal is structurally bounded (rec 5)', () => {
  /**
   * The load-bearing proof, and it is a *consequence of containment* rather than a convention.
   *
   * `canContain` requires the parent's rank to be strictly less than the child's. Any root-to-leaf
   * chain therefore has strictly increasing ranks drawn from eight values, so **no chain can exceed
   * eight nodes and no depth can exceed seven** — whatever a customer, an import or a bug attempts.
   *
   * Every recursive function in the module recurses over tree *depth*, so this bound is what makes
   * recursion safe here rather than a stack overflow waiting for a large estate. A hierarchy without
   * this rule would need every walk rewritten iteratively; this one does not.
   */
  it('containment caps depth at 7, so no traversal can recurse deeper', () => {
    const estate = fullDepthEstate();
    expect(estate).toHaveLength(8);
    expect(estate.at(-1)!.depth).toBe(7);

    // No legal parent exists for a ninth level: the leaf type contains nothing.
    for (const type of ORG_NODE_TYPES) {
      expect(canContain('zone', type)).toBe(false);
    }
    // And every legal placement strictly increases rank, so a chain can never revisit a level.
    for (const parent of ORG_NODE_TYPES) {
      for (const child of ORG_NODE_TYPES) {
        if (canContain(parent, child))
          expect(orgNodeRank(child)).toBeGreaterThan(orgNodeRank(parent));
      }
    }
  });

  it('builds a full-depth estate without approaching a stack limit', () => {
    const { roots } = buildTree(fullDepthEstate());
    let depth = 0;
    let cursor = roots[0];
    while (cursor?.children[0]) {
      cursor = cursor.children[0];
      depth += 1;
    }
    expect(depth).toBe(7);
  });

  /**
   * No function walks parents. Ancestry is read from the materialized `path` in a single pass — the
   * difference between O(1) queries and O(depth) queries per node, and the difference between a
   * breadcrumb that costs nothing and one that costs a round trip per level.
   */
  it('resolves ancestry from the stored path, never by following parentId', () => {
    const estate = fullDepthEstate();
    const lookup = byId(estate);
    const leaf = estate.at(-1)!;

    let reads = 0;
    const counting = new Map(lookup);
    const original = counting.get.bind(counting);
    counting.get = (key: string) => {
      reads += 1;
      return original(key);
    };

    const resolved = resolveLocation(leaf, counting, false);
    expect(resolved.breadcrumb).toHaveLength(7);
    // Exactly one lookup per ancestor. A parentId walk would be the same count but seven round trips.
    expect(reads).toBe(7);
  });

  it('exposes no function that takes a parent-fetcher — a walk cannot be written accidentally', () => {
    // Every export is a pure function of documents already in hand; none can issue a read.
    const exported = Object.entries(hierarchy).filter(([, v]) => typeof v === 'function');
    expect(exported.length).toBeGreaterThan(5);
    for (const [name, fn] of exported) {
      const source = (fn as (...args: unknown[]) => unknown).toString();
      expect(source, `${name} must not await`).not.toContain('await ');
      expect(source, `${name} must not be async`).not.toMatch(/^async/);
    }
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * Recommendation 3 — integrity after moving large subtrees, at every level.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe('subtree moves preserve integrity at every level (rec 3)', () => {
  /** org → region → country → branch → site → building → floor → zone, with breadth at each level. */
  function estate(): OrgNodeDoc[] {
    const docs = [node('org', 'org', null, [])];
    const add = (id: string, type: OrgNodeType, parent: string, parentPath: string[]) => {
      docs.push(node(id, type, parent, parentPath));
      return [...parentPath, id];
    };
    const emea = add('emea', 'region', 'org', ['org']);
    const apac = add('apac', 'region', 'org', ['org']);
    const uk = add('uk', 'country', 'emea', emea);
    add('fr', 'country', 'emea', emea);
    const north = add('north', 'branch', 'uk', uk);
    add('south', 'branch', 'uk', uk);
    const london = add('london', 'site', 'north', north);
    const tower = add('tower', 'building', 'london', london);
    const f3 = add('f3', 'floor', 'tower', tower);
    add('lobby', 'zone', 'f3', f3);
    add('atrium', 'zone', 'f3', f3);
    // A second APAC-side site so the move target is real.
    add('sydney', 'site', 'apac', apac);
    return docs;
  }

  /**
   * The integrity check applied after every move: ancestry, breadcrumbs, materialized paths,
   * descendants and references all agree with each other and with the tree.
   */
  function assertIntegrity(docs: OrgNodeDoc[]): void {
    const lookup = byId(docs);
    for (const doc of docs) {
      // depth is exactly the path length
      expect(doc.depth, `${doc._id}: depth must equal path length`).toBe(doc.path.length);

      // the path's last element is the parent, and a root has an empty path
      if (doc.parentId === null) expect(doc.path).toEqual([]);
      else expect(doc.path.at(-1), `${doc._id}: path must end at its parent`).toBe(doc.parentId);

      // every ancestor exists, and the path is the parent's path plus the parent
      const parent = doc.parentId ? lookup.get(doc.parentId) : null;
      if (parent) expect(doc.path).toEqual([...parent.path, parent._id]);
      for (const ancestorId of doc.path) expect(lookup.has(ancestorId)).toBe(true);

      // no node is its own ancestor
      expect(doc.path).not.toContain(doc._id);

      // containment still holds
      expect(containmentError(parent?.type ?? null, doc.type)).toBeNull();

      // the breadcrumb matches the path exactly
      const resolved = resolveLocation(doc, lookup, false);
      expect(resolved.breadcrumb.map((c) => c.id)).toEqual(doc.path);
      expect(resolved.depth).toBe(doc.path.length);
    }

    // and the whole thing still assembles into one tree with no orphans
    const { orphaned, nodeCount } = buildTree(docs);
    expect(orphaned).toEqual([]);
    expect(nodeCount).toBe(docs.length);
  }

  /** Apply a move the way the service does: rewrite the node and every descendant, then re-link. */
  function applyMove(docs: OrgNodeDoc[], nodeId: string, parentId: string): OrgNodeDoc[] {
    const lookup = byId(docs);
    const moving = lookup.get(nodeId)!;
    const target = lookup.get(parentId)!;
    expect(moveError(moving, target)).toBeNull();

    const descendants = docs.filter((d) => d.path.includes(nodeId));
    const rewrites = new Map(movedPaths(moving, target, descendants).map((r) => [r.id, r]));

    return docs.map((doc) => {
      const rewrite = rewrites.get(doc._id);
      if (!rewrite) return doc;
      return {
        ...doc,
        path: rewrite.path,
        depth: rewrite.depth,
        ...(doc._id === nodeId ? { parentId: target._id } : {}),
      };
    });
  }

  it('starts from an estate that is already consistent', () => {
    assertIntegrity(estate());
  });

  it.each([
    ['a zone', 'lobby', 'tower'],
    ['a floor', 'f3', 'london'],
    ['a building', 'tower', 'sydney'],
    ['a site', 'london', 'apac'],
    ['a branch', 'north', 'fr'],
    ['a country', 'uk', 'apac'],
    ['a region', 'emea', 'org'],
  ])('moves %s and leaves every invariant intact', (_label, nodeId, parentId) => {
    const before = estate();
    const after = applyMove(before, nodeId, parentId);
    assertIntegrity(after);

    // ids are untouched — every reference in the platform still resolves
    expect(after.map((d) => d._id).sort()).toEqual(before.map((d) => d._id).sort());
    // the subtree travelled intact: the same descendants, still beneath the moved node
    const descendantsBefore = before.filter((d) => d.path.includes(nodeId)).map((d) => d._id);
    const descendantsAfter = after.filter((d) => d.path.includes(nodeId)).map((d) => d._id);
    expect(descendantsAfter).toEqual(descendantsBefore);
  });

  it('survives a chain of moves without drift', () => {
    let docs = estate();
    docs = applyMove(docs, 'lobby', 'tower');
    docs = applyMove(docs, 'tower', 'sydney');
    docs = applyMove(docs, 'sydney', 'emea');
    assertIntegrity(docs);

    // The zone is still under the building, which is still under the site, wherever the site went.
    const lookup = byId(docs);
    expect(lookup.get('lobby')!.path).toEqual(['org', 'emea', 'sydney', 'tower']);
    expect(lookup.get('lobby')!.depth).toBe(4);
  });

  /**
   * ⚠️ **30 s, and the number is about the machine rather than the code.**
   *
   * This asserts 10,000 paths are correct after a move; it is a *correctness* test at scale and
   * carries no performance budget — nothing here asserts a duration. It ran in ~2 s alone and
   * **6.2 s during `pnpm turbo lint typecheck test`**, where eleven packages compile and test at
   * once, so vitest's 5 s default failed the whole gate on a busy laptop. That reports machine load
   * as a product defect, which trains everyone to re-run the gate instead of reading it.
   *
   * ⛔ A real slowdown still fails, five times later. What this removes is the suite's ability to
   * say "this feature is broken" when what happened is "this machine was busy". Diagnosed in slice
   * 2.8 after the same failure had twice been recorded as an unexplained flake.
   */
  it('moves a 10,000-node subtree with every path still correct', { timeout: 30_000 }, () => {
    const docs: OrgNodeDoc[] = [
      node('org', 'org', null, []),
      node('a', 'region', 'org', ['org']),
      node('b', 'region', 'org', ['org']),
      node('site', 'site', 'a', ['org', 'a']),
    ];
    for (let i = 0; i < 10_000; i += 1) {
      docs.push(node(`z${i}`, 'zone', 'site', ['org', 'a', 'site']));
    }
    const after = applyMove(docs, 'site', 'b');

    expect(after.filter((d) => d.type === 'zone')).toHaveLength(10_000);
    for (const zone of after.filter((d) => d.type === 'zone')) {
      expect(zone.path).toEqual(['org', 'b', 'site']);
      expect(zone.depth).toBe(3);
    }
    assertIntegrity(after);
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * Recommendations 4 & 11 — historical integrity.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe('historical integrity (rec 4, 11)', () => {
  const org = node('org', 'org', null, [], { name: 'Acme' });
  const zoneA = node('zoneA', 'zone', 'org', ['org'], { name: 'Zone A' });
  const zoneB = node('zoneB', 'zone', 'org', ['org'], { name: 'Zone B' });

  it('a rename invalidates no id, no reference and no link', () => {
    const renamed = { ...zoneA, name: 'Reception' };
    expect(renamed._id).toBe(zoneA._id);
    expect(renamed.path).toEqual(zoneA.path);
    expect(renamed.parentId).toBe(zoneA.parentId);
    // An evidence record holding `zoneA` resolves to the same node, with the new label.
    expect(resolveLocation(renamed, byId([org, renamed]), false).label).toBe('Acme › Reception');
  });

  it('an archive invalidates no id and still resolves in full', () => {
    const archived = { ...zoneA, status: 'archived' as const, archivedAt: AT };
    const resolved = resolveLocation(archived, byId([org, archived]), false);
    expect(resolved.id).toBe('zoneA');
    expect(resolved.label).toBe('Acme › Zone A');
    expect(resolved.status).toBe('archived');
  });

  it('a restore returns the node unchanged', () => {
    const archived = { ...zoneA, status: 'archived' as const, archivedAt: AT };
    const restored = { ...archived, status: 'active' as const };
    delete (restored as { archivedAt?: string }).archivedAt;
    expect(restored).toEqual(zoneA);
  });

  it('a move invalidates no id — every historical reference still resolves', () => {
    const moved = { ...zoneA, parentId: 'zoneB', path: ['org', 'zoneB'], depth: 2 };
    expect(moved._id).toBe(zoneA._id);
    expect(resolveLocation(moved, byId([org, zoneB, moved]), false).id).toBe('zoneA');
  });

  /**
   * **The gap this review was asked to check for, and it is real.**
   *
   * The requirement: evidence recorded while a camera sat in Zone A must still resolve to *Zone A*
   * after the camera moves to Zone B. Today it does not, and neither half of the problem lives in
   * the hierarchy:
   *
   *  1. **A camera's `zoneId` is mutable** and evidence records reference the *camera*, not the
   *     location. Reading "where did this happen" through the camera therefore returns where the
   *     camera is **now**.
   *  2. **A location's ancestry is current**, so evidence naming a zone that has since moved
   *     resolves to the zone's ancestry today rather than at the time of the event.
   *
   * Nothing dangles — every id still resolves — but the *answer changes*, which for an investigation
   * is worse than an error. The fix is to capture `zoneId` and its `path` **on the evidence record at
   * write time**, which is an Evidence-context change (`CameraProbeRecord`, the timeline entries),
   * not a hierarchy one. The hierarchy already supplies everything needed.
   *
   * This test asserts the current behaviour deliberately, so the day it is fixed the test fails and
   * has to be rewritten as the guarantee. Recorded in the freeze record as a **known limitation**.
   */
  it('resolves through the camera to its CURRENT location — the named limitation', () => {
    // An event recorded when the camera was in Zone A. The record holds the camera, not the place.
    const evidence = { evidenceId: 'probe:prb_1', cameraId: 'cam_1', at: AT };
    const cameraBefore = { _id: 'cam_1', zoneId: 'zoneA' };
    const cameraAfter = { ...cameraBefore, zoneId: 'zoneB' };

    const where = (camera: { zoneId: string }) =>
      resolveLocation(
        byId([org, zoneA, zoneB]).get(camera.zoneId)!,
        byId([org, zoneA, zoneB]),
        false,
      ).label;

    expect(where(cameraBefore)).toBe('Acme › Zone A');
    // After the move, the same evidence record resolves somewhere else. This is the gap.
    expect(where(cameraAfter)).toBe('Acme › Zone B');
    expect(evidence.cameraId).toBe('cam_1'); // the reference itself never broke
  });

  /**
   * And the shape of the fix, verified as available today: the hierarchy can hand out the ancestry
   * at any moment, so an evidence writer has everything it needs to freeze the answer. No hierarchy
   * change is required — which is why this is a P-4+ Evidence item and not a P-3 one.
   */
  it('supplies the ancestry an evidence writer would freeze at write time', () => {
    const atWriteTime = { zoneId: zoneA._id, path: [...zoneA.path], depth: zoneA.depth };
    // The zone later moves; the captured snapshot is unaffected, because it was copied, not linked.
    const moved = { ...zoneA, parentId: 'zoneB', path: ['org', 'zoneB'], depth: 2 };
    expect(atWriteTime.path).toEqual(['org']);
    expect(moved.path).toEqual(['org', 'zoneB']);
    expect(pathUnder({ _id: zoneA._id, path: zoneA.path })).toEqual(['org', 'zoneA']);
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * Recommendation 13 — P-4 can consume this without changing it.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe('P-4 readiness: rules consume the hierarchy unchanged (rec 13)', () => {
  const estate = [
    node('org', 'org', null, []),
    node('emea', 'region', 'org', ['org']),
    node('london', 'site', 'emea', ['org', 'emea']),
    node('tower', 'building', 'london', ['org', 'emea', 'london']),
    node('lobby', 'zone', 'tower', ['org', 'emea', 'london', 'tower']),
    node('dock', 'zone', 'tower', ['org', 'emea', 'london', 'tower']),
  ];

  /**
   * A rule scope is **a node id**. Nothing more is needed, and nothing in the hierarchy has to change
   * to carry one: a rule references a location exactly as a camera does.
   */
  it('scopes a rule to any level with a single node id', () => {
    for (const scope of ['org', 'emea', 'london', 'tower', 'lobby']) {
      const inScope = estate.filter((n) => n._id === scope || n.path.includes(scope));
      expect(inScope.length).toBeGreaterThan(0);
      expect(inScope[0]!._id).toBe(scope);
    }
  });

  it('resolves a site-scoped rule to the zones it applies to — one indexed predicate', () => {
    const zonesUnder = (scope: string) =>
      estate.filter((n) => n.path.includes(scope) && n.type === 'zone').map((n) => n._id);
    expect(zonesUnder('london')).toEqual(['lobby', 'dock']);
    expect(zonesUnder('org')).toEqual(['lobby', 'dock']);
    expect(zonesUnder('lobby')).toEqual([]);
  });

  it('answers "does this rule apply here" without a traversal', () => {
    const applies = (ruleScope: string, at: OrgNodeDoc) =>
      at._id === ruleScope || at.path.includes(ruleScope);
    const lobby = estate.find((n) => n._id === 'lobby')!;
    expect(applies('london', lobby)).toBe(true);
    expect(applies('emea', lobby)).toBe(true);
    expect(applies('dock', lobby)).toBe(false);
  });

  it('needs no new hierarchy field, contract or route', () => {
    // Everything a rule scope requires is already published on the node.
    const required = ['id', 'type', 'path', 'status'];
    const resolved = resolveLocation(estate[4]!, byId(estate), false);
    for (const key of required) expect(Object.keys(resolved)).toContain(key);
    // And the reverse: the hierarchy names nothing about rules.
    expect(Object.keys(resolved)).not.toContain('rules');
    expect(Object.keys(resolved)).not.toContain('ruleCount');
  });
});
