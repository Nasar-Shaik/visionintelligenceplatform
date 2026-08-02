import type { OrgNodeType, OrgTreeNode } from '@vip/contracts';

/**
 * Display labels for the neutral type identifiers.
 *
 * `type` is the identifier the platform stores and reasons about; this map is the only place it
 * becomes a word a person reads, which is what makes translating the product a change to one file
 * rather than a search across screens (P-3 rec 8). A type with no entry falls back to itself rather
 * than rendering blank — a missing translation should look wrong, not look empty.
 */
export const ORG_TYPE_LABELS: Record<OrgNodeType, string> = {
  org: 'Organization',
  region: 'Region',
  country: 'Country',
  branch: 'Branch',
  site: 'Site',
  building: 'Building',
  floor: 'Floor',
  zone: 'Zone',
};

export function orgTypeLabel(type: string): string {
  return ORG_TYPE_LABELS[type as OrgNodeType] ?? type;
}

/**
 * Flatten a tree for rendering, carrying each node's depth.
 *
 * Depth comes from the node itself, not from how far the flattening recursed — under a subtree read
 * the top node's depth is its depth in the *estate*, and indenting from the recursion would quietly
 * disagree with the breadcrumb sitting next to it.
 */
export interface FlatOrgNode {
  node: OrgTreeNode;
  /** Indentation level within this rendering, relative to the roots shown. */
  indent: number;
}

export function flattenTree(roots: OrgTreeNode[], expanded: ReadonlySet<string>): FlatOrgNode[] {
  const out: FlatOrgNode[] = [];
  const walk = (nodes: OrgTreeNode[], indent: number): void => {
    for (const node of nodes) {
      out.push({ node, indent });
      if (node.children.length > 0 && expanded.has(node.id)) walk(node.children, indent + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** Every node in a subtree, itself included — for "show me the cameras under this site". */
export function subtreeIds(node: OrgTreeNode): string[] {
  const ids: string[] = [];
  const walk = (current: OrgTreeNode): void => {
    ids.push(current.id);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return ids;
}

/** Find a node anywhere in a forest by id. */
export function findNode(roots: OrgTreeNode[], id: string): OrgTreeNode | undefined {
  for (const root of roots) {
    if (root.id === id) return root;
    const found = findNode(root.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * The ids to expand so every node with children is open.
 *
 * A collapsed tree is the right default for a large estate and the wrong one for a small estate that
 * fits on a screen — so small estates open fully and large ones open to their top two levels.
 */
export const AUTO_EXPAND_LIMIT = 50;

export function defaultExpanded(roots: OrgTreeNode[], nodeCount: number): Set<string> {
  const expanded = new Set<string>();
  const walk = (nodes: OrgTreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.children.length === 0) continue;
      if (nodeCount <= AUTO_EXPAND_LIMIT || depth < 2) expanded.add(node.id);
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return expanded;
}

/**
 * Where a camera may be placed.
 *
 * Anywhere except the organization root — a camera pinned to "Acme" tells nobody where it is, and a
 * placement nobody can act on is worse than being asked for one more click at onboarding.
 */
export function isCameraPlaceable(node: OrgTreeNode): boolean {
  return node.type !== 'org' && node.status === 'active';
}
