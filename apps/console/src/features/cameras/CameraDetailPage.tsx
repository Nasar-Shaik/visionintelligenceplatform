import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CircleStop, Pencil, PlugZap, RefreshCw, Video } from 'lucide-react';
import type { Camera, CapabilityChange, StreamProbeResult } from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import { useLocation } from '@/features/organization/useOrganization';
import { formatTimestamp } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  PageHeader,
  QueryBoundary,
  StatusIndicator,
  toast,
} from '@/ui';
import { CameraActions, CameraDeviceSections, Field } from './CameraDeviceSections';
import { CapabilityTruthPanel } from './CapabilityTruthPanel';
import { EditCameraDialog } from './EditCameraDialog';
import { cameraLifecyclePresentation, healthPresentation } from './cameraPresentation';
import {
  useCamera,
  useDeleteCamera,
  useCameraStream,
  useCheckCameraHealth,
  useProbeCamera,
  useRefreshCapabilities,
  useStreamControl,
} from './useCameras';

/**
 * One camera, in full — reachable by URL.
 *
 * ### ⚠️ Why this is a page and not the sheet it replaces
 *
 * A camera was previously only viewable by clicking its row, which means it had no address: an
 * installer could not send "this one" to a colleague, the browser's back button did nothing, and a
 * refresh dropped the operator back to an unfiltered list. At nine cameras that is an inconvenience;
 * at five thousand it is the difference between a product and a demo.
 *
 * ### The render states, and why they are not one state
 *
 * · **loading** — the skeleton, from `QueryBoundary`
 * · **unavailable** — the camera service did not answer. Nothing is claimed about the camera
 * · **not found** — the id is not in this tenant. ⚠️ Deliberately the same answer as another
 *   tenant's camera, so this page cannot be used to discover that an id exists elsewhere
 * · **permission denied** — a viewer sees the camera and none of the actions
 * · **stale** — a reading that could not be refreshed is kept and **labelled**, never blanked; an
 *   operator troubleshooting an outage needs the last thing that was true (P-6.4/P-6.5)
 * · **offline** — a property of the *camera*, rendered in the record rather than as a page error
 */
