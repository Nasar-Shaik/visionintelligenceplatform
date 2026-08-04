import { useMemo, useState } from 'react';
import { Camera as CameraIcon, Plus, ScanSearch } from 'lucide-react';
import type { Camera, CameraHealthStatus, CameraLifecycleState, OrgTreeNode } from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FilterBar,
  PageHeader,
  QueryBoundary,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusIndicator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
  toast,
} from '@/ui';
import { AddCameraDialog } from './AddCameraDialog';
import { CameraDetailSheet } from './CameraDetailSheet';
import { DiscoveryDialog } from './DiscoveryDialog';
import {
  HEALTH_LABEL,
  LIFECYCLE_LABEL,
  cameraLifecyclePresentation,
  capabilitySummary,
  healthPresentation,
  matchesSearch,
} from './cameraPresentation';
import { useCameras, useDeleteCamera } from './useCameras';
import { LocationPicker } from '@/features/organization/LocationPicker';
import { findNode, subtreeIds } from '@/features/organization/orgPresentation';
import { useOrgTree } from '@/features/organization/useOrganization';

const HEALTH_FILTERS: Array<CameraHealthStatus | 'all'> = [
  'all',
  'online',
  'unhealthy',
  'offline',
  'unknown',
];

/**
 * Lifecycle filter (P-2). `active` is first and is what an operator almost always wants: retired
 * cameras are kept forever for their history, and a site that has replaced its cameras twice would
 * otherwise show three times as many rows as it has devices.
 */
const LIFECYCLE_FILTERS: Array<CameraLifecycleState | 'all' | 'active'> = [
  'active',
  'all',
  'configured',
  'connected',
  'monitoring',
  'degraded',
  'offline',
  'retired',
];

/**
 * Camera & device management (P-1).
 *
 * The list polls on a 30s interval rather than 5s: camera health changes on the order of minutes,
 * and a faster poll would put a steady request load on the gateway for information nobody is
 * watching change second to second.
 */
