/**
 * Domain: the organizational hierarchy — containment, traversal, movement and archival (P-3).
 *
 * Everything here is pure and framework-free. The application layer fetches documents and persists
 * results; this module decides what is legal and what the result looks like. That split is what
 * makes the rules testable without a database, and it is what lets a future bulk import validate
 * five thousand rows by calling the same functions in a loop rather than five thousand HTTP
 * round-trips (P-3 rec 5).
 *
 * **Traversal is never recursive over the store.** Ancestry is materialized on each node (`path`)
 * and the depth is indexed, so "everything under this site" is one indexed query and building a tree
 * is a single pass over a flat list (P-3 rec 6). No function here is worse than O(n).
 */
import {
  allowedChildTypes,
  canContain,
  ORG_NODE_TYPES,
  type OrgCrumb,
  type OrgLocation,
  type OrgNodeType,
  type OrgTreeNode,
} from '@vip/contracts';
import type { OrgNodeDoc } from './tenant.js';

/** The separator between breadcrumb steps in a rendered label. */
export const LABEL_SEPARATOR = ' › ';

/**
 * Whether a child may sit directly under a parent, as a message or `null` when it may.
 *
 * A message rather than a boolean because the caller always needs to say *why*, and a boolean
 * forces the reason to be written a second time at every call site.
 */
export function containmentError(parent: OrgNodeType | null, child: OrgNodeType): string | null {
  if (parent === null) {
    return child === 'org' ? null : `a ${child} requires a parent`;
  }
  if (child === 'org') return 'an org root must have a null parent';
  if (!canContain(parent, child)) {
    return `a ${child} cannot be placed under a ${parent} — the hierarchy is ${ORG_NODE_TYPES.join(' → ')}`;
  }
  return null;
}

/** Ancestor ids of a node, root-first. The materialized path *is* the ancestry — no walk required. */
export function ancestorIds(node: Pick<OrgNodeDoc, 'path'>): string[] {
  return node.path;
}

/** Index documents by id, for the single-pass builders below. */
export function byId(docs: readonly OrgNodeDoc[]): Map<string, OrgNodeDoc> {
  return new Map(docs.map((doc) => [doc._id, doc]));
}

/** Ids that have at least one child among `docs`. One pass; used for tree disclosure controls. */
export function parentsWithChildren(docs: readonly OrgNodeDoc[]): Set<string> {
  const parents = new Set<string>();
  for (const doc of docs) if (doc.parentId) parents.add(doc.parentId);
  return parents;
}

/**
 * Resolve a node for display: breadcrumb, depth, label and the child types it accepts.
 *
 * The backend owns traversal (P-3 rec 3). An ancestor missing from `lookup` is skipped rather than
 * faked — a breadcrumb with a hole is a visible defect, and an invented name is an invisible one.
 */
export function resolveLocation(
  doc: OrgNodeDoc,
  lookup: Map<string, OrgNodeDoc>,
  hasChildren: boolean,
): OrgLocation {
  const breadcrumb: OrgCrumb[] = [];
  for (const id of doc.path) {
    const ancestor = lookup.get(id);
    if (ancestor) breadcrumb.push({ id: ancestor._id, type: ancestor.type, name: ancestor.name });
  }
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    parentId: doc.parentId,
    type: doc.type,
    name: doc.name,
    path: doc.path,
    status: doc.status ?? 'active',
    ...(doc.archivedAt ? { archivedAt: doc.archivedAt } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    breadcrumb,
    depth: doc.path.length,
    label: [...breadcrumb.map((crumb) => crumb.name), doc.name].join(LABEL_SEPARATOR),
    allowedChildTypes: allowedChildTypes(doc.type),
    hasChildren,
  };
}

/**
 * Build the estate as a forest, in one pass.
 *
 * A node whose parent is absent from `docs` becomes an **orphan** and is reported by id rather than
 * promoted to a root or dropped. Promoting it would silently restructure the customer's estate on a
 * screen; dropping it would make cameras vanish from a view with no explanation. Both are worse than
 * saying so.
 */