export function CameraDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const query = useCamera(id);
  const camera = query.data;
  const [pendingDelete, setPendingDelete] = useState<Camera | null>(null);
  const deleteCamera = useDeleteCamera();

  return (
    <>
      <div className="mb-4">
        <Link
          to="/cameras"
          /* ⚠️ `min-h-6` because a 20 px target fails WCAG 2.5.8, and a back link is the control an
             operator reaches for most on a phone. Measured, not assumed: the a11y check named it. */
          className="inline-flex min-h-6 items-center gap-1 py-0.5 text-sm text-text-subtle hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          All cameras
        </Link>
      </div>

      <QueryBoundary
        skeleton={<CameraDetailSkeleton />}
        isLoading={query.isLoading}
        /* ⚠️ Only a failure with nothing to show is an error state — see `stale` below. */
        isError={query.isError && camera === undefined}
        error={query.error}
        isEmpty={!query.isLoading && !query.isError && camera === undefined}
        emptyState={
          <EmptyState
            icon={Video}
            title="No such camera"
            description="This camera is not in your tenant. It may have been removed, or the link may be wrong."
            action={
              <Button asChild variant="outline">
                <Link to="/cameras">Back to cameras</Link>
              </Button>
            }
          />
        }
      >
        {camera ? (
          <CameraDetail camera={camera} stale={query.isError} onDelete={setPendingDelete} />
        ) : null}
      </QueryBoundary>

      {/* ⚠️ Removing a camera stops analysis and keeps its evidence — said before it happens. */}
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
            <Button
              variant="destructive"
              disabled={deleteCamera.isPending}
              onClick={() =>
                pendingDelete &&
                deleteCamera.mutate(pendingDelete.id, {
                  onSuccess: () => {
                    toast.success(`${pendingDelete.name} removed`);
                    setPendingDelete(null);
                    void navigate('/cameras');
                  },
                  onError: () => toast.error('Could not remove the camera'),
                })
              }
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CameraDetail({
  camera,
  stale,
  onDelete,
}: {
  camera: Camera;
  stale: boolean;
  onDelete: (camera: Camera) => void;
}) {
  const [editing, setEditing] = useState(false);
  const canUpdate = usePermission('camera:update');
  const canControlStream = usePermission('stream:control');

  const location = useLocation(camera.zoneId);
  const stream = useCameraStream(camera.id);
  const probe = useProbeCamera();
  const checkHealth = useCheckCameraHealth();
  const refreshCapabilities = useRefreshCapabilities();
  const streamControl = useStreamControl(camera.id);

  const recording = stream.data?.recording === true;

  /* Results produced by the actions below, displayed by the sections above them. */
  const [probeResult, setProbeResult] = useState<StreamProbeResult | null>(null);
  const [probeUnavailable, setProbeUnavailable] = useState<string | null>(null);
  const [capabilityChanges, setCapabilityChanges] = useState<CapabilityChange[] | null>(null);

  return (
    <>
      <PageHeader
        title={camera.name}
        description={camera.streamUrl}
        actions={
          canUpdate ? (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden />
                Edit
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  probe.mutate(camera.id, {
                    onSuccess: () => toast.success('Probe finished'),
                    onError: () => toast.error('The probe could not be run'),
                  })
                }
                disabled={probe.isPending}
              >
                <PlugZap className="size-4" aria-hidden />
                Probe
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  checkHealth.mutate(camera.id, {
                    onSuccess: () => toast.success('Health re-checked'),
                    onError: () => toast.error('The health check could not be run'),
                  })
                }
                disabled={checkHealth.isPending}
              >
                <RefreshCw className="size-4" aria-hidden />
                Check health
              </Button>
            </>
          ) : null
        }
      />

      {/*
        ⚠️ A reading that could not be refreshed is shown **and labelled**. Blanking the page during
        an outage is the defect P-6.4 found on System Health and P-6.5 found again on the Inbox: the
        moment the platform is least reachable is the moment an operator most needs the last thing
        that was true.
      */}
      {stale ? (
        <Alert variant="warning" className="mb-4">
          <span className="font-medium">This camera could not be refreshed.</span> What follows is
          the last reading the console received — it may no longer be current.
        </Alert>
      ) : null}

      <div className="grid gap-6">
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Lifecycle">
            <StatusIndicator {...cameraLifecyclePresentation(camera.lifecycle.state)} />
          </Field>
          <Field label="Health">
            <StatusIndicator {...healthPresentation(camera.health.status)} />
          </Field>
          <Field label="Status">
            <Badge variant={camera.status === 'enabled' ? 'success' : 'neutral'}>
              {camera.status}
            </Badge>
          </Field>
          <Field label="Location">
            {location.data?.label ?? <code className="text-xs">{camera.zoneId}</code>}
          </Field>
          <Field label="Protocol">{camera.protocol.toUpperCase()}</Field>
          <Field label="Credentials">
            {camera.hasCredentials ? 'stored, encrypted' : 'none stored'}
          </Field>
          <Field label="Added">{formatTimestamp(camera.createdAt)}</Field>
          <Field label="Last changed">{formatTimestamp(camera.updatedAt)}</Field>
        </section>

        {/* ── recording ─────────────────────────────────────────────────────────────────────── */}
        <section aria-labelledby="recording">
          <h3
            id="recording"
            className="mb-2 text-xs font-medium uppercase tracking-wide text-text-subtle"
          >
            Recording
          </h3>
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-2 p-3">
            <div className="flex-1 text-sm">
              {stream.isLoading ? (
                <span className="text-text-subtle">Asking the media service…</span>
              ) : stream.isError ? (
                /* ⚠️ Unreachable ≠ not recording. Saying "off" here would invent an answer. */
                <span className="text-warning">
                  The media service did not answer — whether this camera is recording is unknown.
                </span>
              ) : stream.data === null || stream.data === undefined ? (
                <span className="text-text-subtle">
                  No stream worker for this camera. Nothing is being recorded.
                </span>
              ) : (
                <span>
                  {recording ? 'Recording' : 'Connected, not recording'} · state{' '}
                  <code className="text-xs">{stream.data.state}</code> ·{' '}
                  {stream.data.framesReceived} frames
                  {stream.data.lastSegmentAt
                    ? ` · last segment ${formatTimestamp(stream.data.lastSegmentAt)}`
                    : ''}
                </span>
              )}
              {/*
                ⚠️ TD-4, stated where it matters rather than in a document nobody reads: the media
                service holds stream state in memory, so restarting it stops every worker and the
                camera record will not remember that this camera was ever recording.
              */}
              <p className="mt-1 text-xs text-text-subtle">
                Stream workers live in the media service&rsquo;s memory — a restart of that service
                stops recording, and nothing in the camera record remembers it was on.
              </p>
            </div>
            {canControlStream ? (
              <Button
                variant="outline"
                disabled={streamControl.isPending}
                onClick={() =>
                  streamControl.mutate(stream.data && recording ? 'stop' : 'start', {
                    onSuccess: () =>
                      toast.success(recording ? 'Recording stopped' : 'Recording started'),
                    onError: () => toast.error('The media service refused'),
                  })
                }
              >
                {recording ? (
                  <>
                    <CircleStop className="size-4" aria-hidden />
                    Stop recording
                  </>
                ) : (
                  <>
                    <Video className="size-4" aria-hidden />
                    Start recording
                  </>
                )}
              </Button>
            ) : null}
          </div>
        </section>

        <CapabilityTruthPanel camera={camera} stream={stream.data} />

        {/* ── configured capture, as distinct from what the device can do ───────────────────── */}
        <section aria-labelledby="capture">
          <h3
            id="capture"
            className="mb-2 text-xs font-medium uppercase tracking-wide text-text-subtle"
          >
            Configured capture
          </h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Codec">{camera.capture.codec?.toUpperCase() ?? 'not set'}</Field>
            <Field label="Resolution">{camera.capture.resolution ?? 'not set'}</Field>
            <Field label="Frame rate">
              {camera.capture.fps !== undefined ? `${camera.capture.fps} fps` : 'not set'}
            </Field>
            <Field label="PTZ requested">{camera.capture.ptz ? 'yes' : 'no'}</Field>
          </div>
          {/* ⚠️ Configured ≠ achieved. The measured rate lives in the capability table above. */}
          <p className="mt-2 text-xs text-text-subtle">
            What the platform asks this camera for. What it actually gets is measured, and is in the
            capability table above.
          </p>
        </section>

        {/* ── operator metadata ─────────────────────────────────────────────────────────────── */}
        <section aria-labelledby="metadata">
          <h3
            id="metadata"
            className="mb-2 text-xs font-medium uppercase tracking-wide text-text-subtle"
          >
            Device and notes
          </h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Manufacturer">{camera.metadata.manufacturer ?? '—'}</Field>
            <Field label="Model">{camera.metadata.model ?? '—'}</Field>
            <Field label="Firmware">{camera.metadata.firmware ?? '—'}</Field>
            <Field label="Serial">{camera.metadata.serialNumber ?? '—'}</Field>
          </div>
          <div className="mt-3 grid gap-3">
            <Field label="Described as">{camera.metadata.location ?? '—'}</Field>
            <Field label="Tags">
              {camera.metadata.tags.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {camera.metadata.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </span>
              ) : (
                'none'
              )}
            </Field>
            <Field label="Notes">
              {camera.metadata.notes ? (
                <span className="whitespace-pre-wrap">{camera.metadata.notes}</span>
              ) : (
                'none'
              )}
            </Field>
          </div>
        </section>

        {/* ⚠️ Moved from the sheet unchanged — device truth, stream profiles, drift, timeline. */}
        <CameraDeviceSections
          camera={camera}
          probeResult={probeResult}
          probeUnavailable={probeUnavailable}
          capabilityChanges={capabilityChanges}
        />

        <section aria-labelledby="camera-actions" className="border-t border-border pt-4">
          <h3
            id="camera-actions"
            className="mb-3 text-xs font-medium uppercase tracking-wide text-text-subtle"
          >
            Actions
          </h3>
          <CameraActions
            camera={camera}
            onDelete={onDelete}
            onProbeResult={setProbeResult}
            onProbeUnavailable={setProbeUnavailable}
            onCapabilityChanges={setCapabilityChanges}
          />
        </section>

        {canUpdate ? (
          <section aria-labelledby="capabilities-refresh">
            <h3
              id="capabilities-refresh"
              className="mb-2 text-xs font-medium uppercase tracking-wide text-text-subtle"
            >
              Capabilities
            </h3>
            <Button
              variant="outline"
              disabled={refreshCapabilities.isPending}
              onClick={() =>
                refreshCapabilities.mutate(
                  { id: camera.id, force: true },
                  {
                    onSuccess: () => toast.success('Capabilities re-read from the device'),
                    onError: () => toast.error('The device could not be re-read'),
                  },
                )
              }
            >
              <RefreshCw className="size-4" aria-hidden />
              Re-read from the device
            </Button>
          </section>
        ) : null}
      </div>

      <EditCameraDialog camera={camera} open={editing} onOpenChange={setEditing} />
    </>
  );
}

/** The page's shape while it loads — same rhythm as the loaded page, so nothing jumps. */
function CameraDetailSkeleton() {
  return (
    <div className="grid gap-6" aria-hidden>
      <div className="h-8 w-64 animate-pulse rounded bg-surface-2" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-surface-2" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded bg-surface-2" />
    </div>
  );
}
