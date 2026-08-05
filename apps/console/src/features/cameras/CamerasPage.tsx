import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera as CameraIcon, Plus, ScanSearch } from 'lucide-react';
import type { Camera, CameraHealthStatus, CameraLifecycleState, OrgTreeNode } from '@vip/contracts';
import { useDebounced, usePermission } from '@/app/hooks';
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
import { DiscoveryDialog } from './DiscoveryDialog';
import {
  HEALTH_LABEL,
  LIFECYCLE_LABEL,
  cameraLifecyclePresentation,
  capabilitySummary,
  healthPresentation,
} from './cameraPresentation';
import { useCameraPages, useDeleteCamera, useFleetMetrics } from './useCameras';
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
/**
 * ⚠️ How far an operator may page before the screen says stop.
 *
 * Ten pages of fifty. The bound exists for the reason P-6.5 measured on the Inbox: an infinite query
 * refetches **every page it has loaded** on each interval, so a list left open all shift costs more
 * the further it has been paged. Beyond this the answer is a narrower search, not more scrolling.
 */
const MAX_PAGES = 10;
const PAGE_SIZE = 50;
/** `CAMERA_ZONE_FILTER_LIMIT` — a site with more zones than this narrows by a child instead. */
const ZONE_FILTER_LIMIT = 200;

export function CamerasPage() {
  const deleteCamera = useDeleteCamera();
  const canCreate = usePermission('camera:create');

  const [search, setSearch] = useState('');
  const [health, setHealth] = useState<CameraHealthStatus | 'all'>('all');
  const [lifecycle, setLifecycle] = useState<CameraLifecycleState | 'all' | 'active'>('active');
  const [location, setLocation] = useState<string>('all');
  const [adding, setAdding] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Camera | null>(null);

  /*
   * ⚠️ **The search box is the server's, not the browser's.**
   *
   * It used to filter an array the console had already fetched — every camera in the tenant, on
   * every page load. That works at nine cameras and is a different product at five thousand:
   * measured at P-6.6, the estate arrives at ~800 bytes a camera. `search`, `zoneId`, `lifecycle`
   * and `status` are all things the camera service already answers; the console simply never asked.
   *
   * Debounced, because a keystroke is not a query.
   */
  const debouncedSearch = useDebounced(search, 300);

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

  /*
   * ⚠️ **What the server can answer, and what it cannot — kept apart on purpose.**
   *
   * `search`, the location subtree and an exact `lifecycle` state are all `CameraQuery` fields, so
   * they narrow the result **before** it is sent. Two things are not:
   *
   *   · **health** — `health.status` is on the record but is not a query field, so filtering by it
   *     is a refinement of the rows already loaded. The screen says so when there are more.
   *   · **"active"** — the operator's usual view is "everything except retired", and the query can
   *     express `lifecycle = retired` but not its complement. Same treatment, same disclosure.
   *
   * Inventing either server-side would mean a contract change to a frozen foundation; pretending
   * they are server-side would mean a filter that silently answers for one page of an estate.
   */
  const serverQuery = useMemo(
    () => ({
      limit: PAGE_SIZE,
      ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
      ...(locationScope ? { zoneIds: [...locationScope].slice(0, ZONE_FILTER_LIMIT) } : {}),
      ...(lifecycle !== 'all' && lifecycle !== 'active' ? { lifecycle } : {}),
    }),
    [debouncedSearch, locationScope, lifecycle],
  );

  const query = useCameraPages(serverQuery);
  const loaded = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.cameras),
    [query.data],
  );
  const fleet = useFleetMetrics('day');

  const atCap = (query.data?.pages.length ?? 0) >= MAX_PAGES;
  const hasMore = query.hasNextPage === true && !atCap;

  /** The refinements the server cannot do, applied to what is loaded — and only to that. */
  const visible = useMemo(
    () =>
      loaded.filter(
        (camera) =>
          (health === 'all' || camera.health.status === health) &&
          (lifecycle === 'active' ? camera.lifecycle.state !== 'retired' : true),
      ),
    [loaded, health, lifecycle],
  );
  const refined = visible.length !== loaded.length;

  const confirmDelete = () => {
    if (!pendingDelete) return;
    deleteCamera.mutate(pendingDelete.id, {
      onSuccess: () => {
        toast.success(`${pendingDelete.name} removed`);
        setPendingDelete(null);
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

      {/*
        ⚠️ **"of N" is the server's N.** The estate size comes from `/cameras/metrics`, not from the
        length of what happens to be loaded — the two are the same number only until the first page
        boundary, and a count that quietly becomes a page size is the arithmetic P-6.5 found in the
        Inbox. When a refinement the server cannot do is active, the line says that too.
      */}
      <p className="mb-3 text-sm text-text-subtle" data-testid="camera-count">
        {query.isLoading
          ? 'Loading cameras…'
          : `Showing ${visible.length}${refined ? ` of ${loaded.length} loaded` : ''} of ${
              /* ⚠️ "about" when the server says the count is sampled — a sampled aggregate presented
                 as a census is a confident number describing a subset nobody chose. */
              fleet.data?.sampled ? 'about ' : ''
            }${fleet.data?.cameras ?? loaded.length} camera${
              (fleet.data?.cameras ?? loaded.length) === 1 ? '' : 's'
            }`}
        {refined ? ' · health and “active” are applied to the rows loaded, not to the estate' : ''}
      </p>

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        isEmpty={loaded.length === 0}
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
                <TableRow key={camera.id}>
                  <TableCell>
                    {/*
                      ⚠️ A link, not a click handler on the row. It is the same navigation an
                      operator can middle-click, copy, or reach with the keyboard for free — and it
                      gives the camera an address, which the row-opens-a-sheet version never did.
                    */}
                    <Link
                      to={`/cameras/${camera.id}`}
                      className="font-medium hover:underline focus-visible:underline"
                    >
                      {camera.name}
                    </Link>
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

        {hasMore ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more cameras'}
            </Button>
          </div>
        ) : null}

        {atCap && query.hasNextPage ? (
          <p className="mt-4 text-center text-sm text-text-subtle">
            {`Showing the ${loaded.length} cameras loaded so far.`} There are more — narrow the
            search or pick a location rather than paging further.
          </p>
        ) : null}
      </QueryBoundary>

      <AddCameraDialog open={adding} onOpenChange={setAdding} />
      <DiscoveryDialog open={discovering} onOpenChange={setDiscovering} />

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