export function buildTree(
  docs: readonly OrgNodeDoc[],
  options: { rootIds?: readonly string[] } = {},
): {
  roots: OrgTreeNode[];
  nodeCount: number;
  orphaned: string[];
} {
  // A subtree read has a root whose parent was deliberately not fetched. Naming it keeps "the parent
  // is missing" meaning what it should — an inconsistency — rather than meaning "you asked for less".
  const declaredRoots = new Set(options.rootIds ?? []);
  const lookup = byId(docs);
  const withChildren = parentsWithChildren(docs);
  const nodes = new Map<string, OrgTreeNode>();
  for (const doc of docs) {
    nodes.set(doc._id, {
      ...resolveLocation(doc, lookup, withChildren.has(doc._id)),
      children: [],
    });
  }

  const roots: OrgTreeNode[] = [];
  const orphaned: string[] = [];
  for (const doc of docs) {
    const node = nodes.get(doc._id)!;
    if (doc.parentId === null || declaredRoots.has(doc._id)) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(doc.parentId);
    if (!parent) {
      orphaned.push(doc._id);
      continue;
    }
    parent.children.push(node);
  }

  sortTree(roots);
  return { roots, nodeCount: docs.length, orphaned };
}

/**
 * Order siblings the way an operator reads them: outer types first, then by name.
 *
 * `localeCompare` with an explicit `undefined` locale and numeric collation, so "Floor 2" sorts
 * before "Floor 10" and the order does not depend on the server's locale — a list whose order
 * changes with the host is a list nobody can screenshot.
 */
function sortTree(nodes: OrgTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return ORG_NODE_TYPES.indexOf(a.type) - ORG_NODE_TYPES.indexOf(b.type);
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  for (const node of nodes) sortTree(node.children);
}

/** The path a node would carry under a given parent. `null` parent means a root: an empty path. */
export function pathUnder(parent: Pick<OrgNodeDoc, '_id' | 'path'> | null): string[] {
  return parent ? [...parent.path, parent._id] : [];
}

/**
 * Why a move is illegal, or `null` when it is legal.
 *
 * The cycle check reads the *target's* materialized path: a node may not move under itself or under
 * any of its own descendants. Testing this by walking parents would be O(depth) queries and would
 * miss the case where the walk is what created the cycle.
 */
export function moveError(node: OrgNodeDoc, parent: OrgNodeDoc): string | null {
  if (parent._id === node._id) return 'a node cannot be moved under itself';
  if (parent.path.includes(node._id)) {
    return 'a node cannot be moved under one of its own descendants';
  }
  const containment = containmentError(parent.type, node.type);
  if (containment) return containment;
  if ((parent.status ?? 'active') === 'archived' && (node.status ?? 'active') === 'active') {
    return 'an active node cannot be moved under an archived one';
  }
  return null;
}

/**
 * The path rewrites a move implies: the node itself plus every descendant.
 *
 * A descendant's ancestry above the moved node is replaced wholesale and the part below it is kept —
 * the subtree travels intact. Returned as data rather than applied, so the caller can write them in
 * one bulk operation and so the arithmetic is testable without a store.
 */
export function movedPaths(
  node: OrgNodeDoc,
  parent: OrgNodeDoc,
  descendants: readonly OrgNodeDoc[],
): Array<{ id: string; path: string[]; depth: number }> {
  const nodePath = pathUnder(parent);
  const rewrites = [{ id: node._id, path: nodePath, depth: nodePath.length }];
  const keepFrom = node.path.length;
  for (const descendant of descendants) {
    const path = [...nodePath, ...descendant.path.slice(keepFrom)];
    rewrites.push({ id: descendant._id, path, depth: path.length });
  }
  return rewrites;
}

/**
 * Why a node cannot be archived, or `null`.
 *
 * A root may not be archived: a tenant with no live estate has no way back through the product, and
 * the operation someone actually wants there is deprovisioning the tenant.
 */
export function archiveError(node: OrgNodeDoc): string | null {
  if (node.parentId === null) return 'the organization root cannot be archived';
  if ((node.status ?? 'active') === 'archived') return 'this location is already archived';
  return null;
}

/**
 * Why a node cannot be restored, or `null`.
 *
 * Restoring under an archived ancestor would produce a live location inside a retired one, which is
 * a state no screen can render honestly. The caller is told to restore the parent first.
 */
export function restoreError(node: OrgNodeDoc, ancestors: readonly OrgNodeDoc[]): string | null {
  if ((node.status ?? 'active') === 'active') return 'this location is not archived';
  const archived = ancestors.find((a) => (a.status ?? 'active') === 'archived');
  if (archived) {
    return `restore "${archived.name}" first — a location cannot be active inside an archived one`;
  }
  return null;
}

/** Whether a node is part of the live estate. Tolerates documents written before P-3. */
export function isActive(node: Pick<OrgNodeDoc, 'status'>): boolean {
  return (node.status ?? 'active') === 'active';
}
