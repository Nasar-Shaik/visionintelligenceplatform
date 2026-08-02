import { useMemo } from 'react';
import type { OrgTreeNode } from '@vip/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui';
import { flattenTree, orgTypeLabel } from './orgPresentation';
import { useOrgTree } from './useOrganization';

/** Every node in a forest, flattened and ordered as the tree renders them. */
function allNodes(roots: OrgTreeNode[]): OrgTreeNode[] {
  const expanded = new Set<string>();
  const collect = (nodes: OrgTreeNode[]): void => {
    for (const node of nodes) {
      expanded.add(node.id);
      collect(node.children);
    }
  };
  collect(roots);
  return flattenTree(roots, expanded).map((row) => row.node);
}

export interface LocationPickerProps {
  value: string | undefined;
  onChange: (nodeId: string) => void;
  id?: string;
  /** Restrict selectable nodes — cameras are placed in leaves, filters accept any level. */
  selectable?: (node: OrgTreeNode) => boolean;
  placeholder?: string;
  /** A row meaning "no filter". Omit for a required field. */
  anyOption?: string;
}

/**
 * Choose a location from the estate.
 *
 * Options are labelled with the **full path the server resolved** rather than the node's bare name,
 * because "Lobby" is ambiguous in any estate with more than one building and the disambiguation is
 * exactly what the hierarchy is for. Indentation shows the shape; the label carries the meaning.
 */
export function LocationPicker({
  value,
  onChange,
  id,
  selectable,
  placeholder = 'Choose a location…',
  anyOption,
}: LocationPickerProps) {
  const tree = useOrgTree();
  const nodes = useMemo(() => allNodes(tree.data?.roots ?? []), [tree.data]);
  const options = useMemo(
    () => (selectable ? nodes.filter(selectable) : nodes),
    [nodes, selectable],
  );

  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label="Location">
        <SelectValue placeholder={tree.isPending ? 'Loading locations…' : placeholder} />
      </SelectTrigger>
      <SelectContent>
        {anyOption ? <SelectItem value="all">{anyOption}</SelectItem> : null}
        {options.map((node) => (
          <SelectItem key={node.id} value={node.id}>
            {node.label} · {orgTypeLabel(node.type)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