export function CamerasPage() {
  const query = useCameras({ refetchInterval: 30_000 });
  const deleteCamera = useDeleteCamera();
  const canCreate = usePermission('camera:create');

  const [search, setSearch] = useState('');
  const [health, setHealth] = useState<CameraHealthStatus | 'all'>('all');
  const [lifecycle, setLifecycle] = useState<CameraLifecycleState | 'all' | 'active'>('active');
  const [location, setLocation] = useState<string>('all');
  const [adding, setAdding] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [selected, setSelected] = useState<Camera | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Camera | null>(null);

  const cameras = query.data ?? [];

  /*
   * "Everything under this site" resolved by the backend (P-3). The subtree comes from the tree the
   * server built; the console filters on the resulting id set and never walks the hierarchy itself.
   */
  const tree = useOrgTree();
  const locationScope = useMemo(() => {
    if (location === 'all') return null;
    const node = findNode(tree.data?.roots ?? [], location);
    return node ? new Set(subtreeIds(node)) : null;
  }, [location, tree.data]);

  /** Zone id → the full path the server resolved. A raw id in a table tells an operator nothing. */
  const locationLabels = useMemo(() => {
    const labels = new Map<string, string>();
    const walk = (nodes: OrgTreeNode[]): void => {
      for (const node of nodes) {
        labels.set(node.id, node.label);
        walk(node.children);
      }
    };
    walk(tree.data?.roots ?? []);
    return labels;
  }, [tree.data]);

  const visible = useMemo(
    () =>
      cameras.filter(
        (camera) =>
          matchesSearch(camera, search) &&
          (locationScope === null || locationScope.has(camera.zoneId)) &&
          (health === 'all' || camera.health.status === health) &&
          (lifecycle === 'all'
            ? true
            : lifecycle === 'active'
              ? camera.lifecycle.state !== 'retired'
              : camera.lifecycle.state === lifecycle),
      ),
    [cameras, search, health, lifecycle, locationScope],
  );

  const confirmDelete = () => {
    if (!pendingDelete) return;
    deleteCamera.mutate(pendingDelete.id, {
      onSuccess: () => {
        toast.success(`${pendingDelete.name} removed`);
        setPendingDelete(null);
        setSelected(null);
      },
      onError: () => toast.error('Could not remove the camera'),
    });
  };

  return (
    <>
      <PageHeader
        title="Cameras"
        description="Every camera and recorder this tenant watches."
        actions={
          canCreate ? (
            <>
              <Button variant="outline" onClick={() => setDiscovering(true)}>
                <ScanSearch className="size-4" aria-hidden />
                Discover
              </Button>
              <Button onClick={() => setAdding(true)}>
                <Plus className="size-4" aria-hidden />
                Add cameras
              </Button>
            </>
          ) : null
        }
      />

      <FilterBar search={search} onSearchChange={setSearch} searchPlaceholder="Search cameras…">
        <div className="w-64">
          <LocationPicker
            value={location}
            onChange={setLocation}
            anyOption="All locations"
            placeholder="All locations"
          />
        </div>
        <Select
          value={lifecycle}
          onValueChange={(v) => setLifecycle(v as CameraLifecycleState | 'all' | 'active')}
        >
          <SelectTrigger className="w-44" aria-label="Filter by lifecycle">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIFECYCLE_FILTERS.map((value) => (
              <SelectItem key={value} value={value}>
                {value === 'all'
                  ? 'All lifecycle states'
                  : value === 'active'
                    ? 'Active (not retired)'
                    : LIFECYCLE_LABEL[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={health} onValueChange={(v) => setHealth(v as CameraHealthStatus | 'all')}>
          <SelectTrigger className="w-40" aria-label="Filter by health">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HEALTH_FILTERS.map((value) => (
              <SelectItem key={value} value={value}>
                {value === 'all' ? 'All health' : HEALTH_LABEL[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        isEmpty={cameras.length === 0}
        skeleton={<TableSkeleton rows={6} cols={5} />}
        emptyState={
          <EmptyState
            icon={CameraIcon}
            title="No cameras yet"
            description="Discover the ONVIF devices on this network, or add a camera by stream URL."
            action={
              canCreate ? (
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setDiscovering(true)}>
                    <ScanSearch className="size-4" aria-hidden />
                    Discover
                  </Button>
                  <Button onClick={() => setAdding(true)}>Add a camera</Button>
                </div>
              ) : null
            }
          />
        }
      >
        {visible.length === 0 ? (
          <EmptyState
            icon={CameraIcon}
            title="No cameras match"
            description="No camera matches the current search and filter."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Camera</TableHead>
                <TableHead>Lifecycle</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((camera) => (
                <TableRow
                  key={camera.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(camera)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(camera);
                    }
                  }}
                >
                  <TableCell>
                    <div className="font-medium">{camera.name}</div>
                    <div className="truncate font-mono text-xs text-text-subtle">
                      {camera.streamUrl}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusIndicator {...cameraLifecyclePresentation(camera.lifecycle.state)} />
                  </TableCell>
                  <TableCell>
                    <StatusIndicator {...healthPresentation(camera.health.status)} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {locationLabels.get(camera.zoneId) ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {capabilitySummary(camera.capabilities) || '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={camera.status === 'enabled' ? 'success' : 'neutral'}>
                      {camera.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </QueryBoundary>

      <AddCameraDialog open={adding} onOpenChange={setAdding} />
      <DiscoveryDialog open={discovering} onOpenChange={setDiscovering} />
      <CameraDetailSheet
        camera={selected}
        onClose={() => setSelected(null)}
        onDelete={setPendingDelete}
      />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {pendingDelete?.name}?</DialogTitle>
            <DialogDescription>
              The camera is removed from the inventory and analysis stops. Recorded evidence is not
              deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteCamera.isPending}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
