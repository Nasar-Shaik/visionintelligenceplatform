import { useMemo } from 'react';
import { Globe, MapPin, X } from 'lucide-react';
import type { OrgTreeNode } from '@vip/contracts';
import { Badge, Button, Label } from '@/ui';
import { LocationPicker } from '@/features/organization/LocationPicker';
import { findNode, orgTypeLabel, subtreeIds } from '@/features/organization/orgPresentation';
import { useOrgTree } from '@/features/organization/useOrganization';

export interface RuleScopeFieldProps {
  nodeIds: string[];
  onChange: (nodeIds: string[]) => void;
  disabled?: boolean;
}

/**
 * Where a rule applies (P-4).
 *
 * The estate is the frozen Location Hierarchy — this reuses the P-3 picker rather than growing a
 * second one, so a rule is scoped with the same control that places a camera.
 *
 * Two things it makes explicit rather than implicit. **A rule with no locations applies to the whole
 * tenant**, which is the right default and a genuinely surprising one to discover after the fact — so
 * it is stated, not left blank. And each chosen node shows **how many locations sit beneath it**,
 * because "the London site" and "forty zones" are the same choice and an author should see both.
 */
export function RuleScopeField({ nodeIds, onChange, disabled }: RuleScopeFieldProps) {
  const tree = useOrgTree();
  const roots = useMemo(() => tree.data?.roots ?? [], [tree.data]);

  const chosen = useMemo(
    () =>
      nodeIds
        .map((id) => findNode(roots, id))
        .filter((node): node is OrgTreeNode => node !== undefined),
    [nodeIds, roots],
  );

  const add = (nodeId: string) => {
    if (nodeId === 'all' || nodeIds.includes(nodeId)) return;
    onChange([...nodeIds, nodeId]);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="rule-scope">Where this rule applies</Label>

      {nodeIds.length === 0 ? (
        <p className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <Globe className="size-4" aria-hidden />
          Everywhere in this tenant. Add a location to narrow it.
        </p>
      ) : (
        <ul className="space-y-1" aria-label="Rule scope">
          {chosen.map((node) => {
            const below = subtreeIds(node).length - 1;
            return (
              <li
                key={node.id}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex-1 truncate">{node.label}</span>
                <Badge variant="outline">{orgTypeLabel(node.type)}</Badge>
                {below > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    +{below} location{below === 1 ? '' : 's'} below
                  </span>
                ) : null}
                {!disabled ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${node.name} from the scope`}
                    onClick={() => onChange(nodeIds.filter((id) => id !== node.id))}
                  >
                    <X className="size-4" />
                  </Button>
                ) : null}
              </li>
            );
          })}
          {/* A scoped id the tree cannot resolve is shown, not hidden — it is why the rule fails to validate. */}
          {nodeIds
            .filter((id) => !chosen.some((node) => node.id === id))
            .map((id) => (
              <li
                key={id}
                className="flex items-center gap-2 rounded-md border border-destructive/50 px-3 py-2 text-sm"
              >
                <span className="flex-1 truncate text-destructive">
                  {id} — this location no longer exists
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${id} from the scope`}
                  onClick={() => onChange(nodeIds.filter((other) => other !== id))}
                >
                  <X className="size-4" />
                </Button>
              </li>
            ))}
        </ul>
      )}

      {!disabled ? (
        <LocationPicker
          id="rule-scope"
          value={undefined}
          onChange={add}
          placeholder="Add a location…"
        />
      ) : null}
    </div>
  );
}
