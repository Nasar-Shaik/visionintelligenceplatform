import { useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Building2,
  ChevronDown,
  ChevronRight,
  MapPin,
  Pencil,
  Plus,
} from 'lucide-react';
import type { OrgNodeType, OrgTreeNode } from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Label,
  PageHeader,
  QueryBoundary,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  TableSkeleton,
  toast,
} from '@/ui';
import {
  defaultExpanded,
  findNode,
  flattenTree,
  orgTypeLabel,
  subtreeIds,
} from './orgPresentation';
import {
  useArchiveLocation,
  useCreateLocation,
  useOrgTree,
  useRestoreLocation,
  useUpdateLocation,
} from './useOrganization';

/**
 * The estate: the customer's physical world, as the platform models it.
 *
 * Everything shown here — the breadcrumb, the depth, which child types a node accepts — is computed
 * by the server and rendered as received. This page contains no containment rule, which is the point:
 * when the rules change, they change once.
 */
export function LocationsPage() {
  const tree = useOrgTree();
  const canEdit = usePermission('camera:create');
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [adding, setAdding] = useState<OrgTreeNode | null>(null);
  const [renaming, setRenaming] = useState<OrgTreeNode | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const roots = useMemo(() => tree.data?.roots ?? [], [tree.data]);
  const nodeCount = tree.data?.nodeCount ?? 0;

  const open = useMemo(
    () => expanded ?? defaultExpanded(roots, nodeCount),
    [expanded, roots, nodeCount],
  );
  const rows = useMemo(() => flattenTree(roots, open), [roots, open]);
  const selectedNode = selected ? findNode(roots, selected) : undefined;

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Locations"
        description="Where every camera actually is. Regions, sites, buildings, floors and zones."
      />

      {tree.data?.truncated ? (
        <p className="text-sm text-warning" role="status">
          This estate is larger than one view. Showing the top of the hierarchy — open a branch to
          see the rest.
        </p>
      ) : null}

      {tree.data && tree.data.orphaned.length > 0 ? (
        <p className="text-sm text-destructive" role="status">
          {tree.data.orphaned.length} location(s) reference a parent that no longer resolves.
        </p>
      ) : null}

      <QueryBoundary
        isLoading={tree.isPending}
        isError={tree.isError}
        error={tree.error}
        isEmpty={rows.length === 0}
        skeleton={<TableSkeleton rows={6} />}
        emptyState={
          <EmptyState
            icon={Building2}
            title="No locations yet"
            description="Your organization is created with a root. Add regions, sites and zones beneath it."
          />
        }
      >
        <div className="rounded-md border">
          <ul className="divide-y" aria-label="Locations">
            {rows.map(({ node, indent }) => (
              <li
                key={node.id}
                className={`flex items-center gap-2 px-3 py-2 text-sm ${
                  selected === node.id ? 'bg-muted/60' : ''
                }`}
                style={{ paddingLeft: `${indent * 20 + 12}px` }}
              >
                {node.hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggle(node.id)}
                    aria-label={`${open.has(node.id) ? 'Collapse' : 'Expand'} ${node.name}`}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {open.has(node.id) ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </button>
                ) : (
                  <span className="inline-block size-4" />
                )}

                <button
                  type="button"
                  className="flex-1 truncate text-left font-medium hover:underline"
                  onClick={() => setSelected(node.id)}
                >
                  {node.name}
                </button>

                <Badge variant="outline">{orgTypeLabel(node.type)}</Badge>

                {canEdit ? (
                  <span className="flex items-center gap-1">
                    {node.allowedChildTypes.length > 0 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAdding(node)}
                        aria-label={`Add a location under ${node.name}`}
                      >
                        <Plus className="size-4" />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRenaming(node)}
                      aria-label={`Rename ${node.name}`}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    {node.parentId !== null ? <ArchiveButton node={node} /> : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </QueryBoundary>

      {selectedNode ? <LocationDetail node={selectedNode} /> : null}

      {adding ? <AddLocationDialog parent={adding} onDone={() => setAdding(null)} /> : null}
      {renaming ? <RenameLocationDialog node={renaming} onDone={() => setRenaming(null)} /> : null}
    </div>
  );
}

/**
 * The breadcrumb the server resolved, plus the ids anything else would need.
 *
 * The subtree id list is shown because it is what a rule scope, a report filter or a camera query
 * consumes — the same set the Cameras page passes as `zoneId` filters.
 */
function LocationDetail({ node }: { node: OrgTreeNode }) {
  const ids = subtreeIds(node);
  return (
    <div className="rounded-md border p-4 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <MapPin className="size-4" />
        <span>{node.label}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Type</dt>
          <dd>{orgTypeLabel(node.type)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Depth</dt>
          <dd>{node.depth}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Locations below</dt>
          <dd>{ids.length - 1}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Status</dt>
          <dd>{node.status === 'archived' ? 'Archived' : 'Active'}</dd>
        </div>
      </dl>
    </div>
  );
}

function ArchiveButton({ node }: { node: OrgTreeNode }) {
  const archive = useArchiveLocation();
  const restore = useRestoreLocation();
  const archived = node.status === 'archived';
  const run = archived ? restore : archive;

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={run.isPending}
      aria-label={`${archived ? 'Restore' : 'Archive'} ${node.name}`}
      onClick={() =>
        run.mutate(node.id, {
          onSuccess: () =>
            toast.success(`${node.name} ${archived ? 'restored' : 'archived'}`, {
              description: archived
                ? undefined
                : 'Everything beneath it was archived too. Nothing was deleted.',
            }),
          onError: (error: Error) => toast.error(error.message),
        })
      }
    >
      {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
    </Button>
  );
}

/**
 * Add a location under a parent.
 *
 * The type list is `parent.allowedChildTypes` **exactly as the server sent it** — the console does
 * not know that a zone cannot contain a region, and should not need to.
 */
function AddLocationDialog({ parent, onDone }: { parent: OrgTreeNode; onDone: () => void }) {
  const create = useCreateLocation();
  const [name, setName] = useState('');
  const [type, setType] = useState<OrgNodeType>(parent.allowedChildTypes[0] as OrgNodeType);

  return (
    <Dialog open onOpenChange={(next) => !next && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a location</DialogTitle>
          <DialogDescription>Under {parent.label}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="location-type">Type</Label>
            <Select value={type} onValueChange={(next) => setType(next as OrgNodeType)}>
              <SelectTrigger id="location-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {parent.allowedChildTypes.map((option) => (
                  <SelectItem key={option} value={option}>
                    {orgTypeLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="location-name">Name</Label>
            <Input
              id="location-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="London HQ"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            disabled={name.trim().length === 0 || create.isPending}
            onClick={() =>
              create.mutate(
                { type, name: name.trim(), parentId: parent.id },
                {
                  onSuccess: () => {
                    toast.success(`${name.trim()} added`);
                    onDone();
                  },
                  onError: (error: Error) => toast.error(error.message),
                },
              )
            }
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Rename a location.
 *
 * A rename is safe precisely because the name is not an identifier: every camera, event, rule and
 * piece of evidence references the id, so nothing but the label changes.
 */
function RenameLocationDialog({ node, onDone }: { node: OrgTreeNode; onDone: () => void }) {
  const update = useUpdateLocation();
  const [name, setName] = useState(node.name);

  return (
    <Dialog open onOpenChange={(next) => !next && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename {orgTypeLabel(node.type).toLowerCase()}</DialogTitle>
          <DialogDescription>
            References are by id, so renaming affects nothing but what people read.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="rename-location">Name</Label>
          <Input
            id="rename-location"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            disabled={name.trim().length === 0 || update.isPending}
            onClick={() =>
              update.mutate(
                { nodeId: node.id, patch: { name: name.trim() } },
                {
                  onSuccess: () => {
                    toast.success('Renamed');
                    onDone();
                  },
                  onError: (error: Error) => toast.error(error.message),
                },
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
